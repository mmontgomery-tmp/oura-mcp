#!/usr/bin/env node
// One-time migration: Apple Health rows stored before sample fingerprints have plain
// "<UTC second>" keys. Re-key each to "<UTC second>#<fingerprint>", exactly the key the same sample
// gets when Health Auto Export re-sends it, so re-sent 7-day windows overwrite instead of
// double-counting. Chat readings (via "chat") keep their plain keys and are not touched.
//   node scripts/migrate-hae-keys.mjs --table <HealthTableName> [--dry-run]
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { haeKeyInputs, haeSortKey } from '../src/health.ts';

const i = process.argv.indexOf('--table');
const table = i > 0 ? process.argv[i + 1] : undefined;
const dryRun = process.argv.includes('--dry-run');
if (!table) {
  console.error('usage: node scripts/migrate-hae-keys.mjs --table <HealthTableName> [--dry-run]');
  process.exit(2);
}

const ddb = new DynamoDBClient({});
const plain = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v.S ?? Number(v.N)]));

const items = [];
let start;
do {
  const out = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }));
  items.push(...(out.Items ?? []));
  start = out.LastEvaluatedKey;
} while (start);

const legacy = items.filter((it) => it.via?.S === 'hae' && !it.ts.S.includes('#'));
// Before fingerprints, same-second food entries were summed into one row ("A + B" sources when
// the apps differed). A summed row cannot be split back into samples, so it is left as is.
const summed = legacy.filter((it) => it.source?.S?.includes(' + '));
const todo = legacy.filter((it) => !summed.includes(it));
console.log(
  `${items.length} rows; ${legacy.length} Apple Health rows with plain keys; ${todo.length} to re-key; ` +
    `${summed.length} summed rows left as is.`,
);

let moved = 0;
let alreadyThere = 0;
for (const item of todo) {
  const row = plain(item);
  const ts = haeSortKey(row.ts, haeKeyInputs(row));
  if (dryRun) {
    console.log(`  ${row.metric.padEnd(8)} ${row.ts} -> ${ts}`);
    continue;
  }
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: table,
        Item: { ...item, ts: { S: ts } },
        ConditionExpression: 'attribute_not_exists(ts)',
      }),
    );
    moved++;
  } catch (err) {
    // A push after the deploy already wrote this sample under its new key.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    alreadyThere++;
  }
  await ddb.send(new DeleteItemCommand({ TableName: table, Key: { metric: item.metric, ts: item.ts } }));
}
if (!dryRun) console.log(`Re-keyed ${moved}; ${alreadyThere} already existed under the new key (old copy removed).`);
