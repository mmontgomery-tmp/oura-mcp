import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHaePayload } from '../src/hae.ts';
import { syncHaeRows } from '../src/sync.ts';
import { memoryHealthStore } from './fakes.ts';
import { rows, setup } from './harness.ts';

const TZ = 'America/Los_Angeles';
const T0 = Date.parse('2026-10-10T19:00:00Z'); // Saturday 12:00 in Los Angeles; full days inside: Oct 4-9
const min = (n: number) => new Date(T0 + n * 60_000);

type Sample = { date: string; qty: number; source?: string };
const payload = (metrics: Record<string, Sample[]>) => ({
  data: {
    metrics: Object.entries(metrics).map(([name, data]) => ({
      name,
      units: name === 'weight_body_mass' ? 'lb' : 'g',
      data: data.map((s) => ({ source: 'Cal AI', ...s })),
    })),
  },
});

function harness() {
  const store = memoryHealthStore();
  const push = (metrics: Record<string, Sample[]>, at: Date, period: string | undefined = 'Previous 7 Days') => {
    const parsed = parseHaePayload(payload(metrics), { timeZone: TZ, now: at });
    return syncHaeRows(store, parsed.rows, { now: at, timeZone: TZ, period, acceptedByMetric: parsed.accepted_by_metric });
  };
  const protein = () => [...store.rows.values()].filter((r) => r.metric === 'protein');
  const active = () => protein().filter((r) => !r.superseded_at).map((r) => r.value).sort((a, b) => a! - b!);
  return { store, push, protein, active };
}

const A = { date: '2026-10-07 12:00:00 -0700', qty: 42 };
const B = { date: '2026-10-07 12:00:00 -0700', qty: 18 };
const B2 = { date: '2026-10-07 12:00:00 -0700', qty: 20 }; // B edited in Cal AI: deleted + rewritten

test('an edit: the replaced sample is marked missing, then superseded 15+ minutes later, never deleted', async () => {
  const { push, protein, active } = harness();
  await push({ protein: [A, B] }, min(0));
  let r = await push({ protein: [A, B2] }, min(5));
  assert.deepEqual([r.written, r.pending, r.superseded], [1, 1, 0]);
  r = await push({ protein: [A, B2] }, min(15)); // 10 minutes after the first miss: wait
  assert.deepEqual([r.pending, r.superseded], [0, 0]);
  r = await push({ protein: [A, B2] }, min(21)); // 16 minutes: confirmed
  assert.deepEqual([r.pending, r.superseded], [0, 1]);
  assert.equal(protein().length, 3, 'nothing is deleted');
  assert.deepEqual(active(), [20, 42]);
});

test('a superseded or missing sample that shows up again is un-marked', async () => {
  const { push, protein, active } = harness();
  await push({ protein: [A, B] }, min(0));
  await push({ protein: [A] , weight_body_mass: [] }, min(5)); // B missing (A present keeps the day under half)
  await push({ protein: [A, { date: '2026-10-07 13:00:00 -0700', qty: 5 }] }, min(25));
  assert.ok(protein().find((x) => x.value === 18)?.superseded_at);
  const r = await push({ protein: [A, B] }, min(40));
  assert.equal(r.restored, 1);
  const b = protein().find((x) => x.value === 18)!;
  assert.equal(b.superseded_at, undefined);
  assert.equal(b.missing_since, undefined);
  assert.ok(active().includes(18));
});

test('a metric missing from the push, empty, or only Oura-sourced is not reconciled', async () => {
  const { push, protein } = harness();
  await push({ protein: [A, B] }, min(0));
  const cases: Record<string, Sample[]>[] = [
    { weight_body_mass: [{ date: '2026-10-08 07:00:00 -0700', qty: 180 }] }, // protein left out entirely
    { protein: [] }, // present but empty (e.g. HealthKit query failed while locked)
    { protein: [{ ...A, source: 'Oura' }] }, // present, but nothing accepted
  ];
  for (const [i, metrics] of cases.entries()) {
    const r = await push(metrics, min(20 * (i + 1)));
    assert.ok(!r.reconciled.includes('protein'), JSON.stringify(metrics));
  }
  assert.ok(protein().every((x) => !x.missing_since && !x.superseded_at));
});

test('more than half of a metric-day would be marked: skipped and reported', async () => {
  const { push, protein } = harness();
  const C = { date: '2026-10-07 18:00:00 -0700', qty: 30 };
  await push({ protein: [A, B, C] }, min(0));
  const r = await push({ protein: [A, { date: '2026-10-08 12:00:00 -0700', qty: 10 }] }, min(5));
  assert.deepEqual(r.skipped_days, [{ metric: 'protein', day: '2026-10-07', missing: 2, total: 3 }]);
  assert.equal(r.pending, 0);
  assert.ok(protein().every((x) => !x.missing_since));
});

test('"Previous 7 Days" reconciles only the six full days inside the window; other periods reconcile nothing', async () => {
  const { push, protein } = harness();
  const today = { date: '2026-10-10 08:00:00 -0700', qty: 11 };
  const oldest = { date: '2026-10-03 20:00:00 -0700', qty: 12 };
  const inside = { date: '2026-10-05 12:00:00 -0700', qty: 13 };
  const keep = { date: '2026-10-05 13:00:00 -0700', qty: 14 };
  const other = { date: '2026-10-06 12:00:00 -0700', qty: 15 };
  await push({ protein: [today, oldest, inside, keep, other] }, min(0));
  for (const period of ['Since Last Sync', '' /* no header */]) {
    const r = await push({ protein: [keep, other] }, min(5), period);
    assert.equal(r.reconcile, 'off');
    assert.equal(r.pending, 0);
  }
  const r = await push({ protein: [keep, other] }, min(10));
  assert.equal(r.pending, 1, 'only the Oct 5 sample; today and Oct 3 are at the window edges');
  assert.deepEqual(protein().filter((x) => x.missing_since).map((x) => x.value), [13]);
});

test('chat readings are never marked', async () => {
  const { store, push } = harness();
  await store.writeRows([{
    metric: 'protein', ts: '2026-10-07T19:00:00Z', value: 50, unit: 'g', original_value: 50, original_unit: 'g',
    source: 'claude-log', via: 'chat', recorded_at: '2026-10-07T12:00', ingested_at: min(0).toISOString(),
  }]);
  await push({ protein: [A] }, min(0));
  await push({ protein: [A] }, min(20));
  await push({ protein: [A] }, min(40));
  assert.ok(!store.rows.get('protein|2026-10-07T19:00:00Z')!.missing_since);
});

test('end to end: get_health_metrics ignores superseded samples; the test clock only accepts old dates', async () => {
  const { ingest, connect } = setup();
  const send = (metrics: Record<string, Sample[]>, at: string) =>
    ingest(payload(metrics), { headers: { 'automation-period': 'Previous 7 Days', 'x-smoke-test-now': at } });
  const a = { date: '2001-02-03 12:30:00 -0800', qty: 42 };
  const b = { date: '2001-02-03 12:30:00 -0800', qty: 18 };
  const b2 = { date: '2001-02-03 12:30:00 -0800', qty: 20 };
  await send({ protein: [a, b] }, '2001-02-06T12:00:00-08:00');
  await send({ protein: [a, b2] }, '2001-02-06T12:05:00-08:00');
  const last = (await (await send({ protein: [a, b2] }, '2001-02-06T12:21:00-08:00')).json()) as { superseded: number };
  assert.equal(last.superseded, 1);
  const client = await connect('auto');
  const out = rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric: 'protein', start_date: '2001-02-03', end_date: '2001-02-03' } }));
  assert.deepEqual(out.days, [{ date: '2001-02-03', protein_g: 62 }], '42 + 20; the replaced 18 g is ignored');
  await client.close();
  assert.equal((await send({ protein: [a] }, '2026-10-10T12:00:00-07:00')).status, 400);
});

// ---------------------------------------------------------------------------------------
// Single-sample metric-days (weekly weigh-in on Mondays, weekly BP on Saturdays).
// The more-than-half guard counts the day's stored samples together with this push's samples.

async function scenario(name: string, units: string, before: Record<string, unknown>[], after: Record<string, unknown>[]) {
  const store = memoryHealthStore();
  const results = [];
  for (const [samples, m] of [[before, 0], [after, 5], [after, 21]] as const) {
    const parsed = parseHaePayload({ data: { metrics: [{ name, units, data: samples }] } }, { timeZone: TZ, now: min(m) });
    results.push(await syncHaeRows(store, parsed.rows, { now: min(m), timeZone: TZ, period: 'Previous 7 Days', acceptedByMetric: parsed.accepted_by_metric }));
  }
  const stored = [...store.rows.values()].map((r) => ({ v: r.value ?? `${r.systolic}/${r.diastolic}`, superseded: !!r.superseded_at, missing: !!r.missing_since }));
  return { first: results[1], second: results[2], stored };
}
const weighIn = (qty: number) => ({ date: '2026-10-05 07:00:00 -0700', qty, source: 'Withings' });
const otherWeighIn = { date: '2026-10-07 07:00:00 -0700', qty: 181.2, source: 'Withings' };
const bpReading = (s: number, d: number) => ({ date: '2026-10-09 08:00:00 -0700', systolic: s, diastolic: d, source: 'OMRON connect' });

test('A: a corrected Monday weigh-in (weight on another day too) is superseded', async () => {
  const r = await scenario('weight_body_mass', 'lb', [weighIn(180.4), otherWeighIn], [weighIn(179.9), otherWeighIn]);
  assert.deepEqual([r.first.pending, r.second.superseded], [1, 1]);
  assert.deepEqual(r.stored.filter((x) => x.superseded).map((x) => x.v), [180.4]);
});

test('B: a corrected weigh-in that is the only weight of the week is superseded (1 of 2 is not more than half)', async () => {
  const r = await scenario('weight_body_mass', 'lb', [weighIn(180.4)], [weighIn(179.9)]);
  assert.deepEqual([r.first.pending, r.first.skipped_days.length, r.second.superseded], [1, 0, 1]);
  assert.deepEqual(r.stored.filter((x) => !x.superseded).map((x) => x.v), [179.9]);
});

test('C: a corrected BP reading is superseded', async () => {
  const r = await scenario('blood_pressure', 'mmHg', [bpReading(128, 84)], [bpReading(118, 78)]);
  assert.deepEqual([r.first.pending, r.second.superseded], [1, 1]);
  assert.deepEqual(r.stored.filter((x) => x.superseded).map((x) => x.v), ['128/84']);
});

test('D (current behavior): a weigh-in deleted outright is skipped as 100% of its day, nothing marked', async () => {
  const r = await scenario('weight_body_mass', 'lb', [weighIn(180.4), otherWeighIn], [otherWeighIn]);
  for (const push of [r.first, r.second]) {
    assert.deepEqual(push.skipped_days, [{ metric: 'weight', day: '2026-10-05', missing: 1, total: 1 }]);
    assert.deepEqual([push.pending, push.superseded], [0, 0]);
  }
  assert.ok(r.stored.every((x) => !x.superseded && !x.missing), 'use delete_reading to remove it by hand');
});

test('E (current behavior): deleting the only weight of the week leaves weight out of the push, so no reconcile', async () => {
  const r = await scenario('weight_body_mass', 'lb', [weighIn(180.4)], []);
  for (const push of [r.first, r.second]) {
    assert.ok(!push.reconciled.includes('weight'));
    assert.deepEqual([push.pending, push.superseded, push.skipped_days.length], [0, 0, 0]);
  }
  assert.ok(r.stored.every((x) => !x.superseded && !x.missing));
});

test('a skipped metric-day is logged only on the first push of each hour', async () => {
  const { ingest, logs } = setup();
  const send = (samples: Record<string, unknown>[], at: string) =>
    ingest({ data: { metrics: [{ name: 'weight_body_mass', units: 'lb', data: samples }] } }, {
      headers: { 'automation-period': 'Previous 7 Days', 'x-smoke-test-now': at },
    });
  const monday = { date: '2001-02-05 07:00:00 -0800', qty: 180, source: 'Withings' };
  const wednesday = { date: '2001-02-07 07:00:00 -0800', qty: 181, source: 'Withings' };
  await send([monday, wednesday], '2001-02-10T12:00:00-08:00');
  for (const at of ['12:05', '12:10', '12:55', '13:00', '13:05', '14:20']) await send([wednesday], `2001-02-10T${at}:00-08:00`);
  const skipLogs = logs.filter((l) => String(l.msg).startsWith('hae reconcile skipped'));
  assert.equal(skipLogs.length, 3, 'hours 12, 13 and 14: one line each');
  assert.deepEqual(skipLogs[0], { msg: skipLogs[0].msg, metric: 'weight', day: '2001-02-05', missing: 1, total: 1 });
});
