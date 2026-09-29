# Open-source prior art: reuse, fork, learn-from, graveyard

Research date: 2026-09-29. All stars/licences/last-push from `gh api`, so they are point-in-time.

**Hard constraint this is written against:** the app must work on mobile with no desktop/self-hosted server running. Self-hosted-server projects below are marked **[REFERENCE-ONLY]** — mine their *features*, never their architecture.

---

## 1. Ranked shortlist

### A. FORK candidates (permissive licence, mobile-first, real code)

| Project | Stack | Licence | Stars / last push | Why fork / why not |
|---|---|---|---|---|
| **PocketPal AI** — https://github.com/a-ghorbani/pocketpal-ai | Expo 57 / RN 0.82, llama.rn, WatermelonDB, MobX, `react-native-keychain` | **MIT** | 8,447 / 2026-09-29 | The cleanest legally-reusable mobile codebase in this space. Real on-device GGUF inference, on-device neural TTS, secure key storage in the OS Keychain, iOS+Android shipped. **But** it is a *chat assistant*, not a roleplay client: no character cards, no lorebook, no memory pipeline, no multi-bot. Fork for the transport + keychain + llama.rn plumbing, build your own RP layer. |
| **Maid** — https://github.com/Mobile-Artificial-Intelligence/maid | Expo 57 / RN, llama.rn, `expo-secure-store`, `expo-sqlite` | **MIT** | 2,709 / 2026-09-14 | Second MIT option, first-party SDKs for Anthropic/Mistral/OpenAI/Ollama. Same verdict as PocketPal: good plumbing, no RP semantics. |
| **Amica** — https://github.com/semperai/amica | Next.js + Tauri, three.js + `@pixiv/three-vrm`, Transformers.js, Whisper, Silero VAD | **MIT** | 1,601 / 2026-09-22 | Only MIT project here that does **3D VRM avatar + voice in/out + emotion engine** in-browser, and the web build is PWA-installable on mobile. If you want an embodied companion rather than a chat window, this is the reuse target for the avatar/voice layer. Licence-clean. |
| **Scowld** — https://github.com/apoorvdarshan/scowld | Swift/iOS, VRM avatar, BYOK, keys in iOS Keychain | **MIT** | 24 / 2026-08-24 | Tiny and new, but it is the *only* iOS-native BYOK companion with an animated avatar and on-device wake detection. Read it as a blueprint; too small to fork. |
| **letta** — https://github.com/letta-ai/letta | Python | **Apache-2.0** | 24,969 / 2026-09-10 | Server-side agent memory platform. **[REFERENCE-ONLY]** for the memory-tiering design; Apache-2.0 means you can lift algorithms/concepts and any code you port, but it needs a host. |
| **MLC-LLM / MLC Chat** — https://github.com/mlc-ai/mlc-llm | C++/TVM, Android (Kotlin) + iOS | **Apache-2.0** | 23,196 / 2026-09-29 | If you want an on-device engine other than llama.rn. Apache-2.0, actively developed. Note MLC Chat is a *demo* app, not a product — you'd write all product surface. |

**Specs / libraries worth vendoring outright:**
- `character-card-spec-v3` — https://github.com/kwaroran/character-card-spec-v3 — **MIT**, 112 stars, last push 2024-07-20. The card format RisuAI and newer frontends use. MIT means you can implement freely. (v2, https://github.com/malfoyslastname/character-card-spec-v2, has **no licence** — read it, do not copy text/code from it.)
- `png-chunk-text` (npm, **MIT**) — the standard way to read/write the `chara` tEXt chunk in V2 PNG cards.
- `@risuai/ccardlib` (npm, **MIT**, v0.4.2, last modified 2024-06-14) — card parse/serialize library extracted from RisuAI. MIT, so it survives RisuAI's GPL.

### B. LEARN-FROM (best designs to study; copyleft, so read not copy)

| Project | Licence | Stars / last push | What to steal conceptually |
|---|---|---|---|
| **Kelivo** — https://github.com/Chevey339/kelivo | **AGPL-3.0** | 4,087 / 2026-09-28 | **Closest single project to the target's non-RP surface.** Flutter, ships iOS+Android+macOS+Windows+Linux+HarmonyOS from one codebase. See §4. |
| **RikkaHub** — https://github.com/rikkahub/rikkahub | **AGPL-3.0** | 7,904 / 2026-09-29 | **Closest to the target's RP surface on mobile.** See §4. Note the README explicitly says *"This project does not accept pull requests"* and warns that forks leak privacy — it is a single-maintainer app, not a community project. |
| **Glaze** — https://github.com/hydall/Glaze | **AGPL-3.0** | 34 / 2026-09-28 | A 2026 Flutter RP client whose `docs/ARCHITECTURE.md` is the single best written design doc in this space. Studio multi-agent pipeline, memory token budgets, Dropbox/Drive sync. Self-described "vibecoded"; read the docs, don't inherit the code. |
| **RisuAI** — https://github.com/kwaroran/Risuai | **GPL-3.0** (not AGPL) | 1,699 / 2026-09-29 | Broadest RP feature set in a non-server product. See §4. GPL-3.0 has no network clause — better than AGPL for a mobile app. |
| **SillyTavern** — https://github.com/SillyTavern/SillyTavern | **AGPL-3.0** | 33,910 / 2026-09-23 | The feature reference. Its **group chat** module (`public/scripts/group-chats.js`, 2,492 lines) is the canonical multi-bot implementation; see §4. |
| **Agnaistic/Agnai** — https://github.com/agnaistic/agnai | **AGPL-3.0** | 784 / 2026-06-15 | The "multi-user + multi-bot, designed with scale in mind" design. Derived from PygmalionAI's galatea-ui. Needs MongoDB/Redis. **[REFERENCE-ONLY]**. |
| **lite.koboldai.net** — https://github.com/LostRuins/lite.koboldai.net | **AGPL-3.0** | 202 / 2026-09-20 | Proof that a *single static HTML file* can be a full RP frontend (story/adventure/chat/instruct modes, world info, TTS, ST card import, AI-Horde image gen). The strongest precedent for a **pure-PWA, zero-server** client. **[REFERENCE-ONLY]** by licence, but architecturally it is the shape you want. |

### C. IGNORE (wrong shape, wrong licence, or dead)

| Project | Licence | Why ignore |
|---|---|---|
| **Open WebUI** — 153,512★ | **custom** ("Open WebUI License") | BSD-3 + a branding clause: you may not remove "Open WebUI" branding unless you have <50 users / written permission / an enterprise licence. Hosted-server product. |
| **LobeHub (lobe-chat)** — 82,885★ | **custom** ("LobeHub Community License", Apache-2.0 + commercial conditions) | Not OSI-open. Server product. |
| **LibreChat** (MIT, 45,105★), **AnythingLLM** (MIT, 66,585★), **big-AGI** (MIT, 7,134★), **Jan** (Apache-2.0, 44,703★) | permissive | All desktop/server. Legally reusable, architecturally irrelevant to "no server". |
| **chatbot-ui** — 33,348★ | MIT | Last push **2024-08-03**. Abandoned. |
| **KoboldAI-Client** — 3,953★ | AGPL-3.0 | Last commit **2025-01-16** ("Disable Google Colab due to dependency issues"). Superseded by KoboldCpp (11,901★, AGPL-3.0, pushed 2026-09-29) and KoboldAI United. |
| **text-generation-webui → `oobabooga/textgen`** — 47,723★ | AGPL-3.0 | Renamed and repositioned as a **desktop app** (2026-08-17). Not a frontend to reuse. |
| **TavernAI 2** — 86★, **no licence** | — | The repo contains only releases, docs, locales — **no source**. All rights reserved by default. Do not touch. |
| **character-card-spec-v2** | none | Spec text is readable, but unlicensed → not reusable as code. |

---

## 2. Mobile-first clients: stack and on-device secrets

| App | Stack | Local models | API keys on device | Chat data | Cross-device sync |
|---|---|---|---|---|---|
| **ChatterUI** (2,785★, AGPL-3.0) | Expo 57 / React Native, `drizzle-orm` + `expo-sqlite`, `react-native-mmkv` + zustand persist, `cui-llama.rn` (custom llama.cpp adapter) | Yes — GGUF via llama.rn, local + remote mode | **MMKV, unencrypted.** `lib/storage/MMKV.ts` calls `createMMKV()` with **no encryption key**; `ConnectionEditor.tsx` just puts the key into the auth header. No Keychain/Keystore use found. | SQLite (characters/chats/chat_entries/swipes/lorebooks/attachments — V2 card fields) | **None.** No backup/export/sync code found. Android-only APK; README: *"iOS is Currently unavailable due to lacking iOS hardware for development."* |
| **PocketPal** (8,447★, MIT) | RN 0.82, llama.rn, WatermelonDB, MobX | Yes — GGUF fully offline; 4-layer stack (UI/tools → JSI bridges → llama.cpp + ONNX Runtime → CPU/GPU/NPU), with Qualcomm Hexagon NPU and Metal/OpenCL paths | **`react-native-keychain`** — `Keychain.setGenericPassword('apiKey', …, {service: serverId})` in `src/store/ServerStore.ts`; HF token likewise in `HFStore.ts`. Correct pattern. | WatermelonDB | **Supabase** for PalsHub (`src/services/palshub/`, incl. a `SyncService.ts` that syncs the `CachedPal`/`UserLibrary` tables) — a real backend, but scoped to the *marketplace library and auth*, not to chat history. |
| **Maid** (2,709★, MIT) | Expo 57 / RN, llama.rn, expo-sqlite | Yes | **`expo-secure-store`** (OS keychain) | SQLite | Supabase present in deps. |
| **RikkaHub** (7,904★, AGPL-3.0) | Kotlin, Jetpack Compose, DataStore + Room | No (workspace/proot agent env instead) | DataStore preferences; not a secure enclave | Room SQLite + files | **WebDAV + S3-compatible**, plus ZIP backup/restore. `data/sync/`: `BackupManager.kt` writes a ZIP containing `settings.json` + the DB snapshot; `S3Sync.kt`, `WebDavClient.kt`, `WebDavSync.kt`; restore is staged then applied on restart (`PendingRestore.kt`). **This is the reference sync design.** |
| **Kelivo** (4,087★, AGPL-3.0) | Flutter 3.44 / Dart 3.12, Riverpod, Hive + SQLite | No on-device LLM; **PRoot Linux sandbox** on Android and **iSH Alpine** on iOS for agent workspaces | Per-provider **multiple** keys with round-robin / priority / least-used / random load balancing and per-key error cooldown (`lib/core/services/api_key_manager.dart`) | Hive + SQLite | **WebDAV, S3-compatible, or local file**, with automatic on-device snapshots and a pre-restore copy. Restore by overwrite **or merge**. Also imports Cherry Studio and Chatbox archives. |
| **Scowld** (24★, MIT) | Swift/iOS, VRM | No | iOS Keychain | Local history | None found. |
| **Layla** (closed source) | Native, closed | Yes, on-device | n/a | n/a | n/a — but see §5 for its open components. |
| **MLC Chat** (MLC-LLM, 23,196★, Apache-2.0) | Kotlin (Android) / Swift (iOS) | Yes, compiled models | n/a — demo app | n/a | None. |

**Pattern:** every serious mobile client keeps keys in the OS keystore (PocketPal, Maid, Scowld) **or** does not bother (ChatterUI → MMKV plaintext). The ones that solved sync without a self-hosted server all converged on **WebDAV/S3 with the user's own credentials** (RikkaHub, Kelivo) or **Dropbox/Google Drive OAuth** (Glaze) — never a vendor-hosted relay.

---

## 3. Graveyard lessons

**Open-source graveyard**

- **TavernAI (original, `TavernAI/TavernAI-v1`, MIT, 2,698★, 2022-12-21 → 2026-06-16).** Humi's client was the genre's founding app. Development stalled in early 2023; Cohee1207 forked v1.2.8 in Feb 2023 into what became SillyTavern, and by end-2024 the two shared almost no code. **Lesson:** the maintainer, not the code, is the asset. A stalled solo project loses its community to whichever fork ships fastest. The upstream repo is now explicitly labelled *"legacy"*.
- **PygmalionAI (org alive; products dead).** The org still exists and still trains models — Pygmalion-3-12B (2024-10-30), Eleusis-12B (2025-01), plus a fork of aphrodite-engine (1,869★, AGPL-3.0, pushed 2026-09-11). But **every client died**: `galatea-ui` (last push 2023-06-26), `galatea-frontend` (2023-08-11), `paphos-backend` (2023-04-08). `pygmalion-6b` on HF has not changed since **2023-01-13**. Agnai's README still says it is *"Based on the early work of Galatea-UI"* — the UI outlived its home. **Lesson:** a model-org's own frontend is a demo; the frontend is where orgs lose interest. Also: models outlive UIs (HF weights survive), so *store cards and chats as portable files*.
- **CAI tools / OpenCharacters** (`josephrocca/OpenCharacters`, MIT, 399★, last push **2025-03-29**). Single-file character chat. **Lesson:** single-file demos are great architecture references (see lite.koboldai.net) and terrible products — no update path, no data migration.
- **Venus/Chub, Loom, DreamTavern, Faraday.** Chub's Venus is a hosted platform (status trackers only; no shutdown found). "Loom" in this space is **a preset/prompt system distributed via Lucid.card**, not an app — the only GitHub hits are SillyTavern helper extensions (`prolix-oc/SillyTavern-LumiverseHelper`). Faraday.dev **shut down and rebranded into Backyard AI** (https://backyard.ai/blog/rebranding-to-backyard) — both closed-source. DreamTavern is closed-source with review sites asking "is it shut down?". **Lesson:** in this niche, closed desktop apps die by rebrand-or-vanish; there is no way to audit or revive them.

**Closed-product graveyard (dated, sourced)** — from https://www.companionhunt.com/data/ai-companion-app-shutdowns/ (updated 2026-09-24) and https://roleplaya.com/blog/ai-roleplay-sites-shut-down/:

- **Soulmate AI** (2023-09-30) — every companion and full chat/voice history deleted; ~1 week's notice; **no export, no refunds**.
- **CarynAI** (2023-10-23) — died with its host company after the CEO's arrest.
- **Figgs AI** (2024-12-30) — devoted community, still closed; attributed to developer abandonment + a data-exposure incident.
- **Moxie robot** (2025-01-30) — $800 hardware bricked overnight because inference ran entirely in the cloud; no offline fallback. Community revived some units via OpenMoxie.
- **Dot / New Computer** (2025-10-05) — founders' "Northstar had diverged"; ~30 days notice; export offered only inside the wind-down window.
- **Yara AI** (Nov 2025) — shut down *voluntarily* while solvent, citing regulatory and ethical risk.
- **Avatar.One** (2026-09-24) — domain now redirects to an unrelated company; no export.
- **Xoul AI** — went dark 2025-04-21 with ~a day's notice, later returned.
- **Feature withdrawals that hurt as much as shutdowns:** Replika ERP filter (2023-02-03), Character.AI Playbacks/Memos removal (2026-03-18) and the Roar model retirement (2026-04-28), ChatGPT's GPT-4o retirement (2026-02-13), Grok Ani's avatar removal (2026-09-01), and China's Doubao/Qwen/Yuanbao companion shutdowns (2026-07-15).

**The five lessons, distilled**

1. **Client-only projects die of maintainer attention, not of hosting cost; server projects die of inference cost.** Figgs had users and no revenue model. RikkaHub/Kelivo/ChatterUI have no bill to pay — the failure mode is the single maintainer walking away (see RikkaHub's "does not accept PRs").
2. **Cloud-side state is the thing that gets deleted.** Every shutdown row in the table lost the chats; export was the exception. A BYOK client's data is on the user's device by construction — this is the app's single biggest defensible advantage over Janitor/CAI/Talkie.
3. **Regulation and app stores move in one direction only** (Replika → age checks → face scans → metered free tiers). If you ship to app stores, assume adult content will be pressured; if you ship an APK/sideload/PWA, you keep the escape hatch.
4. **Feature withdrawal is the most common "death".** Never let the user's persona live only in your format — import/export Character Card V2/V3 JSON+PNG, and let the user keep a plain-text export of every memory and summary.
5. **Sync without a server is a solved, boring pattern** (WebDAV/S3/Dropbox with user credentials). Every project that tried a vendor relay added a shutdown dependency; every project that used the user's own storage is still standing.

---

## 4. Is anyone already doing "BYOK + mobile + memory + images + multi-bot"?

**No. Not one project covers all five.** The closest three, and exactly where each falls short:

| | BYOK | Mobile-native, no server | Long-term memory | Image gen | Multi-bot / group |
|---|---|---|---|---|---|
| **Kelivo** (AGPL) | ✅ native protocols for OpenAI/Gemini/Claude + any compatible endpoint; multi-key load balancing | ✅ iOS App Store + Android + HarmonyOS | ✅ `memory_pipeline` / `memory_extractor` / `memory_gatekeeper` / `memory_profile_distiller`; typed as identity/workflow/voice/instruction; auto-organize + per-assistant scope + inspectable run log | ✅ image-output models + provider tools, image mode in the composer | ❌ **no multi-character/group chat.** Conversations are 1:1; no scene or cast model. |
| **RisuAI** (GPL-3.0) | ✅ many providers incl. custom | ⚠️ `capacitor.config.ts` exists and there is a PWA manifest, but releases are **desktop only** (dmg/exe/deb/rpm/AppImage); it is a Tauri app with optional `server/node` + `server/hono` | ✅ HypaMemory v2/v3, SupaMemory, HanuraiMemory; embeddings via Transformers.js/WebLLM | ✅ `PlaygroundImageGen` | ✅ **group chat is core**: `character.type === 'group'`, per-character `characterTalks` weights, mention-driven ordering |
| **Glaze** (AGPL) | ✅ OpenAI-compatible | ✅ Android APK + iOS IPA (sideload) + Windows | ✅ MemoryBooks: draft→approval lifecycle, message-range provenance, `maxInjectionBudgetPercent` 0.35, `full`/`hybrid`/`chunk_first` packing | ✅ routmy/openai/gemini/naistera adapters, `[IMG:GEN]` tags wired into replies | ❌ **no character group chat.** Its "multi-agent" is *Studio Mode* — tracker agents (continuity/narrative/beauty) feeding one FINAL generator. Not a cast of characters. |

**What nobody has at all** (your genuine differentiators):
- **Multi-bot scenes with a persistent world/dungeon simulation** in a mobile BYOK client. SillyTavern is the only thing with real group-chat semantics, and it is a Node server. Its design is worth copying conceptually: two orthogonal enums — `group_activation_strategy` = {NATURAL, LIST, MANUAL, POOLED} decides *who speaks*, and `group_generation_mode` = {SWAP, APPEND, APPEND_DISABLED} decides *whether replies merge into one message or stay separate*, plus `allow_self_responses` and an auto-mode delay loop.
- **Persistent time/location/state tracking.** The only real implementation is a SillyTavern *extension* — `virgilianshailer/story-tracker` (**MIT**, 11★, created 2026-04-17, pushed 2026-08-08). It LLM-extracts current time, date, day-of-week, city/country, weather, per-character position, outfits, and user-defined custom fields, injects them into the Author's Note, renders a HUD, keeps a history log, and can route analysis to a *cheaper* model via a separate connection profile. **MIT licence means you can port this logic wholesale.** Its "separate connection profile for analysis" trick is exactly the cost-control pattern a mobile BYOK app needs.
- **Cross-device sync for a pure client.** Kelivo's WebDAV/S3 + local snapshots and Glaze's Dropbox/Drive + manifest-diff-with-ETag (conflict = newer `updatedAt`) are the two working designs. Glaze's `sync_manifest.dart` + `sync_conflict.dart` + `sync_queue.dart` split is the cleanest thing to copy conceptually.

---

## 5. Other reusable pieces

- **Layla's open components** (the app is closed, but the org publishes a lot under Apache-2.0): `l3utterfly/layla-sdk` (mini-app SDK: chat, tool calling, TTS/STT, image gen, video gen, music gen, per-mini-app SQLite, character memories — 26★); `l3utterfly/llm-ltm` (LLM long-term memory: overlapping transcript windows → durable memories + knowledge-graph triples with `rawText`/`summary`/`knowledgeGraphJSON` — the best concrete memory-extraction recipe I found); `l3utterfly/Layla-Server` (Apache-2.0); `l3utterfly/local-dream` + `npuforge` (Stable Diffusion on Android Snapdragon NPU). All Apache-2.0.
- **`DasterProkio/awesome-ai-companion`** — 813★, **CC0-1.0**, updated 2026-09-29. The best-maintained index of this exact niche, with a "Continuity & Data Ownership" section. Its own framing: *"The deepest fear in a long-term AI relationship: platform shutdown, account ban, model deprecation, lost history."*
- **Operit** (https://github.com/AAswordman/Operit, 8,220★, **LGPL-3.0**, Kotlin/Android) — on-device agent with memory, role cards, voice, local MNN/llama.cpp models.
- **KoboldCpp** (11,901★, AGPL-3.0) — the on-device-adjacent inference server every client speaks to; not reusable in a client, but its API is the de-facto compat target.

## Licence cheat-sheet for reuse

- **MIT / Apache-2.0** → fork freely, close the derivative: PocketPal, Maid, Scowld, Amica, Jan, LibreChat, big-AGI, AnythingLLM, letta, MLC-LLM, Layla SDK/llm-ltm, char-card-spec-v3, png-chunk-text, @risuai/ccardlib, story-tracker.
- **GPL-3.0** → RisuAI. Copyleft on distribution, no network clause. A mobile app that never serves a network API does not trigger §13-style obligations, but distributing the binary obliges you to offer the whole derivative's source under GPL-3.0.
- **AGPL-3.0** → SillyTavern, ChatterUI, RikkaHub, Kelivo, Glaze, KoboldCpp, lite.koboldai.net, textgen. Same as GPL plus §13: if any user interacts with the derivative *over a network*, you must offer them the source. A purely on-device app avoids §13, but App Store distribution still triggers the source-offer obligation. **You cannot ship a closed-source fork of Kelivo or RikkaHub.**
- **Custom / NOASSERTION** → Open WebUI (branding clause), LobeHub (commercial restrictions). Not OSI-open; avoid entirely.
- **No licence file** → TavernAI 2, character-card-spec-v2, Rikkaweb, orangechat. All rights reserved; read for ideas only.

## Sources

- https://github.com/SillyTavern/SillyTavern
- https://github.com/TavernAI/TavernAI-v1
- https://github.com/TavernAI/TavernAI
- https://tavernai.net/
- https://github.com/Cohee1207/SillyTavern-Archive
- https://ai.miraheze.org/wiki/SillyTavern
- https://github.com/KoboldAI/KoboldAI-Client
- https://github.com/LostRuins/koboldcpp
- https://github.com/LostRuins/lite.koboldai.net
- https://github.com/oobabooga/textgen
- https://github.com/kwaroran/Risuai
- https://github.com/agnaistic/agnai
- https://github.com/PygmalionAI/galatea-ui
- https://github.com/PygmalionAI/galatea-frontend
- https://github.com/PygmalionAI/paphos-backend
- https://github.com/PygmalionAI/aphrodite-engine
- https://huggingface.co/PygmalionAI/pygmalion-6b
- https://huggingface.co/api/models?author=PygmalionAI
- https://github.com/Vali-98/ChatterUI
- https://github.com/rikkahub/rikkahub
- https://github.com/Chevey339/kelivo
- https://github.com/hydall/Glaze
- https://github.com/a-ghorbani/pocketpal-ai
- https://github.com/Mobile-Artificial-Intelligence/maid
- https://github.com/apoorvdarshan/scowld
- https://github.com/semperai/amica
- https://github.com/mlc-ai/mlc-llm
- https://github.com/l3utterfly/layla-sdk
- https://github.com/l3utterfly/llm-ltm
- https://github.com/l3utterfly/Layla-Server
- https://github.com/danny-avila/LibreChat
- https://github.com/lobehub/lobehub
- https://github.com/open-webui/open-webui
- https://github.com/janhq/jan
- https://github.com/enricoros/big-AGI
- https://github.com/Mintplex-Labs/anything-llm
- https://github.com/mckaywrigley/chatbot-ui
- https://github.com/letta-ai/letta
- https://github.com/malfoyslastname/character-card-spec-v2
- https://github.com/kwaroran/character-card-spec-v3
- https://github.com/virgilianshailer/story-tracker
- https://github.com/DasterProkio/awesome-ai-companion
- https://github.com/AAswordman/Operit
- https://github.com/M4Marvin/charon
- https://github.com/Cocolalilal/LastChat
- https://github.com/BCCC0/SwiftTavern
- https://github.com/MiaoWuNYA/rikkahub-sillytavern-android
- https://www.companionhunt.com/data/ai-companion-app-shutdowns/
- https://roleplaya.com/blog/ai-roleplay-sites-shut-down/
- https://aicompanionguides.com/blog/the-platforms-that-died-rip-2025-shutdowns/
- https://backyard.ai/blog/rebranding-to-backyard
- https://docs.rikka-ai.com/settings/backup
- https://deepwiki.com/rikkahub/rikkahub/9.4-backup-and-export-system
- https://www.npmjs.com/package/png-chunk-text
- https://www.npmjs.com/package/@risuai/ccardlib
