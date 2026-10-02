import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { createLambdaHandler } from '../src/app.ts';
import { CLIENT, fakeOura, INGEST_KEY, INGEST_SECRET, memoryHealthStore, memoryStore, OURA_DATA, PARAMS, PATH_SECRET } from './fakes.ts';

export const HOST = 'abc123.lambda-url.us-east-1.on.aws';
export const NOW = new Date('2026-09-27T18:00:00Z'); // 11:00 in Los Angeles

export function setup(opts: { tokensExpireIn?: number; data?: Record<string, unknown[]> } = {}) {
  const oura = fakeOura({ data: opts.data ?? OURA_DATA });
  const store = memoryStore({
    [PARAMS.pathSecret]: PATH_SECRET,
    [PARAMS.oauthClient]: CLIENT,
    [PARAMS.tokens]: oura.seedTokens(Date.now() + (opts.tokensExpireIn ?? 3_600_000)),
    [PARAMS.ingestPathSecret]: INGEST_SECRET,
    [PARAMS.ingestKey]: INGEST_KEY,
  });
  const health = memoryHealthStore();
  const logs: Record<string, unknown>[] = [];
  let clock = NOW;
  const lambda = createLambdaHandler({
    store,
    health,
    timeZone: 'America/Los_Angeles',
    fetch: oura.fetch,
    now: () => clock,
    log: (msg, extra) => logs.push({ msg, ...extra }),
    sleep: async () => {},
  });

  /** What the Function URL does: turn an HTTP request into a payload-v2 event, and back. */
  const viaFunctionUrl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    // Like the Function URL: text bodies as-is, encoded (binary) bodies base64.
    const binary = req.headers.has('content-encoding');
    const bytes = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
    const event = {
      version: '2.0',
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(req.headers),
      body: bytes?.toString(binary ? 'base64' : 'utf8'),
      isBase64Encoded: binary,
      requestContext: { domainName: url.host, http: { method: req.method, path: url.pathname, sourceIp: '203.0.113.9' } },
    } as unknown as LambdaFunctionURLEvent;
    const res = await lambda(event);
    const status = typeof res === 'object' ? res.statusCode ?? 200 : 200;
    const nullBody = status === 204 || status === 304;
    return new Response(nullBody ? null : typeof res === 'object' ? res.body : res, {
      status,
      headers: typeof res === 'object' ? (res.headers as Record<string, string>) : {},
    });
  };

  async function connect(mode: 'auto' | 'legacy', secret = PATH_SECRET) {
    const client = new Client({ name: 'test', version: '0' }, { versionNegotiation: { mode } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`https://${HOST}/mcp/${secret}`), { fetch: viaFunctionUrl }),
    );
    return client;
  }

  /**
   * POST a body to the ingest endpoint as Health Auto Export would. `now` sets the server's clock
   * for this one request, so reconciliation (the 15-minute rule, the 7-day window) can be driven.
   */
  const ingest = async (body: unknown, opts: { secret?: string; key?: string | null; headers?: Record<string, string>; now?: string } = {}) => {
    if (opts.now) clock = new Date(opts.now);
    try {
      return await viaFunctionUrl(`https://${HOST}/ingest/${opts.secret ?? INGEST_SECRET}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.key === null ? {} : { 'x-ingest-key': opts.key ?? INGEST_KEY }),
          ...opts.headers,
        },
        body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
    } finally {
      clock = NOW;
    }
  };

  return { oura, store, health, logs, viaFunctionUrl, connect, ingest };
}

export const rows = (result: unknown) => {
  const r = result as { isError?: boolean; content: { type: string; text: string }[] };
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};

