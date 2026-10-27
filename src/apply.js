// Puts keys where each kind of app expects them.
//
// The public key (pk_) is safe in app code, so it goes in the app's usual
// public config. The secret key (sk_) only ever goes into a server's env file
// that git ignores, and is never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { findXcodeproj } from './detect.js';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

/** Set NAME=value in a dotenv file, replacing an existing line. Returns 'added' | 'updated' | 'unchanged'. */
export function setEnvVar(path, name, value) {
  const text = read(path) ?? '';
  const re = new RegExp(`^${name}=.*$`, 'm');
  const line = `${name}=${value}`;
  if (re.test(text)) {
    if (text.match(re)[0] === line) return 'unchanged';
    writeFileSync(path, text.replace(re, line));
    return 'updated';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
  return 'added';
}

/** Where the public key goes for this app, and how the code reads it. */
export function publicKeyTarget(app) {
  const { root, stack, framework } = app;
  if (stack === 'capacitor') {
    const env = { vite: 'VITE_VEND16_PUBLIC_KEY', next: 'NEXT_PUBLIC_VEND16_PUBLIC_KEY', cra: 'REACT_APP_VEND16_PUBLIC_KEY', nuxt: 'NUXT_PUBLIC_VEND16_PUBLIC_KEY' }[framework];
    if (env) {
      const read = framework === 'vite' ? `import.meta.env.${env}` : framework === 'nuxt' ? 'useRuntimeConfig().public.vend16PublicKey' : `process.env.${env}`;
      return { kind: 'env', path: join(root, '.env'), name: env, read };
    }
    return { kind: 'module', path: join(root, 'src', 'vend16.config.js'), read: "import { VEND16_PUBLIC_KEY } from './vend16.config.js'" };
  }
  if (stack === 'expo') return { kind: 'expo-extra', path: join(root, 'app.json'), read: "Constants.expoConfig.extra.vend16PublicKey (import Constants from 'expo-constants')" };
  if (stack === 'react-native') return { kind: 'module', path: join(root, 'vend16.config.js'), read: "import { VEND16_PUBLIC_KEY } from './vend16.config.js'" };
  if (stack === 'flutter') return { kind: 'dart', path: join(root, 'lib', 'vend16_config.dart'), read: "import 'vend16_config.dart'; then vend16PublicKey" };
  if (stack === 'native') return { kind: 'native', read: 'iOS: Bundle.main.object(forInfoDictionaryKey: "Vend16PublicKey"); Android: getString(R.string.vend16_public_key)' };
  return null;
}

/** Write the public key. Returns [{path, result}] for each file touched, plus `manual` notes. */
export function writePublicKey(app, key) {
  if (!/^pk_[A-Za-z0-9_-]{8,}$/.test(key)) throw new Error('That is not a Vend16 public key (pk_...)');
  const t = publicKeyTarget(app);
  const out = { target: t, files: [], manual: [] };
  if (!t) return out;
  if (t.kind === 'env') {
    out.files.push({ path: t.path, result: setEnvVar(t.path, t.name, key) });
    if (isGitIgnored(app.root, t.path)) {
      out.manual.push(`${relative(app.root, t.path)} is git-ignored, so set ${t.name} in your CI or build environment too (the public key is safe to share).`);
    }
  } else if (t.kind === 'module') {
    const body = `// Vend16 public key. Safe to ship in the app: it can only report purchases and read entitlements.\nexport const VEND16_PUBLIC_KEY = '${key}';\n`;
    const was = read(t.path);
    if (was === body) out.files.push({ path: t.path, result: 'unchanged' });
    else { mkdirSync(dirname(t.path), { recursive: true }); writeFileSync(t.path, body); out.files.push({ path: t.path, result: was === null ? 'added' : 'updated' }); }
  } else if (t.kind === 'dart') {
    const body = `// Vend16 public key. Safe to ship in the app: it can only report purchases and read entitlements.\nconst String vend16PublicKey = '${key}';\n`;
    const was = read(t.path);
    if (was === body) out.files.push({ path: t.path, result: 'unchanged' });
    else { mkdirSync(dirname(t.path), { recursive: true }); writeFileSync(t.path, body); out.files.push({ path: t.path, result: was === null ? 'added' : 'updated' }); }
  } else if (t.kind === 'expo-extra') {
    const text = read(t.path);
    let cfg;
    try { cfg = JSON.parse(text); } catch { cfg = null; }
    if (!cfg) {
      out.manual.push(`Add "extra": { "vend16PublicKey": "${key}" } under "expo" in app.json (or app.config.js).`);
    } else {
      cfg.expo = cfg.expo ?? {};
      cfg.expo.extra = cfg.expo.extra ?? {};
      const result = cfg.expo.extra.vend16PublicKey === key ? 'unchanged' : cfg.expo.extra.vend16PublicKey ? 'updated' : 'added';
      cfg.expo.extra.vend16PublicKey = key;
      if (result !== 'unchanged') writeFileSync(t.path, JSON.stringify(cfg, null, 2) + '\n');
      out.files.push({ path: t.path, result });
    }
  } else if (t.kind === 'native') {
    if (app.gradleRoot) {
      const p = join(app.gradleRoot, 'app', 'src', 'main', 'res', 'values', 'vend16.xml');
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<!-- Vend16 public key. Safe to ship in the app. -->\n<resources>\n    <string name="vend16_public_key" translatable="false">${key}</string>\n</resources>\n`;
      const was = read(p);
      if (was !== body) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); }
      out.files.push({ path: p, result: was === body ? 'unchanged' : was === null ? 'added' : 'updated' });
    }
    if (app.xcodeproj || app.bundleId) {
      const plist = findInfoPlist(app);
      if (plist) out.files.push({ path: plist, result: setPlistString(plist, 'Vend16PublicKey', key) });
      else out.manual.push(`Add Vend16PublicKey = ${key} to your iOS target's Info (Xcode, target, Info tab, Custom iOS Target Properties).`);
    }
  }
  return out;
}

/** The app target's Info.plist next to the .xcodeproj, if the project has one as a file. */
function findInfoPlist(app) {
  const proj = app.xcodeproj ?? findXcodeproj(app.root, 2);
  if (!proj) return null;
  const dir = dirname(proj);
  const name = proj.split(/[\\/]/).pop().replace(/\.xcodeproj$/, '');
  for (const p of [join(dir, name, 'Info.plist'), join(dir, 'App', 'Info.plist'), join(dir, 'Info.plist')]) if (existsSync(p)) return p;
  return null;
}

/** Set a string key in an XML plist without a plist library. */
export function setPlistString(path, key, value) {
  const text = read(path);
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (re.test(text)) {
    if (text.match(re)[2] === value) return 'unchanged';
    writeFileSync(path, text.replace(re, `$1${value}$3`));
    return 'updated';
  }
  const at = text.lastIndexOf('</dict>');
  if (at < 0) throw new Error(`${path} is not an XML plist`);
  writeFileSync(path, text.slice(0, at) + `\t<key>${key}</key>\n\t<string>${value}</string>\n` + text.slice(at));
  return 'added';
}

/** True when git ignores `path` (false outside a repo or without git). */
export function isGitIgnored(root, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when git tracks `path`. */
export function isGitTracked(root, path) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when `root` is inside a git work tree. */
export function inGitRepo(root) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the secret key into a server env file. Refuses a file git tracks, or
 * one git would not ignore, unless `force`. Never returns or prints the key.
 */
export function writeSecretKey(root, envPath, key, { force = false } = {}) {
  if (!key.startsWith('sk_')) throw new Error('Not a secret key');
  if (inGitRepo(dirname(envPath))) {
    if (isGitTracked(dirname(envPath), envPath)) throw new Error(`${envPath} is tracked by git. Refusing to put a secret key in it.`);
    if (!force && !isGitIgnored(dirname(envPath), envPath)) {
      throw new Error(`${envPath} is not git-ignored. Add it to .gitignore first (or pass --force if you are sure).`);
    }
  }
  return setEnvVar(envPath, 'VEND16_SECRET_KEY', key);
}
