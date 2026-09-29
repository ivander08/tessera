/**
 * Native-shell streaming guard.
 *
 * Tessera streams every reply as SSE — `src/lib/sse.ts` reads `response.body`
 * incrementally, one `data:` frame at a time. Both native wrappers ship a way to
 * break that, and both breaks are *silent*: the body arrives complete, once, at the
 * end, so the chat merely looks slow and the cache meter never moves. Nothing throws.
 * This module is the tripwire for that.
 *
 * - **Capacitor.** `CapacitorHttp`, when enabled, replaces `window.fetch` with a
 *   bridge that awaits the whole response natively and then constructs a `Response`
 *   from a string. It also does not patch `EventSource` at all.
 *   https://github.com/ionic-team/capacitor/issues/6582
 * - **Tauri.** `@tauri-apps/plugin-http`'s `fetch` reads the response to completion on
 *   the Rust side before the first chunk crosses the IPC boundary.
 *   https://github.com/tauri-apps/plugins-workspace/issues/2415 (duplicate #2129)
 *
 * The fix is identical in both cases and is what `nativeFetch()` hands back: the
 * webview's own `fetch`. Do not "optimize" SSE back onto a plugin or bridge HTTP
 * client — there is no configuration flag that makes either of them stream, and
 * both issues are still open.
 *
 * Importable from the browser bundle and from the Worker: no Node APIs, no top-level
 * side effects, every probe is inside a function and reads `globalThis` defensively.
 */

/** Which shell the app is running inside, if any. */
export type NativeShell = 'capacitor' | 'tauri' | 'browser';

export interface StreamingCheck {
  ok: boolean;
  /** Human-readable diagnosis naming the fix. Always populated, pass or fail. */
  reason: string;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

interface AndroidHttpInterface {
  isEnabled?: () => boolean;
}

interface TauriGlobal {
  http?: { fetch?: unknown };
}

/** `globalThis` as an indexable bag. The Worker has no `window`, so never touch it. */
function globals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function asFetch(value: unknown): FetchFn | null {
  return typeof value === 'function' ? (value as FetchFn) : null;
}

/**
 * True under Capacitor or Tauri, false in a plain browser tab.
 *
 * `window.Capacitor` exists on the web too whenever `@capacitor/core` has been
 * imported, so its mere presence is not the test — `isNativePlatform()` is.
 */
export function detectNativeShell(): NativeShell {
  const g = globals();

  const capacitor = g.Capacitor as CapacitorGlobal | undefined;
  if (capacitor && typeof capacitor.isNativePlatform === 'function') {
    try {
      if (capacitor.isNativePlatform() === true) return 'capacitor';
    } catch {
      // A probe that throws is not a native shell; fall through.
    }
  }

  // Tauri injects both of these as initialization scripts on the main frame.
  if (g.isTauri === true || g.__TAURI_INTERNALS__ !== undefined) return 'tauri';

  return 'browser';
}

export function isNativeShell(): boolean {
  return detectNativeShell() !== 'browser';
}

/**
 * Android's CapacitorHttp plugin installs a JS interface whose `isEnabled()` reads the
 * live `plugins.CapacitorHttp.enabled` config. It is the only synchronous, authoritative
 * answer available, and it exists on Android only — iOS reports the same value through a
 * `prompt()` round-trip inside the Capacitor bridge, which is not something to trigger
 * from library code. `null` therefore means "cannot tell", not "disabled".
 */
function capacitorHttpEnabledOnAndroid(): boolean | null {
  const iface = globals().CapacitorHttpAndroidInterface as AndroidHttpInterface | undefined;
  if (!iface || typeof iface.isEnabled !== 'function') return null;
  try {
    return iface.isEnabled() === true;
  } catch {
    return null;
  }
}

/**
 * The Capacitor bridge saves the webview's untouched `fetch` to `window.CapacitorWebFetch`
 * *before* deciding whether to patch, and only overwrites `window.fetch` when the patch
 * runs. So a plain identity comparison is an exact answer on both Android and iOS, with no
 * probe and no side effect.
 *
 * Note what is deliberately *not* used as the signal: `Capacitor.Plugins.CapacitorHttp` is
 * always populated by `registerPlugin` in `@capacitor/core`, and Android's
 * `CapacitorHttp` plugin is always registered by `Bridge.registerAllPlugins` — so the
 * plugin being "present" says nothing about whether requests are patched. `enabled` is
 * what decides, and that is what the identity check measures.
 */
function capacitorFetchWasReplaced(): boolean | null {
  const g = globals();
  const original = asFetch(g.CapacitorWebFetch);
  const current = asFetch(g.fetch);
  if (!original || !current) return null;
  return original !== current;
}

/**
 * Under `withGlobalTauri` the plugin's `fetch` is reachable as `__TAURI__.http.fetch`. It
 * is never assigned to `window.fetch` by Tauri itself — routing SSE through it is a code
 * choice, not a runtime state — but if that assignment did happen, this catches it.
 */
function tauriFetchWasReplaced(): boolean {
  const g = globals();
  const tauri = g.__TAURI__ as TauriGlobal | undefined;
  const pluginFetch = asFetch(tauri?.http?.fetch);
  const current = asFetch(g.fetch);
  return pluginFetch !== null && pluginFetch === current;
}

/**
 * Diagnoses whether the current fetch implementation can stream a response body.
 *
 * Call once at startup and log a failing `reason`; the string names the fix rather than
 * merely describing the symptom, because the failure is invisible otherwise.
 */
export function assertNativeStreaming(): StreamingCheck {
  const shell = detectNativeShell();

  if (shell === 'browser') {
    return {
      ok: true,
      reason: 'Not a native shell: the browser fetch streams response bodies natively.',
    };
  }

  if (shell === 'capacitor') {
    const androidEnabled = capacitorHttpEnabledOnAndroid();
    if (androidEnabled === true) {
      return {
        ok: false,
        reason:
          'CapacitorHttp is enabled — disable it (plugins.CapacitorHttp.enabled = false). ' +
          'Its patched window.fetch buffers the whole body and it does not patch EventSource, ' +
          'so SSE cannot stream: https://github.com/ionic-team/capacitor/issues/6582',
      };
    }

    const replaced = capacitorFetchWasReplaced();
    if (replaced === true) {
      return {
        ok: false,
        reason:
          'CapacitorHttp is enabled — disable it (plugins.CapacitorHttp.enabled = false). ' +
          'window.fetch is not the webview fetch (it differs from window.CapacitorWebFetch), ' +
          'so response bodies are buffered before JS sees them: ' +
          'https://github.com/ionic-team/capacitor/issues/6582. ' +
          'Use nativeFetch() from src/lib/native/sse.ts for SSE.',
      };
    }

    if (replaced === null) {
      return {
        ok: false,
        reason:
          'Capacitor native shell detected but the webview fetch could not be identified: ' +
          'window.CapacitorWebFetch or window.fetch is missing. Do not route SSE through a ' +
          'bridge client; verify the app is running with the stock Capacitor bridge.',
      };
    }

    return {
      ok: true,
      reason:
        'Capacitor native shell with the webview fetch intact — SSE streams. ' +
        'Keep CapacitorHttp disabled: it buffers the body and does not patch EventSource ' +
        '(https://github.com/ionic-team/capacitor/issues/6582).',
    };
  }

  if (tauriFetchWasReplaced()) {
    return {
      ok: false,
      reason:
        'Tauri plugin-http buffers the body — use the webview fetch. window.fetch is ' +
        '@tauri-apps/plugin-http\'s fetch, which reads the response to completion in Rust ' +
        'before the first chunk reaches JS: ' +
        'https://github.com/tauri-apps/plugins-workspace/issues/2415. ' +
        'Use nativeFetch() from src/lib/native/sse.ts for SSE.',
    };
  }

  if (asFetch(globals().fetch) === null) {
    return {
      ok: false,
      reason: 'Tauri native shell has no global fetch implementation to stream with.',
    };
  }

  return {
    ok: true,
    reason:
      'Tauri native shell using the webview fetch — SSE streams. Do not import fetch from ' +
      '@tauri-apps/plugin-http for streaming requests: it buffers the response body ' +
      '(https://github.com/tauri-apps/plugins-workspace/issues/2415, duplicate #2129).',
  };
}

/**
 * The webview's own `fetch` — the one implementation that streams.
 *
 * Under Capacitor this deliberately prefers `window.CapacitorWebFetch`, the reference the
 * bridge saved before patching. That makes this function correct even if CapacitorHttp is
 * somehow switched on, instead of merely reporting that it is on.
 */
export function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const g = globals();
  const impl = asFetch(g.CapacitorWebFetch) ?? asFetch(g.fetch);
  if (impl === null) {
    return Promise.reject(new Error('No fetch implementation available in this shell.'));
  }
  // `fetch` must be invoked with a global as its receiver; an ES module is strict, so an
  // unbound call throws "Illegal invocation". `g` is `globalThis`, which is the window here.
  return impl.call(g, input, init);
}
