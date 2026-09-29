# Competing AI-Roleplay Frontends & Clients — Deep Scan

**Research date: 2026-09-29.** All GitHub figures from live `gh api` calls that day. All store figures read from live Play/App Store listings or the iTunes Lookup API that day. Anything I could not verify against a primary source is marked `[UNVERIFIED]`. Anything stale (>6 months without a commit) is flagged.

> Scope: every app named in the brief except SillyTavern (owned by a sibling agent). Reddit was DNS-sinkholed on this host and the PullPush archive API rate-limited this IP mid-run; where community sentiment is cited it comes from archived quotes reproduced in third-party write-ups, plus vendor help centres and store review counts.
>
> **Two corrections to the brief's premise, established by primary sources:** (1) **Faraday.dev is not a separate product** — it rebranded to Backyard AI in May 2024 and its desktop app is deprecated. (2) **Loom and DreamTavern are not findable as live products** — Loom's domain has been dead since 2019, and DreamTavern (by Weights) shut down when its team joined OpenAI.

---

## 1. Ranked comparison table

Ranked by closeness to the target: **BYOK + cross-platform (desktop and mobile from one codebase) + power-user features**.

| # | App | Platforms | OSS | BYOK | Memory | Multi-bot | Voice | Images | Dungeon/state | Monetization | Traction (2026-09-29) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Risu AI** | Win/Mac/Linux (Tauri), Android, Web, Docker | ✅ GPL-3.0 | ✅ 10+ providers + own backend | ✅ HypaV2/V3, SupaMemory, HanuraiMemory | ✅ group chats | ✅ ElevenLabs/VOICEVOX/Web Speech | ✅ emotion sprites + SD gen | ⚠️ via script vars | Free; optional paid backend | 1,699★, pushed 2026-09-29; 120k downloads on v2026.8.250; Discord 7,466 |
| 2 | **WyvernChat** | Web (+ responsive mobile) | ❌ | ✅ Featherless + OpenRouter/OpenAI/Gemini + custom providers + local | ⚠️ token-breakdown, manual summarize; **"Worlds" persistent memory announced** | ✅ group chats + multiplayer | ❌ | ✅ script-driven avatars/images | ✅✅ **Lua WyvernScripts: dice rolls, stat changes** | Free; BYOK or Featherless sub | Discord **4,556** / 850 online |
| 3 | **Agnai** | Web (self-host or agnai.chat) | ✅ AGPL-3.0 | ✅ 9 services | ⚠️ keyword memory books; LTM only via optional pipeline | ✅ multi-user **and** multi-bot | ❌ | ✅ via third-party | ❌ | Free; self-host | 784★, pushed 2026-06-15 (**slowing**) |
| 4 | **Chub.ai / Venus** | Web + Android APK (iOS intermittent) | ❌ | ✅ 6 named providers + own Soji API | ✅ summarizes only evicted messages | ✅ + Go Live | ✅ TTS out | ✅ "Imagine" | ⚠️ via Stages API | **$20/mo crypto-only**; free = ~20 msg/day | Discord **27,125**; ~5.8M visits/mo (est.) |
| 5 | **JanitorAI** | Web + iOS + Android | ❌ | ✅ generic OpenAI-compatible proxy + own Router | ❌ **none** — manual template only | ❌ | ❌ | ❌ | ❌ | Free 9k ctx / **$12.99 Janitor+** | **1.4M DAU**; Discord **387,316**; Play 1M+, 4.6★ |
| 6 | **TheCodexAI** | Web | ❌ | ✅ **18+ providers, $0 markup** | ⚠️ claimed (Chronicler Memory) | ✅ Cast Lounges | ✅ TTS | ✅ Scriptorium | ❌ | Free+ads / $5 / $10 / $20 | **No credible traction** |
| 7 | **ChatterUI** | Android (iOS WIP) | ✅ AGPL-3.0 | ✅ 12+ providers + local GGUF | ❌ none | ❌ | ✅ device TTS | ❌ | ❌ | Free / Ko-fi | 2,785★, pushed 2026-09-22 |
| 8 | **PocketPal AI** | Android + iOS | ✅ MIT | ⚠️ local-first; llama.cpp server; no cloud chat APIs | ❌ | ❌ | ✅ Kokoro on-device | ❌ | ❌ | Free; PalsHub IAP | 8,447★; Play 1M+ installs, 3.3★, 3.4K reviews |
| 9 | **Backyard AI** (formerly **Faraday.dev**) | Web + iOS + Android; **desktop deprecated** | ❌ | ⚠️ local GGUF **only** — no OpenAI/Anthropic keys | ❌ no summarization; "memory" = context size | ✅ ≤4 | ✅ calls (removed on Android) | ❌ | ⚠️ Grammars + prose Author's Note | Free 300 msg/wk / $12 / $35 | iOS 3.4★ (37); Android 10K+, 3.2★ |
| 10 | **KoboldCpp** | Win/Mac/Linux/Docker/Android | ✅ AGPL-3.0 | ✅ local GGUF + Horde/OAI/Anthropic/OR/Gemini/Grok | ⚠️ World Info + TextDB RAG; no LLM summarizer | ✅ | ✅ Whisper STT + 5 TTS | ✅ **local SD/Flux** | ✅ **Adventure mode + dice** | Free | **11,901★**, pushed 2026-09-29 |
| 11 | **KoboldAI-Client** | Win/Linux/macOS/Colab | ✅ AGPL-3.0 | ✅ local + Horde/OAI | ⚠️ World Info | ✅ | ❌ | ❌ | ✅ **Adventure mode + dice** | Free | 3,953★, **dormant since 2025-01** |
| 12 | **Layla** | Android | ❌ | ⚠️ local GGUF + partial | ⚠️ | ❌ | ✅ | ✅ | ❌ | Free + Pro | Play installs `[UNVERIFIED]` |
| 13 | **MLC Chat** | iOS/Android/Win/Mac/Linux | ✅ Apache-2.0 | ❌ local only | ❌ | ❌ | ⚠️ | ❌ | ❌ | Free (research) | 23,196★ (engine repo) |
| 14 | **Character.AI** | iOS/Android/Web | ❌ | ❌ | ✅ Pins + Lorebook + memory meter | ✅ Rooms | ✅ Calls | ❌ | ❌ | $2.99 lite / $9.99 c.ai+ | Play 50M+, **2.2★** (2.44M reviews) |
| 15 | **Talkie** | iOS/Android/Web | ❌ | ❌ | ✅ RAG on Pro+ | ⚠️ | ✅ voice clone | ✅ | ⚠️ Mini-Theater | $9.99/mo; $49.99 yr1 | Play 50M+, 4.5★ (851K) |
| 16 | **Chai** | iOS/Android/Web | ❌ | ❌ (own models) | ⚠️ weak | ❌ | ✅ | ✅ on MAX | ❌ | $159.99/yr; MAX $90/mo | Play 10M+, 3.1★ (838K) |
| 17 | **Linky** | iOS/Android | ❌ | ❌ | ⚠️ | ⚠️ | ✅ | ✅ Live2D/3D | ⚠️ | Sub + coins + gacha | Play 10M+, 3.9★ (137K) |
| 18 | **Nomi AI** | iOS/Android/Web | ❌ | ❌ | ✅✅ Mind Maps | ✅ group | ✅ calls | ✅ selfies | ❌ | $15.99/mo | App Store 4.6★, 2.9K |
| 19 | **Kindroid** | iOS/Android/Web | ❌ | ❌ | ✅✅ cascaded | ✅ up to 10 | ✅ real-time calls | ✅ | ❌ | $13.99/mo → ~$100/mo | Play 1M+, 4.4★, 25.1K |
| 20 | **Replika** | iOS/Android/Web/VR | ❌ | ❌ | ✅ | ❌ | ✅ video calls | ✅ | ❌ | $19.99/mo; $299.99 lifetime | Play 10M+, 4.3★; ~42M users |
| 21 | **DreamGen** | Web + API | ⚠️ models open | ⚠️ API + ST import | ⚠️ in-scenario | ✅ | ❌ | ✅ | ✅✅ **tracked state vars** | $7.83–$48.30/mo | 20K+ users (self-claim) |
| 22 | **Loom** | — | — | — | — | — | — | — | — | — | **Does not exist** — domain dead since 2019 |
| 23 | **DreamTavern** | — | — | — | — | — | — | — | — | — | **Not findable as a product** — treat as nonexistent |

### 2025–26 newcomers with real traction (unranked; see §9)

| Name | Platform | OSS | BYOK | Traction | Differentiator |
|---|---|---|---|---|---|
| **RikkaHub** | Android + web | ✅ AGPL | ✅ | 7,904★; Play 10K+, 4.7★ | Defined the mobile BYOK category; large fork lineage |
| **Kelivo** | Android/iOS/macOS/Win/Linux/HarmonyOS | ✅ AGPL | ✅ | 4,100★; App Store 4.9★ | **One Flutter codebase, 6 targets**, memory + world books + TTS/STT |
| **Soul of Waifu** | Windows | ✅ | ✅ | 1,355★ | Tabletop RPG engine with explicit **WorldState**, dice, 4-file cognitive memory |
| **N.E.K.O** | Desktop (Steam) | ✅ Apache-2.0 | ✅ | 2,988★ | Proactive embodied companion |
| **Super Agent Party** | Win/Mac/Linux/Docker | ✅ AGPL | ✅ | 2,710★ | VRM/Live2D pet + tavern cards + group chat + memory |
| **LettuceAI** | Android/Win/Mac/Linux/iOS | ✅ AGPL | ✅ 20+ | 139★ | Only mobile-first app with the full feature stack (see §8) |
| **Miru** | macOS/Win/Android | ✅ Apache-2.0 | ✅ | 166★ | **Plain-Markdown auditable memory**; attention engine |
| **Open Dungeon** | macOS/Windows | ✅ MIT | ✅ | 231★ | Local FLUX inline scene images + rolling-summary memory |
| **Vellium** | Win/Mac/Linux | ✅ MIT | ✅ | 134★ | Multi-character RP, Inochi2D avatars, live voice, RAG |

---

## 2. Risu AI — the closest existing thing to the target

**Platforms / licence.** Windows, macOS, Linux (Tauri 2.5 desktop), Android (Capacitor), web at risuai.net, and self-hostable via Docker or Node.js 20.19+. GPL-3.0. Svelte 5 + TypeScript + Tailwind 4 + Vite 8.
- https://risuai.net/ ("RisuAI is available on Windows, MacOS, Linux, Android, and Web")
- https://github.com/kwaroran/RisuAI (README feature list, badges)

**Traction (live, 2026-09-29).** 1,699★, 351 forks, 154 open issues, created 2023-04-12, last push 2026-09-29 — shipping continuously. Release `v2026.8.250` (2026-08-25) has **120,143 asset downloads**; `v2026.6.215` has 92,646 — real install volume that dwarfs the star count. Discord **7,466 members / 1,168 online** (`discord.com/api/v10/invites/JzP8tB9ZK8?with_counts=true`). The star count is under-representative: Risu's users are largely mobile and non-GitHub.
- A review pegged it at 1,671★/346 forks on 2026-09-12, confirming the growth rate: https://www.promptquorum.com/power-local-llm/risuai-review

**BYOK.** Fully BYOK — OpenAI, Claude, Gemini, DeepInfra, OpenRouter, oobabooga, and more; plus its own optional hosted backend ("Choose RisuAI as your AI backend, or use it as a frontend for other AI backends"). Free either way; only the backend costs money.

**Standout features (each verified against source or wiki, not marketing):**
- **Memory stack — five separate implementations in-tree**: `src/ts/process/memory/{hypamemory,hypamemoryv2,hypav2,hypav3,supaMemory,hanuraiMemory,contextualEmbedding}.ts`. SupaMemory is pure recursive compression: *"just simply automatically request summarize to an AI when token is full, and re-summarizes the summarizations when if its needed... works without additional programs."* HypaV3 is a vector system with configurable `memoryTokensRatio`, `recentMemoryRatio`, `similarMemoryRatio`, `enableSimilarityCorrection`, `preserveOrphanedMemory` and its own preset system (https://github.com/kwaroran/RisuAI/wiki/SupaMemory).
- **Chat-scoped variable state** — `src/ts/parser/chatVar.svelte.ts` implements `getChatVar`/`setChatVar`/`getGLChatVar` over a persisted `chat.scriptstate` map with per-character and global `defaultVariables`. This is the primitive that makes dungeon/state mechanics possible, but **Risu exposes it as a scripting primitive, not as a first-class world model.**
- **Group chats** — `src/ts/process/group.ts`: characters carry `characterTalks` (turn weight, default 4/6) and `characterActive` flags. Turn-taking is probability-weighted, **not** knowledge-isolated.
- **TTS** — ElevenLabs (BYOK), VOICEVOX (self-hosted Japanese), Web Speech (free) (https://github.com/kwaroran/RisuAI/wiki/TTS).
- **Images** — emotion/expression sprites driven by detected emotion, inlayed images, backgrounds, plus real-time generation through an external Stable Diffusion API (https://en.namu.wiki/w/RisuAI; https://deepwiki.com/kwaroran/RisuAI/5.5-image-generation-and-dynamic-assets).
- **Plugin API v3.0** — a sandboxed JS plugin surface with `RisuPlugin`, `RisuModule`, replacers (`beforeRequest`/`afterRequest`), script modes (`display`/`output`/`input`/`process`), TTS hooks, `SafeDocument`/`SafeElement` DOM wrappers and `PluginStorage`. This is the most mature extension surface in the whole ecosystem after SillyTavern's (`plugins.md`, `src/ts/plugins/apiV3/risuai.d.ts`).
- **Card formats**: `.charx`, `.risum`, `.risup` plus RisuRealm for distribution.

**Monetization.** The app is free. There is an optional paid RisuAI-hosted backend, but no published consumer price tier `[UNVERIFIED]`.

**NSFW.** Unfiltered; RisuRealm hosts explicitly adult cards. No content policy in the repo.

**Novel mechanics worth stealing:**
1. **Recursive summarization without a vector DB** (SupaMemory) — the cheapest correct long-memory design, and it works with any provider.
2. **A user-facing scripting variable store with per-character defaults** — turns "state tracking" into something power users can build.
3. **Emotion-tagged sprite switching** — an image system that costs zero generation calls for the common case.

**Ecosystem signal:** `PocketRisu/PocketRisu` (366★, forked from Risuai 2026-03-17, GPL-3.0) re-architects Risu as a **self-hosted server with a single SQLite DB**, server-side generation that survives a dropped connection, QR/Tailscale remote mobile access, and a disk-usage dashboard. That fork exists because Risu's client-side storage model doesn't survive multi-device use — a design lesson.

---

## 3. WyvernChat — the most direct competitor to the brief's feature list

**Platforms.** Web app (`app.wyvern.chat`), PWA-capable, self-described **Beta**. No native mobile app; responsive UI. **Closed source.** Operator is **Featherless AI** — the wiki's `siteConfig.company` is literally `"Featherless AI"`, and WyvernChat joined the Featherless family in January 2025, letting founder **Nev** develop full-time. Still effectively a **one-full-time-developer** project.
- https://wiki.wyvern.chat/ · https://rpwithai.com/an-interview-with-nev-wyvernchat-its-history-challenges-and-more/ (2026-01-26)

**Traction.** Discord **4,556 members / 850 online** (live invite API, 2026-09-29); **r/WyvernChat 2,162 subscribers**. No published user count. Small, but shipping fast — Stories V2, Character Scenarios and group-chat UI landed within days of each other in late September 2026.

**BYOK.** Both, cleanly separated (https://wiki.wyvern.chat/en/Connections, updated 2026-09-02):
- **Free Queue** — a shared connection Wyvern runs on its own account: *"No cost and needs no API key."* Zero-setup start. Some features (Actor mode) require a real connection.
- **BYOK providers:** Featherless (linked or manual key), OpenAI, Anthropic, **Google Gemini**, **Google Vertex AI**, OpenRouter, InfermaticAI, ElevenLabs (TTS), plus **fully custom OpenAI-compatible providers** (e.g. a local model server) — which can be shared by share-code **without** exposing your key. Per-connection: force chat-completion, tool call, use-browser-request, system prompt, final instructions, sequences/stop strings, sampler overrides, and **connection playlists that rotate models automatically**. Connections sync across devices.

**The "Worlds" system — this has SHIPPED, and it is the full dungeon-sim package the brief describes** (https://wiki.wyvern.chat/en/Features/Worlds/Environments-Locations):
- **Environments → Locations** as a nested hierarchy with **parent-location inheritance**: each ancestor contributes context description, character pool, and included lexicon. Character pools have **participation weights**; per-environment and per-location **included/excluded Lexicon filters**; and a documented **final-instructions stacking order — World Formatting Rules → Environment → Location, last = most authoritative.**
- Plus **Timeline & Eras**, Scenario & Guided Intro, **Relationships & Attitudes**, Travel, InfoBoard, Commands, Director, and a Property & Furnishings Market.
- **RPG Stats & Blueprints** — toggleable subsystems (Inventory, Currency, RPG Stats, Combat, Ships, Creatures, Party Stats in Prompt). The stat system defaults to **SPECIAL** and is fully customizable: point-buy (base 3, max 8, 21 points) / Fixed / Free Assign / Roll; **Stat Roles** map your vocabulary onto combat math (HP scaling, MP scaling, physical/magic attack, physical/magic defense, speed, accuracy); **threshold-based Stat Value Labels** so the AI reads `Strength: high` rather than `Strength: 6`; Species / Occupations / Traits as additive blueprints with an NPC-only species flag.
- **StoryEngine** — portable, publishable engines of **Variables, Starting States, Rules, Commands, Scripts (Lua), Linked Lore and Handlebars Presentation**, versioned by revision; a running chat pins its revision until you review an update, and world parties share engine continuity. **This is the closest thing on the market to a real scripting runtime for roleplay.**
- **Memory Scan** (paid) — the auto-summarization answer: scans the last 25/50/100/custom or the full log (or "everything new since last scan"), chunks the range, and proposes **typed** entries — **Memories, NPCs, Locations, Events, Items, Concepts** — as Lexicon entries, deduplicating against existing ones, with review or auto-approve and optional **background auto-scan every N messages**. Free alternative is "Lexicon Sidechat" (single-request, manual, no dedup). The engineering detail worth copying: **a partially-failed scan does not mark its range as covered**, so retries cannot silently skip ground.
- **Lexicon** — lore that lives *in* the chat, in three scopes: Chat (private to one conversation, anyone can add), Character (creator-managed, all chats), and World. Entry types with special behavior for **NPC** (name-matching on first name, full name, nickname, title, plus a "Lines Parsed" control for how much dialogue the NPC owns), Item, Location, Event, Concept, Memory. Key logic: **AND ANY / AND ALL / NOT ANY / NOT ALL**. Context position: Before Character / After Character / **In Chat** (strongest). Highlighted keyword detection with click-to-inspect.
- Also: **Group Chats** (multi-character *and* multi-human, with turn order), Personas, **Sprites** (emote images), **Stories V2** (chapter/scene planning, AI continue/rewrite/expand/shorten, convert a chat into reviewed prose, publish editions with likes/bookmarks/boosts), Arena, Guilds + Treasury, Crystals, Shop, Boosts, Bounties, Events, Communities, Hubs, Data Export + **Wyldfire Bundle**, and Lua + Handlebars references.
- Earlier-established: **WyvernScripts** (Lua, keyword/slash-command triggered, capable of tool calls, dice rolls, stat changes, self-avatar changes and predefined images, authored in a visual **Studio Editor** with real-time testing), **Collections** (multi-creator shared worlds), **Sampler Presets / Instruct Templates** synced per connection, **Token Usage Breakdown**, chat branching + rewinding, and export-first ethos.

**Monetization.** **There is no WyvernChat subscription** — you link a paid Featherless account.
- **Featherless Chat plan: $25/month** — unlimited tokens, **32K context**, 4 concurrent units, any model in a 40,000+ catalogue, explicitly "works with SillyTavern, RisuAI, Wyvern", human-typed interactive chat only. Developer tier $50/mo in credits (per-token, up to 256K context, 100 concurrent). https://featherless.ai/pricing
- Free WyvernChat caps: 30 private characters, 30 lorebooks, 5 worlds, 5 backgrounds, 10 collections, 2 custom themes; **10 new private characters and 10 private lorebooks per day**; **5 public characters + 5 public lorebooks per day (applies to all accounts including subscribers**, to protect moderation throughput). A subscription lifts the private caps. Subscriber perks: unlimited creation, AI Assistant, Director and Actor, **Memory Scan**, Studio Assistants, badges, exclusive themes. **Scan Turn is free; Memory Scan is not.** (https://wiki.wyvern.chat/en/Paid/Content-Limits)

**NSFW.** **Explicitly not uncensored** — metadata declares `content-rating: Teen+`. There is a **Content Moderation Team** (volunteer humans) plus automod: *"If your character wasn't approved by our automod, it will be reviewed by our volunteer human moderation team… Reviews typically take no more than 12 hours."* Separate Prohibited Content Guide and Art Guidelines exist. **This is the sharpest strategic contrast in the set:** Chub is uncensored and pays for it with payment processors (crypto-only); Wyvern is Teen+ and can therefore charge $25/mo through a normal processor.

**Novel mechanics worth stealing — two, and they are exactly the ones needed:**
1. **Memory Scan as a reviewable, chunked, background auto-summarizer writing structured *typed* entries** (Memory/NPC/Location/Event/Item/Concept) into a lexicon rather than dumping prose into a context block — plus the "don't mark a failed range as covered" rule.
2. **Location-graph state with inheritance and a documented instruction-precedence stack** (World → Environment → Location, last wins). That is precisely the brief's persistent time/location/state model, with proven UX: environment = biome, location = room, character pools per-location merging upward.

**Verdict:** WyvernChat has **already shipped** the composite feature set the brief describes — worlds, persistent location/time state, RPG stats, dice, multi-bot, typed memory extraction, and a Lua scripting runtime. Its weaknesses are: web-only (no native mobile), closed source, Teen+ content ceiling, single-maintainer dependency, and no vector/semantic retrieval in its lorebooks. **This is the benchmark to beat, not a hypothetical.**

---

## 4. Agnai — the multi-bot/multi-user reference

**Platforms / licence.** Web app, self-hostable via npm (`npm install agnai -g`), Docker, or Docker+MongoDB. AGPL-3.0. Node/TypeScript + MongoDB + Redis (both optional — falls back to "Guest Only" mode with browser-local storage).

**Traction.** 784★, 152 forks, 113 open issues, created 2023-03-05, **last push 2026-06-15** — the only major OSS client here that has visibly slowed. No releases published. Treat as **maintenance-mode / at-risk**.

**BYOK.** Yes — Kobold, NovelAI, AI Horde, Goose, OpenAI, Claude, Replicate, OpenRouter, Mancer. Guest users need no account.

**Standout features.**
- **Multi-user *and* multi-bot** — the only client in this set with real multi-tenancy: user auth, per-user AI service settings, per-user generation presets, subscriptions, and "Multiple users with multiple bots" group conversations (README).
- **Memory Books** with a genuinely thoughtful mechanism: keyword+wildcard triggers (`book*`, `?book`), `priority` (sort order for budget inclusion) and `weight` (position in the prompt), a `depth` (how many recent messages to scan) and a token `contextLimit`. Notably the author is honest that he doesn't know the right defaults: *"At the moment I have no idea. I would be very interested to hear your experiences"* (https://github.com/agnaistic/agnai/blob/dev/instructions/memory.md).
- **Optional pipeline features** (opt-in, `agnai --pipeline`): long-term memory, plus **Wikipedia article and PDF embedding**. This is the only app in the set that ingests external documents into memory out of the box.
- Persona schema formats: W++, Square-bracket, Boostyle, plain text.
- AI character generation and third-party image generation.

**Monetization.** Free/open-source; the hosted agnai.chat is a courtesy instance.

**NSFW.** Unfiltered.

**Novel mechanic worth stealing.** **The pipeline flag** — the cleanest separation in the ecosystem between "runs on a laptop with no DB" and "runs with embeddings, Wikipedia and PDF ingestion." Also `priority` vs `weight` as *two orthogonal memory-ranking axes* (what gets in vs. where it lands) is a better model than the single relevance score everyone else uses.

---

## 5. Chub.ai / Venus — the model for "better chub.ai"

**Platforms.** Web only (`chub.ai`, frontend at `venus.chub.ai`). Closed source.

**What it actually is:** three products — (a) a **character-card + lorebook repository** and creator community, (b) a **frontend** that chats against your own keys, (c) an **inference provider** ("Mars", now branded **Soji**) with an OpenAI-compatible API.

**BYOK.** Yes, seven first-class providers: OpenAI, Anthropic, Google Gemini, OpenRouter, NovelAI, Kobold/Ooba (local), plus its own Mars/Soji. Also supports reverse proxies (which Chub itself discourages on security grounds — a nice touch) (https://docs.chub.ai/docs/the-basics/api-connections.md).

**Pricing (primary source, read live 2026-09-29).** `$20/month`, unlimited access to all LLMs including **"Soji 1.6T 60K"**, unlimited voice, unlimited multimedia generation, early access to new models, and the API usable anywhere OpenAI's API is. **Payment is crypto-only**, explicitly to escape card-network censorship pressure: *"The primary sources of censorship pressure for most websites are credit card companies and payment processors. By not using them, we are able to stay free of that pressure permanently."* Free trial = a few dozen one-time messages. https://venus.chub.ai/subscription

**Standout features.**
- **Full chat-tree branching** — Chub claims this is unique: *"Chub AI is unlike any other frontend out there in that we support full tree branching of chats, similar to what you would get when using ChatGPT"* (https://docs.chub.ai/docs/the-basics/just-chatting.md).
- **Chat Memory** — manual or AI-generated, using *"a method similar to the Aisu Auto Summarizer"*: it only summarizes messages that have fallen out of context. That's the correct algorithm and most competitors get it wrong.
- **Lorebooks** with the full V2-spec surface: keywords, secondary keywords, selective logic (`AND`/`NOT`), constant, probability, insertion order, priority, recursive scanning, scan depth, token budget.
- **"Imagine"** in-chat image generation; **TTS**; **Impersonate**; **Presets** (model-specific, shareable, public/private/unlisted); **Character Settings** that let you locally override *anyone's* character definition for your own chats.
- **Stages** — third-party extensions in sandboxed per-subdomain iframes, deliberately unable to touch cookies or your keys.

**The most important thing Chub has: the Stages state model.** Three persisted state types per extension (https://docs.chub.ai/docs/stages/developing-a-stage/state.md):
- **Initialization state** — created once per chat (e.g. a procedurally generated maze).
- **Message state** — per message in the graph (e.g. player position; *"some things that in a linear chat would belong in chat state, such as the path traversed, also belong here"*).
- **Chat state** — across *all branches* of the chat tree. The docs say this *"has no analogous concept in any other UI"* and give fog-of-war as the canonical example.

The reference implementation is a playable **maze** with generated walls, fog of war, and image display — i.e. Chub already ships a working dungeon-sim primitive, exposed to third-party developers rather than to end users.

**Traction.** **Discord 27,125 members / 4,021 online** (live invite API `chubai`, 2026-09-29 — note an earlier figure of 431 in this report came from the wrong invite code and is superseded). HypeStat **estimate**: ~5.8M monthly visits, ~191.6K daily, global rank #8,949, 80.6% mobile. r/Chub_AI measured **452 weekly contributors** in April 2026. No published user count; ownership undisclosed. The card library size is **not published** — a review site claims "60,000+ characters" `[UNVERIFIED]`, and third parties describe it as the largest open repository. **Treat the library as the moat and the number as unanswerable.**

**The 2026 crisis — the most decision-relevant thing about Chub.** On **2026-06-28** Chub went **crypto-only permanently**, cut the free tier to **~20 messages/day**, deprecated every model except Soji and Mobile, removed the **Mercury ($5) tier entirely**, and re-based Soji as a DeepSeek V4 finetune — which **broke users' existing presets**. The stated reason: *"It was either doing this (cutting costs and making the website crypto-only to avoid payment processors altogether), or having to censor the website more than legally required."* Chub's own character-creation docs still ask users to avoid NSFW avatar images because they *"spook the payment processors"* — the whole business model in one line.
- Consequences users report: card payments broken, PayPal fallback broken, auto-renewals silently cancelled, unresponsive support (*"I already lost 2 days worth of subscription time"*). Australia: the eSafety Commissioner published that after being asked about the Basic Online Safety Expectations, *"one service provider, Chub AI, decided to geo-block, or withdraw, its service from Australia."*
- The single sharpest user reaction, which is the competitive thesis for a BYOK app: *"$20 is ridiculous for access to Soji, which, being a DeepSeek v4 finetune, can be accessed for much cheaper through DeepSeek's official API… There is no reason for someone to purchase their $20 tier unless you really love the Chub UI… Just install SillyTavern or any similar frontend, folks."*
- https://www.reddit.com/r/Chub_AI/comments/1uhj2nw/chub_updates/ · https://www.reddit.com/r/Chub_AI/comments/1uhip7a/chub_is_now_dead/ · https://arcanumrpgs.com/blog/chub-ai-not-working/ (checked 2026-09-19)

**Most-complained-about limitations (2025–26), which define the wedge:**
1. **Pricing/payment crisis** — the crypto pivot, the 20-msg free tier, the deleted Mercury tier, presets broken by a silent model swap.
2. **"My lorebook didn't fire and I can't tell why"** — needs V2 Spec on; keywords scanned only within Scan Depth; whole-word matching; token budget silently drops entries. **This is the #2 complaint and it is a UX failure, not a capability failure.**
3. **Documentation is stale and self-contradictory** — the docs site says pages were "last updated 1 year ago," so third parties advise trusting the live pricing page over the docs. A community FAQ exists precisely because the official docs never keep up.
4. **Steep configuration learning curve**; **inconsistent tagging** (cards with <3 tags are hidden from search); **card definitions cannot be hidden** (by design — it's a repository first), a privacy gripe for creators.
5. **Proxy discussion is suppressed** on both the Discord and subreddit because illegal proxies are rampant and risk the community's existence.

**The verdict for a "better chub.ai": the wedge is not features — it is not being hostage to payment processors, not degrading the free tier, and modern memory + state.** Chub's users are leaving over pricing and payments, not over missing image generation.

**NSFW.** Explicitly uncensored: *"Chub is uncensored. We do not restrict in any meaningful capacity the variety of characters that are allowed to be posted on the platform nor the type of interactions you are allowed to have with said characters"* (https://docs.chub.ai/docs/the-basics/getting-started.md).

**Novel mechanics worth stealing (highest-value list in this report):**
1. **Three-tier persisted extension state, including branch-transcendent chat state.** This is the cleanest solution anyone has published to "the world must remember something even if the player rewinds."
2. **Summarize only what has fallen out of context** (the Aisu algorithm).
3. **Chat-tree branching as a first-class UI**, not a swipe hack.
4. **Sandboxed extension hosting on per-stage subdomains** — the security model for third-party code that SillyTavern lacks.
5. **Crypto-only payment to sidestep processor censorship** — a strategy, not a feature, but it's why Chub can host what it hosts.

**What's weak (the opening for "better chub.ai"):** web-only, no mobile app; chat state is available only to *extension authors*, never as a user-facing feature; no voice input; no multi-bot knowledge isolation; branching is a power-user surface with no state rollback; and the crypto-only paywall excludes most casual users.

---

## 6. JanitorAI — the scale/UX reference

**Platforms.** Web (janitorai.com), plus native apps: iOS `id6692609366` (released 2025-11-29, v2.5.0 on 2026-09-15) and Android `com.janitor.ai`. Closed source, JanitorAI INC.

**Traction (primary, read 2026-09-29).**
- Google Play: **1M+ downloads, 4.6★, 17.7K reviews**, updated 2026-09-15.
- App Store: **4.49★, 4,179 ratings**, 17+.
The app is a *beta* per its own store copy — notable that a beta has 1M+ installs.

**BYOK / proxy.** Yes — Janitor's own help centre walks users through **OpenRouter + DeepSeek** as the "easiest free option," configuring a Proxy URL + API key per config. So Janitor is a genuine BYOK frontend with its own model (JLLM) as the default (https://help.janitorai.com/en/article/tldr-quickstart-proxy-instructions-1x0fptu/).

**Model.** JLLM, in-house. **Free-tier context ≈ 8k–9k tokens.** Janitor+ gives **5× more context**, priority replies, monthly swipes with better models, and cosmetics.

**Standout features (all from Janitor's own help centre, which is unusually candid):**
- **Advanced Prompts** (a.k.a. system prompts / prompt overrides) — the feature the brief names. Janitor's own documentation is a better prompt-engineering tutorial than most paid courses: it explains why negative prompting fails (*"'No blood' is still 'blood'"*), why weak phrasing ("may", "feel free to") makes instructions optional, and why repetition is noise. (https://help.janitorai.com/en/article/advanced-prompting-101-1ka4aon/, updated 2025-07-31)
- **Chat Memory with a prescribed template** — `Environment / Relationship Dynamic / Current Plot Points / {{char}} notes / {{user}} notes / Important Past Events`. The docs tell users to use **bullet points, one verb tense, facts not scenes**, and to avoid scripting the bot. This is *manual* structured state tracking, crowdsourced to users because the app doesn't do it. Example: `- inventory: gameboy`. (https://help.janitorai.com/en/article/chat-memory-context-management-9oivt3/, updated 2026-08-11)
- **Prompting summaries** — the documented pattern for hand-rolled auto-summarization uses `<system>task: pause chat|roleplay, answer query(...)</system>` with `pause chat|roleplay` as the magic token that breaks the character. Again: users doing manually what the product should do.
- **NSFW images are banned** in character cards ("NSFW images are not permitted"), and the site has added ID verification for uncensored mode.

**Monetization (verified).** Free = unlimited chats, standard models, **~9k context**, $0. **janitor+ = $12.99 USD/mo** (launched 2026-06-24): 5× context, priority routing, monthly enhanced swipes, a **Router balance**, $5 signup Router credit, gold username + checkmark, comment emojis. No published message cap ("Usage limits apply"). Router credits are separate purchased/promotional balances; purchased credits expire no earlier than **365 days**, are non-refundable, and require an active subscription to hold or use. Payment via Stripe on web, app stores on mobile — and **app-store subscriptions cannot be cancelled from the web**.
- **janitor+ Router** (2026-07-30) is strategically important: a first-party in-site router with per-token pricing shown before you chat, model switching in settings, a built-in wallet, 10% subscriber discount, and $5 launch credit. **Janitor is building its own OpenRouter to own the margin and fund its "voice and image" roadmap** — the trade a BYOK-only product makes instead. https://janitorai.com/news/announcements/introducing-janitor-router

**Traction (verified 2026-09-29).**
- **1.4M+ daily active users** — company-stated 2025-03-27 (dated; flag it).
- **Discord: 387,316 members / 38,633 online** — live API. **This is by far the largest community in the entire scan** (Chub 27k, Risu 7.5k, Wyvern 4.6k).
- Google Play: **1M+ downloads, 4.6★, 17.7K reviews**, updated 2026-09-15. App Store: 4.49★, 4,179 ratings.
- **HypeStat estimate: ~112.5M monthly visits, ~3.7M daily, global rank #179, 90.9% mobile, 36% US.** Infrastructure posts corroborate: 500k concurrent websockets pre-Elixir, **20 billion rows in the chats table**, 50 bare-metal EPYC worker nodes, 50 Gbps egress.

**NSFW stance and the regulatory squeeze (all dated).** Adult-only 18+, enforced (ToS updated 2026-07-29). Prohibits sexualization of minors including fictional depictions, sexual violence, bestiality, gore, hate speech. **Mobile is stricter than web by design:** app launches in **Restricted Mode** (higher-content-score characters blocked, definitions hidden, keyword checks on messages), and users must opt into Unrestricted Mode **from the website, never in-app, "due to app store rules."** Geo/KYC history: UK blocked outright 2025-07-24 under the Online Safety Act; on **2026-06-15 Brazil, Australia and the UK were moved to mandatory one-time age verification via k-ID** (on-device facial age estimation or ID scan deleted after check). Janitor states it is "fundamentally against KYC for social media" and chose verification over fines of up to A$35M / R$9.5M.
- Corporate: **JanitorAI Inc** (Delaware law); **Dulova Investments Limited** (Nicosia, Cyprus) is merchant of record.

**Novel mechanics worth stealing:**
1. **The Chat Memory template** — an empirically-evolved schema for what a roleplay state record must contain (`Environment / Relationship Dynamic / Current Plot Points / {{char}} notes / {{user}} notes / Important Past Events`), shipped as *documentation* rather than as a data model. A real app should store exactly those fields as structured data. The docs even prescribe **one verb tense, bullet points, facts not scenes**, and `- inventory: gameboy`.
2. **Scripts** — a lorebook that behaves like a tiny event system rather than a dictionary: per-entry **probability rerolled every message** (no sticky state), **Min Messages** patience gates, **Inclusion Groups** that guarantee exactly one of a competing set fires, group weighting, specificity-based **Key Match Priority**, and an insertion-order override for zero randomness. It also accepts SillyTavern `entries` arrays verbatim. Its docs are honest about the failure modes (scripts don't self-activate; the model may ignore an activated entry).

**The glaring gap:** Janitor's users do the memory work by hand, in a text box, with the app's own documentation warning about "context rot" at 8–9k tokens. **Janitor has no auto-summarization, no image generation in the chat loop, no voice, no world/dungeon sim, no structured time/location state, and no true group chat** — "public chats" publish a *transcript*, not a running cast. It wins purely on scale, content library and prompt-engineering depth. That is the clearest unmet demand in the whole scan.

---

## 7. TheCodexAI — the purest BYOK-first entrant (pre-traction)

**Platforms.** Web only (Next.js, PWA-style), **closed source**. Launched on Product Hunt. No App Store or Play presence. Operator "The Codex AI Team".
- https://thecodexai.com/ · https://thecodexai.com/pricing · https://www.producthunt.com/products/the-codex-ai

**BYOK — the strongest positioning in the set.** "The Nexus Gateway": direct browser-to-LLM inference with **zero platform token markups**, client-encrypted API keys, and **18+ providers** — OpenRouter, Anthropic, OpenAI, Google, DeepSeek, xAI, Mistral, NovelAI, TogetherAI, Featherless, Infermatic, **AI Horde (100% free)**, and local **Ollama / LM Studio / KoboldCpp**. **BYOK is unmetered and $0-markup on every tier including Free** — that is the pitch.

**Claimed features** (all ™-branded; the site's marketing density is a red flag for feature inflation — treat as roadmap, not inventory) `[VENDOR-UNVERIFIED]`: **Chronicler Memory** ("autonomous background extraction of facts, relationship shifts, active quests, and inventory items with branch-aware timeline ancestry filtering and an interactive Memory Ledger" — the closest analogue to the brief's goals); **Tesseract Codex** 3-tier retrieval (exact keyword → stemmed BM25 → semantic vector); **OmniVisualizer** in-session scene painting; **Empathy Matrix** dual-axis Affection (−100..+100) / Trust (0..100) with an NPC-to-NPC relationship web; **Presence Matrix** multi-bot "Cast Lounges" with simulated online/Away/DND status and `@Name` mentions; **ChronoNexus** 2D branching multiverse map; **OmniDirectives** slash commands (`/ooc /scene /pov /timejump /whisper /steer /branch /trim /remember`); **Aegis Vault** client-side AES-256-GCM encryption; **OmniIngest** one-click SillyTavern/Chub card import; and **OmniSight** — a live prompt & token inspector.

**Pricing.** Free ($0, 1 curated model, ads) / Supporter $5 / Adventurer $10 / Legend $20 — with **BYOK free and unmetered on all tiers**. Note the site's own homepage and pricing page **disagree** on the free model and on fleet sizes, a small but telling inconsistency.

**Traction: none found.** Product Hunt shows **2 followers**; no Discord exposed; no store presence; no traffic estimate. **Assume pre-traction.**

**NSFW.** "100% Uncensored (Zero Filters)" throughout; no published content policy comparable to Chub's or Wyvern's.

**Novel mechanic worth stealing — OmniSight, the prompt & token inspector.** Nobody else in this set gives the user a live view of the assembled prompt: raw system instructions, which lore entries were injected, which vector memories activated, what macros expanded to, and exact token counts. Given that the **#1 recurring Chub complaint is "my lorebook isn't firing and I can't tell why," a first-class prompt inspector is a cheap, high-perceived-value differentiator.** It is also directly relevant to the caching hazard in §11.8 — an inspector is how you debug a cache-aware prompt layout.

---

## 8. Desktop BYOK clients

**Backyard AI (backyard.ai) — formerly Faraday.dev. These are the same product, not two.**
Faraday.dev rebranded to Backyard AI on **2024-05-13**; `faraday.dev` 308-redirects to `backyard.ai`, and the GitHub org `FaradayDotDev` does not exist. Vendor: **Ahoy Labs, Inc.** This matters because the brief listed them as separate competitors.
- **Platforms:** web + native iOS + Android (Play, last updated 2025-08-26). **The desktop app is deprecated** — `desktop.backyard.ai` states plainly: *"The desktop app is deprecated and no longer supported."* No Linux build. Closed source.
- **Not BYOK in the usual sense:** desktop was **local GGUF only**; web/mobile run Backyard's **own hosted models**. There is **no support for OpenAI/Anthropic/OpenRouter keys.** "Mobile Tethering" points the phone app at your own desktop's local model over the LAN.
- **Pricing (live 2026-09-29):** Free = 300 msgs/week, 16k context, 1 model. **Standard $12/mo** = unlimited, 16k context, all Standard models. **Pro $35/mo** = up to **100k context** plus 70B/104B models (Command R+, Euryale 70B, Magnum 72B). **The only thing gated is context size ("memory") and model tier** — lorebooks, group chats, voice and samplers are all free.
- **Features:** group chats **≤4 characters**; voice calls (StyleTTS2 cloud / Piper offline — Android reviews in Nov 2025 report calls were later **removed**); **Lorebooks** (non-recursive, keyword must appear in the **last 4 messages**, hard **384-token combined cap**); **Author's Note**; **Grammars** (GBNF constrained decoding forcing a schema, e.g. `description ::= … narrative ::= … choices ::= …`); advanced samplers.
- **No auto-summarization and no world/dungeon mode at all.** Its only "state" lever is Grammars plus a prose Author's Note — their own homepage example is `current location: island in the middle of the ocean; time: night`. **That is stateless prompting, not a state machine.**
- **Traction:** iOS **3.4★ from only 37 ratings**; Android **10K+ downloads, 3.2★, 101 reviews**; Discord 9.1k members (their own blog, May 2024). Desktop abandoned; 2026 Play reviews complain of stalled development. **This is a declining competitor, not a rising one.**
- **NSFW:** generation is unfiltered, but published Community Hub content is restricted (18+ characters, mature tags, no incest/non-consensual/photorealistic-porn).
- https://backyard.ai/plans · https://desktop.backyard.ai/ · https://backyard.ai/blog/rebranding-to-backyard · https://play.google.com/store/apps/details?id=backyard.ai.app

**Strategic read:** Backyard monetizes *memory as context size* (16k → 100k). That is precisely the paywall a BYOK app inverts — with BYOK, context is a property of the user's chosen model, not a subscription tier. But note the corollary: Backyard is proof that "no filter + local models + a nice UI" does **not** by itself win; it shipped mediocre ratings and abandoned its desktop app.

**KoboldCpp — the most feature-dense app in this entire scan, and it is free.**
`LostRuins/koboldcpp`, **AGPL-3.0, 11,901★, 786 forks, pushed 2026-09-29 (today), 532 open issues, v1.122.1.** A single-file, no-install executable for Windows/macOS/Linux/Docker/Android(Termux)/Raspberry Pi.
- **BYOK:** local GGUF/GGML for every architecture, **plus** `--nomodel` to connect to AI Horde, OpenAI-compatible endpoints, Anthropic, OpenRouter, Gemini, Grok, Mistral. It *exposes* KoboldCpp/OpenAI/Ollama/A1111/ComfyUI/Whisper/XTTS/OpenAI-Speech APIs.
- **Features:** **Adventure mode with dice rolls**; World Info with **recursive** scanning; Memory + Author's Note; persistent stories with JSON savefiles; **TextDB RAG**; **local image generation** (SD 1.5/SDXL/SD3/Flux/Qwen-Image via `stable-diffusion.cpp`); **Whisper STT**; TTS via Qwen3TTS/Kokoro/OuteTTS/Parler/Dia; **video generation** (WAN 2.2, LTX2.3); music generation; multimodal vision; **MCP server + tool calling**; bundled **KoboldAI Lite** web UI; group chat via multiple newline-separated AI names.
- **Monetization:** none. **NSFW:** unfiltered by design.

**KoboldAI-Client** (`KoboldAI/KoboldAI-Client`) — **AGPL-3.0, 3,953★, 862 forks, last push 2025-01-16.** ⚠️ **Effectively dormant (~20 months).** Development moved entirely to KoboldCpp. Ships **Adventure mode with an "Adventure roll modifier"**, Adventure-specific models, AI Dungeon adventure import, and World Info.

**KoboldAI Lite** (`LostRuins/lite.koboldai.net`) — **202★, AGPL-3.0, pushed 2026-09-20.** A zero-dependency static HTML page that runs against any backend. Story/Adventure/Chat/Instruct modes, image gen with NSFW toggle, TTS, **Whisper voice input**, MCP tools, websearch, and the one genuinely novel detail: **"Inject timestamps into context"** — the closest thing to persistent time awareness found in any client.

**Loom** — **does not exist.** `loom.chat` fails to resolve; Wayback has only two 2018–2019 captures of a parking page; GitHub searches across many phrasings return no matching project. `[UNVERIFIED — treat as nonexistent or long dead; do not plan around it]`

**DreamTavern — two different things, both dead ends.** (a) **DreamTavern by Weights** is **confirmed shut down**: its homepage states Weights and its team joined OpenAI and the products were wound down. While alive it had cards, lorebooks, personas, presets, **group chat and long-term memory** — a useful historical feature reference, not a live competitor. (b) A separate, unrelated **`dreamtavern.app`** is a **private hosted fork of SillyTavern** (identified by its `st-tailwind.css`, jQuery 3.5.1, and SillyTavern's `#shadow_popup`/`userList` IDs in the served HTML). No public repo, no pricing page, no store listing — effectively invisible.
- https://www.lumichat.ink/blog/dreamtavern-ai-review (shutdown verified 2026-08-03) · https://dreamtavern.app/login

**Most feature-complete desktop implementation of persistent world state — and the answer to the brief's specific question.**
The strongest is **KoboldAI's Adventure Mode + World Info**, not Backyard (which has none). KoboldAI gives you Adventure mode with dice-roll modifiers and a configurable pre-prompt, Adventure-tuned models, AI Dungeon adventure import, World Info as the world-state store (with KoboldCpp adding recursive entry triggering), named stories with JSON persistence, and — in Lite — timestamp injection. But this is still **prompted lore, not a state machine**: there is no location graph, no entity/inventory model, and no event log.

The most **architecturally** advanced is **Vellium** (`tg-prplx/vellium`, MIT, 134★, pushed 2026-09-24, Electron): multi-character scenes with manual turn handoff and auto-conversation, LoreBooks + world-info import, RAG with optional reranking, **"Scene State"**, Author's Note, **Prompt Stack**, **Compressed Context**, branching timelines with fork/edit/regenerate, TTS + Whisper STT, Inochi2D avatars with lip-sync, MCP tool calling, and local-first **SQLite** storage. It treats context as first-class inspectable layers — the right architecture — though it explicitly deprecates its earlier Agents subsystem, a useful signal about what did not work.

The richest **feature superset** remains `jofizcd/Soul-of-Waifu` (**1,355★**, Python, Windows, updated 2026-08-28): **Soul Stage** is a tabletop RPG engine with a **WorldState engine tracking in-game time of day, weather, active location and key facts**, deterministic dice and skill checks, hidden story arcs, a campaign board with pressure clocks, an inventory/status HUD, and no-code custom state variables with an adaptive HUD. **Soul Memory** is four isolated cognitive files (Psychology, Relationship, Episodic with local semantic embeddings, Diary) with emotional decay, memory self-healing on contradiction, and crash-safe atomic writes. Plus an autonomous desktop agent with a neurohormone simulation, gated behind a 25-second human approval banner. Windows-only, no filters.
- https://github.com/jofizcd/Soul-of-Waifu · https://github.com/tg-prplx/vellium · https://github.com/LostRuins/koboldcpp

**Minor desktop newcomers worth knowing:** **TipsyTavern** (MIT, Tauri 2 + React + Rust, world books with recursive scanning + token budgeting, real-time **context inspector**); **NeoTavern** (AGPL-3.0, self-described "successor to the SillyTavern 2 project", Tauri desktop + Android + PWA over SQLite with LLM/TTS/STT/image adapters); **TavernDesk** (MIT, C#/WPF, "structured tabletop campaigns" with editable long-term memory — its default branch is literally named "tabletop memory upgrade").

---

## 9. Mobile BYOK clients

**ChatterUI** (2,785★, AGPL-3.0, React Native + llama.cpp) — the strongest *provider breadth* on Android: local GGUF, koboldcpp, text-generation-webui, Ollama, OpenAI, Claude, Cohere, OpenRouter, Mancer, AI Horde, plus **user-definable custom API templates**. v0.10.0 (2026-09-22) added **Lorebooks**, Author Notes with depth injection, Character Links and per-character config linking. **Missing: image generation, long-term memory, group chat, scripting, STT.**

**PocketPal AI** (8,447★, MIT, 1M+ Play installs) — the highest-traction OSS mobile app, but **it is not a BYOK chat client**: on-device GGUF is the product; there are no OpenAI/Anthropic chat providers. It has **PalsHub**, a first-party persona marketplace with in-app checkout — the standout monetization model in the OSS mobile space: keep the app free and MIT, sell community personas.

**Layla** — Android, closed, on-device GGUF plus partial cloud; persona-focused. Play installs `[UNVERIFIED]`.

**MLC Chat** (23,196★ engine repo, Apache-2.0) — a research demo for the MLC compilation engine; runs local models on iOS/Android/desktop but has **no roleplay features at all** — no cards, no lorebook, no memory. It's a runtime, not a competitor.

**LettuceAI** (139★, AGPL-3.0, Tauri + React + Rust) — **the single most important mobile finding.** Android, Windows, macOS, Linux (iOS scaffolded), 20+ providers, character cards, long-term memory, Kokoro/eSpeak TTS, local llama.cpp, group chat and lorebooks. It is the **only mobile app found that combines BYOK + character cards + long-term memory + TTS + image generation + group chat.** But it has 139 stars and a near-zero user base — the feature combination is *proven possible* and *completely unoccupied*.
- https://github.com/LettuceAI/app

**Answer to the key question — is there any mobile app with BYOK + cards + long-term memory + voice + image gen?** Essentially **no, not at scale.** Every high-traction mobile app owns a subset:
- PocketPal: cards-adjacent, TTS, no BYOK, no memory.
- ChatterUI: BYOK, cards, lorebooks, TTS, no memory, no images, no group chat.
- RikkaHub (7,904★): BYOK, ST card import, "ChatGPT-like memory" — the closest at scale, but TTS and images live in forks.
- LettuceAI: everything, but ~139 users.
The full stack exists only in a 139-star repo. **That is the market gap.**

---

## 10. Hosted consumer apps — the monetization and NSFW map

Full per-app detail (pricing, install counts, model names, dated NSFW policy changes) is in the sibling findings; the decision-relevant summary:

- **Memory is the product now.** Character.AI shipped **Lorebook** + a **Memory Visualization** meter (Apr 2026, c.ai+ first) and **Pins: 15 free / 30 lite / 30 c.ai+**. Nomi sells **Mind Maps** — an editable concept graph across people/places/topics/goals. Kindroid sells a **five-tier cascaded memory ladder**. Talkie gates **RAG/vector memory** behind Pro+. Every one of these is a paywall on remembering.
- **Pricing anchor:** $9.99–$19.99/mo (Character.AI $9.99, Talkie $9.99, Kindroid $13.99, Nomi $15.99, Replika $19.99). Second meters are emerging: cosmetic currency (Replika gems, Linky coins, PolyBuzz coins, Emochi mochi), memory/context tiers, and usage metering (Chai MAX Auto at $0.66/1k tokens).
- **NSFW is a fault line with measured cost.** Character.AI banned it and lost MAU (~28M peak → ~20M). Talkie tightened and **was pulled from Google Play for two weeks** (late Apr → mid May 2026). Replika removed ERP in Feb 2023, partially restored it after backlash, and took a **€5M Garante fine**. Kindroid and DreamGen stayed permissive and command the loyalty.
- **Scale ≠ satisfaction:** Character.AI has 50M+ Play installs at **2.2★** (2.44M reviews, a collapse driven by ads and limits) while Kindroid has 1M+ at 4.4★ and 4.79★ on iOS. There is real room for a quality-first entrant.
- **Structural fragility is the argument for BYOK.** Figgs AI shut down permanently (2024-12-30); **Dot (New Computer) wound down with only weeks' notice** ("Dot will remain operational until October 5"); Xoul AI went dark for months; Talkie was pulled from Play; Chai began Apple/Google age-verification API integration on 2026-03-09. A client with no central content server is structurally immune to all of it.
- **The clearest commercial analogue for the brief's state tracking is DreamGen**: scenario-level **tracked state variables** (e.g. Love, Suspicion, Food as 0–10 integers updated per turn), resource-management mechanics, multi-character casts, and a SillyTavern import path — at $7.83–$48.30/mo. And **Tipsy Chat**'s "ScenePlay Mode" (branching cinematic scenes with choices plus generated visuals) is the most game-like mechanic among the new mobile entrants.

---

## 11. Newcomers with real traction (2025–2026)

Full ranked table in the sibling findings. The four that matter:

1. **RikkaHub** — 7,904★, Kotlin/Compose, AGPL-3.0, Play 10K+ installs at 4.7★, pushed 2026-09-29. Multi-provider (any OpenAI/Google/Anthropic-compatible API), multimodal input, MCP support, ChatGPT-like memory, **SillyTavern character card import**, QR export of providers, prompt variables, a proot Linux agent workspace. **It has spawned a whole fork ecosystem** (LastChat 366★, Rikkahub-Revised 230★, Miffan 119★, rikkahub-sillytavern-android 38★, Rikkaweb 30★, plus bridges like `tavern-rikka-bridge` and `Rikkahub2Kelivo`). Governance risk for *them*: the README states **"This project does not accept pull requests."**
2. **Kelivo** — 4,100★, Flutter, AGPL-3.0, six platforms (Android, iOS, macOS, Windows, Linux, HarmonyOS). **Long-term memory** with a background pipeline that extracts/deduplicates/merges into four typed stores (identity, workflow, voice, instructions), global or per-assistant, browsable and editable, with *"injected memories stay stable so prompt caching keeps working"* — an explicit cache-awareness most competitors lack. Plus **world books** (keyword/regex triggered with configurable position/role/depth), TTS across 10 providers, STT including offline on-device, image generation, MCP, skills, a Linux sandbox, scheduled tasks, context compression, and no account/analytics/ad SDK. **This is the single closest existing product to the user's target.**
3. **Soul of Waifu** — 1,355★; see §6. Richest feature superset found anywhere.
4. **Tolan** (hosted, 200k+ MAU, 4.8★/100k+ App Store reviews) — valuable only because **OpenAI published its architecture**: it **rebuilds the context window from scratch every turn** rather than caching (*"cached prompts just didn't cut it"*), embeds memory with `text-embedding-3-large` into **Turbopuffer** for sub-50 ms lookups, triggers recall from the latest message *plus system-synthesised questions* ("Who is the user married to?"), merges with mean reciprocal rank, and runs a **nightly compression job** to resolve contradictions. Measured result: memory recall misses down 30%, next-day retention up >20%. https://openai.com/index/tolan/

**Shutdowns / traps:** `HappyFox001/AI-Chat` has **824★ but is archived** (last push 2026-03-30); `LyubomirT/intense-rp-next` 198★ archived; `Glaze` self-describes as "vibecoded... curb your expectations"; **Dot shut down**.

---

## 12. What NO existing app does — the unserved features

### 12.1 Memory and auto-summarization — solved as a commodity, unsolved under edit
Every serious app has rolling summary + vector RAG. The state of the art is documented to the action: **AI Dungeon** writes a memory of exactly 6 actions, regenerates a full plot summary every 15 actions, embeds each memory, retrieves by similarity, and caps the Memory Bank by tier (Free 25 / Champion 100 / Legend 200 / Mythic 400), evicting least-used entries. Risu's SupaMemory does recursive compression without a vector store. **Chub** summarizes *only the messages that have already fallen out of context* (the Aisu algorithm) — the correct approach. **WyvernChat's Memory Scan** goes furthest structurally: chunked, background-capable, and it writes **typed** entries (Memory/NPC/Location/Event/Item/Concept) into a lexicon with dedup rather than dumping prose into a context block. **JanitorAI does no automatic summarization at all** — its docs teach users to write a structured memory block by hand and periodically ask the model for a recap.

**What's unserved:** *versioned, branch-aware memory.* Smart-Memory (the best OSS memory extension, 60★) explicitly warns that long-term memories are shared across checkpoints and branches and **do not roll back**, and ships a read-only mode as the workaround. No product has memory that rewinds with the chat.

### 12.2 Persistent time/location/state — **one commercial product has now shipped it; the rest are prose-only**

**Correction to the common assumption: WyvernChat has already shipped structured location/world state.** Its **Worlds** system is a nested **Environments → Locations** hierarchy with **parent-location inheritance** (each ancestor contributes context, character pool and lexicon), character pools with participation weights, per-location include/exclude lexicon filters, and a **documented instruction-precedence stack (World → Environment → Location, last wins)** — plus Timeline & Eras, Relationships & Attitudes, Travel, and an RPG stat system with point-buy, stat roles mapped to combat math, and threshold-based labels so the model reads `Strength: high` instead of `Strength: 6`. That is a genuine, shipping, structured state model with a proven UX shape.

**DreamGen** also ships per-scenario **tracked state variables** (e.g. Love, Suspicion, Food as 0–10 integers updated per turn), though they are scenario-local counters rather than a world clock.

Everything else is prose-only. Structured world state otherwise exists **only in OSS**, and only twice done properly:

- **Marinara Engine's Game Mode** computes state **in engine code, not in the LLM**: a fixed clock (start Day 1 08:00; talking +15 min, exploring +30, combat round +5, short rest +1 h, long rest +8 h, travel +2 h, day rolls at midnight), biome+season weather, party morale 0–100 in five bands that silently modifies dice by ±2, grid or node maps, and engine-rolled dice the GM never invents. Its **World Maps** agent holds nested regions→settlements→buildings→floors→rooms and **validates movement from the user's message — the narration cannot move the map.**
- **Multihog D&D Framework** (85★, GPL-3.0) — a second-pass state extractor injecting a rolling State Memo, **Hybrid RNG** with a pre-seeded deterministic dice queue plus **tool-call RNG with commitment logic** (the AI must declare a DC *before* seeing the result, which structurally prevents sycophancy), and **World Progression**, a location-centric macro simulator that emits daily reports and repopulates dungeons while you're away.

**No hosted consumer companion does structured state.** Character.AI, Nomi, Kindroid and Talkie do prose memory only. **Latitude deliberately declined to port AI Dungeon's game state** (health, quests, inventory, levels) from Voyage, calling AI Dungeon "a collaborative storytelling experience."

**On the desktop side, the strongest is KoboldAI's Adventure Mode + World Info** (KoboldAI-Client and KoboldCpp), with dice-roll modifiers, AI Dungeon adventure import, recursive World Info entries as the world-state store, named-story JSON persistence, and timestamp injection in KoboldAI Lite. **Backyard AI has none of this** — no adventure mode, no dungeon, no dice, no time/location tracker; only GBNF Grammars plus a prose Author's Note. **But even KoboldAI is prompted lore, not a state machine:** no location graph, no entity/inventory model, no event log.

**What's still unserved:** a single canonical world clock + location + inventory store that survives **across sessions, across characters, and across chat branches**, queryable as data rather than prose. Wyvern's Worlds is **web-only, closed, and Teen+** — it is not available on mobile, not BYOK-portable as data, and its location graph is authored rather than procedural. Marinara scopes time per-game; Smart-Memory's State Ledger is explicitly chat-scoped; nothing lets the world advance while you're away except Multihog's one-off extension. **And nothing in this category is cross-platform mobile.**

### 12.3 Multi-bot with per-character knowledge isolation — **the single biggest defensible gap**
Multi-bot scenes are universal (CAI Rooms, Nomi ≤10, Kindroid ≤10, Risu, Agnai, Marinara). **Knowledge isolation is essentially absent.**

- **Kindroid** isolates *cards*, not *knowledge*: "Each Kindroid will be able to access its own backstory and memories, but not each other's" — but group history consolidates into each participant's long-term memory, and its own docs frame the "secret conversation" use case as *you* keeping the secret.
- **Nomi** isolates by **room**, not by character: "All Mind Map entries are completely private to the rooms they are formed in."
- **SillyTavern** explicitly does **not** isolate: "No matter the choice, the group chat history is always shared between all members," with the two modes being "swap cards" (only the active speaker's card in context) or "join cards" (docs warn this causes "characters being confused about themselves, having merged personalities").
- Only **Smart-Memory** implements real epistemic isolation — a per-character knowledge map across `knows` / `suspects` / `believes (false)` / `unaware` / `hiding (from a specific other)`, with the responding character's block injected privately, memories from scenes they missed tagged `[secondhand]`, and independent memory/profile/state stores per group member. It has **60 stars.**

**The academic evidence is damning.** SocialMemBench (arXiv 2605.17789v1, 2026-05-18; 43 synthetic social networks, 430 personas, 7,355 turns) found four OSS memory frameworks (Mem0, LangMem, Graphiti, Cognee) scoring **0.12–0.18** — *below* uncompressed raw-turn retrieval (0.345). Theory-of-mind questions scored **0.05–0.10 across all four.** The paper names the missing primitive: a **`KNOWS_ABOUT` cross-persona edge**, "absent from every framework we evaluated." Graphiti scored **0.00** on departed-member recall.

**A productized per-character belief store with cross-persona edges, surviving member departure, is available to whoever builds it first.**

### 12.4 Image generation tied to the scene — solved in OSS, absent commercially
**Automatic narrative-triggered illustration is BYOK/OSS-only.** Commercial apps do *prompted* selfies; nobody does *narrative-triggered* art.
- **Marinara Illustrator** runs as a post-processing agent, decides whether the moment is worth a picture, writes the prompt, and calls your image connection — default cadence every 5 accepted messages, six prompt modes, and on NovelAI V5 it emits **per-character captions (up to 22 characters)** specifically to stop traits leaking between characters in group scenes.
- **SillyTavern Auto Illustrator** has the model emit invisible image prompts inline during streaming, detected by regex.

**What's unserved:** *persistent visual identity.* Nobody maintains a record of a character's face, current outfit and injuries and feeds it into every generation. Marinara's Beholder (body-slot clothing, wounds, held items) + Attach Card Appearance are the closest, and they are two separate opt-in agents.

### 12.5 Voice in and out — technically solved, not integrated
- **Best OSS full-duplex: Moshi** (Kyutai, Apache-2.0, 7B) — speech-token-native, **sub-200 ms**, genuinely interruptible. Needs 16 GB VRAM FP16 / 10 GB quantized; **CPU-only is not real-time**; MOS 3.8 vs GPT-4o voice 4.5.
- **Best OSS TTS: Kokoro-82M** (Apache-2.0) — **RTF 0.1238 on CPU** (8× real-time), UTMOS 3.6899, the highest in the Aug-2026 VCTK benchmark. Under $0.06/hr of audio via API; free self-hosted.
- **Realistic latency budget:** VAD ~50 ms → streaming STT 100–200 ms → LLM TTFT 150–400 ms → TTS first chunk 40–150 ms → transport 20–80 ms. The commonly-ignored killer is the **MP3→Opus re-encode at 200–500 ms**.
- **Cost per hour of conversation** (~50% talk time): STT ~$0.20 (Deepgram Flux) or ~$0 self-hosted; TTS ~$0.45 (OpenAI) / ~$0.90 (Deepgram Aura-2) / **~$5.40 (ElevenLabs)** / **~$0 self-hosted Kokoro**. So a BYOK companion runs voice for **$0.20–$1.00/hr**, or near-zero self-hosted.
- **What ships today:** SillyTavern has 13 TTS backends including in-browser Kokoro via WebGPU. Marinara Calls does live audio/video calls with **Local Whisper ONNX** so mic audio never leaves the machine, plus `[whispering]`/`[laughs]` cues that drive both TTS and reaction video clips.

**What's unserved:** (a) **full-duplex interruptible voice in any BYOK app** — Moshi exists and no frontend integrates it; (b) **persistent per-character voice identity across sessions**, the way text memory persists. Marinara's phonetic-name field is the closest and only applies inside calls.

### 12.6 World / dungeon simulation — two excellent OSS implementations, zero commercial ones
Covered in §10.2. The two references are **Marinara Game Mode** (engine-authoritative state, three call types, blind-draft dice arbitration where the GM writes both a success and a failure branch and the engine deletes the unselected one) and **Multihog D&D Framework** (second-pass extraction, commitment-logic RNG, autonomous world progression, map evolution). **LoreKeeper** (€7.99/mo) is the closest commercial analogue but is a hosted RPG, not a companion app. AI Dungeon has **no dice, no inventory, no state machine** — by choice.

**What's unserved:** a **procedurally generated dungeon that is generated once and then remembered as data** (topology, loot state, enemy positions, opened doors) rather than re-narrated. Marinara's maps are authored/AI-drafted then held; Multihog's Map Evolution approximates autonomy in a single extension.

### 12.7 The composite gap — the wedge

> **No product combines (a) engine-authoritative structured world state, (b) per-character epistemic isolation, and (c) cross-session persistence — while being BYOK and cross-platform.**

Marinara does (a) and (c) partially; Smart-Memory does (b); neither does both, and neither is cross-platform mobile. Kelivo and LettuceAI are the only BYOK apps shipping one codebase across desktop and mobile with memory intact.

**The nearest threat is WyvernChat, which has already shipped (a) and (c)** — worlds with location inheritance, timelines, RPG stats and typed memory extraction — but **not (b)**, and it is web-only, closed, Teen+, and single-maintainer. **Per-character epistemic isolation (§12.3) is therefore the most durable gap in this report** — it is the one thing nobody has shipped, that the literature says every existing system fails, and that Wyvern's architecture does not address.

### 12.8 One architectural hazard nobody has solved
**Dynamic prompt sources destroy prompt caching.** SillyTavern documents that vector RAG breaks caching; Smart-Memory notes injected memories must stay stable to preserve it. Tolan's answer was to abandon caching entirely and rebuild context every turn — viable when you own the model bill, ruinous when the user does. **A BYOK app that wants cheap long-context memory must design a stable prompt prefix with cache-aware layout.** This is a genuine unsolved constraint and a real design opportunity.

---

## Sources

**Risu AI**
- https://github.com/kwaroran/RisuAI
- https://github.com/kwaroran/RisuAI/wiki/SupaMemory
- https://github.com/kwaroran/RisuAI/wiki/TTS
- https://github.com/kwaroran/RisuAI/blob/main/plugins.md
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/memory/hypav3.ts
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/parser/chatVar.svelte.ts
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/group.ts
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/plugins/apiV3/risuai.d.ts
- https://risuai.net/
- https://api.github.com/repos/kwaroran/RisuAI
- https://api.github.com/repos/kwaroran/RisuAI/releases
- https://discord.com/api/v10/invites/JzP8tB9ZK8?with_counts=true
- https://github.com/PocketRisu/PocketRisu
- https://www.promptquorum.com/power-local-llm/risuai-review (2026-09-12)
- https://deepwiki.com/kwaroran/RisuAI/5.5-image-generation-and-dynamic-assets
- https://en.namu.wiki/w/RisuAI

**WyvernChat**
- https://app.wyvern.chat/
- https://wiki.wyvern.chat/
- https://wiki.wyvern.chat/en/FAQ
- https://wiki.wyvern.chat/en/Connections
- https://wiki.wyvern.chat/en/Paid/Content-Limits
- https://wiki.wyvern.chat/en/Paid/Memory-Scan
- https://wiki.wyvern.chat/en/Paid/Featherless-Subscription
- https://wiki.wyvern.chat/en/Advanced/Lexicon
- https://wiki.wyvern.chat/en/Features/StoryEngine
- https://wiki.wyvern.chat/en/Features/Worlds/Environments-Locations
- https://wiki.wyvern.chat/en/Features/Worlds/RPG-Stats-Blueprints
- https://wiki.wyvern.chat/en/Policies/Moderation
- https://featherless.ai/pricing
- https://rpwithai.com/wyvernchat-an-ai-roleplay-platform-ready-to-soar/ (2025-09-25)
- https://rpwithai.com/an-interview-with-nev-wyvernchat-its-history-challenges-and-more/ (2026-01-26)
- https://discord.com/api/v10/invites/wyvernchat?with_counts=true

**JanitorAI (news + infra)**
- https://janitorai.com/plus
- https://janitorai.com/news/announcements/introducing-janitor-router (2026-07-30)
- https://janitorai.com/news/announcements/introduction (1.4M DAU, 2025-03-27)
- https://janitorai.com/news/announcements/15 (infra: 20B chat rows)
- https://janitorai.com/news/announcements/20 (mobile Restricted Mode)
- https://janitorai.com/news/announcements/24 (k-ID age verification, 2026-06-15)
- https://janitorai.com/term (ToS, updated 2026-07-29)
- https://help.janitorai.com/en/article/what-are-scripts-a-beginner-friendly-overview-1s89w2x/ (Scripts, updated 2026-05-04)
- https://discord.com/api/v10/invites/janitorai?with_counts=true
- https://hypestat.com/info/janitorai.com (ESTIMATE)

**Chub.ai (2026 crisis + traction)**
- https://www.reddit.com/r/Chub_AI/comments/1uhj2nw/chub_updates/ (2026-06-28 crypto pivot)
- https://www.reddit.com/r/Chub_AI/comments/1uhip7a/chub_is_now_dead/
- https://www.reddit.com/r/Chub_AI/comments/1qt3g9y/info_about_subscription_issues/
- https://arcanumrpgs.com/blog/chub-ai-not-working/ (checked 2026-09-19)
- https://theunofficialguidetochubai.wordpress.com/faq/ (Chub+Venus merge history)
- https://docs.chub.ai/docs/the-basics/character-creation.md (macros)
- https://docs.chub.ai/docs/advanced-setups/prompting.md
- https://docs.chub.ai/docs/inference-api/usage-with-third-party-uis.md
- https://docs.chub.ai/docs/patch-notes/0.5.7.md (iOS return)
- https://discord.com/api/v10/invites/chubai?with_counts=true (27,125 members)
- https://hypestat.com/info/chub.ai (ESTIMATE)
- https://dreamgen.com/blog/articles/chub-ai-review (452 weekly contributors)

**TheCodexAI**
- https://thecodexai.com/
- https://thecodexai.com/pricing
- https://www.producthunt.com/products/the-codex-ai (2 followers)

**DreamTavern (negative results)**
- https://api.github.com/search/repositories?q=DreamTavern (1 unrelated result)
- https://play.google.com/store/search?q=DreamTavern&c=apps (no exact match)
- https://itunes.apple.com/search?term=DreamTavern&entity=software&limit=10 (no match)
- https://www.lumichat.ink/blog/dreamtavern-ai-review (Weights/OpenAI shutdown, verified 2026-08-03)
- https://flowgpt.com/guide/dreamtavern (archived product guide)

**Agnai**
- https://github.com/agnaistic/agnai
- https://github.com/agnaistic/agnai/blob/dev/README.md
- https://github.com/agnaistic/agnai/blob/dev/instructions/memory.md
- https://github.com/agnaistic/agnai/blob/dev/instructions/novel.md
- https://agnai.chat/

**Chub.ai / Venus**
- https://chub.ai/
- https://venus.chub.ai/subscription
- https://docs.chub.ai/docs/llms.txt
- https://docs.chub.ai/docs/the-basics/getting-started.md
- https://docs.chub.ai/docs/the-basics/just-chatting.md
- https://docs.chub.ai/docs/the-basics/api-connections.md
- https://docs.chub.ai/docs/advanced-setups/lorebooks.md
- https://docs.chub.ai/docs/stages/overview.md
- https://docs.chub.ai/docs/stages/developing-a-stage/state.md

**JanitorAI**
- https://help.janitorai.com/en/category/user-guides-vtspde/
- https://help.janitorai.com/en/article/advanced-prompting-101-1ka4aon/ (updated 2025-07-31)
- https://help.janitorai.com/en/article/chat-memory-context-management-9oivt3/ (updated 2026-08-11)
- https://help.janitorai.com/en/article/tldr-quickstart-proxy-instructions-1x0fptu/ (updated 2025-08-01)
- https://help.janitorai.com/en/article/faq-subscription-janitorai-1o8ccf2/ (updated 2026-06-25)
- https://play.google.com/store/apps/details?id=com.janitor.ai
- https://apps.apple.com/us/app/janitor-interactive-stories/id6692609366
- https://itunes.apple.com/search?term=janitor+ai&entity=software&country=us

**Mobile BYOK clients**
- https://github.com/Vali-98/ChatterUI
- https://github.com/a-ghorbani/pocketpal-ai
- https://github.com/LettuceAI/app
- https://github.com/mlc-ai/mlc-llm
- https://play.google.com/store/apps/details?id=ai.character.app

**Desktop / newcomer repos**
- https://backyard.ai/
- https://backyard.ai/plans (pricing + feature matrix, read 2026-09-29)
- https://backyard.ai/desktop
- https://desktop.backyard.ai/ (desktop deprecation notice)
- https://backyard.ai/blog/rebranding-to-backyard (Faraday → Backyard, 2024-05-13)
- https://backyard.ai/docs/creating-characters/lorebooks
- https://backyard.ai/community-guidelines
- https://web.archive.org/web/20241220231306/https://faraday.dev/ (redirect proof)
- https://apps.apple.com/us/app/backyard-ai/id6498968886
- https://play.google.com/store/apps/details?id=backyard.ai.app
- https://github.com/KoboldAI/KoboldAI-Client
- https://github.com/KoboldAI/KoboldAI-Client/wiki/Memory,-Author's-Note-and-World-Info
- https://github.com/LostRuins/koboldcpp
- https://raw.githubusercontent.com/LostRuins/koboldcpp/concedo/README.md
- https://lite.koboldai.net/
- https://github.com/tg-prplx/vellium
- https://raw.githubusercontent.com/tg-prplx/vellium/main/docs/vellium/chat-and-rp.md
- https://github.com/RebootFlume/TipsyTavern
- https://github.com/Disya123/NeoTavern
- https://dreamtavern.app/login (private SillyTavern fork)
- https://github.com/jofizcd/Soul-of-Waifu
- https://github.com/rikkahub/rikkahub
- https://github.com/Chevey339/kelivo
- https://github.com/Project-N-E-K-O/N.E.K.O
- https://github.com/heshengtao/super-agent-party
- https://github.com/kiyotakali/Miru
- https://github.com/newideas99/open-dungeon
- https://github.com/tg-prplx/vellium
- https://github.com/Cocolalilal/LastChat
- https://github.com/jialmaster/SillyDroid
- https://github.com/HappyFox001/AI-Chat (archived)
- https://new.computer/ (Dot shutdown notice)
- https://openai.com/index/tolan/ (architecture, MAU, retention; 2026-01-07)

**Hosted consumer apps**
- https://play.google.com/store/apps/details?id=com.weaver.app.prod (Talkie)
- https://play.google.com/store/apps/details?id=com.Beauchamp.Messenger.external (Chai)
- https://chai-ai.com/faq
- https://www.chai-ai.com/pricing
- https://play.google.com/store/apps/details?id=com.aigc.ushow.ichat (Linky)
- https://support.linke.ai/terms-of-service
- https://nomiaicom.com/pricing
- https://nomiaicom.com/features/mind-maps
- https://itunes.apple.com/lookup?bundleId=com.kindroid.app
- https://play.google.com/store/apps/details?id=com.kindroid.app
- https://kindroid.ai/docs/article/memory
- https://play.google.com/store/apps/details?id=ai.replika.app
- https://v2.dreamgen.com/pricing
- https://huggingface.co/dreamgen
- https://play.google.com/store/apps/details?id=com.tipsyturbo.app (Tipsy Chat)
- https://play.google.com/store/apps/details?id=ai.socialapps.speakmaster (PolyBuzz)
- https://play.google.com/store/apps/details?id=com.flow.mobile (Emochi)
- https://www.businessofapps.com/data/character-ai-statistics/
- https://blog.character.ai/pipsqueak2-and-more/ (2026-04-14)
- https://blog.character.ai/u18-chat-announcement/ (2025-10-29)

**Feature-gap primary sources**
- https://help.aidungeon.com/faq/the-memory-system
- https://github.com/Pasta-Devs/Marinara-Engine
- https://raw.githubusercontent.com/Pasta-Devs/Marinara-Engine/main/docs/game/map-time-weather.md
- https://raw.githubusercontent.com/Pasta-Devs/Marinara-Engine/main/docs/game/dice-and-skill-checks.md
- https://raw.githubusercontent.com/Pasta-Devs/Marinara-Engine/main/docs/media/illustrator-agent.md
- https://raw.githubusercontent.com/Pasta-Devs/Marinara-Engine/main/docs/conversation/calls.md
- https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework
- https://github.com/senjinthedragon/Smart-Memory
- https://github.com/Lodactio/Extension-Summaryception
- https://github.com/SenriYuki/SillyTavern-Horae
- https://github.com/gamer-mitsuha/sillytavern-auto-illustrator
- https://docs.sillytavern.app/usage/core-concepts/groupchats
- https://arxiv.org/html/2605.17789v1 (SocialMemBench, 2026-05-18)
- https://lore-keeper.com/en/features
- https://huggingface.co/api/models/hexgrad/Kokoro-82M
- https://heyneo.com/blog/voice-cloning-models-cpu-benchmark (2026-08-15)
- https://www.hermify.io/en/blog/hermes-agent-voice-latency-tuning (2026-08-15)
- https://deepgram.com/pricing
- https://www.cartesia.ai/pricing
- https://elevenlabs.io/pricing

**Unavailable sources (documented)**
- reddit.com / old.reddit.com — DNS-sinkholed on this host; `.json` endpoints time out
- api.pullpush.io — HTTP 429 mid-run ("does not provide free scraping resources for agents")
- r.jina.ai — 403; redlib mirrors — 429/410/502
- api.chub.ai/search — 403 (Cloudflare)
- chub.ai/ — 403 (Cloudflare) via `read`; readable via headless browser
