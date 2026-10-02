// The health tools: log_reading, delete_reading and get_health_metrics. The read itself is in
// health-read.ts and the prompts are in health-prompts.ts.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DATE_RE, localTime, parseInstant, sortKey } from './dates.ts';
import { CHAT_LIMITS, CLAUDE_SOURCE, type HealthRow, METRICS, roundFor, rowTime, UNITS } from './health.ts';
import { registerHealthPrompts, REMOVABLE } from './health-prompts.ts';
import { createMetricsReader, type HealthToolDeps, MAX_DAYS, type MetricsQuery, presentReading as present, switchoverText } from './health-read.ts';
import { ToolInputError, toolRunner } from './tool-run.ts';
import { removeWorkout } from './workout-tools.ts';

export type { HealthToolDeps } from './health-read.ts';
export { parsePromptArgs } from './health-prompts.ts';

const FUTURE_SLACK_MS = 5 * 60_000;

export function registerHealthTools(server: McpServer, deps: HealthToolDeps): void {
  const { health, timeZone, log } = deps;
  const now = () => deps.now?.() ?? new Date();
  const run = toolRunner(log);
  const readMetrics = createMetricsReader(deps);
  const presentReading = (r: HealthRow) => present(r, timeZone);
  const switchover = switchoverText(timeZone);
  const netCarbsRule =
    `carbs_g is always net carbs. Carbs entries before ${switchover} were entered as net carbs and count as-is ` +
    '(fiber before then is ignored). From then on Apple Health carbs are total carbs and net carbs = carbs - fiber; ' +
    'a fiber entry is subtracted only if a carbs entry has the same time and app, and a day never goes below 0 ' +
    '(a warnings entry explains any clamp or unmatched fiber). total_carbs_g and fiber_g count only entries from ' +
    'the switchover on and are omitted for days before it.';

  /** Timestamps as the tools show them: local ISO with offset, e.g. 2026-09-27T07:30:00-07:00. */
  const toSortKey = (timestamp: string) => {
    try {
      return sortKey(parseInstant(timestamp, timeZone));
    } catch (err) {
      throw new ToolInputError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---------------------------------------------------------------------------------------

  const logInput = z.object({
    metric: z.enum(['glucose', 'ketones']).describe('glucose = blood glucose (mg/dL); ketones = blood ketones / BHB (mmol/L).'),
    value: z.number().describe('The number the user reported.'),
    unit: z.string().describe('Must be "mg/dL" for glucose or "mmol/L" for ketones.'),
    timestamp: z
      .string()
      .optional()
      .describe(
        `When the reading was taken, ISO 8601. Without an offset it is local time in ${timeZone} ` +
          '(e.g. "2026-09-27T07:30"). Omit it for "just now".',
      ),
    context: z
      .enum(['fasting', 'post-meal', 'other'])
      .optional()
      .describe('fasting = before eating after an overnight fast; post-meal = after eating; other = anything else.'),
    note: z.string().max(200).optional().describe('Short free-text note from the user, max 200 characters.'),
  });

  server.registerTool(
    'log_reading',
    {
      title: 'Log a glucose or ketone reading',
      description:
        'Save a home blood glucose or blood ketone reading. Use this tool whenever the user reports a glucose or ' +
        'ketone number they measured (e.g. "fasting glucose 94", "ketones 1.3 after my walk"), then confirm what ' +
        `was stored. Glucose must be in mg/dL (20–600) and ketones in mmol/L (0–10); anything else is rejected ` +
        `without saving. If the user says when it was taken, pass timestamp (local ${timeZone} time unless they ` +
        'give an offset); otherwise omit it to use now. Set context when the user makes it clear (fasting / ' +
        'post-meal). Returns the stored row, including the timestamp delete_reading needs to undo it.',
      inputSchema: logInput,
      annotations: { title: 'Log reading', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run('log_reading', async (input: z.infer<typeof logInput>) => {
      const limits = CHAT_LIMITS[input.metric];
      // Exact unit only: chat readings are never converted (ingest does convert, e.g. mmol/L glucose).
      const normUnit = (u: string) => u.toLowerCase().replace(/\s+/g, '');
      if (normUnit(input.unit) !== normUnit(limits.unit)) {
        const hint = input.metric === 'glucose' ? ' (mg/dL = mmol/L × 18)' : '';
        throw new ToolInputError(
          `${input.metric} must be reported in ${limits.unit}; got "${input.unit}". Nothing was saved${hint}.`,
        );
      }
      if (!Number.isFinite(input.value) || input.value < limits.min || input.value > limits.max) {
        throw new ToolInputError(
          `${input.metric} ${input.value} ${limits.unit} is outside the accepted range ` +
            `${limits.min}–${limits.max} ${limits.unit}. Nothing was saved.`,
        );
      }
      const at = input.timestamp ? Date.parse(toSortKey(input.timestamp)) : now().getTime();
      if (at > now().getTime() + FUTURE_SLACK_MS) {
        throw new ToolInputError(`Timestamp ${input.timestamp} is in the future. Nothing was saved.`);
      }
      const row: HealthRow = {
        metric: input.metric,
        ts: sortKey(at),
        value: roundFor(input.metric, input.value),
        unit: UNITS[input.metric],
        original_value: input.value,
        original_unit: input.unit,
        source: CLAUDE_SOURCE,
        via: 'chat',
        ...(input.context ? { context: input.context } : {}),
        ...(input.note ? { note: input.note } : {}),
        recorded_at: input.timestamp ?? localTime(at, timeZone).iso,
        ingested_at: now().toISOString(),
      };
      const res = await health.putChatReading(row);
      if (!res.ok) {
        throw new ToolInputError(
          `An Apple Health ${input.metric} reading from ${res.existing.source} already exists at exactly this second; ` +
            'nothing was saved. Use a slightly different timestamp if this is a separate reading.',
        );
      }
      const t = localTime(at, timeZone);
      return { stored: { metric: row.metric, date: t.date, ...presentReading(row) } };
    }),
  );

  // ---------------------------------------------------------------------------------------

  const deleteInput = z.object({
    metric: z.enum(REMOVABLE).describe('The reading\'s metric, or "workout" to remove a workout.'),
    timestamp: z
      .string()
      .describe(
        'When the reading was taken (for a workout: when it started): the exact timestamp from log_reading or ' +
          `get_health_metrics (e.g. "2026-09-27T07:30:12-07:00"), or to the minute in ${timeZone} time ` +
          '(e.g. "2026-10-05T07:02") to match any reading in that minute.',
      ),
    value: z
      .number()
      .optional()
      .describe(
        'The reading value (systolic for bp; duration in minutes for a workout), to pick one when several share that minute.',
      ),
    undo: z
      .boolean()
      .optional()
      .describe('true restores an Apple Health reading or workout that was marked removed. Chat readings are deleted permanently.'),
  });

  server.registerTool(
    'delete_reading',
    {
      title: 'Delete or remove a reading',
      description:
        'Remove a reading the user says is wrong. A reading logged in chat (source "claude-log") is deleted. An ' +
        'Apple Health reading (weight, waist, body_fat, lean_mass, bp, glucose, protein, carbs, fiber, fat, calories ' +
        'from the phone) is marked removed ' +
        '(superseded): it stops counting in get_health_metrics but stays in the table. It is still in Apple Health, ' +
        'so tell the user to delete it there too, or the next Health Auto Export push restores it. undo: true ' +
        'restores an Apple Health reading marked removed. Identify the reading by metric and timestamp (exact, or ' +
        'to the minute), plus value if several readings share that minute. A workout is removed the same way: ' +
        'metric "workout", timestamp its start time (from get_workouts), value its duration in minutes if several ' +
        'started in that minute.',
      inputSchema: deleteInput,
      annotations: { title: 'Delete reading', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    run('delete_reading', async (input: z.infer<typeof deleteInput>) => {
      if (input.metric === 'workout') return removeWorkout({ health, timeZone, now }, input);
      const { metric } = input;
      let at: number;
      try {
        at = parseInstant(input.timestamp, timeZone);
      } catch (err) {
        throw new ToolInputError(err instanceof Error ? err.message : String(err));
      }
      // Without seconds, match anything in that minute (get_health_metrics shows HH:MM for Apple Health readings).
      const toSecond = /\d{2}:\d{2}:\d{2}/.test(input.timestamp);
      const from = sortKey(at);
      const to = sortKey(toSecond ? at : at + 59_000);
      const describe = (r: HealthRow) => {
        const t = localTime(rowTime(r), timeZone);
        const v = r.metric === 'bp' ? `${r.systolic}/${r.diastolic}` : `${r.value}`;
        return `${t.iso.slice(11, 19)} ${v} ${r.unit} (${r.source})`;
      };
      const matchesValue = (r: HealthRow) =>
        input.value === undefined || Math.abs((r.metric === 'bp' ? r.systolic! : r.value!) - input.value) < 0.051;

      const atTime = await health.query(metric, from, `${to}~`);
      const candidates = atTime.filter(
        (r) => matchesValue(r) && (input.undo ? r.via === 'hae' && (r.superseded_at || r.missing_since) : !r.superseded_at),
      );
      if (candidates.length === 0) {
        const others = atTime.filter((r) => !r.superseded_at);
        if (input.undo) {
          throw new ToolInputError(
            `No removed Apple Health ${metric} reading at ${input.timestamp}. Chat readings are deleted permanently; ` +
              'log it again with log_reading.',
          );
        }
        throw new ToolInputError(
          `No ${metric} reading${input.value !== undefined ? ` of ${input.value}` : ''} at ${input.timestamp}.` +
            (others.length ? ` Readings at that time: ${others.map(describe).join('; ')}.` : ' Check the time with get_health_metrics.'),
        );
      }
      if (candidates.length > 1) {
        throw new ToolInputError(
          `${candidates.length} ${metric} readings match ${input.timestamp}: ${candidates.map(describe).join('; ')}. ` +
            'Pass value (or the exact timestamp) to choose one. Nothing was changed.',
        );
      }

      const row = candidates[0];
      const t = localTime(rowTime(row), timeZone);
      const shown = { metric: row.metric, date: t.date, ...presentReading(row), timestamp: t.iso };
      if (input.undo) {
        const { superseded_at: _s, superseded_by: _b, missing_since: _m, ...restored } = row;
        await health.writeRows([restored]);
        return { restored: shown, note: 'It counts in get_health_metrics again.' };
      }
      if (row.via === 'chat') {
        const res = await health.deleteChatReading(metric, row.ts);
        if (res.kind !== 'deleted') throw new ToolInputError(`That ${metric} reading changed in the meantime; nothing was deleted.`);
        return { deleted: shown };
      }
      await health.writeRows([{ ...row, superseded_at: now().toISOString(), superseded_by: 'chat' }]);
      return {
        removed: shown,
        note:
          `Marked removed: it no longer counts in get_health_metrics. It is still in Apple Health (${row.source}), so ` +
          'delete it there first, or the next Health Auto Export push will send it again and clear this mark. ' +
          'To undo, call delete_reading with undo: true.',
      };
    }),
  );

  // ---------------------------------------------------------------------------------------

  const readInput = z.object({
    metric: z.enum([...METRICS, 'all']).describe('One metric, or "all".'),
    start_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe('First day, inclusive (YYYY-MM-DD). Defaults to 6 days before end_date.'),
    end_date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe(`Last day, inclusive (YYYY-MM-DD). Defaults to today in ${timeZone}.`),
  });

  server.registerTool(
    'get_health_metrics',
    {
      title: 'Health metrics (daily)',
      description:
        `Weight, waist, body fat, lean mass, blood pressure, glucose, ketones and nutrition by day (up to ${MAX_DAYS} ` +
        `days, ${timeZone}). ` +
        'protein_g, carbs_g (net carbs), total_carbs_g, fiber_g, fat_g and calories_kcal are daily sums. ' +
        `${netCarbsRule} weight (lb), waist (in), body_fat (%), lean_mass (lb), bp (mmHg), glucose (mg/dL) and ketones ` +
        '(mmol/L) list each reading with time, value(s), unit, context and source. Readings come from Apple Health ' +
        '(source = the recording app) or from chat (source "claude-log", with the timestamp delete_reading needs). ' +
        'An Apple Health reading that duplicates a chat reading (within 15 min and 5%) is shown once.',
      inputSchema: readInput,
      annotations: { title: 'Health metrics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    run('get_health_metrics', (input: MetricsQuery) => readMetrics(input)),
  );

  registerHealthPrompts(server, deps, readMetrics);
}
