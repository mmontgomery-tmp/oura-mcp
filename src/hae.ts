import { parseInstant, sortKey } from './dates.ts';
import { type Context, haeKeyInputs, haeSortKey, type HealthRow, type Metric, roundFor, unitFactor, UNITS } from './health.ts';

// Health Auto Export (iOS) REST API automation payload, JSON export format:
//   {"data": {"metrics": [{"name": "blood_glucose", "units": "mg/dL",
//     "data": [{"date": "2026-09-27 07:30:00 -0700", "qty": 94, "source": "OneTouch", "metadata": {...}}]}],
//    "workouts": [...], ...}}
// Blood pressure samples carry systolic/diastolic instead of qty. Names and shapes follow HAE's
// reference server (github.com/HealthyApps/health-auto-export-server, src/models).

/** HAE metric name -> our metric. Everything else is ignored. */
export const HAE_METRICS: Record<string, Metric> = {
  weight_body_mass: 'weight',
  blood_pressure: 'bp',
  blood_glucose: 'glucose',
  protein: 'protein',
  carbohydrates: 'carbs', // net carbs before NET_CARBS_SWITCHOVER, total carbs from it on
  fiber: 'fiber',
  total_fat: 'fat',
  dietary_energy: 'calories',
};

export class HaeFormatError extends Error {
  override name = 'HaeFormatError';
}

export type SkipReason = 'unsupported_metric' | 'oura_source' | 'unknown_unit' | 'invalid_sample';

export interface HaeParseResult {
  rows: HealthRow[];
  accepted: number;
  skipped: number;
  skipped_reasons: Partial<Record<SkipReason, number>>;
  /** Names of ignored metrics, so the automation's metric selection can be tidied up. */
  ignored_metrics: string[];
  /** Samples received per HAE metric name (logged: shows which metrics each push carried). */
  metric_counts: Record<string, number>;
  /** The unit each HAE metric was sent in (logged: confirms what the payload actually uses). */
  metric_units: Record<string, string>;
  /** Accepted samples per metric: reconciliation only touches metrics present and non-empty. */
  accepted_by_metric: Partial<Record<Metric, number>>;
  /** Every field name seen on accepted samples (and metadata keys), to spot a sample UUID. */
  sample_fields: string[];
}

interface HaeSample {
  date?: unknown;
  qty?: unknown;
  systolic?: unknown;
  diastolic?: unknown;
  source?: unknown;
  metadata?: unknown;
}

export function parseHaePayload(body: unknown, opts: { timeZone: string; now: Date }): HaeParseResult {
  const data = (body as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object') throw new HaeFormatError('Expected a Health Auto Export JSON body: {"data": {"metrics": [...]}}.');
  const metrics = (data as { metrics?: unknown }).metrics ?? [];
  if (!Array.isArray(metrics)) throw new HaeFormatError('"data.metrics" must be an array.');

  const result: HaeParseResult = {
    rows: [],
    accepted: 0,
    skipped: 0,
    skipped_reasons: {},
    ignored_metrics: [],
    metric_counts: {},
    metric_units: {},
    accepted_by_metric: {},
    sample_fields: [],
  };
  const fields = new Set<string>();
  const skip = (reason: SkipReason, n = 1) => {
    result.skipped += n;
    result.skipped_reasons[reason] = (result.skipped_reasons[reason] ?? 0) + n;
  };
  // Every sample becomes its own row (see haeSortKey): samples sharing a timestamp stay separate,
  // and a re-sent sample maps to the key it had before.
  const keys = new Set<string>();
  const ingestedAt = opts.now.toISOString();

  for (const m of metrics as { name?: unknown; units?: unknown; data?: unknown }[]) {
    const samples = Array.isArray(m?.data) ? (m.data as HaeSample[]) : [];
    if (typeof m?.name === 'string') {
      result.metric_counts[m.name] = (result.metric_counts[m.name] ?? 0) + samples.length;
      if (typeof m.units === 'string') result.metric_units[m.name] = m.units;
    }
    const metric = typeof m?.name === 'string' ? HAE_METRICS[m.name] : undefined;
    if (!metric) {
      skip('unsupported_metric', samples.length);
      if (typeof m?.name === 'string' && !result.ignored_metrics.includes(m.name)) result.ignored_metrics.push(m.name);
      continue;
    }
    const units = typeof m.units === 'string' ? m.units : '';
    const factor = unitFactor(metric, units);

    for (const s of samples) {
      const source = typeof s?.source === 'string' && s.source.trim() ? s.source.trim() : 'unknown';
      if (/oura/i.test(source)) {
        skip('oura_source');
        continue;
      }
      if (factor === undefined) {
        skip('unknown_unit');
        continue;
      }
      let ms: number;
      try {
        if (typeof s.date !== 'string') throw new Error('missing date');
        ms = parseInstant(s.date, opts.timeZone);
      } catch {
        skip('invalid_sample');
        continue;
      }
      const row: HealthRow = {
        metric,
        ts: sortKey(ms),
        unit: UNITS[metric],
        original_unit: units,
        source,
        via: 'hae',
        recorded_at: s.date as string,
        ingested_at: ingestedAt,
      };
      if (metric === 'bp') {
        const sys = num(s.systolic);
        const dia = num(s.diastolic);
        if (sys === undefined || dia === undefined) {
          skip('invalid_sample');
          continue;
        }
        Object.assign(row, {
          systolic: roundFor(metric, sys * factor),
          diastolic: roundFor(metric, dia * factor),
          original_systolic: sys,
          original_diastolic: dia,
        });
      } else {
        const qty = num(s.qty);
        if (qty === undefined) {
          skip('invalid_sample');
          continue;
        }
        row.value = roundFor(metric, qty * factor);
        row.original_value = qty;
      }
      if (metric === 'glucose') {
        const context = mealContext(s.metadata);
        if (context) row.context = context;
      }
      result.accepted++;
      result.accepted_by_metric[metric] = (result.accepted_by_metric[metric] ?? 0) + 1;
      for (const f of Object.keys(s)) fields.add(f);
      if (s.metadata && typeof s.metadata === 'object') for (const f of Object.keys(s.metadata)) fields.add(`metadata.${f}`);

      // Exact duplicates in this request (same time, source, values, unit) are numbered.
      let duplicate = 0;
      do row.ts = haeSortKey(row.ts.slice(0, 20), haeKeyInputs(row), duplicate++);
      while (keys.has(`${metric}|${row.ts}`));
      keys.add(`${metric}|${row.ts}`);
      result.rows.push(row);
    }
  }
  result.sample_fields = [...fields].sort();
  return result;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** HealthKit's HKBloodGlucoseMealTime, if HAE passes it through: 1 = preprandial, 2 = postprandial. */
function mealContext(metadata: unknown): Context | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    if (!/meal/i.test(k)) continue;
    if (/^(2|post|after)/i.test(String(v))) return 'post-meal';
  }
  return undefined;
}

/**
 * Structure-preserving redaction for the one-time "first payload" log: keeps keys, every metric
 * name and unit, sources, date strings and metadata keys; replaces numbers with "<number>"; keeps
 * the first 2 samples of each metric and says how many more there were.
 */
export function redactPayload(body: unknown): unknown {
  const redact = (v: unknown, depth: number, key?: string): unknown => {
    if (typeof v === 'number') return '<number>';
    if (typeof v === 'boolean' || v === null) return v;
    if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    if (depth > 8) return '<…>';
    if (Array.isArray(v)) {
      // Sample lists ("data" arrays inside a metric) are shortened; the metric list is kept whole.
      const keep = key === 'data' && depth > 1 ? 2 : 100;
      const shown = v.slice(0, keep).map((x) => redact(x, depth + 1));
      return v.length > keep ? [...shown, `<${v.length - keep} more>`] : shown;
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, depth + 1, k)]));
    }
    return typeof v;
  };
  return redact(body, 0);
}
