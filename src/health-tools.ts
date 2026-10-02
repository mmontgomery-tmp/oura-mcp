import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { addDays, DATE_RE, type DateRange, eachDay, inRange, localDateFormatter, localTime, parseInstant, resolveRange, sortKey } from './dates.ts';
import {
  CHAT_LIMITS,
  CLAUDE_SOURCE,
  dedupeReadings,
  type HealthRow,
  METRICS,
  type Metric,
  NET_CARBS_SWITCHOVER_MS,
  roundFor,
  rowTime,
  SUMMED,
  UNITS,
} from './health.ts';
import type { HealthStore } from './health-store.ts';
import { netCarbsForDay } from './net-carbs.ts';
import { dataMessage, parseRangeArg, PromptInputError, RANGE_DESCRIPTION, requestMessage } from './prompts.ts';

export interface HealthToolDeps {
  health: HealthStore;
  timeZone: string;
  now?: () => Date;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const MAX_DAYS = 92;
const MAX_READINGS = 1000; // keeps a response readable if a CGM ever syncs every 5 minutes
const FUTURE_SLACK_MS = 5 * 60_000;
const SUM_KEYS = { protein: 'protein_g', carbs: 'carbs_g', fat: 'fat_g', calories: 'calories_kcal' } as const;

class ToolInputError extends Error {}

export function registerHealthTools(server: McpServer, deps: HealthToolDeps): void {
  const { health, timeZone, log } = deps;
  const now = () => deps.now?.() ?? new Date();
  const switchover = (() => {
    const t = localTime(NET_CARBS_SWITCHOVER_MS, timeZone);
    return `${t.date} ${t.time} (${timeZone})`;
  })();
  const netCarbsRule =
    `carbs_g is always net carbs. Carbs entries before ${switchover} were entered as net carbs and count as-is ` +
    '(fiber before then is ignored). From then on Apple Health carbs are total carbs and net carbs = carbs - fiber; ' +
    'a fiber entry is subtracted only if a carbs entry has the same time and app, and a day never goes below 0 ' +
    '(a warnings entry explains any clamp or unmatched fiber). total_carbs_g and fiber_g count only entries from ' +
    'the switchover on and are omitted for days before it.';

  function run<I>(name: string, body: (input: I) => Promise<unknown>) {
    return async (input: I) => {
      const started = Date.now();
      try {
        const result = await body(input);
        log('tool ok', { tool: name, ms: Date.now() - started });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('tool error', { tool: name, error: message, kind: err instanceof Error ? err.name : typeof err, ms: Date.now() - started });
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    };
  }

  /** Timestamps as the tools show them: local ISO with offset, e.g. 2026-09-27T07:30:00-07:00. */
  const toSortKey = (timestamp: string) => {
    try {
      return sortKey(parseInstant(timestamp, timeZone));
    } catch (err) {
      throw new ToolInputError(err instanceof Error ? err.message : String(err));
    }
  };

  function presentReading(r: HealthRow) {
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
    metric: z.enum(METRICS),
    timestamp: z
      .string()
      .describe(
        'When the reading was taken: the exact timestamp from log_reading or get_health_metrics ' +
          `(e.g. "2026-09-27T07:30:12-07:00"), or to the minute in ${timeZone} time (e.g. "2026-10-05T07:02") to ` +
          'match any reading in that minute.',
      ),
    value: z
      .number()
      .optional()
      .describe('The reading value (systolic for bp), to pick one when several readings share that minute.'),
    undo: z
      .boolean()
      .optional()
      .describe('true restores an Apple Health reading that was marked removed. Chat readings are deleted permanently.'),
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
        'to the minute), plus value if several readings share that minute.',
      inputSchema: deleteInput,
      annotations: { title: 'Delete reading', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    run('delete_reading', async (input: z.infer<typeof deleteInput>) => {
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
    run('get_health_metrics', (input: z.infer<typeof readInput>) => readMetrics(input)),
  );

  /** The get_health_metrics read, shared by the tool and the prompt. */
  async function readMetrics(input: z.infer<typeof readInput>) {
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
          ((d[metric] ??= []) as unknown[]).push(presentReading(r));
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

  // ---------------------------------------------------------------------------------------
  // Prompts: the same three tools as ready-made commands (see prompts.ts).

  const metricsPromptArgs = z.object({
    metric: z.string().optional().describe('weight, waist, body_fat, lean_mass, bp, glucose, ketones, protein, carbs (net carbs), fiber, fat, calories or all (default: all)'),
    range: z.string().optional().describe(RANGE_DESCRIPTION),
  });
  server.registerPrompt(
    'get_health_metrics',
    {
      title: 'Health metrics',
      description:
        'Your weight, waist, body fat, lean mass, blood pressure, glucose, ketones and nutrition (protein, net carbs, ' +
        'fiber, fat, calories) by day, ' +
        `as a table. Net carbs: entries before ${switchover} count as entered; after it, carbs minus matching fiber.`,
      argsSchema: metricsPromptArgs,
    },
    async (args: z.infer<typeof metricsPromptArgs>) => {
      const data = await readMetrics(parsePromptArgs(args, localDateFormatter(timeZone)(now())));
      log('prompt ok', { prompt: 'get_health_metrics', start: data.range.start, end: data.range.end });
      return dataMessage('health metrics', data.range, timeZone, data);
    },
  );

  const logPromptArgs = z.object({
    metric: z.string().describe('glucose or ketones'),
    value: z.string().describe('The reading, e.g. 94 (glucose, mg/dL) or 1.3 (ketones, mmol/L)'),
    time: z.string().optional().describe('When it was taken, e.g. 07:30 or 2026-09-27T07:30 (default: now)'),
    context: z.string().optional().describe('fasting, post-meal or other'),
    note: z.string().optional().describe('Optional note, up to 200 characters'),
  });
  server.registerPrompt(
    'log_reading',
    {
      title: 'Log a glucose or ketone reading',
      description: 'Pre-fills a request to save a home glucose or ketone reading; Claude saves it with the log_reading tool.',
      argsSchema: logPromptArgs,
    },
    (args: z.infer<typeof logPromptArgs>) => {
      const metric = args.metric.trim().toLowerCase();
      if (metric !== 'glucose' && metric !== 'ketones') throw new PromptInputError('metric must be glucose or ketones.');
      const value = Number(args.value.trim());
      if (!args.value.trim() || !Number.isFinite(value)) throw new PromptInputError(`"${args.value}" is not a number.`);
      const unit = CHAT_LIMITS[metric].unit;
      const parts = [
        `metric: ${metric}`,
        `value: ${value}`,
        `unit: ${unit}`,
        `timestamp: ${args.time?.trim() ? args.time.trim() : 'now (omit it)'}`,
        ...(args.context?.trim() ? [`context: ${args.context.trim()}`] : []),
        ...(args.note?.trim() ? [`note: ${args.note.trim().slice(0, 200)}`] : []),
      ];
      return requestMessage(
        `Log ${metric} ${value} ${unit}`,
        `Log this reading with the log_reading tool, then confirm what was stored:\n- ${parts.join('\n- ')}\n` +
          'A time without a date means today; a time without an offset is local time.',
      );
    },
  );

  const deletePromptArgs = z.object({
    metric: z.string().optional().describe(`${METRICS.join(', ')}`),
    timestamp: z.string().optional().describe('When it was taken, exact or to the minute (leave empty to pick from a list)'),
  });
  server.registerPrompt(
    'delete_reading',
    {
      title: 'Delete or remove a reading',
      description:
        'Pre-fills a request to remove a wrong reading: chat-logged readings are deleted, Apple Health readings are ' +
        'marked removed. Claude asks before changing anything.',
      argsSchema: deletePromptArgs,
    },
    (args: z.infer<typeof deletePromptArgs>) => {
      const metric = args.metric?.trim().toLowerCase();
      if (metric && !(METRICS as readonly string[]).includes(metric)) {
        throw new PromptInputError(`metric must be one of: ${METRICS.join(', ')}.`);
      }
      if (metric && args.timestamp?.trim()) {
        return requestMessage(
          `Remove ${metric} at ${args.timestamp.trim()}`,
          `Remove my ${metric} reading at ${args.timestamp.trim()} with the delete_reading tool, then confirm what ` +
            'changed. If it came from Apple Health, remind me to delete it there too.',
        );
      }
      return requestMessage(
        'Choose a reading to remove',
        `Show my ${metric ?? 'weight, waist, body fat, blood pressure, glucose and ketone'} readings from the last 7 days using ` +
          'get_health_metrics, numbered, and ask me which one to remove. Then remove it with delete_reading and ' +
          'confirm. If it came from Apple Health, remind me to delete it there too.',
      );
    },
  );
}

const METRIC_ALIASES: Record<string, Metric | 'all'> = {
  'blood pressure': 'bp',
  'waist circumference': 'waist',
  'body fat': 'body_fat',
  'body fat percentage': 'body_fat',
  bodyfat: 'body_fat',
  'lean mass': 'lean_mass',
  'lean body mass': 'lean_mass',
  'net carbs': 'carbs',
  'total carbs': 'carbs',
  'dietary fiber': 'fiber',
  'total fat': 'fat',
  nutrition: 'all',
  macros: 'all',
  '': 'all',
};

const DAY_KEYS = ['date', 'weight', 'waist', 'body_fat', 'lean_mass', 'bp', 'glucose', 'ketones', 'protein_g', 'carbs_g', 'total_carbs_g', 'fiber_g', 'fat_g', 'calories_kcal', 'warnings'];

/** Day fields in a fixed, readable order. */
function ordered<T extends Record<string, unknown>>(d: T): T {
  return Object.fromEntries(DAY_KEYS.filter((k) => k in d).map((k) => [k, d[k]])) as T;
}

/** Free-text get_health_metrics prompt arguments -> tool input. Throws a readable error for bad values. */
export function parsePromptArgs(args: { metric?: string; range?: string }, today: string) {
  const m = (args.metric ?? '').trim().toLowerCase();
  const metric = METRIC_ALIASES[m] ?? ([...METRICS, 'all'] as string[]).find((x) => x === m);
  if (!metric) throw new PromptInputError(`Unknown metric "${args.metric}". Use one of: ${METRICS.join(', ')}, all.`);
  return { metric: metric as Metric | 'all', ...parseRangeArg(args.range, today, MAX_DAYS) };
}
