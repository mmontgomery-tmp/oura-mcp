import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { parseHaePayload, redactPayload } from '../src/hae.ts';
import { dedupeReadings, type HealthRow } from '../src/health.ts';
import { rows, setup } from './harness.ts';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-09-27T18:00:00Z'); // 11:00 in Los Angeles (matches the harness)

// A Health Auto Export v2 JSON payload with every shape the parser has to handle.
const HAE_PAYLOAD = {
  data: {
    metrics: [
      { name: 'weight_body_mass', units: 'kg', data: [
        { date: '2026-09-26 07:02:11 -0700', qty: 82.3, source: 'Withings' },
        { date: 'not a date', qty: 82.0, source: 'Withings' },
      ] },
      { name: 'blood_pressure', units: 'mmHg', data: [{ date: '2026-09-26 07:05:00 -0700', systolic: 118, diastolic: 76, source: 'OMRON connect' }] },
      { name: 'blood_glucose', units: 'mmol<180.1558800000541>/L', data: [
        { date: '2026-09-26 13:30:00 -0700', qty: 5.2, source: 'OneTouch Reveal', metadata: { HKBloodGlucoseMealTime: '2' } },
        { date: '2026-09-26 13:31:00 -0700', qty: 5.5, source: 'Oura' },
      ] },
      { name: 'protein', units: 'g', data: [
        { date: '2026-09-26 12:00:00 -0700', qty: 20, source: 'MyFitnessPal' },
        { date: '2026-09-26 12:00:00 -0700', qty: 15, source: 'MyFitnessPal' }, // same timestamp: summed
        { date: '2026-09-26 19:00:00 -0700', qty: 42.5, source: 'MyFitnessPal' },
      ] },
      { name: 'carbohydrates', units: 'oz', data: [{ date: '2026-09-26 12:00:00 -0700', qty: 1, source: 'MyFitnessPal' }] },
      { name: 'dietary_energy', units: 'kJ', data: [{ date: '2026-09-26 12:00:00 -0700', qty: 2092, source: 'MyFitnessPal' }] },
      { name: 'step_count', units: 'count', data: [{ date: '2026-09-26 08:00:00 -0700', qty: 800, source: 'iPhone' }, { date: '2026-09-26 09:00:00 -0700', qty: 12, source: 'iPhone' }] },
    ],
    workouts: [],
  },
};

test('HAE parser: accepted metrics, units normalized, Oura and unsupported samples skipped', () => {
  const r = parseHaePayload(HAE_PAYLOAD, { timeZone: TZ, now: NOW });
  assert.equal(r.accepted, 7);
  assert.equal(r.skipped, 5);
  assert.deepEqual(r.skipped_reasons, { invalid_sample: 1, oura_source: 1, unknown_unit: 1, unsupported_metric: 2 });
  assert.deepEqual(r.ignored_metrics, ['step_count']);
  const by = (m: string) => r.rows.filter((x) => x.metric === m);

  const { ts: weightKey, ...weight } = by('weight')[0];
  assert.match(weightKey, /^2026-09-26T14:02:11Z#[0-9a-f]{12}$/, 'UTC second + sample fingerprint');
  assert.deepEqual(weight, {
    metric: 'weight', value: 181.44, unit: 'lb', original_value: 82.3, original_unit: 'kg',
    source: 'Withings', via: 'hae', recorded_at: '2026-09-26 07:02:11 -0700', ingested_at: NOW.toISOString(),
  });
  assert.equal(by('bp')[0].systolic, 118);
  assert.equal(by('bp')[0].diastolic, 76);
  assert.equal(by('bp')[0].value, undefined);
  const glucose = by('glucose');
  assert.equal(glucose.length, 1, 'the Oura-sourced glucose sample is dropped');
  assert.equal(glucose[0].value, 93.7); // 5.2 mmol/L x 18.016
  assert.equal(glucose[0].context, 'post-meal'); // HKBloodGlucoseMealTime 2 = postprandial
  // Two food entries at the same second are stored as two rows, not summed into one.
  assert.deepEqual(by('protein').map((x) => [x.ts.slice(0, 20), x.value]), [
    ['2026-09-26T19:00:00Z', 20], ['2026-09-26T19:00:00Z', 15], ['2026-09-27T02:00:00Z', 42.5],
  ]);
  assert.notEqual(by('protein')[0].ts, by('protein')[1].ts);
  assert.deepEqual(r.metric_counts, { weight_body_mass: 2, blood_pressure: 1, blood_glucose: 2, protein: 3, carbohydrates: 1, dietary_energy: 1, step_count: 2 });
  assert.equal(by('calories')[0].value, 500); // 2092 kJ
  assert.equal(by('carbs').length, 0); // "oz" is not a unit we convert
});

test('HAE parser: rejects non-HAE bodies, tolerates payloads with no metrics', () => {
  assert.throws(() => parseHaePayload({ foo: 1 }, { timeZone: TZ, now: NOW }), /data/);
  assert.throws(() => parseHaePayload({ data: { metrics: {} } }, { timeZone: TZ, now: NOW }), /array/);
  assert.equal(parseHaePayload({ data: { workouts: [] } }, { timeZone: TZ, now: NOW }).accepted, 0);
});

test('redaction keeps the structure but no health values', () => {
  const red = JSON.stringify(redactPayload(HAE_PAYLOAD));
  for (const leaked of ['82.3', '118', '5.2', '2092', '42.5']) assert.ok(!red.includes(leaked), `leaked ${leaked}`);
  for (const kept of ['weight_body_mass', 'blood_pressure', 'systolic', 'qty', 'mmol<', 'step_count', '2026-09-26 07:02:11 -0700', 'OneTouch Reveal', 'HKBloodGlucoseMealTime', '<1 more>']) {
    assert.ok(red.includes(kept), `missing ${kept}`);
  }
});

const row = (source: string, ts: string, value: number, metric: HealthRow['metric'] = 'glucose'): HealthRow => ({
  metric, ts, value, unit: 'mg/dL', original_unit: 'mg/dL', source, via: source === 'claude-log' ? 'chat' : 'hae',
  recorded_at: ts, ingested_at: ts,
});

test('duplicates: same metric, within 15 min and 5%, keep the claude-log row, pair at most once', () => {
  const claude = row('claude-log', '2026-09-26T14:05:00Z', 102);
  const cases: [HealthRow, boolean][] = [
    [row('OneTouch', '2026-09-26T14:00:00Z', 100), true], // 5 min, 2%
    [row('OneTouch', '2026-09-26T13:50:00Z', 100), true], // exactly 15 min
    [row('OneTouch', '2026-09-26T13:49:59Z', 100), false], // 15 min 1 s
    [row('OneTouch', '2026-09-26T14:00:00Z', 96.8), false], // 5.1% apart
    [row('OneTouch', '2026-09-26T14:00:00Z', 97), true], // 4.9% apart
    [row('OneTouch', '2026-09-26T14:00:00Z', 100, 'ketones'), false], // different metric
  ];
  for (const [other, hidden] of cases) {
    const { kept } = dedupeReadings([claude, other]);
    assert.equal(kept.includes(other), !hidden, `${other.metric} ${other.ts} ${other.value}`);
    assert.ok(kept.includes(claude));
  }
  // Two meter readings near one chat reading: only the closest one is its duplicate.
  const near = row('OneTouch', '2026-09-26T14:04:00Z', 101);
  const far = row('OneTouch', '2026-09-26T14:12:00Z', 103);
  const { kept, hidden } = dedupeReadings([claude, near, far]);
  assert.equal(hidden, 1);
  assert.deepEqual(kept, [claude, far]);
});

// ---------------------------------------------------------------------------------------
// Ingest endpoint

test('ingest: auth, size limit, content checks, and counts', async () => {
  const { ingest, health } = setup();
  assert.equal((await ingest(HAE_PAYLOAD, { secret: 'wrong' })).status, 404);
  assert.equal((await ingest(HAE_PAYLOAD, { key: null })).status, 401);
  assert.equal((await ingest(HAE_PAYLOAD, { key: 'wrong' })).status, 401);
  assert.equal((await ingest('{not json')).status, 400);
  assert.equal((await ingest({ hello: 'world' })).status, 400);
  assert.equal((await ingest('a,b\n1,2', { headers: { 'content-type': 'text/csv' } })).status, 415);
  const big = { data: { metrics: [{ name: 'protein', units: 'g', data: [{ date: '2026-09-26 12:00:00 -0700', qty: 1, source: 'x'.repeat(1024 * 1024) }] }] } };
  const tooBig = await ingest(big);
  assert.equal(tooBig.status, 413);
  assert.match(((await tooBig.json()) as { hint: string }).hint, /Batch Requests/);
  assert.equal(health.rows.size, 0, 'nothing written by rejected requests');

  const ok = await ingest(HAE_PAYLOAD);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    accepted: 7, skipped: 5, rows_written: 7, rows_unchanged: 0, ignored_metrics: ['step_count'],
    reconcile: 'off', marked_missing: 0, superseded: 0, restored: 0, // no "Previous 7 Days" period header
    skipped_reasons: { invalid_sample: 1, oura_source: 1, unknown_unit: 1, unsupported_metric: 2 },
  });
  // Re-sending the same payload lands on the same keys and writes nothing.
  const again = (await (await ingest(HAE_PAYLOAD)).json()) as { rows_written: number; rows_unchanged: number };
  assert.deepEqual([again.rows_written, again.rows_unchanged], [0, 7]);
  assert.equal(health.rows.size, 7);
});

test('ingest: a mis-entered X-Ingest-Key is diagnosed in the log without logging the key', async () => {
  const { ingest, logs } = setup();
  const { INGEST_KEY } = await import('./fakes.ts');
  const payload = { data: { metrics: [] } };
  assert.equal((await ingest(payload, { key: `  ${INGEST_KEY}\n` })).status, 200, 'surrounding whitespace is tolerated');
  await ingest(payload, { key: null, headers: { 'ingest-key': INGEST_KEY } }); // wrong header name
  await ingest(payload, { key: `X-Ingest-Key: ${INGEST_KEY}` }); // header line pasted as the value
  await ingest(payload, { key: INGEST_KEY.toUpperCase() });
  await ingest(payload, { key: null });
  const rejected = logs.filter((l) => l.msg === 'rejected: bad or missing X-Ingest-Key');
  assert.equal(rejected.length, 4);
  assert.equal(rejected[0].key_found_in_header, 'ingest-key');
  assert.match(String(rejected[1].hint), /plus extra text/);
  assert.match(String(rejected[2].hint), /letter case/);
  assert.equal(rejected[3].problem, 'no X-Ingest-Key header');
  assert.ok(!JSON.stringify(logs).includes(INGEST_KEY) && !JSON.stringify(logs).includes(INGEST_KEY.toUpperCase()), 'key never logged');
});

test('ingest: gzip bodies are inflated (and a gzip bomb is refused)', async () => {
  const { ingest, health } = setup();
  const gz = await ingest(gzipSync(JSON.stringify(HAE_PAYLOAD)), { headers: { 'content-encoding': 'gzip' } });
  assert.equal(gz.status, 200);
  assert.equal(((await gz.json()) as { rows_written: number }).rows_written, 7);
  assert.equal(health.rows.size, 7);
  const bomb = gzipSync(JSON.stringify({ data: { metrics: [], pad: 'x'.repeat(3 * 1024 * 1024) } }));
  assert.ok(bomb.length < 1024 * 1024, 'compressed size is under the limit');
  assert.equal((await ingest(bomb, { headers: { 'content-encoding': 'gzip' } })).status, 413);
});

test('ingest: the first payload is logged once, redacted, and never the secrets', async () => {
  const { ingest, logs, health } = setup();
  await ingest(HAE_PAYLOAD, { headers: { 'automation-name': 'Health backend', 'automation-aggregation': 'none' } });
  await ingest(HAE_PAYLOAD);
  const firsts = logs.filter((l) => l.msg === 'hae first payload (redacted)');
  assert.equal(firsts.length, 1);
  assert.equal(health.markerClaims, 1);
  const text = JSON.stringify(firsts[0]);
  assert.match(text, /"automation-name":"Health backend"/);
  assert.match(text, /weight_body_mass/);
  assert.ok(!text.includes('82.3') && !text.includes('118'), 'values redacted');
  const { INGEST_KEY, INGEST_SECRET } = await import('./fakes.ts');
  const all = JSON.stringify(logs);
  assert.ok(!all.includes(INGEST_KEY) && !all.includes(INGEST_SECRET), 'secrets never logged');
});

// ---------------------------------------------------------------------------------------
// MCP tools

const call = async (client: Awaited<ReturnType<ReturnType<typeof setup>['connect']>>, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };

test('log_reading stores glucose and ketones and returns the row; defaults to now in Los Angeles', async () => {
  const { connect, health } = setup();
  const client = await connect('auto');
  const g = rows(await call(client, 'log_reading', { metric: 'glucose', value: 94, unit: 'mg/dL', context: 'fasting', note: 'before coffee' }));
  assert.deepEqual(g.stored, {
    metric: 'glucose', date: '2026-09-27', time: '11:00', value: 94, unit: 'mg/dL', context: 'fasting',
    source: 'claude-log', note: 'before coffee', timestamp: '2026-09-27T11:00:00-07:00',
  });
  const k = rows(await call(client, 'log_reading', { metric: 'ketones', value: 1.3, unit: 'mmol/L', timestamp: '2026-09-27T08:15' }));
  assert.equal(k.stored.timestamp, '2026-09-27T08:15:00-07:00');
  const stored = health.rows.get('ketones|2026-09-27T15:15:00Z')!;
  assert.equal(stored.source, 'claude-log');
  assert.equal(stored.via, 'chat');
  assert.equal(stored.original_unit, 'mmol/L');
  await client.close();
});

test('log_reading rejects wrong units, out-of-range and future values without writing', async () => {
  const { connect, health } = setup();
  const client = await connect('auto');
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ metric: 'glucose', value: 5.4, unit: 'mmol/L' }, /must be reported in mg\/dL.*Nothing was saved/],
    [{ metric: 'ketones', value: 12, unit: 'mg/dL' }, /must be reported in mmol\/L/],
    [{ metric: 'glucose', value: 650, unit: 'mg/dL' }, /outside the accepted range 20–600 mg\/dL. Nothing was saved/],
    [{ metric: 'glucose', value: 19, unit: 'mg/dL' }, /outside the accepted range/],
    [{ metric: 'ketones', value: 10.5, unit: 'mmol/L' }, /outside the accepted range 0–10/],
    [{ metric: 'glucose', value: 90, unit: 'mg/dL', timestamp: '2026-09-28T09:00' }, /in the future/],
    [{ metric: 'glucose', value: 90, unit: 'mg/dL', timestamp: 'this morning' }, /Invalid timestamp/],
  ];
  for (const [args, message] of cases) {
    const r = await call(client, 'log_reading', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, message);
  }
  const tooLong = await call(client, 'log_reading', { metric: 'glucose', value: 90, unit: 'mg/dL', note: 'x'.repeat(201) });
  assert.equal(tooLong.isError, true);
  // Boundaries are inclusive.
  rows(await call(client, 'log_reading', { metric: 'ketones', value: 0, unit: 'mmol/L', timestamp: '2026-09-27T06:00' }));
  rows(await call(client, 'log_reading', { metric: 'glucose', value: 600, unit: 'mg/dL', timestamp: '2026-09-27T06:00' }));
  assert.equal(health.rows.size, 2);
  await client.close();
});

test('get_health_metrics "all": daily sums, readings, and an HAE+chat duplicate shown once', async () => {
  const { connect, ingest } = setup();
  await ingest(HAE_PAYLOAD);
  // Meter reading synced via Apple Health at 07:00, the same reading reported in chat at 07:05.
  await ingest({ data: { metrics: [{ name: 'blood_glucose', units: 'mg/dL', data: [{ date: '2026-09-27 07:00:00 -0700', qty: 100, source: 'OneTouch Reveal' }] }] } });
  const client = await connect('auto');
  rows(await call(client, 'log_reading', { metric: 'glucose', value: 102, unit: 'mg/dL', timestamp: '2026-09-27T07:05', context: 'fasting' }));

  const out = rows(await call(client, 'get_health_metrics', { metric: 'all', start_date: '2026-09-26' }));
  assert.deepEqual(out.range, { start: '2026-09-26', end: '2026-09-27' });
  assert.equal(out.timezone, 'America/Los_Angeles');
  const [d26, d27] = out.days;
  assert.equal(d26.protein_g, 77.5); // 35 + 42.5
  assert.equal(d26.calories_kcal, 500);
  assert.deepEqual(d26.weight, [{ time: '07:02', value: 181.44, unit: 'lb', source: 'Withings' }]);
  assert.deepEqual(d26.bp, [{ time: '07:05', systolic: 118, diastolic: 76, unit: 'mmHg', source: 'OMRON connect' }]);
  assert.deepEqual(d26.glucose, [{ time: '13:30', value: 93.7, unit: 'mg/dL', context: 'post-meal', source: 'OneTouch Reveal' }]);
  assert.deepEqual(d27.glucose, [
    { time: '07:05', value: 102, unit: 'mg/dL', context: 'fasting', source: 'claude-log', timestamp: '2026-09-27T07:05:00-07:00' },
  ]);
  assert.match(out.notes.join(' '), /1 Apple Health glucose reading\(s\) hidden as duplicates/);
  assert.deepEqual(out.days_without_data, []);

  // A single metric only returns that metric.
  const g = rows(await call(client, 'get_health_metrics', { metric: 'protein', start_date: '2026-09-26', end_date: '2026-09-26' }));
  assert.deepEqual(g.days, [{ date: '2026-09-26', protein_g: 77.5 }]);
  await client.close();
});

test('delete_reading: chat readings are deleted, Apple Health readings are marked removed and can be undone', async () => {
  const { connect, ingest, health } = setup();
  const meter = { data: { metrics: [{ name: 'blood_glucose', units: 'mg/dL', data: [{ date: '2026-09-27 07:00:14 -0700', qty: 100, source: 'OneTouch Reveal' }] }] } };
  await ingest(meter);
  const client = await connect('auto');
  const logged = rows(await call(client, 'log_reading', { metric: 'glucose', value: 88, unit: 'mg/dL', timestamp: '2026-09-27T09:10:30' }));
  const glucoseDay = async () =>
    rows(await call(client, 'get_health_metrics', { metric: 'glucose', start_date: '2026-09-27', end_date: '2026-09-27' })).days[0]?.glucose ?? [];

  // Apple Health reading, found to the minute (get_health_metrics shows 07:00): marked removed, not deleted.
  const removed = rows(await call(client, 'delete_reading', { metric: 'glucose', timestamp: '2026-09-27T07:00' }));
  assert.equal(removed.removed.value, 100);
  assert.equal(removed.removed.timestamp, '2026-09-27T07:00:14-07:00');
  assert.match(removed.note, /still in Apple Health \(OneTouch Reveal\), so delete it there first, or the next Health Auto Export push/);
  const hae = [...health.rows.values()].find((r) => r.via === 'hae')!;
  assert.ok(hae.superseded_at);
  assert.equal(hae.superseded_by, 'chat');
  assert.deepEqual((await glucoseDay()).map((r: { value: number }) => r.value), [88]);

  // Undo brings it back.
  const restored = rows(await call(client, 'delete_reading', { metric: 'glucose', timestamp: '2026-09-27T07:00', undo: true }));
  assert.equal(restored.restored.value, 100);
  assert.deepEqual((await glucoseDay()).map((r: { value: number }) => r.value).sort(), [100, 88].sort());

  // A later push that still contains it clears a manual mark (it wasn't deleted in Apple Health).
  rows(await call(client, 'delete_reading', { metric: 'glucose', timestamp: '2026-09-27T07:00:14-07:00' }));
  const push = (await (await ingest(meter)).json()) as { restored: number };
  assert.equal(push.restored, 1);
  assert.equal([...health.rows.values()].find((r) => r.via === 'hae')!.superseded_at, undefined);

  // Chat readings are still deleted outright, and cannot be undone.
  const deleted = rows(await call(client, 'delete_reading', { metric: 'glucose', timestamp: logged.stored.timestamp }));
  assert.equal(deleted.deleted.value, 88);
  assert.equal([...health.rows.values()].filter((r) => r.via === 'chat').length, 0);
  const noUndo = await call(client, 'delete_reading', { metric: 'glucose', timestamp: logged.stored.timestamp, undo: true });
  assert.match(noUndo.content[0].text, /Chat readings are deleted permanently; log it again with log_reading/);

  const missing = await call(client, 'delete_reading', { metric: 'glucose', timestamp: '2026-09-27T11:11' });
  assert.match(missing.content[0].text, /No glucose reading at/);
  await client.close();
});

test('delete_reading: several readings in the same minute need a value; nothing changes until then', async () => {
  const { connect, ingest, health } = setup();
  await ingest({ data: { metrics: [{ name: 'protein', units: 'g', data: [
    { date: '2026-09-27 12:00:05 -0700', qty: 20, source: 'Cal AI' },
    { date: '2026-09-27 12:00:40 -0700', qty: 15, source: 'Cal AI' },
  ] }] } });
  const client = await connect('auto');
  const ambiguous = await call(client, 'delete_reading', { metric: 'protein', timestamp: '2026-09-27T12:00' });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /2 protein readings match .*12:00:05 20 g \(Cal AI\); 12:00:40 15 g \(Cal AI\)\. Pass value/);
  assert.ok([...health.rows.values()].every((r) => !r.superseded_at));
  const picked = rows(await call(client, 'delete_reading', { metric: 'protein', timestamp: '2026-09-27T12:00', value: 15 }));
  assert.equal(picked.removed.value, 15);
  const day = rows(await call(client, 'get_health_metrics', { metric: 'protein', start_date: '2026-09-27', end_date: '2026-09-27' }));
  assert.equal(day.days[0].protein_g, 20);
  await client.close();
});

test('a chat reading at the same second as an Apple Health reading is stored separately', async () => {
  const { connect, ingest, health } = setup();
  await ingest({ data: { metrics: [{ name: 'blood_glucose', units: 'mg/dL', data: [{ date: '2026-09-27 07:00:00 -0700', qty: 100, source: 'OneTouch Reveal' }] }] } });
  const client = await connect('auto');
  rows(await call(client, 'log_reading', { metric: 'glucose', value: 140, unit: 'mg/dL', timestamp: '2026-09-27T07:00:00' }));
  assert.equal(health.rows.get('glucose|2026-09-27T14:00:00Z')!.value, 140);
  assert.equal([...health.rows.values()].filter((r) => r.via === 'hae')[0].value, 100);
  await client.close();
});

// ---------------------------------------------------------------------------------------
// Re-sent 7-day windows ("Previous 7 Days"): idempotent keys, separate same-second samples

const glucoseAt = (samples: { date: string; qty: number; source: string }[]) => ({
  data: { metrics: [{ name: 'blood_glucose', units: 'mg/dL', data: samples }] },
});

test('the same sample always maps to the same key, in any order and any request', () => {
  const a = { date: '2026-09-27 07:00:00 -0700', qty: 100, source: 'OneTouch' };
  const b = { date: '2026-09-27 08:00:00 -0700', qty: 120, source: 'OneTouch' };
  const keys = (payload: unknown) => parseHaePayload(payload, { timeZone: TZ, now: NOW }).rows.map((r) => r.ts).sort();
  assert.deepEqual(keys(glucoseAt([a, b])), keys(glucoseAt([b, a])));
  // Split across two requests (Batch Requests ON): same keys as one request.
  assert.deepEqual([...keys(glucoseAt([a])), ...keys(glucoseAt([b]))].sort(), keys(glucoseAt([a, b])));
  // The offset used to express the time does not matter.
  assert.deepEqual(keys(glucoseAt([{ ...a, date: '2026-09-27 14:00:00 +0000' }])), keys(glucoseAt([a])));
});

test('different samples at the same second are all stored: other value, other source, or exact duplicates', async () => {
  const { ingest, health } = setup();
  const at = '2026-09-27 12:00:00 -0700';
  const payload = {
    data: {
      metrics: [
        { name: 'protein', units: 'g', data: [
          { date: at, qty: 20, source: 'Cal AI' },
          { date: at, qty: 15, source: 'Cal AI' }, // same second, other value
          { date: at, qty: 20, source: 'MyFitnessPal' }, // same second and value, other source
          { date: at, qty: 6, source: 'Cal AI' },
          { date: at, qty: 6, source: 'Cal AI' }, // exact duplicate (two identical entries)
        ] },
      ],
    },
  };
  const first = (await (await ingest(payload)).json()) as { rows_written: number };
  assert.equal(first.rows_written, 5);
  assert.equal(new Set([...health.rows.keys()]).size, 5);
  // Re-sending (every 5 minutes) neither duplicates nor rewrites anything.
  const again = (await (await ingest(payload)).json()) as { rows_written: number; rows_unchanged: number };
  assert.deepEqual([again.rows_written, again.rows_unchanged], [0, 5]);
  assert.equal(health.rows.size, 5);
  const total = [...health.rows.values()].reduce((s, r) => s + (r.value ?? 0), 0);
  assert.equal(total, 67, 'every gram counted once');
});

test('only new or changed samples are written; ingested_at alone does not count as a change', async () => {
  const { ingest, health } = setup();
  const day = [
    { date: '2026-09-27 07:00:00 -0700', qty: 100, source: 'OneTouch' },
    { date: '2026-09-27 12:00:00 -0700', qty: 140, source: 'OneTouch' },
  ];
  await ingest(glucoseAt(day));
  const writesAfterFirst = health.writes;
  const r = (await (await ingest(glucoseAt([...day, { date: '2026-09-27 18:00:00 -0700', qty: 110, source: 'OneTouch' }]))).json()) as {
    rows_written: number;
    rows_unchanged: number;
  };
  assert.deepEqual([r.rows_written, r.rows_unchanged], [1, 2]);
  assert.equal(health.writes - writesAfterFirst, 1);
});

test('migrating an old plain-key row gives exactly the key a re-sent sample will get', async () => {
  const { haeKeyInputs, haeSortKey, rowInstant } = await import('../src/health.ts');
  for (const row of parseHaePayload(HAE_PAYLOAD, { timeZone: TZ, now: NOW }).rows) {
    const legacy = { ...row, ts: rowInstant(row) }; // how it was stored before fingerprints
    assert.equal(haeSortKey(legacy.ts, haeKeyInputs(legacy)), row.ts, `${row.metric} ${row.ts}`);
  }
});

// ---------------------------------------------------------------------------------------
// get_health_metrics as an MCP prompt

test('parsePromptArgs: metrics, aliases, durations and dates', async () => {
  const { parsePromptArgs } = await import('../src/health-tools.ts');
  const today = '2026-09-27';
  assert.deepEqual(parsePromptArgs({}, today), { metric: 'all' });
  assert.deepEqual(parsePromptArgs({ metric: 'Glucose', range: '30d' }, today), { metric: 'glucose', start_date: '2026-08-29' });
  assert.deepEqual(parsePromptArgs({ metric: 'blood pressure', range: '7 days' }, today), { metric: 'bp', start_date: '2026-09-21' });
  assert.deepEqual(parsePromptArgs({ range: '2026-09-01' }, today), { metric: 'all', start_date: '2026-09-01' });
  assert.deepEqual(parsePromptArgs({ range: '2026-09-01 to 2026-09-15' }, today), { metric: 'all', start_date: '2026-09-01', end_date: '2026-09-15' });
  assert.deepEqual(parsePromptArgs({ range: '2026-09-01..2026-09-15' }, today), { metric: 'all', start_date: '2026-09-01', end_date: '2026-09-15' });
  assert.throws(() => parsePromptArgs({ metric: 'steps' }, today), /Unknown metric "steps"/);
  assert.throws(() => parsePromptArgs({ range: 'last month' }, today), /Unrecognized range/);
  assert.throws(() => parsePromptArgs({ range: '200d' }, today), /1–92 days/);
});

test('get_health_metrics prompt: listed with its arguments and embeds the same data as the tool', async () => {
  const { connect, ingest } = setup();
  await ingest(HAE_PAYLOAD);
  const client = await connect('auto');
  const { prompts } = await client.listPrompts();
  const p = prompts.find((x) => x.name === 'get_health_metrics');
  assert.ok(p, 'prompt is listed');
  assert.deepEqual(p!.arguments?.map((a) => [a.name, a.required ?? false]), [['metric', false], ['range', false]]);

  const got = await client.getPrompt({ name: 'get_health_metrics', arguments: { metric: 'protein', range: '2026-09-26' } });
  const text = (got.messages[0].content as { text: string }).text;
  assert.match(text, /compact table/);
  const embedded = JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
  const viaTool = rows(await call(client, 'get_health_metrics', { metric: 'protein', start_date: '2026-09-26' }));
  assert.deepEqual(embedded, viaTool);
  assert.deepEqual(embedded.days[0], { date: '2026-09-26', protein_g: 77.5 });

  await assert.rejects(client.getPrompt({ name: 'get_health_metrics', arguments: { metric: 'steps' } }), /Unknown metric/);
  await client.close();
});

test('all 8 tools have a matching prompt; Oura prompts embed the same data as the tools', async () => {
  const { connect } = setup();
  const client = await connect('auto');
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), [
    'delete_reading', 'get_activity', 'get_health_metrics', 'get_heart_rate', 'get_readiness', 'get_sleep', 'get_workouts', 'log_reading',
  ]);
  const embedded = (r: { messages: { content: unknown }[] }) => {
    const text = (r.messages[0].content as { text: string }).text;
    return JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
  };
  for (const name of ['get_sleep', 'get_heart_rate', 'get_readiness', 'get_activity']) {
    const viaPrompt = embedded(await client.getPrompt({ name, arguments: { range: '2026-09-25 2026-09-26' } }));
    const viaTool = rows(await call(client, name, { start_date: '2026-09-25', end_date: '2026-09-26' }));
    assert.deepEqual(viaPrompt, viaTool, name);
  }
  await assert.rejects(client.getPrompt({ name: 'get_heart_rate', arguments: { range: '60d' } }), /1–31 days/);
  await client.close();
});

test('log_reading and delete_reading prompts only pre-fill requests; they never write', async () => {
  const { connect, health } = setup();
  const client = await connect('auto');
  const text = async (name: string, args: Record<string, string>) =>
    ((await client.getPrompt({ name, arguments: args })).messages[0].content as { text: string }).text;

  const log = await text('log_reading', { metric: 'Glucose', value: '94', time: '07:30', context: 'fasting' });
  assert.match(log, /log_reading tool/);
  assert.match(log, /metric: glucose\n- value: 94\n- unit: mg\/dL\n- timestamp: 07:30\n- context: fasting/);
  assert.match(await text('log_reading', { metric: 'ketones', value: '1.3' }), /unit: mmol\/L\n- timestamp: now/);
  await assert.rejects(client.getPrompt({ name: 'log_reading', arguments: { metric: 'insulin', value: '4' } }), /glucose or ketones/);
  await assert.rejects(client.getPrompt({ name: 'log_reading', arguments: { metric: 'glucose', value: 'high' } }), /not a number/);

  assert.match(await text('delete_reading', { metric: 'glucose', timestamp: '2026-09-27T07:30:00-07:00' }), /delete_reading tool/);
  assert.match(await text('delete_reading', {}), /ask me which one to remove/);
  assert.equal(health.rows.size, 0, 'fetching prompts wrote nothing');
  await client.close();
});
