#!/usr/bin/env node
// One-time Oura connection: runs the OAuth authorization-code flow in your browser and stores
// the client credentials and the first token pair in SSM, where the Lambda takes over rotation.
//
//   npm run oura-auth                 # reuse client credentials already in SSM, or prompt
//   npm run oura-auth -- --new-client # prompt for client ID/secret again
//
// Register the app first at https://cloud.ouraring.com/oauth/applications with the redirect
// URI printed below. OURA_CLIENT_ID / OURA_CLIENT_SECRET env vars skip the prompts.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const PREFIX = process.env.PARAM_PREFIX ?? '/oura-mcp';
const PORT = Number(process.env.OURA_REDIRECT_PORT ?? 8787);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = ['daily', 'heartrate', 'spo2'];
const AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
// moi is Oura's live token endpoint; the documented api.ouraring.com one only works for some
// older apps. Try moi first: a rejected exchange burns the single-use code, and moi is the one
// nearly every app needs. The endpoint that worked is stored so the Lambda refreshes there too.
const TOKEN_URLS = ['https://moi.ouraring.com/oauth/v2/ext/oauth-token', 'https://api.ouraring.com/oauth/token'];
const TIMEOUT_MS = 5 * 60_000;

const ssm = new SSMClient({});

async function getParam(name) {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value;
  } catch (err) {
    if (err instanceof ParameterNotFound) return undefined;
    throw err;
  }
}

const putSecure = (name, value) =>
  ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }));

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo the prompt but not the typed characters.
    rl._writeToOutput = (s) => {
      if (s.startsWith(question) || s === '\r\n' || s === '\n') rl.output.write(s);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    }),
  );
}

async function clientCredentials() {
  const existing = process.argv.includes('--new-client') ? undefined : await getParam(`${PREFIX}/oauth-client`);
  if (existing) {
    console.log(`Using the Oura client credentials stored at ${PREFIX}/oauth-client.`);
    return { creds: JSON.parse(existing), isNew: false };
  }
  console.log(`\nRegister an app at https://cloud.ouraring.com/oauth/applications with redirect URI:\n  ${REDIRECT_URI}\n`);
  const client_id = process.env.OURA_CLIENT_ID || (await ask('Oura client ID: '));
  const client_secret = process.env.OURA_CLIENT_SECRET || (await ask('Oura client secret (hidden): ', { hidden: true }));
  if (!client_id || !client_secret) throw new Error('Client ID and secret are required.');
  return { creds: { client_id, client_secret }, isNew: true };
}

function waitForCallback(state) {
  return new Promise((resolve, reject) => {
    const servers = [];
    const finish = (fn) => {
      clearTimeout(timer);
      for (const s of servers) s.close();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Timed out waiting for the Oura redirect.'))), TIMEOUT_MS);
    const onRequest = (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const page = (msg) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end(`<!doctype html><title>Oura MCP</title><body style="font:16px system-ui;margin:3rem">${msg}</body>`);
      };
      if (url.searchParams.get('state') !== state) {
        page('State mismatch. Start again from the terminal.');
        return finish(() => reject(new Error('OAuth state mismatch.')));
      }
      const error = url.searchParams.get('error');
      if (error) {
        page(`Oura returned an error: ${error}. You can close this tab.`);
        return finish(() => reject(new Error(`Oura authorization failed: ${error}`)));
      }
      page('Oura connected. You can close this tab and return to the terminal.');
      finish(() => resolve(url.searchParams.get('code')));
    };
    // "localhost" may resolve to IPv4 or IPv6 in the browser; listen on both loopbacks only.
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(onRequest);
      s.on('error', (err) => {
        if (host === '127.0.0.1') finish(() => reject(err));
      });
      s.listen(PORT, host);
      servers.push(s);
    }
  });
}

async function exchangeCode(code, { client_id, client_secret }) {
  const failures = [];
  for (const tokenUrl of TOKEN_URLS) {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id, client_secret }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token && body.refresh_token) return { ...body, token_url: tokenUrl };
    const reason = body.error_description ?? body.error ?? body.detail ?? 'no tokens returned';
    failures.push(`${new URL(tokenUrl).host} HTTP ${res.status}: ${reason}`);
    if (res.status !== 400 && res.status !== 401) break;
  }
  throw new Error(`Token exchange failed (${failures.join('; ')}).`);
}

async function main() {
  const { creds, isNew } = await clientCredentials();
  const state = randomBytes(24).toString('base64url');
  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: creds.client_id,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
  }).toString();

  const callback = waitForCallback(state);
  console.log(`\nOpening Oura in your browser. If it does not open, visit:\n  ${authorize}\n`);
  console.log(
    `If Oura shows "400 invalid_request", the app's registered redirect URI is not exactly ${REDIRECT_URI}\n` +
      '(check http vs https, localhost vs 127.0.0.1, the port, and trailing slashes), then run this again.\n',
  );
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [authorize.toString()], () => {});
  const code = await callback;

  const t = await exchangeCode(code, creds);
  // Save the client first: the tokens are useless to the Lambda without it.
  if (isNew) await putSecure(`${PREFIX}/oauth-client`, JSON.stringify(creds));
  await putSecure(
    `${PREFIX}/tokens`,
    JSON.stringify({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + Number(t.expires_in ?? 86_400) * 1000,
      scope: t.scope,
      token_url: t.token_url,
    }),
  );
  console.log(`Stored the Oura token pair at ${PREFIX}/tokens. Granted scopes: ${t.scope ?? '(not reported)'}`);
  // New-portal apps report scopes as "extapi:daily"; legacy apps as "daily".
  const granted = String(t.scope ?? SCOPES.join(' '))
    .split(/\s+/)
    .map((s) => s.replace(/^extapi:/, ''));
  const missing = SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) console.warn(`WARNING: missing scopes ${missing.join(', ')}; related fields will be empty.`);

  // Quick check that the token actually reads data.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const probe = await fetch(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${since}`, {
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const days = probe.ok ? (await probe.json()).data?.length : undefined;
  console.log(
    probe.ok ? `Verified: Oura returned ${days} day(s) of activity for the last week.` : `WARNING: test read failed (HTTP ${probe.status}).`,
  );
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  if (/credentials|security token|ExpiredToken/i.test(err.message)) console.error("Run 'aws login' first.");
  process.exit(1);
});
