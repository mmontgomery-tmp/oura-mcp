import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHaePayload } from '../src/hae.ts';
import type { HealthRow } from '../src/health.ts';
import { syncHaeRows } from '../src/sync.ts';
import { memoryHealthStore } from './fakes.ts';
import { rows, setup } from './harness.ts';

// A weigh-in that is replaced twice, on the in-memory store:
//   a scale app's 07:30 reading -> deleted, a manual "Health" entry added at 19:30 by mistake
//                               -> 19:30 deleted, "Health" 07:30 added.
// The first push that carries a replacement only marks the old row missing_since; a push 15 or
// more minutes later supersedes it. Until then both rows count. These tests pin that down.

const TZ = 'America/Los_Angeles';
const T0 = Date.parse('2026-10-10T19:00:00Z'); // 12:00 in Los Angeles; full days inside: Oct 4-9
const min = (n: number) => new Date(T0 + n * 60_000);

type Sample = { date: string; qty: number; source: string };
const SCALE_APP: Sample = { date: '2026-10-08 07:30:10 -0700', qty: 180.5, source: 'Scale App' };
const HEALTH_1930: Sample = { date: '2026-10-08 19:30:00 -0700', qty: 180.5, source: 'Health' };
const HEALTH_0730: Sample = { date: '2026-10-08 07:30:00 -0700', qty: 180.5, source: 'Health' };
const OTHER_DAY: Sample = { date: '2026-10-06 07:00:00 -0700', qty: 181.1, source: 'Health' };

function harness() {
  const store = memoryHealthStore();
  const push = (metrics: Record<string, Sample[]>, at: Date, period = 'Previous 7 Days') => {
    const body = { data: { metrics: Object.entries(metrics).map(([name, data]) => ({ name, units: name === 'weight_body_mass' ? 'lb' : 'g', data })) } };
    const parsed = parseHaePayload(body, { timeZone: TZ, now: at });
    return syncHaeRows(store, parsed.rows, { now: at, timeZone: TZ, period, acceptedByMetric: parsed.accepted_by_metric });
  };
  const all = (metric = 'weight') => [...store.rows.values()].filter((r) => r.metric === metric);
  const label = (r: HealthRow) => `${r.source} ${r.recorded_at?.slice(11, 16)}`;
  const active = (metric = 'weight') => all(metric).filter((r) => !r.superseded_at).map(label).sort();
  return { store, push, all, active, label };
}

/** The scale app's 07:30 reading replaced by Health 19:30, confirmed 16 minutes later. */
async function afterFirstReplacement(extra: Sample[] = []) {
  const h = harness();
  await h.push({ weight_body_mass: [SCALE_APP, ...extra] }, min(0));
  const first = await h.push({ weight_body_mass: [HEALTH_1930, ...extra] }, min(5));
  assert.deepEqual([first.written, first.pending, first.skipped_days.length], [1, 1, 0]);
  const second = await h.push({ weight_body_mass: [HEALTH_1930, ...extra] }, min(21));
  assert.equal(second.superseded, 1);
  return h;
}

test('replacement in one push: 19:30 deleted and Health 07:30 added, retired on the second push', async () => {
  const { push, all, active } = await afterFirstReplacement();
  assert.deepEqual(active(), ['Health 19:30']);

  // The first push with the change: the new row is written, the old one is only marked.
  let r = await push({ weight_body_mass: [HEALTH_0730] }, min(60));
  assert.deepEqual([r.written, r.pending, r.superseded], [1, 1, 0]);
  assert.deepEqual(r.skipped_days, [], 'the retired scale-app row is not counted: 1 of 2 is not more than half');
  assert.deepEqual(active(), ['Health 07:30', 'Health 19:30'], 'both still count until a later push confirms');

  r = await push({ weight_body_mass: [HEALTH_0730] }, min(65)); // 5 minutes later: too soon
  assert.deepEqual([r.pending, r.superseded], [0, 0]);

  r = await push({ weight_body_mass: [HEALTH_0730] }, min(76)); // 16 minutes after the first miss
  assert.deepEqual([r.superseded, r.skipped_days.length], [1, 0]);
  assert.deepEqual(active(), ['Health 07:30']);
  assert.equal(all().length, 3, 'nothing is deleted');
  assert.deepEqual(all().filter((x) => x.superseded_at).map((x) => x.superseded_by), ['reconcile', 'reconcile']);
});

test('replacement across two pushes, the only weight of the week: the delete alone changes nothing', async () => {
  const { push, active } = await afterFirstReplacement();

  // 19:30 deleted, nothing added yet: weight is absent from the push, which looks exactly like a
  // HealthKit query that failed on a locked phone, so weight is not reconciled.
  let r = await push({ protein: [{ date: '2026-10-08 12:00:00 -0700', qty: 40, source: 'Cal AI' }] }, min(60));
  assert.ok(!r.reconciled.includes('weight'));
  assert.deepEqual(active(), ['Health 19:30']);

  r = await push({ weight_body_mass: [HEALTH_0730] }, min(65)); // the replacement arrives
  assert.deepEqual([r.written, r.pending, r.skipped_days.length], [1, 1, 0]);
  r = await push({ weight_body_mass: [HEALTH_0730] }, min(81));
  assert.equal(r.superseded, 1);
  assert.deepEqual(active(), ['Health 07:30']);
});

test('replacement across two pushes, another weigh-in that week: skipped while the day is empty, then retired', async () => {
  const { push, active } = await afterFirstReplacement([OTHER_DAY]);

  // 19:30 deleted, nothing added yet: all of that day's weight would be marked, so it is skipped.
  let r = await push({ weight_body_mass: [OTHER_DAY] }, min(60));
  assert.deepEqual(r.skipped_days, [{ metric: 'weight', day: '2026-10-08', missing: 1, total: 1 }]);
  assert.deepEqual([r.pending, r.superseded], [0, 0]);

  r = await push({ weight_body_mass: [OTHER_DAY, HEALTH_0730] }, min(65)); // the replacement arrives
  assert.deepEqual([r.written, r.pending, r.skipped_days.length], [1, 1, 0]);
  r = await push({ weight_body_mass: [OTHER_DAY, HEALTH_0730] }, min(81));
  assert.equal(r.superseded, 1);
  assert.deepEqual(active(), ['Health 07:00', 'Health 07:30']);
});

test('a partial push never retires good rows', async () => {
  const { push, all, active } = harness();
  const meals: Sample[] = ['08:00', '12:30', '18:45'].map((t, i) => ({ date: `2026-10-08 ${t}:00 -0700`, qty: 30 + i, source: 'Cal AI' }));
  await push({ weight_body_mass: [HEALTH_0730], protein: meals }, min(0));

  // The metric is left out, or comes back empty (HealthKit unreadable while the phone is locked).
  for (const [i, metrics] of [{ protein: meals }, { weight_body_mass: [], protein: [] }].entries()) {
    const r = await push(metrics as Record<string, Sample[]>, min(20 * (i + 1)));
    assert.deepEqual([r.pending, r.superseded], [0, 0]);
  }
  // Most of a day is missing: skipped by the more-than-half guard, on every push.
  for (const m of [60, 80, 100]) {
    const r = await push({ weight_body_mass: [HEALTH_0730], protein: [meals[0]] }, min(m));
    assert.deepEqual(r.skipped_days, [{ metric: 'protein', day: '2026-10-08', missing: 2, total: 3 }]);
    assert.deepEqual([r.pending, r.superseded], [0, 0]);
  }
  // Less than half is missing in one push: marked, still counted, and un-marked when it is back.
  let r = await push({ weight_body_mass: [HEALTH_0730], protein: meals.slice(0, 2) }, min(120));
  assert.deepEqual([r.pending, r.superseded], [1, 0]);
  assert.equal(active('protein').length, 3);
  r = await push({ weight_body_mass: [HEALTH_0730], protein: meals }, min(140));
  assert.deepEqual([r.restored, r.superseded], [1, 0]);
  assert.ok(all().concat(all('protein')).every((x) => !x.superseded_at && !x.missing_since));
});

test('a row removed by hand with delete_reading stays removed; later pushes neither restore nor re-mark it', async () => {
  // The Lambda test clock only accepts dates before 2010, so the same sequence runs in 2001.
  const { ingest, connect, health } = setup();
  const send = (samples: Sample[], at: string) =>
    ingest({ data: { metrics: [{ name: 'weight_body_mass', units: 'lb', data: samples }] } }, {
      headers: { 'automation-period': 'Previous 7 Days', 'x-smoke-test-now': `2001-02-10T${at}:00-08:00` },
    }).then((res) => res.json() as Promise<{ marked_missing: number; superseded: number; restored: number; rows_unchanged: number }>);
  const scaleApp = { date: '2001-02-08 07:30:10 -0800', qty: 180.5, source: 'Scale App' };
  const at1930 = { date: '2001-02-08 19:30:00 -0800', qty: 180.5, source: 'Health' };
  const at0730 = { date: '2001-02-08 07:30:00 -0800', qty: 180.5, source: 'Health' };

  await send([scaleApp], '09:00');
  await send([at1930], '09:05');
  assert.equal((await send([at1930], '09:21')).superseded, 1);
  assert.equal((await send([at0730], '13:34')).marked_missing, 1); // 19:30 is now pending

  const client = await connect('auto');
  const day = async () =>
    rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric: 'weight', start_date: '2001-02-08', end_date: '2001-02-08' } })).days[0];
  assert.deepEqual((await day()).weight.map((w: { time: string }) => w.time), ['07:30', '19:30'], 'pending rows still show');

  // Removed by hand one minute later, before reconciliation could confirm it.
  const removed = rows(await client.callTool({ name: 'delete_reading', arguments: { metric: 'weight', timestamp: '2001-02-08T19:30' } }));
  assert.equal(removed.removed.value, 180.5);
  assert.deepEqual((await day()).weight.map((w: { time: string }) => w.time), ['07:30']);

  for (const at of ['13:52', '14:30']) {
    const r = await send([at0730], at);
    assert.deepEqual([r.marked_missing, r.superseded, r.restored, r.rows_unchanged], [0, 0, 0, 1]);
  }
  const row = [...health.rows.values()].find((r) => r.recorded_at?.includes('19:30'))!;
  assert.equal(row.superseded_by, 'chat', 'the manual removal is left as it was');
  assert.deepEqual((await day()).weight.map((w: { time: string }) => w.time), ['07:30']);
  await client.close();
});
