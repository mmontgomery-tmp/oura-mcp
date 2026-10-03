// get_report_data: everything the Weekly Oura Summary report page shows, in one call. The page
// used to make five calls per load (get_health_metrics "all", get_sleep, get_activity,
// get_readiness and get_workouts over the same range), each a separate round trip through
// claude.ai and a separate Lambda invocation. Chats keep using the individual tools.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DATE_RE, type DateRange, resolveRange } from './dates.ts';
import type { MetricsQuery } from './health-read.ts';
import { type Log, toolRunner } from './tool-run.ts';
import type { OuraReads } from './tools.ts';

/** A year and a day: enough for a report page that loads everything since its first day for a year. */
export const REPORT_MAX_DAYS = 366;

export interface ReportToolDeps {
  oura: OuraReads;
  readMetrics: (input: MetricsQuery, maxDays?: number) => Promise<unknown>;
  readWorkouts: (range: DateRange) => Promise<unknown>;
  timeZone: string;
  now?: () => Date;
  log: Log;
}

/** A section's payload, or {error: {message}} if that section failed; the other sections still return. */
async function section<T>(read: Promise<T>): Promise<T | { error: { message: string } }> {
  try {
    return await read;
  } catch (err) {
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

export function registerReportTool(server: McpServer, deps: ReportToolDeps): void {
  const { oura, readMetrics, readWorkouts, timeZone, log } = deps;
  const run = toolRunner(log);
  const input = z.object({
    start_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe('First day, inclusive (YYYY-MM-DD). Defaults to 6 days before end_date.'),
    end_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe(`Last day, inclusive (YYYY-MM-DD). Defaults to today in ${timeZone}.`),
  });

  server.registerTool(
    'get_report_data',
    {
      title: 'Report page data',
      description:
        'Serves the Weekly Oura Summary report page: in one call, the payloads of get_health_metrics (metric "all"), ' +
        `get_sleep, get_activity, get_readiness and get_workouts for the same range (up to ${REPORT_MAX_DAYS} days), as ` +
        '{range, timezone, health, sleep, activity, readiness, workouts}. A section that fails is {error: {message}} ' +
        'and the others still return. In chat, use the individual tools instead: their responses are smaller and ' +
        'their descriptions explain each field.',
      inputSchema: input,
      annotations: { title: 'Report page data', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    run('get_report_data', async (args: z.infer<typeof input>, note) => {
      const range = resolveRange(args, { timeZone, maxDays: REPORT_MAX_DAYS, now: deps.now?.() });
      // Sleep and readiness share one fetch of Oura's sleep periods. Each awaits it, so a failure
      // shows up in both sections and is never an unhandled rejection.
      const periods = oura.sleepPeriods(range);
      const [health, sleep, activity, readiness, workouts] = await Promise.all([
        section(readMetrics({ metric: 'all', start_date: range.start, end_date: range.end }, REPORT_MAX_DAYS)),
        section(oura.sleep(range, periods)),
        section(oura.activity(range)),
        section(oura.readiness(range, periods)),
        section(readWorkouts(range)),
      ]);
      const sections = { health, sleep, activity, readiness, workouts };
      const failed = Object.entries(sections).filter(([, v]) => v && typeof v === 'object' && 'error' in v).map(([k]) => k);
      note({ start: range.start, end: range.end, ...(failed.length ? { failed_sections: failed } : {}) });
      return { range, timezone: timeZone, ...sections };
    }),
  );
}
