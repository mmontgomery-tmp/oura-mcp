import { addDays, localDateFormatter, localTime, parseInstant, sortKey, tzOffsetMs } from './dates.ts';
import { rowInstant, rowTime } from './health.ts';

// Writes one Health Auto Export push and reconciles it against what is stored.
//
// HealthKit samples are immutable: an app "edits" an entry by deleting the sample and writing a
// new one, and the payload carries no sample UUID (only date/start/end/qty/source). So a sample
// that stops appearing in full 7-day pushes has most likely been deleted or replaced. It is never
// deleted here; it is first marked `missing_since`, and `superseded_at` once a second push at
// least 15 minutes later still lacks it. Any later push that contains it clears both marks.
// get_health_metrics ignores superseded rows.
//
// Reconciliation only runs where a push is known to be complete:
// - the automation's period is "Previous 7 Days" or "Today" (Batch Requests off: one request per
//   push);
// - only Apple Health rows (never chat readings);
// - only metrics with at least one accepted sample in this push (a failed HealthKit query, e.g.
//   error 6 while the phone is locked, leaves a metric out or empty: nothing is marked);
// - "Previous 7 Days": only the six days strictly inside the window (the oldest day may be
//   partial, and today is not in it);
// - "Today": only today, and only while the phone is in the server's time zone (its "today" is
//   then the same day; otherwise the push starts at a different midnight and looks partial);
// - not for a metric-day where more than half the samples would be newly marked in one push
//   (logged). Rows an earlier push already marked missing are left out of that count, so several
//   rounds of edits to the same day don't add up to "more than half".
//
// Workouts use the same rules with one difference: the more-than-half guard looks at the whole
// reconciled window instead of each day. A day usually holds one workout, so a per-day guard could
// never retire a deleted one; and a push that carries any workouts answered the one workouts query
// in full.

export const RECONCILE_PERIOD = 'Previous 7 Days';
export const TODAY_PERIOD = 'Today';
export const CONFIRM_MISSING_MS = 15 * 60_000;

/** What reconciliation needs from a stored row: health readings and workouts both fit. */
export interface SyncRow {
  metric: string;
  ts: string;
  via: 'hae' | 'chat';
  /** The timestamp exactly as received, with its original offset. */
  recorded_at: string;
  missing_since?: string;
  superseded_at?: string;
  superseded_by?: 'reconcile' | 'chat';
}

export interface SyncStore<R extends SyncRow> {
  query(metric: R['metric'], from: string, to: string): Promise<R[]>;
  writeRows(rows: R[]): Promise<void>;
}

export interface SkippedDay {
  metric: string;
  /** The day, or "first..last" when the guard covers the whole window. */
  day: string;
  missing: number;
  total: number;
}

export interface SyncResult {
  written: number;
  unchanged: number;
  /** Samples that were marked missing or superseded and are back in this push. */
  restored: number;
  /** Newly marked missing_since (first miss). */
  pending: number;
  /** Newly marked superseded_at (second miss, at least 15 minutes after the first). */
  superseded: number;
  reconciled: string[];
  reconcile: 'on' | 'off';
  /** Why a "Today" push was not reconciled, when that is not the usual reason. */
  note?: string;
  skipped_days: SkippedDay[];
}

/** What makes two versions of a row "the same": every attribute except ingested_at. */
export function rowFingerprint(row: SyncRow): string {
  const item = row as unknown as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(item)
      .filter((k) => k !== 'ingested_at' && item[k] !== undefined)
      .sort()
      .map((k) => [k, String(item[k])]),
  );
}

export async function syncHaeRows<R extends SyncRow>(
  store: SyncStore<R>,
  rows: R[],
  opts: {
    now: Date;
    timeZone: string;
    period?: string;
    acceptedByMetric: Partial<Record<string, number>>;
    /** What the more-than-half guard measures: each day (readings) or the whole window (workouts). */
    guard?: 'day' | 'window';
  },
): Promise<SyncResult> {
  const { now, timeZone } = opts;
  const nowIso = now.toISOString();
  const localDay = (r: SyncRow) => localTime(rowTime(r), timeZone).date;
  const period = (opts.period ?? '').trim().toLowerCase();
  const todayPush = period === TODAY_PERIOD.toLowerCase();
  const note = todayPush && !rows.every((r) => inServerTimeZone(r, timeZone)) ? 'phone is in another time zone' : undefined;
  const reconcile = (period === RECONCILE_PERIOD.toLowerCase() || todayPush) && !note;

  // The days this push lists completely: today for a "Today" push, the six full days inside the
  // window for a "Previous 7 Days" push.
  const today = localDateFormatter(timeZone)(now);
  const startOf = (day: string) => parseInstant(`${day}T00:00`, timeZone);
  const days = todayPush ? [today] : [6, 5, 4, 3, 2, 1].map((n) => addDays(today, -n));
  const daysFrom = sortKey(startOf(days[0]));
  const daysTo = sortKey(startOf(addDays(days.at(-1)!, 1)) - 1000);

  const result: SyncResult = {
    written: 0,
    unchanged: 0,
    restored: 0,
    pending: 0,
    superseded: 0,
    reconciled: [],
    reconcile: reconcile ? 'on' : 'off',
    ...(note ? { note } : {}),
    skipped_days: [],
  };

  const byMetric = new Map<R['metric'], R[]>();
  for (const r of rows) {
    let list = byMetric.get(r.metric);
    if (!list) byMetric.set(r.metric, (list = []));
    list.push(r);
  }

  const toWrite: R[] = [];
  for (const [metric, pushed] of byMetric) {
    const reconcileMetric = reconcile && (opts.acceptedByMetric[metric] ?? 0) > 0;
    const instants = pushed.map(rowInstant).sort();
    const from = reconcileMetric && daysFrom < instants[0] ? daysFrom : instants[0];
    const to = reconcileMetric && daysTo > instants.at(-1)! ? daysTo : instants.at(-1)!;
    // "~" sorts after "#<fingerprint>", so the upper bound includes every sample at `to`.
    const stored = new Map(
      (await store.query(metric, from, `${to}~`)).filter((r) => r.via === 'hae').map((r) => [r.ts, r] as const),
    );

    // Pushed samples: write new or changed ones (a write also clears any missing/superseded mark).
    for (const r of pushed) {
      const old = stored.get(r.ts);
      if (old && rowFingerprint(old) === rowFingerprint(r)) {
        result.unchanged++;
        continue;
      }
      if (old?.missing_since || old?.superseded_at) result.restored++;
      toWrite.push(r);
      result.written++;
    }

    if (!reconcileMetric) continue;
    result.reconciled.push(metric);
    const pushedKeys = new Set(pushed.map((r) => r.ts));
    const groups = opts.guard === 'window' ? [days] : days.map((d) => [d]);
    for (const group of groups) {
      const inGroup = (r: SyncRow) => group.includes(localDay(r));
      const active = [...stored.values()].filter((r) => !r.superseded_at && inGroup(r));
      const missing = active.filter((r) => !pushedKeys.has(r.ts));
      if (!missing.length) continue;
      // The guard looks at what this push would newly mark. Rows an earlier push already marked
      // missing count neither as missing nor towards the total.
      const fresh = missing.filter((r) => !r.missing_since);
      const counted = active.filter((r) => pushedKeys.has(r.ts) || !r.missing_since);
      const total = new Set([...counted.map((r) => r.ts), ...pushed.filter(inGroup).map((r) => r.ts)]).size;
      if (fresh.length > total / 2) {
        const day = group.length === 1 ? group[0] : `${group[0]}..${group.at(-1)}`;
        result.skipped_days.push({ metric, day, missing: fresh.length, total });
        continue;
      }
      for (const r of missing) {
        if (!r.missing_since) {
          toWrite.push({ ...r, missing_since: nowIso });
          result.pending++;
        } else if (now.getTime() - Date.parse(r.missing_since) >= CONFIRM_MISSING_MS) {
          toWrite.push({ ...r, superseded_at: nowIso, superseded_by: 'reconcile' });
          result.superseded++;
        }
        // Otherwise the first miss was under 15 minutes ago: wait for a later push.
      }
    }
  }

  await store.writeRows(toWrite);
  return result;
}

/** True when the sample's own UTC offset (as the phone wrote it) is the server time zone's. */
function inServerTimeZone(row: SyncRow, timeZone: string): boolean {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(row.recorded_at?.trim() ?? '');
  if (!m) return false;
  const offsetMs = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  return offsetMs === tzOffsetMs(rowTime(row), timeZone);
}
