// Works out what kind of app lives in a folder, and its store IDs.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const json = (p) => { const t = read(p); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Every dependency name in package.json. */
function deps(pkg) {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

/** The first `appId` / `applicationId` style value in a config or Gradle file. */
function firstMatch(text, re) {
  if (!text) return null;
  const m = re.exec(text);
  return m ? m[1] : null;
}

/** applicationId from android/app/build.gradle(.kts), or the manifest's package as a fallback. */
export function androidApplicationId(androidDir) {
  const app = join(androidDir, 'app');
  const gradle = read(join(app, 'build.gradle')) ?? read(join(app, 'build.gradle.kts'));
  const id = firstMatch(gradle, /applicationId\s*=?\s*["']([\w.]+)["']/);
  if (id) return id;
  const manifest = read(join(app, 'src', 'main', 'AndroidManifest.xml'));
  return firstMatch(manifest, /<manifest[^>]*\spackage="([\w.]+)"/);
}

/** PRODUCT_BUNDLE_IDENTIFIER of the app target in the first .xcodeproj under iosDir (skipping tests and variables). */
export function iosBundleId(iosDir) {
  const proj = findXcodeproj(iosDir);
  if (!proj) return null;
  const pbx = read(join(proj, 'project.pbxproj'));
  if (!pbx) return null;
  const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\s]+)"?\s*;/g)].map((m) => m[1])
    .filter((id) => !id.includes('$') && !/tests?$/i.test(id) && !/\.(share|widget|extension|notification|watchkit)/i.test(id));
  if (!ids.length) return null;
  // The app's own ID is usually the shortest (extensions add a suffix).
  return ids.sort((a, b) => a.length - b.length)[0];
}

export function findXcodeproj(dir, depth = 2) {
  if (!isDir(dir)) return null;
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  const here = entries.find((e) => e.endsWith('.xcodeproj') && !e.startsWith('Pods'));
  if (here) return join(dir, here);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules' || e === 'Pods' || e === 'build') continue;
    const p = join(dir, e);
    if (isDir(p)) {
      const found = findXcodeproj(p, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function packageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function webFramework(root, d) {
  if (d.vite || ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].some((f) => existsSync(join(root, f)))) return 'vite';
  if (d.next) return 'next';
  if (d['react-scripts']) return 'cra';
  if (d['@angular/core']) return 'angular';
  if (d.nuxt) return 'nuxt';
  return null;
}

/**
 * Detect the app in `root`. Returns:
 * { stack: 'capacitor'|'react-native'|'expo'|'flutter'|'native', root, name,
 *   bundleId, packageName, packageManager, framework, notes: [] }
 * or null when nothing supported is here.
 */
export function detect(root) {
  const pkg = json(join(root, 'package.json'));
  const d = deps(pkg);
  const notes = [];
  const base = { root, name: pkg?.name ?? basename(root), packageManager: pkg ? packageManager(root) : null, framework: null, notes };

  // Capacitor
  const capConfig = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json'].map((f) => join(root, f)).find(existsSync);
  if (capConfig || d['@capacitor/core']) {
    const text = capConfig ? read(capConfig) : '';
    const appId = capConfig?.endsWith('.json') ? json(capConfig)?.appId : firstMatch(text, /appId\s*:\s*['"`]([\w.]+)['"`]/);
    const appName = capConfig?.endsWith('.json') ? json(capConfig)?.appName : firstMatch(text, /appName\s*:\s*['"`]([^'"`]+)['"`]/);
    const major = Number(String(d['@capacitor/core'] ?? '').replace(/^[^\d]*/, '').split('.')[0]) || null;
    if (major && major < 8) notes.push(`@capacitor/core is version ${major}; @spruik/capacitor-iap needs Capacitor 8.`);
    const iosId = existsSync(join(root, 'ios')) ? iosBundleId(join(root, 'ios')) : null;
    const androidId = existsSync(join(root, 'android')) ? androidApplicationId(join(root, 'android')) : null;
    return {
      ...base,
      stack: 'capacitor',
      name: appName ?? base.name,
      capacitorMajor: major,
      framework: webFramework(root, d),
      bundleId: iosId ?? appId ?? null,
      packageName: androidId ?? appId ?? null,
    };
  }

  // Expo (managed or prebuilt)
  if (d.expo) {
    const app = json(join(root, 'app.json'))?.expo ?? {};
    return {
      ...base,
      stack: 'expo',
      name: app.name ?? base.name,
      bundleId: app.ios?.bundleIdentifier ?? (existsSync(join(root, 'ios')) ? iosBundleId(join(root, 'ios')) : null),
      packageName: app.android?.package ?? (existsSync(join(root, 'android')) ? androidApplicationId(join(root, 'android')) : null),
    };
  }

  // React Native (bare)
  if (d['react-native']) {
    return {
      ...base,
      stack: 'react-native',
      bundleId: existsSync(join(root, 'ios')) ? iosBundleId(join(root, 'ios')) : null,
      packageName: existsSync(join(root, 'android')) ? androidApplicationId(join(root, 'android')) : null,
    };
  }

  // Flutter
  const pubspec = read(join(root, 'pubspec.yaml'));
  if (pubspec && /^\s*flutter\s*:/m.test(pubspec)) {
    return {
      ...base,
      stack: 'flutter',
      name: firstMatch(pubspec, /^name:\s*([\w-]+)/m) ?? base.name,
      packageManager: 'flutter',
      bundleId: existsSync(join(root, 'ios')) ? iosBundleId(join(root, 'ios')) : null,
      packageName: existsSync(join(root, 'android')) ? androidApplicationId(join(root, 'android')) : null,
    };
  }

  // Native iOS and/or Android
  const xcodeproj = findXcodeproj(root, 1);
  const gradleRoot = ['settings.gradle', 'settings.gradle.kts'].some((f) => existsSync(join(root, f)))
    ? root
    : ['settings.gradle', 'settings.gradle.kts'].some((f) => existsSync(join(root, 'android', f))) ? join(root, 'android') : null;
  if (xcodeproj || gradleRoot) {
    return {
      ...base,
      stack: 'native',
      name: xcodeproj ? basename(xcodeproj, '.xcodeproj') : base.name,
      packageManager: null,
      bundleId: xcodeproj ? iosBundleId(root) : null,
      packageName: gradleRoot ? androidApplicationId(gradleRoot) : null,
      xcodeproj,
      gradleRoot,
    };
  }

  return null;
}

export const STACK_LABEL = {
  capacitor: 'Capacitor',
  expo: 'Expo (React Native)',
  'react-native': 'React Native',
  flutter: 'Flutter',
  native: 'Native iOS / Android',
};
