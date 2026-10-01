import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { addDays, DATE_RE, type DateRange, localDateFormatter, resolveRange } from './dates.ts';

// MCP prompts mirror the tools so clients can list them as ready-made commands (claude.ai: "+" >
// Connectors > this connector; Claude Code: /mcp__<connector>__<name>). Tools never appear in those
// menus; prompts do. Read prompts fetch the data here and embed it. Write prompts only pre-fill a
// request, because fetching a prompt must never change anything.

export class PromptInputError extends Error {
  override name = 'InvalidPromptArgument';
}

export const RANGE_DESCRIPTION = '7d, 30d or 90d; a start date YYYY-MM-DD; or "YYYY-MM-DD YYYY-MM-DD" (default: the last 7 days)';

/** Free-text range ("30d", "7 days", "2026-09-01", "2026-09-01 to 2026-09-15") -> tool date inputs. */
export function parseRangeArg(range: string | undefined, today: string, maxDays: number): { start_date?: string; end_date?: string } {
  const r = (range ?? '').trim().toLowerCase();
  if (!r) return {};
  const days = /^(\d{1,3})\s*(d|day|days)$/.exec(r);
  if (days) {
    const n = Number(days[1]);
    if (n < 1 || n > maxDays) throw new PromptInputError(`Range must be 1–${maxDays} days.`);
    return { start_date: addDays(today, -(n - 1)) };
  }
  const dates = r.split(/\s*(?:\.\.|to|\s)\s*/).filter(Boolean);
  if (dates.length <= 2 && dates.every((d) => DATE_RE.test(d))) {
    return dates[1] ? { start_date: dates[0], end_date: dates[1] } : { start_date: dates[0] };
  }
  throw new PromptInputError(`Unrecognized range "${range}". Use 7d, 30d, 90d, YYYY-MM-DD, or "YYYY-MM-DD YYYY-MM-DD".`);
}

const TABLE_INSTRUCTIONS =
  'Show them as one compact table, one row per day, with columns only for fields that have data. Then list ' +
  "the days without data on one line and repeat any notes. Don't add health commentary unless I ask.";

/** A prompt result carrying data fetched by the server, plus how to present it. */
export function dataMessage(what: string, range: DateRange, timeZone: string, data: unknown) {
  return {
    description: `${what}, ${range.start} to ${range.end}`,
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `Here is my ${what} from ${range.start} to ${range.end} (${timeZone}), fetched from my Oura/health ` +
            `connector. ${TABLE_INSTRUCTIONS}\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
        },
      },
    ],
  };
}

/** A prompt result that asks Claude to do something (used by the write prompts). */
export function requestMessage(description: string, text: string) {
  return { description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** Registers a read prompt that takes only a `range` and embeds the result of `read`. */
export function registerRangePrompt(
  server: McpServer,
  opts: {
    name: string;
    title: string;
    what: string;
    maxDays: number;
    timeZone: string;
    now: () => Date;
    read: (range: DateRange) => Promise<unknown>;
    log: (msg: string, extra?: Record<string, unknown>) => void;
  },
): void {
  const args = z.object({ range: z.string().optional().describe(RANGE_DESCRIPTION) });
  server.registerPrompt(
    opts.name,
    { title: opts.title, description: `Your ${opts.what} by day, as a table (up to ${opts.maxDays} days).`, argsSchema: args },
    async ({ range }: z.infer<typeof args>) => {
      const today = localDateFormatter(opts.timeZone)(opts.now());
      const resolved = resolveRange(parseRangeArg(range, today, opts.maxDays), { timeZone: opts.timeZone, maxDays: opts.maxDays, now: opts.now() });
      const data = await opts.read(resolved);
      opts.log('prompt ok', { prompt: opts.name, start: resolved.start, end: resolved.end });
      return dataMessage(opts.what, resolved, opts.timeZone, data);
    },
  );
}
