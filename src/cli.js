// vend16: add verified in-app purchases to an app in one command.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError, EXIT, createApi } from './api.js';
import { clearCredentials, loadCredentials, saveCredentials } from './config.js';
import { STACK_LABEL, detect } from './detect.js';
import { publicKeyTarget, writePublicKey, writeSecretKey } from './apply.js';
import { clientInstalled, installPlan, runInstall } from './install.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `vend16 ${VERSION}: put a buy button in your app. We get the rest sorted.

Usage: vend16 <command> [options]

Commands
  init       Sign in, find or create this app on Vend16, add its public key,
             install the store client and list what is left to set up
  login      Sign in through your browser (you approve a short code)
  logout     Forget this computer's sign-in
  status     Who you are signed in as, this app, and its setup checklist
  keys       Show this app's public key; --server-env FILE writes a new
             secret key into a server env file (never printed)
  doctor     Check the integration and say what to fix

Options
  --dir PATH         The app's folder (default: the current folder)
  --app ID           Use this Vend16 app (app_...) instead of matching IDs
  --name NAME        Name for a new Vend16 app (default: the app's name)
  --server-env FILE  Your server's env file for VEND16_SECRET_KEY
  --skip-install     Do not install packages or run cap sync
  --no-browser       Do not open the browser when signing in
  -y, --yes          Never ask; take the safe default for every question
  --json             Print one JSON result on stdout (progress goes to stderr)
  --force            Allow a server env file git does not ignore
  -h, --help         This help
  -v, --version      The version

Environment
  VEND16_TOKEN  An agent token (at_...) to use instead of signing in
  VEND16_API    Another Vend16 server (default https://vend16.com)

Exit codes
  0 done   1 error or problems found   2 bad usage   3 not signed in
  4 no app found or no matching Vend16 app   5 Vend16 could not be reached

Docs: https://vend16.com/docs   Agent guide: https://vend16.com/llms-full.txt`;

const OPTIONS = {
  dir: { type: 'string' },
  app: { type: 'string' },
  name: { type: 'string' },
  'server-env': { type: 'string' },
  'skip-install': { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  json: { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/** Docs for wiring purchases into code, per stack. */
const RECIPES = {
  capacitor: 'https://github.com/spruikco/capacitor-iap/blob/main/AGENTS.md',
  expo: 'https://github.com/spruikco/vend16-skill/blob/main/plugins/vend16/skills/vend16/references/react-native.md',
  'react-native': 'https://github.com/spruikco/vend16-skill/blob/main/plugins/vend16/skills/vend16/references/react-native.md',
  flutter: 'https://github.com/spruikco/vend16-skill/blob/main/plugins/vend16/skills/vend16/references/flutter.md',
  native: 'https://github.com/spruikco/vend16-skill/tree/main/plugins/vend16/skills/vend16/references',
};

/** Used when the server has no setup endpoint yet. */
function fallbackChecklist(appId) {
  return [
    { id: 'apple_products', label: 'Create your products in App Store Connect (same IDs as the code)', done: false, how: 'App Store Connect, your app, Monetization', url: 'https://appstoreconnect.apple.com' },
    { id: 'apple_notifications', label: 'App Store Server Notifications (Version 2), Production and Sandbox', done: false, how: `URL: https://vend16.com/v1/notifications/apple/${appId}`, url: 'https://appstoreconnect.apple.com' },
    { id: 'play_products', label: 'Create your products in Play Console (same IDs as the code)', done: false, how: 'Play Console, Monetize with Play, Products', url: 'https://play.google.com/console' },
    { id: 'play_service_account', label: 'Give Vend16 a Google Play service account', done: false, how: 'Upload its JSON key on the Setup page', url: `https://vend16.com/app/apps/${appId}/setup` },
    { id: 'play_rtdn', label: 'Real-time developer notifications for renewals and refunds', done: false, how: 'Pub/Sub details are on the Setup page', url: `https://vend16.com/app/apps/${appId}/setup` },
  ];
}

export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const run = io.run;

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    stderr.write(`vend16: ${e.message}\nRun vend16 --help for usage.\n`);
    return EXIT.USAGE;
  }
  const o = parsed.values;
  const cmd = parsed.positionals[0] ?? (o.version ? 'version' : 'help');
  if (o.version || cmd === 'version') { stdout.write(VERSION + '\n'); return EXIT.OK; }
  if (o.help || cmd === 'help') { stdout.write(HELP + '\n'); return EXIT.OK; }

  const jsonMode = !!o.json;
  const interactive = !o.yes && !!stdin.isTTY && !jsonMode;
  const say = (msg = '') => stderr.write(msg + '\n');
  const root = resolve(o.dir ?? io.cwd ?? process.cwd());
  const creds = loadCredentials(env);
  let api = createApi({ base: creds.api, token: creds.token, fetchImpl, userAgent: `vend16-cli/${VERSION}` });

  const finish = (code, result) => {
    if (jsonMode) stdout.write(JSON.stringify({ ok: code === EXIT.OK, exit_code: code, command: cmd, ...result }, null, 2) + '\n');
    return code;
  };
  const fail = (code, message, extra = {}) => {
    say(`vend16: ${message}`);
    return finish(code, { error: message, ...extra });
  };
  const exitFor = (e) => (e instanceof ApiError ? (e.status === 401 || e.status === 403 || e.code === 'not_signed_in' ? EXIT.AUTH : EXIT.SERVER) : EXIT.ERROR);

  async function ask(question, fallback) {
    if (!interactive) return fallback;
    const rl = createInterface({ input: stdin, output: stderr });
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
  }
  async function confirm(question, fallback = true) {
    if (!interactive) return fallback;
    const a = (await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}] `, '')).toLowerCase();
    return a ? a.startsWith('y') : fallback;
  }

  function openBrowser(url) {
    if (o['no-browser'] || env.VEND16_NO_BROWSER || io.openBrowser === false) return false;
    if (typeof io.openBrowser === 'function') { io.openBrowser(url); return true; }
    try {
      const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(c, a, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).unref();
      return true;
    } catch { return false; }
  }

  /** Device sign-in. Returns {email} or throws ApiError. */
  async function deviceLogin() {
    const start = await api.startDeviceLogin(`vend16 CLI on ${env.COMPUTERNAME ?? env.HOSTNAME ?? 'this computer'}`);
    const url = start.verificationUriComplete ?? start.verificationUri;
    say('');
    say(`  To sign in to Vend16, open ${start.verificationUri}`);
    say(`  and enter this code: ${start.userCode}`);
    say('');
    if (openBrowser(url)) say('  (Your browser should open by itself.)');
    say('  Waiting for you to approve it...');
    let interval = start.interval * 1000;
    const deadline = Date.now() + start.expiresIn * 1000;
    const pollMs = env.VEND16_POLL_MS ? Number(env.VEND16_POLL_MS) : null;
    while (Date.now() < deadline) {
      await sleep(pollMs ?? interval);
      const r = await api.pollDeviceLogin(start.deviceCode);
      if (r.pending) continue;
      if (r.slowDown) { interval += 5000; continue; }
      api = createApi({ base: creds.api, token: r.token, fetchImpl, userAgent: `vend16-cli/${VERSION}` });
      let email = r.email;
      if (!email) { try { email = (await api.account()).email; } catch { /* the token still works */ } }
      if (!env.VEND16_TOKEN) saveCredentials({ token: r.token, api: creds.api, email }, env);
      say(`  Signed in${email ? ` as ${email}` : ''}.`);
      return { email };
    }
    throw new ApiError(400, 'expired_token', 'The sign-in code expired. Run vend16 login again.');
  }

  /** The signed-in account, signing in first when needed and allowed. */
  async function ensureLogin() {
    if (creds.token) {
      try { return await api.account(); } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 401 && e.status !== 403)) throw e;
        if (creds.source === 'VEND16_TOKEN') throw new ApiError(401, 'bad_token', 'VEND16_TOKEN was not accepted');
        say('Your saved sign-in has expired.');
      }
    }
    await deviceLogin();
    return api.account();
  }

  /** Pick the Vend16 app for the detected one. Returns {app, created, candidates}. */
  async function resolveApp(local, { create }) {
    const apps = await api.listApps();
    if (o.app) {
      const a = apps.find((x) => x.id === o.app);
      if (!a) throw Object.assign(new Error(`No Vend16 app ${o.app} on this account`), { exit: EXIT.NO_APP, candidates: apps });
      return { app: a, created: false };
    }
    const matches = apps.filter((a) => (local?.bundleId && a.bundleId === local.bundleId) || (local?.packageName && a.packageName === local.packageName));
    if (matches.length === 1) return { app: matches[0], created: false };
    if (matches.length > 1) {
      if (!interactive) throw Object.assign(new Error(`More than one Vend16 app matches. Pass --app with one of: ${matches.map((m) => m.id).join(', ')}`), { exit: EXIT.NO_APP, candidates: matches });
      say('More than one Vend16 app matches this one:');
      matches.forEach((m, i) => say(`  ${i + 1}. ${m.name} (${m.id})`));
      const n = Number(await ask('Which one? ', '1'));
      return { app: matches[Math.max(1, Math.min(matches.length, n || 1)) - 1], created: false };
    }
    if (!create) throw Object.assign(new Error('No Vend16 app matches this app yet. Run vend16 init to create it.'), { exit: EXIT.NO_APP, candidates: apps });
    const name = o.name ?? local?.name ?? 'My app';
    const ok = await confirm(`Create a Vend16 app "${name}" (iOS ${local?.bundleId ?? 'none'}, Android ${local?.packageName ?? 'none'})?`, true);
    if (!ok) throw Object.assign(new Error('No app created.'), { exit: EXIT.NO_APP, candidates: apps });
    const app = await api.createApp({ name, bundleId: local?.bundleId, packageName: local?.packageName });
    say(`Created ${app.name} (${app.id}) on Vend16.`);
    return { app, created: true };
  }

  async function setupChecklist(appId) {
    try { return { items: await api.setup(appId), source: 'vend16' }; } catch (e) {
      if (e instanceof ApiError && (e.code === 'not_available' || e.status === 404)) return { items: fallbackChecklist(appId), source: 'generic' };
      throw e;
    }
  }

  function printChecklist(items) {
    say('');
    say('Still to set up:');
    for (const s of items) say(`  [${s.done ? 'x' : ' '}] ${s.label}${s.done ? '' : s.how ? `\n        ${s.how}` : ''}${!s.done && s.url ? `\n        ${s.url}` : ''}`);
  }

  const appSummary = (a) => a && { id: a.id, name: a.name, bundle_id: a.bundleId, package_name: a.packageName };
  const localSummary = (l) => l && { stack: l.stack, name: l.name, bundle_id: l.bundleId, package_name: l.packageName, root: l.root };

  try {
    switch (cmd) {
      case 'login': {
        if (creds.token && !o.force) {
          try {
            const a = await api.account();
            say(`Already signed in${a.email ? ` as ${a.email}` : ''}. (vend16 logout, or --force, to switch.)`);
            return finish(EXIT.OK, { signed_in: true, email: a.email });
          } catch { /* expired: sign in again */ }
        }
        const { email } = await deviceLogin();
        return finish(EXIT.OK, { signed_in: true, email });
      }

      case 'logout': {
        const had = clearCredentials(env);
        say(had ? 'Signed out on this computer.' : 'You were not signed in.');
        if (env.VEND16_TOKEN) say('VEND16_TOKEN is still set in your environment.');
        return finish(EXIT.OK, { signed_in: false });
      }

      case 'status': {
        const local = detect(root);
        if (!creds.token) {
          say('Not signed in. Run: vend16 login');
          return finish(EXIT.AUTH, { signed_in: false, local: localSummary(local) });
        }
        const account = await api.account();
        say(`Signed in as ${account.email ?? 'unknown'}${account.plan ? ` (${account.plan} plan)` : ''}.`);
        if (!local) { say(`No app found in ${root}.`); return finish(EXIT.OK, { signed_in: true, account, local: null }); }
        say(`${STACK_LABEL[local.stack]} app: iOS ${local.bundleId ?? 'none'}, Android ${local.packageName ?? 'none'}.`);
        let app = null;
        try { app = (await resolveApp(local, { create: false })).app; } catch (e) { if (e.exit !== EXIT.NO_APP) throw e; say(e.message); }
        let setup = null;
        if (app) {
          say(`Vend16 app: ${app.name} (${app.id}).`);
          setup = await setupChecklist(app.id);
          printChecklist(setup.items);
        }
        return finish(EXIT.OK, { signed_in: true, account, local: localSummary(local), app: appSummary(app), setup: setup?.items ?? null });
      }

      case 'keys': {
        const local = detect(root);
        await ensureLogin();
        const { app } = await resolveApp(local, { create: false });
        const pk = app.publicKey ?? (await api.publicKey(app.id));
        say(`${app.name} (${app.id})`);
        say(`Public key: ${pk}`);
        let secret = null;
        if (o['server-env']) {
          const path = resolve(root, o['server-env']);
          const ok = await confirm('Make a NEW secret key? The current one stops working straight away.', !!o.yes);
          if (!ok) return fail(EXIT.ERROR, 'Secret key not changed. Pass --yes to make a new one.', { app: appSummary(app), public_key: pk });
          const key = await api.createSecretKey(app.id);
          const result = writeSecretKey(root, path, key, { force: o.force });
          secret = { written_to: path, result };
          say(`Wrote VEND16_SECRET_KEY to ${path} (${result}). It is not shown anywhere else.`);
        }
        return finish(EXIT.OK, { app: appSummary(app), public_key: pk, secret_key: secret });
      }

      case 'init': {
        const local = detect(root);
        if (!local) {
          return fail(EXIT.NO_APP, `No Capacitor, React Native, Flutter, iOS or Android app found in ${root}. Run this in your app's folder, or pass --dir.`);
        }
        say(`Found a ${STACK_LABEL[local.stack]} app: iOS ${local.bundleId ?? 'none'}, Android ${local.packageName ?? 'none'}.`);
        for (const n of local.notes) say(`Note: ${n}`);
        if (!local.bundleId && !local.packageName) say('Note: no bundle ID or package name found. Add them on the app\'s Setup page later.');

        const account = await ensureLogin();
        const { app, created } = await resolveApp(local, { create: true });
        if (!created) say(`Using ${app.name} (${app.id}).`);

        const pk = app.publicKey ?? (await api.publicKey(app.id));
        if (!pk) return fail(EXIT.SERVER, 'Vend16 did not return a public key for this app.');
        const written = writePublicKey(local, pk);
        for (const f of written.files) say(`${f.result === 'unchanged' ? 'Already set' : 'Public key ' + f.result}: ${relative(root, f.path) || f.path}`);
        const manual = [...local.notes, ...written.manual];

        // Secret key: only into a server env file, only when asked.
        let secret = null;
        let serverEnv = o['server-env'];
        if (!serverEnv && interactive) {
          serverEnv = await ask('Does this app have its own server? Path to its env file for VEND16_SECRET_KEY (Enter to skip): ', '');
        }
        if (serverEnv) {
          const path = resolve(root, serverEnv);
          const ok = await confirm('Make a new secret key for that server? Any older secret key stops working.', true);
          if (ok) {
            const key = await api.createSecretKey(app.id);
            secret = { written_to: path, result: writeSecretKey(root, path, key, { force: o.force }) };
            say(`Wrote VEND16_SECRET_KEY to ${relative(root, path) || path}. It is not shown anywhere else.`);
          }
        } else {
          manual.push('No server env file given, so no secret key was made. Apps without their own server do not need one.');
        }

        // Store client.
        const plan = installPlan(local);
        let installed = [];
        if (o['skip-install']) {
          if (plan.steps.length) manual.push(`Install skipped. Run: ${plan.steps.map((s) => `${s.cmd} ${s.args.join(' ')}`).join(' && ')}`);
        } else if (plan.steps.length && (await confirm(`Run ${plan.steps.map((s) => `${s.cmd} ${s.args.join(' ')}`).join(', then ')}?`, true))) {
          installed = runInstall(local, plan, { run, log: say });
          if (installed.some((r) => !r.ok)) manual.push(`An install step failed: ${installed.find((r) => !r.ok).step}`);
        }
        manual.push(...plan.notes);

        const setup = await setupChecklist(app.id);
        printChecklist(setup.items);
        const target = publicKeyTarget(local);
        const next = [
          `Wire purchases into the code: ${RECIPES[local.stack]}`,
          target?.read ? `Read the public key with: ${target.read}` : null,
          'Full guide for agents: https://vend16.com/llms-full.txt',
        ].filter(Boolean);
        if (manual.length) { say(''); say('Notes:'); manual.forEach((m) => say(`  - ${m}`)); }
        say('');
        say('Next:');
        next.forEach((n) => say(`  - ${n}`));

        const failedInstall = installed.some((r) => !r.ok);
        return finish(failedInstall ? EXIT.ERROR : EXIT.OK, {
          account: { email: account.email },
          local: localSummary(local),
          app: appSummary(app),
          created,
          public_key: { written: written.files.map((f) => ({ path: f.path, result: f.result })), read_with: target?.read ?? null },
          secret_key: secret,
          install: installed,
          setup: setup.items,
          setup_source: setup.source,
          manual,
          next,
        });
      }

      case 'doctor': {
        const checks = [];
        const add = (id, ok, detail, level = 'error') => { checks.push({ id, ok, level: ok ? 'ok' : level, detail }); say(`${ok ? 'ok  ' : level === 'warn' ? 'warn' : 'FAIL'}  ${detail}`); };
        const major = Number(process.versions.node.split('.')[0]);
        add('node', major >= 20, `Node ${process.versions.node}${major >= 20 ? '' : ' (needs 20 or later)'}`);
        let account = null;
        if (!creds.token) add('signed_in', false, 'Not signed in. Run: vend16 login');
        else {
          try { account = await api.account(); add('signed_in', true, `Signed in as ${account.email ?? 'unknown'}`); } catch (e) { add('signed_in', false, `Sign-in not accepted by ${creds.api}: ${e.message}`); }
        }
        const local = detect(root);
        add('app', !!local, local ? `${STACK_LABEL[local.stack]} app in ${root}` : `No supported app in ${root}`);
        let app = null;
        if (local) {
          add('store_ids', !!(local.bundleId || local.packageName), `iOS ${local.bundleId ?? 'none'}, Android ${local.packageName ?? 'none'}`, 'warn');
          for (const n of local.notes) add('stack_note', false, n);
          const t = publicKeyTarget(local);
          if (t?.path) {
            let text = '';
            try { text = readFileSync(t.path, 'utf8'); } catch { /* missing */ }
            add('public_key', /pk_[A-Za-z0-9_-]{8,}/.test(text), /pk_/.test(text) ? `Public key found in ${relative(root, t.path)}` : `No public key in ${relative(root, t.path)}. Run: vend16 init`);
          }
          const ci = clientInstalled(local);
          if (ci.installed !== null) add('client', ci.installed, ci.installed ? 'Store client installed' : 'Store client not installed. Run: vend16 init');
          if (ci.ios !== null) add('ios_wired', ci.ios, ci.ios ? 'Plugin wired into the iOS project' : 'Plugin not in ios/App/CapApp-SPM/Package.swift. Run: npx cap sync');
          if (ci.android !== null) add('android_wired', ci.android, ci.android ? 'Plugin wired into the Android project' : 'Plugin not in android/capacitor.settings.gradle. Run: npx cap sync');
          const leaks = secretLeaks(root);
          if (leaks !== null) add('no_secret_in_git', leaks.length === 0, leaks.length ? `A secret key (sk_) is in files git tracks: ${leaks.join(', ')}. Rotate it on the Setup page and remove it.` : 'No secret key in files git tracks');
          if (account) {
            try {
              app = (await resolveApp(local, { create: false })).app;
              add('vend16_app', true, `Vend16 app ${app.name} (${app.id})`);
              const setup = await setupChecklist(app.id);
              for (const s of setup.items) add(`setup:${s.id ?? s.label}`, s.done, s.done ? s.label : `${s.label}${s.how ? `: ${s.how}` : ''}`, 'warn');
            } catch (e) { add('vend16_app', false, e.message); }
          }
        }
        const failed = checks.some((c) => c.level === 'error');
        return finish(failed ? EXIT.ERROR : EXIT.OK, { checks, app: appSummary(app) });
      }

      default:
        stderr.write(`vend16: unknown command "${cmd}". Run vend16 --help.\n`);
        return finish(EXIT.USAGE, { error: `unknown command ${cmd}` });
    }
  } catch (e) {
    if (e?.exit) return fail(e.exit, e.message, e.candidates ? { candidates: e.candidates.map(appSummary) } : {});
    if (e instanceof ApiError && e.code === 'access_denied') return fail(EXIT.AUTH, 'Sign-in was declined.');
    if (e instanceof ApiError && e.code === 'expired_token') return fail(EXIT.AUTH, e.message);
    return fail(exitFor(e), e?.message ?? String(e), e instanceof ApiError ? { code: e.code, status: e.status } : {});
  }
}

/** Files git tracks that hold something shaped like a Vend16 secret key. null outside a repo. */
function secretLeaks(root) {
  try {
    const out = execFileSync('git', ['grep', '-l', '-E', 'sk_[A-Za-z0-9_-]{24,}'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // git grep found nothing
    return null; // not a repo, or no git
  }
}
