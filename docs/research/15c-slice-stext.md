# SillyTavern extension API surface & third-party-client reuse feasibility

Pinned to `release` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (2026-09-14, tag 1.19.0). Repo AGPL-3.0, 33,910★, last push 2026-09-23. Docs repo last push 2026-07-09.

## 1. Manifest format & discovery

`manifest.json` per extension folder. Fields read by the loader: `display_name` (required), `loading_order`, `js` (required), `css`, `author` (required), `version`, `homePage`, `auto_update`, `i18n`, `hooks`, `dependencies`, `generate_interceptor`, `minimum_client_version`. `requires`/`optional` are **deprecated** (legacy Extras-API modules).

`hooks` maps lifecycle name → exported function name: `install`, `update`, `delete`, `clean`, `enable`, `disable`, `activate`. Each awaited with a 5 s timeout.

Discovery is server-side: `GET /api/extensions/discover` scans three dirs, returns `{type, name}` where type ∈ `system` | `local` | `global`. Folders without `manifest.json` are skipped.

- system → `public/scripts/extensions/<folder>` (15 built-ins: regex, quick-reply, vectors, tts, caption, expressions, gallery, memory, translate, token-counter…)
- local → `data/<handle>/extensions/<folder>`, exposed as `third-party/<folder>`
- global → `public/scripts/extensions/third-party/<folder>`, also `third-party/<folder>`; local wins on collision

Activation (`loadExtensionSettings` → `activateExtensions`): fetch each `/scripts/extensions/<name>/manifest.json`, sort by `loading_order` then `display_name`, check `minimum_client_version` and `dependencies` (must exist, must not be in `extension_settings.disabledExtensions`), then `addExtensionLocale`+`addExtensionScript`+`addExtensionStyle`, then the `activate` hook. Asset URL is always `/scripts/extensions/<name>/<manifest.js|css>`.

## 2. The context API

`globalThis.SillyTavern = { libs, getContext }`. `getContext()` returns a **~160-key object literal** (172 counting nested `swipe`/`variables`/`symbols`/`constants` sub-keys). Enumerated from source: `chat`, `characters`, `groups`, `name1`, `name2`, `characterId`, `groupId`, `chatId`, `chatMetadata`, `chatCompletionSettings` (=`oai_settings`), `textCompletionSettings`, `powerUserSettings`, `mainApi`, `extensionSettings`, `eventSource`, `eventTypes` (+ legacy `event_types`), `generate`, `generateRaw`, `generateQuietPrompt`, `generateRawData`, `setExtensionPrompt`, `extensionPrompts`, `substituteParams(Extended)`, `SlashCommandParser`, `SlashCommand*`, `ARGUMENT_TYPE`, `executeSlashCommandsWithOptions`, `registerSlashCommand` (deprecated), `macros`, `renderExtensionTemplateAsync`, `Popup`, `POPUP_TYPE`, `POPUP_RESULT`, `callGenericPopup`, `getRequestHeaders`, `saveSettingsDebounced`, `saveMetadata`, `tokenizers`, `getTokenCountAsync`, `ConnectionManagerRequestService`, `ChatCompletionService`, `TextCompletionService`, `getWorldInfoPrompt`, `loadWorldInfo`, `variables.local/global`, `writeExtensionField`, `openThirdPartyExtensionMenu`, `getExtensionManifest`, `loader`, `isMobile`, `t`.

**Note:** the brief names `registerExtension` — no such export exists on `release` or `staging`. The only repo-wide hit is `registerExtensionSlashCommands` (internal, `public/scripts/extensions-slashcommands.js`). The registration equivalent is the manifest `hooks.activate` export plus `eventSource.on(APP_READY)`.

Dependency mix across 8 top extensions (see Sources): `extensionSettings`+`saveSettingsDebounced`+`eventSource`/`event_types` in nearly all; jQuery `$()` in 6/8 (301 calls in rpg-companion, 216 in JS-Slash-Runner); direct `/api/*` in 5/8, most often `/api/backends/chat-completions/generate`.

## 3. Event names

`event_types` in `public/scripts/events.js` — 104 keys, 103 distinct strings. Notables: `app_initialized`, `app_ready` (both auto-fire to late listeners via `EventEmitter(..., [APP_READY, APP_INITIALIZED])`), `extensions_first_load`, `extension_settings_loaded`, `settings_loaded(_before/_after)`, `chat_id_changed`, `chatLoaded`, `message_sent/received/edited/deleted/swiped/updated`, `user_message_rendered`, `character_message_rendered`, `stream_token_received`, `generation_started/stopped/ended`, `GENERATION_AFTER_COMMANDS`, `generate_before_combine_prompts`, `generate_after_data`, `world_info_activated`, `worldinfo_updated`, `worldinfo_entries_loaded`, `worldinfo_scan_done`, `character_page_loaded`, `character_edited`, `group_updated`, `group_member_drafted`, `group_wrapper_started/finished`, `chat_completion_prompt_ready`, `tool_calls_performed`, `secret_written`, `preset_changed`, `main_api_changed`, `persona_*`, `tts_*`. **`character_selected` and `extension_prompt_ready` do not exist** in the enum. Payload shapes are heterogeneous (docs say so explicitly).

## 4. STscript, Quick Replies, outlets

STscript: `|`-separated command batches with a pipe value; `/pass Hello | /echo` — `/echo Hello` equivalent. Extensions register via `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))`; once registered the command is usable in any STscript context. `/help slash` lists commands.

Quick Replies ship an auto-execution engine with per-QR boolean triggers: `executeOnStartup`, `executeOnUser`, `executeOnAi`, `executeOnChatChange`, `executeOnNewChat`, `executeBeforeGeneration`, plus `preventAutoExecute` and `automationId`. `AutoExecuteHandler.handleWIActivation(entries)` collects `entries.map(e => e.automationId)` and runs every QR whose `automationId` matches — that is the World-Info ↔ QR link. Stored as `extensions.automation_id` on WI entries; a command runs once even if several entries share the ID. QR also exposes `quickReplyApi` (global + exported) with `listSets/listQuickReplies/listAutomationIds/createQuickReply/…` and slash commands `/qr`, `/qr-create`, `/qr-set`, `/qr-set-on/off`, `/qr-chat-set`, `/qr-get`, `/qr-contextadd`…

`{{outlet::Name}}` is a **macro**, not an extension API: `public/scripts/macros.js` line 668 maps `/{{outlet::(.+?)}}/gi` → `getOutletPrompt(key)`, which reads `extension_prompts[inject_ids.CUSTOM_WI_OUTLET(key)].value`. WI entries with position "Outlet" are written into `extension_prompts` at `extension_prompt_types.NONE` (`-1`) and materialized wherever the macro appears. Case-sensitive; no nesting.

## 5. Server plugin API

Yes. `src/plugin-loader.js`, gated on `enableServerPlugins` in `config.yaml` (default **false**); auto-update via git unless `enableServerPluginsAutoUpdate: false`. Plugins live in `plugins/` (shipped dir holds only `.gitkeep` + `package.json`). Contract: exports `info {id,name,description}`, `init(router)` (Express `Router`), optional `exit()`. Routes mount at `/api/plugins/<id>/…`; id must match `/^[a-z0-9_-]+$/`.

A plugin can do what a UI extension cannot: register server endpoints, use Node APIs/arbitrary npm packages, touch the filesystem, add backend generation sources. Only 6 official plugins exist (topic:plugin org:SillyTavern; largest SillyTavern-WebSearch-Selenium, 65★). Plugins are **not sandboxed**. `SillyTavern-Extras` — the external-modules API that `requires`/`optional` pointed at — is `[OBSOLETE]`, last push 2024-12-10.

## 6. Reuse feasibility

**Verdict: not realistic for a foreign (Tauri/React/Flutter) client to run unmodified third-party ST extensions. Partially realistic only for a narrow, deliberately-built subset.** Blockers, each verified in source:

1. **jQuery + ST DOM ids.** Extensions append into `#extensions_settings` / `#extensions_settings2` / `#extensionsMenu` and bind to `#send_textarea`, `#send_but`, `.mes`, `#rightNavHolder`, `#top-bar`, `#rm_print_characters_block`. jQuery 3.5.1 + jQuery-UI are plain `<script>` tags in `index.html` (lines 8201–8213), not part of `libs`.
2. **`getContext()` semantics are object-identity-bound.** `chat`, `characters`, `chatMetadata`, `extensionPrompts` are live mutable references into ST's own module state; docs warn `chatMetadata`'s reference changes on chat switch. A reimplementation must reproduce those objects, not just the function names.
3. **Server surface.** ~45 Express routers mounted in `setupPrivateEndpoints` (`/api/characters`, `/api/chats`, `/api/worldinfo`, `/api/settings`, `/api/backends/chat-completions`, `/api/tokenizers`, `/api/extensions`, `/api/secrets`…). Extensions call them directly. Plus CSRF: `getRequestHeaders()` returns `{'Content-Type','X-CSRF-Token': token}`, token from `GET /csrf-token`, injected into every jQuery request by a global `$.ajaxPrefilter`.
4. **Persistence.** `extensionSettings` round-trips through `POST /api/settings/save` (whole `settings.json` payload incl. `power_user`, `oai_settings`, `textgenerationwebui_settings`). No per-extension store exists.
5. **`extension_prompt_types`** = `{NONE:-1, IN_PROMPT:0, IN_CHAT:1, BEFORE_PROMPT:2}` and `extension_prompt_roles` = `{SYSTEM:0, USER:1, ASSISTANT:2}`; `setExtensionPrompt(key,value,position,depth,scan,role,filter)`. A host must implement the whole prompt-assembly + WI scan pipeline for these to mean anything.
6. **Templates/theme.** `renderExtensionTemplateAsync` = Handlebars + DOMPurify + `data-i18n` localization over `/scripts/extensions/<name>/<id>.html`; CSS expects `--SmartTheme*` variables (17 in `style.css`), FontAwesome, `inline-drawer` markup.
7. **`oai_settings`** is a 77-field `structuredClone(default_settings)` object extensions read/write directly. And `SillyTavern.libs` (lodash, DOMPurify, localforage, Handlebars, moment, showdown, Popper, morphdom, chevrotain, gzip/sha256…) is a documented dependency surface.

**Precedent: the only working example is a frontend fork, not a foreign client.** TauriTavern (1776★, AGPL-3.0, active 2026-09-28) does run unmodified third-party extensions, but ships ST's own frontend module graph (`src/scripts/extensions.js`, `st-context.js` 10,967 B vs upstream 10,862 B, plus `script.js`, `slash-commands/`, `openai.js`, `power-user.js`, `world-info.js`, `popup.js`, `templates.js`), documents itself as "基于 SillyTavern 1.18.0", preserves upstream `scripts/extensions.js` call semantics, and reimplements only the *static-asset endpoint* in Rust. It explicitly does **not** support Node-only server plugins. NativeTavern (Dart/Flutter, GPL-3.0, 112★) reimplements ST but lists 扩展 as ⏳ planned. rikkahub-sillytavern-android ships its own QuickJS-sandboxed plugin system unrelated to ST's. Lumiverse "Spindle" extensions are a separate API — ST extensions get *ported*, not run. Risuai and Agnai have no ST-extension path.

**Therefore:** target **data-format interop** (character cards, lorebooks, presets, regex scripts, QR scripts) — what every competitor actually achieves — and treat ST UI extensions as out of scope unless you also ship an ST-compatible DOM + module graph, at which point you have built an ST fork.

## Sources

- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js (manifest load L537-560, activation L577-700, `extension_settings` L141-235, script/style injection L781-845, `loadExtensionSettings` L1783, interceptors L2024)
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/events.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js (`globalThis.SillyTavern` L293, `extension_prompt_types` L484, `getRequestHeaders` L647, `setExtensionPrompt`, `saveSettings` L8051)
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/macros.js (`{{outlet::}}` L668)
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/popup.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/templates.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions-slashcommands.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/src/AutoExecuteHandler.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/src/QuickReply.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/api/QuickReplyApi.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/index.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/manifest.json
- https://github.com/SillyTavern/SillyTavern/blob/release/src/plugin-loader.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/server-main.js (L192 `/csrf-token`, L278 `setupPrivateEndpoints`)
- https://github.com/SillyTavern/SillyTavern/blob/release/src/server-startup.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/extensions.js (`/discover` L480)
- https://github.com/SillyTavern/SillyTavern/blob/release/src/users.js (L1219 third-party static route)
- https://github.com/SillyTavern/SillyTavern/blob/release/src/constants.js (PUBLIC_DIRECTORIES)
- https://github.com/SillyTavern/SillyTavern/blob/release/public/lib.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/index.html
- https://docs.sillytavern.app/for-contributors/writing-extensions/
- https://docs.sillytavern.app/for-contributors/server-plugins/
- https://docs.sillytavern.app/usage/st-script/
- https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- https://github.com/SillyTavern/SillyTavern-Content/blob/main/extensions.json (66 official extensions)
- https://github.com/SillyTavern/SillyTavern-Extras (OBSOLETE, last push 2024-12-10)
- https://github.com/city-unit/st-extension-example
- https://github.com/Darkatse/TauriTavern/blob/main/docs/CurrentState/ThirdPartyExtensions.md
- https://github.com/Darkatse/TauriTavern/blob/main/docs/FrontendGuide.md
- https://github.com/Darkatse/TauriTavern/blob/main/ExtensionDEV.md
- https://github.com/miaoxworld/NativeTavern
- https://github.com/MiaoWuNYA/rikkahub-sillytavern-android
- https://github.com/prolix-oc/Lumiverse
- https://github.com/catofwonders/StructuredPrefillSpindleFork
- Sample extensions analysed (getContext/jQuery/api counts): https://github.com/SpicyMarinara/rpg-companion-sillytavern , https://github.com/mattjaybe/SillyTavern-Pathweaver , https://github.com/mattjaybe/SillyTavern-EchoChamber , https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary , https://github.com/Lodactio/Extension-Summaryception , https://github.com/N0VI028/JS-Slash-Runner , https://github.com/zonde306/ST-Prompt-Template , https://github.com/cierru/st-stepped-thinking
