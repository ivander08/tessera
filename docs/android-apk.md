# Android APK — built

**The APK is built and verified.** `android/app/build/outputs/apk/debug/app-debug.apk`, 5.5 MB.

```sh
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

Then open Tessera on the phone, paste the same token you use at `/setup`, and configure a
provider key at `/settings` if the device is new.

## What is installed on this machine

| Tool | Version | Location |
|---|---|---|
| JDK | Temurin 21.0.12 | `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot` |
| Android SDK | platform 35, build-tools 35.0.0, platform-tools 37.0.1 | `%LOCALAPPDATA%\Android\Sdk` |
| `sdkmanager` | 19.0 | `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin` |
| `adb` | 1.0.41 | `%LOCALAPPDATA%\Android\Sdk\platform-tools` |

**JDK 17 is still the default `java` on PATH.** Capacitor 8's Gradle build requires 21, so
every Gradle invocation must set `JAVA_HOME` first:

```sh
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot
set ANDROID_HOME=C:\Users\Ivander\AppData\Local\Android\Sdk
```

## Rebuilding

```sh
bun run build:native     # bakes VITE_API_BASE from .env.native into dist/
bunx cap sync android    # copies dist/ into the Android project
cd android && gradlew.bat assembleDebug
```

`bun run cap:apk` does all three, but it uses `npx`, which is broken on this machine —
`npm error could not determine executable to run`. Run the three steps by hand, or
`bunx cap sync android` instead of `npx cap sync android`.

## The trap this hit

`bun run build` (browser mode) overwrites `dist/` and **removes** the API base.
`build:native` adds it. Running the browser build last, then `cap sync`, packages a bundle
whose every request resolves against the phone's own local origin — the app installs
cleanly, shows no error, and simply cannot reach anything.

This happened during the build. `src/lib/native/bundle.test.ts` now guards it: it reads the
packaged bundle and fails if the Worker origin is absent. Verified by mutation — stripping
the origin from the packaged bundle makes the test fail, restoring it makes it pass.

## What is in the APK

- `assets/public/` — the full native web bundle, verified to contain
  `https://tessera.ivanderseah08.workers.dev`.
- `AndroidManifest.xml` — the `ACTION_SEND` intent filters for `image/png` and
  `application/json`, so Tessera appears in the share sheet for character cards. Confirmed
  present in the built APK via `aapt dump xmltree`.
- Icons generated from `app-icon.svg`.
- `CapacitorHttp` disabled, with the reason recorded in `capacitor.config.ts`.

## Not done

- **No share-sheet handler.** The intent filter is compiled in, but nothing reads the
  incoming intent and hands it to `parseCardFile()`. That needs a plugin
  (`@capgo/capacitor-share-target`) and a device to test on. See `WRAPPERS.md` §2.
- **Debug build only.** Release signing needs a keystore, which should not be committed.
- **Not tested on a device.** No phone is attached (`adb devices` is empty). The bundle,
  the manifest and the API origin are all verified statically; the app itself has not been
  launched on Android.

`android/` is gitignored — it is generated output, and re-running `npx cap add android`
overwrites `AndroidManifest.xml`, which is why the intent filter is documented in
`WRAPPERS.md` as well as applied here.
