import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHaePayload } from '../src/hae.ts';
import { parsePromptArgs } from '../src/health-tools.ts';
import { syncHaeRows } from '../src/sync.ts';
import { memoryHealthStore } from './fakes.ts';
import { rows, setup } from './harness.ts';

// Dietary fat arrives from Health Auto Export as "total_fat" (seen in production pushes on
// 2026-09-29, next to saturated_fat, which stays ignored, and fiber). It is stored as "fat" in grams
// and handled exactly like protein and carbs. All of this runs against the in-memory store.

const lunch = '2026-09-26 12:30:00 -0700';
const nutrition = (fat: { qty: number; units?: string; date?: string }[], extra: unknown[] = []) => ({
  data: {
    metrics: [
      { name: 'protein', units: 'g', data: [{ date: lunch, qty: 40, source: 'Cal AI' }] },
      { name: 'carbohydrates', units: 'g', data: [{ date: lunch, qty: 6, source: 'Cal AI' }] },
      ...fat.map((f) => ({ name: 'total_fat', units: f.units ?? 'g', data: [{ date: f.date ?? lunch, qty: f.qty, source: 'Cal AI' }] })),
      { name: 'saturated_fat', units: 'g', data: [{ date: lunch, qty: 9, source: 'Cal AI' }] },
      { name: 'fiber', units: 'g', data: [{ date: lunch, qty: 3, source: 'Cal AI' }] },
      ...extra,
    ],
  },
});
type Summary = { accepted: number; skipped: number; rows_written: number; rows_unchanged: number; skipped_reasons: Record<string, number>; ignored_metrics?: string[] };

test('total_fat is stored as fat in grams; saturated_fat is logged and skipped', async () => {
  const { ingest, health, logs } = setup();
  const res = (await (await ingest(nutrition([{ qty: 28 }, { qty: 1500, units: 'mg', date: '2026-09-26 18:00:00 -0700' }]))).json()) as Summary;
  assert.equal(res.accepted, 5); // protein, carbs, 2 x fat, fiber
  assert.deepEqual(res.skipped_reasons, { unsupported_metric: 1 });
  assert.deepEqual(res.ignored_metrics, ['saturated_fat']);
  const fat = [...health.rows.values()].filter((r) => r.metric === 'fat').sort((a, b) => a.ts.localeCompare(b.ts));
  assert.deepEqual(fat.map((r) => [r.value, r.unit, r.original_unit, r.source]), [[28, 'g', 'g', 'Cal AI'], [1.5, 'g', 'mg', 'Cal AI']]);
  const line = logs.find((l) => l.msg === 'hae ingest')!;
  assert.deepEqual((line.units as Record<string, string>).total_fat, 'mg', 'the unit as sent is logged per metric');
  assert.equal((line.metrics as Record<string, number>).total_fat, 2);
});

test('an unknown fat unit or a malformed metric entry is skipped and reported, never failing the request', async () => {
  const { ingest, health } = setup();
  const res = await ingest(nutrition([{ qty: 1, units: 'oz' }], [null, { name: 42, data: 'nope' }, { units: 'g' }]));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Summary;
  assert.equal(body.skipped_reasons.unknown_unit, 1);
  assert.equal([...health.rows.values()].filter((r) => r.metric === 'fat').length, 0);
  assert.equal(body.accepted, 3, 'protein, carbs and fiber from the same request are still stored');
});

test('a re-sent fat sample is stored once', async () => {
  const { ingest, health } = setup();
  await ingest(nutrition([{ qty: 28 }]));
  const again = (await (await ingest(nutrition([{ qty: 28 }]))).json()) as Summary;
  assert.deepEqual([again.rows_written, again.rows_unchanged], [0, 4]);
  assert.equal([...health.rows.values()].filter((r) => r.metric === 'fat').length, 1);
});

test('fat is reconciled like protein and carbs: an edited entry is superseded after two pushes 15+ minutes apart', async () => {
  const store = memoryHealthStore();
  const T0 = Date.parse('2026-10-10T19:00:00Z'); // Oct 4-9 are the full days inside the window
  const push = async (qty: number[], minutes: number, period = 'Previous 7 Days') => {
    const now = new Date(T0 + minutes * 60_000);
    const p = parseHaePayload({ data: { metrics: [{ name: 'total_fat', units: 'g', data: qty.map((q) => ({ date: '2026-10-07 12:30:00 -0700', qty: q, source: 'Cal AI' })) }] } }, { timeZone: 'America/Los_Angeles', now });
    return syncHaeRows(store, p.rows, { now, timeZone: 'America/Los_Angeles', period, acceptedByMetric: p.accepted_by_metric });
  };
  await push([28, 10], 0);
  assert.equal((await push([28, 12], 5)).pending, 1); // the 10 g entry was edited to 12 g
  assert.equal((await push([28, 12], 21)).superseded, 1);
  assert.deepEqual([...store.rows.values()].filter((r) => !r.superseded_at).map((r) => r.value).sort(), [12, 28]);
  // A "Today" push only reconciles today's rows (Oct 10), so these Oct 7 rows are left alone.
  const today = await push([28], 40, 'Today');
  assert.deepEqual([today.reconcile, today.pending, today.superseded, today.restored], ['on', 0, 0, 0]);
});

test('get_health_metrics: fat_g daily sums, alone and in "all"; delete_reading removes and undo restores a fat entry', async () => {
  const { ingest, connect } = setup();
  await ingest(nutrition([{ qty: 28 }, { qty: 12, date: '2026-09-26 19:00:00 -0700' }]));
  const client = await connect('auto');
  const day = async (metric: string) =>
    rows(await client.callTool({ name: 'get_health_metrics', arguments: { metric, start_date: '2026-09-26', end_date: '2026-09-26' } })).days[0];
  assert.deepEqual(await day('fat'), { date: '2026-09-26', fat_g: 40 });
  assert.deepEqual(await day('all'), { date: '2026-09-26', protein_g: 40, carbs_g: 6, fat_g: 40 });

  const removed = rows(await client.callTool({ name: 'delete_reading', arguments: { metric: 'fat', timestamp: '2026-09-26T19:00' } }));
  assert.equal(removed.removed.value, 12);
  assert.match(removed.note, /delete it there first/);
  assert.equal((await day('fat')).fat_g, 28);
  rows(await client.callTool({ name: 'delete_reading', arguments: { metric: 'fat', timestamp: '2026-09-26T19:00', undo: true } }));
  assert.equal((await day('fat')).fat_g, 40);

  const { tools } = await client.listTools();
  const describe = (name: string) => JSON.stringify(tools.find((t) => t.name === name));
  assert.match(describe('get_health_metrics'), /fat_g/);
  assert.match(describe('get_health_metrics'), /net carbs/);
  assert.match(describe('delete_reading'), /"fat"/);
  await client.close();
});

test('prompt aliases: "total fat" and "net carbs"', () => {
  assert.equal(parsePromptArgs({ metric: 'total fat' }, '2026-09-29').metric, 'fat');
  assert.equal(parsePromptArgs({ metric: 'Net carbs' }, '2026-09-29').metric, 'carbs');
  assert.equal(parsePromptArgs({ metric: 'fat' }, '2026-09-29').metric, 'fat');
});

test('subscriptions/listen is refused at once instead of hanging the Lambda (the Runtime.ExitError crashes)', async () => {
  const { connect } = setup();
  const client = await connect('auto');
  const started = Date.now();
  await assert.rejects(client.listen({ toolsListChanged: true } as never), /Subscription limit reached/);
  assert.ok(Date.now() - started < 2000, 'answered immediately');
  // The connection is still usable afterwards.
  assert.equal((await client.listTools()).tools.length, 8);
  await client.close();
});
