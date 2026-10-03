import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { addDays, DATE_RE, type DateRange, daysBetween, localDateFormatter, localTime, paddedDateParams, resolveRange } from './dates.ts';
import { NET_CARBS_SWITCHOVER_MS } from './health.ts';
import type { HealthStore } from './health-store.ts';
import { registerHealthTools } from './health-tools.ts';
import { createMetricsReader } from './health-read.ts';
import { registerReportTool } from './report-tools.ts';
import { createWorkoutReader, registerWorkoutTools } from './workout-tools.ts';
import { type OuraApi, OuraApiError } from './oura.ts';
import { registerRangePrompt } from './prompts.ts';
import { toolRunner } from './tool-run.ts';
import {
  ACTIVITY_FIELDS,
  type DailyActivity,
  type DailyReadiness,
  type DailySleep,
  type DailySpo2,
  type HeartRateSample,
  SLEEP_FIELDS,
  type SleepPeriod,
  summarizeActivity,
  summarizeHeartRate,
  summarizeReadiness,
  summarizeSleep,
} from './summarize.ts';

export const SERVER_VERSION = '2.0.0';

export interface ToolDeps {
  oura: OuraApi;
  health: HealthStore;
  timeZone: string;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const rangeInput = z.object({
  start_date: z
    .string()
    .regex(DATE_RE, 'Use YYYY-MM-DD')
    .optional()
    .describe('First day, inclusive (YYYY-MM-DD). Defaults to 6 days before end_date.'),
  end_date: z
    .string()
    .regex(DATE_RE, 'Use YYYY-MM-DD')
    .optional()
    .describe("Last day, inclusive (YYYY-MM-DD). Defaults to today in the ring owner's timezone."),
});
type RangeInput = z.infer<typeof rangeInput>;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Server instructions; the net-carbs switchover is shown in the ring owner's timezone. */
function instructions(timeZone: string): string {
  const t = localTime(NET_CARBS_SWITCHOVER_MS, timeZone);
  return `One person's health data. Oura Ring (read-only): get_sleep, get_heart_rate, get_readiness,
get_activity. Apple Health and chat readings: get_health_metrics for weight, waist (in), body_fat (%), lean_mass (lb),
blood pressure, glucose, ketones, protein, net carbs (carbs_g), fiber, fat and calories. Workouts recorded in Apple Health
(for example Peloton rides): get_workouts, one row per workout plus daily totals. get_report_data returns all of
those sections at once for the Weekly Oura Summary report page; in chat, use the individual tools. carbs_g is always net carbs: entries before ${t.date} ${t.time}
(${timeZone}) were entered as net carbs; from then on net carbs = total carbs minus matching fiber (total_carbs_g and
fiber_g show the parts). Entries and workouts edited or deleted in Apple Health, today's included, are corrected automatically
once two phone syncs at least 15 minutes apart agree; until then an edited entry can be counted twice. Whenever the
person reports a home glucose or ketone reading, save it with log_reading (and
delete_reading undoes one). Date-range tools take an optional inclusive start_date/end_date (YYYY-MM-DD) and return
compact daily rows plus the days with no data. Units are in the field names or a unit field (_h hours, _bpm beats/min,
_ms milliseconds, _c degrees Celsius). Sleep metrics belong to the day the person woke up; resting_hr_bpm and
avg_hrv_ms come from the night's main sleep. Scores are Oura's 1-100 scores.`.replace(/\s+/g, ' ');
}

/**
 * The Oura reads behind the tools, one per tool. Sleep and readiness both need Oura's sleep
 * periods; a caller that runs both (get_report_data) fetches them once and passes them in.
 */
export function createOuraReads(oura: OuraApi, timeZone: string) {
  const sleepPeriods = (range: DateRange) => oura.list<SleepPeriod>('sleep', paddedDateParams(range), SLEEP_FIELDS);
  return {
    sleepPeriods,

    async sleep(range: DateRange, periods: Promise<SleepPeriod[]> = sleepPeriods(range)) {
      const q = paddedDateParams(range);
      const [p, daily, spo2] = await Promise.all([
        periods,
        oura.list<DailySleep>('daily_sleep', q, ['day', 'score']),
        // BDI lives in daily_spo2, which needs the separate "spo2" scope; degrade instead of failing.
        oura
          .list<DailySpo2>('daily_spo2', q, ['day', 'breathing_disturbance_index', 'spo2_percentage'])
          .catch((err: unknown) => {
            if (err instanceof OuraApiError && err.status === 403) return null;
            throw err;
          }),
      ]);
      return summarizeSleep(range, { periods: p, daily, spo2 });
    },

    async heartRate(range: DateRange) {
      // Samples are UTC; pad a day each side so every local day is fully covered, then bucket by timezone.
      const windows = chunk(addDays(range.start, -1), addDays(range.end, 2), 7);
      const [sampleChunks, periods] = await Promise.all([
        Promise.all(
          windows.map(([from, to]) =>
            oura.list<HeartRateSample>(
              'heartrate',
              { start_datetime: `${from}T00:00:00Z`, end_datetime: `${to}T00:00:00Z` },
              ['timestamp', 'bpm', 'source'],
            ),
          ),
        ),
        sleepPeriods(range),
      ]);
      return summarizeHeartRate(range, { samples: sampleChunks.flat(), periods, localDate: localDateFormatter(timeZone) });
    },

    async readiness(range: DateRange, periods: Promise<SleepPeriod[]> = sleepPeriods(range)) {
      const [readiness, p] = await Promise.all([
        oura.list<DailyReadiness>('daily_readiness', paddedDateParams(range), [
          'day', 'score', 'temperature_deviation', 'temperature_trend_deviation',
        ]),
        periods,
      ]);
      return summarizeReadiness(range, { readiness, periods: p });
    },

    async activity(range: DateRange) {
      const activity = await oura.list<DailyActivity>('daily_activity', paddedDateParams(range), ACTIVITY_FIELDS);
      return summarizeActivity(range, { activity });
    },
  };
}
export type OuraReads = ReturnType<typeof createOuraReads>;

export function buildServer(deps: ToolDeps): McpServer {
  const { oura, timeZone } = deps;
  const log = deps.log ?? ((msg, extra) => console.log(JSON.stringify({ msg, ...extra })));
  const server = new McpServer({ name: 'oura', version: SERVER_VERSION }, { instructions: instructions(timeZone) });
  registerHealthTools(server, { health: deps.health, timeZone, now: deps.now, log });
  registerWorkoutTools(server, { health: deps.health, timeZone, now: deps.now, log });

  const ouraReads = createOuraReads(oura, timeZone);
  registerReportTool(server, {
    oura: ouraReads,
    readMetrics: createMetricsReader({ health: deps.health, timeZone, now: deps.now, log }),
    readWorkouts: createWorkoutReader({ health: deps.health, timeZone }),
    timeZone,
    now: deps.now,
    log,
  });

  // Each Oura read, kept so the matching prompt runs exactly the same query.
  const reads = new Map<string, { maxDays: number; body: (range: DateRange) => Promise<unknown> }>();

  const run = toolRunner(log);
  /** Wraps an Oura read: resolves the range and logs it; errors become tool errors (tool-run.ts). */
  function tool(name: string, maxDays: number, body: (range: DateRange) => Promise<unknown>) {
    reads.set(name, { maxDays, body });
    return run(name, (input: RangeInput, note) => {
      const range = resolveRange(input, { timeZone, maxDays, now: deps.now?.() });
      note({ start: range.start, end: range.end });
      return body(range);
    });
  }

  server.registerTool(
    'get_sleep',
    {
      title: 'Oura sleep (daily)',
      description:
        'Nightly sleep summary per day (up to 92 days): sleep_score, total_sleep_h, time_in_bed_h, deep_h, rem_h, ' +
        'light_h, efficiency_pct, bedtime, wake_time (local HH:MM), resting_hr_bpm, avg_hrv_ms, avg_breath_rpm, ' +
        'breathing_disturbance_index, spo2_avg_pct, nap_h. Main sleep only; naps are summed in nap_h.',
      inputSchema: rangeInput,
      annotations: { title: 'Oura sleep', ...READ_ONLY },
    },
    tool('get_sleep', 92, (range) => ouraReads.sleep(range)),
  );

  server.registerTool(
    'get_heart_rate',
    {
      title: 'Oura heart rate (daily)',
      description:
        'Daily heart-rate summary (up to 31 days) built from 5-minute samples: resting_hr_bpm (lowest 5-min ' +
        "average during the night's main sleep, as in the Oura app), avg_hrv_ms, avg/min/max_hr_bpm, " +
        'avg_awake_hr_bpm, avg_sleep_hr_bpm, max_workout_hr_bpm, samples.',
      inputSchema: rangeInput,
      annotations: { title: 'Oura heart rate', ...READ_ONLY },
    },
    tool('get_heart_rate', 31, (range) => ouraReads.heartRate(range)),
  );

  server.registerTool(
    'get_readiness',
    {
      title: 'Oura readiness (daily)',
      description:
        'Daily readiness (up to 92 days): readiness_score, temp_deviation_c and temp_trend_deviation_c (body ' +
        'temperature vs. personal baseline), resting_hr_bpm, avg_hrv_ms.',
      inputSchema: rangeInput,
      annotations: { title: 'Oura readiness', ...READ_ONLY },
    },
    tool('get_readiness', 92, (range) => ouraReads.readiness(range)),
  );

  server.registerTool(
    'get_activity',
    {
      title: 'Oura activity (daily)',
      description:
        'Daily activity (up to 92 days): activity_score, steps, active_kcal, total_kcal, walking_equiv_km, ' +
        'high/medium/low_activity_min, sedentary_h, non_wear_h.',
      inputSchema: rangeInput,
      annotations: { title: 'Oura activity', ...READ_ONLY },
    },
    tool('get_activity', 92, (range) => ouraReads.activity(range)),
  );

  const PROMPTS: Record<string, { title: string; what: string }> = {
    get_sleep: { title: 'Oura sleep', what: 'Oura sleep' },
    get_heart_rate: { title: 'Oura heart rate', what: 'Oura heart rate' },
    get_readiness: { title: 'Oura readiness', what: 'Oura readiness' },
    get_activity: { title: 'Oura activity', what: 'Oura activity' },
  };
  for (const [name, { maxDays, body }] of reads) {
    registerRangePrompt(server, { name, ...PROMPTS[name], maxDays, timeZone, now: () => deps.now?.() ?? new Date(), read: body, log });
  }

  return server;
}

/** Splits [from, to) into consecutive windows of at most `size` days. */
function chunk(from: string, to: string, size: number): [string, string][] {
  const out: [string, string][] = [];
  for (let a = from; a < to; a = addDays(a, size)) {
    const b = addDays(a, size);
    out.push([a, daysBetween(b, to) < 0 ? to : b]);
  }
  return out;
}
