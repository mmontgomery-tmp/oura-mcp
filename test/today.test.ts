import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHaePayload } from '../src/hae.ts';
import { syncHaeRows } from '../src/sync.ts';
import { memoryHealthStore } from './fakes.ts';
import { rows, setup } from './harness.ts';

// "Today" pushes are reconciled like "Previous 7 Days" pushes, for today's rows only. Cal AI
// rewrites an edited entry as a new sample stamped with the edit time, so every round of edits
// leaves the old versions behind. Handling each round the same day keeps them from piling up
// past the more-than-half guard the next morning (for example 4 stale rows out of 7).
// All of this runs against the in-memory store.

const TZ = 'America/Los_Angeles';
const at = (time: string, day = '2026-10-10') => new Date(`${day}T${time}:00-07:00`);
type Sample = { date: string; qty: number; source?: string };
const entry = (time: string, qty: number, day = '2026-10-10'): Sample => ({ date: `${day} ${time} -0700`, qty });

function harness() {
  const store = memoryHealthStore();
  const push = (metrics: Record<string, Sample[]>, now: Date, period = 'Today') => {
    const body = {
      data: {
        metrics: Object.entries(metrics).map(([name, data]) => ({
          name,
          units: name === 'weight_body_mass' ? 'lb' : 'g',
          data: data.map((s) => ({ source: 'Cal AI', ...s })),
        })),
      },
    };
    const parsed = parseHaePayload(body, { timeZone: TZ, now });
    return syncHaeRows(store, parsed.rows, { now, timeZone: TZ, period, acceptedByMetric: parsed.accepted_by_metric });
  };
  const all = (metric = 'protein') => [...store.rows.values()].filter((r) => r.metric === metric);
  const active = (metric = 'protein') => all(metric).filter((r) => !r.superseded_at).map((r) => r.value!).sort((a, b) => a - b);
  return { store, push, all, active };
}

// Three versions of lunch and dinner, plus one entry that is never edited.
const L1 = entry('12:10:05', 30), L2 = entry('16:40:10', 31), L3 = entry('17:58:13', 32);
const D1 = entry('15:10:30', 20), D2 = entry('16:40:22', 21), D3 = entry('17:58:20', 22);
const OTHER = entry('17:05:21', 12);

test('one round of same-day edits is retired the same day, after two "Today" pushes 15+ minutes apart', async () => {
  const { push, all, active } = harness();
  await push({ protein: [L1, D1] }, at('16:15'));

  let r = await push({ protein: [L2, D2] }, at('16:43')); // both entries edited in Cal AI
  assert.deepEqual([r.reconcile, r.written, r.pending, r.superseded], ['on', 2, 2, 0]);
  assert.deepEqual(r.skipped_days, [], '2 of 4 is not more than half');
  assert.deepEqual(active(), [20, 21, 30, 31], 'the old versions still count until a later push confirms');

  r = await push({ protein: [L2, D2] }, at('16:50')); // 7 minutes later: too soon
  assert.deepEqual([r.pending, r.superseded], [0, 0]);
  r = await push({ protein: [L2, D2] }, at('16:59')); // 16 minutes later: confirmed
  assert.equal(r.superseded, 2);
  assert.deepEqual(active(), [21, 31]);
  assert.equal(all().length, 4, 'nothing is deleted');
});

test('three rounds of same-day edits are each retired as they happen', async () => {
  const { push, active } = harness();
  await push({ protein: [L1] }, at('14:20'));
  await push({ protein: [L1, D1] }, at('16:15'));

  let r = await push({ protein: [L2, D2] }, at('16:43')); // round 1
  assert.deepEqual([r.pending, r.skipped_days.length], [2, 0]);
  r = await push({ protein: [L2, D2, OTHER] }, at('17:25'));
  assert.equal(r.superseded, 2);
  assert.deepEqual(active(), [12, 21, 31]);

  r = await push({ protein: [L3, D3, OTHER] }, at('18:01')); // round 2: 2 of 5
  assert.deepEqual([r.pending, r.skipped_days.length], [2, 0]);
  r = await push({ protein: [L3, D3, OTHER] }, at('18:20'));
  assert.equal(r.superseded, 2);
  assert.deepEqual(active(), [12, 22, 32]);

  const L4 = entry('19:30:00', 33);
  r = await push({ protein: [L4, D3, OTHER] }, at('19:31')); // round 3: 1 of 4
  assert.deepEqual([r.pending, r.skipped_days.length], [1, 0]);
  r = await push({ protein: [L4, D3, OTHER] }, at('19:50'));
  assert.equal(r.superseded, 1);
  assert.deepEqual(active(), [12, 22, 33], 'only the current version of each entry counts');

  // The next morning's 7-day push finds nothing left to do for that day.
  r = await push({ protein: [L4, D3, OTHER] }, at('09:03', '2026-10-11'), 'Previous 7 Days');
  assert.deepEqual([r.written, r.pending, r.superseded, r.restored, r.skipped_days.length], [0, 0, 0, 0, 0]);
});

test('rounds of edits faster than the confirmation: rows already marked missing are not counted again', async () => {
  const { push, active } = harness();
  await push({ protein: [L1, D1] }, at('16:15'));
  let r = await push({ protein: [L2, D2] }, at('16:43')); // L1 and D1 marked missing
  assert.equal(r.pending, 2);

  // Edited again 8 minutes later. Four stored rows are absent from this push and two are new:
  // counting all four would be 4 of 6, more than half. Only the two newly missing ones count.
  const L3b = entry('16:50:00', 32), D3b = entry('16:50:05', 22);
  r = await push({ protein: [L3b, D3b] }, at('16:51'));
  assert.deepEqual(r.skipped_days, []);
  assert.deepEqual([r.pending, r.superseded], [2, 0], 'L2 and D2 are marked; L1 and D1 are 8 minutes in');

  r = await push({ protein: [L3b, D3b] }, at('17:00'));
  assert.deepEqual([r.pending, r.superseded], [0, 2], 'L1 and D1, 17 minutes after their first miss');
  r = await push({ protein: [L3b, D3b] }, at('17:07'));
  assert.equal(r.superseded, 2, 'L2 and D2');
  assert.deepEqual(active(), [22, 32]);
});

test('a "Today" push from a locked phone that omits a metric retires nothing', async () => {
  const { push, all, active } = harness();
  const weight = [{ date: '2026-10-10 07:05:00 -0700', qty: 180.2, source: 'Health' }];
  await push({ protein: [L1, D1, OTHER], weight_body_mass: weight }, at('17:30'));

  const partial: Record<string, Sample[]>[] = [
    { weight_body_mass: weight }, // protein left out entirely
    { weight_body_mass: weight, protein: [] }, // present but empty
    {}, // nothing at all
  ];
  for (const [i, metrics] of partial.entries()) {
    for (const minutes of [0, 20]) {
      const r = await push(metrics, at(`${18 + i}:${minutes === 0 ? '00' : '20'}`));
      assert.ok(!r.reconciled.includes('protein'));
      assert.deepEqual([r.pending, r.superseded], [0, 0]);
    }
  }
  // Most of today's entries missing: skipped by the more-than-half guard, however often it repeats.
  for (const time of ['21:00', '21:20', '21:40']) {
    const r = await push({ protein: [OTHER] }, at(time));
    assert.deepEqual(r.skipped_days, [{ metric: 'protein', day: '2026-10-10', missing: 2, total: 3 }]);
    assert.deepEqual([r.pending, r.superseded], [0, 0]);
  }
  assert.deepEqual(active(), [12, 20, 30]);
  assert.ok(all().concat(all('weight')).every((x) => !x.missing_since && !x.superseded_at));
});

test('a "Today" push only touches today: earlier days and other periods are left alone', async () => {
  const { push, all } = harness();
  const yesterday = [entry('12:00:00', 20, '2026-10-09'), entry('18:00:00', 21, '2026-10-09')];
  await push({ protein: yesterday }, at('20:00', '2026-10-09'));
  await push({ protein: [L1] }, at('14:20'));
  for (const time of ['14:30', '15:00']) {
    const r = await push({ protein: [L1] }, at(time));
    assert.deepEqual([r.reconcile, r.pending, r.superseded], ['on', 0, 0], "yesterday's rows are not in a Today push, and not missing");
  }
  const r = await push({ protein: [] }, at('15:20'), 'Since Last Sync');
  assert.equal(r.reconcile, 'off');
  assert.ok(all().every((x) => !x.missing_since && !x.superseded_at));
});

test('a "Today" push from another time zone is not reconciled (its "today" starts at a different midnight)', async () => {
  const { push, all } = harness();
  await push({ protein: [L1, D1, OTHER] }, at('17:30'));
  // 21:10 in Los Angeles is 00:10 the next day in New York: the phone's "Today" holds only this.
  const lateSnack = { date: '2026-10-11 00:05:00 -0400', qty: 8 };
  for (const time of ['21:10', '21:30']) {
    const r = await push({ protein: [lateSnack] }, at(time));
    assert.deepEqual([r.reconcile, r.note, r.pending, r.superseded], ['off', 'phone is in another time zone', 0, 0]);
  }
  assert.equal(all().length, 4, 'the new sample is still stored');
  assert.ok(all().every((x) => !x.missing_since && !x.superseded_at));
});

test("across midnight: yesterday's rows stay correct when the 7-day push picks the day up", async () => {
  const { push, all, active } = harness();
  await push({ protein: [L1, D1] }, at('16:15'));
  await push({ protein: [L2, D2] }, at('16:43'));
  await push({ protein: [L2, D2] }, at('17:00')); // L1 and D1 retired the same day
  assert.deepEqual(active(), [21, 31]);

  const D4 = entry('23:48:00', 23); // dinner edited again just before midnight
  let r = await push({ protein: [L2, D4] }, at('23:50'));
  assert.deepEqual([r.written, r.pending], [1, 1], 'D2 is marked, with no second "Today" push left today');
  assert.deepEqual(active(), [21, 23, 31]);

  // After midnight "Today" is a new day: its pushes no longer say anything about Oct 10.
  const breakfast = entry('00:05:00', 9, '2026-10-11');
  r = await push({ protein: [breakfast] }, at('00:10', '2026-10-11'));
  assert.deepEqual([r.reconcile, r.pending, r.superseded, r.restored], ['on', 0, 0, 0]);
  assert.deepEqual(active(), [9, 21, 23, 31]);

  // The 7-day push now covers Oct 10 as a full day and finishes the job.
  r = await push({ protein: [L2, D4] }, at('00:12', '2026-10-11'), 'Previous 7 Days');
  assert.deepEqual([r.written, r.unchanged, r.superseded, r.restored, r.skipped_days.length], [0, 2, 1, 0, 0]);
  assert.deepEqual(active(), [9, 23, 31], 'Oct 10: lunch 31 + dinner 23; Oct 11: breakfast 9');
  assert.equal(all().filter((x) => x.superseded_at).length, 3, 'L1, D1 and D2 stay retired');

  // A row a "Today" push marked by mistake is un-marked when the 7-day push still has it.
  const { push: push2, all: all2 } = harness();
  await push2({ protein: [L1, D1, OTHER] }, at('17:30'));
  r = await push2({ protein: [L1, D1] }, at('23:55')); // OTHER missing from one push
  assert.equal(r.pending, 1);
  r = await push2({ protein: [L1, D1, OTHER] }, at('00:12', '2026-10-11'), 'Previous 7 Days');
  assert.deepEqual([r.restored, r.superseded], [1, 0]);
  assert.ok(all2().every((x) => !x.missing_since && !x.superseded_at));
});

test('end to end: the ingest endpoint reconciles a "Today" push and get_health_metrics follows', async () => {
  // The Lambda test clock only accepts dates before 2010.
  const { ingest, connect } = setup();
  const send = (protein: Sample[], time: string) =>
    ingest({ data: { metrics: [{ name: 'protein', units: 'g', data: protein.map((s) => ({ source: 'Cal AI', ...s })) }] } }, {
      headers: { 'automation-period': 'Today', 'x-smoke-test-now': `2001-02-10T${time}:00-08:00` },
    }).then((res) => res.json() as Promise<{ reconcile: string; marked_missing: number; superseded: number }>);
  const lunch = { date: '2001-02-10 12:30:00 -0800', qty: 40 };
  const lunchEdited = { date: '2001-02-10 13:10:00 -0800', qty: 45 };
  const snack = { date: '2001-02-10 15:00:00 -0800', qty: 10 };

  await send([lunch], '12:35');
  const edited = await send([lunchEdited], '13:11');
  assert.deepEqual([edited.reconcile, edited.marked_missing, edited.superseded], ['on', 1, 0]);
  const client = await connect('auto');
  const total = async () =>
    rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric: 'protein', start_date: '2001-02-10', end_date: '2001-02-10' } })).days[0].protein_g;
  assert.equal(await total(), 85, 'both versions count until the second push');
  const confirmed = await send([lunchEdited, snack], '15:05');
  assert.equal(confirmed.superseded, 1);
  assert.equal(await total(), 55, '45 + 10; the replaced 40 g is ignored');
  await client.close();
});

test('the test clock header is refused unless the deployment allows it', async () => {
  const { ingest, health } = setup({ allowTestClock: false });
  const res = await ingest({ data: { metrics: [{ name: 'protein', units: 'g', data: [{ date: '2001-02-10 12:30:00 -0800', qty: 40, source: 'Cal AI' }] }] } }, {
    headers: { 'automation-period': 'Today', 'x-smoke-test-now': '2001-02-10T12:35:00-08:00' },
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /test clock is off/);
  assert.equal(health.rows.size, 0, 'nothing is stored');
});
