#!/usr/bin/env node
// Copies every item from a point-in-time-restored table back into the live health table.
//   node scripts/pitr-copy.mjs --from <restored-table> --to <live-table> [--prune] [--dry-run]
// Items with the same key are overwritten with the restored version. With --prune, live items
// that are not in the restored table (written after the restore point) are deleted, which makes
// the live table an exact copy of the snapshot. --dry-run only reports what would change.
import { BatchWriteItemCommand, DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg('--from');
const to = arg('--to');
const prune = process.argv.includes('--prune');
const dryRun = process.argv.includes('--dry-run');
if (!from || !to) {
  console.error('usage: node scripts/pitr-copy.mjs --from <restored-table> --to <live-table> [--prune] [--dry-run]');
  process.exit(2);
}

const ddb = new DynamoDBClient({});
const keyOf = (item) => `${item.metric.S}|${item.ts.S}`;

async function scanAll(table) {
  const items = [];
  let start;
  do {
    const out = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }));
    items.push(...(out.Items ?? []));
    start = out.LastEvaluatedKey;
  } while (start);
  return items;
}

async function write(requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt > 6) throw new Error(`${pending.length} writes left unprocessed after retries`);
      if (attempt) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      const out = await ddb.send(new BatchWriteItemCommand({ RequestItems: { [to]: pending } }));
      pending = out.UnprocessedItems?.[to] ?? [];
    }
  }
}

const [source, live] = await Promise.all([scanAll(from), scanAll(to)]);
const sourceKeys = new Set(source.map(keyOf));
const extra = live.filter((item) => !sourceKeys.has(keyOf(item)));
console.log(`${from}: ${source.length} items; ${to}: ${live.length} items; ${extra.length} live items are not in the snapshot.`);

if (dryRun) {
  console.log(`Dry run: would write ${source.length} items${prune ? ` and delete ${extra.length}` : ''} in ${to}.`);
  process.exit(0);
}
await write(source.map((Item) => ({ PutRequest: { Item } })));
console.log(`Wrote ${source.length} items into ${to}.`);
if (prune) {
  await write(extra.map((item) => ({ DeleteRequest: { Key: { metric: item.metric, ts: item.ts } } })));
  console.log(`Deleted ${extra.length} items that were written after the restore point.`);
}
