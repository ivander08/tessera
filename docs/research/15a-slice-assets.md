# Local card & asset storage, avatars/sprites/NSFW metadata

## 1. SillyTavern on-disk layout (release branch, v1.13.x, HEAD 2026-09-23)

Data root `dataRoot: ./data` (`default/config.yaml:3`). Per account `data/<handle>/`; built-in account `default-user`. `USER_DIRECTORY_TEMPLATE` (`src/constants.js:20-52`) is authoritative — created under `data/<handle>/`:

`thumbnails{,/bg,/avatar,/persona}`, `worlds`, `user`, `avatars` → literally **`User Avatars`** (space, capitals), `user/images`, `groups`, `group chats` (space), `chats`, `characters`, `backgrounds`, `NovelAI Settings`, `KoboldAI Settings`, `OpenAI Settings`, `TextGen Settings`, `themes`, `movingUI`, `extensions`, `instruct`, `context`, `QuickReplies`, `assets`, `user/workflows`, `user/files`, `vectors`, `backups`, `sysprompt`, `reasoning`.

- **Characters are PNGs, no sidecar JSON.** `characters/<Name>.png`; card in PNG `tEXt` chunks `chara` (b64 CCv2) and `ccv3` (b64 CCv3). `src/character-card-parser.js`: `write()` strips both chunks then writes `chara` plus a synthesized `ccv3` (`spec:'chara_card_v3'`, `spec_version:'3.0'`); `read()` prefers `ccv3`. The list scans **only `.png`** (`src/endpoints/characters.js:136,1469`).
- Per-character folder `characters/<charName>/` holds sprites plus `backgrounds/`, `live2d/<model>/`, `vrm/<cat>/`.
- **Chats:** `chats/<avatarBasename>/<chat>.jsonl` (basename = card filename minus `.png`). Group: `group chats/<id>.jsonl`. Line 1 = header `{chat_metadata:{},user_name:'unused',character_name:'unused'}`; `chat_metadata.integrity` is a slug checked on save; messages carry `is_user`, `send_date`, `mes`, `swipes`, `extra`, `name`, `original_avatar`/`force_avatar`.
- `groups/<id>.json`; `worlds/<name>.json` (top key `entries` = dict keyed by uid: `key`,`keysecondary`,`content`,`order`,`position`,`depth`,`role`,`probability`,…); `themes/<name>.json`; presets `*.json` in each per-API Settings folder + `instruct/`,`context/`,`sysprompt/`,`reasoning/`.
- `settings.json` per user; persona images `User Avatars/`; gallery `user/images/<char>/`; Data Bank `user/files/`; RAG `vectors/` (Vectra JSON).
- **No SQLite/ORM.** `package.json` has no `sqlite`/`better-sqlite3`/`sequelize`/`knex`. Persistence = `node-persist` + `write-file-atomic` + `vectra`. node-persist stores: `data/_storage` (accounts, keys `user:<handle>`, `avatar:<handle>`) and `data/_cache/characters` (parsed-card cache, `performance.useDiskCache` default true).

## 2. Expression sprites (`public/scripts/extensions/expressions/index.js`, 2721 lines)

- Sprites in `characters/<spriteFolderName>/`; folder = character **display name** (docs: "Display names … dictate which image set is used"), or `characters/<name>/<subfolder>` when the name contains `/` (`src/endpoints/sprites.js:18-35`). Override: `extension_settings.expressionOverrides = [{name:'<avatarFilenameWithoutExt>', path:'<folder>'}]`; `/costume Boris`, `/setspritefolder`.
- `GET /api/sprites/get?name=<folder>` → `[{label,path}]` for any `image/*`; label = filename lowercased via `/^(.+?)(?:[-\.].*?)?$/`, so `joy.png`/`joy-1.png`/`joy.expressive.png` → `joy`. Any image format (webp, animated gif).
- `extension_settings.expressions`: `api` (0 local, 1 extras, 2 llm, 3 webllm, 99 none), `custom: string[]`, `fallback_expression`, `showDefault`, `llmPrompt`, `promptType` (`raw`|`full`), `translate`, `filterAvailable`, `allowMultiple`, `rerollIfSame`.
- Defaults: `DEFAULT_EXPRESSIONS` = 28 GoEmotions labels (admiration…neutral); `DEFAULT_FALLBACK_EXPRESSION='joy'`; `DEFAULT_LLM_PROMPT='Ignore previous instructions. Classify the emotion of the last message. Output just one word, e.g. "joy" or "anger". Choose only one of the following labels: {{labels}}'`.
- Classification: **local** → `POST /api/extra/classify {text}` → `classification[0].label`, model `Cohee/distilbert-base-uncased-go-emotions-onnx` (`config.yaml:306`); **llm** → `generateRaw({prompt:text,systemPrompt})` (raw) or `generateQuietPrompt({quietPrompt})` (full), JSON-schema enum of labels when supported, then `Fuse` fuzzy match; **webllm** → `generateWebLlmChatPrompt`; **extras** → `POST /api/classify` (deprecated per docs); **translate** → `globalThis.translate(text,'en')` first.
- Fallback: `#none` or `#emoji` (built-in `/img/default-expressions/<label>.png`).
- Docs: <https://docs.sillytavern.app/extensions/expression-images/> (`/extensions/expressions/` 404s).

## 3. Live2D

ST `SillyTavern/Extension-Live2D` (GPL-3.0, 89★, **last push 2024-06-28 — stale**). Models in `assets/live2d/<modelFolder>/` or `characters/<char>/live2d/<modelFolder>/`; detection = file whose name contains `model` and ends `.json` (i.e. `*.model3.json`), `*.moc3` + textures alongside. Runtime `pixi.min.js` + `pixi-live2d-display` + `live2dcubismcore.min.js` (`lib/`, `constants.js` `JS_LIBS`). Mapping in `extension_settings.live2d.characterModelMapping`. **RisuAI has no Live2D**; it stores `emotionImages: [label, assetPath][]` and `additionalAssets: [name, path, fileName][]`.

**Licensing is the blocker.** SDK free to develop with, but release requires the SDK Release License; individuals/small-scale enterprises are exempt **except "Expandable Applications"** — works "using and generating any indefinite numbers of models by adding or combining files or data (e.g. avatar)", or acting as portal/collection. A client loading arbitrary user-supplied models is exactly that: review + special Publication License Agreement regardless of company size; revenue share ¥300/sale or 20% of sales (5% mid/large). <https://www.live2d.com/en/sdk/license/>, <https://www.live2d.com/en/sdk/license/expandable/>.

`.charx` **is** the spec'd packaging answer (CCv3: Live2D SHOULD go in `assets/{type}/l2d/`), but ST's CharX importer ignores it — `CHARX_IMAGE_EXTENSIONS` in `src/charx.js` is images only.

## 4. VRM / 3D

ST `SillyTavern/Extension-VRM` (GPL-3.0, 65★, pushed 2026-01-20): `.vrm` in `assets/vrm/model`, animations in `assets/vrm/animation` (`.fbx`, `.bvh`, `.vrma` via `@pixiv/three-vrm`). `src/endpoints/assets.js:14` `VALID_CATEGORIES = ['bgm','ambient','blip','live2d','vrm','character','temp']` — VRM is already first-class. RisuAI: none. List as optional; models are 10s–100s of MB and need three.js.

## 5. "Character sheet"

Not a file format. In this ecosystem a *character sheet* is (a) the structured persona block inside `data.description` in a community syntax — W++ (`[character("Name"){…}]`), PList, Ali:Chat — that tools render, and (b) an HTML/Markdown card body in `creator_notes` or emitted by a card-builder bot. **No standard exists.** The only machine-readable analogue is CCv3's `data.assets` types (`icon`, `background`, `emotion`, `user_icon`) plus `extensions`. Tools: `easychen/airole` (127★, 2026-07-23), `lenML/CCEditor` (42★, 2026-09-04), `zer0thgear/character-card-editor` (27★, 2026-09-25), `spaceman2408/CharacterVault` (15★, 2026-09-29). Agnai is closest to a schema: `persona:{kind:'attributes', attributes:{species:['robot'], personality:[…]}}` (`common/characters.ts:7-20`), flattened to text on Tavern export. Treat "sheet" as a renderer concern over text fields, not an interchange format.

## 6. Safety / NSFW metadata

- **CCv2/CCv3 spec has no rating field** — only `tags: string[]` and `extensions: Record<string, any>`. Everything below is de-facto.
- **chub** node (`GET https://api.chub.ai/api/characters/<creator>/<slug>?full=true`, sampled 2026-09-29): `topics: string[]` carries a literal **`"NSFW"`** token among free-text tags — that is the de-facto rating. `nsfw_image: boolean` is image-only and **not** a content rating (`bobpage/TestRoid` `nsfw_image:true`; `Anonymous/LewdTV` `nsfw_image:false` with NSFW in `topics`). `rating`/`ratingCount` are 1–5 star user ratings. Also `labels:[{title:'TOKEN_COUNTS',description:'{json}'}]`, `primaryFormat:'tavern'`, `is_unlisted`, `permissions`, `verified`, `hasGallery`, `nTokens`, `avatar_url` (`…/avatar.webp`), `max_res_url` (`…/chara_card_v2.png`). Search: `GET /search?search=&first=&sort=star_count&nsfw=true&excludetopics=`.
- **In-card:** chub writes `data.extensions.chub = {id, full_path, preset, extensions, custom_css, expressions, alt_expressions, background_image, related_lorebooks}` — `expressions`/`alt_expressions` is the sprite-pack hook (null on every card sampled).
- **ST** has no NSFW field. Convention only: `creator_notes`, and ST strips the literal placeholder `"Creator's notes go here."` on import (`src/endpoints/characters.js:906`). Tags in `tags` + `settings.json` `tags`/`tag_map`.
- **BYAF** has a real boolean `ByafCharacter.isNSFW`, imported as `tags:['nsfw']` (`src/byaf.js:264`).
- **RisuAI**: `character.license?: string`, `character.private?: boolean`; its search API takes an `nsfw` bool.
- **CCv3** assets carry no rating; app fields must go in `extensions`, new asset types prefixed `x_`.

Spec'd: `tags`, `extensions`, `x_` asset types. De-facto: `"NSFW"` topic, `nsfw_image`, `isNSFW`, `license`, `rating` stars.

## 7. Import/export formats

ST's server accepts exactly six (`src/endpoints/characters.js:1568-1573`): `yaml`, `yml`, `json`, `png`, `charx`, `byaf`; client gates on the same list (`public/script.js:10537`). ST **exports only `png` and `json`** (`/api/characters/export`, `:1659-1675`).

| Ext | Meaning | Lossy? |
|---|---|---|
| `.png` | `tEXt` `chara` (b64 CCv2) and/or `ccv3` (b64 CCv3); `ccv3` wins | Export strips `chat`, resets `fav`, image re-encoded/resized to 512×768 |
| `.json` | V1 flat / V2 (`spec:'chara_card_v2'` + `data`) / V3 (`chara_card_v3`) | ST export is **always V2**; V3-only fields (`nickname`, `source`, `group_only_greetings`, `creation_date`, `assets`) dropped |
| `.charx` | ZIP, `card.json` at root (MUST), assets under `assets/{type}/{images\|audio\|video\|l2d\|3d\|ai\|fonts\|code\|other}/`, URI `embeded://` (misspelling normative; ST also accepts `embedded://`, `__asset:`) | ST persists **images only**: sprites → `characters/<name>/`, backgrounds → `characters/<name>/backgrounds/`, misc → `user/images/<name>/`; audio/video/l2d/3d/fonts/code dropped |
| `.byaf` | Backyard Archive Format ZIP: `manifest.json` + character/scenario JSON, `isNSFW`, `loreItems`, `images` | Very lossy — flattened to CCv2, creates `.jsonl` chats + gallery backgrounds |
| `.risum` | RisuAI legacy module binary (magic `111`, version `0`, length-prefixed RPack JSON + assets) — a *module*, not a card; current module export is `.module`, a `.charx` | N/A |
| `.yaml`/`.yml` | ST-only minimal: `name`, `context` → description, `greeting` → first_mes | Yes |
| `.webp` | **Not** a card container in ST; chub avatar format (`avatar.webp`), accepted as sprite/gallery imagery | N/A |
| `.jsonl` | ST chat log; group import accepts only ST's own JSON/JSONL. Importers: Ooba, Agnai, CAI Tools, Kobold Lite, Chub Chat, Risu | — |
| `.json` presets/lorebooks | `worlds/<name>.json`; presets per API folder; standalone lorebook = `{spec:'lorebook_v3', data:{…}}` | — |

RisuAI export targets (`src/ts/characterCards.ts:705,1245`): `png`, `json`, `charx`, `charxJpeg` (JPEG with embedded CCv3), spec `v2` or `v3`.

## Sources

- https://github.com/SillyTavern/SillyTavern (release; AGPL-3.0; 33.9k★; HEAD 2026-09-23)
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/constants.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/users.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/character-card-parser.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/charx.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/byaf.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/types/byaf.d.ts
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/characters.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/chats.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/sprites.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/assets.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/groups.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/worldinfo.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/presets.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/themes.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/extensions/expressions/index.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/extensions/expressions/settings.html
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/script.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/char-data.js
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/config.yaml
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/content/index.json
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/content/Eldoria.json
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/package.json
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/tests/tavern-card-validator.test.js
- https://docs.sillytavern.app/administration/
- https://docs.sillytavern.app/extensions/expression-images/
- https://docs.sillytavern.app/extensions/live2d/
- https://docs.sillytavern.app/extensions/vrm/
- https://docs.sillytavern.app/usage/core-concepts/data-bank/
- https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- https://github.com/SillyTavern/Extension-Live2D (GPL-3.0, 89★, last push 2024-06-28)
- https://raw.githubusercontent.com/SillyTavern/Extension-Live2D/main/constants.js
- https://github.com/SillyTavern/Extension-VRM (GPL-3.0, 65★, pushed 2026-01-20)
- https://raw.githubusercontent.com/SillyTavern/Extension-VRM/main/README.md
- https://www.live2d.com/en/sdk/license/
- https://www.live2d.com/en/sdk/license/expandable/
- https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html
- https://raw.githubusercontent.com/kwaroran/character-card-spec-v3/main/SPEC_V3.md
- https://raw.githubusercontent.com/kwaroran/character-card-spec-v3/main/concepts.md
- https://raw.githubusercontent.com/malfoyslastname/character-card-spec-v2/main/spec_v2.md
- https://github.com/kwaroran/RisuAI (GPL-3.0, 1.7k★, pushed 2026-09-29)
- https://raw.githubusercontent.com/kwaroran/RisuAI/main/src/ts/characterCards.ts
- https://raw.githubusercontent.com/kwaroran/RisuAI/main/src/ts/process/modules.ts
- https://raw.githubusercontent.com/kwaroran/RisuAI/main/src/ts/storage/database.svelte.ts
- https://raw.githubusercontent.com/agnaistic/agnai/main/common/characters.ts
- https://raw.githubusercontent.com/agnaistic/agnai/main/web/shared/PersonaAttributes.tsx
- https://raw.githubusercontent.com/Sillyanonymous/SillyTavern-CharacterLibrary/main/modules/providers/chub/chub-api.js
- https://docs.chub.ai/docs/the-basics/character-creation.md
- https://docs.chub.ai/docs/inference-api/usage-with-third-party-uis.md
- https://api.chub.ai/search?search=&first=40&sort=star_count&nsfw=true&excludetopics=
- https://api.chub.ai/api/characters/bobpage/TestRoid?full=true
- https://api.chub.ai/api/characters/Vyrea_Aster/miiya-e25a67d2?full=true
- https://api.chub.ai/api/characters/Anonymous/LewdTV?full=true
- https://avatars.charhub.io/avatars/bobpage/TestRoid/chara_card_v2.png
