import { CLAUDE_SOURCE, type HealthRow } from '../src/health.ts';
import type { HealthStore } from '../src/health-store.ts';
import type { SecretStore } from '../src/store.ts';

export function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string>; puts: number } {
  const data = new Map(Object.entries(initial));
  const store = {
    data,
    puts: 0,
    async get(name: string) {
      await tick();
      return data.get(name);
    },
    async put(name: string, value: string) {
      await tick();
      store.puts++;
      data.set(name, value);
    },
  };
  return store;
}

const tick = () => new Promise((r) => setTimeout(r, 2));

export const PATH_SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
export const INGEST_SECRET = 'ingest-secret-0123456789abcdefghijklmnopqrstuvwxyz';
export const INGEST_KEY = 'ingest-key-0123456789abcdefghijklmnopqrstuvwxyz0123';
export const PARAMS = {
  pathSecret: '/oura-mcp/path-secret',
  oauthClient: '/oura-mcp/oauth-client',
  tokens: '/oura-mcp/tokens',
  ingestPathSecret: '/oura-mcp/ingest-path-secret',
  ingestKey: '/oura-mcp/ingest-key',
};

/** In-memory HealthStore with the same conditions as the DynamoDB one. */
export function memoryHealthStore(): HealthStore & {
  rows: Map<string, HealthRow>;
  markerClaims: number;
  writes: number;
  hourlyLogs: Map<string, string>;
} {
  const rows = new Map<string, HealthRow>();
  const k = (metric: string, ts: string) => `${metric}|${ts}`;
  const copy = (r: HealthRow) => structuredClone(r);
  let claimed = false;
  const store = {
    rows,
    markerClaims: 0,
    writes: 0,
    async writeRows(list: HealthRow[]) {
      const seen = new Set<string>();
      for (const r of list) {
        // DynamoDB rejects a BatchWriteItem that repeats a key.
        if (seen.has(k(r.metric, r.ts))) throw new Error('ValidationException: Provided list of item keys contains duplicates');
        seen.add(k(r.metric, r.ts));
        rows.set(k(r.metric, r.ts), copy(r));
      }
      store.writes += list.length;
    },
    async putChatReading(row: HealthRow) {
      const existing = rows.get(k(row.metric, row.ts));
      if (existing && existing.source !== CLAUDE_SOURCE) return { ok: false as const, existing: copy(existing) };
      rows.set(k(row.metric, row.ts), copy(row));
      return { ok: true as const };
    },
    async deleteChatReading(metric: string, ts: string) {
      const existing = rows.get(k(metric, ts));
      if (!existing) {
        const hae = [...rows.values()].find((r) => r.metric === metric && r.ts.startsWith(`${ts}#`));
        return hae ? { kind: 'not_claude' as const, row: copy(hae) } : { kind: 'not_found' as const };
      }
      if (existing.source !== CLAUDE_SOURCE) return { kind: 'not_claude' as const, row: copy(existing) };
      rows.delete(k(metric, ts));
      return { kind: 'deleted' as const, row: existing };
    },
    async query(metric: string, from: string, to: string) {
      return [...rows.values()].filter((r) => r.metric === metric && r.ts >= from && r.ts <= to).sort((a, b) => a.ts.localeCompare(b.ts)).map(copy);
    },
    hourlyLogs: new Map<string, string>(),
    async claimHourlyLog(key: string, hour: string) {
      if (store.hourlyLogs.get(key) === hour) return false;
      store.hourlyLogs.set(key, hour);
      return true;
    },
    async claimFirstPayloadLog() {
      if (claimed) return false;
      claimed = true;
      store.markerClaims++;
      return true;
    },
  };
  return store;
}
export const CLIENT = JSON.stringify({ client_id: 'cid', client_secret: 'csecret' });

/**
 * A fake Oura with single-use refresh tokens: each refresh token works exactly once,
 * like the real API. `valid` holds access tokens the API accepts.
 */
export function fakeOura(opts: { data?: Record<string, unknown[]>; latencyMs?: number } = {}) {
  const valid = new Set<string>();
  const liveRefresh = new Set<string>();
  const calls: { collection: string; params: Record<string, string> }[] = [];
  const tokenHosts: string[] = [];
  let refreshes = 0;
  let seq = 0;

  function issue() {
    seq++;
    const pair = { access_token: `at-${seq}`, refresh_token: `rt-${seq}` };
    valid.add(pair.access_token);
    liveRefresh.add(pair.refresh_token);
    return pair;
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    await new Promise((r) => setTimeout(r, opts.latencyMs ?? 1));
    if (url.pathname === '/oauth/token' || url.pathname === '/oauth/v2/ext/oauth-token') {
      tokenHosts.push(url.host);
      const form = new URLSearchParams(String(init?.body));
      const rt = form.get('refresh_token') ?? '';
      if (form.get('client_secret') !== 'csecret') return json(401, { error: 'invalid_client' });
      if (!liveRefresh.delete(rt)) return json(400, { error: 'invalid_grant' });
      refreshes++;
      return json(200, { ...issue(), token_type: 'bearer', expires_in: 86_400 });
    }
    const auth = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    if (!valid.has(auth)) return json(401, { detail: 'Unauthorized' });
    const collection = url.pathname.split('/').pop()!;
    calls.push({ collection, params: Object.fromEntries(url.searchParams) });
    let rows = opts.data?.[collection];
    if (rows === undefined) return json(403, { detail: 'Forbidden' });
    if (collection === 'heartrate') {
      const from = Date.parse(url.searchParams.get('start_datetime')!);
      const to = Date.parse(url.searchParams.get('end_datetime')!);
      rows = rows.filter((r) => {
        const t = Date.parse((r as { timestamp: string }).timestamp);
        return t >= from && t < to;
      });
    }
    return json(200, { data: rows, next_token: null });
  };

  return {
    fetch,
    calls,
    tokenHosts,
    get refreshes() {
      return refreshes;
    },
    /** Tokens as `npm run oura-auth` would store them. */
    seedTokens(expiresAt: number) {
      return JSON.stringify({ ...issue(), expires_at: expiresAt });
    },
    revokeAccessTokens() {
      valid.clear();
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Realistic slices of Oura v2 documents (trimmed to the fields the server asks for).
export const OURA_DATA: Record<string, unknown[]> = {
  sleep: [
    {
      day: '2026-09-25', type: 'long_sleep', bedtime_start: '2026-09-24T23:12:30-07:00', bedtime_end: '2026-09-25T06:58:00-07:00',
      total_sleep_duration: 25_200, time_in_bed: 27_930, deep_sleep_duration: 5_400, rem_sleep_duration: 6_300,
      light_sleep_duration: 13_500, efficiency: 90, lowest_heart_rate: 48, average_heart_rate: 55.4, average_hrv: 61,
      average_breath: 14.625, heart_rate: { interval: 300, items: [58, 54, null, 51, 52, 57] },
    },
    { day: '2026-09-25', type: 'sleep', total_sleep_duration: 1_800, time_in_bed: 2_100, average_hrv: 40 },
    { day: '2026-09-25', type: 'rest', total_sleep_duration: 900 },
    {
      day: '2026-09-26', type: 'long_sleep', bedtime_start: '2026-09-26T00:05:00-07:00', bedtime_end: '2026-09-26T07:30:00-07:00',
      total_sleep_duration: 23_400, time_in_bed: 26_700, deep_sleep_duration: 4_500, rem_sleep_duration: 5_400,
      light_sleep_duration: 13_500, efficiency: 88, lowest_heart_rate: 50, average_heart_rate: 57, average_hrv: 55,
      average_breath: 14.9, heart_rate: null,
    },
    // Outside the requested range (the padded query returns it; it must be filtered out).
    { day: '2026-09-18', type: 'long_sleep', total_sleep_duration: 30_000, average_hrv: 99 },
  ],
  daily_sleep: [{ day: '2026-09-25', score: 84 }, { day: '2026-09-26', score: 79 }],
  daily_spo2: [{ day: '2026-09-25', breathing_disturbance_index: 3, spo2_percentage: { average: 96.418 } }],
  daily_readiness: [
    { day: '2026-09-25', score: 82, temperature_deviation: -0.123, temperature_trend_deviation: 0.05 },
    { day: '2026-09-26', score: 74, temperature_deviation: 0.41, temperature_trend_deviation: 0.2 },
  ],
  daily_activity: [
    {
      day: '2026-09-25', score: 88, steps: 11_234, active_calories: 512, total_calories: 2_480,
      equivalent_walking_distance: 9_870, high_activity_time: 1_200, medium_activity_time: 2_700,
      low_activity_time: 14_400, sedentary_time: 30_600, non_wear_time: 600,
    },
  ],
  heartrate: [
    // 2026-09-25 local (America/Los_Angeles, UTC-7)
    { timestamp: '2026-09-25T14:00:00+00:00', bpm: 72, source: 'awake' },
    { timestamp: '2026-09-25T18:30:00+00:00', bpm: 151, source: 'workout' },
    { timestamp: '2026-09-26T05:00:00+00:00', bpm: 66, source: 'awake' }, // 22:00 local on the 25th
    // 2026-09-26 local
    { timestamp: '2026-09-26T08:00:00+00:00', bpm: 53, source: 'sleep' }, // 01:00 local
    { timestamp: '2026-09-26T20:00:00+00:00', bpm: 80, source: 'awake' },
  ],
};
