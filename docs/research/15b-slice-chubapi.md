# (c) Character-hub APIs & interoperability

Verified live 2026-09-29 unless marked UNVERIFIED.

## 1. chub.ai Hub API

**Spec.** `https://api.chub.ai/openapi.json` → 200 for browser-like UA and `SillyTavern:1.13.4:…`, **403 for `curl/8.0`**. A load balancer alternates **two variants of the same 197 paths**: `Chub API` v0.2.0 (552 KB; *"Commercial use requires prior authorization."*, lore@chub.ai, 3 security schemes) or `Rostro API` v0.5.9 (377 KB; points at `https://api.rostro.dev/v1` for the OpenAI mimic, `https://proto.rostro.dev/mcp` for MCP, terms `https://rostro.dev/tos`). 6 fetches: 4× Chub, 2× Rostro, identical paths — Rostro looks like a white-label rebuild. Swagger UI: `https://api.chub.ai/docs`.

**Auth.** apiKey-in-header schemes `CH-API-KEY`, `Authorization`, `samwise`. Public reads work **unauthenticated**. Clients send `samwise`+`CH-API-KEY` (SillyTavern-CharacterLibrary) or `Authorization: Bearer`. CORS is open. Tokens are purpose-scoped: `POST /api/account/tokens` (inference), `/api/account/tokens/core` (chat), `/account/tokens/projects` (CRUD); list `GET /api/account/tokens`; revoke `DELETE /api/account/token/{id}`. Docs point to `https://chub.ai/my_stages?active=tokens`.

**Endpoints a client needs** (all verified):
- `GET /api/characters/{creator}/{slug}?full=true` — without `full=true`, `node.definition` is `null`. `node` = id, fullPath, tagline, topics[], starCount, forksCount, nTokens, primaryFormat, nChats/nMessages, hasGallery, related_characters/lorebooks/prompts/extensions, permissions, is_public, is_unlisted, nsfw_image, avatar_url, max_res_url, project_uuid, badges, labels[]. `definition` = description, personality, tavern_personality, scenario, first_message, example_dialogs, alternate_greetings[], system_prompt, post_history_instructions, embedded_lorebook, extensions, avatar; `extensions` nests `{fav, chub:{id, full_path, expressions, alt_expressions, related_lorebooks}, agnai:{voice, persona}}`.
- Namespace form `GET /api/{namespace}/{creator}/{slug}`; the enum leaks in a 422 body: `characters|character|lorebooks|lorebook|presets|preset|extension|extensions|stage|stages|scenario…`.
- By id: `GET /api/characters/{project_id}` or `GET /api/{space}/{project_id}` (plus `/api/public/...` mirrors).
- Search `GET /search` (POST works too; params on the query string): `search, first, page, sort, nsfw, nsfl, username, tags, exclude_tags, min_tokens, max_tokens, include_forks, venus` → `{data:{count, nodes[], page, cursor}}`; `sort` ∈ `default|trending|star_count|download_count|rating|name|last_activity_at|n_favorites|random` (`trending` cut count 37688→225). `first=200`/`first=500` both return full pages. `nsfw`/`nsfl` are accepted but did **not** change my first 5 results — UNVERIFIED whether they filter.
- `POST /tags` `{nsfl,nsfw,order_by,sort,offset,search}` → 500 tags with `non_private_projects_count`, `followers_count`.
- `GET /api/projects/similar/{project_id}/{no_nsfl}/{no_nsfw}`.
- Raw card `GET /api/v4/projects/{id}/repository/files/raw%252Fcard.json/raw` → `{spec:"chara_card_v2", spec_version:"2.0", data:{…}}`; also `raw%252Fsillytavern_raw.json/raw` (lorebook, carries `extensions.chub`) and `raw%252Ftavern_raw.json/raw` on `https://gateway.chub.ai`. `?ref=main` OK; `GET /api/v4/projects/{id}/repository/commits` lists refs.
- Images `https://avatars.charhub.io/avatars/{creator}/{slug}/avatar.webp` and `/chara_card_v2.png` — a real PNG whose first `tEXt` chunk is named `chara` and holds base64 V2 JSON (verified by chunk walk). Gallery `GET /api/gallery/project/{id}`.
- `GET /api/characters/{id}/expressions` → **403 `{"detail":"You must create an account to continue."}`** — the only read endpoint needing an account.
- Inference `GET https://inference.chub.ai/v1/models` (also on api.chub.ai) → `mythomax, asha, soji, mixtral, mistral, mobile, testing`; OpenAI-compatible `POST /v1/chat/completions`.
- **Dead:** `POST /api/characters/download` → 405, GET → 422; ST migrated to the v4 file route.

**Rate limits:** undocumented in spec, docs, and site; no `RateLimit-*` headers. 40 sequential character fetches and 30 sequential searches all returned 200.

## 2. chub ToS / acceptable use

`https://chub.ai/tos` and `/privacy` are SPA shells for `curl`; readable only in a browser (`https://www.chub.ai/tos` works). ToS **last updated May 15th, 2026**.

- **Third-party clients: no clause names them.** Nearest are the OpenAPI description *"Commercial use requires prior authorization."* and a ban on any part of the Services or Content being *"copied, reproduced, aggregated, republished, … transmitted, distributed, sold, licensed, or otherwise exploited for any commercial purpose whatsoever, without our express prior written permission"* (ask lore@chub.ai). **No anti-scraping clause** — I grepped the full text for scrap/crawl/robot/bot and found none.
- Redistribution: *"You may use UGC for personal, non-commercial purposes"*, plus fair use, with an attribute ("Chub" or "courtesy of Chub"). Public cards grant every user *"a perpetual, irrevocable, worldwide, royalty-free, non-exclusive license to use, display, publish, reproduce, distribute, and make derivative works of your Content through our Services and functionalities."*
- Private content: *"will not ever be distributed to a third party, unencrypted, used for training an AI model."*
- API inference: *"If you use the API outside of the Chub UI, none of the content of the inputs or the outputs of queries made to the inference endpoints at \*.chub.ai are at any point logged or stored."* Only metadata is: unique id, user id, time, input/output length, model, approximate charge, ms.
- NSFW/gated: 18+. Any character/lorebook/preset/stage sexualizing anyone under or appearing under 18 is banned; *"Circumventing image removals with external links … may result in account deletion."*

## 3. Auth-gated content

Anonymous **public NSFW reads succeed** — `dripula/vampire-roommate` returned a full `definition` with no token (`is_public: true`, `permissions: "read"`), and all 50 rows of a `sort=random&nsfw=true&nsfl=true` page were likewise `permissions: "read"`. A token is needed for private/unlisted projects, expressions, favorites, chats, personas, and writes; clients send `CH-API-KEY`+`samwise` or `Authorization: Bearer`.

## 4. JanitorAI

**No public API** (`/api/*` 404 at nginx; no swagger). The real surface is undocumented JSON under `https://janitorai.com/hampter/`:
- `GET /hampter/characters?page=&sort=popular&mode=all&search=&tag_id[]=&excluded_tag_id[]=&user_id[]=&language=en&following=` → `{data[],total,page,size}`. Page 1 is anonymous; **page ≥2 → 401 `{"message":"Sign in to search and browse more characters."}`**.
- `GET /hampter/characters/{uuid}` → personality, first_message, scenario, example_dialogs, scripts, allow_proxy, showdefinition, token_counts, stats, tags. **Every sampled card returned those four content fields as `null` even with `showdefinition: true`** — definitions are not served anonymously; the community workaround is proxy-mode prompt capture.
- Also `/hampter/tags` (anon, CF-cached), `/profiles/search`, `/following/v2/myfollowing`, `POST /following/follow|unfollow`, `/chats/{chatId}` (Bearer read from Supabase `sb-*-auth-token` in localStorage). Avatars: `https://ella.janitorai.com/bot-avatars/`.
- **No export endpoint**: `/characters/{id}/export`, `/download`, `/export/character/{id}` all 404. Exports are client-side, built by userscripts as **Tavern V1 PNG** (JSON in the `chara` tEXt chunk) plus JSONL/TXT chat dumps — e.g. `itsfantomas/janitor-exporter` (18★, MIT, 2026-05-30).

**ToS** `https://janitorai.com/term` (updated **July 29, 2026**): *"you further agree not to: (i) use automated systems, bots, or scripts to access the Platform without authorization; (ii) attempt to gain unauthorized access …; (iv) harvest user data without consent; or (v) use the Platform for any commercial purpose without our prior written consent."* The license is *"personal, non-commercial"* and excludes *"reverse engineer, decompile, disassemble, or create derivative works."* Privacy: `/policy` (Sept 17, 2026). The ToS never mentions card export/import.

**Tools** (★/last push/license): `hydall/JAR` 48/2026-08-13/AGPL-3.0; `hydall/Glaze` 34/2026-09-28/AGPL-3.0 (Flutter client); `vu5eruz/GeminiForJanitors` 36/2026-08-26/MIT; `daksh-7/scrapitor` 21/2026-06-26/none; `Sillyanonymous/SillyTavern-CharacterLibrary` 140/2026-09-02/AGPL-3.0 (the most thorough reverse-engineering of hampter); `kubernetes-bad/metachar` 37/**2024-01-11, abandoned**.

## 5. Pygmalion / Kobold era

- **pygmalion.chat is alive** (Next.js); ToS updated **Jan 23, 2024**; guidelines: 16+, public cards must be the poster's own and in English.
- Live API is connect-protobuf-over-JSON: `https://server.pygmalion.chat/galatea.v1.PublicCharacterService/CharacterSearch` (POST `{orderBy,includeSensitive,pageSize}`), plus `CharactersListing`, `GetRandomFeaturedCharacters`, `CharacterAvailableTags`, `PublicUsersService/UsersListWithStats`. 4,513 cards.
- Export `GET https://server.pygmalion.chat/api/export/character/{uuid}/v2` → `{"character":{spec:"chara_card_v2",spec_version:"2.0",data:{…,extensions:{depth_prompt:null,pygmalion_id:"<uuid>"}}}}` (verified live); SillyTavern's content-manager uses exactly this route.
- **Pygmalion's own format** (legacy YAML/JSON): `char_name, char_persona, char_greeting, example_dialogue, world_scenario` (+`your_name`). text-generation-webui still reads it in `load_character()`/`build_pygmalion_style_context()`, alongside `name|bot|char_name`, `your_name|user`, `context`, `greeting`; `upload_tavern_character()` maps Tavern cards onto those fields.
- **Abandonment:** the PygmalionAI org is mostly dormant — `gradio-ui` 2023-06-01, `galatea-ui` archived 2023-06-26, `pygmalion-docs` 2023-09-16; only `data-toolbox` (2025-10-13) is recent. `KoboldAI/KoboldAI-Client` 3953★ AGPL-3.0, 2025-01-16. `TavernAI/TavernAI-v1` 2698★, 2026-06-16.
- **Specs:** V1 = six mandatory strings (`name, description, personality, scenario, first_mes, mes_example`) as base64 JSON in PNG `tEXt` chunk `chara`; `.json` sidecar discouraged; WEBP out of spec. V2 (`character-card-spec-v2` 195★, **no license, frozen 2023-06-22**) adds spec, spec_version, creator_notes, system_prompt, post_history_instructions, alternate_greetings, character_book, tags, creator, character_version, extensions. V3 (`kwaroran/character-card-spec-v3` 112★, MIT, 2024-07-20) adds typed `assets[]` with `uri` (`embeded://`, `ccdefault:`) and defines **CHARX**: a zip with `card.json` at root and an `assets/{type}/{kind}/` tree (`.charx`). PNG asset chunks (`chara-ext-asset_:{path}`) exist, but new apps SHOULD use CHARX.

## 6. Others

- **RisuAI** (`kwaroran/Risuai` 1699★, GPL-3.0, 2026-09-29 — active): exports `.charx`, `.risum` modules (binary: magic `0x6f`, version byte, length-prefixed sections; `RisuModule{name, description, lorebook[], regex[], cjs, trigger[], id, assets[], mcp, icon}`), `.risup`/`.risupreset`, and a "Risu Refined Character Card" with password/integrity; extension data lives in `data.extensions.risuai` (`triggerscript`, `customScripts`, `emotions`). Hub `https://sv.risuai.xyz` (paths not anonymously discoverable). `PocketRisu/PocketRisu` 366★ GPL-3.0, 2026-09-27.
- **Agnai** (`agnaistic/agnai` 784★, AGPL-3.0, 2026-06-15): `exportCharacter(char,'tavern'|'ooba')` — 'tavern' emits a full V2 card with `extensions.agnai`, 'ooba' the text-generation-webui shape; `.png` when an avatar exists, else `.json`.
- **Backyard AI / Faraday** (`faraday.dev` 302→`backyard.ai`; Ahoy Labs, Inc.; Terms Oct 29, 2024): its own `https://backyard.ai/docs/feature-guides/import-export` says *"Docs on imports and exports coming soon."* — **no documented format**.
- **Character.AI**: **no documented import/export.** `developer.character.ai` does not resolve; `character.ai/terms` 404s; `neo.character.ai` and `help.character.ai` 403/timeout.
- **text-generation-webui** (47723★, AGPL-3.0, 2026-08-17): YAML/JSON at `user_data/characters/{name}.{yml,yaml,json}`; fields `name|bot|char_name`, `your_name|user`, `context`, `greeting` (or the Pygmalion set); also ingests Tavern cards.
- **Libraries:** `character-card-utils` npm 2.0.3 (2023-06-04, ISC) — **stale**. `@risuai/ccardlib` 0.4.2 (2024-06-14, MIT). `parsecard` 2.0.4 (2026-07-26, Apache-2.0). `@character-foundry/loader` 0.1.10 (2025-12-15, MIT) with `…/schemas` 0.2.2, `…/normalizer` 0.1.5. `@overworks/chara-card-core` 0.2.0 (2026-05-14, MIT). `@lenml/char-card-reader` 1.1.1 (2025-12-13, AGPL-3.0-only). `character-card-parser` npm 0.0.2 (2025-02-23, ISC) — its GitHub `UpstreetAI/character-card-parser` is **404/0★, abandoned**. `png-chunks-extract` 1.0.0 (2015, MIT). Python: **`tavern-card` 0.1.1** (2026-07-10, `felixchaos/tavern-card`, zero-dependency V1/V2/V3 JSON + PNG `tEXt`/`zTXt`); no `character-card-utils` or `chara-card` on PyPI (404).

## Sources

https://api.chub.ai/openapi.json
https://api.chub.ai/docs
https://api.chub.ai/api/characters/crustcrunch/Esther?full=true
https://api.chub.ai/api/characters/97826
https://api.chub.ai/api/v4/projects/97826
https://api.chub.ai/api/v4/projects/97826/repository/files/raw%252Fcard.json/raw
https://api.chub.ai/api/v4/projects/97826/repository/files/raw%252Fsillytavern_raw.json/raw
https://api.chub.ai/api/v4/projects/97826/repository/commits
https://api.chub.ai/api/gallery/project/97826
https://api.chub.ai/api/characters/97826/expressions
https://api.chub.ai/api/projects/similar/97826/false/false
https://api.chub.ai/search?search=&first=5&sort=download_count
https://api.chub.ai/tags
https://api.chub.ai/v1/models
https://inference.chub.ai/v1/models
https://gateway.chub.ai/api/v4/projects/97826/repository/files/raw%252Ftavern_raw.json/raw
https://avatars.charhub.io/avatars/crustcrunch/Esther/avatar.webp
https://avatars.charhub.io/avatars/crustcrunch/Esther/chara_card_v2.png
https://docs.chub.ai/docs/llms.txt
https://docs.chub.ai/docs/llms-full.txt
https://docs.chub.ai/docs/inference-api/usage-with-third-party-uis.md
https://docs.chub.ai/docs/the-basics/api-connections.md
https://docs.chub.ai/docs/stages/developing-a-stage/quickstart-setup.md
https://chub.ai/my_stages?active=tokens
https://www.chub.ai/tos
https://www.chub.ai/privacy
https://rostro.dev/
https://rostro.dev/tos
https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/endpoints/content-manager.js
https://raw.githubusercontent.com/Sillyanonymous/SillyTavern-CharacterLibrary/main/modules/providers/chub/chub-api.js
https://raw.githubusercontent.com/Sillyanonymous/SillyTavern-CharacterLibrary/main/modules/providers/chub/chub-browse.js
https://raw.githubusercontent.com/Sillyanonymous/SillyTavern-CharacterLibrary/main/modules/providers/janitorai/janitorai-api.js
https://raw.githubusercontent.com/Sillyanonymous/SillyTavern-CharacterLibrary/main/extras/cl-janitor-bridge.user.js
https://raw.githubusercontent.com/agnaistic/agnai/dev/web/store/chub.ts
https://raw.githubusercontent.com/agnaistic/agnai/dev/web/pages/Chub/util.ts
https://raw.githubusercontent.com/agnaistic/agnai/dev/common/characters.ts
https://janitorai.com/hampter/characters?page=1&sort=popular&mode=all
https://janitorai.com/hampter/characters/62650d46-bcda-4eac-90a5-1162cb3d5d80
https://janitorai.com/hampter/tags
https://janitorai.com/term
https://janitorai.com/policy
https://janitorai.com/content
https://raw.githubusercontent.com/itsfantomas/janitor-exporter/main/README.md
https://raw.githubusercontent.com/itsfantomas/janitor-exporter/main/janitor-exporter.user.js
https://api.github.com/repos/hydall/JAR
https://api.github.com/repos/hydall/Glaze
https://api.github.com/repos/berry-thelight/janitorai-downloader-exporter
https://api.github.com/repos/kubernetes-bad/metachar
https://server.pygmalion.chat/galatea.v1.PublicCharacterService/CharacterSearch
https://server.pygmalion.chat/api/export/character/6b67ca81-f58e-4a16-bf29-5f36313f29b7/v2
https://pygmalion.chat/
https://pygmalion.chat/explore
https://pygmalion.chat/terms-of-service
https://pygmalion.chat/guidelines
https://api.github.com/repos/PygmalionAI/gradio-ui
https://api.github.com/repos/PygmalionAI/galatea-ui
https://api.github.com/repos/PygmalionAI/pygmalion-docs
https://api.github.com/repos/KoboldAI/KoboldAI-Client
https://raw.githubusercontent.com/malfoyslastname/character-card-spec-v2/main/spec_v1.md
https://raw.githubusercontent.com/malfoyslastname/character-card-spec-v2/main/spec_v2.md
https://raw.githubusercontent.com/kwaroran/character-card-spec-v3/main/SPEC_V3.md
https://api.github.com/repos/kwaroran/character-card-spec-v3
https://raw.githubusercontent.com/kwaroran/Risuai/main/src/ts/characterCards.ts
https://raw.githubusercontent.com/kwaroran/Risuai/main/src/ts/process/modules.ts
https://raw.githubusercontent.com/kwaroran/Risuai/main/src/ts/process/processzip.ts
https://raw.githubusercontent.com/kwaroran/Risuai/main/src/lang/en.ts
https://api.github.com/repos/kwaroran/Risuai
https://raw.githubusercontent.com/oobabooga/text-generation-webui/main/modules/chat.py
https://raw.githubusercontent.com/oobabooga/text-generation-webui/main/docs/01%20-%20Chat%20Tab.md
https://api.github.com/repos/oobabooga/text-generation-webui
https://backyard.ai/docs/feature-guides/import-export
https://backyard.ai/terms
https://backyard.ai/community-guidelines
https://developer.character.ai
https://character.ai/terms
https://registry.npmjs.org/character-card-utils
https://registry.npmjs.org/@risuai%2Fccardlib
https://registry.npmjs.org/parsecard
https://registry.npmjs.org/@character-foundry%2Floader
https://registry.npmjs.org/@overworks%2Fchara-card-core
https://registry.npmjs.org/@lenml%2Fchar-card-reader
https://registry.npmjs.org/character-card-parser
https://pypi.org/pypi/tavern-card/json
