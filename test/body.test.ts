import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHaePayload } from '../src/hae.ts';
import { parsePromptArgs } from '../src/health-tools.ts';
import { syncHaeRows } from '../src/sync.ts';
import { memoryHealthStore } from './fakes.ts';
import { rows, setup } from './harness.ts';

// Body measurements from Health Auto Export: waist_circumference -> "waist" (in),
// body_fat_percentage -> "body_fat" (%), lean_body_mass -> "lean_mass" (lb). The metric names are
// those of HAE's reference server (src/models/MetricName.ts). They are handled like weight: one
// row per sample, idempotent re-sends, the same reconciliation. All values here are invented, and
// everything runs against the in-memory store.

const TZ = 'America/Los_Angeles';
type Sample = { date: string; qty: number; source?: string };
const metric = (name: string, units: string, data: Sample[]) => ({ name, units, data: data.map((s) => ({ source: 'Smart Tape', ...s })) });
const MORNING = '2026-09-26 07:10:00 -0700';

test('waist, body fat and lean mass are stored in inches, percent and pounds', () => {
  const parsed = parseHaePayload(
    {
      data: {
        metrics: [
          metric('waist_circumference', 'in', [{ date: MORNING, qty: 38.25 }]),
          metric('waist_circumference', 'cm', [{ date: '2026-09-25 07:10:00 -0700', qty: 100 }]),
          metric('body_fat_percentage', '%', [{ date: MORNING, qty: 24.6, source: 'Smart Scale' }]),
          metric('lean_body_mass', 'kg', [{ date: MORNING, qty: 60, source: 'Smart Scale' }]),
          metric('lean_body_mass', 'lb', [{ date: '2026-09-25 07:10:00 -0700', qty: 132.4, source: 'Smart Scale' }]),
          metric('body_mass_index', 'count', [{ date: MORNING, qty: 27.1 }]),
        ],
      },
    },
    { timeZone: TZ, now: new Date('2026-09-27T18:00:00Z') },
  );
  const stored = parsed.rows.map((r) => [r.metric, r.value, r.unit, r.original_value, r.original_unit, r.source]);
  assert.deepEqual(stored, [
    ['waist', 38.25, 'in', 38.25, 'in', 'Smart Tape'],
    ['waist', 39.37, 'in', 100, 'cm', 'Smart Tape'],
    ['body_fat', 24.6, '%', 24.6, '%', 'Smart Scale'],
    ['lean_mass', 132.28, 'lb', 60, 'kg', 'Smart Scale'],
    ['lean_mass', 132.4, 'lb', 132.4, 'lb', 'Smart Scale'],
  ]);
  assert.deepEqual(parsed.ignored_metrics, ['body_mass_index']);
  assert.deepEqual(parsed.metric_units, { waist_circumference: 'cm', body_fat_percentage: '%', lean_body_mass: 'lb', body_mass_index: 'count' });
  assert.match(parsed.rows[0].ts, /^2026-09-26T14:10:00Z#[0-9a-f]{12}$/, 'UTC second + sample fingerprint, like weight');
});

test('body fat sent as a fraction (HealthKit stores 0.246) is read as a percentage', () => {
  const at = (qty: number) =>
    parseHaePayload({ data: { metrics: [metric('body_fat_percentage', '%', [{ date: MORNING, qty }])] } }, { timeZone: TZ, now: new Date('2026-09-27T18:00:00Z') }).rows[0];
  assert.deepEqual([at(0.246).value, at(0.246).original_value], [24.6, 0.246]);
  assert.equal(at(24.6).value, 24.6);
  assert.equal(at(1).value, 100, 'a fraction of exactly 1');
  assert.equal(at(1.5).value, 1.5, 'above 1 it is already a percentage');
});

test('an unknown unit is skipped and reported, never failing the request', async () => {
  const { ingest, health } = setup();
  const res = await ingest({ data: { metrics: [metric('waist_circumference', 'furlongs', [{ date: MORNING, qty: 1 }]), metric('lean_body_mass', 'lb', [{ date: MORNING, qty: 130 }])] } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { accepted: number; skipped_reasons: Record<string, number> };
  assert.deepEqual([body.accepted, body.skipped_reasons.unknown_unit], [1, 1]);
  assert.deepEqual([...health.rows.values()].map((r) => r.metric), ['lean_mass']);
});

test('re-sends are stored once; an edited waist reading is retired after two pushes 15+ minutes apart', async () => {
  const store = memoryHealthStore();
  const T0 = Date.parse('2026-10-10T19:00:00Z'); // Oct 4-9 are the full days inside the window
  const push = async (qty: number[], minutes: number) => {
    const now = new Date(T0 + minutes * 60_000);
    const body = { data: { metrics: [metric('waist_circumference', 'in', qty.map((q) => ({ date: '2026-10-07 07:10:00 -0700', qty: q })))] } };
    const p = parseHaePayload(body, { timeZone: TZ, now });
    return syncHaeRows(store, p.rows, { now, timeZone: TZ, period: 'Previous 7 Days', acceptedByMetric: p.accepted_by_metric });
  };
  assert.deepEqual(await push([38.5], 0).then((r) => [r.written, r.unchanged]), [1, 0]);
  assert.deepEqual(await push([38.5], 5).then((r) => [r.written, r.unchanged]), [0, 1]);
  const first = await push([38.25], 10); // corrected in Apple Health: 1 of 2, not more than half
  assert.deepEqual([first.written, first.pending, first.skipped_days.length], [1, 1, 0]);
  assert.equal((await push([38.25], 26)).superseded, 1);
  assert.deepEqual([...store.rows.values()].filter((r) => !r.superseded_at).map((r) => r.value), [38.25]);
  assert.equal(store.rows.size, 2, 'nothing is deleted');
});

test('get_health_metrics lists each reading; delete_reading removes and undo restores one', async () => {
  const { ingest, connect } = setup();
  await ingest({
    data: {
      metrics: [
        metric('waist_circumference', 'in', [{ date: MORNING, qty: 38.25 }, { date: '2026-09-26 21:00:00 -0700', qty: 38.75 }]),
        metric('body_fat_percentage', '%', [{ date: MORNING, qty: 24.6, source: 'Smart Scale' }]),
        metric('lean_body_mass', 'lb', [{ date: MORNING, qty: 132.4, source: 'Smart Scale' }]),
        metric('weight_body_mass', 'lb', [{ date: MORNING, qty: 175.6, source: 'Smart Scale' }]),
      ],
    },
  });
  const client = await connect('auto');
  const day = async (m: string) =>
    rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric: m, start_date: '2026-09-26', end_date: '2026-09-26' } })).days[0];

  assert.deepEqual(await day('all'), {
    date: '2026-09-26',
    weight: [{ time: '07:10', value: 175.6, unit: 'lb', source: 'Smart Scale' }],
    waist: [
      { time: '07:10', value: 38.25, unit: 'in', source: 'Smart Tape' },
      { time: '21:00', value: 38.75, unit: 'in', source: 'Smart Tape' },
    ],
    body_fat: [{ time: '07:10', value: 24.6, unit: '%', source: 'Smart Scale' }],
    lean_mass: [{ time: '07:10', value: 132.4, unit: 'lb', source: 'Smart Scale' }],
  });
  assert.deepEqual(Object.keys(await day('body_fat')), ['date', 'body_fat']);

  const removed = rows(await client.callTool({ name: 'delete_reading', arguments: { metric: 'waist', timestamp: '2026-09-26T21:00' } }));
  assert.deepEqual([removed.removed.value, removed.removed.unit], [38.75, 'in']);
  assert.equal((await day('waist')).waist.length, 1);
  rows(await client.callTool({ name: 'delete_reading', arguments: { metric: 'waist', timestamp: '2026-09-26T21:00', undo: true } }));
  assert.equal((await day('waist')).waist.length, 2);

  const { tools } = await client.listTools();
  const schema = (name: string) => JSON.stringify(tools.find((t) => t.name === name));
  for (const m of ['"waist"', '"body_fat"', '"lean_mass"']) {
    assert.ok(schema('get_health_metrics').includes(m), `get_health_metrics accepts ${m}`);
    assert.ok(schema('delete_reading').includes(m), `delete_reading accepts ${m}`);
  }
  assert.ok(!schema('log_reading').includes('"waist"'), 'log_reading stays glucose and ketones only');
  await client.close();
});

test('prompt aliases: "body fat", "lean body mass", "waist circumference"', () => {
  const m = (metric: string) => parsePromptArgs({ metric }, '2026-09-29').metric;
  assert.deepEqual([m('Body fat'), m('lean body mass'), m('waist circumference'), m('waist')], ['body_fat', 'lean_mass', 'waist', 'waist']);
});
