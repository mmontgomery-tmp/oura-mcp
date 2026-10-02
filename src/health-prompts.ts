// Prompts for the health tools: the same three tools as ready-made commands (see prompts.ts).
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { localDateFormatter } from './dates.ts';
import { CHAT_LIMITS, METRICS, type Metric } from './health.ts';
import { type HealthToolDeps, MAX_DAYS, type MetricsQuery, switchoverText } from './health-read.ts';
import { dataMessage, parseRangeArg, PromptInputError, RANGE_DESCRIPTION, requestMessage } from './prompts.ts';

/** What delete_reading can remove: any health metric, or a workout. */
export const REMOVABLE = [...METRICS, 'workout'] as const;

export function registerHealthPrompts(
  server: McpServer,
  deps: HealthToolDeps,
  readMetrics: (input: MetricsQuery) => Promise<{ range: { start: string; end: string } }>,
): void {
  const { timeZone, log } = deps;
  const now = () => deps.now?.() ?? new Date();
  const switchover = switchoverText(timeZone);

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
    metric: z.string().optional().describe(`${REMOVABLE.join(', ')}`),
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
      if (metric && !(REMOVABLE as readonly string[]).includes(metric)) {
        throw new PromptInputError(`metric must be one of: ${REMOVABLE.join(', ')}.`);
      }
      if (metric && args.timestamp?.trim()) {
        return requestMessage(
          `Remove ${metric} at ${args.timestamp.trim()}`,
          `Remove my ${metric === 'workout' ? 'workout that started' : `${metric} reading`} at ${args.timestamp.trim()} with the delete_reading tool, then confirm what ` +
            'changed. If it came from Apple Health, remind me to delete it there too.',
        );
      }
      if (metric === 'workout') {
        return requestMessage(
          'Choose a workout to remove',
          'Show my workouts from the last 7 days using get_workouts, numbered, and ask me which one to remove. Then ' +
            'remove it with delete_reading (metric "workout", timestamp its start time) and confirm. Remind me to ' +
            'delete it in Apple Health too.',
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

/** Free-text get_health_metrics prompt arguments -> tool input. Throws a readable error for bad values. */
export function parsePromptArgs(args: { metric?: string; range?: string }, today: string) {
  const m = (args.metric ?? '').trim().toLowerCase();
  const metric = METRIC_ALIASES[m] ?? ([...METRICS, 'all'] as string[]).find((x) => x === m);
  if (!metric) throw new PromptInputError(`Unknown metric "${args.metric}". Use one of: ${METRICS.join(', ')}, all.`);
  return { metric: metric as Metric | 'all', ...parseRangeArg(args.range, today, MAX_DAYS) };
}
