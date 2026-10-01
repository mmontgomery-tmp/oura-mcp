import type { SecretStore } from './store.ts';

// Oura's live token endpoint for current apps; cloud.ouraring.com's docs still name the legacy one,
// which only some older apps accept. `npm run oura-auth` records which one worked in `token_url`.
export const OURA_TOKEN_URL = 'https://moi.ouraring.com/oauth/v2/ext/oauth-token';
export const OURA_LEGACY_TOKEN_URL = 'https://api.ouraring.com/oauth/token';

export interface OuraTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
  scope?: string;
  /** Token endpoint this grant was issued by; refreshes must go to the same one. */
  token_url?: string;
}

export interface OuraClientCredentials {
  client_id: string;
  client_secret: string;
}

/** How to fix any OuraAuthError; every such message ends with it. */
export const REAUTHORIZE =
  'To re-authorize Oura, run `npm run oura-auth` in the oura-mcp project folder (see docs/RUNBOOK.md).';

/** Needs a human: re-authorize. Retrying will not help. */
export class OuraAuthError extends Error {
  override name = 'OuraAuthError';
  constructor(problem: string) {
    super(`${problem} ${REAUTHORIZE}`);
  }
}

// Refresh this long before expiry so a token never dies mid-request.
const EXPIRY_SKEW_MS = 5 * 60_000;
// After losing a refresh race, how long to wait for the winner to persist its tokens.
const RACE_POLL_DELAYS_MS = [250, 750, 1500, 3000];
const PERSIST_DELAYS_MS = [0, 200, 800];

export interface TokenManagerOptions {
  store: SecretStore;
  tokensParam: string;
  clientParam: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface TokenManager {
  getAccessToken(): Promise<string>;
  /** Call after Oura answered 401 for `rejected`; returns a token worth one retry. */
  handleUnauthorized(rejected: string): Promise<string>;
}

/**
 * Oura refresh tokens are single-use: each refresh returns a new refresh token and
 * invalidates the old one. Up to two Lambda instances (reserved concurrency 2) can race
 * for the same refresh token, so the rules here are:
 *
 * 1. Re-read SSM right before refreshing; if another instance already rotated, use its tokens.
 * 2. Persist the new pair to SSM *before* using the access token.
 * 3. On `invalid_grant`, assume we lost the race and poll SSM for the winner's tokens.
 * 4. If persisting fails, keep the unpersisted pair in memory and keep retrying the write;
 *    never refresh again from the (already consumed) token in SSM while one is pending.
 */
export function createTokenManager(opts: TokenManagerOptions): TokenManager {
  const {
    store,
    tokensParam,
    clientParam,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = (msg, extra) => console.log(JSON.stringify({ msg, ...extra })),
  } = opts;

  let cached: OuraTokens | undefined;
  let unpersisted: OuraTokens | undefined;
  let client: OuraClientCredentials | undefined;
  let inflight: Promise<OuraTokens> | undefined;

  const fresh = (t: OuraTokens) => t.expires_at - now() > EXPIRY_SKEW_MS;

  async function readStore(): Promise<OuraTokens> {
    const raw = await store.get(tokensParam);
    if (!raw) throw new OuraAuthError('Oura is not connected yet.');
    cached = parseTokens(raw);
    return cached;
  }

  async function persist(tokens: OuraTokens): Promise<void> {
    let lastErr: unknown;
    for (const delay of PERSIST_DELAYS_MS) {
      if (delay) await sleep(delay);
      try {
        await store.put(tokensParam, JSON.stringify(tokens));
        if (unpersisted === tokens) unpersisted = undefined;
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    // The old refresh token is already burned, so this pair is the only valid one.
    // Keep it in memory and retry the write on the next request.
    unpersisted = tokens;
    log('ERROR: could not persist rotated Oura tokens to SSM; holding them in memory', {
      error: String(lastErr),
    });
  }

  async function loadClient(): Promise<OuraClientCredentials> {
    if (client) return client;
    const raw = await store.get(clientParam);
    if (!raw) throw new OuraAuthError('The Oura OAuth client credentials are missing from SSM.');
    const parsed = JSON.parse(raw) as Partial<OuraClientCredentials>;
    if (!parsed.client_id || !parsed.client_secret) throw new OuraAuthError(`${clientParam} in SSM is malformed.`);
    client = { client_id: parsed.client_id, client_secret: parsed.client_secret };
    return client;
  }

  type Exchange =
    | { kind: 'ok'; tokens: OuraTokens }
    | { kind: 'rejected'; status: number; error: string }
    | { kind: 'failed'; status: number; error: string };

  async function exchange(current: OuraTokens): Promise<Exchange> {
    const { client_id, client_secret } = await loadClient();
    const refreshToken = current.refresh_token;
    // No cross-endpoint retry: a single-use refresh token must not be spent on a guess.
    const tokenUrl = current.token_url ?? OURA_TOKEN_URL;
    let res: Response;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id, client_secret }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Nothing was exchanged, so the stored refresh token is still good: a retry will work.
      throw new Error(
        `Could not reach Oura to refresh the access token (${err instanceof Error ? err.message : String(err)}). ` +
          'This is usually temporary; try again in a minute.',
      );
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof body.access_token === 'string') {
      return {
        kind: 'ok',
        tokens: {
          access_token: body.access_token,
          // Oura rotates, but fall back to the old one if a response ever omits it.
          refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
          expires_at: now() + Number(body.expires_in ?? 86_400) * 1000,
          scope: typeof body.scope === 'string' ? body.scope : current.scope,
          token_url: tokenUrl,
        },
      };
    }
    const error = String(body.error ?? body.detail ?? 'unknown_error');
    return res.status === 400 || res.status === 401
      ? { kind: 'rejected', status: res.status, error }
      : { kind: 'failed', status: res.status, error };
  }

  async function doRefresh(stale: OuraTokens): Promise<OuraTokens> {
    if (unpersisted) {
      await persist(unpersisted);
      if (unpersisted) {
        // SSM still holds a burned refresh token; this in-memory pair is the source of truth.
        if (unpersisted.refresh_token !== stale.refresh_token && fresh(unpersisted)) return unpersisted;
      }
    }
    const current = unpersisted ?? (await readStore());
    if (current.refresh_token !== stale.refresh_token && fresh(current)) {
      log('oura tokens already rotated by another instance');
      return current;
    }

    const result = await exchange(current);
    if (result.kind === 'ok') {
      cached = result.tokens;
      await persist(result.tokens);
      log('oura tokens refreshed', { expires_at: new Date(result.tokens.expires_at).toISOString() });
      return result.tokens;
    }
    if (result.kind === 'failed') {
      throw new Error(`Oura token refresh failed (HTTP ${result.status}: ${result.error}). Try again shortly.`);
    }

    // Rejected: most likely the other instance consumed this single-use token a moment ago.
    for (const delay of RACE_POLL_DELAYS_MS) {
      await sleep(delay);
      const latest = await readStore();
      if (latest.refresh_token !== current.refresh_token) {
        log('lost oura refresh race; using tokens persisted by the other instance');
        return latest;
      }
    }
    throw new OuraAuthError(
      `Oura rejected the stored refresh token (HTTP ${result.status}: ${result.error}); it was revoked or already used.`,
    );
  }

  function refresh(stale: OuraTokens): Promise<OuraTokens> {
    // One refresh at a time per instance (a tool may call several Oura endpoints in parallel).
    inflight ??= doRefresh(stale).finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return {
    async getAccessToken() {
      const t = unpersisted ?? cached ?? (await readStore());
      if (fresh(t)) return t.access_token;
      return (await refresh(t)).access_token;
    },
    async handleUnauthorized(rejected) {
      const t = unpersisted ?? cached ?? (await readStore());
      if (t.access_token !== rejected && fresh(t)) return t.access_token;
      return (await refresh(t)).access_token;
    },
  };
}

export function parseTokens(raw: string): OuraTokens {
  const t = JSON.parse(raw) as Partial<OuraTokens>;
  if (typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || typeof t.expires_at !== 'number') {
    throw new OuraAuthError('The Oura tokens stored in SSM are malformed.');
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at,
    scope: t.scope,
    token_url: t.token_url,
  };
}
