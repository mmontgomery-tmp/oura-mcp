// Health readings shared by the Apple Health ingest, the log/delete tools and get_health_metrics.
import { createHash } from 'node:crypto';

export const METRICS = ['weight', 'waist', 'body_fat', 'lean_mass', 'bp', 'glucose', 'ketones', 'protein', 'carbs', 'fiber', 'fat', 'calories'] as const;
export type Metric = (typeof METRICS)[number];

/** Normalized unit per metric. Stored values are always in these units. */
export const UNITS: Record<Metric, string> = {
  weight: 'lb',
  /** Apple Health Waist Circumference. */
  waist: 'in',
  /** Apple Health Body Fat Percentage, as a percentage (22.5 = 22.5%). */
  body_fat: '%',
  /** Apple Health Lean Body Mass. */
  lean_mass: 'lb',
  bp: 'mmHg',
  glucose: 'mg/dL',
  ketones: 'mmol/L',
  protein: 'g',
  /** Apple Health Carbohydrates: net carbs before NET_CARBS_SWITCHOVER, total carbs from it on. */
  carbs: 'g',
  fiber: 'g',
  fat: 'g',
  calories: 'kcal',
};

/** Reported as daily sums; everything else is reported reading by reading. */
export const SUMMED: ReadonlySet<Metric> = new Set<Metric>(['protein', 'carbs', 'fiber', 'fat', 'calories']);

/**
 * Net carbs switchover, the one place this date lives. Before it, Apple Health's Carbohydrates held
 * net carbs (edited to net in Cal AI) and fiber is ignored. From it on, Carbohydrates is total carbs
 * and net carbs = carbs - fiber. Each sample is classified by its own timestamp, never by when it
 * was ingested. See net-carbs.ts.
 */
export const NET_CARBS_SWITCHOVER = '2026-09-29T15:44:00-07:00';
export const NET_CARBS_SWITCHOVER_MS = Date.parse(NET_CARBS_SWITCHOVER);

export const CLAUDE_SOURCE = 'claude-log';
export type Context = 'fasting' | 'post-meal' | 'other';

export interface HealthRow {
  metric: Metric;
  /**
   * Sort key. Chat readings: the UTC second, e.g. 2026-09-27T14:30:00Z. Apple Health samples: that
   * second plus a fingerprint of the sample (see haeSortKey), so distinct samples sharing a
   * timestamp are stored separately while a re-sent sample lands on the same key.
   */
  ts: string;
  /** Single-valued metrics (everything except bp), in UNITS[metric]. */
  value?: number;
  systolic?: number;
  diastolic?: number;
  unit: string;
  original_value?: number;
  original_systolic?: number;
  original_diastolic?: number;
  original_unit: string;
  /** The app that recorded it (Apple Health source name), or "claude-log". */
  source: string;
  /** Which path wrote the row. */
  via: 'hae' | 'chat';
  context?: Context;
  note?: string;
  /** Timestamp exactly as received, with its original offset. */
  recorded_at: string;
  ingested_at: string;
  /** Apple Health only: first full push that lacked this sample (see sync.ts). */
  missing_since?: string;
  /** Apple Health only: confirmed gone (deleted or edited in Apple Health); ignored by reads. */
  superseded_at?: string;
  /** Who set superseded_at: reconciliation, or delete_reading from chat. */
  superseded_by?: 'reconcile' | 'chat';
}

/** The UTC second a row was measured at, whatever its key suffix. */
export function rowInstant(row: Pick<HealthRow, 'ts'>): string {
  return row.ts.slice(0, 20); // "YYYY-MM-DDTHH:MM:SSZ"
}

export function rowTime(row: Pick<HealthRow, 'ts'>): number {
  return Date.parse(rowInstant(row));
}

/**
 * Sort key for an Apple Health sample: `<UTC second>#<fingerprint>[~<n>]`. The fingerprint hashes
 * what identifies the sample apart from its time (source app, values as sent, unit as sent), so:
 * - re-sending the same sample always produces the same key (idempotent re-sends);
 * - samples with the same timestamp but a different source or value get different keys;
 * - exact duplicates within one request (e.g. two identical food entries) are numbered ~1, ~2, ...
 * Keys sort by time: "#" follows the fixed-width timestamp.
 */
export function haeSortKey(
  instant: string,
  sample: { source: string; values: number[]; unit: string },
  duplicate = 0,
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([sample.source, sample.values, sample.unit]))
    .digest('hex')
    .slice(0, 12);
  return `${instant}#${fingerprint}${duplicate ? `~${duplicate}` : ''}`;
}

/** The fingerprint inputs of a stored Apple Health row (used by the key migration). */
export function haeKeyInputs(row: HealthRow): { source: string; values: number[]; unit: string } {
  const values = row.metric === 'bp' ? [row.original_systolic!, row.original_diastolic!] : [row.original_value!];
  return { source: row.source, values, unit: row.original_unit };
}

const GLUCOSE_MG_PER_MMOL = 18.016; // molar mass of glucose, 180.16 g/mol

// Accepted input units per metric -> factor to the normalized unit. Keys are lowercased with
// whitespace removed. Apple Health writes molar glucose as "mmol<180.1558800000541>/L".
const MASS_TO_LB = { lb: 1, lbs: 1, pound: 1, pounds: 1, kg: 2.20462262185, g: 0.00220462262185, st: 14, stone: 14 };
const CONVERSIONS: Record<Metric, Record<string, number>> = {
  weight: MASS_TO_LB,
  waist: { in: 1, inch: 1, inches: 1, cm: 1 / 2.54, mm: 1 / 25.4, m: 100 / 2.54, ft: 12 },
  // A value of 1 or less is a fraction (0.225 = 22.5%); see bodyFatPercent.
  body_fat: { '%': 1, percent: 1 },
  lean_mass: MASS_TO_LB,
  bp: { mmhg: 1, kpa: 7.50061683 },
  glucose: { 'mg/dl': 1, 'mmol/l': GLUCOSE_MG_PER_MMOL },
  ketones: { 'mmol/l': 1 },
  protein: { g: 1, mg: 0.001 },
  carbs: { g: 1, mg: 0.001 },
  fiber: { g: 1, mg: 0.001 },
  fat: { g: 1, mg: 0.001 },
  calories: { kcal: 1, cal: 1, kilocalories: 1, kj: 1 / 4.184 },
};
const DECIMALS: Record<Metric, number> = { weight: 2, waist: 2, body_fat: 1, lean_mass: 2, bp: 0, glucose: 1, ketones: 2, protein: 1, carbs: 1, fiber: 1, fat: 1, calories: 1 };

export function unitFactor(metric: Metric, unit: string): number | undefined {
  const key = unit.toLowerCase().replace(/\s+/g, '').replace(/^mmol<[\d.]+>\//, 'mmol/');
  return CONVERSIONS[metric][key];
}

/**
 * Body fat as a percentage. HealthKit stores it as a fraction, and nobody's body fat is 1% or
 * less, so a value of 1 or below is taken as a fraction whatever the unit label says.
 */
export function bodyFatPercent(qty: number): number {
  return qty > 0 && qty <= 1 ? qty * 100 : qty;
}

export function roundFor(metric: Metric, value: number): number {
  const f = 10 ** DECIMALS[metric];
  return Math.round(value * f) / f;
}

/** Range checks for readings typed into chat (log_reading). */
export const CHAT_LIMITS = {
  glucose: { unit: 'mg/dL', min: 20, max: 600 },
  ketones: { unit: 'mmol/L', min: 0, max: 10 },
} as const;

// ---------------------------------------------------------------------------------------
// Duplicate readings: a meter that syncs to Apple Health produces an HAE row for the same
// measurement the user also reported in chat. Treat a claude-log row and a non-claude row of
// the same metric within 15 minutes and 5% of each other as one reading and keep the
// claude-log row. Each row pairs at most once, closest in time first; nothing is deleted.

const DUP_WINDOW_MS = 15 * 60_000;
const DUP_TOLERANCE = 0.05;

const close = (a?: number, b?: number) =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= DUP_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));

function sameValue(a: HealthRow, b: HealthRow): boolean {
  return a.metric === 'bp' ? close(a.systolic, b.systolic) && close(a.diastolic, b.diastolic) : close(a.value, b.value);
}

/** Returns the rows to show plus how many non-claude rows were hidden as duplicates. */
export function dedupeReadings(rows: HealthRow[]): { kept: HealthRow[]; hidden: number } {
  const claude = rows.filter((r) => r.source === CLAUDE_SOURCE);
  const others = rows.filter((r) => r.source !== CLAUDE_SOURCE);
  const pairs: { c: HealthRow; o: HealthRow; dt: number }[] = [];
  for (const c of claude) {
    const tc = rowTime(c);
    for (const o of others) {
      const dt = Math.abs(rowTime(o) - tc);
      if (o.metric === c.metric && dt <= DUP_WINDOW_MS && sameValue(c, o)) pairs.push({ c, o, dt });
    }
  }
  pairs.sort((a, b) => a.dt - b.dt);
  const usedClaude = new Set<HealthRow>();
  const hidden = new Set<HealthRow>();
  for (const { c, o } of pairs) {
    if (usedClaude.has(c) || hidden.has(o)) continue;
    usedClaude.add(c);
    hidden.add(o);
  }
  return { kept: rows.filter((r) => !hidden.has(r)), hidden: hidden.size };
}
