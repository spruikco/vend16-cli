import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/detect.js';
import { fixture, PBXPROJ, GRADLE, GRADLE_KTS, PLIST } from './helpers.js';

test('Capacitor with Vite: IDs from the native projects, framework vite', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { '@capacitor/core': '^8.1.0' }, devDependencies: { vite: '^6' } }),
    'capacitor.config.ts': "const config = { appId: 'com.example.shop', appName: 'Shop', webDir: 'dist' };\nexport default config;",
    'ios/App/App.xcodeproj/project.pbxproj': PBXPROJ('com.example.shop'),
    'android/app/build.gradle': GRADLE('com.example.shop'),
  });
  const d = detect(root);
  assert.equal(d.stack, 'capacitor');
  assert.equal(d.name, 'Shop');
  assert.equal(d.framework, 'vite');
  assert.equal(d.bundleId, 'com.example.shop');
  assert.equal(d.packageName, 'com.example.shop');
  assert.equal(d.capacitorMajor, 8);
  assert.deepEqual(d.notes, []);
});

test('Capacitor 7 gets a note; appId stands in when there are no native folders yet', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { '@capacitor/core': '7.2.0' } }),
    'capacitor.config.json': JSON.stringify({ appId: 'com.example.old', appName: 'Old', webDir: 'www' }),
    'yarn.lock': '',
  });
  const d = detect(root);
  assert.equal(d.bundleId, 'com.example.old');
  assert.equal(d.packageManager, 'yarn');
  assert.match(d.notes[0], /needs Capacitor 8/);
});

test('React Native: bundle ID skips test targets and variables', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'rn', dependencies: { 'react-native': '0.76.0' } }),
    'ios/rn.xcodeproj/project.pbxproj': PBXPROJ('com.example.rn'),
    'android/app/build.gradle': GRADLE('com.example.rn.android'),
  });
  const d = detect(root);
  assert.equal(d.stack, 'react-native');
  assert.equal(d.bundleId, 'com.example.rn');
  assert.equal(d.packageName, 'com.example.rn.android');
});

test('Expo: IDs from app.json', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { expo: '~52.0.0', 'react-native': '0.76.0' } }),
    'app.json': JSON.stringify({ expo: { name: 'Pantry', ios: { bundleIdentifier: 'com.example.pantry' }, android: { package: 'com.example.pantry' } } }),
  });
  const d = detect(root);
  assert.equal(d.stack, 'expo');
  assert.equal(d.name, 'Pantry');
  assert.equal(d.bundleId, 'com.example.pantry');
});

test('Flutter: Kotlin DSL applicationId and Runner bundle ID', () => {
  const root = fixture({
    'pubspec.yaml': 'name: pantry_app\nflutter:\n  uses-material-design: true\n',
    'ios/Runner.xcodeproj/project.pbxproj': PBXPROJ('com.example.pantryApp'),
    'android/app/build.gradle.kts': GRADLE_KTS('com.example.pantry_app'),
  });
  const d = detect(root);
  assert.equal(d.stack, 'flutter');
  assert.equal(d.name, 'pantry_app');
  assert.equal(d.bundleId, 'com.example.pantryApp');
  assert.equal(d.packageName, 'com.example.pantry_app');
});

test('Native iOS and Android side by side', () => {
  const root = fixture({
    'Pantry.xcodeproj/project.pbxproj': PBXPROJ('com.example.native'),
    'Pantry/Info.plist': PLIST,
    'android/settings.gradle': "include ':app'",
    'android/app/build.gradle': GRADLE('com.example.native'),
  });
  const d = detect(root);
  assert.equal(d.stack, 'native');
  assert.equal(d.name, 'Pantry');
  assert.equal(d.bundleId, 'com.example.native');
  assert.equal(d.packageName, 'com.example.native');
});

test('Nothing supported: null', () => {
  assert.equal(detect(fixture({ 'README.md': 'hi', 'package.json': '{"name":"site"}' })), null);
});
