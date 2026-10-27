// A fake Vend16 server and throwaway app folders for the tests.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../src/cli.js';

export const SECRET = 'sk_' + 'S'.repeat(32);
export const TOKEN = 'at_' + 'T'.repeat(32);

/** Start a fake server. `state` drives its answers; `calls` records every request. */
export async function fakeVend16(opts = {}) {
  const state = {
    apps: opts.apps ?? [],
    pendingPolls: opts.pendingPolls ?? 1,
    deny: !!opts.deny,
    setup: opts.setup ?? 'ok', // 'ok' | 'missing'
    secretsMade: 0,
  };
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: json });
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'POST' && p === '/v1/device/code') {
      return send(200, { device_code: 'dev_123', user_code: 'WXYZ-1234', verification_uri: 'https://vend16.com/activate', verification_uri_complete: 'https://vend16.com/activate?code=WXYZ-1234', interval: 1, expires_in: 60 });
    }
    if (req.method === 'POST' && p === '/v1/device/token') {
      if (state.deny) return send(400, { error: 'access_denied' });
      if (state.pendingPolls > 0) { state.pendingPolls--; return send(400, { error: { code: 'authorization_pending', message: 'Waiting' } }); }
      return send(200, { access_token: TOKEN, token_type: 'Bearer', account: { email: 'dev@example.com' } });
    }
    if (!authed) return send(401, { error: { code: 'unauthorized', message: 'Sign in again' } });
    // Shapes as vend16.com sends them (src/agent.ts whoami, setupStatus).
    if (req.method === 'GET' && p === '/v1/me') return send(200, { account_id: 'acct_1', email: 'dev@example.com', email_verified: true, plan: 'Free' });
    if (req.method === 'GET' && p === '/v1/apps') return send(200, { apps: state.apps });
    if (req.method === 'POST' && p === '/v1/apps') {
      const a = { id: 'app_new' + (state.apps.length + 1), name: json.name, bundle_id: json.bundle_id ?? null, package_name: json.package_name ?? null, public_key: 'pk_' + 'P'.repeat(32) };
      state.apps.push(a);
      return send(201, { app: a });
    }
    const m = /^\/v1\/apps\/([^/]+)\/(keys|secret-key|setup)$/.exec(p);
    if (m) {
      const app = state.apps.find((a) => a.id === m[1]);
      if (!app) return send(404, { error: { code: 'not_found', message: 'No such app' } });
      if (m[2] === 'keys') return send(200, { public_key: app.public_key });
      if (m[2] === 'secret-key' && req.method === 'POST') { state.secretsMade++; return send(201, { secret_key: SECRET }); }
      if (m[2] === 'setup') {
        if (state.setup === 'missing') return send(404, '');
        return send(200, { ready: false, next: 'apple_notifications', steps: [
          { id: 'app_ids', title: 'iOS bundle ID', status: app.bundle_id ? 'done' : 'todo', next_step: null },
          { id: 'apple_notifications', title: 'App Store Server Notifications', status: 'todo', next_step: `https://vend16.com/v1/notifications/apple/${app.id}` },
          { id: 'play_rtdn', title: 'Play real-time notifications', status: 'not_needed', next_step: null },
        ] });
      }
    }
    return send(404, '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, calls, close: () => new Promise((r) => server.close(r)) };
}

/** Make a folder with these files ({relativePath: contents}). */
export function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'vend16-cli-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

/** Run the CLI in-process. Returns {code, stdout, stderr, json, runs}. */
export async function cli(args, { base, env = {}, signedIn = true, cwd } = {}) {
  const configDir = env.VEND16_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'vend16-cfg-'));
  if (signedIn) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'credentials.json'), JSON.stringify({ token: TOKEN, api: base, email: 'dev@example.com' }));
  }
  let stdout = '', stderr = '';
  const runs = [];
  const code = await main(args, {
    env: { VEND16_API: base, VEND16_CONFIG_DIR: configDir, VEND16_POLL_MS: '1', ...env },
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    stdin: { isTTY: false },
    openBrowser: false,
    run: (cmd, a) => { runs.push(`${cmd} ${a.join(' ')}`); return 0; },
    cwd,
  });
  let json = null;
  try { json = JSON.parse(stdout); } catch { /* not --json */ }
  return { code, stdout, stderr, json, runs, configDir };
}

export const PBXPROJ = (id) => `// !$*UTF8*$!
{ objects = {
  A = { buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${id}; }; };
  B = { buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${id}Tests; }; };
  C = { buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = "$(PRODUCT_BUNDLE_IDENTIFIER).share"; }; };
}; }`;

export const GRADLE = (id) => `android {\n    defaultConfig {\n        applicationId "${id}"\n    }\n}\n`;
export const GRADLE_KTS = (id) => `android {\n    defaultConfig {\n        applicationId = "${id}"\n    }\n}\n`;
export const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>App</string>\n</dict>\n</plist>\n`;
