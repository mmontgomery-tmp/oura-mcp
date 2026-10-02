import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncHaeRows } from '../src/sync.ts';
import { parseHaeWorkouts, type WorkoutRow } from '../src/workouts.ts';
import { memoryHealthStore } from './fakes.ts';
import { rows, setup } from './harness.ts';

// Workouts arrive from a separate Health Auto Export "Workouts" automation as data.workouts. The
// shapes below follow HAE's Export Version 2 documentation and its reference server. All values
// are invented, and everything runs against the in-memory store.

const TZ = 'America/Los_Angeles';

/** A ride as Export Version 2 documents it. */
function ride(day: string, opts: { id?: string; start?: string; minutes?: number; kcal?: number; avg?: number; max?: number; extra?: Record<string, unknown> } = {}) {
  const start = opts.start ?? '07:00:00';
  const minutes = opts.minutes ?? 30;
  const [h, m, s] = start.split(':').map(Number);
  const total = h * 3600 + m * 60 + s + minutes * 60;
  const end = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map((n) => String(n).padStart(2, '0')).join(':');
  return {
    id: opts.id ?? `ride-${day}-${start}`,
    name: 'Indoor Cycling',
    start: `${day} ${start} -0700`,
    end: `${day} ${end} -0700`,
    duration: minutes * 60,
    isIndoor: true,
    activeEnergyBurned: { qty: opts.kcal ?? 320, units: 'kcal' },
    avgHeartRate: { qty: opts.avg ?? 142, units: 'bpm' },
    maxHeartRate: { qty: opts.max ?? 168, units: 'bpm' },
    heartRateData: [{ date: `${day} ${start} -0700`, Min: 118, Avg: 140, Max: 165, units: 'bpm', source: 'Chest Strap' }],
    activeEnergy: [{ date: `${day} ${start} -0700`, qty: 11, units: 'kcal', source: 'Bike App' }],
    ...opts.extra,
  };
}
const parse = (workouts: unknown[], now = new Date('2026-10-10T19:00:00Z')) => parseHaeWorkouts({ data: { workouts } }, { timeZone: TZ, now })!;

function harness() {
  const store = memoryHealthStore();
  const T0 = Date.parse('2026-10-10T19:00:00Z'); // 12:00 in Los Angeles; full days inside: Oct 4-9
  const push = (workouts: unknown[], minutes: number, period = 'Previous 7 Days') => {
    const now = new Date(T0 + minutes * 60_000);
    const parsed = parse(workouts, now);
    return syncHaeRows<WorkoutRow>(
      { query: (_m, from, to) => store.queryWorkouts(from, to), writeRows: (r) => store.writeRows(r) },
      parsed.rows,
      { now, timeZone: TZ, period, acceptedByMetric: { workout: parsed.accepted }, guard: 'window' },
    );
  };
  const all = () => [...store.workouts.values()];
  const active = () => all().filter((w) => !w.superseded_at).map((w) => w.hae_id).sort();
  return { store, push, all, active };
}

test('a Version 2 workout: type, start, end, duration, active energy, heart rate and source', () => {
  const parsed = parse([ride('2026-10-07')]);
  assert.deepEqual([parsed.received, parsed.accepted, parsed.skipped], [1, 1, 0]);
  const { ts, ingested_at, ...row } = parsed.rows[0];
  assert.match(ts, /^2026-10-07T14:00:00Z#[0-9a-f]{12}$/, 'start as a UTC second + fingerprint of the id');
  assert.deepEqual(row, {
    metric: 'workout',
    name: 'Indoor Cycling',
    start: '2026-10-07T14:00:00Z',
    end: '2026-10-07T14:30:00Z',
    duration_s: 1800,
    active_kcal: 320,
    avg_hr_bpm: 142,
    max_hr_bpm: 168,
    source: 'Bike App', // no source on the workout itself: taken from its active-energy series
    hae_id: 'ride-2026-10-07-07:00:00',
    via: 'hae',
    recorded_at: '2026-10-07 07:00:00 -0700',
    recorded_end: '2026-10-07 07:30:00 -0700',
  });
  assert.deepEqual(parsed.types, { 'Indoor Cycling': 1 });
  assert.ok(parsed.fields.includes('avgHeartRate') && parsed.fields.includes('id'));
});

test('optional fields: fallbacks for energy, heart rate and source; kJ is converted', () => {
  const base = { id: 'w', name: 'Indoor Cycling', start: '2026-10-07 07:00:00 -0700', end: '2026-10-07 07:30:00 -0700', duration: 1800 };
  const one = (extra: Record<string, unknown>) => parse([{ ...base, ...extra }]).rows[0];

  const bare = one({});
  assert.deepEqual([bare.active_kcal, bare.avg_hr_bpm, bare.max_hr_bpm, bare.source], [undefined, undefined, undefined, 'unknown']);
  assert.equal(one({ source: 'Bike App', activeEnergy: [{ qty: 1, units: 'kcal', source: 'Watch' }] }).source, 'Bike App', 'a top-level source wins');
  assert.equal(one({ heartRateData: [{ Avg: 140, Max: 160, source: 'Chest Strap' }] }).source, 'Chest Strap', 'else any series');

  assert.equal(one({ activeEnergyBurned: { qty: 1338.9, units: 'kJ' } }).active_kcal, 320);
  assert.equal(one({ activeEnergy: { qty: 300, units: 'kcal' } }).active_kcal, 300, 'Version 1 sends one object');
  assert.equal(one({ activeEnergy: [{ qty: 100.2, units: 'kcal' }, { qty: 50.1, units: 'kcal' }] }).active_kcal, 150.3, 'else the series is summed');

  const fromObject = one({ heartRate: { min: { qty: 110, units: 'bpm' }, avg: { qty: 141.6, units: 'bpm' }, max: { qty: 170, units: 'bpm' } } });
  assert.deepEqual([fromObject.avg_hr_bpm, fromObject.max_hr_bpm], [142, 170]);
  const fromSeries = one({ heartRateData: [{ Min: 100, Avg: 130, Max: 150 }, { Min: 120, Avg: 150, Max: 172 }] });
  assert.deepEqual([fromSeries.avg_hr_bpm, fromSeries.max_hr_bpm], [140, 172]);
});

test('Version 1 (no id or duration), Oura-sourced and malformed workouts', () => {
  const v1 = { name: 'Running', start: '2026-10-07 06:00:00 -0700', end: '2026-10-07 06:25:30 -0700', activeEnergy: { qty: 250, units: 'kcal' } };
  const parsed = parse([
    v1,
    { ...ride('2026-10-07', { id: 'oura-1' }), source: 'Oura' },
    { id: 'no-times', name: 'Yoga' },
    { id: 'backwards', name: 'Yoga', start: '2026-10-07 08:00:00 -0700', end: '2026-10-07 07:00:00 -0700' },
    'not a workout',
  ]);
  assert.deepEqual([parsed.received, parsed.accepted, parsed.skipped], [5, 1, 4]);
  assert.deepEqual(parsed.skipped_reasons, { oura_source: 1, invalid_workout: 3 });
  const row = parsed.rows[0];
  assert.deepEqual([row.name, row.duration_s, row.active_kcal, row.hae_id], ['Running', 1530, 250, undefined]);
  // Without an id the key comes from source, type and end, so a re-send still lands on the same row.
  assert.equal(parse([v1]).rows[0].ts, row.ts);

  assert.equal(parseHaeWorkouts({ data: { metrics: [] } }, { timeZone: TZ, now: new Date() }), undefined, 'a Health Metrics push has no workouts list');
});

test('re-sends are stored once; the same workout with updated numbers is rewritten in place', async () => {
  const { push, all } = harness();
  const week = [ride('2026-10-05'), ride('2026-10-06'), ride('2026-10-07')];
  assert.deepEqual(await push(week, 0).then((r) => [r.written, r.unchanged]), [3, 0]);
  assert.deepEqual(await push(week, 5).then((r) => [r.written, r.unchanged, r.pending]), [0, 3, 0]);

  const updated = [week[0], week[1], ride('2026-10-07', { kcal: 345, max: 171 })]; // same id, final numbers
  assert.deepEqual(await push(updated, 10).then((r) => [r.written, r.unchanged, r.pending]), [1, 2, 0]);
  assert.equal(all().length, 3);
  assert.deepEqual(all().map((w) => w.active_kcal), [320, 320, 345]);
});

test('an edited workout (new id) and a deleted one retire after two pushes 15+ minutes apart', async () => {
  const { push, all, active } = harness();
  const mon = ride('2026-10-05', { id: 'mon' });
  const tue = ride('2026-10-06', { id: 'tue' });
  const wed = ride('2026-10-07', { id: 'wed' });
  const thu = ride('2026-10-08', { id: 'thu' });
  await push([mon, tue, wed, thu], 0);

  // Wednesday's ride is trimmed in Apple Health (deleted and rewritten); Thursday's is deleted.
  const wedEdited = ride('2026-10-07', { id: 'wed-2', minutes: 25 });
  let r = await push([mon, tue, wedEdited], 5);
  assert.deepEqual([r.written, r.pending, r.superseded, r.skipped_days.length], [1, 2, 0, 0], '2 of 5 is not more than half of the window');
  assert.deepEqual(active(), ['mon', 'thu', 'tue', 'wed', 'wed-2'], 'both still count until a later push confirms');

  r = await push([mon, tue, wedEdited], 12); // 7 minutes later: too soon
  assert.deepEqual([r.pending, r.superseded], [0, 0]);
  r = await push([mon, tue, wedEdited], 21); // 16 minutes later: confirmed
  assert.equal(r.superseded, 2);
  assert.deepEqual(active(), ['mon', 'tue', 'wed-2']);
  assert.equal(all().length, 5, 'nothing is deleted');

  // A deleted workout that shows up again is un-marked.
  r = await push([mon, tue, wedEdited, thu], 40);
  assert.equal(r.restored, 1);
  assert.deepEqual(active(), ['mon', 'thu', 'tue', 'wed-2']);
});

test('a push with no workouts, or with most of the window missing, retires nothing', async () => {
  const { push, all } = harness();
  const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map((d) => ride(d, { id: d }));
  await push(week, 0);

  for (const minutes of [5, 25]) {
    const r = await push([], minutes); // the workouts query failed (locked phone), or returned nothing
    assert.ok(!r.reconciled.includes('workout'));
    assert.deepEqual([r.pending, r.superseded], [0, 0]);
  }
  for (const minutes of [45, 65, 85]) {
    const r = await push([week[0]], minutes); // 3 of 4 gone at once: skipped, however often it repeats
    assert.deepEqual(r.skipped_days, [{ metric: 'workout', day: '2026-10-04..2026-10-09', missing: 3, total: 4 }]);
    assert.deepEqual([r.pending, r.superseded], [0, 0]);
  }
  for (const period of ['Since Last Sync', '']) {
    const r = await push([week[0], week[1], week[2]], 100, period);
    assert.deepEqual([r.reconcile, r.pending], ['off', 0]);
  }
  assert.ok(all().every((w) => !w.missing_since && !w.superseded_at));
});

test('"Today" pushes reconcile today\'s workouts; workouts at the window edges are left alone', async () => {
  const { push, active } = harness();
  const today = ride('2026-10-10', { id: 'am', start: '06:00:00' });
  const second = ride('2026-10-10', { id: 'pm', start: '10:00:00' });
  const oldest = ride('2026-10-03', { id: 'oldest' });
  const inside = ride('2026-10-06', { id: 'inside' });
  await push([oldest, inside], 0);
  await push([today, second], 1, 'Today');

  // The 7-day push never lists today, and its oldest day may be partial: neither is marked.
  let r = await push([inside], 5);
  assert.deepEqual([r.pending, r.superseded], [0, 0]);

  r = await push([today], 10, 'Today'); // the second ride was deleted: 1 of 2 today
  assert.deepEqual([r.reconcile, r.pending], ['on', 1]);
  r = await push([today], 30, 'Today');
  assert.equal(r.superseded, 1);
  assert.deepEqual(active(), ['am', 'inside', 'oldest']);
});

test('end to end: a Workouts push through the ingest endpoint, then get_workouts and its prompt', async () => {
  const { ingest, connect, health, logs } = setup(); // the Lambda clock is 2026-09-27 11:00 in Los Angeles
  const send = (workouts: unknown[], period = 'Previous 7 Days') =>
    ingest({ data: { workouts } }, { headers: { 'automation-period': period, 'automation-name': 'Workouts' } }).then(
      (res) => res.json() as Promise<{ accepted: number; workouts: Record<string, unknown> }>,
    );
  const fri = ride('2026-09-25', { id: 'fri', minutes: 45, kcal: 480.4, avg: 150, max: 176 });
  const satAm = ride('2026-09-26', { id: 'sat-am', minutes: 30, kcal: 320 });
  const satPm = { id: 'sat-pm', name: 'Walking', start: '2026-09-26 17:15:00 -0700', end: '2026-09-26 17:45:00 -0700', duration: 1800, source: 'Watch' };
  const lateFri = ride('2026-09-25', { id: 'late', start: '23:50:00', minutes: 20, kcal: 150, extra: { end: '2026-09-26 00:10:00 -0700' } }); // ends after midnight

  const first = await send([fri, satAm, satPm, lateFri, { ...ride('2026-09-24'), source: 'Oura Ring' }]);
  assert.equal(first.accepted, 0, 'no health-metric samples in a Workouts push');
  assert.deepEqual(first.workouts, {
    received: 5, accepted: 4, skipped: 1, skipped_reasons: { oura_source: 1 },
    rows_written: 4, rows_unchanged: 0, reconcile: 'on', marked_missing: 0, superseded: 0, restored: 0,
  });
  const again = await send([fri, satAm, satPm, lateFri]);
  assert.deepEqual([again.workouts.rows_written, again.workouts.rows_unchanged], [0, 4]);
  assert.equal(health.rows.size, 0, 'workouts are not health readings');
  assert.equal(health.workouts.size, 4);

  // A Health Metrics push (HAE adds an empty workouts list to it) says nothing about workouts.
  const metricsPush = (await (await ingest(
    { data: { metrics: [{ name: 'protein', units: 'g', data: [{ date: '2026-09-26 12:00:00 -0700', qty: 30, source: 'Food App' }] }], workouts: [] } },
    { headers: { 'automation-period': 'Previous 7 Days' } },
  )).json()) as Record<string, unknown>;
  assert.ok(!('workouts' in metricsPush));
  assert.ok([...health.workouts.values()].every((w) => !w.missing_since));

  const client = await connect('auto');
  const out = rows(await client.callTool({ name: 'get_workouts', arguments: { start_date: '2026-09-24', end_date: '2026-09-27' } }));
  assert.deepEqual(out.range, { start: '2026-09-24', end: '2026-09-27' });
  assert.deepEqual(out.workouts, [
    { date: '2026-09-25', start: '07:00', end: '07:45', type: 'Indoor Cycling', duration_min: 45, active_kcal: 480, avg_hr_bpm: 150, max_hr_bpm: 176, source: 'Bike App' },
    { date: '2026-09-25', start: '23:50', end: '00:10', type: 'Indoor Cycling', duration_min: 20, active_kcal: 150, avg_hr_bpm: 142, max_hr_bpm: 168, source: 'Bike App' },
    { date: '2026-09-26', start: '07:00', end: '07:30', type: 'Indoor Cycling', duration_min: 30, active_kcal: 320, avg_hr_bpm: 142, max_hr_bpm: 168, source: 'Bike App' },
    { date: '2026-09-26', start: '17:15', end: '17:45', type: 'Walking', duration_min: 30, source: 'Watch' },
  ]);
  assert.deepEqual(out.days, [
    { date: '2026-09-25', workouts: 2, duration_min: 65, active_kcal: 630 }, // a workout belongs to the day it started
    { date: '2026-09-26', workouts: 2, duration_min: 60, active_kcal: 320 },
  ]);
  assert.deepEqual(out.days_without_workouts, ['2026-09-24', '2026-09-27']);

  // Default range: the last 7 days. More than 92 days is refused.
  assert.deepEqual(rows(await client.callTool({ name: 'get_workouts', arguments: {} })).range, { start: '2026-09-21', end: '2026-09-27' });
  const tooLong = await client.callTool({ name: 'get_workouts', arguments: { start_date: '2026-01-01', end_date: '2026-09-27' } });
  assert.equal(tooLong.isError, true);

  // The prompt embeds exactly what the tool returns.
  const prompt = await client.getPrompt({ name: 'get_workouts', arguments: { range: '2026-09-24 2026-09-27' } });
  const text = (prompt.messages[0].content as { text: string }).text;
  assert.match(text, /one row per workout/);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```'))), out);

  const tool = (await client.listTools()).tools.find((t) => t.name === 'get_workouts')!;
  assert.equal(tool.annotations?.readOnlyHint, true);
  await client.close();

  // The first Workouts payload is logged once, redacted: structure and field names, no numbers.
  const firstLogs = logs.filter((l) => l.msg === 'hae first workout payload (redacted)');
  assert.equal(firstLogs.length, 1);
  const logged = JSON.stringify(firstLogs[0]);
  assert.ok(logged.includes('"avgHeartRate":{"qty":"<number>","units":"bpm"}') && logged.includes('<2 more>'));
  assert.ok(!logged.includes('480.4') && !logged.includes('"qty":320'));
  const line = logs.find((l) => l.msg === 'hae ingest' && l.workout_types)!;
  assert.deepEqual(line.workout_types, { 'Indoor Cycling': 4, Walking: 1 });
  assert.ok((line.workout_fields as string[]).includes('activeEnergyBurned'));
});
