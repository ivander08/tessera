# Sampler & Prompt Presets — Research (2026-09-29)

## (a) "Freaky Frankenstein" — identified precisely

**It is a preset family by u/dptgreg (Reddit), not a person's nickname and not a character.**
Official archive: https://rentry.co/freaky-frankenstein-presets (page pub 2026-04-06, last edit **2026-09-15**; mirrored at `rentry.org/freaky-frankenstein-presets`). Self-description: "the official preset archive by **u/dptgreg** (with special thanks to co-author … *u/leovarian* and … *u/Ok_Strategy_2420* aka *Ryah*)".

### Version timeline (from the archive page)
| Version | Date | Notes |
|---|---|---|
| FF 2.0 | 2026-01-23 | "the one that started the Freaky revolution"; Mandarin Chain-of-Thought |
| FF 3.2 Reanimated | 2026-02-19 | group-chat toggles; Freaky Mode vs Realism Mode |
| FF 4.0 "Fat Man" / 3.5 "Little Feller" | 2026-03-25 | VAD Emotional Engine; "Evidence Rule" |
| FF 4.2 / 3.6 | 2026-03-31 | XML tagging for GLM 5.1; Claude/Gemini custom CoT |
| FF 4 MAX / 4 BOLT | 2026-04-30 | 5k / 3k token; "TOON logic" −30–40% tokens |
| FF 4 MAX+ / BOLT+ | 2026-05-07 | DeepSeek-4 "Freaky Deepy" toggle |
| **FF 5.0 Micro** | 2026-06-11 | cache-friendly, ~1.5–2k tokens |
| **FF 5 Internal States** | 2026-07-28 | flagship; Micro/BOLT/MAX tiers; regex-required |
| **FF 5.2 Internal States** | 2026-08-12 | 700+ comments, 50+ testers; "50% up to 90%+ context cache lock rates" |
| **FF 5.4 Internal States** | **2026-09-01** | −25% prompt tokens; FF5 Regex 3.0 |
| FF 6 Micro | "COMING SOON" | "TeleWire TRP / FrankenWire"; author retiring |

Sibling line: **FreaKy FranKIMstein** (BETA 2026-01-28, Fully Cooked 2026-02-03, SwanSong 2026-03-09) — Kimi K2.5-Think-specific.

### What it contains (verified by downloading the real files)
Downloaded via MediaFire direct links from the archive:
- **FF 5.4 Internal States** — `Freaky_Frankenstein_5.4_Internal_States_(2).json`, 144,032 bytes, **63 prompt entries**, **25 embedded regex scripts**.
- **FF 5.2 MAX setup** — `FF5.2_Internal_States_MAX_setup_(1).json`, 135,435 bytes, 12 top-level keys.
- **FF 4 MAX+** — `Freaky Frankenstein 4 MAX+.json` (mirror: https://github.com/EUM27/Hushline-cHat `프리셋/Freaky Frankenstein 4 MAX+.json`), 77,780 bytes, 47 prompt entries.
- **FF5 Regex 3.0 Suite** — `FF5_Regex_3.0_Suite.json`, 20,639 bytes, 25 regex rules (flat array).

FF5.4 architecture: system-role rule modules at `injection_position:0, injection_depth:4`; **nine Internal State modules + the CoT controller injected as user-role at `injection_position:1, injection_depth:0`** (DnD Simulator, Internal Agenda, GM's Notebook, Inventory/Feats/Titles, Relationships RPG, World Sim, Chekhov's Gun, Internal Thoughts, Internal States master). Three mutually-exclusive CoT controllers: **Micro (4,961 chars), BOLT (5,300), MAX "Nested Gates" (9,194)** with 10 named gates. Plus Auto Image Gen SDXL prompt, Kimi K3 prompt, Debug Engine.

State is carried as **HTML `<details>` markup inside `<!-- GFX_START -->…<!-- GFX_END -->`** appended to every assistant reply, then stripped/hidden by regex for the reader and partially for the prompt. `FF5 - Context Saver (Universal)` regex: `/(?:<!--\s{0,8}GFX_START\s{0,8}-->|<internal_states>)[\s\S]{0,50000}?(?:<!--\s{0,8}GFX_END\s{0,8}-->|<\/internal_states>|$)/gi` with `placement:[2], promptOnly:true, minDepth:2`.

Main prompt uses `{{setvar::…}}` initialization + `{{user}}`/`{{char}}` macros; CoT uses `{{getvar::…}}` and `{{roll::1d20}}`.

### Why popular
Comment evidence (PullPush): "It's Freaky Frankenstein and its derivative, Realistic Frankenstein" (top answer to "what are y'alls holy grails presets in RP"), "i tried the freaky frankenstein presets, and it really changed the whole expierience", "by far the best preset I've tried, I even uninstalled some plugins because the preset took over their job". The archive quotes are in the same vein.

### Fork family (plausible alternative referents)
1. **Realistic Frankenstein** — a heavy fork of FF by another Redditor: *"I started out with vanilla Freaky Frankenstein, but when I raised some concerns about slop to u/dptgreg and my ideas didn't get merged, I took it and forked it. This is how Realistic Frankenstein was born: Freaky Frankenstein + a bunch of anti-slop micromanagement + a better realism engine."* Its own 2.0 was announced delayed/reset.
2. **Freaky FrankenSIM** (a.k.a. "FrankenSIM", by Ryah / u/Ok_Strategy_2420, FF co-author) — https://github.com/Ryah/ST-Freaky-D20-Preset, `Freaky FrankenSIM.json` (207,945 bytes), "Freaky FrankenSIM 3.0 – 13-Axis Replacement for BOND, Kishōtenketsu style story structure". README documents "FrankenSIM 2.0 – System Documentation, Version 2.5 (GREMLIN Director Update)".
3. **FrankenGarage** by daddytorgo (unrelated preset).
4. Generic usage: "a standard freaky frankenstein icebreaker" is now near-synonymous with "a jailbreak preset".

**Verdict: "Freaky Frankenstein" = dptgreg's FF preset family (current 5.4), with derivative families Realistic Frankenstein and FrankenSIM. If the user means a *character-card* creator or a different tool, the only other referent found is a 2020 hackathon repo `kescardoso/FreakyFrankenstein` (unrelated).**

Independent teardown: https://github.com/KitoFemboy16/ff5-prompting-course — parsed four FF5.2 files, reports **59 prompt definitions / 15 regex rules each**.

---

## (b) SillyTavern sampler ecosystem

Two disjoint namespaces. Text-Completion = `textgenerationwebui_settings` (raw sampler knobs, DRY/XTC live here). Chat-Completion = `oai_settings` (**no DRY/XTC at all** — only temp, top_p, top_k, min_p, top_a, rep/freq/pres penalty, seed, n).

### Knobs that matter most for RP
| Knob | Key | Typical RP | Notes |
|---|---|---|---|
| Temperature | `temp` | 0.7–1.0 | FF4 MAX+ README says "Temp 0.70–0.85 in MOST cases" |
| Top P | `top_p` | 0.90–0.95 | "Top P 0.95 in most cases" |
| Min P | `min_p` | 0.01–0.05 | best coherence lever; worsens repetition if too high |
| Top K | `top_k` | 0 or 40 | 0 = off |
| Repetition Penalty | `rep_pen` | 1.0–1.2 | range 0 = off |
| DRY multiplier | `dry_multiplier` | 0.8 | 0 = off |
| XTC probability | `xtc_probability` | 0.5 | 0 = off |
| Top A / TFS / Typical P / epsilon / eta | — | 0 / 1 / 1 / 0 / 0 | mostly off in RP presets |
| Dynatemp | `dynatemp` | off | range 0–2, exponent 1 |
| Smoothing | `smoothing_factor` | 0 | quadratic logit transform |
| Mirostat | `mirostat_mode` | 0 | **1 = llama.cpp only; 2 = universal-ish** |
| Top nsigma | `nsigma` | 0 | 2025 addition |
| Adaptive-P | `adaptive_target` | -0.01 (off) | 2026 addition; must be last |

Docs (https://docs.sillytavern.app/usage/common-settings/) state the meaning of these is "universal for all the supported backends". Note ST docs describe **XTC as removing "all except the least likely token meeting a given threshold, with a given probability"** — matching the llama.cpp/ooba implementation, not the "remove top choices" name.

### Sampler ORDER
llama.cpp `--sampler-seq` char map: `d`=dry, `k`=top_k, `y`=typ_p, `p`=top_p, `s`=top_n_sigma, `m`=min_p, `t`=temperature, `x`=xtc, `e`=penalties, `a`=adaptive_p. Default `edskypmxt`.
ST `LLAMACPP_DEFAULT_ORDER` = `['penalties','dry','top_n_sigma','top_k','typ_p','top_p','min_p','xtc','temperature','adaptive_p']`.
**Landmine:** the shipped `default/content/presets/textgen/Default.json` `samplers` array contains `"tfs_z"` and `"typical_p"`, neither of which is a valid llama.cpp sampler name — llama.cpp logs a warning and silently drops them. **Normalise on import.**
KoboldCpp numeric `sampler_order` default `[6,0,1,3,4,2,5]`. ooba `sampler_priority` (20 entries), Aphrodite `samplers_priorities` (14). Mirostat ≠ 0 **overrides the whole chain**.
Server README: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

---

## (c) DRY and XTC

### DRY (Don't Repeat Yourself)
- **Paper (now formal):** "Don't Repeat Yourself: Stopping Verbatim Loops at Sampling Time", Weidmann, Roush, Goldfeder, Basu, Shwartz-Ziv — https://arxiv.org/abs/2608.22761, **2026-08-24**. Abstract: DRY "penalizes a candidate token only when generating it would extend the current suffix into an exact continuation of a span seen earlier in the context… reduces suffix-extension rate by 47%… DRY has been adopted by popular open-source LLM inference frameworks including llama.cpp, ExLlamaV2, and text-generation-webui."
- **Original implementation/PR (p-e-w):** https://github.com/oobabooga/text-generation-webui/pull/5677 (2024-03-10 → merged 2024-05-20).
- **Formula:** `penalty = multiplier * base^(n - allowed_length)`, n = match length.
- **Recommended:** `dry_allowed_length 2 / dry_multiplier 0.8 / dry_base 1.75`. Sequence breakers default `["\n", ":", "\"", "*"]`.
- **What it fixes:** verbatim looping that rep/presence/frequency penalties only suppress at fluency-destroying strengths.

### XTC (Exclude Top Choices)
- **Original PR (p-e-w):** https://github.com/oobabooga/text-generation-webui/pull/6335 (2024-08-18 → merged 2024-09-28).
- **llama.cpp port:** https://github.com/ggml-org/llama.cpp/pull/9742 (MaggotHATE, merged 2024-10-15); adds `xtc_threshold_max`; credits LostRuins for the KoboldCpp implementation.
- **What it fixes:** removes the *most* probable tokens (all except the least likely above threshold) with probability `xtc_probability`, breaking clichés while leaving ≥1 viable choice. p-e-w's guidance: **place XTC after all truncation samplers**.
- **Defaults:** `xtc_probability 0.0` (off), `xtc_threshold 0.10`. Recommended pairing: min_p 0.02 + DRY 0.8.

### 2025–2026 additions
- **top_n_sigma** (2025, llama.cpp PR 13344/13345): `nsigma`, default −1/0 = off.
- **adaptive-p** (https://github.com/ggml-org/llama.cpp/pull/17927, merged **2026-01-15**): `adaptive_target` (default −1.0; recommended 0.55), `adaptive_decay` (0.90). Idea by MrJackSpade, implemented by ddh0. Must be last in the chain. ST exposes it gated to koboldcpp/llamacpp/ooba/tabby.
- **min_keep** — llama.cpp only; `--min-keep`.

### Backend support matrix
| Sampler | llama.cpp | KoboldCpp | ooba | Tabby/ExLlamaV2 | Aphrodite | vLLM | OpenRouter | OpenAI/Claude/Google | NovelAI |
|---|---|---|---|---|---|---|---|---|---|
| temp/top_p/top_k | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| min_p | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | ✅ |
| top_a | ✗ | ✅ | ✅ | ✅ | ✅ | ✗ | ✅ | ✗ | ✅ |
| typical_p / tfs | ✅ / ✗ | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ | ✅ |
| DRY | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | not documented | ✗ | ✗ (has `phrase_rep_pen`) |
| XTC | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | not documented | ✗ | ✗ |
| mirostat | ✅ (1&2) | ✅ (2) | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ |
| top_n_sigma | ✅ | ✅ | ✅ | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ |
| adaptive-p | ✅ | ✅ | — | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ |

### What happens when a backend does NOT support them
**SillyTavern silently drops them — no warning, no error.**
- Text-Completion path: ST builds one payload with every key, posts to its own server; `src/endpoints/backends/text-completions.js` passes the body through verbatim for ooba/koboldcpp/llamacpp/aphrodite/tabby/dreamgen/mancer, but **filters through an allowlist** (`_.pickBy(body, k => X_KEYS.includes(k))`) for openai/generic, openrouter, vllm, togetherai, featherless, infermaticai, ollama. `OPENAI_KEYS` (in `src/constants.js`) = `model, prompt, stream, temperature, top_p, frequency_penalty, presence_penalty, stop, seed, logit_bias, logprobs, max_tokens, n, best_of` — **no DRY, no XTC, no min_p, no typical_p, no tfs, no top_a**.
- Chat-Completion path: DRY/XTC are never constructed at all.
- OpenRouter: params absent from its documented list are not guaranteed forwarded; the correct mitigation is `provider.require_parameters: true`.

---

## (d) Prompt/context presets vs sampler presets

Two entirely separate prompt builders, and ST never converts between them.

**Text Completion** (KoboldCpp, llama.cpp, ooba, Tabby, Ollama, NovelAI, KoboldAI Classic, AI Horde, Mancer, DreamGen, OpenRouter-as-text): **Advanced Formatting** → Handlebars Story String + Context Template + Instruct Mode → **one flat string**.

**Chat Completion** (OpenAI, Claude, Google AI Studio/Vertex, OpenRouter, Mistral, DeepSeek, Cohere, xAI, MiniMax, Custom, …): **Prompt Manager** → ordered drag-drop list of named prompts → `messages[]` array. Instruct Mode and Context Templates are explicitly inert here.

Prompt-manager semantics (docs + `PromptManager.js`): `injection_position` **0 = RELATIVE** (emitted in list order), **1 = ABSOLUTE/In-Chat** (spliced into chat history at `injection_depth`, where **0 = after the last message**, 1 = before it, …). Same role+depth are grouped and ordered by `injection_order` (default 100). `INJECTION_POSITION = {RELATIVE:0, ABSOLUTE:1}`, `DEFAULT_DEPTH=4`, `DEFAULT_ORDER=100`.
Pinned prompts that can only be toggled, not removed: main, worldInfoBefore/After, personaDescription, charDescription, charPersonality, scenario, enhanceDefinitions, nsfw (Auxiliary), dialogueExamples, chatHistory, jailbreak (Post-History Instructions).

Instruct templates fields: `input_sequence`, `input_suffix`, `output_sequence`, `output_suffix`, `system_sequence`, `system_suffix`, `stop_sequence`, `wrap`, `macro`, `names_behavior` (`none|force|always`), `first/last_output_sequence`, `first/last_input_sequence`, `last_system_sequence`, `user_alignment_message`, `system_same_as_user`, `sequences_as_stop_strings`, `story_string_prefix/suffix`, `activation_regex`, `skip_examples`.

Chat-Completion `names_behavior` is **numeric**: `NONE=-1, DEFAULT=0, COMPLETION=1, CONTENT=2`.

### Provider adaptation ST performs
`use_sysprompt` merges leading system messages into Claude's top-level `system` field / Google's `system_instruction`; other system messages are demoted to `user`. Name folding ("Name: ") for Claude/Google/Mistral/xAI. Prompt Post-Processing levels `'' | merge | semi | strict | single` (+ `_tools` variants). Claude temp clamp 1.0, Mistral 1.5, OpenAI 2.0. `claude-(fable|opus-5|sonnet-5)` **deletes** temperature/top_p/top_k entirely. OpenAI max 4 stop strings; Google ≤5 strings each 1–16 chars; Claude unlimited. Assistant prefill only for Claude, and rejected by `claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8)` and Claude 5.

### What a clone MUST replicate to import existing ST presets
**Tier 0:** preset schema (`prompts[]` + `prompt_order[]` incl. `character_id` 100000/100001); macro engine (`{{user}}`, `{{char}}`, `{{group}}`, `{{description}}`, `{{personality}}`, `{{scenario}}`, `{{persona}}`, `{{charPrompt}}`, `{{charInstruction}}`, `{{original}}`, `{{time}}`, `{{date}}`, `{{newline}}`, `{{trim}}`, `{{noop}}`, and legacy `<USER>/<CHAR>/<BOT>/<GROUP>`); variables (`getvar/setvar/addvar/incvar/decvar/getglobalvar/…`); `{{random}}`, `{{pick}}`, `{{roll:1d20}}`; relative/absolute injection assembly; provider message serialisation.
**Tier 1:** character card model, World Info engine (all 8 positions, recursion, inclusion groups, outlets), persona, Author's Note.
**Tier 2:** **regex engine** (Affects targets, min/max depth, `{{match}}`, trim-out, `markdownOnly`/`promptOnly` ephemerality); Text-Completion pipeline (Handlebars story string, separators, names-as-stop-strings); PHI in both pipelines; per-provider rewriting.
**Tier 3 (needed for FF5/Nemo/Nimbus class):** depth-0 user-role injection; reasoning blocks (prefix/suffix/separator + "add to prompts"); prompt post-processing; legacy migrations (`names_in_completion→names_behavior`, `claude_use_sysprompt→use_sysprompt`, `main_prompt/nsfw_prompt/jailbreak_prompt→prompts[]`); token counting.
**Tier 4:** Summarize (`{{summary}}`), Vector Storage, Data Bank, Objective, Quick Replies, STscript; extension-side preset features (NemoPresetExt externalises prompt bodies to server files and leaves stubs — a clone reading only the JSON sees stubs); HTML rendering for regex-produced styling.

FF5 additionally **requires its regex pack** ("FF5 Regex 3.0 … ABSOLUTELY REQUIRED - but shipped with presets"), and the standalone `tavo1_Strip_Old_Plot_Momentum.json` / `tavo1_Hide_Plot_Summary.json` files assume a frontend that emits a Plot Momentum block.

---

## (e) Preset JSON schemas (for import)

**Directory layout correction:** there is **no** `presets/chat-completion/` or `presets/text-completion/`. Actual: `openai/`, `textgen/`, `context/`, `instruct/`, `sysprompt/`, `reasoning/`, `kobold/`, `novel/`, `moving-ui/`, `quick-replies/`. Mapping in `src/endpoints/presets.js`.

### Chat-completion preset (`openai/`)
Real FF5.4 top-level keys (exactly 12):
`continue_nudge_prompt, extensions, group_nudge_prompt, impersonation_prompt, new_chat_prompt, new_example_chat_prompt, new_group_chat_prompt, personality_format, prompt_order, prompts, scenario_format, wi_format`
FF5.2 MAX has the same **minus `extensions`**. FF4 MAX+ likewise (11 keys, no `extensions`).
Community presets add samplers + connection keys (Sinatra: `temperature, top_p, top_k, min_p, top_a, repetition_penalty, frequency_penalty, presence_penalty, seed, n, openai_max_context, openai_max_tokens, stream_openai, names_behavior, use_sysprompt, continue_postfix, continue_prefill, squash_system_messages, media_inlining, reasoning_effort, show_thoughts, function_calling, tool_call_recurse_limit, enable_web_search, max_context_unlocked, bias_preset_selected, …`).

Prompt entry (union of fields seen in real files): `identifier, name, role, content, system_prompt, marker, enabled, injection_position, injection_depth, injection_order, injection_trigger, forbid_overrides, extension, position`.
`prompt_order`: `[{ "character_id": 100000, "order": [{"identifier": "...", "enabled": true}] }, { "character_id": 100001, … }]`. **100000 = solo, 100001 = group.**

### Text-completion preset (`textgen/`)
Flat object, no `name`:
`temp, temperature_last, top_p, top_k, top_a, tfs, epsilon_cutoff, eta_cutoff, typical_p, min_p, rep_pen, rep_pen_range, rep_pen_decay, rep_pen_slope, no_repeat_ngram_size, penalty_alpha, num_beams, length_penalty, min_length, encoder_rep_pen, freq_pen, presence_pen, skew, do_sample, early_stopping, dynatemp, min_temp, max_temp, dynatemp_exponent, smoothing_factor, smoothing_curve, dry_allowed_length, dry_multiplier, dry_base, dry_sequence_breakers, dry_penalty_last_n, add_bos_token, ban_eos_token, skip_special_tokens, mirostat_mode, mirostat_tau, mirostat_eta, guidance_scale, negative_prompt, grammar_string, json_schema, json_schema_allow_empty, banned_tokens, sampler_priority[], samplers[], samplers_priorities[], ignore_eos_token, spaces_between_special_tokens, speculative_ngram, sampler_order[], logit_bias[], xtc_threshold, xtc_probability, nsigma, min_keep, rep_pen_size`.
Note `dry_sequence_breakers` is a **JSON-encoded string**, not an array.

### Context / instruct / sysprompt / reasoning
- context: `{story_string, example_separator, chat_start, use_stop_strings, names_as_stop_strings, story_string_position, story_string_depth, story_string_role, always_force_name2, trim_sentences, single_line, name}`
- instruct: `{input_sequence, output_sequence, last_output_sequence, system_sequence, stop_sequence, wrap, macro, names_behavior, activation_regex, first_output_sequence, skip_examples, output_suffix, input_suffix, system_suffix, user_alignment_message, system_same_as_user, last_system_sequence, first_input_sequence, last_input_sequence, sequences_as_stop_strings, story_string_prefix, story_string_suffix, name}`
- sysprompt: `{name, content, post_history}`
- reasoning: `{name, prefix, suffix, separator}`

### Import detection (ST's own key sniffing, `preset-manager.js`)
```
isPossiblyInstructData      = name + input_sequence + output_sequence
isPossiblyContextData       = name + story_string
isPossiblySystemPromptData  = name + content
isPossiblyTextCompletionData= temp + top_k + top_p + rep_pen
isPossiblyReasoningData     = name + prefix + suffix + separator
```
Order: instruct → context → sysprompt → text-completion → reasoning. **Chat-completion presets are not caught by any of these** — they use a separate importer that accepts any JSON and does no sniffing.
Per-API import: `data.name ?? filename`, saves via `POST /api/presets/save` with 4-space indent. Accepts `.json` and `.settings`.
**No version field anywhere.** Migrations are field-level on load (`migrateChatCompletionSettings`, `registerPromptManagerMigration`, `migrateInstructModeSettings`).

### Regex extension namespace
```json
"extensions": { "regex_scripts": [ { "id","scriptName","findRegex","replaceString","trimStrings":[],
  "placement":[2], "disabled":false, "markdownOnly":false, "promptOnly":false, "runOnEdit":false,
  "substituteRegex":0, "minDepth":null, "maxDepth":null } ] }
```
`placement` enum (verified, `public/scripts/extensions/regex/engine.js`): `MD_DISPLAY:0` (deprecated), `USER_INPUT:1`, `AI_OUTPUT:2`, `SLASH_COMMAND:3`, `WORLD_INFO:5`, `REASONING:6` (4 = legacy sendAs). FF5 uses `[2]` mostly, `[2,1]` for thought deletion. `markdownOnly` = affects display only; `promptOnly` = affects the outgoing prompt only (this is how FF5 strips its own state markup from context without hiding it in chat).

### Real community preset files (URLs)
- FF 5.4 (canonical): https://www.mediafire.com/file/9f70q840092j5lr/ (via https://rentry.co/freaky-frankenstein-presets)
- FF 4 MAX+ mirror: https://raw.githubusercontent.com/EUM27/Hushline-cHat/main/프리셋/Freaky%20Frankenstein%204%20MAX+.json
- FF 5.0 registry entry: https://raw.githubusercontent.com/MentallyQuill/Tavernary/main/data/registry/projects/reddit-1v9u18m.json
- FrankenSIM: https://raw.githubusercontent.com/Ryah/ST-Freaky-D20-Preset/main/Freaky%20FrankenSIM.json
- Sinatra: https://raw.githubusercontent.com/KrowleyKrd/SinatraPreset/main/!Sinatra1.json
- Stab's EDH (178★): https://raw.githubusercontent.com/Zorgonatis/Stabs-EDH/main/Stabs-GLM5.1-Directives-v3.0.1.json
- Nemo Engine (181★): https://raw.githubusercontent.com/NemoVonNirgend/NemoEngine/main/Nemo%20Engine/Nemo%20Engine%2011.5.1%20-%20General%20RP.json
- Nimbus (Tavo): https://github.com/clowuds/Tavo-SillyTavern-NimbusPreset
- ST defaults: https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/default/content/presets/{openai,textgen,context,instruct,sysprompt,reasoning}/<name>.json

ST version anchor: `release` branch = **1.19.0**, tagged 2026-09-14; HEAD commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

### Caveats
- No community **text-completion** preset found on GitHub (code search for `rep_pen_slope` in preset JSON returned zero) — the textgen format is verified only from ST's own shipped files.
- Whether OpenRouter forwards `dry_*`/`xtc_*` is undocumented; treat as unsupported without `provider.require_parameters`.
- Reddit was DNS-sinkholed; PullPush rate-limited after the first queries. Reddit-derived claims are from the successful first pulls.
