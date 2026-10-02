import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { addDays, DATE_RE, type DateRange, eachDay, inRange, localDateFormatter, localTime, resolveRange } from './dates.ts';
import { rowTime } from './health.ts';
import type { HealthStore } from './health-store.ts';
import { parseRangeArg, RANGE_DESCRIPTION } from './prompts.ts';
import type { WorkoutRow } from './workouts.ts';

export interface WorkoutToolDeps {
  health: HealthStore;
  timeZone: string;
  now?: () => Date;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const MAX_DAYS = 92;
const MAX_WORKOUTS = 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function registerWorkoutTools(server: McpServer, deps: WorkoutToolDeps): void {
  const { health, timeZone, log } = deps;
  const now = () => deps.now?.() ?? new Date();

  const input = z.object({
    start_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe('First day, inclusive (YYYY-MM-DD). Defaults to 6 days before end_date.'),
    end_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe(`Last day, inclusive (YYYY-MM-DD). Defaults to today in ${timeZone}.`),
  });

  /** The get_workouts read, shared by the tool and the prompt. */
  async function readWorkouts(range: DateRange) {
    // Pad a UTC day each side (any timezone's local days are then covered), filter by local date.
    const stored = await health.queryWorkouts(`${addDays(range.start, -1)}T00:00:00Z`, `${addDays(range.end, 2)}T00:00:00Z`);
    type Day = { date: string; workouts: number; duration_min: number; active_kcal?: number };
    const days = new Map<string, Day>();
    const workouts: Record<string, unknown>[] = [];
    let left = 0;

    // Superseded workouts were deleted or edited in Apple Health. A workout belongs to the day it started.
    for (const w of stored.filter((r: WorkoutRow) => !r.superseded_at)) {
      const start = localTime(rowTime(w), timeZone);
      if (!inRange(start.date, range)) continue;
      const minutes = w.duration_s / 60;
      const d = days.get(start.date) ?? { date: start.date, workouts: 0, duration_min: 0 };
      d.workouts++;
      d.duration_min += minutes;
      if (w.active_kcal !== undefined) d.active_kcal = (d.active_kcal ?? 0) + w.active_kcal;
      days.set(start.date, d);
      if (workouts.length >= MAX_WORKOUTS) {
        left++;
        continue;
      }
      workouts.push({
        date: start.date,
        start: start.time,
        end: localTime(Date.parse(w.end), timeZone).time,
        type: w.name,
        duration_min: round1(minutes),
        ...(w.active_kcal !== undefined ? { active_kcal: Math.round(w.active_kcal) } : {}),
        ...(w.avg_hr_bpm !== undefined ? { avg_hr_bpm: w.avg_hr_bpm } : {}),
        ...(w.max_hr_bpm !== undefined ? { max_hr_bpm: w.max_hr_bpm } : {}),
        source: w.source,
      });
    }
    return {
      range,
      timezone: timeZone,
      workouts,
      days: [...days.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((d) => ({
          date: d.date,
          workouts: d.workouts,
          duration_min: round1(d.duration_min),
          ...(d.active_kcal !== undefined ? { active_kcal: Math.round(d.active_kcal) } : {}),
        })),
      days_without_workouts: eachDay(range).filter((d) => !days.has(d)),
      ...(left ? { notes: [`Showing the first ${MAX_WORKOUTS} workouts; ask for a shorter range for the other ${left}. Daily totals cover all of them.`] } : {}),
    };
  }

  server.registerTool(
    'get_workouts',
    {
      title: 'Workouts',
      description:
        `Workouts recorded in Apple Health (for example Peloton rides), up to ${MAX_DAYS} days, in ${timeZone} time. ` +
        'workouts has one row per workout: date, start and end (local HH:MM), type, duration_min, active_kcal, ' +
        'avg_hr_bpm and max_hr_bpm when the workout recorded them, and source (the recording app, or "unknown"). ' +
        'days has the daily totals: workouts, duration_min and active_kcal. A workout belongs to the day it started. ' +
        'Workouts edited or deleted in Apple Health drop out automatically after two phone syncs at least 15 minutes ' +
        'apart. For Oura activity scores, steps and calories use get_activity instead.',
      inputSchema: input,
      annotations: { title: 'Workouts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof input>) => {
      const started = Date.now();
      try {
        const range = resolveRange(args, { timeZone, maxDays: MAX_DAYS, now: now() });
        const result = await readWorkouts(range);
        log('tool ok', { tool: 'get_workouts', start: range.start, end: range.end, ms: Date.now() - started });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('tool error', { tool: 'get_workouts', error: message, kind: err instanceof Error ? err.name : typeof err, ms: Date.now() - started });
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    },
  );

  const promptArgs = z.object({ range: z.string().optional().describe(RANGE_DESCRIPTION) });
  server.registerPrompt(
    'get_workouts',
    {
      title: 'Workouts',
      description: `Your workouts from Apple Health, one row per workout plus daily totals (up to ${MAX_DAYS} days).`,
      argsSchema: promptArgs,
    },
    async ({ range }: z.infer<typeof promptArgs>) => {
      const today = localDateFormatter(timeZone)(now());
      const resolved = resolveRange(parseRangeArg(range, today, MAX_DAYS), { timeZone, maxDays: MAX_DAYS, now: now() });
      const data = await readWorkouts(resolved);
      log('prompt ok', { prompt: 'get_workouts', start: resolved.start, end: resolved.end });
      return {
        description: `workouts, ${resolved.start} to ${resolved.end}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Here are my workouts from ${resolved.start} to ${resolved.end} (${timeZone}), fetched from my Oura/health ` +
                'connector. Show them as one compact table, one row per workout, with columns only for fields that have ' +
                'data, then one line of totals for the period (workouts, minutes, active kcal). List the days without ' +
                "a workout on one line and repeat any notes. Don't add health commentary unless I ask.\n\n" +
                `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
            },
          },
        ],
      };
    },
  );
}
