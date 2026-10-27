import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, fakeVend16, fixture, SECRET, TOKEN, PBXPROJ, GRADLE, PLIST } from './helpers.js';

const capApp = () => fixture({
  'package.json': JSON.stringify({ name: 'shop', dependencies: { '@capacitor/core': '^8.1.0' }, devDependencies: { vite: '^6' } }),
  'capacitor.config.ts': "export default { appId: 'com.example.shop', appName: 'Shop', webDir: 'dist' };",
  'ios/App/App.xcodeproj/project.pbxproj': PBXPROJ('com.example.shop'),
  'android/app/build.gradle': GRADLE('com.example.shop'),
});

const PK = 'pk_' + 'K'.repeat(32);
const existing = (over = {}) => ({ id: 'app_shop', name: 'Shop', bundle_id: 'com.example.shop', package_name: 'com.example.shop', public_key: PK, ...over });

test('login: device code, waits while pending, saves the token', async () => {
  const s = await fakeVend16({ pendingPolls: 2 });
  try {
    const r = await cli(['login', '--json'], { base: s.base, signedIn: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /WXYZ-1234/);
    assert.match(r.stderr, /vend16\.com\/activate/);
    assert.equal(r.json.email, 'dev@example.com');
    const saved = JSON.parse(readFileSync(join(r.configDir, 'credentials.json'), 'utf8'));
    assert.equal(saved.token, TOKEN);
    assert.equal(s.calls.filter((c) => c.url === '/v1/device/token').length, 3);
    assert.equal(s.calls.find((c) => c.url === '/v1/device/token').body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  } finally { await s.close(); }
});

test('login: declined in the browser exits 3', async () => {
  const s = await fakeVend16({ deny: true });
  try {
    const r = await cli(['login', '--json'], { base: s.base, signedIn: false });
    assert.equal(r.code, 3);
    assert.match(r.json.error, /declined/);
  } finally { await s.close(); }
});

test('init --yes on a new Capacitor app: creates the app, writes the key, installs, prints the checklist', async () => {
  const s = await fakeVend16();
  const root = capApp();
  try {
    const r = await cli(['init', '--yes', '--json', '--dir', root], { base: s.base });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.created, true);
    assert.equal(r.json.app.bundle_id, 'com.example.shop');
    const created = s.calls.find((c) => c.method === 'POST' && c.url === '/v1/apps');
    assert.deepEqual(created.body, { name: 'Shop', bundle_id: 'com.example.shop', package_name: 'com.example.shop' });
    assert.match(readFileSync(join(root, '.env'), 'utf8'), /^VITE_VEND16_PUBLIC_KEY=pk_P{32}$/m);
    assert.equal(r.json.public_key.read_with, 'import.meta.env.VITE_VEND16_PUBLIC_KEY');
    assert.deepEqual(r.runs, ['npm install github:spruikco/capacitor-iap', 'npx cap sync']);
    assert.equal(r.json.setup_source, 'vend16');
    assert.equal(r.json.setup.length, 2);
    assert.equal(s.state.secretsMade, 0, 'no secret key without --server-env');
    assert.match(r.json.next[0], /capacitor-iap\/blob\/main\/AGENTS\.md/);
  } finally { await s.close(); }
});

test('init picks the existing app by bundle ID and runs again without changes', async () => {
  const s = await fakeVend16({ apps: [existing(), existing({ id: 'app_other', bundle_id: 'com.example.other', package_name: 'com.example.other' })] });
  const root = capApp();
  try {
    const a = await cli(['init', '--yes', '--json', '--skip-install', '--dir', root], { base: s.base });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.json.created, false);
    assert.equal(a.json.app.id, 'app_shop');
    assert.equal(a.json.public_key.written[0].result, 'added');
    assert.deepEqual(a.runs, []);
    assert.ok(a.json.manual.some((m) => /Install skipped/.test(m)));
    const b = await cli(['init', '--yes', '--json', '--skip-install', '--dir', root], { base: s.base });
    assert.equal(b.json.public_key.written[0].result, 'unchanged');
  } finally { await s.close(); }
});

test('init with two matching apps and no --app: exit 4 with the candidates', async () => {
  const s = await fakeVend16({ apps: [existing(), existing({ id: 'app_shop2' })] });
  try {
    const r = await cli(['init', '--yes', '--json', '--skip-install', '--dir', capApp()], { base: s.base });
    assert.equal(r.code, 4);
    assert.deepEqual(r.json.candidates.map((c) => c.id), ['app_shop', 'app_shop2']);
    const ok = await cli(['init', '--yes', '--json', '--skip-install', '--app', 'app_shop2', '--dir', capApp()], { base: s.base });
    assert.equal(ok.code, 0);
    assert.equal(ok.json.app.id, 'app_shop2');
  } finally { await s.close(); }
});

test('init --server-env: the secret key goes into the env file and never into output', async () => {
  const s = await fakeVend16({ apps: [existing()] });
  const root = capApp();
  try {
    const r = await cli(['init', '--yes', '--json', '--skip-install', '--server-env', 'server/.env', '--dir', root], { base: s.base });
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(join(root, 'server', '.env'), 'utf8'), new RegExp(`^VEND16_SECRET_KEY=${SECRET}$`, 'm'));
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'secret never printed');
    assert.equal(r.json.secret_key.result, 'added');
  } finally { await s.close(); }
});

test('the secret key is refused for an env file git tracks or does not ignore', async () => {
  const s = await fakeVend16({ apps: [existing()] });
  const root = capApp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'tracked.env'), 'A=1\n');
    execFileSync('git', ['add', 'tracked.env'], { cwd: root });
    const tracked = await cli(['init', '--yes', '--json', '--skip-install', '--server-env', 'tracked.env', '--dir', root], { base: s.base });
    assert.equal(tracked.code, 1);
    assert.match(tracked.json.error, /tracked by git/);
    assert.ok(!readFileSync(join(root, 'tracked.env'), 'utf8').includes('sk_'));
    const loose = await cli(['init', '--yes', '--json', '--skip-install', '--server-env', 'loose.env', '--dir', root], { base: s.base });
    assert.equal(loose.code, 1);
    assert.match(loose.json.error, /not git-ignored/);
    writeFileSync(join(root, '.gitignore'), 'loose.env\n');
    const ok = await cli(['init', '--yes', '--json', '--skip-install', '--server-env', 'loose.env', '--dir', root], { base: s.base });
    assert.equal(ok.code, 0, ok.stderr);
  } finally { await s.close(); }
});

test('keys: public key only; a new secret needs --yes and goes to the file', async () => {
  const s = await fakeVend16({ apps: [existing()] });
  const root = capApp();
  try {
    const r = await cli(['keys', '--json', '--dir', root], { base: s.base });
    assert.equal(r.code, 0);
    assert.equal(r.json.public_key, PK);
    const no = await cli(['keys', '--json', '--server-env', 'api.env', '--dir', root], { base: s.base });
    assert.equal(no.code, 1);
    assert.equal(s.state.secretsMade, 0);
    const yes = await cli(['keys', '--json', '--yes', '--server-env', 'api.env', '--dir', root], { base: s.base });
    assert.equal(yes.code, 0, yes.stderr);
    assert.ok(existsSync(join(root, 'api.env')));
    assert.ok(!yes.stdout.includes(SECRET));
  } finally { await s.close(); }
});

test('setup endpoint not there yet: the generic checklist, with the Apple notifications URL', async () => {
  const s = await fakeVend16({ apps: [existing()], setup: 'missing' });
  try {
    const r = await cli(['init', '--yes', '--json', '--skip-install', '--dir', capApp()], { base: s.base });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.setup_source, 'generic');
    assert.ok(r.json.setup.some((i) => i.how?.includes('/v1/notifications/apple/app_shop')));
  } finally { await s.close(); }
});

test('native app: key into Android resources and the iOS Info.plist', async () => {
  const s = await fakeVend16({ apps: [existing({ bundle_id: 'com.example.native', package_name: 'com.example.native' })] });
  const root = fixture({
    'Pantry.xcodeproj/project.pbxproj': PBXPROJ('com.example.native'),
    'Pantry/Info.plist': PLIST,
    'android/settings.gradle': "include ':app'",
    'android/app/build.gradle': GRADLE('com.example.native'),
  });
  try {
    const r = await cli(['init', '--yes', '--json', '--dir', root], { base: s.base });
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(join(root, 'android/app/src/main/res/values/vend16.xml'), 'utf8'), new RegExp(`name="vend16_public_key"[^>]*>${PK}<`));
    assert.match(readFileSync(join(root, 'Pantry/Info.plist'), 'utf8'), new RegExp(`<key>Vend16PublicKey</key>\\s*<string>${PK}</string>`));
    assert.deepEqual(r.runs, [], 'nothing to install for native');
  } finally { await s.close(); }
});

test('status when signed out exits 3; a bad VEND16_TOKEN exits 3', async () => {
  const s = await fakeVend16();
  try {
    const out = await cli(['status', '--json'], { base: s.base, signedIn: false });
    assert.equal(out.code, 3);
    const bad = await cli(['init', '--yes', '--json', '--dir', capApp()], { base: s.base, signedIn: false, env: { VEND16_TOKEN: 'at_wrong' } });
    assert.equal(bad.code, 3);
  } finally { await s.close(); }
});

test('no app here exits 4; Vend16 down exits 5; a bad flag exits 2', async () => {
  const s = await fakeVend16();
  try {
    const none = await cli(['init', '--yes', '--json', '--dir', fixture({ 'README.md': 'x' })], { base: s.base });
    assert.equal(none.code, 4);
  } finally { await s.close(); }
  const down = await cli(['status', '--json', '--dir', capApp()], { base: 'http://127.0.0.1:9' });
  assert.equal(down.code, 5);
  const usage = await cli(['init', '--nope'], { base: 'http://127.0.0.1:9' });
  assert.equal(usage.code, 2);
});

test('doctor: points at what is missing and exits 1', async () => {
  const s = await fakeVend16({ apps: [existing()] });
  try {
    const r = await cli(['doctor', '--json', '--dir', capApp()], { base: s.base });
    assert.equal(r.code, 1);
    const byId = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
    assert.equal(byId.signed_in.ok, true);
    assert.equal(byId.public_key.ok, false);
    assert.equal(byId.client.ok, false);
    assert.equal(byId.vend16_app.ok, true);
  } finally { await s.close(); }
});
