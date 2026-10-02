// The get_health_metrics read: daily nutrition sums, net carbs, and reading lists. Shared by the
// tool and the prompt.
import { addDays, type DateRange, eachDay, inRange, localTime, resolveRange } from './dates.ts';
import { CLAUDE_SOURCE, dedupeReadings, type HealthRow, METRICS, type Metric, NET_CARBS_SWITCHOVER_MS, roundFor, rowTime, SUMMED } from './health.ts';
import type { HealthStore } from './health-store.ts';
import { netCarbsForDay } from './net-carbs.ts';
import { type Log, ToolInputError } from './tool-run.ts';

export interface HealthToolDeps {
  health: HealthStore;
  timeZone: string;
  now?: () => Date;
  log: Log;
}

export interface MetricsQuery {
  metric: Metric | 'all';
  start_date?: string;
  end_date?: string;
}

export const MAX_DAYS = 92;
const MAX_READINGS = 1000; // keeps a response readable if a CGM ever syncs every 5 minutes
const SUM_KEYS = { protein: 'protein_g', carbs: 'carbs_g', fat: 'fat_g', calories: 'calories_kcal' } as const;

const DAY_KEYS = ['date', 'weight', 'waist', 'body_fat', 'lean_mass', 'bp', 'glucose', 'ketones', 'protein_g', 'carbs_g', 'total_carbs_g', 'fiber_g', 'fat_g', 'calories_kcal', 'warnings'];

/** Day fields in a fixed, readable order. */
function ordered<T extends Record<string, unknown>>(d: T): T {
  return Object.fromEntries(DAY_KEYS.filter((k) => k in d).map((k) => [k, d[k]])) as T;
}

/** The net-carbs switchover in local time, as the tool and prompt descriptions state it. */
export function switchoverText(timeZone: string): string {
  const t = localTime(NET_CARBS_SWITCHOVER_MS, timeZone);
  return `${t.date} ${t.time} (${timeZone})`;
}

/** One reading as the tools show it. */
export function presentReading(r: HealthRow, timeZone: string) {
  const t = localTime(rowTime(r), timeZone);
  return {
    time: t.time,
    ...(r.metric === 'bp' ? { systolic: r.systolic, diastolic: r.diastolic } : { value: r.value }),
    unit: r.unit,
    ...(r.context ? { context: r.context } : {}),
    source: r.source,
    ...(r.note ? { note: r.note } : {}),
    // Only chat readings can be deleted, and delete_reading needs their exact timestamp.
    ...(r.source === CLAUDE_SOURCE ? { timestamp: t.iso } : {}),
  };
}

export function createMetricsReader(deps: HealthToolDeps) {
  const { health, timeZone, log } = deps;
  const now = () => deps.now?.() ?? new Date();

  return async function readMetrics(input: MetricsQuery) {
    let range: DateRange;
    try {
      range = resolveRange(input, { timeZone, maxDays: MAX_DAYS, now: now() });
    } catch (err) {
      throw new ToolInputError(err instanceof Error ? err.message : String(err));
    }
    const metrics: readonly Metric[] = input.metric === 'all' ? METRICS : [input.metric];
    const wantCarbs = metrics.includes('carbs');
    const wantFiber = metrics.includes('fiber');
    // Net carbs need both carbs and fiber rows, whichever of the two was asked for.
    const queried: Metric[] = [...new Set<Metric>([...metrics, ...(wantCarbs || wantFiber ? (['carbs', 'fiber'] as const) : [])])];
    // Pad a UTC day each side (any timezone's local days are then covered), filter by local date.
    const from = `${addDays(range.start, -1)}T00:00:00Z`;
    const to = `${addDays(range.end, 2)}T00:00:00Z`;
    const perMetric = await Promise.all(queried.map((m) => health.query(m, from, to)));
    const carbsByDay = new Map<string, HealthRow[]>();
    const fiberByDay = new Map<string, HealthRow[]>();

    type Day = Record<string, unknown> & { date: string };
    const days = new Map<string, Day>();
    const day = (date: string) => {
      let d = days.get(date);
      if (!d) days.set(date, (d = { date }));
      return d;
    };
    const notes: string[] = [];
    let readings = 0;
    let truncated = false;

    queried.forEach((metric, i) => {
      // Superseded Apple Health samples were deleted or edited in Apple Health.
      let rows = perMetric[i].filter((r) => !r.superseded_at);
      if (!SUMMED.has(metric)) {
        const { kept, hidden } = dedupeReadings(rows);
        rows = kept;
        if (hidden) notes.push(`${hidden} Apple Health ${metric} reading(s) hidden as duplicates of chat-logged readings.`);
      }
      for (const r of rows) {
        const { date } = localTime(rowTime(r), timeZone);
        if (!inRange(date, range)) continue;
        if (metric === 'carbs' || metric === 'fiber') {
          const byDay = metric === 'carbs' ? carbsByDay : fiberByDay;
          byDay.set(date, [...(byDay.get(date) ?? []), r]);
          continue;
        }
        const d = day(date);
        if (SUMMED.has(metric)) {
          const k = SUM_KEYS[metric as keyof typeof SUM_KEYS];
          d[k] = roundFor(metric, ((d[k] as number | undefined) ?? 0) + (r.value ?? 0));
        } else {
          if (readings >= MAX_READINGS) {
            truncated = true;
            continue;
          }
          readings++;
          ((d[metric] ??= []) as unknown[]).push(presentReading(r, timeZone));
        }
      }
    });
    if (truncated) notes.push(`Showing the first ${MAX_READINGS} readings; ask for a shorter range for the rest.`);

    // Net carbs, total carbs and fiber per day (rules and switchover in net-carbs.ts / health.ts).
    const switchoverDay = localTime(NET_CARBS_SWITCHOVER_MS, timeZone).date;
    const describeFiber = (r: HealthRow) => `${localTime(rowTime(r), timeZone).time} ${r.value} g (${r.source})`;
    for (const date of new Set([...carbsByDay.keys(), ...fiberByDay.keys()])) {
      const res = netCarbsForDay(carbsByDay.get(date) ?? [], fiberByDay.get(date) ?? [], {
        dayEntirelyBeforeSwitchover: date < switchoverDay,
        describe: describeFiber,
      });
      const fields: Record<string, unknown> = {};
      if (wantCarbs) {
        if (res.carbs_g !== undefined) fields.carbs_g = res.carbs_g;
        if (res.total_carbs_g !== undefined) Object.assign(fields, { total_carbs_g: res.total_carbs_g, fiber_g: res.fiber_g });
        if (res.warnings.length) fields.warnings = res.warnings;
        if (res.unmatchedFiber.length) log('net carbs: unmatched fiber ignored', { date, samples: res.unmatchedFiber.length });
      } else if (wantFiber && res.fiber_g !== undefined) {
        fields.fiber_g = res.fiber_g;
      }
      if (Object.keys(fields).length) Object.assign(day(date), fields);
    }

    const out = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(ordered);
    for (const d of out) {
      for (const m of metrics) if (Array.isArray(d[m])) (d[m] as { time: string }[]).sort((a, b) => a.time.localeCompare(b.time));
    }
    return {
      range,
      timezone: timeZone,
      days: out,
      days_without_data: eachDay(range).filter((d) => !days.has(d)),
      ...(notes.length ? { notes } : {}),
    };
  }
}
