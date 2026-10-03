import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OURA_DATA, PARAMS } from './fakes.ts';
import { rows, setup } from './harness.ts';

// get_report_data: the report page's five reads in one call. All values are invented; everything
// runs against the in-memory store and the fake Oura. The harness clock is 2026-09-27 11:00 in
// Los Angeles.

const RANGE = { start_date: '2026-09-24', end_date: '2026-09-27' };

async function seeded(opts: Parameters<typeof setup>[0] = {}) {
  const env = setup(opts);
  await env.ingest({
    data: {
      metrics: [
        { name: 'protein', units: 'g', data: [{ date: '2026-09-25 12:00:00 -0700', qty: 30, source: 'Food App' }, { date: '2026-09-26 19:00:00 -0700', qty: 25, source: 'Food App' }] },
        { name: 'carbohydrates', units: 'g', data: [{ date: '2026-09-25 12:00:00 -0700', qty: 12, source: 'Food App' }] },
        { name: 'weight_body_mass', units: 'lb', data: [{ date: '2026-09-26 07:00:00 -0700', qty: 180.4, source: 'Scale App' }] },
      ],
    },
  });
  await env.ingest({
    data: {
      workouts: [{
        id: 'w1', name: 'Indoor Cycling', start: '2026-09-26 07:30:00 -0700', end: '2026-09-26 08:00:00 -0700', duration: 1800,
        activeEnergyBurned: { qty: 300, units: 'kcal' }, avgHeartRate: { qty: 140, units: 'bpm' }, maxHeartRate: { qty: 165, units: 'bpm' },
        activeEnergy: [{ date: '2026-09-26 07:30:00 -0700', qty: 10, units: 'kcal', source: 'Bike App' }],
      }],
    },
  });
  return env;
}

test('each section is exactly what the individual tool returns for the same range', async () => {
  const { connect } = await seeded();
  const client = await connect('auto');
  const report = rows(await client.callTool({ name: 'get_report_data', arguments: RANGE }));
  assert.deepEqual(Object.keys(report), ['range', 'timezone', 'health', 'sleep', 'activity', 'readiness', 'workouts']);
  assert.deepEqual(report.range, { start: '2026-09-24', end: '2026-09-27' });
  assert.equal(report.timezone, 'America/Los_Angeles');

  const tool = async (name: string, extra: Record<string, unknown> = {}) => rows(await client.callTool({ name, arguments: { ...RANGE, ...extra } }));
  assert.deepEqual(report.health, await tool('get_health_metrics', { metric: 'all' }));
  assert.deepEqual(report.sleep, await tool('get_sleep'));
  assert.deepEqual(report.activity, await tool('get_activity'));
  assert.deepEqual(report.readiness, await tool('get_readiness'));
  assert.deepEqual(report.workouts, await tool('get_workouts'));

  // Real content, not just matching empties.
  assert.equal(report.health.days.length, 2);
  assert.equal(report.sleep.rows.length, 2);
  assert.equal(report.workouts.workouts[0].type, 'Indoor Cycling');

  // Same defaults as the tools: the last 7 days.
  const defaults = rows(await client.callTool({ name: 'get_report_data', arguments: {} }));
  assert.deepEqual(defaults.range, { start: '2026-09-21', end: '2026-09-27' });
  assert.deepEqual(defaults.health, rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric: 'all' } })));
  await client.close();
});

test("Oura's sleep periods are fetched once for both sleep and readiness", async () => {
  const { connect, oura } = await seeded();
  const client = await connect('auto');
  const sleepCalls = () => oura.calls.filter((c) => c.collection === 'sleep').length;

  let before = sleepCalls();
  rows(await client.callTool({ name: 'get_report_data', arguments: RANGE }));
  assert.equal(sleepCalls() - before, 1);
  const collections = oura.calls.slice(-5).map((c) => c.collection).sort();
  assert.deepEqual(collections, ['daily_activity', 'daily_readiness', 'daily_sleep', 'daily_spo2', 'sleep'], 'five Oura requests, not six');

  before = sleepCalls();
  rows(await client.callTool({ name: 'get_sleep', arguments: RANGE }));
  rows(await client.callTool({ name: 'get_readiness', arguments: RANGE }));
  assert.equal(sleepCalls() - before, 2, 'the two tools separately fetch them twice');
  await client.close();
});

test('a failing section is {error: {message}} and the other sections still return', async () => {
  // Oura refuses one collection.
  const { daily_activity: _left_out, ...withoutActivity } = OURA_DATA;
  {
    const { connect, logs } = await seeded({ data: withoutActivity });
    const client = await connect('auto');
    const r = await client.callTool({ name: 'get_report_data', arguments: RANGE });
    assert.ok(!r.isError, 'the call itself succeeds');
    const report = rows(r);
    assert.match(report.activity.error.message, /403|Forbidden/i);
    for (const k of ['health', 'sleep', 'readiness', 'workouts']) assert.ok(!('error' in report[k]), k);
    const line = logs.find((l) => l.msg === 'tool ok' && l.tool === 'get_report_data')!;
    assert.deepEqual(line.failed_sections, ['activity']);
    await client.close();
  }
  // The Oura grant is revoked: every Oura section carries the re-authorize message; health and workouts still load.
  {
    const { connect, store } = await seeded({ tokensExpireIn: -1 });
    store.data.set(PARAMS.tokens, JSON.stringify({ access_token: 'dead', refresh_token: 'revoked', expires_at: 0 }));
    const client = await connect('auto');
    const report = rows(await client.callTool({ name: 'get_report_data', arguments: RANGE }));
    for (const k of ['sleep', 'activity', 'readiness']) assert.match(report[k].error.message, /npm run oura-auth/, k);
    assert.equal(report.health.days.length, 2);
    assert.equal(report.workouts.workouts.length, 1);
    await client.close();
  }
  // The health table fails.
  {
    const { connect, health } = await seeded();
    health.query = async () => {
      throw new Error('DynamoDB is unavailable');
    };
    const client = await connect('auto');
    const report = rows(await client.callTool({ name: 'get_report_data', arguments: RANGE }));
    assert.deepEqual(report.health, { error: { message: 'DynamoDB is unavailable' } });
    assert.equal(report.sleep.rows.length, 2);
    assert.equal(report.workouts.workouts.length, 1, 'workouts use their own query');
    await client.close();
  }
});

test('the range can be up to 366 days; beyond that the call is refused', async () => {
  const { connect } = await seeded();
  const client = await connect('auto');
  const year = rows(await client.callTool({ name: 'get_report_data', arguments: { start_date: '2025-09-27', end_date: '2026-09-27' } }));
  assert.deepEqual(year.range, { start: '2025-09-27', end: '2026-09-27' });
  assert.equal(year.health.days.length + year.health.days_without_data.length, 366);
  assert.equal(year.health.days.length, 2, 'beyond get_health_metrics own 92-day limit');
  assert.equal(year.sleep.rows.length + year.sleep.days_without_data.length, 366);

  const tooLong = await client.callTool({ name: 'get_report_data', arguments: { start_date: '2025-09-26', end_date: '2026-09-27' } });
  assert.equal(tooLong.isError, true);
  assert.match((tooLong.content as { text: string }[])[0].text, /367 days; this tool allows at most 366/);

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'get_report_data')!;
  assert.deepEqual([tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint], [true, false]);
  assert.match(tool.description!, /report page/);
  const { prompts } = await client.listPrompts();
  assert.ok(!prompts.some((p) => p.name === 'get_report_data'), 'no prompt for it, on purpose');
  await client.close();
});
