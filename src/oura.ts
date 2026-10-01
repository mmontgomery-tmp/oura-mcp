import { OuraAuthError, type TokenManager } from './tokens.ts';

export const OURA_API = 'https://api.ouraring.com/v2/usercollection';

export class OuraApiError extends Error {
  override name = 'OuraApiError';
  readonly status: number;
  readonly collection: string;
  constructor(status: number, collection: string, detail: string) {
    super(`Oura ${collection} request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.collection = collection;
  }
}

// Oura documents the scope each collection needs; surfaced in 403 messages.
const SCOPE_FOR: Record<string, string> = {
  sleep: 'daily',
  daily_sleep: 'daily',
  daily_readiness: 'daily',
  daily_activity: 'daily',
  daily_spo2: 'spo2',
  heartrate: 'heartrate',
};

export interface OuraApi {
  /** Fetches every page of a usercollection endpoint. `fields` trims large per-document payloads. */
  list<T>(collection: string, params: Record<string, string>, fields?: readonly string[]): Promise<T[]>;
}

export function createOuraApi(opts: {
  tokens: TokenManager;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): OuraApi {
  const { tokens, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;

  async function getPage(collection: string, query: URLSearchParams): Promise<{ data: unknown[]; next_token?: string | null }> {
    const url = `${OURA_API}/${collection}?${query}`;
    let token = await tokens.getAccessToken();
    let retried401 = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) return (await res.json()) as { data: unknown[]; next_token?: string | null };

      if (res.status === 401) {
        if (retried401) throw new OuraAuthError(`Oura still rejects the access token for ${collection} after refreshing it.`);
        retried401 = true;
        token = await tokens.handleUnauthorized(token);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 800 * (attempt + 1));
        continue;
      }
      const text = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status === 403) {
        throw new OuraApiError(
          403,
          collection,
          `access denied. The Oura authorization may be missing the "${SCOPE_FOR[collection] ?? '?'}" scope ` +
            '(re-run `npm run oura-auth`), or the Oura membership is inactive.',
        );
      }
      throw new OuraApiError(res.status, collection, text);
    }
  }

  return {
    async list<T>(collection: string, params: Record<string, string>, fields?: readonly string[]) {
      const out: T[] = [];
      let nextToken: string | undefined;
      // Hard stop so a misbehaving cursor cannot loop a Lambda to its timeout.
      for (let page = 0; page < 50; page++) {
        const query = new URLSearchParams(params);
        if (fields?.length) query.set('fields', fields.join(','));
        if (nextToken) query.set('next_token', nextToken);
        const body = await getPage(collection, query);
        out.push(...(body.data as T[]));
        if (!body.next_token) return out;
        nextToken = body.next_token;
      }
      return out;
    },
  };
}
