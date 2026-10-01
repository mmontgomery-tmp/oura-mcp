import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenManager, OuraAuthError, parseTokens } from '../src/tokens.ts';
import { CLIENT, fakeOura, memoryStore, PARAMS } from './fakes.ts';

const HOUR = 3_600_000;
const quiet = () => {};
const noSleep = async () => {};

function setup(expiresInMs: number) {
  const oura = fakeOura();
  const store = memoryStore({ [PARAMS.oauthClient]: CLIENT, [PARAMS.tokens]: oura.seedTokens(Date.now() + expiresInMs) });
  const manager = () =>
    createTokenManager({
      store,
      tokensParam: PARAMS.tokens,
      clientParam: PARAMS.oauthClient,
      fetch: oura.fetch,
      log: quiet,
      sleep: noSleep,
    });
  const stored = () => parseTokens(store.data.get(PARAMS.tokens)!);
  return { oura, store, manager, stored };
}

test('uses a fresh access token without refreshing', async () => {
  const { oura, store, manager } = setup(10 * HOUR);
  assert.equal(await manager().getAccessToken(), 'at-1');
  assert.equal(oura.refreshes, 0);
  assert.equal(store.puts, 0);
});

test('refreshes an expiring token and persists the rotated pair before use', async () => {
  const { oura, manager, stored } = setup(60_000); // inside the 5-minute skew
  assert.equal(await manager().getAccessToken(), 'at-2');
  assert.equal(oura.refreshes, 1);
  assert.equal(stored().refresh_token, 'rt-2');
  assert.ok(stored().expires_at > Date.now() + 23 * HOUR);
});

test('two instances racing on one single-use refresh token both end up with valid tokens', async () => {
  const { oura, manager, stored } = setup(-HOUR);
  const [a, b] = await Promise.all([manager().getAccessToken(), manager().getAccessToken()]);
  assert.equal(oura.refreshes, 1, 'exactly one refresh reached Oura successfully');
  assert.equal(a, 'at-2');
  assert.equal(b, 'at-2');
  assert.equal(stored().refresh_token, 'rt-2');
});

test('an instance with a stale cached pair adopts the rotation another instance persisted', async () => {
  const { oura, manager } = setup(10 * HOUR);
  const a = manager();
  const b = manager();
  assert.equal(await a.getAccessToken(), 'at-1');
  assert.equal(await b.getAccessToken(), 'at-1'); // both instances now cache rt-1
  oura.revokeAccessTokens(); // Oura starts answering 401 for at-1

  assert.equal(await a.handleUnauthorized('at-1'), 'at-2'); // A rotates rt-1 -> rt-2
  assert.equal(await b.handleUnauthorized('at-1'), 'at-2'); // B must not burn anything
  assert.equal(oura.refreshes, 1);
});

test('if SSM writes fail, the rotated pair is kept in memory and persisted later', async () => {
  const { oura, store, manager, stored } = setup(-HOUR);
  const realPut = store.put;
  let failWrites = true;
  store.put = async (name, value) => {
    if (failWrites) throw new Error('ThrottlingException');
    return realPut(name, value);
  };
  const m = manager();
  assert.equal(await m.getAccessToken(), 'at-2'); // still served
  assert.equal(stored().refresh_token, 'rt-1', 'SSM still has the burned token');

  // The next refresh must use rt-2 (in memory), never the burned rt-1 in SSM.
  failWrites = false;
  assert.equal(await m.handleUnauthorized('at-2'), 'at-3');
  assert.equal(oura.refreshes, 2);
  assert.equal(stored().refresh_token, 'rt-3');
});

test('a revoked refresh token surfaces an actionable OuraAuthError', async () => {
  const { store, manager } = setup(-HOUR);
  store.data.set(PARAMS.tokens, JSON.stringify({ access_token: 'x', refresh_token: 'revoked', expires_at: 0 }));
  await assert.rejects(manager().getAccessToken(), (err: unknown) => {
    assert.ok(err instanceof OuraAuthError);
    assert.match(err.message, /npm run oura-auth/);
    return true;
  });
});

test('missing tokens tell the user to run the auth script', async () => {
  const { store, manager } = setup(HOUR);
  store.data.delete(PARAMS.tokens);
  await assert.rejects(manager().getAccessToken(), /not connected yet/);
});

test('refreshes go to the token endpoint that issued the grant, and it is carried forward', async () => {
  const { oura, store, manager, stored } = setup(-HOUR);
  assert.equal(await manager().getAccessToken(), 'at-2');
  assert.deepEqual(oura.tokenHosts, ['moi.ouraring.com'], 'default is the live moi endpoint');

  // A pair issued by the legacy endpoint keeps refreshing there, with no cross-endpoint retry.
  const legacy = { ...stored(), expires_at: 0, token_url: 'https://api.ouraring.com/oauth/token' };
  store.data.set(PARAMS.tokens, JSON.stringify(legacy));
  assert.equal(await manager().getAccessToken(), 'at-3');
  assert.deepEqual(oura.tokenHosts, ['moi.ouraring.com', 'api.ouraring.com']);
  assert.equal(stored().token_url, 'https://api.ouraring.com/oauth/token');
});

test('a network failure during refresh is reported as temporary and burns nothing', async () => {
  const { store, stored } = setup(-HOUR);
  const before = stored().refresh_token;
  const m = createTokenManager({
    store, tokensParam: PARAMS.tokens, clientParam: PARAMS.oauthClient, log: quiet, sleep: noSleep,
    fetch: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(m.getAccessToken(), /Could not reach Oura.*try again/);
  assert.equal(stored().refresh_token, before);
});

test('Oura still answering 401 after a refresh asks for re-authorization', async () => {
  const { createOuraApi } = await import('../src/oura.ts');
  const api = createOuraApi({
    tokens: { getAccessToken: async () => 'a', handleUnauthorized: async () => 'b' },
    fetch: async () => new Response('{}', { status: 401 }),
  });
  await assert.rejects(api.list('sleep', {}), (err: unknown) => {
    assert.ok(err instanceof OuraAuthError);
    assert.match((err as Error).message, /still rejects the access token.*npm run oura-auth/);
    return true;
  });
});
