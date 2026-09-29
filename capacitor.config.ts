import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell for Tessera. Wraps the existing `dist/` build — `webDir: 'dist'` points at
 * the same Vite output the Worker serves, so there is no second codebase and no forked UI.
 *
 * The native project itself is not checked in. Generate it once with `npx cap add android`;
 * see WRAPPERS.md. The AndroidManifest intent-filter for share-sheet card import is also
 * documented there, because it has to be added to the generated file.
 */
const config: CapacitorConfig = {
  appId: 'app.tessera.client',
  appName: 'Tessera',
  webDir: 'dist',

  /**
   * CapacitorHttp is deliberately NOT enabled, and must stay that way.
   *
   * Enabling it makes the native bridge replace `window.fetch` with a shim that performs
   * the request natively and only then constructs a `Response` from the completed body —
   * so `response.body` is never a live stream and SSE arrives in one lump at the end. It
   * also does not patch `EventSource` at all, which is a separate half of the same gap:
   * https://github.com/ionic-team/capacitor/issues/6582
   *
   * Tessera streams every reply, so this is not a preference. `src/lib/native/sse.ts`
   * asserts at startup that `window.fetch` is still the webview's own implementation
   * (`window.CapacitorWebFetch`) and names this issue if it is not.
   *
   * Setting it explicitly to `false` also documents the intent — the Capacitor default is
   * already `false`, so this is a guard against someone "turning it on to fix CORS".
   */
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
  },

  /**
   * Sideloaded only. Google Play's AI-Generated Content policy lists "generative AI
   * applications primarily intended to be sexually gratifying" as violative, and chub.ai's
   * own Play listing (`ai.chub` / `com.chub.ai`) is 404 — this is a documented pattern, not
   * a risk to manage. No store submission is planned. See WRAPPERS.md.
   */
};

export default config;
