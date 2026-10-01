import { type DateRange, eachDay, inRange } from './dates.ts';

// Only the Oura fields we read. Everything else is dropped (and mostly never fetched).
export interface SleepPeriod {
  day: string;
  type?: 'deleted' | 'sleep' | 'long_sleep' | 'late_nap' | 'rest' | null;
  bedtime_start?: string;
  bedtime_end?: string;
  total_sleep_duration?: number | null;
  time_in_bed?: number | null;
  deep_sleep_duration?: number | null;
  rem_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  efficiency?: number | null;
  lowest_heart_rate?: number | null;
  average_heart_rate?: number | null;
  average_hrv?: number | null;
  average_breath?: number | null;
  heart_rate?: { interval: number; items: (number | null)[] } | null;
}
export const SLEEP_FIELDS = [
  'day', 'type', 'bedtime_start', 'bedtime_end', 'total_sleep_duration', 'time_in_bed',
  'deep_sleep_duration', 'rem_sleep_duration', 'light_sleep_duration', 'efficiency',
  'lowest_heart_rate', 'average_heart_rate', 'average_hrv', 'average_breath', 'heart_rate',
] as const;

export interface DailySleep { day: string; score?: number | null }
export interface DailySpo2 { day: string; breathing_disturbance_index?: number | null; spo2_percentage?: { average?: number | null } | null }
export interface DailyReadiness { day: string; score?: number | null; temperature_deviation?: number | null; temperature_trend_deviation?: number | null }
export interface DailyActivity {
  day: string;
  score?: number | null;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  equivalent_walking_distance?: number | null;
  high_activity_time?: number | null;
  medium_activity_time?: number | null;
  low_activity_time?: number | null;
  sedentary_time?: number | null;
  non_wear_time?: number | null;
}
export const ACTIVITY_FIELDS = [
  'day', 'score', 'steps', 'active_calories', 'total_calories', 'equivalent_walking_distance',
  'high_activity_time', 'medium_activity_time', 'low_activity_time', 'sedentary_time', 'non_wear_time',
] as const;
export interface HeartRateSample { timestamp: string; bpm: number; source: string }

type Num = number | null;

const round = (v: number | null | undefined, digits = 1): Num =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits;
const hours = (seconds: number | null | undefined): Num => (seconds == null ? null : round(seconds / 3600, 2));
const minutes = (seconds: number | null | undefined): Num => (seconds == null ? null : Math.round(seconds / 60));
/** "2026-09-26T23:14:00-07:00" -> "23:14" (Oura already localizes these). */
const clock = (iso: string | undefined): string | null => (iso && iso.length >= 16 ? iso.slice(11, 16) : null);

function mean(values: number[]): Num {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function byDay<T extends { day: string }>(docs: T[], range: DateRange): Map<string, T> {
  const map = new Map<string, T>();
  for (const d of docs) if (inRange(d.day, range)) map.set(d.day, d);
  return map;
}

/**
 * The night's main sleep: the longest `long_sleep` period for the day (what the Oura app
 * shows), falling back to the longest counted period if there was no long sleep.
 */
export function mainSleepByDay(periods: SleepPeriod[], range: DateRange) {
  const out = new Map<string, { main: SleepPeriod; napSeconds: number }>();
  const counted = periods.filter((p) => inRange(p.day, range) && p.type !== 'deleted' && p.type !== 'rest');
  const days = new Set(counted.map((p) => p.day));
  for (const day of days) {
    const ofDay = counted.filter((p) => p.day === day);
    const longest = (ps: SleepPeriod[]) =>
      ps.reduce((a, b) => ((b.total_sleep_duration ?? 0) > (a.total_sleep_duration ?? 0) ? b : a));
    const longSleeps = ofDay.filter((p) => p.type === 'long_sleep');
    const main = longest(longSleeps.length ? longSleeps : ofDay);
    const napSeconds = ofDay.filter((p) => p !== main).reduce((s, p) => s + (p.total_sleep_duration ?? 0), 0);
    out.set(day, { main, napSeconds });
  }
  return out;
}

/**
 * Resting HR as the Oura app shows it: the minimum of the night's 5-minute HR samples.
 * `lowest_heart_rate` is Oura's 30-second ecore value, which reads a bit lower than the
 * app, so it is only a fallback.
 */
export function restingHr(p: SleepPeriod): Num {
  const samples = (p.heart_rate?.items ?? []).filter((v): v is number => typeof v === 'number' && v > 0);
  return samples.length ? Math.round(Math.min(...samples)) : (p.lowest_heart_rate ?? null);
}

export interface Summary<Row> {
  range: DateRange;
  rows: Row[];
  days_without_data: string[];
  notes?: string[];
}

function finish<Row extends { date: string }>(range: DateRange, rows: Row[], notes: string[] = []): Summary<Row> {
  const have = new Set(rows.map((r) => r.date));
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return {
    range,
    rows,
    days_without_data: eachDay(range).filter((d) => !have.has(d)),
    ...(notes.length ? { notes } : {}),
  };
}

// ---------------------------------------------------------------------------------------

export interface SleepRow {
  date: string;
  sleep_score: Num;
  total_sleep_h: Num;
  time_in_bed_h: Num;
  deep_h: Num;
  rem_h: Num;
  light_h: Num;
  efficiency_pct: Num;
  bedtime: string | null;
  wake_time: string | null;
  resting_hr_bpm: Num;
  avg_hrv_ms: Num;
  avg_breath_rpm: Num;
  breathing_disturbance_index: Num;
  spo2_avg_pct: Num;
  nap_h: Num;
}

export function summarizeSleep(
  range: DateRange,
  input: { periods: SleepPeriod[]; daily: DailySleep[]; spo2: DailySpo2[] | null },
): Summary<SleepRow> {
  const mains = mainSleepByDay(input.periods, range);
  const scores = byDay(input.daily, range);
  const spo2 = byDay(input.spo2 ?? [], range);
  const days = new Set([...mains.keys(), ...scores.keys(), ...spo2.keys()]);
  const rows = [...days].map((date): SleepRow => {
    const m = mains.get(date)?.main;
    const naps = mains.get(date)?.napSeconds ?? 0;
    const s = spo2.get(date);
    return {
      date,
      sleep_score: scores.get(date)?.score ?? null,
      total_sleep_h: hours(m?.total_sleep_duration),
      time_in_bed_h: hours(m?.time_in_bed),
      deep_h: hours(m?.deep_sleep_duration),
      rem_h: hours(m?.rem_sleep_duration),
      light_h: hours(m?.light_sleep_duration),
      efficiency_pct: m?.efficiency ?? null,
      bedtime: clock(m?.bedtime_start),
      wake_time: clock(m?.bedtime_end),
      resting_hr_bpm: m ? restingHr(m) : null,
      avg_hrv_ms: m?.average_hrv ?? null,
      avg_breath_rpm: round(m?.average_breath),
      breathing_disturbance_index: s?.breathing_disturbance_index ?? null,
      spo2_avg_pct: round(s?.spo2_percentage?.average),
      nap_h: naps > 0 ? hours(naps) : null,
    };
  });
  const notes = input.spo2 === null
    ? ['breathing_disturbance_index/spo2 unavailable: the Oura authorization lacks the "spo2" scope (re-run `npm run oura-auth`).']
    : [];
  return finish(range, rows, notes);
}

// ---------------------------------------------------------------------------------------

export interface HeartRateRow {
  date: string;
  resting_hr_bpm: Num;
  avg_hrv_ms: Num;
  avg_hr_bpm: Num;
  min_hr_bpm: Num;
  max_hr_bpm: Num;
  avg_awake_hr_bpm: Num;
  avg_sleep_hr_bpm: Num;
  max_workout_hr_bpm: Num;
  samples: number;
}

export function summarizeHeartRate(
  range: DateRange,
  input: { samples: HeartRateSample[]; periods: SleepPeriod[]; localDate: (d: Date) => string },
): Summary<HeartRateRow> {
  const buckets = new Map<string, HeartRateSample[]>();
  for (const s of input.samples) {
    const day = input.localDate(new Date(s.timestamp));
    if (!inRange(day, range)) continue;
    let b = buckets.get(day);
    if (!b) buckets.set(day, (b = []));
    b.push(s);
  }
  const mains = mainSleepByDay(input.periods, range);
  const days = new Set([...buckets.keys(), ...mains.keys()]);
  const rows = [...days].map((date): HeartRateRow => {
    const b = buckets.get(date) ?? [];
    const bpm = b.map((s) => s.bpm);
    const bySource = (src: string) => b.filter((s) => s.source === src).map((s) => s.bpm);
    const workout = [...bySource('workout'), ...bySource('session')];
    const m = mains.get(date)?.main;
    return {
      date,
      resting_hr_bpm: m ? restingHr(m) : null,
      avg_hrv_ms: m?.average_hrv ?? null,
      avg_hr_bpm: round(mean(bpm), 0),
      min_hr_bpm: bpm.length ? Math.min(...bpm) : null,
      max_hr_bpm: bpm.length ? Math.max(...bpm) : null,
      avg_awake_hr_bpm: round(mean(bySource('awake')), 0),
      avg_sleep_hr_bpm: round(mean(bySource('sleep')), 0) ?? round(m?.average_heart_rate, 0),
      max_workout_hr_bpm: workout.length ? Math.max(...workout) : null,
      samples: b.length,
    };
  });
  return finish(range, rows);
}

// ---------------------------------------------------------------------------------------

export interface ReadinessRow {
  date: string;
  readiness_score: Num;
  temp_deviation_c: Num;
  temp_trend_deviation_c: Num;
  resting_hr_bpm: Num;
  avg_hrv_ms: Num;
}

export function summarizeReadiness(
  range: DateRange,
  input: { readiness: DailyReadiness[]; periods: SleepPeriod[] },
): Summary<ReadinessRow> {
  const readiness = byDay(input.readiness, range);
  const mains = mainSleepByDay(input.periods, range);
  const days = new Set([...readiness.keys(), ...mains.keys()]);
  const rows = [...days].map((date): ReadinessRow => {
    const r = readiness.get(date);
    const m = mains.get(date)?.main;
    return {
      date,
      readiness_score: r?.score ?? null,
      temp_deviation_c: round(r?.temperature_deviation, 2),
      temp_trend_deviation_c: round(r?.temperature_trend_deviation, 2),
      resting_hr_bpm: m ? restingHr(m) : null,
      avg_hrv_ms: m?.average_hrv ?? null,
    };
  });
  return finish(range, rows);
}

// ---------------------------------------------------------------------------------------

export interface ActivityRow {
  date: string;
  activity_score: Num;
  steps: Num;
  active_kcal: Num;
  total_kcal: Num;
  walking_equiv_km: Num;
  high_activity_min: Num;
  medium_activity_min: Num;
  low_activity_min: Num;
  sedentary_h: Num;
  non_wear_h: Num;
}

export function summarizeActivity(range: DateRange, input: { activity: DailyActivity[] }): Summary<ActivityRow> {
  const rows = [...byDay(input.activity, range).values()].map(
    (a): ActivityRow => ({
      date: a.day,
      activity_score: a.score ?? null,
      steps: a.steps ?? null,
      active_kcal: a.active_calories ?? null,
      total_kcal: a.total_calories ?? null,
      walking_equiv_km: a.equivalent_walking_distance == null ? null : round(a.equivalent_walking_distance / 1000, 1),
      high_activity_min: minutes(a.high_activity_time),
      medium_activity_min: minutes(a.medium_activity_time),
      low_activity_min: minutes(a.low_activity_time),
      sedentary_h: hours(a.sedentary_time),
      non_wear_h: hours(a.non_wear_time),
    }),
  );
  return finish(range, rows);
}
