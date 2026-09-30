# Tessera native wrappers

Android (Capacitor 8) and desktop (Tauri v2). **Both wrap the existing `dist/` build.**
There is no second codebase and no forked UI: `vite build` produces `dist/`, the Worker
serves it as static assets, Capacitor copies it into an APK, and Tauri embeds it in the
installer. One frontend, three shells.

> **Status: configuration only.** This repo contains the wrapper *configuration*. The
> generated native projects (`android/`, `src-tauri/target/`, installers) are not checked
> in, and no APK or installer has been built — see [Not done](#not-done).

---

## 1. The streaming landmine

Tessera streams every reply as SSE, one `data:` frame at a time (`src/lib/sse.ts`). Both
wrappers ship a way to break that, and **both breaks are silent**: the whole body arrives
at once at the end, so the chat merely looks slow and nothing throws.

| Shell | What breaks it | Issue |
|---|---|---|
| Capacitor | `CapacitorHttp`, when enabled, replaces `window.fetch` with a native bridge that awaits the complete body and only then builds a `Response`. It also never patches `EventSource`. | [#6582](https://github.com/ionic-team/capacitor/issues/6582) |
| Tauri | `@tauri-apps/plugin-http`'s `fetch` reads the response to completion in Rust before the first chunk crosses the IPC boundary. | [#2415](https://github.com/tauri-apps/plugins-workspace/issues/2415) (duplicate [#2129](https://github.com/tauri-apps/plugins-workspace/issues/2129)) |

**The fix in both cases is the webview's native `fetch`.** It streams correctly and needs no
plugin, no bridge, and no configuration.

The rules that follow, and that must not be "optimized" away later:

1. **Do not enable `CapacitorHttp`.** `capacitor.config.ts` sets `enabled: false` explicitly
   as a guard. Do not turn it on to solve a CORS problem — see §4 for the actual fix.
2. **Do not add `tauri-plugin-http`.** It is absent from `src-tauri/Cargo.toml` on purpose.
   The desktop shell has no plugins at all.
3. **Route SSE through `nativeFetch()`** from `src/lib/native/sse.ts` if a call ever needs to
   be sure. In a browser it is just `fetch`.

### The guard

`src/lib/native/sse.ts` is the tripwire. Call it once at startup and log the result:

```ts
import { assertNativeStreaming, isNativeShell } from './lib/native/sse';

if (isNativeShell()) {
  const { ok, reason } = assertNativeStreaming();
  if (!ok) console.error(`[tessera] SSE will not stream — ${reason}`);
}
```

`reason` names the fix, not just the symptom. The detection is grounded in how each shell
actually behaves at runtime rather than on a guess:

- **Capacitor.** The native bridge saves the webview's untouched `fetch` to
  `window.CapacitorWebFetch` *before* deciding whether to patch, and only overwrites
  `window.fetch` when the patch runs. So `window.CapacitorWebFetch !== window.fetch` is an
  exact, side-effect-free answer on both Android and iOS. On Android it additionally reads
  `window.CapacitorHttpAndroidInterface.isEnabled()`, which reflects the live
  `plugins.CapacitorHttp.enabled` config.
  Deliberately **not** used as the signal: the *presence* of `Capacitor.Plugins.CapacitorHttp`
  or `window.CapacitorHttpAndroidInterface`. `registerPlugin` populates the plugin proxy
  unconditionally and Android's `Bridge.registerAllPlugins` always registers the plugin, so
  presence proves nothing — `enabled` is what decides.
- **Tauri.** `window.isTauri` and `window.__TAURI_INTERNALS__` are injected as
  initialization scripts on the main frame, and are the documented markers. Tauri never
  assigns a plugin's `fetch` to `window.fetch`, so the module also compares against
  `window.__TAURI__.http.fetch` under `withGlobalTauri` in case that ever changes.

`nativeFetch()` prefers `window.CapacitorWebFetch` when present, so it stays correct even if
`CapacitorHttp` is somehow switched on — it returns the streaming implementation rather than
merely complaining that the streaming one is gone.

---

## 2. Android (Capacitor 8)

### Dependencies

```sh
bun add @capacitor/core@^8 @capacitor/android@^8
bun add -d @capacitor/cli@^8
```

`capacitor.config.ts` is checked in. It sets `webDir: 'dist'` — the same Vite output the
Worker serves — and `appId: 'app.tessera.client'`.

### Generate the native project

```sh
bun run build        # produces dist/
npx cap add android  # requires the Android SDK + JDK 21
npx cap sync android
```

`android/` is generated and is not checked in. **Re-running `cap add` overwrites
`AndroidManifest.xml`**, so the edit below must be re-applied after regenerating the
project — which is why it lives in this file rather than only in the generated one.

### Share-sheet receiving (card import)

An `ACTION_SEND` intent filter on the main activity is what makes Tessera appear in Android's
share sheet, so a character card PNG or JSON can be shared straight into the app.

Add this inside the `<activity android:name=".MainActivity" ...>` element in
`android/app/src/main/AndroidManifest.xml`, alongside the existing `MAIN` / `LAUNCHER`
intent-filter:

```xml
<!-- Share-sheet receiving: character cards arrive as PNG (chara/ccv3 text chunks)
     or as bare JSON / .charx-as-JSON. The app dispatches on magic bytes, so the
     mime type only decides whether the share sheet offers Tessera at all. -->
<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/png" />
</intent-filter>
<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="application/json" />
</intent-filter>
```

Notes that matter:

- **One `<intent-filter>` per mime type.** Within a single filter, multiple `<data>` elements
  are merged into one union of URI attributes, not treated as alternatives — so putting both
  mime types in one filter would not do what it looks like it does.
- `android:mimeType` matching is **case-sensitive**; lowercase only.
- A `<data>` element with a mime type and no scheme implies the `content:` and `file:`
  schemes, which is what a share intent carries. No `android:scheme` is needed.
- The generated activity already has `android:launchMode="singleTask"`, so a share into an
  already-running app is delivered as a new intent to the existing instance rather than
  starting a second copy.
- Only `image/png` is listed. Card PNGs are PNGs; `.charx` archives arrive as
  `application/zip` and are out of scope for the share sheet, since `parseCardFile` already
  handles them via the file picker.

**The intent filter alone does not deliver the data to JavaScript.** Capacitor does not
surface received intents to the web layer on its own. A plugin is needed to read the intent
and raise an event:

```sh
bun add @capgo/capacitor-share-target@^8
npx cap sync android
```

```ts
import { Capacitor } from '@capacitor/core';
import { CapacitorShareTarget } from '@capgo/capacitor-share-target';

if (Capacitor.isNativePlatform()) {
  await CapacitorShareTarget.addListener('shareReceived', async (event) => {
    // event.files[].uri points at the shared file; event.files[].mimeType is set.
    // Feed the bytes to parseCardFile() from src/lib/cards/import.ts — the same entry
    // point the drag-and-drop path uses, so there is one importer, not two.
  });
}
```

The plugin's own README recommends broader filters (`text/*`, `image/*`, `SEND_MULTIPLE`).
The narrower filter above is intentional: Tessera is not a general-purpose share target, and
a `text/*` filter would put it in the share sheet for every piece of text on the device.

### Distribution

**Sideloaded only. No store submission is planned.** Google Play's AI-Generated Content
policy lists "generative AI applications primarily intended to be sexually gratifying" as
violative, and chub.ai's own Play listing (`ai.chub` / `com.chub.ai`) returns 404 — this is a
documented, repeated outcome rather than a risk to manage. The iOS equivalent is worse:
Apple Guideline 1.1.4 plus the 2025 age-rating overhaul, and chub.ai's App Store listing
disappeared between July 16 and July 28, 2025.

Note that **Android developer verification** begins rolling out from 2026-09-30 in
BR/ID/SG/TH, going global "2027 and beyond", which gates *signed* sideloads. The escape
hatch is a **limited distribution account** (up to 20 devices, no government ID, no fee) —
check it before distributing beyond this one device.

Build and install:

```sh
bun run build
npx cap sync android
cd android && ./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

A release build needs a keystore configured under `android.buildOptions` in
`capacitor.config.ts` (path, password, alias). Not configured here — a signing key is not a
thing to commit.

### Cleartext / CORS

The app talks to the deployed Worker over HTTPS, so no cleartext exemption is needed and
`server.cleartext` is left off. Do **not** set `server.url` to the deployed Worker to dodge
CORS — Capacitor documents that option as live-reload-only and "not intended for use in
production", and it would load the remote SPA instead of the bundled one. See §4.

---

## 3. Desktop (Tauri v2)

`src-tauri/` contains `tauri.conf.json`, `Cargo.toml`, `build.rs` and `src/main.rs`. It is a
window around the same `dist/` bundle:

- `build.frontendDist: "../dist"` — the same Vite output.
- `build.beforeDevCommand: "bun run dev"` and `devUrl: "http://localhost:5180"` for HMR.
- `build.beforeBuildCommand: "bun run build"`.
- A 1100×780 window (min 420×480) — chat-shaped: a message column with room for a sidebar.
- `dragDropEnabled: false`, which is required for HTML5 drag-and-drop on Windows because
  Tauri replaces WebView2's drag-drop handler. Card import uses HTML5 drag-and-drop
  (`src/routes/CharacterNew.tsx`), so leaving this on would break import on Windows only.

### No plugins, no IPC

`Cargo.toml` has exactly two dependencies: `tauri` and `tauri-build`. **`tauri-plugin-http`
is deliberately absent** (§1). There are no `#[tauri::command]` handlers either — the
frontend talks to the deployed Worker over ordinary `fetch`, not over IPC. Every piece of
behaviour worth sharing (prompt assembler, SSE parser, provider adapters) already lives in
TypeScript under `src/lib/` and is shared verbatim with the Worker; reimplementing any of it
in Rust would fork the logic this project exists to get exactly right.

Because no plugins are registered, the webview needs **no ACL capabilities** — it has no IPC
access at all, which is the tightest possible default. There is intentionally no
`src-tauri/capabilities/` directory. If a plugin is ever added it will need a capability file,
or every call is rejected with `command not allowed`.

`src-tauri/` is desktop-only. Tauri's Android/iOS targets need the `lib` + `main` split with
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`; Android ships via Capacitor here, so that
split is not present.

### Dependencies and build

```sh
bun add -d @tauri-apps/cli@^2
```

Rust 1.90+ is required (Tauri 2.12's own MSRV; `Cargo.toml` pins `rust-version = "1.90"`),
plus the platform webview prerequisites — WebView2 on Windows, `webkit2gtk-4.1` on Linux.

Icons are **not committed**. Generate them from a square source image:

```sh
bunx tauri icon ./app-icon.png    # writes src-tauri/icons/
```

`tauri.conf.json` references `icons/32x32.png`, `icons/128x128.png`,
`icons/128x128@2x.png`, `icons/icon.icns`, `icons/icon.ico`. On Windows the build **fails
hard** if no `.ico` exists — `tauri-build` errors with
`` `<path>` not found; required for generating a Windows Resource file ``. So `tauri icon`
is a prerequisite, not a nicety. It accepts an SVG too, so `public/favicon.svg` is a usable
input once squared.

```sh
bun run tauri:dev
bun run tauri:build
```

**Expected installer size: ~2–10 MB.** Tauri uses the system webview rather than bundling a
browser engine, against Electron's ~150 MB — that is the whole reason for the choice. The
desktop size argument does not transfer to mobile, where Capacitor and Tauri both inherit
the platform webview.

---

## 4. CORS — done

In a browser tab the SPA is served by the Worker itself, so `/api/*` calls are same-origin
and no CORS applies. In a native shell the app is served locally — from
`https://localhost` (Android) or `tauri://localhost` (desktop) — and calls the deployed
Worker cross-origin.

`Authorization: Bearer …` is not a CORS-safelisted request header, so **every** `/api/*` call
is preflighted: the webview sends `OPTIONS` first and will not send the real request unless
the preflight is answered.

Implemented in `worker/src/cors.ts` and wired into the Worker entry:

1. `OPTIONS` on `/api/*` is answered with `204` plus `Access-Control-Allow-Origin`,
   `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers: authorization, content-type`,
   and `Access-Control-Max-Age: 86400` so the preflight is cached.
2. Actual responses carry `Access-Control-Allow-Origin` too. `withCors` rebuilds the response
   around its existing `body` stream rather than buffering it, so the chat endpoint still
   streams frame by frame.
3. The preflight is answered **before** the auth check — a preflight carries no
   `Authorization` header by design, so routing it through `isAuthorized` would 401 every one
   of them.
4. Origins are an explicit allowlist, never `*`: the bearer token is the only credential,
   and `*` would let any page on the internet drive this API from a user's browser.
   `Vary: Origin` is set so a shared cache cannot serve one origin's response to another.

   The list must include **`http://tauri.localhost`** — Tauri on Windows serves from the
   plain-`http` variant, not `https`. `tauri-utils` documents this directly:
   `access-control-allow-origin: http://tauri.localhost`. `https://tauri.localhost` is
   only used when `app.windows[].useHttpsScheme` is set, which it is not. Omitting the
   `http` entry makes every desktop API call fail CORS, and the webview shows nothing
   that identifies the cause.

   Verified against the local Worker: preflight returns `204` with the headers above for
   `https://localhost` and `http://tauri.localhost`, an authenticated request returns `200`
   with `Access-Control-Allow-Origin` echoed, and a request from an unlisted origin
   receives no CORS headers at all. The desktop binary was then driven over CDP and
   confirmed to load data from the deployed Worker — see `docs/desktop-verification.md`.

---

## 5. Not done

- **No APK.** `npx cap add android` needs the Android SDK and JDK 21; this machine has
  JDK 17 and no SDK. The configuration, icons and web bundle are all done — see
  [`docs/android-apk.md`](docs/android-apk.md) for the exact remaining steps.
- **No share-sheet handler wired to the importer.** The intent filter and the plugin call
  are documented above; the `shareReceived` listener that feeds `parseCardFile()` is not
  written, because it cannot be exercised without a device.
- **No iOS wrapper.** Capacitor's iOS target would work, but it needs macOS + Xcode, and
  distribution is a different problem entirely (§2).
- **No release signing.** A keystore for Android and a signing identity for Windows/macOS
  are unconfigured — committing either would be a mistake.

### Built and verified

The **desktop app is built**, not merely configured:

| Artifact | Size |
|---|---|
| `src-tauri/target/release/tessera.exe` | 9.1 MB |
| `Tessera_0.1.0_x64_en-US.msi` | 3.69 MiB |
| `Tessera_0.1.0_x64-setup.exe` (NSIS) | 2.79 MiB |

Against Electron's ~150 MB. It was launched, attached to over CDP, and confirmed to load
chats and the model list from the deployed Worker across origins — see
[`docs/desktop-verification.md`](docs/desktop-verification.md).

`src-tauri/target/` and `src-tauri/gen/` are build output and gitignored. `src-tauri/icons/`
is committed: the Windows build hard-fails without an `.ico`, so the generated icons are
part of the source tree rather than a build step.

---

## 6. package.json

Already applied:

```jsonc
{
  "dependencies": {
    "@capacitor/core": "^8",
    "@capacitor/android": "^8"
  },
  "devDependencies": {
    "@capacitor/cli": "^8",
    "@tauri-apps/cli": "^2"
  },
  "scripts": {
    "cap:sync": "bun run build && npx cap sync android",
    "cap:open": "npx cap open android",
    "cap:apk": "bun run build && npx cap sync android && cd android && ./gradlew assembleDebug",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "tauri:icon": "tauri icon ./app-icon.png"
  }
}
```

`capacitor.config.ts` is in `tsconfig.node.json`'s `include` alongside `vite.config.ts`, and
`bunx tsc -p tsconfig.node.json --noEmit` passes.

`@tauri-apps/api` is deliberately **not** a dependency: the desktop shell registers no plugins
and exposes no commands, so it uses no IPC. Add it only if a command or plugin is introduced.

`@capgo/capacitor-share-target` is also **not** a dependency yet, on purpose. It is a native
plugin, so it does nothing until `npx cap add android` has generated the project, and it
cannot be exercised without a device. Install it as part of the §2 share-sheet work:

```sh
bun add @capgo/capacitor-share-target@^8
npx cap sync android
```
