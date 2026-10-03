import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { addDays, DATE_RE, type DateRange, eachDay, inRange, localDateFormatter, localTime, parseInstant, resolveRange, sortKey } from './dates.ts';
import { rowTime } from './health.ts';
import type { HealthStore } from './health-store.ts';
import { parseRangeArg, RANGE_DESCRIPTION } from './prompts.ts';
import { type Log, ToolInputError, toolRunner } from './tool-run.ts';
import type { WorkoutRow } from './workouts.ts';

export interface WorkoutToolDeps {
  health: HealthStore;
  timeZone: string;
  now?: () => Date;
  log: Log;
}

const MAX_DAYS = 92;
const MAX_WORKOUTS = 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** One workout as the tools show it. A workout belongs to the day it started. */
function presentWorkout(w: WorkoutRow, timeZone: string) {
  const start = localTime(rowTime(w), timeZone);
  return {
    date: start.date,
    start: start.time,
    end: localTime(Date.parse(w.end), timeZone).time,
    type: w.name,
    duration_min: round1(w.duration_s / 60),
    ...(w.active_kcal !== undefined ? { active_kcal: Math.round(w.active_kcal) } : {}),
    ...(w.avg_hr_bpm !== undefined ? { avg_hr_bpm: w.avg_hr_bpm } : {}),
    ...(w.max_hr_bpm !== undefined ? { max_hr_bpm: w.max_hr_bpm } : {}),
    source: w.source,
  };
}

/**
 * delete_reading for a workout: marks it removed (superseded by chat), or restores it with undo.
 * Workouts only come from Apple Health, so nothing is ever deleted. `value` is the duration in
 * minutes, to pick one when several workouts started in the same minute.
 */
export async function removeWorkout(
  deps: { health: HealthStore; timeZone: string; now: () => Date },
  input: { timestamp: string; value?: number; undo?: boolean },
) {
  const { health, timeZone } = deps;
  let at: number;
  try {
    at = parseInstant(input.timestamp, timeZone);
  } catch (err) {
    throw new ToolInputError(err instanceof Error ? err.message : String(err));
  }
  // Without seconds, match any workout that started in that minute (get_workouts shows HH:MM).
  const toSecond = /\d{2}:\d{2}:\d{2}/.test(input.timestamp);
  const startedThen = await health.queryWorkouts(sortKey(at), `${sortKey(toSecond ? at : at + 59_000)}~`);
  const describe = (w: WorkoutRow) => {
    const p = presentWorkout(w, timeZone);
    return `${p.start} ${p.type}, ${p.duration_min} min (${p.source})`;
  };
  const matchesValue = (w: WorkoutRow) => input.value === undefined || Math.abs(round1(w.duration_s / 60) - input.value) < 0.051;
  const candidates = startedThen.filter((w) => matchesValue(w) && (input.undo ? w.superseded_at || w.missing_since : !w.superseded_at));

  if (candidates.length === 0) {
    if (input.undo) throw new ToolInputError(`No removed workout started at ${input.timestamp}.`);
    const others = startedThen.filter((w) => !w.superseded_at);
    throw new ToolInputError(
      `No workout${input.value !== undefined ? ` of ${input.value} minutes` : ''} started at ${input.timestamp}.` +
        (others.length ? ` Workouts that started then: ${others.map(describe).join('; ')}.` : ' Check the start time with get_workouts.'),
    );
  }
  if (candidates.length > 1) {
    throw new ToolInputError(
      `${candidates.length} workouts started at ${input.timestamp}: ${candidates.map(describe).join('; ')}. ` +
        'Pass value (the duration in minutes) or the exact start time to choose one. Nothing was changed.',
    );
  }

  const row = candidates[0];
  const shown = { metric: 'workout', ...presentWorkout(row, timeZone), timestamp: localTime(rowTime(row), timeZone).iso };
  if (input.undo) {
    const { superseded_at: _s, superseded_by: _b, missing_since: _m, ...restored } = row;
    await health.writeRows([restored]);
    return { restored: shown, note: 'It counts in get_workouts again.' };
  }
  await health.writeRows([{ ...row, superseded_at: deps.now().toISOString(), superseded_by: 'chat' }]);
  return {
    removed: shown,
    note:
      `Marked removed: it no longer counts in get_workouts. It is still in Apple Health (${row.source}), so delete it ` +
      'there first, or the next Health Auto Export push will send it again and clear this mark. To undo, call ' +
      'delete_reading with metric "workout" and undo: true.',
  };
}

/** The get_workouts read, shared by the tool, its prompt and get_report_data. */
export function createWorkoutReader(deps: { health: HealthStore; timeZone: string }) {
  const { health, timeZone } = deps;
  return async function readWorkouts(range: DateRange) {
    // Pad a UTC day each side (any timezone's local days are then covered), filter by local date.
    const stored = await health.queryWorkouts(`${addDays(range.start, -1)}T00:00:00Z`, `${addDays(range.end, 2)}T00:00:00Z`);
    type Day = { date: string; workouts: number; duration_min: number; active_kcal?: number };
    const days = new Map<string, Day>();
    const workouts: ReturnType<typeof presentWorkout>[] = [];
    let left = 0;

    // Superseded workouts were deleted or edited in Apple Health, or removed with delete_reading.
    for (const w of stored.filter((r) => !r.superseded_at)) {
      const date = localTime(rowTime(w), timeZone).date;
      if (!inRange(date, range)) continue;
      const d = days.get(date) ?? { date, workouts: 0, duration_min: 0 };
      d.workouts++;
      d.duration_min += w.duration_s / 60;
      if (w.active_kcal !== undefined) d.active_kcal = (d.active_kcal ?? 0) + w.active_kcal;
      days.set(date, d);
      if (workouts.length >= MAX_WORKOUTS) left++;
      else workouts.push(presentWorkout(w, timeZone));
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
  };
}

export function registerWorkoutTools(server: McpServer, deps: WorkoutToolDeps): void {
  const { health, timeZone, log } = deps;
  const now = () => deps.now?.() ?? new Date();
  const run = toolRunner(log);

  const input = z.object({
    start_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe('First day, inclusive (YYYY-MM-DD). Defaults to 6 days before end_date.'),
    end_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe(`Last day, inclusive (YYYY-MM-DD). Defaults to today in ${timeZone}.`),
  });

  const readWorkouts = createWorkoutReader({ health, timeZone });

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
        'apart; to remove a wrong one by hand, use delete_reading with metric "workout" and its start time. For Oura ' +
        'activity scores, steps and calories use get_activity instead.',
      inputSchema: input,
      annotations: { title: 'Workouts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    run('get_workouts', (args: z.infer<typeof input>, note) => {
      const range = resolveRange(args, { timeZone, maxDays: MAX_DAYS, now: now() });
      note({ start: range.start, end: range.end });
      return readWorkouts(range);
    }),
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
