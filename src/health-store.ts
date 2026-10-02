import {
  type AttributeValue,
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { CLAUDE_SOURCE, type HealthRow, type Metric } from './health.ts';
import { WORKOUT, type WorkoutRow } from './workouts.ts';

/** Storage for health rows and workouts (PK metric, SK ts). An in-memory version backs the tests. */
export interface HealthStore {
  /** Upserts rows; the same metric + ts overwrites. Keys must be unique within one call. */
  writeRows(rows: (HealthRow | WorkoutRow)[]): Promise<void>;
  /** Writes a chat reading unless a non-claude-log row already sits at that exact key. */
  putChatReading(row: HealthRow): Promise<{ ok: true } | { ok: false; existing: HealthRow }>;
  /** Deletes only claude-log rows. */
  deleteChatReading(
    metric: Metric,
    ts: string,
  ): Promise<{ kind: 'deleted'; row: HealthRow } | { kind: 'not_found' } | { kind: 'not_claude'; row: HealthRow }>;
  /** Rows with from <= ts <= to (both sort keys). */
  query(metric: Metric, from: string, to: string): Promise<HealthRow[]>;
  /** Workouts (PK "workout") with from <= ts <= to. */
  queryWorkouts(from: string, to: string): Promise<WorkoutRow[]>;
  /**
   * True exactly once per table and kind: gates the one-time redacted log of the first Health
   * Metrics payload and of the first Workouts payload.
   */
  claimFirstPayloadLog(kind?: 'metrics' | 'workouts'): Promise<boolean>;
  /** True for the first caller in each `hour` for this `key` (keeps repeated log lines hourly). */
  claimHourlyLog(key: string, hour: string): Promise<boolean>;
}

// Bookkeeping row outside the metric namespace; never returned by any tool.
export const FIRST_PAYLOAD_MARKER = { metric: '_meta', ts: 'hae-first-payload-logged' } as const;
export const FIRST_WORKOUT_PAYLOAD_MARKER = { metric: '_meta', ts: 'hae-first-workout-payload-logged' } as const;

const NAMES = { '#m': 'metric', '#t': 'ts', '#s': 'source' };
const BATCH = 25; // BatchWriteItem limit
const PARALLEL_BATCHES = 4;

export function dynamoHealthStore(tableName: string, client = new DynamoDBClient({})): HealthStore {
  const TableName = () => {
    if (!tableName) throw new Error('TABLE_NAME is not configured for this function.');
    return tableName;
  };
  const key = (metric: string, ts: string) => ({ metric: { S: metric }, ts: { S: ts } });

  async function writeBatch(requests: WriteRequest[]): Promise<void> {
    let pending = requests;
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt > 0) {
        if (attempt > 6) throw new Error(`DynamoDB left ${pending.length} writes unprocessed after retries.`);
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
      const out = await client.send(new BatchWriteItemCommand({ RequestItems: { [TableName()]: pending } }));
      pending = out.UnprocessedItems?.[TableName()] ?? [];
    }
  }

  async function queryRange<R>(metric: string, from: string, to: string): Promise<R[]> {
    const rows: R[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const out = await client.send(
        new QueryCommand({
          TableName: TableName(),
          KeyConditionExpression: '#m = :m AND #t BETWEEN :from AND :to',
          ExpressionAttributeNames: { '#m': NAMES['#m'], '#t': NAMES['#t'] },
          ExpressionAttributeValues: { ':m': { S: metric }, ':from': { S: from }, ':to': { S: to } },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of out.Items ?? []) rows.push(unmarshal(item) as unknown as R);
      start = out.LastEvaluatedKey;
    } while (start);
    return rows;
  }

  return {
    async writeRows(rows) {
      const requests = rows.map((r): WriteRequest => ({ PutRequest: { Item: marshal(r) } }));
      const batches: WriteRequest[][] = [];
      for (let i = 0; i < requests.length; i += BATCH) batches.push(requests.slice(i, i + BATCH));
      for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
        await Promise.all(batches.slice(i, i + PARALLEL_BATCHES).map(writeBatch));
      }
    },

    async putChatReading(row) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: TableName(),
            Item: marshal(row),
            ConditionExpression: 'attribute_not_exists(#m) OR #s = :claude',
            ExpressionAttributeNames: { '#m': NAMES['#m'], '#s': NAMES['#s'] },
            ExpressionAttributeValues: { ':claude': { S: CLAUDE_SOURCE } },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException && err.Item) return { ok: false, existing: unmarshal(err.Item) };
        throw err;
      }
    },

    async deleteChatReading(metric, ts) {
      try {
        const out = await client.send(
          new DeleteItemCommand({
            TableName: TableName(),
            Key: key(metric, ts),
            ConditionExpression: 'attribute_exists(#m) AND #s = :claude',
            ExpressionAttributeNames: { '#m': NAMES['#m'], '#s': NAMES['#s'] },
            ExpressionAttributeValues: { ':claude': { S: CLAUDE_SOURCE } },
            ReturnValues: 'ALL_OLD',
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        );
        return { kind: 'deleted', row: unmarshal(out.Attributes ?? {}) };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          if (err.Item) return { kind: 'not_claude', row: unmarshal(err.Item) };
          // Apple Health samples at that second live under "<ts>#<fingerprint>" keys.
          const out = await client.send(
            new QueryCommand({
              TableName: TableName(),
              KeyConditionExpression: '#m = :m AND begins_with(#t, :prefix)',
              ExpressionAttributeNames: { '#m': NAMES['#m'], '#t': NAMES['#t'] },
              ExpressionAttributeValues: { ':m': { S: metric }, ':prefix': { S: `${ts}#` } },
              Limit: 1,
            }),
          );
          const hae = out.Items?.[0];
          return hae ? { kind: 'not_claude', row: unmarshal(hae) } : { kind: 'not_found' };
        }
        throw err;
      }
    },

    query: (metric, from, to) => queryRange<HealthRow>(metric, from, to),
    queryWorkouts: (from, to) => queryRange<WorkoutRow>(WORKOUT, from, to),

    async claimHourlyLog(logKey, hour) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: TableName(),
            Item: { ...key('_meta', `hourly-log#${logKey}`), hour: { S: hour }, logged_at: { S: new Date().toISOString() } },
            ConditionExpression: 'attribute_not_exists(#m) OR #h <> :h',
            ExpressionAttributeNames: { '#m': NAMES['#m'], '#h': 'hour' },
            ExpressionAttributeValues: { ':h': { S: hour } },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async claimFirstPayloadLog(kind = 'metrics') {
      const marker = kind === 'workouts' ? FIRST_WORKOUT_PAYLOAD_MARKER : FIRST_PAYLOAD_MARKER;
      try {
        await client.send(
          new PutItemCommand({
            TableName: TableName(),
            Item: { ...key(marker.metric, marker.ts), logged_at: { S: new Date().toISOString() } },
            ConditionExpression: 'attribute_not_exists(#m)',
            ExpressionAttributeNames: { '#m': NAMES['#m'] },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
  };
}

// Rows are flat strings and numbers, so a tiny converter replaces @aws-sdk/lib-dynamodb.
function marshal(row: HealthRow | WorkoutRow): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string') item[k] = { S: v };
    else if (typeof v === 'number' && Number.isFinite(v)) item[k] = { N: String(v) };
  }
  return item;
}

function unmarshal(item: Record<string, AttributeValue>): HealthRow {
  const row: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(item)) {
    if (v.S !== undefined) row[k] = v.S;
    else if (v.N !== undefined) row[k] = Number(v.N);
  }
  return row as unknown as HealthRow;
}
