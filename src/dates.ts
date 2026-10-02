const DAY_MS = 86_400_000;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RangeError400 extends Error {
  override name = 'InvalidRange';
}

function toUtcMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!DATE_RE.test(date) || Number.isNaN(ms)) throw new RangeError400(`Invalid date "${date}" (expected YYYY-MM-DD).`);
  return ms;
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((toUtcMs(end) - toUtcMs(start)) / DAY_MS);
}

/** Calendar date (YYYY-MM-DD) of an instant in an IANA timezone. */
export function localDateFormatter(timeZone: string): (instant: Date) => string {
  // en-CA formats as YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (instant) => fmt.format(instant);
}

export interface DateRange {
  start: string;
  end: string;
}

/** Defaults to the last 7 days (inclusive of today) in the user's timezone. */
export function resolveRange(
  input: { start_date?: string; end_date?: string },
  opts: { timeZone: string; maxDays: number; now?: Date },
): DateRange {
  const today = localDateFormatter(opts.timeZone)(opts.now ?? new Date());
  // As documented in the tool schema: end_date defaults to today even when start_date is given.
  const end = input.end_date ?? today;
  const start = input.start_date ?? addDays(end, -6);
  const span = daysBetween(start, end) + 1;
  if (span < 1) throw new RangeError400(`start_date (${start}) is after end_date (${end}).`);
  if (span > opts.maxDays) {
    throw new RangeError400(`Range is ${span} days; this tool allows at most ${opts.maxDays}. Split it into smaller ranges.`);
  }
  return { start, end };
}

export function inRange(day: string, range: DateRange): boolean {
  return day >= range.start && day <= range.end;
}

export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Query window for Oura's date-keyed collections, padded a day on each side.
 * Oura's end_date bound is not consistently inclusive across collections, and sleep
 * periods are keyed by wake-up day, so over-fetch and filter on each document's `day`.
 */
export function paddedDateParams(range: DateRange): Record<string, string> {
  return { start_date: addDays(range.start, -1), end_date: addDays(range.end, 1) };
}

// ---------------------------------------------------------------------------------------
// Instants. Health rows are keyed by a canonical UTC second ("2026-09-27T14:30:00Z"): ISO 8601
// with a timezone designator that sorts chronologically as a string, even across DST changes
// or readings sent with different offsets, so a re-sent sample always maps to the same key.

export class TimestampError extends Error {
  override name = 'InvalidTimestamp';
}

// "2026-09-27 07:30:00 -0700" (Health Auto Export), "2026-09-27T07:30:00-07:00", "…Z", or no
// offset at all (then it is wall-clock time in the given timezone). Seconds are optional.
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

// One formatter per timezone, kept for the life of the instance. An Intl.DateTimeFormat is a large
// native object: building one for every sample of a big Health Auto Export push cost about 45 KB
// each until garbage collection caught up, hundreds of MB for a few thousand samples.
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();
function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = wallClockFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    wallClockFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Milliseconds to add to UTC to get wall-clock time in `timeZone` at `instant`. */
export function tzOffsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    wallClockFormatter(timeZone)
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** Parses any accepted timestamp form into epoch milliseconds (truncated to the second). */
export function parseInstant(input: string, timeZone: string): number {
  const m = TIMESTAMP_RE.exec(input.trim());
  if (!m) throw new TimestampError(`Invalid timestamp "${input}" (use ISO 8601, e.g. 2026-09-27T07:30 or 2026-09-27T07:30:00-07:00).`);
  const [, y, mo, d, h, mi, s = '0', off] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) {
    throw new TimestampError(`Invalid timestamp "${input}" (no such date or time).`);
  }
  if (off) {
    if (off.toUpperCase() === 'Z') return wall;
    const sign = off.startsWith('-') ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    return wall - sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * 60_000;
  }
  // Wall-clock time in timeZone: correct the guess by the zone's offset (twice, for DST edges).
  let t = wall - tzOffsetMs(wall, timeZone);
  t = wall - tzOffsetMs(t, timeZone);
  return t;
}

/** Canonical sort key: UTC, second precision. */
export function sortKey(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Local date, HH:MM, and full ISO with offset (e.g. 2026-09-27T07:30:00-07:00) in timeZone. */
export function localTime(ms: number, timeZone: string): { date: string; time: string; iso: string } {
  const offset = tzOffsetMs(ms, timeZone);
  const wall = new Date(Math.floor(ms / 1000) * 1000 + offset).toISOString().slice(0, 19);
  const mins = Math.round(offset / 60_000);
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const iso = `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { date: wall.slice(0, 10), time: wall.slice(11, 16), iso };
}
