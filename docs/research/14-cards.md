# Character / lorebook formats and ecosystem interop

Research date 2026-09-29. Everything below is from primary sources (spec text, release-branch source, live
API probes, official docs). `[INFERENCE]` marks anything I reasoned rather than read. Probes of
`api.chub.ai` were made from a real browser origin, because plain `curl` from this host gets
`403 "This request has been blocked."` while the same URLs from a page context return 200.

## (a) Character Card spec v1/v2/v3

**The current spec repo is `kwaroran/character-card-spec-v3`** (112★, MIT, last commit
**2024-07-20**, only files `SPEC_V3.md`, `concepts.md`, `README.md`). It is effectively frozen — 4 open
issues, latest 2026-01-18. `concepts.md` is self-labelled outdated; `SPEC_V3.md` is authoritative.
V2 lives at `malfoyslastname/character-card-spec-v2`. V1 is documented in that repo's `spec_v1.md`.

### V1 (flat, "the format as of May 2023")
```ts
{ name, description, personality, scenario, first_mes, mes_example }  // all strings, default ""
```
`<START>` separates example dialogues. `{{char}}`/`<BOT>` and `{{user}}`/`<USER>` are replaced
case-insensitively in `description`, `personality`, `scenario`, `first_mes`, `mes_example`.

### V2
```ts
{ spec: 'chara_card_v2', spec_version: '2.0', data: { /* all six V1 fields, unchanged names */
  creator_notes, system_prompt, post_history_instructions, alternate_greetings: string[],
  character_book?: CharacterBook, tags: string[], creator, character_version, extensions: {} } }
```
Hard requirements: frontends **MUST** replace the global system prompt with `system_prompt` (empty string
→ fall back to user's), **MUST** support `{{original}}` inside it and in `post_history_instructions`,
**MUST** offer swipes for `alternate_greetings`, **MUST** use `character_book` by default and stack it
over the user world book with character book taking precedence. `extensions` **MUST** default to `{}` and
**MUST NOT** have unknown keys destroyed on round-trip — namespace your keys.

### V3 (superset of V2; "changed or removed" fields only)
```ts
interface CharacterCardV3 { spec: 'chara_card_v3'; spec_version: '3.0'; data: {
  /* V2 fields, minus the CCv2 V1-mirroring set */ 
  creator_notes: string;            // now REQUIRED present; plain string
  nickname?: string;                // used for {{char}}/{{bot}} instead of name
  creator_notes_multilingual?: Record<string /*ISO 639-1*/, string>;
  source?: string[];                // ids/URLs; append-only, SHOULD NOT be user-editable
  group_only_greetings: string[];   // REQUIRED present, may be []
  creation_date?: number;           // unix seconds UTC; 0 = unknown
  modification_date?: number;
  assets?: Array<{ type: string; uri: string; name: string; ext: string }>;
} }
```
Notable V3 semantics: `spec_version` parsed as float for forward-compat (unknown newer version → warn but
still import, fill missing fields with defaults). `assets` default when absent is
`[{type:'icon',uri:'ccdefault:',name:'main',ext:'png'}]`; `uri` may be `ccdefault:`, an https URL, a
base64 data URL, or `embeded://path/to/asset.png` (spec's spelling; note the single `d`). If multiple
`icon` assets exist exactly one **MUST** be `name:"main"`; `background` main is optional; `type` values
`icon|background|user_icon|emotion` are defined and app-specific types **SHOULD** be prefixed `x_`.
`ext` is lowercase without dot. Only `embeded://` and `ccdefault:` are mandatory to support.

Lorebook object (shared by V2 `character_book` and V3): book-level `name`, `description`, `scan_depth`,
`token_budget`, `recursive_scanning`, `extensions`, `entries[]`. Entry: `keys[]`, `content`,
`extensions`, `enabled`, `insertion_order`, `case_sensitive?`, plus V3 additions `use_regex` (required to
implement) and `constant` (optional in V2, required in V3), plus optional `name`, `priority`, `id`,
`comment`, `selective`, `secondary_keys[]`, `position: 'before_char'|'after_char'`. Standalone lorebook
export is `{ spec: 'lorebook_v3', data: Lorebook }`.

V3's real novelty is **decorators**: `@@name value` lines at the top of `content`, stripped before
insertion. Spec-defined set includes `@@activate_only_after N`, `@@activate_only_every N`,
`@@keep_activate_after_match`, `@@dont_activate_after_match`, `@@depth N`, `@@instruct_depth N`,
`@@reverse_depth`, `@@reverse_instruct_depth`, `@@role {assistant|system|user}`, `@@scan_depth`,
`@@instruct_scan_depth`, `@@is_greeting N`, `@@position {before_desc|after_desc|personality|scenario}`,
`@@ignore_on_max_context`, `@@additional_keys a,b`, `@@exclude_keys a,b`, `@@is_user_icon N`,
`@@dont_activate`, `@@activate`, `@@disable_ui_prompt {system_prompt|post_history_instructions}`.
Fallback decorators use `@@@` and are tried top-to-bottom (chains ≥5 recommended). Also standardised CBS
macros: `{{random:a,b}}`, `{{pick:a,b}}`, `{{roll:N}}`/`{{roll:d6}}`, `{{// comment}}`,
`{{hidden_key:a}}`, `{{comment:a}}`, `{{reverse:a}}`. Spec advises an `re2`-class engine for `use_regex`
on a server.

### Embedding
- **PNG/APNG**: JSON → UTF-8 → base64 → PNG `tEXt` chunk. V2 keyword `chara`; V3 keyword **`ccv3`**. If
  both present, `ccv3` wins. ST writes both (see below).
- **JSON**: the object itself. V1 files are the bare flat object; V2/V3 are the wrapper.
- **CHARX** (V3, `.charx`): a ZIP. **`card.json` at the root MUST hold the card.** Assets referenced as
  `embeded://path` (case-sensitive, `/`-separated). Recommended layout
  `assets/{type}/{images|audio|video|l2d|3d|ai|fonts|code|other}/` where `{type}` ∈
  `icon|background|emotion|user_icon|other` (platform types may extend). Extra app data may live as JSON
  at zip root. Zip **SHOULD NOT** be encrypted and **SHOULD** use ASCII-only paths.
- Legacy PNG multi-asset: tEXt keyword `chara-ext-asset_:{path}`, base64 body, addressed as
  `__asset:{path}`. Spec says new apps **SHOULD** avoid it and use CHARX.

### Implementation gotcha (verified in code, not spec)
ST's `src/character-card-parser.js` **writes both** chunks: it strips existing `chara`/`ccv3`, writes
`chara`, then clones the JSON, forces `spec:'chara_card_v3'`/`spec_version:'3.0'` and writes `ccv3`. So
ST's PNG export is a lossy V2→V3 relabel, not a real V3. Read order is `ccv3` → `chara`.

## (b) Lorebook / World Info formats

### SillyTavern standalone world file
Path `data/<user-handle>/worlds/<name>.json`, pretty-printed. Top level: `{ name?, description?,
extensions: {}, entries: { "<uid>": Entry } }`. **`entries` is an object keyed by uid, not an array** —
this is the single biggest divergence from CCv2/V3 `character_book`, where `entries` is an array. ST's
import endpoint only validates `'entries' in worldContent`.

Entry fields (defaults from `newWorldInfoEntryDefinition`, `world-info.js:4070+`):
`key: string[]` (default `[]`), `keysecondary: string[]`, `comment` (title/memo), `content`,
`constant: false`, `vectorized: false`, `selective: true`, `selectiveLogic: 0`, `addMemo: false`,
`order: 100`, `position: 0`, `disable: false`, `ignoreBudget: false`, `excludeRecursion: false`,
`preventRecursion: false`, `matchPersonaDescription|matchCharacterDescription|matchCharacterPersonality|
matchCharacterDepthPrompt|matchScenario|matchCreatorNotes: false`, `delayUntilRecursion: 0`,
`probability: 100`, `useProbability: true`, `depth: 4`, `outletName: ''`, `group: ''`,
`groupOverride: false`, `groupWeight: 100`, `scanDepth: null`, `caseSensitive: null`,
`matchWholeWords: null`, `useGroupScoring: null`, `automationId: ''`, `role: 0`,
`sticky|cooldown|delay: null`, `characterFilterNames[]`, `characterFilterTags[]`,
`characterFilterExclude`, `triggers: string[]`.

Enums (integers on the wire — get these right):
- `position`: `0 before` (↑Char), `1 after` (↓Char), `2 ANTop` (↑AT), `3 ANBottom` (↓AT),
  `4 atDepth` (@D), `5 EMTop` (↑EM), `6 EMBottom` (↓EM), `7 outlet`.
- `selectiveLogic`: `0 AND_ANY`, `1 NOT_ALL`, `2 NOT_ANY`, `3 AND_ALL`.
- `role`: `0 system`, `1 user`, `2 assistant`.
- `world_info_insertion_strategy`: `0 evenly` (default), `1 character_first`, `2 global_first`.
- `MAX_SCAN_DEPTH = 1000`, `DEFAULT_DEPTH = 4`, `DEFAULT_WEIGHT = 100`.

Matching behaviour worth reimplementing: keys are literal-substring matches unless a key is a valid
JS regex literal `/…/flags`; `matchWholeWords` splits the key on whitespace and requires every word present;
case-insensitive by default. ST prefixes each scanned message with `charactername:` and, since v1.12.6,
prepends `\x01`, so `/^\x01{{user}}:/` style regexes can target a speaker. `order` sorts ascending and
entries are `unshift`ed into their bucket, so **higher `order` lands later in the prompt**; `probability`
is a 0–100 pass/fail roll applied after activation and skipped for sticky entries; recursion runs until
`world_info_max_recursion_steps` or the token budget overflows; `token_budget` evicts lowest-priority
first. Inclusion groups pick one entry per group by `groupWeight` roll unless `groupOverride` (then highest
`order` wins); with `useGroupScoring` the highest key-match count wins first. Insertion order of sources is
chat lore → persona lore → (character lore, global lore) under the chosen strategy.

**Conversion between the two dialects is the core interop chore.** `convertCharacterBook()` maps
`keys→key`, `secondary_keys→keysecondary`, `insertion_order→order`, `enabled→!disable`, and reads
ST-specific fields out of each entry's `extensions` (`extensions.position` overrides
`position: before_char/after_char`; also `depth`, `probability`, `useProbability`, `selectiveLogic`,
`group`, `group_weight`, `scan_depth`, `case_sensitive`, `match_whole_words`, `automation_id`,
`vectorized`, `sticky`, `cooldown`, `delay`, `triggers`, `ignore_budget`). Going the other way,
`convertWorldInfoToCharacterBook` writes spec field names at the top level and stashes the ST extras in
`extensions`. Character-embedded books carry a *linked world name* in `data.extensions.world` (a string,
not the book itself) — do not confuse the two.

### Risu / Agnai / Chub variants
- **RisuAI native** `loreBook`: `{ key: string, secondkey: string, insertorder, comment, content,
  mode: 'multiple'|'constant'|'normal'|'child'|'folder', alwaysActive, selective,
  extentions?: { risu_case_sensitive }, activationPercent?, loreCache?, useRegex?, bookVersion?, id?,
  folder? }`. Keys are **comma-joined strings**, not arrays. Native export envelope is
  `{ type: 'risu', data: loreBook[] }`. In CCv3 output Risu adds non-spec `mode`/`folder` per entry and
  keeps `risu_case_sensitive`/`risu_activationPercent` in `extensions`.
- **Agnai** memory book is a *different* shape from ST's: `{ kind: 'memory', name, description, entries:
  [{ name, keywords, entry, priority, weight, enabled }] }` (per Hoplight's adapter docs; `characterBook`
  is embedded in the character JSON). Agnai's `CharacterBook` type in `common/memory.ts` is byte-identical
  to the CCv2 definition, and `common/characters.ts` converts native ⇄ character book via
  `nativeToCharacterBook`/`characterBookToNative`.
- **Chub** serves lorebooks as an ST-format world file. ST fetches metadata from
  `https://api.chub.ai/api/lorebooks/<creator>/<slug>` to get `node.id`, then downloads
  `https://api.chub.ai/api/v4/projects/<id>/repository/files/raw%252Fsillytavern_raw.json/raw`
  (note the double-encoded `%252F`). Verified live: the V4 git-file route works unauthenticated for a
  public project and returns the raw card JSON.

## (c) Hub APIs

### chub.ai
`https://api.chub.ai/openapi.json` is a full **OpenAPI 3.1** doc (197 paths, 553 KB) — fetch it from a
browser context, not curl. `info`: *"Commercial use requires prior authorization."*,
`termsOfService: https://chub.ai/tos`, contact `lore@chub.ai`. Security schemes (all `apiKey` in header):
**`CH-API-KEY`**, `Authorization`, `samwise`. There is no `servers` entry and **no documented rate
limits** (no `429` in the spec; no `ratelimit-*` response headers observed).

Confirmed-live, unauthenticated, from a browser origin:
- `GET /api/characters/{creator}/{slug}?full=true` → `{ errors, node }`. `node` keys include `id, name,
  fullPath, description, starCount, topics, forksCount, rating, ratingCount, nTokens, tagline,
  primaryFormat, related_characters, related_lorebooks, related_prompts, related_extensions, hasGallery,
  nChats, nMessages, definition, permissions, is_public, nsfw_image, n_public_chats, n_favorites,
  is_unlisted, avatar_url, max_res_url, bound_preset, project_uuid, voice_id, verified, recommended,
  lang_id, badges`. `definition` keys: `name, description (→creator_notes), example_dialogs (→mes_example),
  first_message, personality (→description), scenario, system_prompt, post_history_instructions,
  tavern_personality, alternate_greetings, embedded_lorebook, extensions, voice_id, voice`.
  **NSFW cards are returned to an anonymous caller** — no token needed to read, only to write/see private.
- `GET /search?search=&first=&page=&sort=&nsfw=&topics=` → `{ data: { count, nodes[], page, cursor,
  previous_cursor } }`. Sort values seen in the wild: `star_count, download_count, trending_downloads,
  created_at, last_activity_at`. A large boolean query grammar exists (`nsfl, nsfw_only, require_images,
  require_example_dialogues, require_alternate_greetings, require_lore_embedded, require_lore_linked,
  require_expressions, min_tokens, include_forks, inclusive_or, mine_first, exclude_mine, asc`).
- `POST /tags` (body `{}`) → `{ count, tags: [{id,name,title,non_private_projects_count,followers_count,
  is_event_tag,is_nsfw,is_nsfl}] }`.
- `GET /api/v4/projects/{id}/repository/commits` → refs; `…/files/raw%252Fcard.json/raw?ref=<sha>` →
  raw card. `GET /api/gallery/project/{id}` → gallery image nodes with `primary_image_path`.
- `GET /api/characters/{project_id}/expressions` → `ExpressionsMeta`
  `{ expressions: {version, compressed (zip URL), expressions: {label: httpsUrl}}, alt_expressions }`.
  The *unauthenticated* `?full=true` payload already embeds this under
  `definition.extensions.chub.expressions.expressions` as a label→URL map, so expression packs are
  reachable without credentials.
- `POST /api/characters/download` (the endpoint ST's docs/blogs still cite) now returns **405** from a
  browser origin; `GET` on that path returns a FastAPI 422 for `project_id`. **Do not build on it.**
- Avatar/image hosts: `https://avatars.charhub.io/avatars/{fullPath}/avatar.webp` and
  `…/{fullPath}/chara_card_v2.png`; `max_res_url` in the payload points at the full-resolution card image.
  `avatars.charhub.io` is a separate CDN from `api.chub.ai`.
- Third-party access is *tolerated and technically enabled*: `api.chub.ai` returns
  `Access-Control-Allow-Origin: *` and the OpenAPI `access-control-allow-headers` list explicitly includes
  `ch-api-key, private-token, samwise`. Client key is obtained from DevTools: log in, find a request to
  `ro.chub.ai`, copy the `Ch-Api-Key` request header; some tools instead read `URQL_TOKEN` from
  `localStorage`. `[INFERENCE]` This is undocumented and can break without notice.

**ToS (fetched live from the SPA; "Last updated May 15th, 2026")** — the clauses that matter for a client:
- "Except as set out in this section … no part of the Services and no Content or Marks may be copied,
  reproduced, aggregated, republished, uploaded, posted, publicly displayed, encoded, translated,
  transmitted, distributed, sold, licensed, or otherwise exploited for any commercial purpose whatsoever,
  without our express prior written permission."
- Commercial Use section: "By downloading a file or image or copying other user-generated content (UGC)
  from CharHub, you agree that you do not claim any rights to it. You may use UGC for personal,
  non-commercial purposes." Attribution ("Chub" / "courtesy of Chub") is asked for fair-use re-display.
  Requests for other use go to `lore@chub.ai`. This matches the OpenAPI `info` line exactly.
- Public cards carry "a perpetual, irrevocable, worldwide, royalty-free, non-exclusive license" to other
  users to use/display/redistribute them **through the Services**; private content is not distributed to
  third parties. **API-inference calls made outside the Chub UI are explicitly not logged** (only a
  unique id, user id, time, input/output length, model, approximate charge, latency).
- 18+ only. Hard ban on sexualised or photorealistic minors in images and text, plus revenge porn.
- Practical read: **personal, non-commercial import of cards into a BYOK client is squarely inside the
  licence; a hosted or monetised client is not, without written permission.** Cache aggressively, send a
  real `User-Agent`, keep per-key request volume low, and give users a way to supply their own key.

### JanitorAI
No public API. `https://janitorai.com` and `api.jannyai.com` are behind Cloudflare Bot Fight Mode (403 to
this host and to datacentre IPs generally — ST's own source carries a comment that hosted ST on
Azure/AWS/GCP "might get blocked"). ST's legacy path was `POST https://api.jannyai.com/api/v1/download`
with `{"characterId": <uuid>}` returning `{status:'ok', downloadUrl}`. There is **no documented
import/export**; everything is community browser tooling: `erpocalypse/jai-card-extractor` (MIT, pushed
2026-07-20) exports `.card.json` (SillyTavern V2), `.lorebook.json`, `.txt`, `.jai.json`; `itsfantomas/
janitor-exporter` (MIT, 18★) exports Tavern **V1** PNG; `unorouter/janitorai-full-export` (MIT, pushed
2026-09-02). The extractor's README states plainly that JanitorAI's terms "may restrict automated access
or bulk downloading" and frames itself as a personal-backup tool. **Treat JanitorAI as import-only, via a
user-pasted file or URL, never a server-side scraper.**

### Pygmalion / legacy
Classic flat shape, still what a lot of old PNGs contain:
`{ char_name, char_persona, char_greeting, world_scenario, example_dialogue }`, carried as bare `.json`
or in a PNG `chara` chunk. Pygmalion.chat's API was
`https://server.pygmalion.chat/api/export/character/<uuid>/v2` → `{character: <V2 card>}` (ST still codes
against it). Detection must be negative-first: reject `spec`/`data`, `schemaVersion`/`body`,
`kind === "character"`, `aiName`/`aiPersona`, then require ≥2 of `char_persona`/`char_greeting`/
`world_scenario` (or `char_name`+`char_persona`).

### Others (one line each)
- **RisuAI**: `.charx` (V3) is native; also `.risum` modules and `.png`/`.jpg` carriers. Realm hub at
  `https://realm.risuai.net` / `sv.risuai.xyz`. Latest release v2026.8.250.
- **Agnai (Agnaistic)**: own JSON `{kind:'character', persona, greeting, …}` plus a memory-book lorebook;
  exports/imports CCv2 via `common/characters.ts`. Pulls from chub via `POST {api.chub.ai}/characters/download`
  with `{format:'tavern', fullPath, version:'main'}` (a third path, separate from ST's).
- **Backyard AI / Faraday**: legacy flat `{aiName, aiPersona, aiDisplayName, customDialogue}` JSON, and
  modern `.byaf` ZIP (`manifest.json` + `characters/<id>/character.json` + `scenarios/*.json` + images).
  ST imports `.byaf` natively (`src/byaf.js`) and maps it to a V2 card with `extensions.display_name`.
- **Character.AI**: no official export. Dumps are third-party HTML scrapes; nothing to implement.
- **Libraries**: `@risuai/ccardlib` (MIT, npm, v0.4.2, **last publish 2024-06-14**, repo
  `kwaroran/ccardlib` 8★) is the only maintained-ish CCv3 type/parse library. `kwaroran/character-card-spec-v3`
  ships no code. `BasedInn/Unified-CharacterCard-Specification` (MIT, 2026-01-26) is a useful
  consolidated read-only reference but is explicitly downstream and non-authoritative.

## (d) Local storage, assets, and safety metadata

### SillyTavern layout (`data/<user-handle>/…`, `src/constants.js`)
`characters/` (one `<Name>.png` per card — **the card JSON lives in the PNG tEXt chunk; there is no sidecar
JSON**; `thumbnails/{avatar,bg,persona}/`), `worlds/<name>.json`, `chats/<char>/<chat>.jsonl`, `groups/`,
`group chats/`, `user/` (settings.json, `user/images/`, `user/files/`), `User Avatars/`, `backgrounds/`,
`themes/`, `extensions/`, `QuickReplies/`, `assets/`, `vectors/`, plus per-API preset folders
(`OpenAI Settings/`, `TextGen Settings/`, …). **Nothing is in SQLite** — no sqlite/sequelize/knex anywhere
in the release tree. There is a disk *cache* (`diskCache`/`memoryCache` in `src/endpoints/characters.js`)
but it is a derived index, not the store. Note ST injects transient, non-spec fields into the card object
it hands the UI: `json_data` (the raw chunk string), `avatar`, `chat`, `create_date`, `date_added`,
`chat_size`, `data_size`, `date_last_chat` — strip these on export (`unsetPrivateFields`).

Chats are **JSONL**: line 1 is a header object carrying `chat_metadata`, `user_name`, `character_name`
(values literally `'unused'`); every later line is one message (`name`, `is_user`, `send_date`, `mes`,
`swipes`, `extra`). Reading the file's last line gives the preview; a corrupt last line degrades the
preview rather than hiding the chat. Importers exist for Ooba's format and for JSONL.

Character sprites/expressions: `characters/<CharacterName>/` (or `characters/<Name>/<subfolder>/`), one
image per expression, filename = label. **The folder is the character's display name**, not the PNG
filename. ST's own regex is `/^(.+?)(?:[-\.].*?)?$/` on the lowercased basename, so `joy.png`, `joy-1.png`,
`joy.expressive.png` all yield label `joy` — **use `-` or `.` for variants, never `_`**. Any `image/*`
format is accepted (webp, animated gif included). Expression classification modes
(`EXPRESSION_API`): `local` (ST's own classifier, `POST /api/extra/classify`, model
`Cohee/distilbert-base-uncased-go-emotions-onnx`), `extras` (`POST /api/classify` to the Extras API —
deprecated), `llm` (`generateRaw({prompt,systemPrompt})` for `promptType:'raw'` or
`generateQuietPrompt({quietPrompt})` for `'full'`, JSON-schema enum of labels when supported, then a `Fuse`
fuzzy match), `webllm` (`generateWebLlmChatPrompt`), `none`. Settings live in
`extension_settings.expressions = { api, custom[], showDefault, translate, filterAvailable,
fallback_expression, llmPrompt, allowMultiple, rerollIfSame, promptType: 'raw'|'full' }` plus a separate
`extension_settings.expressionOverrides = [{name, path}]` (avatar basename → sprite folder) that lets a
character point at a different sprite folder; `/costume <name>` and `/setspritefolder` drive it. Default
label set is the 28 GoEmotions-style labels (`admiration, amusement, anger, annoyance, approval, caring,
confusion, curiosity, desire, disappointment, disapproval, disgust, embarrassment, excitement, fear,
gratitude, grief, joy, love, nervousness, optimism, pride, realization, relief, remorse, sadness, surprise,
neutral`), shipped as `public/img/default-expressions/*.png`; default fallback is `joy`; the built-in
classifier prompt is *"Ignore previous instructions. Classify the emotion of the last message. Output just
one word, e.g. "joy" or "anger". Choose only one of the following labels: {{labels}}"*. Fallback sentinels
`#none` and `#emoji` (the latter renders the default emoji sprite). Docs live at
`https://docs.sillytavern.app/extensions/expression-images/` (the `/extensions/expressions/` path 404s).

CHARX import maps assets by `type`: `emotion|expression` → sprites dir; `background` →
`characters/<Name>/backgrounds/`; everything else → `user/images/<Name>/`; `icon`/`user_icon` are excluded
from auxiliary storage. Accepted `uri` prefixes are `embeded://`, **`embedded://`** and `__asset:` — ST
deliberately accepts the Risu misspelling. Risu's own `.charx` writer additionally emits
`x_meta/<name>.json` sidecars (PNG tEXt chunks as JSON, or `{type: 'PNG'}`) and a `module.risum` member.

### Other clients
RisuAI stores everything in a client-side database (`src/ts/storage/database.svelte.ts`, ~80 KB) with
localStorage/OPFS/Tauri-fs backends and an optional remote save of encrypted `remotes/<name>.local.bin`
blocks. Agnai is server-side. **A new app is free to use SQLite (or anything) as long as it round-trips
the file formats** — no ecosystem consumer reads another app's private store.

### Avatars, sprites, Live2D, VRM, "character sheets"
- Avatar = the card PNG itself in ST (so card and portrait are one file, and `writeCharacterData` re-encodes
  and resizes it to 512×768 on save). CCv3 decouples this via `assets[type=icon]`; chub decouples it via
  `avatar_url` (`…/avatar.webp`) and `max_res_url` (`…/chara_card_v2.png`) on `avatars.charhub.io`.
- **Live2D is not in ST core** — it is `SillyTavern/Extension-Live2D` (GPL-3.0, 89★, **last push
  2024-06-28, stale**). Models live in `assets/live2d/<modelFolder>/` or `characters/<char>/live2d/<model>/`;
  detection is any file whose name contains `model` and ends `.json` (i.e. `*.model3.json`) with `.moc3` +
  textures alongside; mapping is `extension_settings.live2d.characterModelMapping`; runtime is
  `pixi.min.js` + `pixi-live2d-display` + `live2dcubismcore.min.js`. **RisuAI has no Live2D at all.**
  CCv3 assigns the packaging role to CHARX `assets/{type}/l2d/`, but ST's own CharX importer ignores it
  (`CHARX_IMAGE_EXTENSIONS` in `src/charx.js` is images only).
  **Licensing is the real blocker, not the code.** The SDK is free to develop with, but the
  "Expandable Applications" clause explicitly covers works that load "any indefinite numbers of models by
  adding or combining files or data (e.g. avatar)" — i.e. exactly a client that loads user-supplied
  models. That requires review and a special Publication License *regardless of company size*, with a
  royalty of ¥300/sale or 20% of sales (5% for mid/large). A hobby project with user-loaded models is
  arguably already in scope. **Recommendation: ship sprite/expression packs first; treat Live2D as a
  later, deliberately-licensed feature.**
- **VRM/3D** does have a real ST extension: `SillyTavern/Extension-VRM` (GPL-3.0, 65★, pushed
  2026-01-20), `.vrm` in `assets/vrm/model` and animations in `assets/vrm/animation` (`.fbx`, `.bvh`,
  `.vrma`) via `@pixiv/three-vrm`; ST's `src/endpoints/assets.js` already lists `vrm` in
  `VALID_CATEGORIES`. Models are 10s–100s of MB and need three.js — list as optional.
- "Character sheet" has **no standard**. It means one of three things in practice: (1) a styled HTML/JS
  panel rendered over chat — Risu `extensions.risuai.backgroundHTML` and `x-risu-asset` inlays, or ST
  extensions like `SpicyMarinara/rpg-companion-sillytavern` (316★); (2) chub **Stages** — a sandboxed
  React app (`chub_meta.yaml` + a `StageBase` implementation) with `load/beforePrompt/afterResponse/
  setState/render` hooks and an unstable bottom-up `generator.makeImage/imageToImage/removeBackground/
  inpaintImage`; (3) a structured persona block in a community syntax *inside* `data.description` — W++
  (`[character("Name"){…}]`), PList, or Ali:Chat — rendered by tools such as `easychen/airole` (127★) or
  `lenML/CCEditor` (42★). **Design your own sheet format; there is nothing to be compatible with.** The
  nearest thing to a schema in the ecosystem is Agnai's
  `persona: {kind:'attributes', attributes:{species:['robot'], personality:[…]}}`.
- **Safety/NSFW metadata**: the spec has *none* — CCv2/V3 carry only `tags: string[]` and
  `extensions`. Everything else is de-facto and each site invents its own. Verified against live chub
  payloads: chub's content rating is a literal **`"NSFW"` token inside the `topics` array** (not a
  dedicated field), while **`nsfw_image: boolean` is image-only and NOT a content rating** — a card can
  have `nsfw_image:false` with NSFW in `topics` and vice versa. `rating`/`ratingCount` on a chub node are
  1–5-star *user* ratings, not content ratings. Project-level flags are `is_nsfw`, `is_nsfl`, `is_public`,
  `is_unlisted`, `is_anonymous` (per the OpenAPI `CharacterCreate`/`LorebookCreate` schemas). Backyard's
  `.byaf` has a real boolean `isNSFW` (ST imports it as `tags:['nsfw']`). RisuAI has `license` and
  `private`. ST has no NSFW field at all — only the `tags` array plus the user's own `settings.json`
  `tags`/`tag_map`. Hoplight's canonical model adds `rating: 'all-ages'|'mature'|'explicit'`.
  **Recommendation: store your own `rating` + `contentWarnings[]` + `tags[]` in your DB, mirror `tags`
  into the card on export, and namespace anything else under `extensions.<yourapp>` so other clients
  preserve it untouched.**
- **chub's in-card hook** is `data.extensions.chub = {id, full_path, preset, custom_css, expressions,
  alt_expressions, background_image, related_lorebooks}`; `expressions`/`alt_expressions` is the
  sprite-pack map. There is also a `labels: [{title:'TOKEN_COUNTS', description:'<json>'}]` array on the
  node carrying chub's own token accounting.

### File types to accept, and lossiness
ST's server accepts exactly six (`src/endpoints/characters.js` `formatImportFunctions`): **`yaml`, `yml`,
`json`, `png`, `charx`, `byaf`**; the client gates on the same list. ST **exports only `png` and `json`,
and its JSON export is always CCv2** — V3-only fields (`nickname`, `assets`, `source`,
`creator_notes_multilingual`, `group_only_greetings`, `creation_date`, `modification_date`) are dropped.

| Input | Meaning | Notes |
|---|---|---|
| `.png` | tEXt `chara` (b64 V2) and/or `ccv3` (b64 V3) | lossless carrier; `ccv3` wins. ST's write path re-encodes/resizes the image to 512×768 and strips `chat` |
| `.json` | V1 flat, V2 (`spec:'chara_card_v2'`), V3 (`spec:'chara_card_v3'`), or `{spec:'lorebook_v3',…}` | sniff, don't trust extension |
| `.charx` | ZIP, root `card.json` (MUST), assets under `assets/{type}/{images\|audio\|video\|l2d\|3d\|ai\|fonts\|code\|other}/`, `embeded://` URIs (misspelling normative; ST also accepts `embedded://` and `__asset:`) | the only lossless multi-asset container. ST persists **images only** and silently drops audio/video/l2d/3d/fonts/code |
| `.byaf` | Backyard Archive ZIP: `manifest.json` + `characters/<id>/character.json` + `scenarios/*.json` + images; has a real `isNSFW` | very lossy → flattened to V2 |
| `.risum` | RisuAI *legacy module* binary, not a card: byte `111` (0x6F), version byte, u32LE length, RPack'd `{module, type:'risuModule'}`, then asset blocks (`1` + u32LE len + RPack'd bytes) until `0` | scripts/code are non-portable. Risu's *current* module export is `.module`, which is a `.charx` |
| `.yaml`/`.yml` | ST-only minimal: `name`, `context` → description, `greeting` → first_mes | rare, lossy |
| `.webp` | **not** a card container in ST; chub's avatar format (`avatar.webp`), fine as sprite/gallery imagery | n/a |
| `.json` (world) | ST world info, `entries` as an object keyed by uid | |
| `.jsonl` | ST chat log; ST also imports Ooba, Agnai, CAI Tools, Kobold Lite, Chub Chat and Risu chats | |
| `.json` (preset) | API presets, Quick Replies, regex script sets | |
| `.charxJpeg` / `.jpeg` | RisuAI: JPEG with an embedded CCv3 card | niche |

Cross-app conversion is inherently lossy: V2 export drops `nickname`, `assets`, `source`,
`creator_notes_multilingual`, `group_only_greetings`, and **all decorators** (spec: "On backfilling V2, the
application *SHOULD* remove all decorators"). Preserve unknown keys in `extensions` on every round-trip or
you will silently corrupt other people's cards.

## (e) SillyTavern extension API — reuse feasibility

Pinned to `release` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (2026-09-14, tag **1.19.0**).

**Manifest** (`manifest.json` per extension folder): `display_name` (req), `js` (req), `css`, `author`
(req), `version`, `homePage`, `loading_order` (higher = later), `auto_update`,
`minimum_client_version`, `i18n: {locale: path}`, `generate_interceptor` (name of a global fn called on
generation), `dependencies[]` (**other extensions**, by folder name, incl. `third-party/X`),
`hooks: {install,update,delete,clean,enable,disable,activate}` naming exported functions (each awaited with
a 5 s timeout). `requires[]`/`optional[]` are **deprecated** — they pointed at the Extras API, which is
`[OBSOLETE]` (last push 2024-12-10).

Discovery is **server-side**: `GET /api/extensions/discover` scans three directories and returns
`{type, name}` with `type ∈ system|local|global`. `system` = `public/scripts/extensions/<folder>` (15
built-ins: regex, quick-reply, vectors, tts, caption, expressions, gallery, memory, translate,
token-counter, …); `local` = `data/<handle>/extensions/<folder>`; `global` =
`public/scripts/extensions/third-party/<folder>` — the latter two both surface as `third-party/<folder>`,
local winning on collision. Folders without a `manifest.json` are skipped. Activation fetches each
manifest, sorts by `loading_order` then `display_name`, checks `minimum_client_version` and `dependencies`
(against `extension_settings.disabledExtensions`), injects JS/CSS, then runs the `activate` hook.
**There is no `registerExtension()`** — I checked both `release` and `staging`; the only repo-wide hit is
the internal `registerExtensionSlashCommands`. Registration *is* `hooks.activate` + `eventSource.on(APP_READY)`.

**`SillyTavern.getContext()`** (defined in `public/scripts/st-context.js`) is the stable surface and is
large — roughly: `accountStorage, chat, characters, groups, name1, name2, characterId, groupId, chatId,
getCurrentChatId, getRequestHeaders, reloadCurrentChat, renameChat, saveSettingsDebounced, onlineStatus,
maxContext, chatMetadata, saveMetadataDebounced, streamingProcessor, eventSource, eventTypes, addOneMessage,
deleteLastMessage, deleteMessage, generate, sendStreamingRequest, sendGenerationRequest, stopGeneration,
tokenizers, getTextTokens, getTokenCount, getTokenCountAsync, extensionPrompts, setExtensionPrompt,
updateChatMetadata, saveChat, openCharacterChat, openGroupChat, saveMetadata, sendSystemMessage,
activate/deactivateSendButtons, saveReply, substituteParams, substituteParamsExtended, SlashCommandParser,
SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandEnumValue, ARGUMENT_TYPE,
executeSlashCommandsWithOptions, registerSlashCommand, timestampToMoment, registerHelper, registerMacro,
unregisterMacro, registerFunctionTool, unregisterFunctionTool, isToolCallingSupported, canPerformToolCalls,
ToolManager, registerDebugFunction, renderExtensionTemplate(Async), registerDataBankScraper, callPopup,
callGenericPopup, showLoader, hideLoader, mainApi, extensionSettings, ModuleWorkerWrapper,
getTokenizerModel, generateQuietPrompt, generateRaw, generateRawData, writeExtensionField(Bulk),
getThumbnailUrl, selectCharacterById, messageFormatting, shouldSendOnEnter, isMobile, t, translate,
getCurrentLocale, addLocaleData, tags, tagMap, menuType, createCharacterData, Popup, POPUP_TYPE,
POPUP_RESULT, chatCompletionSettings, textCompletionSettings, powerUserSettings, getCharacters,
getOneCharacter, getCharacterCardFields, getCharacterSource, importFromExternalUrl, importTags, uuidv4,
humanizedDateTime, updateMessageBlock, appendMediaToMessage, scrollChatToBottom, macros, messageFormatter,
loader, swipe{left,right,to,show,hide,refresh,isAllowed,state}, variables{local,global}.{get,set,del,add,
inc,dec,has}, loadWorldInfo, saveWorldInfo, reloadWorldInfoEditor, updateWorldInfoList, convertCharacterBook,
getWorldInfoPrompt, getWorldInfoNames, CONNECT_API_MAP, getTextGenServer, extractMessageFromData,
getPresetManager, getChatCompletionModel, printMessages, clearChat, ChatCompletionService,
TextCompletionService, ConnectionManagerRequestService, updateReasoningUI, parseReasoningFromString,
getReasoningTemplateByName, unshallowCharacter, unshallowGroupMembers, getExtensionManifest,
openThirdPartyExtensionMenu, symbols.ignore, constants.unset`. Many entries are marked `@deprecated` in
source but retained. `SillyTavern.libs` additionally exposes lodash, Fuse, DOMPurify, hljs, localforage,
Handlebars, css, Bowser, DiffMatchPatch, Readability, SVGInject, showdown, moment, seedrandom, Popper,
droll, morphdom, slideToggle, chalk, yaml, chevrotain, fflate.

**Events** (`public/scripts/events.js`, `event_types`) — **104 keys / 103 distinct strings**; the ones
extensions actually hook: `app_initialized, app_ready` (both auto-fire to late listeners via
`EventEmitter(..., [APP_READY, APP_INITIALIZED])`), `extensions_first_load, extension_settings_loaded,
settings_loaded(_before/_after), message_sent, message_received, message_swiped, message_edited,
message_deleted, message_updated, chat_id_changed, chatLoaded, chat_created/renamed/deleted,
generation_started/stopped/ended, GENERATION_AFTER_COMMANDS, generate_before_combine_prompts,
generate_after_combine_prompts, generate_after_data, stream_token_received, stream_reasoning_done,
worldinfo_updated, world_info_activated, worldinfo_entries_loaded, worldinfo_scan_done,
worldinfo_force_activate, character_page_loaded, character_edited, character_renamed, group_updated,
group_member_drafted, group_wrapper_started/finished, persona_*, user_message_rendered,
character_message_rendered, character_first_message_selected, main_api_changed,
chatcompletion_source_changed, chatcompletion_model_changed, connection_profile_*, tool_calls_performed/
rendered, tts_job_started/audio_ready/complete, itemized_prompts_*, secret_written/deleted/rotated/edited,
image_swiped`. Payload shapes are explicitly **non-uniform** across events. (There is no
`extension_prompt_ready` and no `character_selected` event.)

**STscript + Quick Replies**: slash commands are `/name arg named=value | /next` — `|`-separated batches
with a pipe value, so `/pass Hello | /echo` ≡ `/echo Hello`; `/help slash` lists commands. Extensions
register via `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))`. Quick Replies ship an
auto-execution engine with per-QR boolean triggers `executeOnStartup`, `executeOnUser`, `executeOnAi`,
`executeOnChatChange`, `executeOnNewChat`, `executeBeforeGeneration`, plus `preventAutoExecute` and
`automationId`. `AutoExecuteHandler.handleWIActivation(entries)` collects
`entries.map(e => e.automationId)` and runs every QR whose `automationId` matches — that is the World
Info ↔ Quick Reply link; it fires once even if several entries share the ID. QR also exposes a global
`quickReplyApi` (`listSets/listQuickReplies/listAutomationIds/createQuickReply/…`) and slash commands
`/qr`, `/qr-create`, `/qr-set`, `/qr-set-on|off`, `/qr-chat-set`, `/qr-get`, `/qr-contextadd`. The
`{{outlet::Name}}` macro (`public/scripts/macros.js` L668, `getOutletPrompt(key)`) reads
`extension_prompts[CUSTOM_WI_OUTLET(key)].value`; WI entries with the Outlet position are stored at
`extension_prompt_types.NONE` (`-1`) and materialised wherever the macro appears. Case-sensitive, no
nesting.

**Server plugins** are a separate mechanism: files/dirs under `plugins/`, loaded only when
`enableServerPlugins: true` (default **false**), exporting `init(router)`/`exit()`/`info{id,name,description}`,
mounted at `/api/plugins/{id}/{route}` (id must match `/^[a-z0-9_-]+$/`). Not sandboxed. Only 6 official
plugins exist. ST's own extension endpoint (`src/endpoints/extensions.js`) does install/update/branches/
switch/move/version/delete/discover over git.

**Verdict: reusing the ST extension ecosystem from a non-fork client is NOT realistic, but the resource
contract is portable.** Seven verified blockers, each read out of source:

1. **jQuery + ST's DOM ids.** Extensions append into `#extensions_settings` / `#extensions_settings2` /
   `#extensionsMenu` and bind to `#send_textarea`, `#send_but`, `.mes`, `#rightNavHolder`, `#top-bar`.
   jQuery 3.5.1 + jQuery-UI are plain `<script>` tags in `index.html` (~L8201–8213), not in `libs`.
   Measured across 8 popular extensions: jQuery `$()` in 6/8 (301 calls in rpg-companion, 216 in
   JS-Slash-Runner).
2. **`getContext()` is object-identity-bound.** `chat`, `characters`, `chatMetadata`, `extensionPrompts`
   are live mutable references into ST's own module state; `chatMetadata`'s reference even changes on chat
   switch. Reproducing the names without the objects is worthless.
3. **The server surface.** ~45 Express routers mounted in `setupPrivateEndpoints` (`/api/characters`,
   `/api/chats`, `/api/worldinfo`, `/api/settings`, `/api/backends/chat-completions`, `/api/tokenizers`,
   `/api/extensions`, `/api/secrets`, …); 5/8 sampled extensions call `/api/*` directly. Plus CSRF:
   `getRequestHeaders()` returns `{'Content-Type','X-CSRF-Token'}`, token from `GET /csrf-token`, injected
   into every jQuery request by a global `$.ajaxPrefilter`.
4. **Persistence.** `extensionSettings` round-trips through `POST /api/settings/save` as the whole
   `settings.json` payload (incl. `power_user`, `oai_settings`, `textgenerationwebui_settings`). There is
   no per-extension store.
5. **Prompt plumbing.** `extension_prompt_types = {NONE:-1, IN_PROMPT:0, IN_CHAT:1, BEFORE_PROMPT:2}` and
   `extension_prompt_roles = {SYSTEM:0, USER:1, ASSISTANT:2}`; `setExtensionPrompt(key,value,position,
   depth,scan,role,filter)`. A host must implement the entire prompt-assembly + WI-scan pipeline for these
   to mean anything.
6. **Templates and theme.** `renderExtensionTemplateAsync` = Handlebars + DOMPurify + `data-i18n` over
   `/scripts/extensions/<name>/<id>.html`; extension CSS expects 17 `--SmartTheme*` variables, FontAwesome
   and `inline-drawer` markup.
7. **`oai_settings`** is a 77-field `structuredClone(default_settings)` object extensions read *and write*
   directly, and `SillyTavern.libs` is a documented dependency surface.

The only working precedent is **`Darkatse/TauriTavern`** (1,776★, AGPL-3.0, active 2026-09-28) — and note
what it actually did: it **kept ST's entire frontend** (its tree contains `src/scripts/st-context.js`,
`extensions.js`, `events.js`, `world-info.js`, `openai.js`, `power-user.js`, `popup.js`, `templates.js`,
the same built-in extension folders; its `st-context.js` is 10,967 B vs upstream 10,862 B) and
re-implemented only the *host* in Rust/Tauri, providing real HTTP endpoints for
`/scripts/extensions/third-party/*`, `/characters/*`, `/thumbnail`, `/User Avatars/*`, `/backgrounds/*`,
`/assets/*`, `/user/images/*`, `/user/files/*`, `/css/user.css`, plus a native-git installer and a
`window.__TAURITAVERN__.api.extension.store` KV/Blob API. Its own compat doc states the key insight:
compatibility comes from "making the third-party resource paths real endpoints the WebView can natively
load," not from interpreting extension code. It explicitly does **not** support ST's Node-only server
plugins, and it pins `window._` (lodash) as a formal ABI because extensions like JS-Slash-Runner and
ST-Prompt-Template touch it during module evaluation. Other data points: `miaoxworld/NativeTavern`
(Dart/Flutter, GPL-3.0, 112★) reimplements ST but lists extensions as *planned*;
`rikkahub-sillytavern-android` ships its own unrelated QuickJS plugin system; Lumiverse "Spindle"
extensions are a separate API and ST extensions get **ported** to it, not run; RisuAI and Agnai have no
ST-extension path at all.

Practical consequence for this project: **do not plan on running unmodified ST extensions.** Instead,
(a) implement the *data* contract exactly (cards, world info JSON, chat JSONL, regex script sets, Quick
Reply sets, presets) so users can import/export between the two; (b) implement STscript-compatible slash
commands, WI `automationId` → command automation, and the `{{outlet::}}` macro natively, since those are
the extension features users miss most; (c) if extension compatibility ever becomes a hard requirement,
the only proven path is shipping ST's frontend wholesale — which is an AGPL-3.0 obligation you should
decide about deliberately, before writing your own UI.

## Interop plan (implementation order)
1. **Reader first, lossless always.** Parse PNG (`ccv3`→`chara`), JSON (V1/V2/V3 by shape), CHARX, and
   world-info JSON. Keep the original bytes/JSON verbatim in a side table; never re-serialize a card you
   did not edit. This one rule prevents most interop bugs.
2. **Normalise to one internal `Character`/`Lorebook` model**, with an explicit `extensions` bag
   preserved opaquely, and a `source`/`importedFrom` field.
3. **Sniff by content, not extension.** Order: CHARX (`PK` + root `card.json`) → V3 (`spec==='chara_card_v3'`)
   → V2 (`spec==='chara_card_v2'`) → world info (`entries` object) → Risu lore (`type==='risu'`) →
   Pygmalion (`char_persona` etc., with the negative gates) → Backyard (`aiName`/`aiPersona`) → flat V1.
4. **Lorebook engine**: implement ST semantics exactly (integer enums, `order` ascending, probability roll,
   recursion + `delayUntilRecursion` levels, inclusion groups + group scoring, token budget eviction,
   `atDepth` with role, `outlet`), then layer CCv3 decorators on top as a superset. Use a JS-regex-literal
   parser for keys, and a linear-time engine for `use_regex`.
5. **Export**: default V2 PNG (maximum compatibility) with an opt-in V3 CHARX for assets; V2 export must
   strip decorators and warn about dropped V3-only fields. Always write both `chara` and `ccv3` tEXt chunks
   if you emit V3, mirroring ST.
6. **chub import**: user-supplied `Ch-Api-Key` (or none — public reads work anonymously), `?full=true`
   detail fetch, rebuild the V2 card with the field mapping in (c), pull `extensions.chub.expressions` for
   sprites, cache detail responses ≥10 min, and hard-fail to "paste a file" when the API 403s. Ship the
   ToS constraints in-app: personal use only, attribute chub, no bulk scraping.
7. **JanitorAI**: file/URL paste only. Never a server-side scraper.
8. **Extensions**: skip binary compatibility; expose a small JS/plugin API of your own, and add an
   STscript-compatible command layer plus import/export for regex sets and Quick Replies.

## Sources
- https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
- https://raw.githubusercontent.com/kwaroran/character-card-spec-v3/main/concepts.md
- https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- https://raw.githubusercontent.com/malfoyslastname/character-card-spec-v2/main/spec_v1.md
- https://api.github.com/repos/kwaroran/character-card-spec-v3
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/charx.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/byaf.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/constants.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/characters.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/worldinfo.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/chats.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/sprites.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/extensions.js
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/content-manager.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/events.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/expressions/index.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/manifest.json
- https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- https://docs.sillytavern.app/for-contributors/writing-extensions/
- https://docs.sillytavern.app/for-contributors/server-plugins/
- https://api.chub.ai/openapi.json
- https://api.chub.ai/docs
- https://chub.ai/tos
- https://docs.chub.ai/docs/llms.txt
- https://docs.chub.ai/docs/advanced-setups/lorebooks.md
- https://docs.chub.ai/docs/the-basics/character-creation.md
- https://docs.chub.ai/docs/stages/developing-a-stage/concepts.md
- https://docs.chub.ai/docs/inference-api/usage-with-third-party-uis.md
- https://github.com/Coneja-Chibi/Hoplight/blob/Mainstage/docs/FORMAT-SUPPORT.md
- https://github.com/Coneja-Chibi/Hoplight/blob/Mainstage/docs/reference/formats/sillytavern.md
- https://github.com/Coneja-Chibi/Hoplight/blob/Mainstage/docs/reference/formats/agnai.md
- https://github.com/Coneja-Chibi/Hoplight/blob/Mainstage/docs/reference/formats/risu.md
- https://github.com/Coneja-Chibi/Hoplight/blob/Mainstage/docs/reference/formats/pygmalion.md
- https://github.com/Coneja-Chibi/Hoplight/blob/Mainstage/docs/reference/formats/backyard.md
- https://github.com/Coneja-Chibi/Hoplight/blob/Mainstage/docs/reference/entities/character.md
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/characterCards.ts
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/modules.ts
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/processzip.ts
- https://github.com/kwaroran/RisuAI/blob/main/src/ts/storage/database.svelte.ts
- https://github.com/agnaistic/agnai/blob/main/common/memory.ts
- https://github.com/agnaistic/agnai/blob/main/common/characters.ts
- https://github.com/Darkatse/TauriTavern/blob/main/docs/CurrentState/ThirdPartyExtensions.md
- https://github.com/Darkatse/TauriTavern/blob/main/docs/API/Extension.md
- https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary/blob/main/modules/providers/chub/chub-api.js
- https://github.com/NoahCherel/NexusAI/blob/main/src/lib/import/chub.ts
- https://github.com/korenko-git/chub-card-extractor/blob/main/core/api.ts
- https://github.com/CUUP1DON/Chub-Ripper
- https://github.com/erpocalypse/jai-card-extractor
- https://github.com/itsfantomas/janitor-exporter
- https://github.com/Live2D/CubismWebSamples/blob/develop/LICENSE.md
- https://www.live2d.com/en/download/cubism-sdk/release-license/
- https://www.npmjs.com/package/@risuai/ccardlib
- https://github.com/SillyTavern/Extension-Live2D
- https://github.com/SillyTavern/Extension-VRM
- https://docs.sillytavern.app/extensions/expression-images/
- https://docs.sillytavern.app/extensions/live2d/
- https://docs.sillytavern.app/extensions/vrm/
- https://www.live2d.com/en/sdk/license/
- https://www.live2d.com/en/sdk/license/expandable/
- https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html
- https://api.chub.ai/api/characters/crustcrunch/Esther?full=true
- https://api.chub.ai/search?search=&first=2&page=1&sort=star_count&nsfw=true
- https://api.chub.ai/api/v4/projects/97826/repository/files/raw%252Fcard.json/raw
- https://api.chub.ai/api/v4/projects/97826/repository/commits
- https://api.chub.ai/api/gallery/project/97826
- https://avatars.charhub.io/avatars/crustcrunch/Esther/avatar.webp
- https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v1.md
- https://github.com/BasedInn/Unified-CharacterCard-Specification
- https://github.com/kwaroran/ccardlib
- https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/assets.js
- https://github.com/SillyTavern/SillyTavern/blob/release/default/config.yaml

## Caveats and open questions
- **chub has no documented rate limits.** The OpenAPI doc contains no `429` response and I saw no
  `ratelimit-*` headers. Treat unknown; back off on any 429 and cache aggressively.
- **chub's public read path is undocumented.** `GET /api/characters/{creator}/{slug}?full=true` and
  `GET /search` work anonymously and send `Access-Control-Allow-Origin: *`, but the OpenAPI entry for
  those routes is under an auth `security` block. `[INFERENCE]` The anonymous behaviour is real but
  unsupported; it can change without notice. Always keep the "paste a file" fallback.
- **`POST /api/characters/download` is gone** (405 from a browser origin). Every blog post, forum answer,
  and even Agnai's current code still uses it. Do not.
- **`POST /api/lorebooks/download` and `POST /api/characters/expressions/download` also 405**; lorebooks
  come from the V4 git-file route, expressions from the `?full=true` payload.
- **`https://api.chub.ai/docs` loads Swagger UI** but the spec URL it points at is not fetchable by curl
  from this host (403). Fetch `openapi.json` from a browser context instead.
- **JanitorAI could not be probed at all** — Cloudflare Bot Fight Mode 403s this host on every path,
  including `/terms`. Its ToS wording on third-party access is therefore UNVERIFIED; the community tools'
  own READMEs are the only available signal, and they say access "may" be restricted.
- **CCv3 is effectively frozen** (last commit 2024-07-20) while ST continues to extend the same fields
  through `extensions`. `[INFERENCE]` The de-facto centre of gravity is ST's dialect, not the spec; write
  the spec-compliant names and read both.
- **Not covered here:** prompt/preset formats, memory systems, world simulation, voice/image — other
  slices own those.
