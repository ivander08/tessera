# Shipping ONE app to desktop + mobile with no server the user runs

Research date 2026-09-29. All CORS results below were measured today with `curl -X OPTIONS` from a foreign `Origin: https://app.example.com`, plus live browser `fetch` from `https://example.com`.

## 0. The constraint set

1. Mobile must work with the laptop **off** → no user-run server, ever. Kills SillyTavern's architecture and every self-hosted sync.
2. BYOK → the device calls the provider directly; the developer hosts nothing.
3. Personal project, single user, free tier → iOS App Store approval is *downgraded* from blocker to "nice to have".

## 1. Hard constraint A — app store policy for NSFW companion chat

**Apple.** Guideline **1.1.4** bans "overtly sexual or pornographic material"; 1.2 bans UGC apps "used primarily for pornographic content"; 1.2 does allow "incidental mature NSFW content from a web-based service … hidden by default and only displayed when the user turns it on **via your website**". Apple's 2025 age-rating overhaul (news 2025-07-24) added **13+/16+/18+** and states explicitly: "you must consider how all app features, including AI assistants and chatbot functionality, impact the frequency of sensitive content appearing within your app". Questionnaire responses were mandatory by 2026-01-31.

**Google.** The AI-Generated Content policy lists as violative: "Generative AI applications primarily intended to be sexually gratifying."

**What actually happens in practice.** chub.ai is the clean case study. Its iOS app (id 6478348543, "Chub AI", 17+ — "Frequent/Intense Sexual Content or Nudity", 20.8 MB, IAP $6.99/$24.99) was live from 2024-05-01; the Wayback CDX shows HTTP 200 snapshots through **2025-07-16** and the first **404 on 2025-07-28**. It is gone from every storefront I checked (US/SE/GB/DE/JP/CA/AU), `bundleId=ai.chub` returns 0 results, and the Play listing (`ai.chub`, `com.chub.ai`) is 404. Its developer page still resolves (200) but lists **no apps**.

The survivor pattern is JanitorAI: its app is live (`id6692609366`, **17+**, 110.9 MB, v2.5.0, updated 2026-09-15) and ships the exact 1.2 loophole — its own help doc: "By default, NSFW content is disabled when you first download the app … you can easily unlock the full JanitorAI experience by toggling a setting in your account **via a web browser**." So: SFW-by-default binary + web-side unlock. That is a *deliberate, documented* store-compliance pattern, and it still requires a website the reviewer can visit.

**Alternatives, ranked by realism for a personal project.**
- **PWA install** (iOS 26 "Add to Home Screen") — no review, no fee, no revocation. Primary path.
- **Android APK sideload** — but **Android developer verification** starts 2026-09-30 in BR/ID/SG/TH for participating stores, global "2027 and beyond", so *signed* sideloads become gated. There is an escape hatch: **limited distribution accounts** (up to **20 devices**, no government ID, no fee). Fine for personal use; check it before shipping.
- **TestFlight** — 10,000 external testers/app, but every build goes through App Review and guideline 2.2 requires beta apps to comply with the guidelines, so 1.1.4 applies. Not a loophole.
- **F-Droid / IzzyOnDroid** — viable for Android; no iOS equivalent.
- **AltStore PAL** — EU-only, needs notarization/CTF economics; not worth it for one user.

**Verdict: for a personal NSFW-capable client, PWA-install on iOS + sideloaded Android APK is the only zero-friction path. Treat any store submission as an optional, separately-scoped SFW product.**

## 2. Hard constraint B — iOS PWA storage, and whether PWA can be the only mobile artifact

The 7-day eviction is **real but narrower than folklore**. WebKit's own docs: ITP deletes IndexedDB/LocalStorage/SW caches after 7 days of no user interaction — **except** "The first-party domain of home screen web applications is exempt from ITP's 7-day cap … its website data is kept isolated from Safari". So *installed* is the whole ballgame; a bookmark/tab user loses everything.

Quotas (Safari 17+/iOS 17+, WebKit storage policy): browser app origin quota **up to 60% of total disk**, overall 80%; "other apps" 15%/20%; a standalone Home Screen web app gets **the same quota as a browser app**. `navigator.storage.persist()` exists and WebKit grants it "based on heuristics like whether the website is opened as a Home Screen Web App". This is generous for chat JSON — a few MB is nothing.

iOS 26 (Safari 26, released 2025-09-15) removed the installability gate entirely: "Added support for any website to become a web app on iOS or iPadOS" — heise's write-up quotes Apple: there are now "zero conditions" for installability, with an explicit "Open as web app" toggle in the share sheet.

What still breaks:
- **Push requires a server.** Declarative Web Push (Safari 18.4, 2025-03-31) works in Home Screen web apps *without* a service worker, but messages still arrive via APNs from a **push server**. With no server there is no remote push. Local notifications are dead ends: Chrome's Notification Triggers `showTrigger` is discontinued ("development has ended"), and Periodic Background Sync is Chrome-only — **Safari and Firefox do not implement it**. So: no notifications when the app is closed, and no scheduled "bot messages you at 9pm" without a backend.
- **No background execution.** No timer can fire while backgrounded; summaries/memory jobs must run on foreground resume.
- **No Keychain.** Web Crypto keys are extractable; a PWA's API key sits in IndexedDB/localStorage. On a personal, single-user device with OS-level disk encryption this is acceptable, but it is strictly weaker than a native shell.

**Can PWA be the *only* mobile artifact? Yes, for this use case** — a chat client is foreground, network-bound, and text-heavy; the missing capabilities are notifications and background jobs, neither of which is load-bearing for the core loop. Ship PWA-only first; add a native wrapper later if notifications become necessary.

## 3. Framework decision matrix

| | Desktop size | Mobile | Streaming (SSE) | Secure key store | SQLite | On-device LLM | Solo-dev friction |
|---|---|---|---|---|---|---|---|
| **PWA only** | n/a (browser) | iOS 26 install, no review | native `fetch` + ReadableStream ✅ | ❌ IndexedDB only | IndexedDB / OPFS / wa-sqlite | ❌ | **lowest** |
| **Tauri v2** (2.12.0, 2026-09-26) | 2–10 MB | iOS/Android, system webview | webview `fetch` ✅; **`plugin-http` buffers** (issue #2415 → dup #2129) | `stronghold` 2.4.0 official, all 5 OSes; `tauri-plugin-keyring` covers all 5 | `tauri-plugin-sql` 2.5.0 official | Rust/GGUF possible, not turnkey | Rust + Xcode; mobile still rough (Android activity/permission fixes landing in 2.12.0) |
| **Capacitor 8** (8.5.2) | Electron ≈80–200 MB, or reuse Tauri | mature plugin surface | webview `fetch` ✅; **CapacitorHttp is off by default** and doesn't patch `EventSource` (issue #6582) | `@aparajita/capacitor-secure-storage` — **mobile only**, no desktop | `@capacitor-community/sqlite` 8.1.1 (community; bundles SQLCipher → Apple export-compliance question) | no first-party | **lowest native**; JS/TS only |
| **React Native + Expo** (SDK 57 / RN 0.86) | ❌ RN Windows/macOS are out-of-tree | strongest on-device stack | `expo/fetch` is global since SDK 52 ✅ | `expo-secure-store` — **no desktop** | `expo-sqlite` (+Drizzle) | **llama.rn** (ships in PocketPal, ChatterUI), react-native-executorch | EAS Build free tier 15+15 builds; desktop = second project |
| **Flutter** 3.47.5 | first-class Win/Linux/macOS | good | `http` `Client.send()` / `dio` stream ✅ | `flutter_secure_storage` 11.2.0 — **all 5 OSes** | `drift` 2.35.0 | `flutter_gemma` (LiteRT-LM; also desktop GPU) | one language, one stack; iOS still needs macOS/Xcode |
| **Electron** 44.4.5 | 80–200 MB | ❌ | ✅ | keytar/safeStorage | better-sqlite3 | Node bindings | desktop-only; not a mobile answer |

Measured app sizes (minimal builds, Xcode 26): Flutter 39.7 MB APK / 12.9 MB iOS; RN+Hermes 44.9 MB / 36.7 MB. Tauri/Capacitor mobile inherit the same webview, so their size difference is a **desktop-only** argument.

## 4. CORS: can a browser/PWA call providers directly? (measured 2026-09-29)

Preflight (`OPTIONS`, `Origin: https://app.example.com`) results — **direct browser use is the norm, not the exception**:

**Works, `Access-Control-Allow-Origin: *`:** OpenAI (`api.openai.com` — preflight 200, allows `authorization,content-type`), Anthropic (`anthropic-dangerous-direct-browser-access` is in the allowed-headers list), OpenRouter (204), Mistral, Groq, xAI, Together, Cerebras, Fireworks, Perplexity, Voyage, Stability, ElevenLabs (allows `*` headers), Pollinations.

**Works, ACAO echoes the Origin (with `Vary: Origin`):** Google Gemini (`generativelanguage.googleapis.com`, allows `x-goog-api-key`), DeepSeek, Jina, Hyperbolic, Moonshot, Zhipu, fal.

**Blocked / unverified:** `integrate.api.nvidia.com` returns no ACAO → not browser-usable. Replicate's preflight returns 200 but I could not observe ACAO on a plain GET — needs a runtime check.

So **no proxy is required for the major providers.** Caveats: a live `fetch` probe from the browser failed for Anthropic/OpenRouter/Gemini/Mistral even though their preflights pass — verify each provider once at runtime before shipping, and keep a per-provider "direct / needs-proxy" flag. Also note keys are visible in DevTools traffic; that is inherent to BYOK-in-browser and is only mitigated by a native shell's Keychain.

## 5. Sync without hosting (laptop off)

Only cloud-mediated options survive. From the companion sync research:

| Rank | Option | Free limits | Idle/pause | Laptop online? |
|---|---|---|---|---|
| 1 | **Yjs/Automerge CRDT + user's own cloud folder** (Drive `appDataFolder`, Dropbox app folder) | Drive: 1M units/min/project, 400M units/day free threshold; **charges planned "later in 2026"** | none | **No** |
| 2 | **Cloudflare Workers + R2** (blob) or **+ D1** | Workers free **100k req/day, 10 ms CPU**; D1 free **5 GB total / 500 MB per DB / 5M rows read/day / 100k rows written/day / 10 DBs**; R2 free 10 GB-month, **zero egress** | none | **No** |
| 3 | Firebase/Firestore | 1 GiB, 50k reads/day | none | No |
| 4 | Turso Sync | 5 GB, 3 GB syncs/mo | none | No |
| ❌ | Supabase / Nhost | — | **pauses after 7 days inactivity** (confirmed in Supabase docs) | fatal for intermittent use |
| ❌ | InstantDB | — | **cloud shuts down 2027-08-31** (team joined OpenAI) | — |
| ❌ | Triplit | — | repo stale since 2026-01-19, site returns **HTTP 410** | — |
| ❌ | ElectricSQL / PowerSync / LiteFS / rqlite / SQLSync / PocketBase / WebDAV | — | require a running server | **Yes** |
| ❌ | Pure P2P (WebRTC, libp2p, Iroh, Veilid) | — | both devices must be online; iOS Safari suspends WebRTC in background | **Yes** |
| ❌ | CloudKit / iCloud Drive | — | CloudKit JS requires an existing native CloudKit app; Apple-only | — |

**Recommendation: Yjs (MIT, pushed 2026-09-29, `y-indexeddb` for server-free offline) storing an *encrypted* blob in Google Drive's `appDataFolder`.** It is the only option where the user already has the account, the provider never sees plaintext, and nothing pauses. Cloudflare R2 + a thin Worker is the fallback if Drive's pending billing change is a problem.

## 6. Recommended path

**One web codebase (TypeScript SPA + a headless core module), three shells — PWA first.**

1. **Mobile = PWA.** Manifest + service worker, but make the install prompt unmissable, because the ITP exemption only applies to Home-Screen-installed apps. Request `navigator.storage.persist()` at boot and show `persisted()` status. Use the provider's native streaming `fetch`. Accept: no push, no background jobs.
2. **Desktop = Tauri v2.** ~2–10 MB installers, `stronghold` (or `tauri-plugin-keyring`) for the API key, `tauri-plugin-sql` for the local DB. Use the **webview's** `fetch`, never `plugin-http`.
3. **Android = the same web bundle wrapped in Capacitor 8**, distributed as a sideloaded APK. Leave `CapacitorHttp` disabled. Secure storage via `@aparajita/capacitor-secure-storage` (mobile-only, which is fine here).
4. **iOS native** (Capacitor or Tauri) only if push/notifications become a requirement — and then only via TestFlight for personal use, or as an SFW app using the JanitorAI web-unlock pattern.
5. **Sync = Yjs + encrypted blob to Drive `appDataFolder`**; R2/Workers as the fallback.
6. **Skip** React Native/Expo and Flutter. RN's on-device inference stack is the best in class but desktop is out-of-tree and `expo-secure-store` has no desktop target; Flutter is the strongest *single-stack* alternative (first-class desktop, `flutter_secure_storage` + `drift` on all five OSes, `flutter_gemma` for on-device) if you would rather write Dart than ship three shells.
7. **On-device inference is a later, optional tier.** `llama.rn` (RN) and `flutter_gemma` (Flutter) are the credible *native* mobile paths. In the PWA there is exactly one route — **WebGPU + `@mlc-ai/web-llm`** (MIT; note RisuAI already depends on `@mlc-ai/web-llm`, which is a working precedent) — but iOS Safari's WebGPU memory ceiling makes 1B+ models marginal, so do not put on-device inference in v1 if PWA is the primary artifact.

## Sources

- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/news/?id=ks775ehf (age ratings, 2025-07-24)
- https://support.google.com/googleplay/android-developer/answer/14094294 (AI-Generated Content policy)
- https://support.google.com/googleplay/android-developer/answer/13985936
- http://web.archive.org/web/20250716101859/https://apps.apple.com/us/app/chub-ai/id6478348543
- http://web.archive.org/cdx/search/cdx?url=apps.apple.com/us/app/chub-ai/id6478348543&output=json
- https://itunes.apple.com/lookup?id=6692609366&country=us
- https://help.janitorai.com/en/article/faq-mobile-app-moderation-vttat8/
- https://help.janitorai.com/en/article/faq-janitorai-app-xam5o9/
- https://webkit.org/tracking-prevention/
- https://webkit.org/blog/14403/updates-to-storage-policy/
- https://webkit.org/blog/16535/meet-declarative-web-push/
- https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes
- https://www.heise.de/en/news/iOS-26-and-iPadOS-26-Changed-web-app-behaviour-on-the-home-screen-10749652.html
- https://developer.apple.com/help/app-store-connect/reference/app-uploads/maximum-build-file-sizes
- https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers
- https://developer.android.com/developer-verification
- https://developer.chrome.com/docs/web-platform/notification-triggers/
- https://openpwa.net/compatibility/periodic-background-sync/
- https://github.com/ionic-team/capacitor/issues/6582
- https://github.com/tauri-apps/plugins-workspace/issues/2415
- https://v2.tauri.app/plugin/stronghold/ · https://v2.tauri.app/plugin/sql/
- https://github.com/aparajita/capacitor-secure-storage · https://pub.dev/packages/flutter_secure_storage
- https://github.com/smootar/app-size-compare · https://docs.flutter.dev/perf/app-size
- https://docs.expo.dev/versions/latest/sdk/expo/ · https://docs.expo.dev/versions/latest/sdk/securestore/
- https://github.com/mybigday/llama.rn · https://pub.dev/packages/flutter_gemma
- https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/d1/platform/limits/
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://developers.google.com/workspace/drive/api/guides/limits
- https://www.instantdb.com/essays/instant_team_joins_openai
- https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb
