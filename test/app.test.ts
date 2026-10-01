import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OURA_DATA, PARAMS, PATH_SECRET } from './fakes.ts';
import { HOST, rows, setup } from './harness.ts';

for (const mode of ['auto', 'legacy'] as const) {
  test(`MCP client (${mode} negotiation) lists the Oura and health tools`, async () => {
    const { connect } = setup();
    const client = await connect(mode);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'delete_reading', 'get_activity', 'get_health_metrics', 'get_heart_rate', 'get_readiness', 'get_sleep', 'log_reading',
    ]);
    const writers = new Set(['log_reading', 'delete_reading']);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, !writers.has(t.name), t.name);
    console.log(`  negotiated ${client.getProtocolEra()} / ${client.getNegotiatedProtocolVersion()}`);
    await client.close();
  });
}

test('get_sleep returns summarized daily rows', async () => {
  const { connect, oura } = setup();
  const client = await connect('auto');
  const out = rows(await client.callTool({ name: 'get_sleep', arguments: { start_date: '2026-09-25', end_date: '2026-09-26' } }));
  assert.deepEqual(out.range, { start: '2026-09-25', end: '2026-09-26' });
  assert.deepEqual(out.days_without_data, []);
  assert.deepEqual(out.rows[0], {
    date: '2026-09-25',
    sleep_score: 84,
    total_sleep_h: 7,
    time_in_bed_h: 7.76,
    deep_h: 1.5,
    rem_h: 1.75,
    light_h: 3.75,
    efficiency_pct: 90,
    bedtime: '23:12',
    wake_time: '06:58',
    resting_hr_bpm: 51, // min of 5-minute samples, not ecore's 48
    avg_hrv_ms: 61,
    avg_breath_rpm: 14.6,
    breathing_disturbance_index: 3,
    spo2_avg_pct: 96.4,
    nap_h: 0.5, // the 'rest' period is excluded
  });
  assert.equal(out.rows[1].resting_hr_bpm, 50); // no samples -> falls back to lowest_heart_rate
  assert.equal(out.rows[1].breathing_disturbance_index, null);
  // Only needed fields were requested from Oura.
  const sleepCall = oura.calls.find((c) => c.collection === 'sleep')!;
  assert.ok(!sleepCall.params.fields.includes('sleep_phase_30_sec'));
  assert.equal(sleepCall.params.start_date, '2026-09-24');
  await client.close();
});

test('get_sleep degrades gracefully without the spo2 scope', async () => {
  const { daily_spo2: _omit, ...withoutSpo2 } = OURA_DATA;
  const { connect } = setup({ data: withoutSpo2 });
  const client = await connect('auto');
  const out = rows(await client.callTool({ name: 'get_sleep', arguments: { start_date: '2026-09-25', end_date: '2026-09-25' } }));
  assert.equal(out.rows[0].breathing_disturbance_index, null);
  assert.match(out.notes[0], /spo2/);
  await client.close();
});

test('get_heart_rate buckets UTC samples into local days', async () => {
  const { connect } = setup();
  const client = await connect('legacy');
  const out = rows(
    await client.callTool({ name: 'get_heart_rate', arguments: { start_date: '2026-09-25', end_date: '2026-09-26' } }),
  );
  assert.deepEqual(out.rows[0], {
    date: '2026-09-25',
    resting_hr_bpm: 51,
    avg_hrv_ms: 61,
    avg_hr_bpm: 96, // (72 + 151 + 66) / 3; the 05:00Z sample is 22:00 local on the 25th
    min_hr_bpm: 66,
    max_hr_bpm: 151,
    avg_awake_hr_bpm: 69,
    avg_sleep_hr_bpm: 55, // no sleep-sourced samples that day -> the sleep period's average
    max_workout_hr_bpm: 151,
    samples: 3,
  });
  assert.equal(out.rows[1].avg_sleep_hr_bpm, 53);
  assert.equal(out.rows[1].samples, 2);
  await client.close();
});

test('get_readiness and get_activity rows', async () => {
  const { connect } = setup();
  const client = await connect('auto');
  const readiness = rows(await client.callTool({ name: 'get_readiness', arguments: { start_date: '2026-09-25', end_date: '2026-09-26' } }));
  assert.deepEqual(readiness.rows[0], {
    date: '2026-09-25',
    readiness_score: 82,
    temp_deviation_c: -0.12,
    temp_trend_deviation_c: 0.05,
    resting_hr_bpm: 51,
    avg_hrv_ms: 61,
  });
  const activity = rows(await client.callTool({ name: 'get_activity', arguments: { start_date: '2026-09-24', end_date: '2026-09-26' } }));
  assert.deepEqual(activity.rows, [
    {
      date: '2026-09-25',
      activity_score: 88,
      steps: 11_234,
      active_kcal: 512,
      total_kcal: 2_480,
      walking_equiv_km: 9.9,
      high_activity_min: 20,
      medium_activity_min: 45,
      low_activity_min: 240,
      sedentary_h: 8.5,
      non_wear_h: 0.17,
    },
  ]);
  assert.deepEqual(activity.days_without_data, ['2026-09-24', '2026-09-26']);
  await client.close();
});

test('default range is the last 7 days in the user timezone; oversized ranges are rejected', async () => {
  const { connect } = setup();
  const client = await connect('auto');
  const out = rows(await client.callTool({ name: 'get_activity', arguments: {} }));
  assert.deepEqual(out.range, { start: '2026-09-21', end: '2026-09-27' });
  // Only start_date given: runs through today, as the schema says (not start + 6 days).
  const fromStart = rows(await client.callTool({ name: 'get_activity', arguments: { start_date: '2026-08-29' } }));
  assert.deepEqual(fromStart.range, { start: '2026-08-29', end: '2026-09-27' });
  const tooBig = (await client.callTool({
    name: 'get_heart_rate',
    arguments: { start_date: '2026-01-01', end_date: '2026-03-01' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.content[0].text, /at most 31/);
  await client.close();
});

test('expired Oura token is refreshed transparently and the rotation is persisted', async () => {
  const { connect, oura, store } = setup({ tokensExpireIn: -1 });
  const client = await connect('auto');
  rows(await client.callTool({ name: 'get_activity', arguments: { start_date: '2026-09-25', end_date: '2026-09-25' } }));
  assert.equal(oura.refreshes, 1);
  assert.equal(JSON.parse(store.data.get(PARAMS.tokens)!).refresh_token, 'rt-2');
  await client.close();
});

test('wrong or missing path secret gets a bare 404, and the secret never reaches the logs', async () => {
  const { viaFunctionUrl, logs } = setup();
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  };
  for (const path of ['/mcp/wrong', '/mcp', '/', `/mcp/${PATH_SECRET}x`, `/other/${PATH_SECRET}`]) {
    const res = await viaFunctionUrl(`https://${HOST}${path}`, init);
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), 'Not found');
  }
  const ok = await viaFunctionUrl(`https://${HOST}/mcp/${PATH_SECRET}/`, {
    ...init,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
    }),
  });
  assert.equal(ok.status, 200);
  assert.ok(!JSON.stringify(logs).includes(PATH_SECRET));
});

test('GET (2025 SSE stream) is answered 405 in stateless mode', async () => {
  const { viaFunctionUrl } = setup();
  const res = await viaFunctionUrl(`https://${HOST}/mcp/${PATH_SECRET}`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(res.status, 405);
});

test('a revoked Oura grant is a clear tool error that says how to re-authorize, never an HTTP 500', async () => {
  const { store, viaFunctionUrl } = setup({ tokensExpireIn: -1 });
  store.data.set(PARAMS.tokens, JSON.stringify({ access_token: 'dead', refresh_token: 'revoked', expires_at: 0 }));
  const res = await viaFunctionUrl(`https://${HOST}/mcp/${PATH_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_sleep', arguments: {} } }),
  });
  assert.equal(res.status, 200);
  const msg = JSON.parse((await res.text()).replace(/^event: message\ndata: /, ''));
  assert.equal(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /rejected the stored refresh token.*To re-authorize Oura, run `npm run oura-auth`/s);
});
