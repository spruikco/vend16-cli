// Where the CLI keeps its sign-in: one JSON file, readable only by you.
// VEND16_TOKEN (an agent token, at_...) and VEND16_API override it, for CI
// and agents that should not touch your home folder.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API } from './api.js';

export function configDir(env = process.env) {
  if (env.VEND16_CONFIG_DIR) return env.VEND16_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'vend16');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vend16');
}

const file = (env) => join(configDir(env), 'credentials.json');

export function loadCredentials(env = process.env) {
  const api = env.VEND16_API || null;
  if (env.VEND16_TOKEN) return { token: env.VEND16_TOKEN, api: api ?? DEFAULT_API, email: null, source: 'VEND16_TOKEN' };
  try {
    const c = JSON.parse(readFileSync(file(env), 'utf8'));
    return { token: c.token ?? null, api: api ?? c.api ?? DEFAULT_API, email: c.email ?? null, source: file(env) };
  } catch {
    return { token: null, api: api ?? DEFAULT_API, email: null, source: null };
  }
}

export function saveCredentials({ token, api, email }, env = process.env) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true });
  const p = file(env);
  writeFileSync(p, JSON.stringify({ token, api, email, saved_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* Windows: the file sits in the user's own profile */ }
  return p;
}

export function clearCredentials(env = process.env) {
  const p = file(env);
  const had = existsSync(p);
  rmSync(p, { force: true });
  return had;
}
