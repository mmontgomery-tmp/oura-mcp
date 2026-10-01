import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHaePayload } from '../src/hae.ts';
import { type HealthRow, NET_CARBS_SWITCHOVER, NET_CARBS_SWITCHOVER_MS } from '../src/health.ts';
import { netCarbsForDay } from '../src/net-carbs.ts';
import { rows, setup } from './harness.ts';

// Switchover 2026-09-29 15:44 PDT (22:44 UTC). Before it, Apple Health Carbohydrates held net carbs
// and fiber is ignored; from it on, net carbs = carbs - fiber (matched by timestamp and source).
// All of this runs against the in-memory store.

const TZ = 'America/Los_Angeles';
type Sample = { date: string; qty: number; source?: string };
const payload = (m: { carbs?: Sample[]; fiber?: Sample[]; protein?: Sample[] }) => ({
  data: {
    metrics: [
      ...(m.carbs ? [{ name: 'carbohydrates', units: 'g', data: m.carbs.map((s) => ({ source: 'Cal AI', ...s })) }] : []),
      ...(m.fiber ? [{ name: 'fiber', units: 'g', data: m.fiber.map((s) => ({ source: 'Cal AI', ...s })) }] : []),
      ...(m.protein ? [{ name: 'protein', units: 'g', data: m.protein.map((s) => ({ source: 'Cal AI', ...s })) }] : []),
    ],
  },
});
const parse = (m: Parameters<typeof payload>[0]) =>
  parseHaePayload(payload(m), { timeZone: TZ, now: new Date('2026-09-30T12:00:00Z') }).rows;
const net = (m: Parameters<typeof payload>[0], dayEntirelyBeforeSwitchover = false) => {
  const r = parse(m);
  return netCarbsForDay(r.filter((x) => x.metric === 'carbs'), r.filter((x) => x.metric === 'fiber'), {
    dayEntirelyBeforeSwitchover,
    describe: (x: HealthRow) => `${x.value} g (${x.source})`,
  });
};

const LUNCH = '2026-09-29 12:30:00 -0700'; // before the switchover: entered as net carbs
const DINNER = '2026-09-29 19:02:00 -0700'; // after it: total carbs + fiber

test('the switchover is one constant, 2026-09-29 15:44 PDT', () => {
  assert.equal(NET_CARBS_SWITCHOVER, '2026-09-29T15:44:00-07:00');
  assert.equal(new Date(NET_CARBS_SWITCHOVER_MS).toISOString(), '2026-09-29T22:44:00.000Z');
});

test('before the switchover: carbs count as-is (net), fiber is ignored', () => {
  const r = net({ carbs: [{ date: '2026-09-28 12:00:00 -0700', qty: 12 }], fiber: [{ date: '2026-09-28 12:00:00 -0700', qty: 5 }] }, true);
  assert.deepEqual(r, { carbs_g: 12, warnings: [], unmatchedFiber: [] }, 'no total_carbs_g / fiber_g for days entirely before');
});

test('from the switchover on: net carbs = carbs - matched fiber', () => {
  const r = net({ carbs: [{ date: DINNER, qty: 30 }], fiber: [{ date: DINNER, qty: 8 }] });
  assert.deepEqual([r.carbs_g, r.total_carbs_g, r.fiber_g, r.warnings], [22, 30, 8, []]);
});

test('each sample decides by its own timestamp: one minute either side of the switchover', () => {
  const before = net({ carbs: [{ date: '2026-09-29 15:43:59 -0700', qty: 20 }], fiber: [{ date: '2026-09-29 15:43:59 -0700', qty: 5 }] });
  const at = net({ carbs: [{ date: '2026-09-29 15:44:00 -0700', qty: 20 }], fiber: [{ date: '2026-09-29 15:44:00 -0700', qty: 5 }] });
  assert.deepEqual([before.carbs_g, before.total_carbs_g, before.fiber_g], [20, 0, 0]);
  assert.deepEqual([at.carbs_g, at.total_carbs_g, at.fiber_g], [15, 20, 5]);
});

test('the mixed day (Sep 29): net lunch as-is + dinner total minus fiber', () => {
  const r = net({
    carbs: [{ date: LUNCH, qty: 4 }, { date: DINNER, qty: 30 }],
    fiber: [{ date: LUNCH, qty: 2 }, { date: DINNER, qty: 8 }],
  });
  assert.equal(r.carbs_g, 26, '4 (lunch, net as entered; its fiber ignored) + 30 - 8');
  assert.equal(r.total_carbs_g, 30, 'only samples from the switchover on');
  assert.equal(r.fiber_g, 8, 'the lunch fiber is before the switchover');
});

test('fiber is only subtracted with a matching carbs sample (same second and source)', () => {
  const r = net({
    carbs: [{ date: DINNER, qty: 30 }],
    fiber: [
      { date: DINNER, qty: 8 }, // matched
      { date: '2026-09-29 20:15:00 -0700', qty: 6 }, // fiber entry with no carbs entry
      { date: DINNER, qty: 3, source: 'MyFitnessPal' }, // same second, other app
    ],
  });
  assert.equal(r.carbs_g, 22, 'only the matched 8 g is subtracted');
  assert.equal(r.fiber_g, 17, 'fiber_g still reports all fiber from the switchover on');
  assert.equal(r.unmatchedFiber.length, 2);
  assert.match(r.warnings[0], /Fiber without a matching carbs entry was not subtracted: 6 g \(Cal AI\); 3 g \(MyFitnessPal\)/);
});

test('a day never goes below 0 net carbs; clamping adds a warning', () => {
  const r = net({ carbs: [{ date: DINNER, qty: 3 }], fiber: [{ date: DINNER, qty: 7 }] });
  assert.equal(r.carbs_g, 0);
  assert.match(r.warnings[0], /Net carbs came out at -4 g \(fiber exceeds carbs\); shown as 0\./);
});

test('get_health_metrics: carbs_g is net, total_carbs_g/fiber_g only from the switchover day on, fiber metric', async () => {
  const { ingest, connect, logs } = setup();
  await ingest(payload({
    carbs: [{ date: '2026-09-28 12:00:00 -0700', qty: 12 }, { date: LUNCH, qty: 4 }, { date: DINNER, qty: 30 }, { date: '2026-09-30 08:00:00 -0700', qty: 5 }],
    fiber: [{ date: '2026-09-28 12:00:00 -0700', qty: 5 }, { date: LUNCH, qty: 2 }, { date: DINNER, qty: 8 }, { date: '2026-09-30 09:00:00 -0700', qty: 9 }],
    protein: [{ date: DINNER, qty: 40 }],
  }));
  const client = await connect('auto');
  const get = async (metric: string) =>
    rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric, start_date: '2026-09-28', end_date: '2026-09-30' } })).days;

  assert.deepEqual(await get('all'), [
    { date: '2026-09-28', carbs_g: 12 }, // entirely before: as-is, fiber ignored, no total/fiber
    { date: '2026-09-29', protein_g: 40, carbs_g: 26, total_carbs_g: 30, fiber_g: 8 },
    {
      date: '2026-09-30', carbs_g: 5, total_carbs_g: 5, fiber_g: 9,
      warnings: ['Fiber without a matching carbs entry was not subtracted: 09:00 9 g (Cal AI).'],
    },
  ]);
  assert.deepEqual((await get('carbs')).map((d: { carbs_g: number }) => d.carbs_g), [12, 26, 5], '"carbs" keeps returning net carbs');
  assert.deepEqual(await get('fiber'), [{ date: '2026-09-29', fiber_g: 8 }, { date: '2026-09-30', fiber_g: 9 }]);
  assert.ok(logs.some((l) => l.msg === 'net carbs: unmatched fiber ignored' && l.date === '2026-09-30'));

  const { tools } = await client.listTools();
  const desc = JSON.stringify(tools.find((t) => t.name === 'get_health_metrics'));
  assert.match(desc, /2026-09-29 15:44/);
  assert.match(desc, /"fiber"/);
  await client.close();
});

test('fiber: a re-send is stored once; delete_reading marks it removed and undo restores it', async () => {
  const { ingest, connect, health } = setup();
  const p = payload({ carbs: [{ date: DINNER, qty: 30 }], fiber: [{ date: DINNER, qty: 8 }] });
  await ingest(p);
  const again = (await (await ingest(p)).json()) as { rows_written: number; rows_unchanged: number };
  assert.deepEqual([again.rows_written, again.rows_unchanged], [0, 2]);
  assert.equal([...health.rows.values()].filter((r) => r.metric === 'fiber').length, 1);

  const client = await connect('auto');
  const day = async () =>
    rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric: 'carbs', start_date: '2026-09-29', end_date: '2026-09-29' } })).days[0];
  assert.deepEqual([(await day()).carbs_g, (await day()).fiber_g], [22, 8]);
  const removed = rows(await client.callTool({ name: 'delete_reading', arguments: { metric: 'fiber', timestamp: '2026-09-29T19:02' } }));
  assert.equal(removed.removed.value, 8);
  assert.deepEqual([(await day()).carbs_g, (await day()).fiber_g], [30, 0], 'removed fiber is no longer subtracted');
  rows(await client.callTool({ name: 'delete_reading', arguments: { metric: 'fiber', timestamp: '2026-09-29T19:02', undo: true } }));
  assert.equal((await day()).carbs_g, 22);
  await client.close();
});
