import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { HealthStore } from './health-store.ts';
import { handleIngest } from './ingest.ts';
import { createOuraApi } from './oura.ts';
import { paramNames, type SecretStore } from './store.ts';
import { createTokenManager } from './tokens.ts';
import { buildServer } from './tools.ts';

export interface HandlerDeps {
  store: SecretStore;
  health: HealthStore;
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Injected in tests so retry back-off does not slow them down. */
  sleep?: (ms: number) => Promise<void>;
}

const MCP_MOUNT = '/mcp/';
const INGEST_MOUNT = '/ingest/';
const NOT_FOUND: LambdaFunctionURLResult = { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };

export function createLambdaHandler(deps: HandlerDeps) {
  const params = paramNames();
  const log = deps.log ?? ((msg, extra) => console.log(JSON.stringify({ msg, ...extra })));

  // Module-scope state survives across warm invocations of the same instance.
  const tokens = createTokenManager({
    store: deps.store,
    tokensParam: params.tokens,
    clientParam: params.oauthClient,
    fetch: deps.fetch,
    log,
    sleep: deps.sleep,
  });
  const oura = createOuraApi({ tokens, fetch: deps.fetch, sleep: deps.sleep });

  // Stateless Streamable HTTP: a fresh McpServer per request, JSON bodies instead of SSE
  // (Function URLs in BUFFERED mode return the whole body at once anyway). 2025-era clients
  // get the SDK's stateless fallback, where GET/DELETE (session operations) are answered 405.
  const mcp = createMcpHandler(() => buildServer({ oura, health: deps.health, timeZone: deps.timeZone, now: deps.now, log }), {
    responseMode: 'json',
    maxRequestBodySize: 256 * 1024,
    // No subscriptions/listen streams: a buffered Lambda cannot hold a response open, and an open
    // stream left the handler awaiting forever until the runtime exited (Runtime.ExitError). Clients
    // get an immediate in-band error instead; this server never sends list-changed notifications.
    maxSubscriptions: 0,
    onerror: (err) => log('mcp error', { error: err.message }),
  });

  // SSM secrets and their SHA-256 digests, loaded once per instance.
  const secrets = new Map<string, Promise<{ value: string; digest: Buffer }>>();
  const loadSecret = (param: string) => {
    let secret = secrets.get(param);
    if (!secret) {
      const pending = deps.store.get(param).then((value) => {
        if (!value || value.length < 32) throw new Error(`${param} is missing or shorter than 32 chars`);
        return { value, digest: sha256(value) };
      });
      // Do not cache a failed SSM read; retry on the next request.
      pending.catch(() => {
        if (secrets.get(param) === pending) secrets.delete(param);
      });
      secrets.set(param, (secret = pending));
    }
    return secret;
  };
  // Compare SHA-256 digests so the comparison is constant-time and length-independent.
  const matches = async (presented: string, param: string) =>
    timingSafeEqual(sha256(presented), (await loadSecret(param)).digest);

  /**
   * Why an ingest request's X-Ingest-Key was refused, in terms safe to log: header names, lengths
   * and hints only, never the presented or expected value. Runs only after a failed check.
   */
  async function describeKeyProblem(headers: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const key = (await loadSecret(params.ingestKey)).value;
    const presented = headers['x-ingest-key'];
    const info: Record<string, unknown> = { header_names: Object.keys(headers).sort() };
    if (presented === undefined) {
      info.problem = 'no X-Ingest-Key header';
    } else {
      info.problem = 'X-Ingest-Key value does not match';
      info.value_length = presented.length;
      info.expected_length = key.length;
      if (presented.includes(key)) info.hint = 'the value contains the key plus extra text (e.g. "X-Ingest-Key: " pasted into the value)';
      else if (presented.trim().toLowerCase() === key.toLowerCase()) info.hint = 'differs only in letter case (autocapitalization?)';
    }
    const elsewhere = Object.entries(headers).find(([name, v]) => name !== 'x-ingest-key' && v?.includes(key));
    if (elsewhere) info.key_found_in_header = elsewhere[0];
    return info;
  }

  return async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
    const started = Date.now();
    const method = event.requestContext.http.method;
    try {
      return await serve(event, method, started);
    } catch (err) {
      log('unhandled error', { method, error: err instanceof Error ? err.message : String(err) });
      return { statusCode: 500, headers: { 'content-type': 'text/plain' }, body: 'Internal error' };
    }
  };

  async function serve(event: LambdaFunctionURLEvent, method: string, started: number): Promise<LambdaFunctionURLResult> {
    // Routes: /mcp/<path-secret> and /ingest/<ingest-path-secret> (optionally with a trailing
    // slash). Each has its own secret; never log the path, it is the credential.
    const path = event.rawPath.replace(/\/+$/, '');
    const ip = event.requestContext.http.sourceIp;

    if (path.startsWith(INGEST_MOUNT)) {
      if (!(await matches(path.slice(INGEST_MOUNT.length), params.ingestPathSecret))) {
        log('rejected: bad ingest path secret', { method, ip });
        return NOT_FOUND;
      }
      // Surrounding whitespace (easy to paste into an iPhone text field) is not part of the key.
      if (!(await matches((event.headers?.['x-ingest-key'] ?? '').trim(), params.ingestKey))) {
        log('rejected: bad or missing X-Ingest-Key', { method, ip, ...(await describeKeyProblem(event.headers ?? {})) });
        return { statusCode: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"Missing or wrong X-Ingest-Key header."}' };
      }
      return handleIngest(event, { health: deps.health, timeZone: deps.timeZone, now: deps.now, log });
    }

    if (!path.startsWith(MCP_MOUNT)) return NOT_FOUND;
    if (!(await matches(path.slice(MCP_MOUNT.length), params.pathSecret))) {
      log('rejected: bad path secret', { method, ip });
      return NOT_FOUND;
    }

    const response = await mcp.fetch(toRequest(event));
    const result = await toResult(response);
    // Never log the path: it is the credential.
    log('request', { method, rpc: rpcMethod(event), status: response.status, ms: Date.now() - started });
    return result;
  }
}

// Recomputed by the Request itself; hop-by-hop headers do not belong to the inner request.
const SKIP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection']);

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function toRequest(event: LambdaFunctionURLEvent): Request {
  const method = event.requestContext.http.method;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined && !SKIP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  const body =
    event.body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
  // The SDK never needs the secret, so the URL it sees is scrubbed of it.
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return new Request(`https://${event.requestContext.domainName}/mcp${query}`, { method, headers, body });
}

async function toResult(response: Response): Promise<LambdaFunctionURLResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { statusCode: response.status, headers, body: await response.text(), isBase64Encoded: false };
}

/** Best-effort JSON-RPC method (and tool name) for logs. */
function rpcMethod(event: LambdaFunctionURLEvent): string | undefined {
  if (!event.body) return undefined;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const msg = JSON.parse(raw) as { method?: string; params?: { name?: string } } | unknown[];
    if (Array.isArray(msg)) return 'batch';
    return msg.method === 'tools/call' && msg.params?.name ? `tools/call:${msg.params.name}` : msg.method;
  } catch {
    return undefined;
  }
}
