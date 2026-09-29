# SillyTavern — deep research for a "better chub.ai"

Research date **2026-09-29**. Baseline: **SillyTavern v1.19.0** (released 2026-09-14), repo
<https://github.com/SillyTavern/SillyTavern> — **33,910 ★, 6,375 forks, AGPL-3.0, default branch `release`,
last push 2026-09-23, 643 open issues**. Forked from TavernAI 1.2.8 in Feb 2023. Release cadence ~monthly
(1.13.0 May 2025 → 1.19.0 Sep 2026); `staging` updates several times daily.

Everything below is read from the actual source/docs unless marked `[INFERENCE]`.

---

## 1. Feature inventory (as of 1.19.0)

### Core chat
- **Character cards** as the unit of everything. Formats supported: PNG tEXt-embedded V2/V3 cards,
  JSON, **CharX** (ZIP, `src/charx.js` — handles RisuAI's misspelled `embeded://` prefix), **BYAF**
  "Backyard Archive Format" (`src/byaf.js`, ZIP). Also Chub / Pygmalion / Janitor-style import.
- **Swipes** (multi-generation candidates per message), swipe picker (1.17), branching and
  **checkpoints** (clone-chat-to-message, with parent links and fresh `integrity` slugs).
- **Alternate greetings**, reorderable, plus **group-specific greetings** via an extension.
- Message editing, `Click-to-Edit`, reasoning blocks as first-class message content
  (editable/collapsible, excluded from smooth streaming).
- **Quick Replies** (QR2): saved STscript sets, per-chat/per-character scoping, auto-execute.
- Markdown via `showdown` + DOMPurify, code highlighting, LaTeX, Mermaid (extensions).
- Regex scripts (`public/scripts/extensions/regex/`, 2,157 LOC) — preset + scoped regex applied
  to prompt/display, the de-facto tool for state trackers and format cleanup.
- Translation of chats (8 providers).
- Tags/folders for characters, groups, chats; fuzzy search via Fuse.js.

### World Info / lorebooks (`public/scripts/world-info.js`, 6,408 LOC)
- Keyword activation with **regex keys**, AND ANY / AND ALL / NOT ANY / NOT ALL optional filters,
  per-entry `scanDepth`, `caseSensitive`, `matchWholeWord`.
- **Insertion positions**: before/after char defs, before/after example messages, top/bottom of
  Author's Note, or `@D` depth (with role), plus **outlet** named anchors.
- **Recursive scanning** with `non-recursable` / `prevent further recursion` / `delay until recursion`.
- **Timed effects** (sticky/cooldown/delay), probability (`trigger %`), inclusion groups with
  prioritisation and group scoring, character filters, automation IDs.
- Three lore scopes: **character lore** (embedded in the card on export), **persona lore**,
  **chat lore**; three merge strategies (sorted evenly / character first / global first).
- **Vector Storage matching** — optional semantic activation that *replaces only the keyword check*;
  scan depth is ignored, `Query messages` is used instead, and the normal budget still applies.
- **Activation settings**: scan depth, include names, **Context % / Budget**, min activations
  (+ max depth), max recursion steps, alert on overflow.

### Author's Note / prompt management
- **Author's Note**: chat-specific + default, position (after scenario, or in-chat @ depth 0..N),
  **insertion frequency** (every Nth user input).
- **Prompt Manager** (Chat Completion): ordered prompt list with **markers** (main prompt, chat
  history, world info, etc.), per-prompt `injection_position` (relative/absolute) and
  `injection_depth`, per-character `prompt_order`, system/user role, `forbid_overrides`,
  live per-prompt token counts, and 80 %-of-budget warning icons on the chat-history marker.
- **Advanced Formatting / Context Template** (Text Completion): Handlebars story string with
  `{{description}} {{scenario}} {{personality}} {{system}} {{persona}} {{wiBefore}} {{wiAfter}}
  {{mesExamples}}`, `{{anchorBefore}}/{{anchorAfter}}` extension anchors, `{{trim}}`, prompt anchors,
  instruct mode, system prompt, custom stopping strings, "Start Reply With".
- **Presets**: separate for OpenAI / TextGen / Kobold / NovelAI / instruct / context / sysprompt /
  reasoning, import/export, plus **connection profiles** (`connection-manager`) and per-character
  preset locking (extension).

### Personas
Name + avatar + description + optional title; description injected at a **per-persona position**
(none / story string / top or bottom of AN / in-chat @ depth). Locks: **chat lock**, **character
lock**, **default persona**. Persona lorebooks. Full CRUD slash commands and lifecycle events
(1.18). Personas can be converted from characters with `{{user}}`/`{{char}}` swapping.

### Group chats
Reply-order strategies: **Manual, Natural Order** (name-mention extraction + per-character
**talkativeness** slider 0–100 %, then random), **List Order**, **Pooled Order**. Generation
handling: **swap character cards** (default) vs **join character cards** (all descriptions merged,
with prefix/suffix templates, include/exclude muted) — the latter exists specifically to keep the
prompt prefix stable for **llama.cpp prompt caching**. Mute / force-talk / auto-mode (5 s delay) /
allow self-responses. Group nudge prompt template. Group reasoning "mind reading" was fixed in 1.18.

### STscript + slash commands
`public/scripts/slash-commands.js` registers **~103 commands** with a full parser
(`chevrotain`), closures, scopes, named closures, pipe breakers, loops (`/while`, `/times`),
math, variables/arrays/objects, `/inject` prompt injections, `/gen`, `/genraw`, `/ask`, message
read/send/delete, character CRUD (`/char-create`…), persona CRUD, World Info CRUD, `/trimtokens`,
`/fuzzy`. Parser has a `strict` escaping flag and parser flags. Documented as a "simple yet powerful
scripting language" — the main extension surface for non-JS users.

### Extension API
- `manifest.json` per extension: `display_name`, `loading_order`, `js`, `css`, `author`,
  `auto_update`, `dependencies` (other extensions by folder name), `generate_interceptor`
  (a global fn called on every generation), `minimum_client_version`, `i18n`, and **lifecycle
  hooks**: `install/update/delete/enable/disable/activate`.
- `SillyTavern.getContext()` (`public/scripts/st-context.js`, 311 LOC) exposes ~90 members:
  `chat` (MUTABLE), `characters`, `groups`, `chatMetadata`, `generate`, `generateRaw`,
  `sendStreamingRequest`, `stopGeneration`, `tokenizers`, `getTokenCount(Async)`,
  `extensionPrompts`, `setExtensionPrompt`, `SlashCommandParser`, `registerSlashCommand`,
  `registerMacro`, `registerFunctionTool`, `ToolManager`, `eventSource`, `eventTypes`, etc.
- `public/lib.js` exposes ~20 npm libs to extensions (lodash, Fuse, DOMPurify, hljs, localforage,
  Handlebars, Bowser, DiffMatchPatch, Readability, SVGInject, showdown, moment, seedrandom, Popper,
  droll, morphdom, slidetoggle, chalk, yaml, chevrotain, fflate, js-sha256).
- **~104 events** (`public/scripts/events.js`) incl. `GENERATE_BEFORE_COMBINE_PROMPTS`,
  `GENERATE_AFTER_COMBINE_PROMPTS`, `GENERATE_AFTER_DATA`, `CHAT_COMPLETION_PROMPT_READY`,
  `WORLD_INFO_ACTIVATED`, `STREAM_TOKEN_RECEIVED`, `TOOL_CALLS_PERFORMED`, `SECRET_WRITTEN`, etc.
- Server plugins (`plugins.js`, `enableServerPlugins: false` by default) for Node-side extensions
  (Office parser, Fandom scraper).
- Extensions run **in the page with unrestricted DOM/JS access** — no sandbox, no permission model.

### Data Bank / RAG
Attachments in three scopes: **global**, **character**, **chat**; plus per-message attachments.
Sources: notepad, local file (PDF/HTML/MD/ePUB/TXT + arbitrary text), **web scrape** (Mozilla
Readability), **YouTube transcript**, web-search results, Fandom wiki (server plugin), Bronie
Parser (third-party). Chunking: size threshold, chunk size (chars), overlap %, retrieve-N chunks,
custom chunk boundary, optional translate-to-English. **Vector Storage** uses `vectra` and stores
one JSON index/collection per document under `<dataRoot>/<handle>/vectors/`.
Embedding sources: `transformers` (local ONNX, default `jina-embeddings-v2-base-en`), `webllm`
(WebGPU), `ollama`, `llamacpp`, `vllm`, `koboldcpp`, `extras` (deprecated), plus API:
OpenAI, Cohere, Google AI Studio, Vertex AI, TogetherAI, Mistral, NomicAI, OpenRouter, Electron Hub,
Chutes, NanoGPT, SiliconFlow, Cloudflare Workers AI.
**Chat Vectorization** (separate toggle) vectorises every message, then *shuffles the most relevant
past messages to the start or end of the history* at generation time.

### Summarize
Bundled `memory` extension (1,131 LOC). Sources: `main` (your chat model), `extras`, `webllm`.
Prompt builders: **Raw blocking**, **Raw non-blocking**, **Classic blocking**. Settings: summary
prompt (with `{{words}}`), target words, override response length, max messages per request,
"no WI/AN", update every X messages / X words, injection template `[Summary: {{summary}}]`,
injection position/role, freeze/pause, restore previous. Summary is stored in the **chat file
metadata of the message that was last in context** — editing/deleting that message reverts it.
Default prompt: *"Ignore previous instructions. Summarize the most important facts and events in
the story so far…"*. Docs are honest: summaries *"may lose some important details or contain
hallucinations"*.

### Media
- **Image Generation** (5,998 LOC) with **24 backends**: extras, Horde, auto (A1111), sdcpp,
  NovelAI, vlad (SD.Next), OpenAI, AIMLAPI, **ComfyUI**, TogetherAI, Draw Things, Pollinations,
  Stability, HuggingFace, Chutes, Electron Hub, NanoGPT, **BFL**, fal.ai, xAI, Google, Z.AI,
  OpenRouter, Cloudflare Workers AI. Video gen via Veo/Sora 2/Z.AI.
- **TTS** with **28 providers**: AllTalk, Azure, Chatterbox, Chutes, Coqui, CosyVoice, Edge,
  ElevenLabs, Electron Hub, Google Translate, Google Gemini TTS, GSVI, GPT-SoVITS (+ adapter, v2),
  Kokoro, MiniMax, NovelAI, OpenAI (+ compatible), Pollinations, SBVits2, Silero, SpeechT5, System,
  TTS WebUI, VITS, XTTSv2, Volcengine.
- **Image Captioning**: local transformers pipeline, Horde, Extras, or **multimodal** (OpenAI,
  Google, VertexAI, Z.AI) — also captions video attachments.
- **Character Expressions**: sprite sets with an emotion classifier (Extras classifier or local),
  custom expression sets, fallback expressions, `{{availableExpressions}}` macros (1.19).
- Speech **recognition** (browser Web Speech or Extras/Chutes/Mistral/Z.AI/ElevenLabs/Groq),
  Gallery, dynamic audio/BGM, Live2D/VRM avatars.
- Data Bank is also the ingest path for attachments + `@mozilla/readability`.

---

## 2. Tech stack & architecture

### Server
- **Node ≥ 20** (`engines`), `type: module` (native ESM). **Express 4.21** + `cookie-session`,
  `csrf-sync`, `helmet`, `cors`, `compression`, `rate-limiter-flexible`, `multer`, `yargs`.
- `server.js` → `src/server-main.js` / `server-startup.js` / `server-init.js`.
  `config.yaml` (default at `default/config.yaml`) drives everything: listen, whitelist, basic auth,
  SSO (Authelia/Authentik), CORS, request proxy (socks5/pac), host whitelist, **private-address
  whitelist (SSRF)**, rate limiting, forwarded-header trust, backups, thumbnails, **performance**
  (`lazyLoadCharacters`, `useDiskCache`, `memoryCacheCapacity: 100mb`), request gzip compression,
  cache buster, `enableServerPlugins`, and provider-specific blocks (`claude`, `gemini`, `ollama`,
  `openai`, `deepl`, `mistral`).
- **Single-user by default**; multi-user via `enableUserAccounts` with per-user directories
  (`src/users.js`, `src/constants.js:USER_DIRECTORY_TEMPLATE`), scrypt password hashes, session
  cookie invalidation on password change.
- **It is a proxy, not an inference host.** ~38 endpoint modules in `src/endpoints/`, of which
  `backends/chat-completions.js` (2,995 LOC) and `backends/text-completions.js` implement
  provider-specific request building. Streaming is forwarded straight through.
- **API surfaces**: two families. *Chat Completion* (OpenAI, Claude, OpenRouter, AI21, MakerSuite,
  VertexAI, Mistral, Custom, Cohere, Perplexity, Groq, Electron Hub, Chutes, NanoGPT, DeepSeek,
  AIMLAPI, xAI, Pollinations, Moonshot, Fireworks, CometAPI, Azure, Z.AI, SiliconFlow, Workers AI,
  MiniMax — 25 sources) and *Text Completion* (KoboldAI, KoboldCpp, AI Horde, TextGen WebUI,
  Tabby, llama.cpp, NovelAI, Ollama, vLLM, …).
- **Tokenizers** (`src/tokenizers/`, `public/scripts/tokenizers.js`): tiktoken for OpenAI, WebTokenizers
  for Claude, plus Llama/Llama3/Mistral/Nemo/Yi/Gemma/DeepSeek/NerdStash/Command-R/Qwen2, some
  downloaded on demand from the `SillyTavern-Tokenizers` repo, with `enableDownloadableTokenizers`
  opt-out and a fallback tokenizer. **Token padding** exists because counts near max context are
  estimates and would otherwise silently truncate the character definition.
- **Extension installation** via `isomorphic-git` (built-in, `git.backend: auto`) or system git —
  clone into `data/<handle>/extensions`, or `public/scripts/extensions/third-party` for
  "install for all users". Auto-update on release version change.
- Tests: Jest (`tests/*.test.js`) + Playwright e2e; CI in `.github/workflows/pr-checks.yml`.

### Frontend
- **No framework. jQuery 3.5.1 + jQuery UI + a hand-written 12,599-line `public/script.js`.**
  Plus jQuery plugins: transit, cookie, ui.touch-punch, cropper, toastr, select2, izoomify,
  pagination, toolcool-color-picker, swiped-events, eventemitter.
- `webpack.config.js` bundles only `public/lib.js` (npm libs) into a cached `lib.js`, keyed by
  version+git-revision+webpack-version hash; cache pruned on change. Everything else is loaded as
  raw `<script>` tags / ESM from `public/scripts/`.
- `public/scripts/` — ~90 modules, ~120k LOC total. Heavy hitters: `script.js` (12.6k),
  `openai.js` (7.4k), `world-info.js` (6.4k), `power-user.js`, `chats.js`, `group-chats.js`,
  `personas.js`, `macros.js`, `variables.js`, `tool-calling.js`, `reasoning.js`, `slash-commands.js`,
  `PromptManager.js`, `itemized-prompts.js`, `sse-stream.js`, `streaming-display.js`, `templates/`.
- State: `settings.json` + `power_user` in `localforage` (IndexedDB), **itemized prompts** cached
  per chat in IndexedDB (`SillyTavern_Prompts`) for the per-message token breakdown UI.
- **Storage layout** (`<dataRoot>/<handle>/`, default `./data/default-user/`): `chats/` (**JSONL**:
  line 1 = header with `chat_metadata` incl. an `integrity` slug, then one JSON object per message),
  `characters/`, `groups/` + `group chats/`, `worlds/`, `themes/`, `QuickReplies/`, `vectors/`,
  `backups/`, `thumbnails/{bg,avatar,persona}/`, `User Avatars/`, `user/{files,images,workflows}`,
  `assets/`, plus preset dirs (`OpenAI Settings/`, `TextGen Settings/`, `KoboldAI Settings/`,
  `NovelAI Settings/`, `instruct/`, `context/`, `sysprompt/`, `reasoning/`).
- **Streaming**: `public/scripts/sse-stream.js` (389 LOC) implements a `TransformStream`-based
  **SSE parser** and a `SmoothEventSourceStream` that yields the stream **one character at a time**
  with punctuation-aware delays (`getDelay`: `,`/`\n` = half, `.`/`!`/`?` = full punctuation delay,
  derived from `power_user.smooth_streaming_speed`). `parseStreamData` normalises **every provider's**
  wire format into `{chunk, reasoning}`: Cohere `delta.message.content.text`, Claude
  `delta.text`/`delta.thinking`, Gemini `candidates[].content.parts[].text` (+`thought` flag),
  NovelAI/Kobold `token`, llama.cpp `content`, OpenAI-likes `choices[0].{text,delta.text,
  delta.reasoning_content,delta.reasoning,delta.content}`. `StreamingProcessor` in `script.js`
  renders through a `Stopwatch(1000 / power_user.streaming_fps)` — the FAQ recommends lowering
  streaming FPS to 10–15 if the UI is janky.

### Desktop / mobile packaging
- `src/electron/` — a trivial Electron 41 shell (`electron .`) that runs the Node server; not a
  packaged app store product.
- `public/manifest.json` — a **PWA manifest** (`display: standalone`, apple touch icons) and
  `index.html` sets `apple-mobile-web-app-capable`, `viewport-fit=cover`,
  `interactive-widget=resizes-content`, and loads `css/mobile-styles.css`. Add-to-home-screen is an
  intended path. No service worker (explicitly declined, PR #4727; PR #6059 only adds PWA `id`/`scope`).
- **No official mobile app.**

---

## 3. Extension ecosystem

### Bundled (14, `public/scripts/extensions/`)
| Extension | What it adds |
|---|---|
| Data Bank (Chat Attachments) | 3-scope document store + ingest (file/web/YouTube/search/Fandom) |
| Vector Storage | `vectra`-backed embeddings for Data Bank files + chat messages (RAG) |
| Summarize | auto-summarising long-term memory into the prompt |
| Character Expressions | sprite emotion images driven by a classifier |
| Connection Profiles | named API endpoint/key/model bundles, switchable |
| Gallery | saved generated images/videos |
| Regex | preset + scoped regex on prompt/display |
| Chat Translation | 8 translation providers |
| Image Captioning | local / Horde / Extras / multimodal captioning |
| Token Counter | per-message token badge |
| TTS | 28 TTS providers |
| Image Generation | 24 image backends |
| Quick Replies | STscript quick-reply sets |
| Assets | ambient/BGM/blip asset manager |

### Official but separate (`github.com/SillyTavern/*`, ~70 repos)
Notable with stars / last push (YYYY-MM) / license:

| Extension | ★ | pushed | lic | Adds |
|---|---|---|---|---|
| [SillyTavern-Timelines](https://github.com/SillyTavern/SillyTavern-Timelines) | 123 | 2024-06 | MIT | timeline view of chats |
| [Extension-TopInfoBar](https://github.com/SillyTavern/Extension-TopInfoBar) | 96 | 2025-06 | AGPL | top bar with quick actions |
| [Extension-Live2d](https://github.com/SillyTavern/Extension-Live2d) | 89 | 2024-06 | GPL | Live2D models |
| [Extension-QuickPersona](https://github.com/SillyTavern/Extension-QuickPersona) | 75 | 2025-10 | AGPL | persona dropdown in chat bar |
| [Extension-VRM](https://github.com/SillyTavern/Extension-VRM) | 65 | 2026-01 | GPL | VRM 3D models |
| [WebSearch-Selenium](https://github.com/SillyTavern/SillyTavern-WebSearch-Selenium) | 65 | 2026-03 | AGPL | real browsing for Web Search |
| [Extension-WebSearch](https://github.com/SillyTavern/Extension-WebSearch) | 59 | 2025-12 | AGPL | web results into prompts (also a function tool) |
| [Extension-PromptInspector](https://github.com/SillyTavern/Extension-PromptInspector) | 55 | 2026-01 | AGPL | inspect/edit the outgoing prompt |
| [SillyTavern-Content](https://github.com/SillyTavern/SillyTavern-Content) | 47 | 2026-05 | MIT | official curated index (66 extensions) |
| [SillyTavern-Fandom-Scraper](https://github.com/SillyTavern/SillyTavern-Fandom-Scraper) | 46 | 2026-05 | AGPL | Fandom wiki → Data Bank (server plugin) |
| [Extension-TypingIndicator](https://github.com/SillyTavern/Extension-TypingIndicator) | 42 | 2025-06 | AGPL | typing indicator |
| [Extension-Objective](https://github.com/SillyTavern/Extension-Objective) | 40 | 2025-06 | AGPL | persistent objective for the AI |
| [SillyTavern-EmulatorJS](https://github.com/SillyTavern/SillyTavern-EmulatorJS) | 38 | 2025-06 | GPL | play retro games in chat |
| [Extension-MessageLimit](https://github.com/SillyTavern/Extension-MessageLimit) | 38 | 2025-01 | AGPL | cap messages per prompt |
| [Extension-Silence](https://github.com/SillyTavern/Extension-Silence) | 36 | 2024-06 | AGPL | silent audio player (keep tab alive) |
| [Extension-Idle](https://github.com/SillyTavern/Extension-Idle) | 35 | 2025-03 | AGPL | idle prompting / proactive continue |
| [Extension-Dice](https://github.com/SillyTavern/Extension-Dice) | 33 | 2025-08 | AGPL | D&D dice (+ function tool) |
| [Extension-Notebook](https://github.com/SillyTavern/Extension-Notebook) | 33 | 2026-04 | AGPL | rich-text notes |
| [Extension-Mermaid](https://github.com/SillyTavern/Extension-Mermaid) | 32 | 2026-03 | AGPL | Mermaid rendering |
| [SillyTavern-PushNotifications](https://github.com/SillyTavern/SillyTavern-PushNotifications) | 25 | 2024-05 | AGPL | push notifications |
| [Extension-WebLLM](https://github.com/SillyTavern/Extension-WebLLM) | 24 | 2026-05 | AGPL | in-browser LLM for extensions/embeddings |
| [SillyTavern-Nicknames](https://github.com/SillyTavern/SillyTavern-Nicknames) | 22 | 2026-04 | AGPL | per-character/persona nicknames in prompts |
| [Extension-Audio](https://github.com/SillyTavern/Extension-Audio) | 21 | 2025-06 | AGPL | BGM + ambience |
| [Extension-EmojiPicker](https://github.com/SillyTavern/Extension-EmojiPicker) | 19 | 2026-04 | AGPL | emoji picker |
| [Extension-ReactTemplate](https://github.com/SillyTavern/Extension-ReactTemplate) | 17 | 2026-05 | AGPL | React+Webpack template |
| [Extension-LaTeX](https://github.com/SillyTavern/Extension-LaTeX) | 15 | 2026-03 | AGPL | LaTeX/AsciiMath rendering |
| [SillyTavern-GroupSendAs](https://github.com/SillyTavern/SillyTavern-GroupSendAs) | 15 | 2024-03 | AGPL | `/sendas` button for group members |
| [Extension-CodeMirror](https://github.com/SillyTavern/Extension-CodeMirror) | 14 | 2026-05 | AGPL | fancy editor |
| [SillyTavern-Office-Parser](https://github.com/SillyTavern/SillyTavern-Office-Parser) | 14 | 2026-03 | AGPL | DOCX/PPTX/XLSX ingest (server plugin) |
| [Extension-CodeRunner](https://github.com/SillyTavern/Extension-CodeRunner) | 14 | 2026-04 | AGPL | run JS/STscript from chat code blocks |
| [Extension-ScreenShare](https://github.com/SillyTavern/Extension-ScreenShare) | 13 | 2025-11 | AGPL | screen → multimodal |
| [Extension-Blip](https://github.com/SillyTavern/Extension-Blip) | 13 | 2025-08 | AGPL | typewriter animation + sound |
| [Extension-DupeFinder](https://github.com/SillyTavern/Extension-DupeFinder) | 13 | 2026-04 | AGPL | cluster duplicate cards |
| [Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings) | 12 | 2026-05 | AGPL | group-specific greetings |
| [Extension-Speech-Recognition](https://github.com/SillyTavern/Extension-Speech-Recognition) | 12 | 2025-12 | GPL | STT |
| [Extension-RVC](https://github.com/SillyTavern/Extension-RVC) | 12 | 2024-08 | AGPL | RVC voice cloning (needs Extras) |
| [Extension-Spotify](https://github.com/SillyTavern/Extension-Spotify) | 12 | 2026-05 | AGPL | now-playing tool |
| [Extension-QuickContextSize](https://github.com/SillyTavern/Extension-QuickContextSize) | 9 | 2025-03 | AGPL | context-size shortcut buttons |
| [Extension-InjectManager](https://github.com/SillyTavern/Extension-InjectManager) | 7 | 2025-07 | AGPL | count active injections |
| [Extension-RSS](https://github.com/SillyTavern/Extension-RSS) | 7 | 2025-01 | AGPL | RSS tool |
| [Extension-ScriptEvents](https://github.com/SillyTavern/Extension-ScriptEvents) | 7 | 2025-05 | AGPL | app events → STscript |
| [Extension-Weather](https://github.com/SillyTavern/Extension-Weather) | 5 | 2026-03 | AGPL | weather tool |
| [Extension-ImageMetadataViewer](https://github.com/SillyTavern/Extension-ImageMetadataViewer) | 5 | 2026-04 | AGPL | image metadata viewer |
| [Extension-CustomSliders](https://github.com/SillyTavern/Extension-CustomSliders) | 5 | 2026-04 | AGPL | custom sliders for OpenAI-compat |
| [Extension-LoremIpsum](https://github.com/SillyTavern/Extension-LoremIpsum) | 4 | 2024-06 | AGPL | filler generator |
| [Extension-SamplerCommands](https://github.com/SillyTavern/Extension-SamplerCommands) | 3 | 2025-12 | AGPL | sampler slash commands |
| [Extension-Randomizer](https://github.com/SillyTavern/Extension-Randomizer) | 7 | 2024-07 | AGPL | randomise samplers per generation |
| [SillyTavern-Launcher](https://github.com/SillyTavern/SillyTavern-Launcher) | 578 | 2026-08 | MIT | cross-platform launcher scripts |
| [SillyTavern-Tokenizers](https://github.com/SillyTavern/SillyTavern-Tokenizers) | 8 | 2025-10 | MIT | tokenizer JSON files |
| [SillyTavern-Extras](https://github.com/SillyTavern/SillyTavern-Extras) | 701 | **2024-12** | AGPL | **`[OBSOLETE]`** — the old Python sidecar (classify, caption, RVC, TTS, embeddings). Still referenced by extensions as an *optional* module source, but dead since Dec 2024. |

**Stale/abandoned official set** (last push ≥12 months before 2026-09): Timelines, Live2d, Silence,
PushNotifications, GroupSendAs, RVC, LoremIpsum, Randomizer, Variable-Viewer (LenAnderson, 2024-06),
Extension-Chess (404 — deleted/renamed).

### Third-party — memory & long-term context (the hottest area)
| Extension | ★ | pushed | lic | Adds |
|---|---|---|---|---|
| [muyoou/st-memory-enhancement](https://github.com/muyoou/st-memory-enhancement) | **1,491** | 2026-09 | none | long-term memory enhancement (Chinese ecosystem flagship) |
| [aikohanasaki/SillyTavern-MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) | 312 | 2026-09 | AGPL | saves chat memories into lorebooks; side-prompt trackers + consolidation |
| [SenriYuki/SillyTavern-Horae](https://github.com/SenriYuki/SillyTavern-Horae) | 189 | 2026-06 | none | structured memory ledger: timeline, costume lock, NPC tracking, inventory, agenda, mood/relationships, scene memory + optional RPG layer (HP/MP, attributes, skills, equipment, reputation, XP, currency, strongholds) |
| [qvink/SillyTavern-MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize) | 168 | 2026-07 | AGPL | per-message automatic summarisation, config profiles |
| [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception) | 165 | 2026-09 | AGPL | **layered recursive memory** — verbatim recent turns + Layer 0/1/2… snippets promoted when a layer fills; claims ~10,900 turns in ~16k tokens |
| [bal-spec/sillytavern-character-memory](https://github.com/bal-spec/sillytavern-character-memory) | 72 | 2026-09 | none | extracts structured character memories from chat |
| [KritBlade/VectFox](https://github.com/KritBlade/VectFox) | 71 | 2026-09 | AGPL | Qdrant-backed event store + LLM event extraction + hybrid sparse/dense search + agent-mode query planning; explicitly built for 2,000+ message stories |
| [InspectorCaracal/SillyTavern-ReMemory](https://github.com/InspectorCaracal/SillyTavern-ReMemory) | 60 | 2025-11 | AGPL | "yet another memory extension" |
| [senjinthedragon/Smart-Memory](https://github.com/senjinthedragon/Smart-Memory) | 60 | 2026-07 | AGPL | multi-tier memory + per-character stores in group chats + entity/memory force graph |
| [pixelnull/sillytavern-DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) | 87 | 2026-07 | MIT | LLM-driven lorebook retrieval (Obsidian vault ingest), keyword+fuzzy "wide net" |
| [selinawynters-ops/ST---ThreadKeeper](https://github.com/selinawynters-ops/ST---ThreadKeeper) | 13 | 2026-07 | Apache-2.0 | LLM-powered fact memory for long RPs |

That's **six-plus competing memory stacks** for one app. That fragmentation is the signal.

### Third-party — world/state/RPG simulation
| Extension | ★ | pushed | lic | Adds |
|---|---|---|---|---|
| [SpicyMarinara/rpg-companion-sillytavern](https://github.com/SpicyMarinara/rpg-companion-sillytavern) | **316** | 2026-08 | NOASSERTION | stats tracker, info-box dashboard (date/weather/time/location), present-characters panel with relationships + thoughts. **Author has deprecated it to build the [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) frontend instead** |
| [MultihogAurelius/SillyTavern-MultihogDnDFramework](https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework) | 85 | 2026-09 | GPL | grew from "RPG State Tracker" into a game engine |
| [DangerDaza/Dooms-Enhancement-Suite](https://github.com/DangerDaza/Dooms-Enhancement-Suite) | 56 | 2026-09 | NOASSERTION | character tracking, lore library, TTS highlighting |
| [bmen25124/SillyTavern-WTracker](https://github.com/bmen25124/SillyTavern-WTracker) | 40 | 2026-06 | MIT | LLM stat tracking (location, time, …) |
| [ghostd93/BetterSimTracker](https://github.com/ghostd93/BetterSimTracker) | 38 | 2026-09 | MIT | per-message relationship stats + history visualisation |
| [xenofei/SillyTavern-ScenePulse](https://github.com/xenofei/SillyTavern-ScenePulse) | 21 | 2026-04 | GPL | scene intelligence: characters, relationships |
| [lunarblazepony/BlazeTracker](https://github.com/lunarblazepony/BlazeTracker) | 13 | 2026-03 | MIT | LLM scene-state tracking |
| [cgstever/StatefulLore](https://github.com/cgstever/StatefulLore) | 8 | 2026-09 | MIT | replaces the built-in lorebook with a **stateful, code-driven** lore system |
| [PavOrlov/SillyTavern-Interactive-Map](https://github.com/PavOrlov/SillyTavern-Interactive-Map) | 9 | 2025-12 | CC0 | clickable-zone maps |
| [GetBeholder/Beholder-ST](https://github.com/GetBeholder/Beholder-ST) | 2 | 2026-08 | AGPL | per-character physical state (worn clothing per body part) |
| [ddkhan24/hordestudio](https://github.com/ddkhan24/hordestudio) | 59 | 2026-09 | none | AI-Dungeon-style **persistent worlds** + character creation |
| [ackness/covel](https://github.com/ackness/covel) | 53 | 2026-09 | MIT | agentic AI-RPG framework (narration, NPCs, lore) |

### Third-party — lorebook / World Info tooling
[aikohanasaki/SillyTavern-WorldInfoInfo](https://github.com/aikohanasaki/SillyTavern-WorldInfoInfo) 36★ (see which entries fired),
[LorebookOrdering](https://github.com/aikohanasaki/SillyTavern-LorebookOrdering) 34★ (per-book activation priority),
[WorldInfoLocks](https://github.com/aikohanasaki/SillyTavern-WorldInfoLocks) 30★,
[bmen25124/SillyTavern-WorldInfo-Recommender](https://github.com/bmen25124/SillyTavern-WorldInfo-Recommender) 132★ (LLM lorebook curation),
[Culpeo/SillyTavern-WI-FunctionCall](https://github.com/Culpeo/SillyTavern-WI-FunctionCall) 3★ (activate WI **on demand via function calling**),
[hype-hosting/SillyTavern-Lorebook-Studio](https://github.com/hype-hosting/SillyTavern-Lorebook-Studio) 12★ (3D node-graph lorebook editor),
[aceeenvw/ace-entry-track](https://github.com/aceeenvw/ace-entry-track) 10★ (live entry/token-budget tracker),
[Phiarlan/SillyTavern-WorldInfoPlus](https://github.com/Phiarlan/SillyTavern-WorldInfoPlus) 4★,
[leandrojofre/SillyTavern-WI-Bulk-Mover](https://github.com/leandrojofre/SillyTavern-WI-Bulk-Mover) 16★.

### Third-party — authoring / prompt / UI
[bmen25124/SillyTavern-Character-Creator](https://github.com/bmen25124/SillyTavern-Character-Creator) 180★,
[Samueras/GuidedGenerations-Extension](https://github.com/Samueras/GuidedGenerations-Extension) 227★ (modular guided generation + persistent context),
[bmen25124/SillyTavern-Roadway](https://github.com/bmen25124/SillyTavern-Roadway) 82★ (story decision engine),
[bmen25124/SillyTavern-Flowchart](https://github.com/bmen25124/SillyTavern-Flowchart) 42★ (visual automation),
[bmen25124/SillyTavern-Custom-Scenario](https://github.com/bmen25124/SillyTavern-Custom-Scenario) 41★,
[bmen25124/SillyTavern-Magic-Translation](https://github.com/bmen25124/SillyTavern-Magic-Translation) 34★,
[Bronya-Rand/Prome-VN-Extension](https://github.com/Bronya-Rand/Prome-VN-Extension) 62★ (visual-novel mode),
[Bronya-Rand/Guinevere-UI-Extension](https://github.com/Bronya-Rand/Guinevere-UI-Extension) 70★ (full UI replacement),
[IceFog72/SillyTavern-ProbablyTooManyTabs](https://github.com/IceFog72/SillyTavern-ProbablyTooManyTabs) 54★ (tabbed workspace),
[Lol1p0p/narrative-agent](https://github.com/Lol1p0p/narrative-agent) 46★,
[DangerDaza…], [RivelleDays/SillyTavern-MoonlitEchoesTheme](https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme) 428★ (theme),
[Tyranomaster/expressions-plus](https://github.com/Tyranomaster/expressions-plus) 16★,
[Wolfsblvt/SillyTavern-Pronouns](https://github.com/Wolfsblvt/SillyTavern-Pronouns) 16★,
[LenAnderson/SillyTavern-Variable-Viewer](https://github.com/LenAnderson/SillyTavern-Variable-Viewer) 34★,
[chaaruze/SillyTavern-Too-Many-Chats](https://github.com/chaaruze/SillyTavern-Too-Many-Chats) 16★ (chat organisation),
[Hapsburgtopquark388/SillyTavern-Streamline](https://github.com/Hapsburgtopquark388/SillyTavern-Streamline) 6★ (hides legacy UI clutter).

### Third-party — integrations
[senjinthedragon/SillyTavern-Discord-Connector](https://github.com/senjinthedragon/SillyTavern-Discord-Connector) 16★,
[Enclave0775/Intiface_Central-Sillytavern-plugin](https://github.com/Enclave0775/Intiface_Central-Sillytavern-plugin) 39★ (haptics),
[platberlitz/sillytavern-image-gen](https://github.com/platberlitz/sillytavern-image-gen) 36★,
[0xl0cal/sillyimages](https://github.com/0xl0cal/sillyimages) 19★,
[Spadic21/ComfyInject](https://github.com/Spadic21/ComfyInject) 36★,
[Thirteen-Moons/ST-indexTTS2-X-Player](https://github.com/Thirteen-Moons/ST-indexTTS2-X-Player) 16★.

### The curated registry
`SillyTavern-Content` holds the in-app "Download Extensions & Assets" index. As of 2026-09 its
`extensions.json` lists **66 extensions**, and `index.json` lists **100 assets** (66 extensions,
14 BGM, 11 ambient, 6 characters, 3 blips). Submission requirements: open source with a libre
license, compatible with latest release, documented README, **and "extensions that have a server
plugin requirement to function will not be accepted."**

### Security incident — "Bot Browser" (2026)
Maintainer PSA: <https://github.com/SillyTavern/SillyTavern/discussions/5592> (2026-05-03), shipped
in the 1.18.0 release notes.

> *"We became aware of a third-party extension ('Bot Browser') that exploited a previously patched
> vulnerability in the data backup system in SillyTavern versions prior to 1.17.0 to exfiltrate API
> keys of users who had it installed. A repository belonging to the malicious developer has since
> been taken down… All versions of SillyTavern prior to 1.17.0 are considered insecure."*

The maintainers' afterword is the most important sentence in the whole ecosystem for a new app:

> *"We built the system that allows any developer to have the same level of access to the core of
> the application as we had… In a system that relies on trust, maybe it's better to be a little bit
> paranoid."*

1.18.0 responded by adding an install-confirmation prompt, grouping extensions into
"Official"/"Community", showing the resolved author from the git remote, and skipping folders
without a manifest. There is still **no sandbox and no permission model** — an extension is
arbitrary JS in the page with access to the settings store and the API keys.

---

## 4. Top pain points, r/SillyTavernAI + GitHub, 2025-09 → 2026-09

**Source caveats.** Reddit is DNS-blocked on the research host; evidence came from the redlib mirror
`safereddit.com` (post bodies, not comment trees) and from GitHub. Quotes are verbatim from post or
issue bodies, not comments. Nothing is invented.

**1. Long-term memory & context — the #1 unsolved problem (SEVERE, most frequent).**
A 28-respondent survey (2026-08-24) found character-specific knowledge rated major-or-worse by
**74 %** of respondents, with 77 % manually editing memory when it's wrong and 50 % also
regenerating. — <https://safereddit.com/r/SillyTavernAI/comments/1vxamvv/survey_results_28_ai_roleplayers_on_their_tools/>
VectFox's author: *"My SillyTavern stories run 2,000+ replies at 1,000+ words each… Every memory
extension I tried buckled under that load."* — <https://safereddit.com/r/SillyTavernAI/comments/1tfrcax/vectfox_vector_database_backend_driven_memory/>
A rival frontend: *"the AI starts hallucinating because it's drowning in old text… you're throwing
away money by sending 120k tokens per message… because you don't want to lose continuity."* —
<https://safereddit.com/r/SillyTavernAI/comments/1tgow6t/megumin_suite_v7_your_preset_your_memory_your/>
→ **Design-fixable.** Memory should be a first-class DB-backed subsystem, not a bolt-on.

**2. UX / "toggle hell" / settings overload (SEVERE, very frequent).**
Marinara Engine launch (1.1k upvotes, 364 comments): *"do I use chat completion or text completion,
how do I add this, how do I enable author's notes, how do I see the prompt I send, what even is the
prompt, and what the hell is temperature… Remember how much effort you had to put into setting up
SillyTavern?"* — <https://safereddit.com/r/SillyTavernAI/comments/1spufte/marinara_engine/>
A preset author: *"you open ST. and instead of RPing you spend 15 minutes configuring stuff. toggles,
system prompts, writing style. then you switch to another character tomorrow and do the whole thing
again."* — <https://safereddit.com/r/SillyTavernAI/comments/1s1rbav/>
A whole discovery site exists because of *"the near sheer-cliff-face that newcomers to SillyTavern
face"* (Tavernary) — <https://safereddit.com/r/SillyTavernAI/comments/1v83xqf/>

**3. Mobile — Termux fragility, no iOS story (SEVERE, frequent).**
Data loss on Android: *"I'm running SillyTavern through Termux on Android. Over the last few days,
I've had multiple chats suddenly reset to essentially 0/1 messages"* —
<https://safereddit.com/r/SillyTavernAI/comments/1w9cva6/>
*"I re installed termux without thought… My whole chat, 3 years of chat was utterly and totally
gone."* — <https://safereddit.com/r/SillyTavernAI/comments/1ue0k5w/>
*"Got fed up with Termux so I built open-source SillyTavern runner app… Termux was refusing to work
from secure folder."* — <https://safereddit.com/r/SillyTavernAI/comments/1r9s9b0/>
iOS port author: *"due to apple limitation we dont have access to JIT, which make the app little
slow and with slow starting times. There's no extension support… The server is very sensible to
closing the app just a second make it crash."* —
<https://safereddit.com/r/SillyTavernAI/comments/1rrbnow/>
→ Half design (no native app, desktop-first layout), half platform-inherent.

**4. Data loss / chat corruption — an open core bug (SEVERE, recurrent).**
GitHub [#5941](https://github.com/SillyTavern/SillyTavern/issues/5941) (open, Confirmed):
*"`POST /api/chats/get` responds HTTP 200 with `{}` on internal failure, so a caller cannot
distinguish 'the read failed' from 'this chat is empty'… `getChat()`… writes that assumption back to
disk… On one real install I counted 84 of 311 chat files with no `integrity` slug… one transient read
failure is enough to replace the chat with its greeting, with no confirmation."*
Also [#6032](https://github.com/SillyTavern/SillyTavern/issues/6032): same-character chat switching
cross-links integrity slugs → *"a populated chat was ultimately replaced with only its
metadata/header and a newly instantiated character greeting."*
→ **Design-fixable.** Safe read-modify-write + conflict detection + real cross-device sync.

**5. Performance with big chats (HIGH, frequent).**
*"SillyTavern will suddenly load in every single message, lagging my browser to hell and back. 2000+
messages all at once. I have it set to only load 5 messages at a time… it's rendering SillyTavern
close to unusable."* — <https://safereddit.com/r/SillyTavernAI/comments/1tkmzse/>
*"STs UI has been choppy/laggy for me. Even typing my text sometimes stops being input for a
second."* — <https://safereddit.com/r/SillyTavernAI/comments/1oi390o/>
*"I sometimes have to wait 30 or more seconds for 'Streaming request in progress'."* —
<https://safereddit.com/r/SillyTavernAI/comments/1ozzf3j/>
A popular preset had to ship regex *"to eliminate browser lag when tracking relationship/internal
states over long chats"* — <https://safereddit.com/r/SillyTavernAI/comments/1vmc07f/>
The FAQ concedes the design limit: *"SillyTavern wasn't designed to handle huge character libraries…
performance degradation starts to become noticeable when you have more than 1000 characters"*, and
*"Memory cache is disabled on Android devices due to the limited amount of available memory."* —
<https://docs.sillytavern.app/usage/faq/>

**6. Setup friction — Node/git/launcher/Docker/CORS/proxies (HIGH, frequent).**
*"I install node.js and git but when I run cmd and type in the prompt, it shows this… Turns out I
didn't give myself full control over the folder."* —
<https://safereddit.com/r/SillyTavernAI/comments/1veyqes/>
Good memory requires infrastructure: *"The fastest and most accurate option would use Qdrant vector
database on a docker as the backend."* — <https://safereddit.com/r/SillyTavernAI/comments/1tfrcax/>
Image gen requires ComfyUI + `--enable-cors-header` + Dev Mode —
<https://safereddit.com/r/SillyTavernAI/comments/1u87agq/>
→ Mostly inherent to self-hosting; the fix is shipping an installer and making remote access a feature.

**7. Cost & prompt caching / billing surprises (HIGH, frequent).**
*"Re-Shifted Architecture & 90%+ Cache Locks… Macro Dice rolls from the frontend were previously
breaking cache… your first message might show a 50% cache hit, but as your context grows, your cache
hit rate will climb toward 70–90%+."* — <https://safereddit.com/r/SillyTavernAI/comments/1vmc07f/>
*"Developed to save money on cache in a climate where this hobby is getting more expensive. Now you
can buy eggs AND chat messages!"* — <https://safereddit.com/r/SillyTavernAI/comments/1u2wrvq/>
A rival frontend admits: *"rebuilding context every turn means my techniques torch prompt caching."*
— <https://safereddit.com/r/SillyTavernAI/comments/1v3ukd3/>
Users resort to subscription-proxy workarounds — *"Technically might be a TOS/EULA violation"* —
<https://safereddit.com/r/SillyTavernAI/comments/1wdlv07/>
→ **Design-fixable.** Cache-aware prompt assembly + cost preview are product features.

**8. Extension breakage, security & trust (HIGH, periodic spikes).**
The Bot Browser incident (above). Plus the "Chibi" preset scandal — a popular shared preset shipped
CSA example text and users reported provider bans: *"the contents of the preset itself could've
gotten people flagged and banned"* —
<https://safereddit.com/r/SillyTavernAI/comments/1wkty52/>
And the maintenance gap: *"a lot of the stuff I used to bolt onto ST with extensions that are not
really maintained… are already there on Lumiverse from the get-go."* —
<https://safereddit.com/r/SillyTavernAI/comments/1sxkud8/>

**9. World Info triggers and surprises (MEDIUM-HIGH, frequent).**
*"your 'Bloodchain' entry stays cold because the word `bloodchain` was never typed. DeepLore casts a
wide net with keywords plus fuzzy matching"* —
<https://safereddit.com/r/SillyTavernAI/comments/1ub9zia/>
*"SillyTavern's lorebook is injected into the context window on every turn. At 2,000+ replies you
accumulate hundreds of entries, and depends on simple keyword matching for triggering."* —
<https://safereddit.com/r/SillyTavernAI/comments/1tfrcax/>
Feature request for more insertion positions: [#4508](https://github.com/SillyTavern/SillyTavern/issues/4508)
(done in staging). RAG was undocumented for a long time: [#1671](https://github.com/SillyTavern/SillyTavern/issues/1671) (34 comments).

**10. Prompt Manager / preset opacity (MEDIUM-HIGH).**
*"During the whole Chibi debacle, people kept repeating 'Make your own presets, people!' but I didn't
see anyone actually stepping up to release an up-to-date guide… If asked how, they received 'Well,
read someone else's preset and steal it.'"* —
<https://safereddit.com/r/SillyTavernAI/comments/1wnv6d7/>
A rival markets a built-in dry run: *"Dry run is built in. You can assemble the full prompt without
actually calling the model… ST, even with prompt inspector, felt fairly clunky."* —
<https://safereddit.com/r/SillyTavernAI/comments/1sxkud8/>

**11. Output quality — repetition, drift, omniscience (MEDIUM-HIGH, chronic).**
Survey: *"Repetitive, clichéd or purple prose — 68%; Passivity, rushing or poor pacing — 60%;
Excessive praise, positivity or weak conflict — 40%; Forgetting events or unresolved threads — 32%."*
— <https://safereddit.com/r/SillyTavernAI/comments/1vxamvv/>
*"character drift is the biggest problem in long-term roleplay. The AI forgets who your NPCs are.
Their edges get sanded off."* — <https://safereddit.com/r/SillyTavernAI/comments/1vrzcv6/>
*"Three messages later, some random bartender looks directly into your soul and says: 'I know you are
secretly the prince.' My brother in degeneracy, you have known me for twelve seconds."* —
<https://safereddit.com/r/SillyTavernAI/comments/1v10zx3/>
→ Architecture (information barriers, separate narrator/perception agents) can fix omniscience;
base-model sycophancy is inherent.

**12. Provider churn breaking presets and access (MEDIUM, spiky).**
*"The model was updated 3 hours after the release of this preset once again making the model
incompatible. I can't win."* — <https://safereddit.com/r/SillyTavernAI/comments/1vmc07f/>
Z.AI blocking RP on coding subs: *"SillyTavern NOT on whitelist"* —
<https://safereddit.com/r/SillyTavernAI/comments/1srltp4/>
*"When you post about a proxy, you push it closer to being destroyed."* —
<https://safereddit.com/r/SillyTavernAI/comments/1phzjkk/>

### What users say they want that ST doesn't have
- *"Top requested frontend improvements: lorebook tools (44%), memory in core (40%), mobile UX (36%),
  stability/backups/sync (36%)."* — <https://safereddit.com/r/SillyTavernAI/comments/1vxamvv/>
- One-click install with a setup wizard (Marinara: *"you just load up the thing, and that's it"*).
- *"local-first, mobile-first, BYOK AI roleplay frontend. No account, no cloud, no analytics, no
  backend holding your stuff… SillyTavern import… [with] a large-library stability/performance pass."*
  (Pyre) — <https://safereddit.com/r/SillyTavernAI/comments/1tyvvn1/>
- *"Roleplay for months and each message still loads that same 10-15k [tokens]. Thanks to this, the
  character never degrades."* — <https://safereddit.com/r/SillyTavernAI/comments/1v3ukd3/>
- Native Android APK, no Termux (Vibe Tavern 1.3: *"NO MORE TERMUX!"*) —
  <https://safereddit.com/r/SillyTavernAI/comments/1wfc3t6/>
- Simultaneous multi-generation / multi-agent routing (a stated reason for leaving ST).
- Proactive characters that message you first, aware of date/hour/season.
- A curated, discoverable extension/preset index (Tavernary).
- Game-mechanics authoring, not just prose (MVU Game Maker) —
  <https://safereddit.com/r/SillyTavernAI/comments/1vrld6c/>

---

## 5. Mobile story

### Android
Official path is **Termux**: <https://docs.sillytavern.app/installation/android-(termux)/> —
F-Droid/GitHub Termux (the Play Store build is unmaintained), `pkg install git nodejs-lts nano`,
`git clone -b release`, `bash start.sh`. 32-bit ARM needs `pkg install esbuild` (else
`Unsupported platform: android arm LEtime-web`). The docs recommend `lazyLoadCharacters: true`,
`useDiskCache: false`, backups off. The FAQ is blunt: *"Termux installations are not officially
supported, and we can't guarantee it will work."* The community guide the docs link
(<https://rentry.org/STAI-Termux>) **now 404s** (verified 2026-09-29). Termux itself warns it *"may
be unstable on Android 12+"* — Android kills excessive-CPU/phantom processes (signal 9), hence
`termux-wake-lock` (<https://wiki.termux.com/wiki/Termux-wake-lock>).

APK runners that embed Node without Termux:
- [Sanitised/ST-android](https://github.com/Sanitised/ST-android) — **129★, 2026-07, AGPL-3.0**,
  Kotlin. Unmodified ST + patched Node, one-click, Android 8+/arm64, own import/export + a
  Termux→APK migration script, *"Unlike Termux, the app works in Private Space/Secure
  Folder/Secondary profiles."* v0.5.0 (2026-07-29) has **6,980 downloads**. Known gap:
  *"Extensions are not properly supported yet."*
- [funnycups/Luker `android-app/`](https://github.com/funnycups/Luker/tree/release/android-app) —
  Node.js Mobile + JNI, WebView on `127.0.0.1:8000`, ~433 MB APK, v2.7.0 had 4,861 downloads.
- [CAPTCHAAAAA/SillyClient](https://github.com/CAPTCHAAAAA/SillyClient-iOS) (name is misleading —
  Android/Windows instance manager, MIT, 2026-09).
- [Aegis-plus/SillyTavern-Android](https://github.com/Aegis-plus/SillyTavern-Android) — 50★, ISC,
  idle since 2026-02; a **thin WebView client** pointing at a self-hosted instance.

### iOS
Officially unsolved. The FAQ: *"iPhones and iPads are not capable of running the whole SillyTavern
app… run it on another computer on your home Wi-Fi, and then access it in your mobile browser."*
Attempts:
- [elouannd/SillyTavern-foriOS](https://github.com/elouannd/SillyTavern-foriOS) — 20★, 2026-05,
  AGPL-3.0. nodejs-mobile on device. README admits *"No JIT (Apple restriction) — slower than
  desktop"*, *"No local AI models (no transformers, captioning, TTS/STT)"*, 1–3 min first launch,
  needs Xcode sideload, 7-day free-account re-signing.
- [MakrSas/sillytavern-ios-server](https://github.com/MakrSas/sillytavern-ios-server) — 0★, research
  prototype. NodeMobile 22.9.0 with **V8 `--jitless`, so no WebAssembly**; Undici replaced by
  `node-fetch`; WebP/AVIF unsupported; tiktoken replaced by an approximate byte tokenizer. States
  *"the real SillyTavern has not yet passed launch on iPhone"* and Safari launch is unreliable
  because iOS suspends the host app.
- [miaoxworld/NativeTavern](https://github.com/miaoxworld/NativeTavern) — 112★, GPL-3.0, Flutter +
  Rust FFI + drift/SQLite rewrite, claims ~98 % ST parity, APK + TestFlight.
- [BCCC0/SwiftTavern](https://github.com/BCCC0/SwiftTavern) 7★, [Starkka15/PocketTavern.iOS](https://github.com/Starkka15/PocketTavern.iOS)
  4★ (skeleton), [oocmoe/trance](https://github.com/oocmoe/trance) 81★ but **stale since 2025-07**.

Why it's hard: no JIT (kills WASM → no local embeddings/captioning), strict background suspension
(generation must be owned natively, `BGContinuedProcessingTask` on iOS 26+ / `beginBackgroundTask`
before), no sideloading ecosystem (unsigned IPAs + 7-day re-signing or $99/yr), WKWebView quirks
(safe-area insets, file import/export, fullscreen), and App Store economics (LLC + Mac + ~25 %
rejection rate) that make an open-source iOS ST commercially irrational.

### What people actually use
The dominant pattern is **(b) run ST on a PC/server, use it from the phone browser/PWA**. This is the
official recommendation: set `listen: true` + whitelist/basic-auth
(<https://docs.sillytavern.app/usage/remoteconnections/>), then **Tailscale / Cloudflare Zero Trust /
ngrok**, never port-forwarding
(<https://docs.sillytavern.app/administration/tunneling/>). The reverse-proxy guide literally opens
with *"Is Termux confusing to set up?… host SillyTavern on your PC where you can connect from
anywhere"* (<https://docs.sillytavern.app/usage/st-reverse-proxy-guide/>). PWA install is supported
(manifest + apple meta tags + `mobile-styles.css`).

The single most-requested missing feature in the ST-android thread is **PC↔phone sync**: *"The only
thing left is to somehow allow direct connection between PC and mobile version… automatic chats and
characters copying, presets and settings copying."*

### Native reimplementations / forks
| Project | ★ | pushed | lic | Divergence |
|---|---|---|---|---|
| [Darkatse/TauriTavern](https://github.com/Darkatse/TauriTavern) | **1,776** | 2026-09 | AGPL-3.0 | **Tauri/Rust rewrite** that keeps the upstream ST frontend and replaces the Node backend with Rust. Ships Win/macOS/Linux/Android APKs/iOS IPA + TestFlight, Flatpak/WinGet/Scoop/Homebrew/AUR/Nix, native git for extensions, **encrypted LAN multi-device sync**, agent framework, one-click ST data migration. Most credible one-codebase play. |
| [steve02081504/fount](https://github.com/steve02081504/fount) | 708 | 2026-09 | NOASSERTION | Deno agent runtime platform, ST/Risu card compat, P2P LAN/BT, Docker/Android. Customise agent logic, not just prompts. |
| [funnycups/Luker](https://github.com/funnycups/Luker) | 488 | 2026-09 | AGPL-3.0 | "Better SillyTavern": **backend-owned generation jobs that survive frontend reload**, patch-first incremental persistence instead of full-save payloads, prompt-preset-aware message assembly, WI simulation/finalization hooks, built-in `Orchestrator` (multi-agent planning) and graph-memory `Memory` plugins. |
| [zhaiiker/SillyTavernMOD](https://github.com/zhaiiker/SillyTavernMOD) | 88 | 2026-09 | AGPL-3.0 | 1.19.0 + a low-invasion "sidecar module" adding SillyTavernchat admin/ops (Chinese community). |
| [aikohanasaki/Aikobots](https://github.com/aikohanasaki/Aikobots) | 22 | 2026-09 | AGPL-3.0 | Personal fork by the MemoryBooks author. |
| [miaoxworld/NativeTavern](https://github.com/miaoxworld/NativeTavern) | 112 | 2026-09 | GPL-3.0 | Flutter/Rust from-scratch rewrite, cross-platform mobile-first. |
| [elouannd/SillyTavern-foriOS](https://github.com/elouannd/SillyTavern-foriOS) | 20 | 2026-05 | AGPL-3.0 | iOS nodejs-mobile port. |
| [SillyTavern-Extras](https://github.com/SillyTavern/SillyTavern-Extras) | 701 | 2024-12 | AGPL-3.0 | The **obsolete** Python sidecar — the thing everyone built against and that has been dead for ~21 months. Its decay is why `Extras` still appears as a source in Summarize/Expressions/Caption/TTS. |

Why forks exist: (a) **mobile/native packaging** upstream refuses to own; (b) **multi-agent
orchestration and durable generation** upstream hasn't built; (c) **regional/community ops**
(multi-user chat rooms, admin); (d) **opinionated memory/state** that upstream keeps out of core.

---

## 6. Context management, token budgeting, prompt-caching awareness

### The budget
```js
getMaxPromptTokens() = getMaxContextTokens() - (overrideResponseLength || getMaxResponseTokens())
```
(`public/script.js:5981`). `getMaxContextTokens()` returns `max_context` for Text Completion APIs,
`oai_settings.openai_max_context` for Chat Completion, and a hardcoded **1487** fallback otherwise;
NovelAI clio/kayra/erato are clamped to 8192 (erato −10 for special tokens) and to the Kayra
subscription limit. Chat Completion defaults are `openai_max_context: 4096`,
`openai_max_tokens: 300` (`public/scripts/openai.js:422`). `getMaxContextSize` survives only as a
deprecated alias.

**Token padding**: `power_user.token_padding` (default **64**) is added to *every* measured string via
`getTokenCountAsync(str, power_user.token_padding)`. Because tokenisation near the window edge is
estimated, this flat addend is the entire safety margin — and it inflates every count, which can
cause over-trimming. Text Completion also subtracts CFG prompt cost
(`this_max_context -= max(negTokens, posTokens)`) and Horde auto-adjust
(`maxContextLength - maxLength`).

### Text Completion trimming
`Generate()` computes `this_max_context` once, then builds the prompt as
`storyString + examples + chat history + last line`. `checkPromptSize()` (`script.js:5104`) is a
**recursive** overflow loop: if the tokenised prompt exceeds `this_max_context`, it first drops
**example messages** one at a time, and only when examples are exhausted does it `mesSend.shift()` —
i.e. **the oldest chat message is dropped first, examples second, and once both are gone it just
stops** ("`---mesSend.length = 0`" — no error). Messages are added oldest-first until the budget is
hit (`tokenCount < this_max_context`), and an optional **user-alignment message** is prepended if the
oldest surviving message isn't a user turn. World Info is resolved *before* this, against the same
`this_max_context`.

### World Info budget
`world_info_budget` defaults to **25** (percent of `maxContext`), `world_info_budget_cap` 0
(absolute token cap, takes precedence), `world_info_max_recursion_steps` 0. The UI resets any value
>100 back to 25. Activation order: **constant entries first, then by descending insertion order**,
with entries triggered by *directly mentioning their keys* taking priority over entries triggered
from inside other entries' content. When the budget overflows, the loop `break`s unless the entry
has `ignoreBudget` — i.e. **later-sorted entries silently vanish**. `world_info_min_activations`
(mutually exclusive with max recursion steps) keeps scanning backwards through the log until N
entries fire, bounded by max depth and the budget. Docs are explicit that *"If the budget is
exhausted, then no more entries are activated even if the keys are present in the prompt."*
Vector Storage matching *"only replaces the check for keywords"* and all other budgeting rules still
apply; the docs warn *"it's impossible to predict exactly what entries will be inserted."*

### Chat Completion budgeting
The Prompt Manager assembles an ordered list of prompt blocks, each with a role, `injection_position`
(`RELATIVE = 0` / `ABSOLUTE = 1`) and `injection_depth` (`DEFAULT_DEPTH = 4`), `injection_order`
(`DEFAULT_ORDER = 100`), `forbid_overrides`, `extension`, and an `injection_trigger` that gates the
prompt by generation type (`shouldTrigger()`). Markers whose content is filled at assembly time:
`dialogueExamples`, `chatHistory`, `worldInfoAfter`, `worldInfoBefore`, `charDescription`,
`charPersonality`, `scenario`, `personaDescription`; system prompts: `main`, `nsfw`, `jailbreak`,
`enhanceDefinitions`. `prompt_order` defaults to the `'global'` strategy, overridable per character.

`populateTokenCounts()` resets a `TokenHandler` and stores `counts[message.identifier] =
message.getTokens()`, summing into `tokenUsage`. The chat-history marker carries the token count, and
`PromptManager.js:1677` warns when `tokenUsage > (openai_max_context - openai_max_tokens) * 0.8`:
*"Only a few messages worth chat history are being sent"* (≤1500 tokens) or *"Very little of your
chat history is being sent, consider deactivating some other prompts"* (≤500 tokens).

On the OpenAI path, `ChatCompletion` keeps a `tokenBudget = context - response` with
`canAfford(msg) = 0 <= tokenBudget - msg.getTokens()`, `canAffordAll(list)` for atomic groups
(tool-call batches), `reserveBudget/freeBudget`, and a `TokenBudgetExceededError` guard.
`Message.tokensPerImage = 85`. Base assembly order is
`worldInfoBefore → main → worldInfoAfter → charDescription → charPersonality → scenario`, with budget
reserved up front for the new-chat message, group nudge, continue nudge, and empty-user replacement.
`populateChatHistory` walks history newest-first and `break`s on the first message that doesn't fit —
the same oldest-first eviction as the Text Completion path, just expressed as a budget rather than a
recursive re-check.

### Per-message accounting
`public/scripts/itemized-prompts.js` stores, per chat, in IndexedDB (`SillyTavern_Prompts`) keyed by
chat id, a record per generated message with `rawPrompt`, `mesSendString`, `finalPrompt`,
`worldInfoString`, `allAnchors`, `summarizeString`, `authorsNoteString`, `smartContextString`,
`chatVectorsString`, `dataBankVectorsString`, `chatInjects`, `beforeScenarioAnchor`,
`afterScenarioAnchor`, plus the OAI breakdown (`oaiStartTokens`, `oaiPromptTokens`, `oaiMainTokens`,
`oaiExamplesTokens`, `oaiConversationTokens`, `oaiBiasTokens`, `oaiJailbreakTokens`,
`oaiNudgeTokens`, `oaiImpersonateTokens`, `oaiNsfwTokens`, `oaiTotalTokens`), `presetName`,
`modelUsed`, `apiUsed`, `messagesCount`, `examplesCount`. This is what powers the
"Prompt Itemization" popup on each reply — the single best diagnostic ST has, and it lives in the
browser, not on the server.

### Prompt-caching awareness
ST is **aware but opt-in, conservative, and mostly Anthropic-shaped**:

- `default/config.yaml` exposes exactly four knobs, all off by default:
  `claude.enableSystemPromptCache: false`, `claude.cachingAtDepth: -1`,
  `claude.extendedTTL: false`, `gemini.enableSystemPromptCache: false`.
- `src/endpoints/backends/chat-completions.js:106` reads `cacheTTL` once at module load
  (`'1h'` if `extendedTTL` else `'5m'`) and `cachingAtDepth` once. For Claude it appends
  `cache_control: {type: 'ephemeral', ttl}` to the **last system-prompt block** and, if tools are
  enabled, to the **last tool**; when at-depth caching is on it calls
  `cachingAtDepthForClaude(messages, cachingAtDepth, cacheTTL)` from `src/prompt-converters.js:985`,
  which walks the message array backwards, skips the assistant prefill, counts role changes, and
  stamps the boundary at `depth === cachingAtDepth` and again at `cachingAtDepth + 2` (max two
  breakpoints). Enabling either pushes the beta headers
  **`prompt-caching-2024-07-31`** and **`extended-cache-ttl-2025-04-11`**.
- OpenRouter gets an equivalent `cachingAtDepthForOpenRouterClaude` (skips system messages when
  counting depth) plus `cachingSystemPromptForOpenRouter`, which caches the first system message by
  wrapping string content into `[{type:'text', text, cache_control}]`.
- **Gemini via OpenRouter** only: requires the model to match `/google\/gemini/` **and**
  `isOpenRouterModelCacheable(model)` — which queries OpenRouter's `/models` and checks
  `pricing.input_cache_write`, memoised in `openRouterCacheableModels` — **and**
  `gemini.enableSystemPromptCache`. There is no native-Gemini `cachedContent` handling.
- **NanoGPT**: `if (enableSystemPromptCache && isClaude) bodyParams['cache_control'] = {enabled:true, ttl}`.
- **Fireworks**: not caching — `headers['x-session-affinity'] = HMAC-SHA256(cookieSecret, chat_id).slice(0,16)`
  (`chat-completions.js:2474`) — per-chat sticky routing so the provider's prefix cache actually hits.
- **Thinking budgets are a separate, bigger lever**: `calculateClaudeBudgetTokens` returns an effort
  *string* for adaptive models (Opus 4.6+), otherwise a numeric budget (min 1024; 0.1/0.25/0.5/0.95 ×
  maxTokens; non-streaming clamped to 21333). `calculateGoogleBudgetTokens` has per-variant curves
  clamped to 24576. Thinking mode silently raises `max_tokens` and therefore shrinks the prompt budget.
- The config file's own comments are the honest statement of the tradeoff: *"Use only when the prompt
  before the chat history is static and doesn't change between requests (e.g `{{random}}` macro or
  lorebooks not as in-chat injections). Otherwise, you'll just waste money on cache misses."* and for
  at-depth: *"Use with caution. Behavior may be unpredictable and no guarantees can or will be made."*
  The docs repeat it: *"Behavior may be unpredictable… the provider may have a minimum prompt size
  requirement for caching."*
- The chat-vectorization doc is the sharpest acknowledgement that ST's own feature set fights
  caching: *"Like any dynamic prompt source (World Info, Summarization, etc.), Chat Vectorization
  restructures the prompt prefix between the LLM calls, which can lead to frequent cache misses.
  When used with caching, vectorization is often counter-productive, as the modified prompts rarely
  hit the cache – effectively making caching useless. You have to choose one or the other, but not
  both."*
- There is **no cache-hit-rate display, no cost estimate, and no cache-aware prompt planner.** The
  community solved this with preset architecture ("Re-Shifted Architecture & 90%+ Cache Locks",
  moving `{{random}}`/dice out of the prefix) and complained when providers broke it. Group chats
  expose one caching-aware design decision — "Join character cards" exists *"when altering large
  chunks of the context is undesirable, e.g. with llama.cpp prompt caching"* — and 1.18 added
  "Classic blocking" summarization *"recommended to use with llama.cpp and its siblings"* for the
  same reason.

**Net:** caching is a set of footguns exposed as four config flags. A new app can own this.

### Known failure modes (verified against source)
1. **Cache misses from dynamic prompt sources.** WI insertion (especially `@depth`), vector/RAG
   shuffling, summarisation, and `{{random}}`/time macros all mutate the prefix and invalidate
   everything after the cache breakpoint. Docs: caching and dynamic sources are *"choose one or the
   other, but not both."*
2. **WI budget overflow is silent.** Once `budget` is reached, subsequent entries are dropped unless
   they carry `ignoreBudget`, and recursion + min-activation sweeps halt. Only `world_info_overflow_alert`
   surfaces it.
3. **Oldest-first eviction is nearly invisible.** Both `checkPromptSize()` and the OpenAI budget
   silently drop the oldest history; only the `.lastInContext` marker (also written to
   `chat_metadata.lastInContextMessageId`) and the Prompt Manager's chatHistory thresholds hint at it.
4. **Flat token padding** (64) is added to every string and inflates estimates → over-trimming.
5. **Cache TTL economics.** `extendedTTL` moves 5m→1h and explicitly raises request cost; an unread
   cache write is pure cost.
6. **Thinking mode shrinks the prompt budget** by raising `max_tokens` (Claude numeric minimum +1024).
7. **Provider cache support is inferred, not declared.** Gemini caching only works through OpenRouter
   and only after an extra `/models` round-trip to read `pricing.input_cache_write`.

---

## 7. What to steal / what to avoid

### Steal
1. **The World Info entry model.** Keys + regex, optional filters with AND/ANY/NOT semantics, insertion
   order *and* insertion position (including `@depth` and named outlets), probability, inclusion
   groups with scoring, timed effects (sticky/cooldown/delay), recursion with per-entry recursion
   control, and scoping by global/character/persona/chat. It is a genuinely good DSL for prompt
   injection and nothing else in the space matches it.
2. **`itemized-prompts`.** Per-message, per-category token accounting stored alongside the message,
   surfaced on the reply. Steal the idea, fix the storage (server-side, queryable, not IndexedDB).
3. **The two-family API abstraction** (Chat Completion vs Text Completion) with a
   per-provider normaliser that reduces every streaming wire format to `{chunk, reasoning}`. ST's
   `parseStreamData` is the most complete such normaliser in the open-source RP space and shows
   exactly which providers are weird (Cohere, Claude thinking blocks, Gemini `thought` parts,
   llama.cpp, NovelAI tokens).
4. **The card formats.** PNG V2/V3 tEXt, JSON, CharX (ZIP with sprite/background assets), BYAF.
   Import all of them, plus ST's own JSONL chats and `settings.json`, or you start with an empty
   library. Compatibility is the moat every serious competitor markets.
5. **Backend-owned generation jobs.** Luker's most valuable divergence: generation survives a
   frontend reload/disconnect and output is recoverable after reconnect. ST's is frontend-owned and
   dies with the tab.
6. **The "why did this fire" tooling idea** — WorldInfoInfo, ace-entry-track, PromptInspector,
   InjectManager, and the itemized prompt popup all exist because users cannot see what the prompt
   actually is. Make this first-class, not an extension.
7. **The extension manifest + lifecycle hooks + `getContext()`** design is a good, small contract.
   Steal the shape; add the sandbox.
8. **Talkativeness + natural-order group drafting**, and "join vs swap character cards" as an
   explicit caching-vs-fidelity tradeoff.
9. **The layered-summary idea** (Summaryception) and **event-extraction + structured vector store**
   (VectFox: characters/items/locations/concepts/importance/DateTime). Both are better than ST's
   flat single summary, and both are implemented as fragile extensions today.

### Avoid
1. **Do not make an extension ecosystem the security model.** Bot Browser exfiltrated API keys by
   exploiting a patched backup bug, because extensions have unrestricted access to a store holding
   plaintext keys. Ship sandboxing, a permission manifest, signed/curated registry, and scoped
   key access.
2. **Do not put the prompt-assembly brain in a 12k-line jQuery file.** `script.js` mixing chat,
   generation, trimming, and rendering is why the UI janks on big chats and why `checkPromptSize()`
   has to be recursive.
3. **Do not store chats as a single JSONL rewritten in full.** `writeFileAtomicSync` + whole-file
   rewrite + a client that treats an HTTP-200-with-`{}` as "empty chat" is how users lost years of
   history (#5941, #6032). Use an append-only log or a real DB, fail closed on unreadable data, and
   make backups restorable.
4. **Do not ship a Node server as the mobile story.** Termux is unsupported, dies on Android 12+
   process limits, needs `esbuild` hacks on 32-bit, and eats a wake-lock. Native core, no on-device Node.
5. **Do not design desktop-first and retrofit touch.** ST's changelog is a long tail of mobile
   keyboard/viewport/pull-to-refresh/autocomplete-lag fixes.
6. **Do not treat caching as a config flag.** Make prompt assembly cache-aware by construction:
   stable prefix, volatile content at the tail, a visible cache-hit estimate, and cost preview.
   ST's own docs admit vectorization and caching are mutually exclusive — that is a design failure,
   not a user error.
7. **Do not use "summarize into one blob" as the memory architecture.** The docs themselves say
   summaries hallucinate; the field has moved to layered/event-structured stores.
8. **Do not keep a dead sidecar in the critical path.** `SillyTavern-Extras` has been `[OBSOLETE]`
   since 2024-12 yet remains an advertised source in Summarize, Expressions, Captioning and TTS.
9. **Do not expose 100+ slash commands and 100+ events as the only automation story** without a
   visual/debuggable layer — the Prompt Manager's opacity is a top-five complaint.
10. **Do not accept a setup that requires Node + git + Docker + Qdrant + ComfyUI + a reverse proxy.**
    Ship an installer, in-app key management, and one-tap LAN/tunnel pairing.

---

## Sources

**Primary repo & docs**
- https://github.com/SillyTavern/SillyTavern (33,910★, AGPL-3.0, v1.19.0)
- https://github.com/SillyTavern/SillyTavern/releases (1.14.0 → 1.19.0 release notes)
- https://github.com/SillyTavern/SillyTavern/blob/release/package.json
- https://github.com/SillyTavern/SillyTavern/blob/release/webpack.config.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/lib.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/manifest.json
- https://github.com/SillyTavern/SillyTavern/blob/release/public/index.html
- https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js (12,599 LOC)
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js (7,396 LOC)
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js (6,408 LOC)
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/PromptManager.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/itemized-prompts.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/sse-stream.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/events.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/prompt-converters.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/constants.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/users.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/chats.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/charx.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/byaf.js
- https://github.com/SillyTavern/SillyTavern/blob/release/default/config.yaml
- https://github.com/SillyTavern/SillyTavern/blob/release/default/scaffold/README.md
- https://github.com/SillyTavern/SillyTavern/blob/release/src/electron/package.json
- https://github.com/SillyTavern/SillyTavern/tree/release/public/scripts/extensions (14 manifests)
- https://docs.sillytavern.app/
- https://docs.sillytavern.app/usage/faq/
- https://docs.sillytavern.app/usage/worldinfo/
- https://docs.sillytavern.app/usage/characters/groupchats/
- https://docs.sillytavern.app/usage/personas/
- https://docs.sillytavern.app/usage/core-concepts/authors-note/
- https://docs.sillytavern.app/usage/prompts/prompt-manager/
- https://docs.sillytavern.app/usage/prompts/context-template/
- https://docs.sillytavern.app/usage/prompts/tokenizer/
- https://docs.sillytavern.app/usage/core-concepts/data-bank/
- https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/
- https://docs.sillytavern.app/extensions/summarize/
- https://docs.sillytavern.app/extensions/chat-vectorization/
- https://docs.sillytavern.app/for-contributors/st-script/
- https://docs.sillytavern.app/for-contributors/writing-extensions/
- https://docs.sillytavern.app/administration/config-yaml/
- https://docs.sillytavern.app/installation/android-(termux)/
- https://docs.sillytavern.app/usage/remoteconnections/
- https://docs.sillytavern.app/administration/tunneling/
- https://docs.sillytavern.app/usage/st-reverse-proxy-guide/
- https://github.com/SillyTavern/SillyTavern-Docs

**Security**
- https://github.com/SillyTavern/SillyTavern/discussions/5592 (Bot Browser PSA, 2026-05-03)

**Extension registry**
- https://github.com/SillyTavern/SillyTavern-Content/blob/main/extensions.json (66 curated extensions)
- https://github.com/SillyTavern/SillyTavern-Content/blob/main/index.json (100 assets)
- https://github.com/orgs/SillyTavern/repositories (~70 repos)

**Third-party extensions** — see the tables in §3; all URLs are inline.
Key ones: https://github.com/muyoou/st-memory-enhancement ·
https://github.com/aikohanasaki/SillyTavern-MemoryBooks ·
https://github.com/Lodactio/Extension-Summaryception ·
https://github.com/SenriYuki/SillyTavern-Horae ·
https://github.com/KritBlade/VectFox ·
https://github.com/senjinthedragon/Smart-Memory ·
https://github.com/pixelnull/sillytavern-DeepLore ·
https://github.com/qvink/SillyTavern-MessageSummarize ·
https://github.com/SpicyMarinara/rpg-companion-sillytavern ·
https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework ·
https://github.com/bmen25124/SillyTavern-WTracker ·
https://github.com/bmen25124/SillyTavern-Character-Creator ·
https://github.com/Samueras/GuidedGenerations-Extension ·
https://github.com/SillyTavern/Extension-WebSearch ·
https://github.com/SillyTavern/Extension-PromptInspector ·
https://github.com/SillyTavern/Extension-WebLLM

**Forks / native clients**
- https://github.com/Darkatse/TauriTavern · https://github.com/funnycups/Luker ·
  https://github.com/steve02081504/fount · https://github.com/zhaiiker/SillyTavernMOD ·
  https://github.com/miaoxworld/NativeTavern · https://github.com/elouannd/SillyTavern-foriOS ·
  https://github.com/Sanitised/ST-android · https://github.com/Aegis-plus/SillyTavern-Android ·
  https://github.com/MakrSas/sillytavern-ios-server · https://github.com/CAPTCHAAAAA/SillyClient-iOS ·
  https://github.com/aikohanasaki/Aikobots · https://github.com/Pasta-Devs/Marinara-Engine
- https://github.com/SillyTavern/SillyTavern-Extras (`[OBSOLETE]`, last push 2024-12)

**Community evidence**
- Reddit via the redlib mirror `safereddit.com` (reddit.com is DNS-blocked on the research host):
  survey https://safereddit.com/r/SillyTavernAI/comments/1vxamvv/ ·
  Marinara https://safereddit.com/r/SillyTavernAI/comments/1spufte/ ·
  Pyre https://safereddit.com/r/SillyTavernAI/comments/1tyvvn1/ ·
  VectFox https://safereddit.com/r/SillyTavernAI/comments/1tfrcax/ ·
  DeepLore https://safereddit.com/r/SillyTavernAI/comments/1ub9zia/ ·
  Termux data loss https://safereddit.com/r/SillyTavernAI/comments/1w9cva6/ ·
  "never delete termux" https://safereddit.com/r/SillyTavernAI/comments/1ue0k5w/ ·
  iOS port https://safereddit.com/r/SillyTavernAI/comments/1rrbnow/ ·
  ST-android runner https://safereddit.com/r/SillyTavernAI/comments/1r9s9b0/ ·
  UI lag https://safereddit.com/r/SillyTavernAI/comments/1oi390o/ ·
  pagination https://safereddit.com/r/SillyTavernAI/comments/1tkmzse/ ·
  setup https://safereddit.com/r/SillyTavernAI/comments/1veyqes/ ·
  cache/preset https://safereddit.com/r/SillyTavernAI/comments/1vmc07f/ ·
  preset guide https://safereddit.com/r/SillyTavernAI/comments/1wnv6d7/ ·
  Chibi https://safereddit.com/r/SillyTavernAI/comments/1wkty52/ ·
  Lumiverse https://safereddit.com/r/SillyTavernAI/comments/1sxkud8/ ·
  Tavernary https://safereddit.com/r/SillyTavernAI/comments/1v83xqf/ ·
  fiction engine https://safereddit.com/r/SillyTavernAI/comments/1v10zx3/ ·
  Termux 404 guide https://rentry.org/STAI-Termux (dead) ·
  wake lock https://wiki.termux.com/wiki/Termux-wake-lock
- GitHub issues: #5941, #6032, #5033, #3507, #2960, #1731, #1278, #2285, #1671, #4508
