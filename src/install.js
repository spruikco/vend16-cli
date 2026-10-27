// Installs the store client each kind of app needs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CAPACITOR_PLUGIN = 'github:spruikco/capacitor-iap';

const ADD = { npm: ['install'], pnpm: ['add'], yarn: ['add'], bun: ['add'] };

/** What `install` would run for this app: [{cmd, args, why}], plus notes for what cannot be automated. */
export function installPlan(app) {
  const pm = app.packageManager ?? 'npm';
  const has = (name) => {
    try {
      const pkg = JSON.parse(readFileSync(join(app.root, 'package.json'), 'utf8'));
      return !!({ ...pkg.dependencies, ...pkg.devDependencies })[name];
    } catch { return false; }
  };
  if (app.stack === 'capacitor') {
    const steps = [];
    if (!has('@spruik/capacitor-iap')) steps.push({ cmd: pm, args: [...ADD[pm], CAPACITOR_PLUGIN], why: 'StoreKit 2 and Play Billing plugin' });
    steps.push({ cmd: 'npx', args: ['cap', 'sync'], why: 'wire the plugin into ios/ and android/' });
    return { steps, notes: [] };
  }
  if (app.stack === 'react-native' || app.stack === 'expo') {
    const steps = has('react-native-iap') ? [] : [{ cmd: pm, args: [...ADD[pm], 'react-native-iap'], why: 'StoreKit 2 and Play Billing for React Native' }];
    const notes = app.stack === 'expo'
      ? ['Expo: react-native-iap needs a development build (npx expo prebuild, or EAS Build). Expo Go cannot make purchases.']
      : ['iOS: run `cd ios && pod install` on a Mac before the next build.'];
    return { steps, notes };
  }
  if (app.stack === 'flutter') {
    const pub = (() => { try { return readFileSync(join(app.root, 'pubspec.yaml'), 'utf8'); } catch { return ''; } })();
    const want = ['in_app_purchase', 'http'].filter((p) => !new RegExp(`^\\s+${p}\\s*:`, 'm').test(pub));
    return { steps: want.length ? [{ cmd: 'flutter', args: ['pub', 'add', ...want], why: 'the official in_app_purchase plugin, and http for Vend16' }] : [], notes: [] };
  }
  if (app.stack === 'native') {
    const notes = [];
    if (app.bundleId) notes.push('iOS: StoreKit 2 is built in. Nothing to install.');
    if (app.packageName) notes.push('Android: add implementation("com.android.billingclient:billing-ktx:7.1.1") to app/build.gradle(.kts) if it is not there.');
    return { steps: [], notes };
  }
  return { steps: [], notes: [] };
}

/** Run the plan. `run` is injectable for tests. Returns [{step, ok, status}]. */
export function runInstall(app, plan, { run = defaultRun, log = () => {} } = {}) {
  const results = [];
  for (const step of plan.steps) {
    log(`$ ${step.cmd} ${step.args.join(' ')}`);
    const status = run(step.cmd, step.args, app.root);
    results.push({ step: `${step.cmd} ${step.args.join(' ')}`, ok: status === 0, status });
    if (status !== 0) break;
  }
  return results;
}

function defaultRun(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  return r.status ?? 1;
}

/** For doctor: is the client package there and wired? */
export function clientInstalled(app) {
  if (app.stack === 'capacitor') {
    const inModules = existsSync(join(app.root, 'node_modules', '@spruik', 'capacitor-iap', 'package.json'));
    const spm = readOr(join(app.root, 'ios', 'App', 'CapApp-SPM', 'Package.swift'));
    const gradle = readOr(join(app.root, 'android', 'capacitor.settings.gradle'));
    return {
      installed: inModules,
      ios: existsSync(join(app.root, 'ios')) ? spm.includes('SpruikCapacitorIap') : null,
      android: existsSync(join(app.root, 'android')) ? gradle.includes('spruik-capacitor-iap') : null,
    };
  }
  if (app.stack === 'react-native' || app.stack === 'expo') return { installed: existsSync(join(app.root, 'node_modules', 'react-native-iap', 'package.json')), ios: null, android: null };
  if (app.stack === 'flutter') return { installed: /^\s+in_app_purchase\s*:/m.test(readOr(join(app.root, 'pubspec.yaml'))), ios: null, android: null };
  return { installed: null, ios: null, android: null };
}

const readOr = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
