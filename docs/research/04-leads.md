# Lead research: Horde Studio, Simulith, lutopia/awesome-ai-companion, 3 r/SillyTavernAI threads

Fetched 2026-09-29. Reddit is **unreachable from this host** (`reddit.com` DNS is poisoned to a
sinkhole; `old.reddit.com` and `www.reddit.com` both ERR_CONNECTION_TIMED_OUT from the headless
browser; r.jina.ai proxy returns 403; redlib mirrors 429/410/502; safereddit is behind Anubis PoW).
All three threads and their full comment trees were recovered via the **PullPush** archive API
(`api.pullpush.io/reddit/search/comment/?link_id=<id>`), which is unauthenticated and worked first
try. Post bodies come from `search/submission/?ids=<id>`.

---

## 1. ddkhan24/hordestudio — "Horde Studio 18"

https://github.com/ddkhan24/hordestudio

**What it is.** A local, self-hosted, creator-focused web app: SillyTavern-compatible character
cards + AI-Dungeon-style persistent "Living Worlds" + a "Virtual Humans 2.0" life simulator +
optional RPG rules + host-owned multiplayer + "Video Adventures". Explicitly positions itself as
*not* a SillyTavern replacement, but as the simulation layer around it.

**Stack.** Deliberately boring and buildless: vanilla HTML/CSS/JS frontend (`app.js` is **50,329
lines**), IndexedDB for browser state, a Python-stdlib local bridge (`horde_mcp_bridge.py`) bound to
127.0.0.1, SQLite (`vh2-worlds.sqlite`) + a Node.js runtime for VH2. **No npm install, no build
step, no bundler.** Python 3 + Node 18+ required. Downloads as a portable ZIP with per-OS launchers.
Provider model: OpenAI-compatible chat completions (OpenRouter, GPTProto, NanoGPT, NVIDIA NIM,
Bedrock) + local (Ollama, LM Studio, KoboldCpp, llama.cpp, vLLM, text-gen-webui); images via ComfyUI
API-format workflows or local OpenAI-compatible image servers; TTS via browser/provider; weather via
Open-Meteo; MCP for Higgsfield/Magnific.

**Traction.** 59 stars / 9 forks; created 2026-07-31, pushed 2026-09-25 — ~2 months old and shipping
releases roughly weekly (v16.6 → v18.2 across ~15 releases). Release downloads are tiny: **47 / 28 /
8** for the last three. Effectively a single-author project (56 of 57 commits; the one outside
contributor contributed an issue-derived fix). A Discord exists (discord.gg/9eyjcMbsST).

**License: NONE.** GitHub reports `license: none`. The author is aware — the internal marketing doc
says *"The project license remains unverified. The public-source wording here is intentional; do not
change it to 'open source' without the actual license."* So it is **source-available, not open
source**. For a from-scratch project this matters: you may read it for design, but you cannot copy
code.

**Lessons learned (this is the most valuable part of the lead).** The repo ships unusually honest
engineering docs under `docs/`. `docs/critical-engine-audit-2026-09-06.md` is a self-audit whose
verdict is *"I would not ship this as a dependable persistent world or life-simulation engine yet…
Different subsystems implement different realities."* Concretely:

1. **Async results must be bound to a timeline/identity.** VH consumes a pending reply *before* the
   model call completes, and persists that consumption — a crash loses the user's message. Fix
   prescribed: persist a **reply job** with `queued/claimed/generating/ready/delivered/failed`, claim
   via expiring lease, finalize response+consumption atomically, idempotency key, recover
   unfinished jobs on reopen.
2. **Every job must capture `{humanId, timelineId, revision}` at initiation.** Switching timelines
   mid-request let an A-request mutate a B-runtime and persist into the wrong timeline.
3. **One movement system, or actors teleport.** Player movement resolved paths; schedules and
   background NPC actions assigned `location` directly. Result: NPCs "disappeared" when a temporary
   pin expired, because a schedule silently relocated them to an unreachable node. Fix: schedules
   *propose*; only committed movement events change occupancy.
4. **Buttons and typed text must go through one command path.** The exit-click handler mutated and
   saved location *before* calling the turn function that contains the pending-check gate.
5. **Never let a prose scanner manufacture state.** A regex "departure detector" read
   `"Ada refuses to leave the room."` as Ada departing, and recovery applied it — setting location to
   `null`.
6. **Storage grows unboundedly.** v18.2 added a storage optimizer: a 100-day synthetic DB went
   144 MB → ~4 MB while preserving canonical state, transcript, media and landmarks. Bounding
   fine-grained ledgers with verified checkpoints, keeping "tentpole" memories permanent.
7. **Model-output robustness is the #1 bug source.** v18.0.3 = "one bounded recovery attempt for
   confirmed malformed replies"; v18.1.1 = "recover ready Virtual Human replies"; v18.0.1 = "fix VH2
   reply context and text bursts". Issue #4 root cause: hardcoded model IDs in starter presets
   overrode the user's global default and produced provider errors — a classic BYOK footgun.
8. **Open issue worth heeding:** *"SillyTavern PNG import drops character metadata (creator_notes,
   tags, alternate_greetings, extensions)"* — they unwrapped the V2/V3 PNG envelope but only mapped
   a subset of fields. Card interop is a real, ongoing tax.
9. **`docs/labs-local-cognition-design.md`** is a genuinely reusable pattern: a tiny local model runs
   *narrow* jobs (bounded input, canonical-ID vocabulary, strict JSON schema, one task's examples,
   deterministic validator, no-model fallback) and only ever emits *candidates* that existing
   reducers validate and commit. Invariants: "Off means identical behavior", "the tiny model never
   writes canonical state", "no continuous minute-by-minute inference" (catch time up from
   timestamps + schedule boundaries), "no mandatory second foreground call", "failure is invisible",
   "budgets are hard limits", "every accepted proposal is explainable" (debug receipt stores task,
   input fingerprint, candidate, confidence, validator decision, reason).
10. **UX lesson** (`docs/vh-feedback-rework-20260920.md`): they had nine studio tabs + twelve
    workspace sections, and presented life-configuration *before* the first conversation. Proposed
    fix: Chat is the default destination; `Person` / `Life` / `Settings` secondary; "Start
    conversation" reachable from character creation. Also: a character "appearance" field silently
    truncated to 800 chars because the textarea didn't disclose the limit.

---

## 2. Chechelpo/Simulith (the reddit lead "FRPLM") — graph-based world simulation

Reddit post: https://www.reddit.com/r/SillyTavernAI/comments/1v9ftps/ (30 pts, 7 comments,
2026-07-29) → https://github.com/Chechelpo/FRPLM (renamed **Simulith**).
Repo: https://github.com/Chechelpo/Simulith · site https://simulith.com

**What it is.** A long-term-session LLM frontend focused on **a world rather than individual
characters**. World → region tree (regions within regions) → locations → characters, each with its
own description *and its own lorebook*. Locations are a **directed graph** whose edges separately
encode *traversability* and *visibility* — an edge can be walkable or not, and can expose the
destination's door description instead of the room's. Default world is the Red Moon Inn of Ubersreik.

**Stack.** Java backend (`frplm-engine`, run as `java -jar`, serves http://localhost:8080) + a
TypeScript/JS frontend, split into three packages. Extension SDK published to npm **and** Maven
Central. 121 commits, 8 stars, 1 fork. License **PolyForm Noncommercial 1.0.0** (read as
non-commercial source-available).

**Traction / staleness.** Created 2026-04-25, last push 2026-09-07; last release tag `0.1.1`
(2026-08-01). Small and slow-moving, but the author is responsive and is actively designing a "2P"
(second-player/multi-agent) mode. He also runs a Patreon (patreon.com/Simulith) for dev posts.

**Lessons.** The author's own answers in the thread are the payoff:
- **Per-character knowledge vs. global location knowledge is unsolved by lorebooks alone.** Asked
  "can two characters know different things about the same location?", he answers: you can put the
  location's information in each *character's* lorebook instead of the location's, but then a
  location with both characters present gets the union of what they both know — you're relying on
  the LLM to sort out who knows what. He calls current control "pretty coarse grained" and says the
  fix is to let lorebook entries **query Prolog for the session's current state** instead of
  keyword-matching.
- **Cross-language porting is a dead end for a solo dev.** Asked to port to "Lumiverse", he declines:
  "I really suck at both [TS and JS]… its mostly written in Java". He notes the *backend* is
  reusable but the editors would have to be rewritten.
- Two commenters asked for **example screenshots on GitHub** and one praised "multi-char lorebooks" —
  i.e. multi-character lore scoping is the feature people actually want.

---

## 3. lutopia.app/companion/ + DasterProkio/awesome-ai-companion

https://lutopia.app/companion/ · https://github.com/DasterProkio/awesome-ai-companion
(813 stars, 81 forks, CC0-1.0, created 2026-07-03, pushed 2026-09-29 — actively curated, ~1–3 adds/day)

**What it is.** A curated index of **221 entries** (the site says "190 projects" / "149 authors";
the README has 221 bullet entries) across **11 categories**, plus a searchable/filterable web front
end with status tags (`ready` = usable app · `adapt` = needs setup/customization · `infra` = building
block · `verify` = unfinished or unclear), platform tags, a beginner guide, an FAQ, a changelog, and
an `llms-full.txt` plain-text export designed to be pasted into an LLM. Strong Chinese-language
bias in authorship; the maintainer claims to have read the code of every listed project.

**Its own recommended "paths".** No-code → SullyOS / whale phone / ZeroChat. Some tinkering →
RikkaHub or Kelivo + dylan-heartbeat + ai-memory-gateway. Full stack → Headlong or AstrBot as
backbone, Aelios/Paramecium for memory, GPT-SoVITS for voice. Explicit warning list: check licenses
(AGPL / PolyForm NC restrict commercial use), **watch for author's personal defaults baked in**, and
read the code for anything tagged `verify`.

**Its framing document** (`INITIATIVE.md`) is a useful statement of the market's emotional core:
*"your companion's identity ultimately lives inside a model you do not control… Exporters safeguard
chat history, but cannot prevent weights from being overwritten overnight."* The pitch is a "digital
birth certificate" / "mind snapshot" and CC0-donating persona+memory as cultural heritage.

**Full enumeration (221 entries by category, counts as listed):**

- **Companion Clients & Workspaces (23):** RikkaHub, LastChat, rikkahub-auto-compress, orangechat
  (橘瓣), Operit, Aura, Scowld, YSClaude, Polaris, chatnest, AionsHome, Ocean, Miru, LumiMuse,
  My Raze, the-house, Claude Code, CcCompanion, Pando, CC Companion App, ackem, mousecrew, yoji
- **Virtual Phones & Companion Spaces (13):** KI-CO (小屋), InternalBeyond (边界之外), 柚月小手机
  (Yuzuki's Little Phone), AI Virtual Phone, 汪汪机 (WangWangPhone), XSJDeveloperGuide, freeapp
  (whale小手机), Hamster Nest (仓鼠小窝), SullyOS (手抓糯米机), ZeroChat, LandricSpace, Atrio,
  dwell-on-something
- **Background Heartbeats & Proactive Messaging (19):** Headlong, AI Companion Runtime, AstrBot,
  astrbot_plugin_proactive_chat, astrbot_plugin_private_companion, Tidal_Echo (潮汐回响),
  Claude Imprint, Not Fade Away, cloud-and-island (云与岛), Keep the Crow (把乌鸦留在身边),
  dylan-heartbeat, OmniRouter, VCPToolBox, cyberboss, ghost-bf, jiwen (积温), revive-companion,
  ai-surf-when-bored, proactive-web-surf-agent
- **Memory, Identity & Emotion State (25):** Ombre-Brain, Serein, Kin Mind, WrenWen, Paramecium,
  Memory Constellations (记忆星图), omemo, Aelios, kiwi-mem, ai-memory-gateway (now **Pawwake**),
  nocturne_memory, imprint-memory, astrbot_plugin_livingmemory, astrbot_plugin_self_learning,
  rolling-memory, moraine-home, Drivesoid, chord-affect-anchors, OmniDimen-Emotion, Eventide,
  Tidefall, ai-companion-cot-emotion, emotion-system, dreams, pilulier (药盒)
- **Voice, Visual Presence & Embodiment (32):** GPT-SoVITS, fish-speech, CosyVoice, index-tts,
  Callhome, voice-mcp, binaural-voice, Gove, erpan (耳畔), murmur, ai-live2d-body, Ghost Vessel,
  AIRI, Open-LLM-VTuber, super-agent-party, Soul-of-Waifu, ChatdollKit, Amica, Neuro, LingChat,
  astrbot_plugin_chuanhuatong, Shinsekai, pelle-d-umore, stackchan-mcp, ROBOTO_ORIGIN,
  phantom-touch-bridge, claude-f-me, svakom-ble-ai, Toy-Relay-AI-mcp-SOSEXY, cachito-ble-mcp-relay,
  astrbot_plugin_meme_manager, cove-sticker-mcp
- **Perception (10):** Whisper, whisper.cpp, faster-whisper, FunASR, SenseVoice, voice-familiarity,
  ears, whale-listen, gaze, cove-sensory-mcp
- **Services & Real-World Integrations (11):** OpenCLI, Amap MCP Server, Open-Meteo Weather API,
  McDonald's MCP, Luckin Coffee skill, Agent Email (NetEase), Agent Email (QQ), ai-time-weather-phone,
  always-here (驻守), Akari Pulse, dsh-toy
- **Game Worlds & Agent Toys (28):** arcade, Detroit AI Player, Jishi Simulated Market (机市),
  cedareco (瓶中生态), Crucible Echoes (坩埚余响), AI Life Board Game, noon-burger-shop (午间汉堡店),
  Camping Plaza (露营广场), random-imitator-td, ci-yu-wu (词语屋), shangzhuochifan (上桌吃饭),
  ai-fishing-game, aifarm-oss, WORKKK, Memoria Station, Moonlit Myriad (月幕万象), NagiBridge,
  OpenMMO, Mineflayer, spicy-monopoly, Sky PC MCP Companion, sky-with-you, TouhouLittleMaid,
  coc-kp-host, Mochi, 小机斗地主 (Doudizhu), CedarDuet (双弈), 西窗 (West Window)
- **Shared Activities & Media (26):** Phosphene, shared-page, memex, scentfolio, sealed-days,
  wake-lottery (唤醒抽奖), ss-reading-nest (共读小窝), reading-nook (共读小屋), co-reading-kit,
  tasogare (黄昏), film-matinee, Duetto, SameWindow, whale-browser-extension, echo-reading,
  coread (共读室), coread-reading-room, cove-book-forge-mcp, netease-music-mcp, Listening Bridge,
  woaini, clawd-on-desk, Journal, mingyun-paizhen (命运牌阵), cove-tarot-companion,
  Ruota della Fortuna
- **Communities & Forums (8):** Lutopia, Symposion, Rhysen Community, GLXY (银河), AISay,
  GalateaGaeden, moltbook, Agent World
- **Continuity & Data Ownership (11):** forge-reload, context-slim, output-guard, chatgpt-exporter,
  ChatGPT-Exporter (batch), Claude-Conversation-Exporter, connectome-host, ReSpark,
  character-card-spec-v2, character-card-spec-v3, immortal-skill (永生.skill)
- **Related Lists (3):** Awesome-AI-Waifu, awesome-ai-agents, awesome-local-llms

### Top 5 most relevant to a BYOK cross-platform RP app

Selected against four axes: (a) it is a *client/entry point* you could learn from or ship alongside,
(b) it proves a cross-platform story for one codebase, (c) it is a component you can lift directly
into a $0–5/mo solo stack, (d) it is card/memory *interop* you must not reinvent.

1. **Chevey339/kelivo** — https://github.com/Chevey339/kelivo — **4,087★, AGPL-3.0, Flutter,
   Android/iOS/macOS/Windows/Linux, pushed 2026-09-29.** The single best existence proof for
   "cross-platform RP client, one codebase": Flutter gives real native apps on all five targets, and
   it already ships the hard parts of a BYOK client — native OpenAI *and* Anthropic *and* Gemini
   protocols, per-provider multi-key rotation with load balancing, proxies, per-model capability
   flags, world books, assistant-scoped long-term memory with a 4-type extraction pipeline
   (identity/workflow/voice/instructions) that is *injected stably so prompt caching keeps working*,
   regex replacements, context compression into a new chat, branches, response versions. Local-only
   storage with no account system. Read this before choosing a framework: it also demonstrates the
   cost (Flutter + PRoot sandbox + 5 platform build targets is a lot for one dev) and the AGPL
   constraint.
2. **rikkahub/rikkahub** — https://github.com/rikkahub/rikkahub — **7,904★, AGPL-3.0, Kotlin,
   Android, pushed 2026-09-29, on Google Play.** The reference *mobile-first* BYOK client, and the
   single most-forked base in the whole companion ecosystem — orangechat, LastChat and
   rikkahub-auto-compress are all forks of it, each adding exactly one missing capability
   (proactive messaging + device tools; privacy presets + RAG memory; automatic rolling summaries and
   context compression). That fork pattern is a roadmap of what the stock client lacks. Also a
   warning: it carries a "many forked versions exist, use with caution to avoid privacy leaks"
   notice, and it monetizes via API-reseller sponsorships.
3. **in30mn1a/LumiMuse** — https://github.com/in30mn1a/LumiMuse — **27★, MIT, Next.js 16 + React 19
   + Tailwind 4 + SQLite, `docker compose up` or `npm run dev`, pushed 2026-09-26.** The closest
   match to the target product's *feature list* in the smallest package: long-term memory, **real
   wall-clock time injection**, native image generation, data import/export, self-hosted, MIT (so
   genuinely copyable). Its stated goal is explicitly anti-bloat — "not a giant platform that stuffs
   everything in, but a quiet, good-looking, long-term private companion space". Low stars but MIT +
   recent + narrow scope makes it the best *reading* target for a solo dev. Caveat: Chinese-first
   docs, small community.
4. **DasterProkio/awesome-ai-companion's `character-card-spec-v2` / `v3`** —
   https://github.com/malfoyslastname/character-card-spec-v2 (195★) and
   https://github.com/kwaroran/character-card-spec-v3 (112★, MIT). Not an app — the interop contract.
   Horde Studio's open bug (PNG import silently drops `creator_notes`, `tags`,
   `alternate_greetings`, `extensions`) is exactly the failure mode of not implementing the spec
   fully, and the Simulith thread's top comment ("I'm a stickler for multi-char lorebooks") shows
   cards+lorebooks are the load-bearing compatibility surface. Implement V2+V3 completely, including
   the PNG `tEXt`/`chara` envelope, or users' existing libraries break on import.
5. **garan0613/ai-memory-gateway (now "Pawwake · 爪迹")** — https://github.com/garan0613/ai-memory-gateway
   — **155★, AGPL-3.0, Python, pushed 2026-09-27.** The cleanest architectural idea available for
   long-term memory in a BYOK app: it is an **OpenAI-compatible proxy** that sits between any client
   and any provider, so memory is added *without touching the client*. Three-tier memory
   (fragments → events → core), optional hybrid keyword+vector search, and — critically — a
   **partitioned A/B context cache with rolling summarization that is designed to preserve prompt
   caching** (i.e. keeps the stable prefix stable and only rotates the tail). That is the single
   biggest cost lever for a free-tier BYOK app, and the "proxy, not a fork" shape means it can be
   dropped in later.

**Runner-up worth naming:** **moeru-ai/airi** (49,787★, MIT, TypeScript) for the Live2D/VRM avatar +
voice layer, and **RVC-Boss/GPT-SoVITS** (62,230★, MIT) for voice cloning — but neither is a
roleplay client.

---

## 4. The three Reddit threads: what users say they want

### Thread A — `1v9ftps` "GitHub - Chechelpo/FRPLM: LLM frontend for simulating worlds"
https://www.reddit.com/r/SillyTavernAI/comments/1v9ftps/ · 2026-07-29 · 30 pts, 7 comments
(full text in §2). Wants expressed: **multi-character lorebooks** ("I'm a stickler for multi-char
lorebooks"); **per-character vs global knowledge separation** ("Can two characters know different
things about the same location, or is visibility global? That seems important once characters start
moving independently"); **screenshots/examples on the repo before trying it**; **portability to
another frontend** (the Lumiverse question — i.e. don't lock world data into a proprietary format).

### Thread B — `1raxnos` "[Alpha] Lightweight AI roleplay frontend in Rust/Tauri – no more Electron bloat"
https://www.reddit.com/r/SillyTavernAI/comments/1raxnos/ · 2026-02-21 · 10 pts, 18 comments
(author = u/realitaetsnaher, repo https://github.com/Finn-Hecker/RyokanApp, 16★, **GPL-3.0**,
Svelte 5 + Tauri v2 + SQLite, Windows x64 + Android arm64, 6.6 MB installer, v0.6.0 on 2026-09-26).
This is the single densest comment section for our purposes.

**What the author says was hard / what he got wrong:** he built it because *"I'm running local models
and I don't want my frontend eating half of it"* — RAM, not features, was the trigger; the 6.6 MB
installer "still kind of surprises me". He is explicit about the failure list: "No mobile, UI is
pretty bare in places, probably crashes in ways I haven't found yet." He later admits he built it
partly as "the perfect excuse to finally build something with Tauri v2 and Svelte 5" — i.e. the
motivation was mixed.

**What users actually said (verbatim sentiment):**
- *"sillytavern is feature-rich but with bad UI/UX, it's only natural that leaner alternatives come
  up from time to time."*
- *"Sillytavern has a HORRIBLE ui. I don't think I have ever seen a worse ui in my entire life
  actually. Stuff like forgeui and comfyui have just as many options but are actually navigable
  without a phD"* (3 pts) — note the actual complaint is **navigability at high option count**, not
  option count.
- *"while Tavern is very flexible, it's flexible in the wrong places. It's monstrous, supports a lot
  of unnecessary legacy software, and is essentially outdated. Multi-agent systems, RAGs, and so on
  have become fashionable. All of this can be done in Tavern, but through a set of third-party
  extensions and with considerable difficulty. Tavern doesn't properly support multi-call LLM. Many
  people don't want to fiddle with thousands of settings and read every author's Discord channel to
  figure out how to set up Tavern the way they want."* (22 pts, the top comment) — this is the
  clearest statement of the gap: **multi-call / multi-agent orchestration is first-class in
  Claude-Code-style tools and bolted-on in SillyTavern.**
- The same commenter's design thesis: *"Look at Codex, Claude code, and Cursor. These are all
  multi-agent systems that don't care about the size of the context; they reduce and optimize it
  themselves… Why can't this same approach be applied to RP? A system that automatically determines
  the right prompt, inserts relevant data into the context, and removes unnecessary data, a system
  that monitors the state of the world, relationships, and so on. For me, this is the future of
  role-playing."* — **the single most valuable directional signal in the whole brief.**
- *"A lot of people are wanting a 'mobile first' approach… A lot of new apps are in apk format or
  available as a download from android or apple stores. There's definitely a market for that as they
  run a lot more smoothly on mobile."*
- iOS users are stuck: *"is there a way for iOS users to access this? I'm able to access Serene Pub
  using basically the same process I use for SillyTavern — for example: http://192.168.0.5:3000/"* —
  i.e. **LAN-URL-to-PWA is the accepted iOS workaround.**
- ChatterUI's author (u/----Val----, 2,785★) explains his own origin: *"I originally made ChatterUI
  due to ST's UX being kinda crap on mobile and aggressive browser memory optimization resetting
  sessions."*
- *"You should add more screenshots so people can preview what it looks like"* (repeated twice
  across threads — **screenshots in the README are a conversion prerequisite**).
- Two commenters told the author he was duplicating existing work and pushed alternatives:
  **serene-pub** (https://github.com/doolijb/serene-pub, 189★, AGPL-3.0, TS), **Aventuras**
  (https://github.com/AventurasTeam/Aventuras, 204★, AGPL-3.0), and **tealios/errata**
  (https://github.com/tealios/errata, 124★, GPL-2.0, "multi-agent setup too"). One said the author's
  "I was forced to make this because nothing else was out there" read as marketing — **expect and
  pre-empt "why does this exist?" hostility on launch.**
- A licensing gotcha was caught in public: *"Repo license: GPL / Readme license: MIT"* — ship a
  correct `LICENSE` file before posting.

### Thread C — `1sg9wve` "Built a free, Open source, lightweight BYOK AI chat frontend…"
https://www.reddit.com/r/SillyTavernAI/comments/1sg9wve/ · 2026-04-09 · 0 pts, 8 comments
(Happy Tavern UI, https://happytavernui.qzz.io/, now serving from https://panthox.com/ — Patreon +
Discord funded, "built on the chatbot-ui MIT-licensed repo".)

This thread is a **case study in how not to launch**, and the comments are the lesson:
- Top comment (11 pts): *"How is this better than Koboldlite which has been around forever and is
  trusted? … Just asking what your improvement or angle is / what new thing you are bringing to the
  table."* → **you must state the differentiator in the first sentence.**
- *"Where is the source code? You claim it's oss mit in a comment, but you don't even share the link
  to your Git repository or project source? Advertising proprietary/closed-source software is not
  allowed in this group for ethical reasons (free software)."* → posting a hosted web app and calling
  it OSS without a repo link gets you accused of astroturfing. Two separate commenters demanded the
  repo and license. The author never provided one in-thread.
- *"Can I have screenshots of this? Spectrum thinks its malware on my end"* → the author's answer,
  *"False positive. Spectrum probably flagged it because of its ability to make external API calls"*,
  is a real warning for any hosted BYOK frontend: **anti-virus/URL filters flag pages that take API
  keys and make outbound calls.**
- The author's own framing of the value prop is thin — *"the Assistant/system prompt setup lets you
  save named uncensored presets per model, plus Discord community for sharing instruction packs"* —
  and a commenter immediately rebuts: *"kobold does let you make character cards, with existing
  uncensored llms, while this lets you use your own API key from openrouter… I don't think there's
  much of a difference between koboldai and this other than a different approach to the same thing."*
- **The one genuine demand signal:** the whole product is gated behind joining a **Discord or
  Patreon to copy "Custom Instructions"/jailbreak presets**, and the author promises "more
  Instructions will be added regularly" — i.e. **uncensored-model access and shareable
  jailbreak/preset packs are what people actually pay attention to**, and a preset *sharing* channel
  is a real product surface, not a nice-to-have.

### Cross-thread synthesis — what users want / dislike

| Dislike | Evidence |
|---|---|
| SillyTavern's UI is unnavigable at high option count | 3 comments across two threads; "navigable without a phD" |
| Flexible in the wrong places; legacy cruft; configuration spread across Discord + extensions | top comment of thread B |
| Multi-call / multi-agent LLM orchestration is not first-class | top comment of thread B |
| Desktop-only / browser-tab-only; no real mobile app | 3 separate comments; ChatterUI's origin story |
| Electron bloat / RAM cost when running local models | thread B premise |
| Browser tab suspension destroying sessions on mobile | ChatterUI author |
| Missing/absent screenshots, repo, or license in announcements | threads A and C |
| Duplicating existing tools without a stated differentiator | threads B and C |

| Want | Evidence |
|---|---|
| Automatic context management — the app decides what to inject/trim, not the user | thread B top comment |
| World/relationship state tracked by the system, not the prompt | thread B top comment |
| Multi-character lorebooks; per-character knowledge isolation | thread A |
| Lightweight native mobile app (APK) / mobile-first | thread B, ×3 |
| Free, BYOK, uncensored, with shareable preset/jailbreak packs | thread C |
| Screenshots and a runnable demo before installing | threads A and C |
| A real repo + license if you call it open source | thread C |
| Portability of world/character data out of the app | thread A (Lumiverse port question) |

---

## 5. Cross-cutting takeaways for a solo, $0–5/mo BYOK RP app

1. **The winning wedge is context orchestration, not more settings.** Both the top-voted comment and
   Horde Studio's own audit converge: the frontier is *automatically deciding* what the prompt
   contains (retrieval, summarization, multi-call) rather than exposing 500 knobs. Horde's "tiny
   local model proposes, deterministic reducers decide, main model speaks" pattern is a cheap,
   copyable way to do this without a second paid call.
2. **State must be transactional and timeline-scoped.** The most expensive bugs in the most
   developed project here (Horde) were: consuming a message before the reply lands, writing an async
   result into the wrong timeline, and two subsystems disagreeing about where an actor is. Job
   records + lease + idempotency keys + `{actor, timeline, revision}` captured at initiation is the
   minimum viable design.
3. **Never derive canonical state from prose.** Regex extraction of "who left the room" produced a
   literal `location: null`. Structured receipts only; prose scanning may flag contradictions but not
   commit.
4. **Model output is adversarial.** Assume malformed replies; exactly one bounded retry with simpler
   instructions, never auto-resubmit uncertain provider outcomes.
5. **Storage will grow forever.** Design memory tiers from day one (verbatim recent + summarized
   mid + permanent "tentpole" facts) and keep a checkpoint/compaction path; Horde's 144 MB → 4 MB
   result is the target.
6. **Ship card interop completely.** V2/V3 PNG (`chara` tEXt chunk) + all metadata fields +
   lorebook/WorldInfo import, or users' libraries break on import and you get an open bug like
   Horde's.
7. **Free-tier-shaped architecture.** The community's default stack is already free-tier-shaped:
   an OpenAI-compatible **proxy** for memory (Pawwake) keeps the stable prompt prefix stable for
   prompt caching; Kelivo shows multi-key rotation across free providers; Cloudflare Workers/Pages
   can host a relay; Flutter or Tauri gives one codebase for desktop+mobile; IndexedDB/SQLite keeps
   data local. LAN URL → PWA is the accepted iOS answer.
8. **Launch mechanics matter as much as the app.** Post with: repo link, explicit LICENSE, a
   one-sentence differentiator, screenshots, and a stated non-goal. Expect "this already exists"
   replies naming Serene Pub, Aventuras, Errata, ChatterUI, Kobold Lite.

---

## Sources

- https://github.com/ddkhan24/hordestudio
- https://github.com/ddkhan24/hordestudio/releases/tag/v18.2.0
- https://github.com/ddkhan24/hordestudio/blob/main/docs/critical-engine-audit-2026-09-06.md
- https://github.com/ddkhan24/hordestudio/blob/main/docs/labs-local-cognition-design.md
- https://github.com/ddkhan24/hordestudio/blob/main/docs/vh-feedback-rework-20260920.md
- https://github.com/ddkhan24/hordestudio/blob/main/docs/vh-conversation-context-2026-09-08.md
- https://github.com/ddkhan24/hordestudio/blob/main/docs/releases/v18.2.0.md
- https://github.com/ddkhan24/hordestudio/blob/main/docs/marketing/v18-vh2-reddit-post.md
- https://github.com/ddkhan24/hordestudio/blob/main/docs/marketing/v16.6.0-reddit.md
- https://github.com/ddkhan24/hordestudio/issues/4
- https://github.com/Chechelpo/Simulith
- https://github.com/Chechelpo/Simulith/blob/master/LICENSE.md
- https://github.com/Chechelpo/FRPLM
- https://www.patreon.com/Simulith/posts/beginnings-of-165292466
- https://lutopia.app/companion/
- https://lutopia.app/companion/guide/
- https://lutopia.app/companion/faq/
- https://lutopia.app/companion/llms-full.txt
- https://github.com/DasterProkio/awesome-ai-companion
- https://github.com/DasterProkio/awesome-ai-companion/blob/main/INITIATIVE.md
- https://www.reddit.com/r/SillyTavernAI/comments/1v9ftps/github_chechelpofrplm_llm_frontend_for_simulating/
- https://www.reddit.com/r/SillyTavernAI/comments/1raxnos/alpha_lightweight_ai_roleplay_frontend_in/
- https://www.reddit.com/r/SillyTavernAI/comments/1sg9wve/built_a_free_open_source_lightweight_byok_ai_chat/
- https://api.pullpush.io/reddit/search/comment/?link_id=1v9ftps
- https://api.pullpush.io/reddit/search/comment/?link_id=1raxnos
- https://api.pullpush.io/reddit/search/comment/?link_id=1sg9wve
- https://api.pullpush.io/reddit/search/submission/?ids=1v9ftps
- https://github.com/Finn-Hecker/RyokanApp
- https://github.com/Finn-Hecker/RyokanApp/releases
- https://happytavernui.qzz.io/ (now https://panthox.com/)
- https://github.com/doolijb/serene-pub
- https://github.com/AventurasTeam/Aventuras
- https://github.com/tealios/errata
- https://github.com/Vali-98/ChatterUI
- https://github.com/SillyTavern/SillyTavern
- https://docs.sillytavern.app/
- https://github.com/Chevey339/kelivo
- https://github.com/rikkahub/rikkahub
- https://github.com/in30mn1a/LumiMuse
- https://github.com/garan0613/ai-memory-gateway
- https://github.com/fishwithoctopus/Ocean
- https://github.com/qegj567-cloud/SullyOS
- https://github.com/moeru-ai/airi
- https://github.com/RVC-Boss/GPT-SoVITS
- https://github.com/malfoyslastname/character-card-spec-v2
- https://github.com/kwaroran/character-card-spec-v3
- https://github.com/wusaki0723/Aelios
- https://github.com/callie0313/dylan-heartbeat
