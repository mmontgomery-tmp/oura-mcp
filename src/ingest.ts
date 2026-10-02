import { gunzipSync } from 'node:zlib';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { HaeFormatError, parseHaePayload, redactPayload } from './hae.ts';
import type { HealthStore } from './health-store.ts';
import { syncHaeRows, type SyncResult } from './sync.ts';
import { parseHaeWorkouts, WORKOUT, type WorkoutRow } from './workouts.ts';

export const MAX_INGEST_BYTES = 1024 * 1024;

// Non-sensitive headers Health Auto Export adds; logged with the first payload.
const HAE_HEADERS = ['content-type', 'user-agent', 'automation-name', 'automation-id', 'automation-aggregation', 'automation-period'];

const json = (statusCode: number, body: unknown): LambdaFunctionURLResult => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** POST /ingest/<secret> after both secrets have been checked. */
export async function handleIngest(
  event: LambdaFunctionURLEvent,
  deps: {
    health: HealthStore;
    timeZone: string;
    now?: () => Date;
    log: (msg: string, extra?: Record<string, unknown>) => void;
    allowTestClock?: boolean;
  },
): Promise<LambdaFunctionURLResult> {
  const started = Date.now();
  if (event.requestContext.http.method !== 'POST') return json(405, { error: 'Use POST.' });

  const declared = Number(event.headers?.['content-length']);
  if (declared > MAX_INGEST_BYTES) return tooLarge(declared);
  let raw = event.body === undefined ? Buffer.alloc(0) : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (raw.length > MAX_INGEST_BYTES) return tooLarge(raw.length);
  if (/gzip/i.test(event.headers?.['content-encoding'] ?? '')) {
    try {
      raw = gunzipSync(raw, { maxOutputLength: MAX_INGEST_BYTES });
    } catch {
      return tooLarge(undefined, 'Body is not valid gzip, or it inflates past 1 MB.');
    }
  }
  const contentType = event.headers?.['content-type'] ?? '';
  if (contentType && !/json/i.test(contentType)) {
    return json(415, { error: `Expected JSON (got ${contentType}). Set the automation's Export Format to JSON.` });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(400, { error: 'Body is not valid JSON.' });
  }

  // Test hook for scripts/health-smoke.sh: a clock override so reconciliation (the 15-minute rule
  // and the 7-day window) can be exercised on 2001 test data. Off unless the deployment sets
  // ALLOW_TEST_CLOCK=true, and refused for any date from 2010 on, so it can never touch real
  // readings.
  let now = deps.now?.() ?? new Date();
  const testNow = event.headers?.['x-smoke-test-now'];
  if (testNow !== undefined) {
    if (!deps.allowTestClock) {
      return json(400, { error: 'The test clock is off on this deployment (x-smoke-test-now needs ALLOW_TEST_CLOCK=true).' });
    }
    const t = Date.parse(testNow);
    if (!Number.isFinite(t) || new Date(t).getUTCFullYear() >= 2010) {
      return json(400, { error: 'x-smoke-test-now is for test data only and must be a date before 2010.' });
    }
    now = new Date(t);
  }

  let parsed;
  try {
    parsed = parseHaePayload(body, { timeZone: deps.timeZone, now });
  } catch (err) {
    if (err instanceof HaeFormatError) return json(400, { error: err.message });
    throw err;
  }

  // A "Workouts" automation sends data.workouts instead of data.metrics (see workouts.ts).
  const workouts = parseHaeWorkouts(body, { timeZone: deps.timeZone, now });
  const hasMetrics = Array.isArray((body as { data?: { metrics?: unknown } }).data?.metrics);

  // One redacted payload of each kind, once per table, so the real schema can be checked in
  // CloudWatch.
  try {
    const headers = Object.fromEntries(HAE_HEADERS.flatMap((h) => (event.headers?.[h] ? [[h, event.headers[h]]] : [])));
    if ((hasMetrics || !workouts) && (await deps.health.claimFirstPayloadLog('metrics'))) {
      deps.log('hae first payload (redacted)', { bytes: raw.length, headers, payload: redactPayload(body) });
    }
    if (workouts?.received && (await deps.health.claimFirstPayloadLog('workouts'))) {
      deps.log('hae first workout payload (redacted)', { bytes: raw.length, headers, payload: redactPayload(body) });
    }
  } catch (err) {
    deps.log('hae first payload log failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // Unchanged re-sent samples are not written; samples gone from a full "Previous 7 Days" or
  // "Today" push are marked (never deleted). See sync.ts for the rules.
  const period = event.headers?.['automation-period'];
  const sync = await syncHaeRows(deps.health, parsed.rows, {
    now,
    timeZone: deps.timeZone,
    period,
    acceptedByMetric: parsed.accepted_by_metric,
  });
  // Workouts follow the same rules, with the more-than-half guard over the whole window.
  let workoutSync: SyncResult | undefined;
  if (workouts) {
    workoutSync = await syncHaeRows<WorkoutRow>(
      { query: (_metric, from, to) => deps.health.queryWorkouts(from, to), writeRows: (rows) => deps.health.writeRows(rows) },
      workouts.rows,
      { now, timeZone: deps.timeZone, period, acceptedByMetric: { [WORKOUT]: workouts.accepted }, guard: 'window' },
    );
  }
  const counts = (s: SyncResult) => ({
    rows_written: s.written,
    rows_unchanged: s.unchanged,
    reconcile: s.reconcile,
    ...(s.note ? { reconcile_note: s.note } : {}),
    marked_missing: s.pending,
    superseded: s.superseded,
    restored: s.restored,
    ...(s.skipped_days.length ? { reconcile_skipped: s.skipped_days } : {}),
  });
  const summary = {
    accepted: parsed.accepted,
    skipped: parsed.skipped,
    skipped_reasons: parsed.skipped_reasons,
    ...counts(sync),
    ...(parsed.ignored_metrics.length ? { ignored_metrics: parsed.ignored_metrics } : {}),
    // Health Metrics payloads can carry an empty "workouts" list; only report real workout pushes.
    ...(workouts && workoutSync && (workouts.received > 0 || !hasMetrics)
      ? {
          workouts: {
            received: workouts.received,
            accepted: workouts.accepted,
            skipped: workouts.skipped,
            skipped_reasons: workouts.skipped_reasons,
            ...counts(workoutSync),
          },
        }
      : {}),
  };
  // A skipped metric-day recurs on every push (every 5 minutes) until fixed by hand: log it only
  // on the first push of each clock hour.
  const hour = now.toISOString().slice(0, 13);
  for (const d of [...sync.skipped_days, ...(workoutSync?.skipped_days ?? [])]) {
    if (await deps.health.claimHourlyLog(`reconcile-skip#${d.metric}#${d.day}`, hour)) {
      deps.log('hae reconcile skipped: more than half of a metric-day would be marked', { ...d });
    }
  }
  // Per-metric counts, sample field names and the period are kept in the log to review later
  // whether pushes are ever partial (e.g. phone locked) and whether a sample UUID ever appears.
  deps.log('hae ingest', {
    ...summary,
    metrics: parsed.metric_counts,
    units: parsed.metric_units,
    sample_fields: parsed.sample_fields,
    ...(workouts?.received ? { workout_types: workouts.types, workout_fields: workouts.fields } : {}),
    period,
    ...(testNow !== undefined ? { test_now: now.toISOString() } : {}),
    bytes: raw.length,
    ms: Date.now() - started,
  });
  return json(200, summary);
}

function tooLarge(bytes?: number, detail?: string): LambdaFunctionURLResult {
  return json(413, {
    error: detail ?? `Payload is ${bytes} bytes; the limit is ${MAX_INGEST_BYTES} (1 MB).`,
    hint:
      'Export fewer days per sync. For a Workouts automation, leave route data out and group workout metrics by ' +
      'minutes, not seconds. Keep "Batch Requests" off: reconciliation needs each push to be the complete window.',
  });
}
