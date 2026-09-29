import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Android project must not be packaged with a browser build.
 *
 * This caught a real failure: `bun run build` (browser mode) overwrites `dist/`, so
 * running it after `build:native` leaves a `dist/` with no API base. `cap sync` then
 * copies that into the APK, and the result installs cleanly and fails at runtime with
 * nothing in the app to explain why — every request resolves against the shell's own
 * local origin, which serves no API.
 *
 * The assertion is deliberately hard-failing rather than skipped. An earlier version
 * returned early when the directory was missing, which meant a silent pass; it survived
 * a mutation that stripped the origin from the packaged bundle. A guard that cannot
 * fail is worse than no guard, because it reads like coverage.
 */

// `import.meta.dir` is `<repo>/src/lib/native`, so the repo root is three levels up.
const ROOT = join(import.meta.dir, '..', '..', '..');
const ANDROID_ASSETS = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'assets');
const NATIVE_BASE = 'https://tessera.ivanderseah08.workers.dev';

describe('android bundle', () => {
  test('the packaged web bundle points at the Worker', () => {
    if (!existsSync(join(ROOT, 'android'))) {
      // No Android project generated in this checkout — `npx cap add android` has not
      // run. Nothing is packaged, so there is nothing that could be wrong.
      return;
    }

    expect(existsSync(ANDROID_ASSETS)).toBe(true);
    const bundles = readdirSync(ANDROID_ASSETS).filter((name) => name.startsWith('index-') && name.endsWith('.js'));
    expect(bundles.length).toBeGreaterThan(0);

    const withOrigin = bundles.filter((name) =>
      readFileSync(join(ANDROID_ASSETS, name), 'utf8').includes(NATIVE_BASE),
    );
    expect(withOrigin.length).toBeGreaterThan(0);
  });

  test('.env.native defines the origin the Android bundle is checked against', () => {
    const env = readFileSync(join(ROOT, '.env.native'), 'utf8');
    // If this file changes, the assertion above must change with it — otherwise the
    // guard silently starts checking for a string nothing produces.
    expect(env).toContain(NATIVE_BASE);
  });
});
