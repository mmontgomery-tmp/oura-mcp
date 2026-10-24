// Workouts from Health Auto Export (a separate "Workouts" automation). The payload is
//   {"data": {"workouts": [{"id": "<uuid>", "name": "Indoor Cycling",
//     "start": "2026-10-03 07:00:00 -0700", "end": "2026-10-03 07:30:00 -0700", "duration": 1800,
//     "activeEnergyBurned": {"qty": 350, "units": "kcal"},
//     "avgHeartRate": {"qty": 150, "units": "bpm"}, "maxHeartRate": {"qty": 175, "units": "bpm"},
//     "heartRate": {"min": {...}, "avg": {...}, "max": {...}},
//     "heartRateData": [{"date": "...", "Min": 120, "Avg": 150, "Max": 175, "units": "bpm", "source": "..."}],
//     "activeEnergy": [{"date": "...", "qty": 50, "units": "kcal", "source": "..."}],
//     "source": {"name": "Oura", "identifier": "com.ouraring.oura"}, ...}]}}
// Field names follow HAE's Export Version 2 documentation
// (help.healthyapps.dev/en/health-auto-export/export-format/workouts) and its reference server
// (github.com/HealthyApps/health-auto-export-server, src/models/Workout.ts). Version 1 has no id or
// duration and sends activeEnergy as a single {qty, units}; both shapes are read. The workout's own
// "source" (the app that wrote it) is not in the documentation, but real pushes carry it as
// {name, identifier}.
import { createHash } from 'node:crypto';
import { parseInstant, sortKey } from './dates.ts';
import { unitFactor } from './health.ts';

export const WORKOUT = 'workout';

/** One workout, stored in the health table under PK "workout". */
export interface WorkoutRow {
  metric: typeof WORKOUT;
  /**
   * Sort key: the start as a UTC second plus a fingerprint of the workout's id (or, without an
   * id, of its source, type and end), so a re-sent workout lands on the same row and an edited
   * one (HealthKit deletes it and writes a new one) gets a new row.
   */
  ts: string;
  /** Workout type as Health Auto Export names it, e.g. "Indoor Cycling". */
  name: string;
  /** Start and end as UTC seconds. */
  start: string;
  end: string;
  duration_s: number;
  active_kcal?: number;
  avg_hr_bpm?: number;
  max_hr_bpm?: number;
  /** The app that wrote the workout (its own source name), or "unknown" if the payload has none. */
  source: string;
  /** That app's bundle identifier, e.g. "com.ouraring.oura", when the payload has it. */
  source_id?: string;
  /** Health Auto Export's workout id (the HealthKit sample's UUID). */
  hae_id?: string;
  via: 'hae';
  /** Start and end exactly as received, with their original offset. */
  recorded_at: string;
  recorded_end: string;
  ingested_at: string;
  missing_since?: string;
  superseded_at?: string;
  superseded_by?: 'reconcile' | 'chat';
}

export type WorkoutSkipReason = 'invalid_workout';

export interface WorkoutParseResult {
  rows: WorkoutRow[];
  received: number;
  accepted: number;
  skipped: number;
  skipped_reasons: Partial<Record<WorkoutSkipReason, number>>;
  /** Workouts received per type name (logged). */
  types: Record<string, number>;
  /** Every top-level field name seen on a workout (logged: shows what the payload really carries). */
  fields: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const qty = (v: unknown): number | undefined => (isObj(v) ? num(v.qty) : undefined);

/** Returns undefined when the payload has no "workouts" list at all (a Health Metrics push). */
export function parseHaeWorkouts(body: unknown, opts: { timeZone: string; now: Date }): WorkoutParseResult | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  const list = isObj(data) ? data.workouts : undefined;
  if (!Array.isArray(list)) return undefined;

  const result: WorkoutParseResult = { rows: [], received: list.length, accepted: 0, skipped: 0, skipped_reasons: {}, types: {}, fields: [] };
  const fields = new Set<string>();
  const keys = new Set<string>();
  const skip = (reason: WorkoutSkipReason) => {
    result.skipped++;
    result.skipped_reasons[reason] = (result.skipped_reasons[reason] ?? 0) + 1;
  };
  const ingestedAt = opts.now.toISOString();

  for (const w of list as unknown[]) {
    if (!isObj(w)) {
      skip('invalid_workout');
      continue;
    }
    for (const f of Object.keys(w)) fields.add(f);
    const name = typeof w.name === 'string' ? w.name.trim() : '';
    if (name) result.types[name] = (result.types[name] ?? 0) + 1;

    let startMs: number;
    let endMs: number;
    try {
      if (!name || typeof w.start !== 'string') throw new Error('missing name or start');
      startMs = parseInstant(w.start, opts.timeZone);
      const seconds = num(w.duration);
      if (typeof w.end === 'string') endMs = parseInstant(w.end, opts.timeZone);
      else if (seconds !== undefined) endMs = startMs + Math.round(seconds) * 1000;
      else throw new Error('missing end and duration');
      if (endMs < startMs) throw new Error('ends before it starts');
    } catch {
      skip('invalid_workout');
      continue;
    }
    // Workouts Oura wrote to Apple Health are kept (unlike Oura's metric samples): an Oura-detected
    // walk may be the only record of it.
    const { name: source, identifier: sourceId } = workoutSource(w);

    const duration = num(w.duration);
    const active = activeKcal(w);
    const hr = heartRate(w);
    const id = typeof w.id === 'string' && w.id.trim() ? w.id.trim() : undefined;
    const row: WorkoutRow = {
      metric: WORKOUT,
      ts: '',
      name,
      start: sortKey(startMs),
      end: sortKey(endMs),
      duration_s: Math.round(duration !== undefined && duration >= 0 ? duration : (endMs - startMs) / 1000),
      ...(active !== undefined ? { active_kcal: Math.round(active * 10) / 10 } : {}),
      ...(hr.avg !== undefined ? { avg_hr_bpm: Math.round(hr.avg) } : {}),
      ...(hr.max !== undefined ? { max_hr_bpm: Math.round(hr.max) } : {}),
      source,
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(id ? { hae_id: id } : {}),
      via: 'hae',
      recorded_at: w.start as string,
      recorded_end: typeof w.end === 'string' ? w.end : sortKey(endMs),
      ingested_at: ingestedAt,
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(id ? ['id', id] : [source, name, row.end]))
      .digest('hex')
      .slice(0, 12);
    let duplicate = 0;
    do row.ts = `${row.start}#${fingerprint}${duplicate ? `~${duplicate}` : ''}`;
    while (keys.has(row.ts) && ++duplicate);
    keys.add(row.ts);
    result.accepted++;
    result.rows.push(row);
  }
  result.fields = [...fields].sort();
  return result;
}

/** Active energy in kcal: the summary field, else Version 1's object, else the sum of the series. */
function activeKcal(w: Obj): number | undefined {
  for (const field of [w.activeEnergyBurned, w.activeEnergy]) {
    if (isObj(field)) {
      const q = num(field.qty);
      const factor = unitFactor('calories', typeof field.units === 'string' ? field.units : 'kcal');
      if (q !== undefined && factor !== undefined) return q * factor;
    }
  }
  if (Array.isArray(w.activeEnergy)) {
    let total: number | undefined;
    for (const s of w.activeEnergy as unknown[]) {
      if (!isObj(s)) continue;
      const q = num(s.qty);
      const factor = unitFactor('calories', typeof s.units === 'string' ? s.units : 'kcal');
      if (q !== undefined && factor !== undefined) total = (total ?? 0) + q * factor;
    }
    return total;
  }
  return undefined;
}

/** Average and max heart rate: the summary fields, else the min/avg/max object, else the series. */
function heartRate(w: Obj): { avg?: number; max?: number } {
  const summary = isObj(w.heartRate) ? w.heartRate : {};
  let avg = qty(w.avgHeartRate) ?? qty(summary.avg);
  let max = qty(w.maxHeartRate) ?? qty(summary.max);
  if ((avg === undefined || max === undefined) && Array.isArray(w.heartRateData)) {
    const samples = (w.heartRateData as unknown[]).filter(isObj);
    const avgs = samples.map((s) => num(s.Avg) ?? num(s.qty)).filter((n): n is number => n !== undefined);
    const maxes = samples.map((s) => num(s.Max) ?? num(s.qty)).filter((n): n is number => n !== undefined);
    if (avg === undefined && avgs.length) avg = avgs.reduce((a, b) => a + b, 0) / avgs.length;
    if (max === undefined && maxes.length) max = Math.max(...maxes);
  }
  return { ...(avg !== undefined && avg > 0 ? { avg } : {}), ...(max !== undefined && max > 0 ? { max } : {}) };
}

/**
 * The app that wrote the workout: its own "source", sent as {"name", "identifier"} (or as a plain
 * name). Never inferred from the samples inside the workout's series: those come from whatever
 * recorded heart rate or energy at the time, so an Oura workout overlapping a Peloton ride used to
 * be labelled Peloton.
 */
function workoutSource(w: Obj): { name: string; identifier?: string } {
  const s = w.source;
  if (typeof s === 'string' && s.trim()) return { name: s.trim() };
  if (isObj(s) && typeof s.name === 'string' && s.name.trim()) {
    const identifier = typeof s.identifier === 'string' && s.identifier.trim() ? s.identifier.trim() : undefined;
    return { name: s.name.trim(), ...(identifier ? { identifier } : {}) };
  }
  return { name: 'unknown' };
}
