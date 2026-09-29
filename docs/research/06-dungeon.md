# World simulation, state tracking & multi-character scenes — research

Scope: prior art and failure modes for "dungeon/world stuff" and a persistent
time/location/detail tracker in a BYOK AI roleplay app. All repo metadata
2026-09-29; docs read live.

---

## 1. AI Dungeon today (Latitude)

**Context assembly.** The prompt is built as: AI Instructions → Plot Essentials →
World Lore (triggered Story Cards) → Story Summary → Memories → Recent Story →
`[Author's note: …]` → last response → `frontMemory`. Free-tier context is ~4,000
tokens; oldest story text is trimmed first. Latitude states outright that when
text falls out of context "it's just making it up as best it can."

**Memory System** (the Pathfinder release, adapted from their abandoned Voyage
product) has two halves:
- *Memories*: each is an LLM summary of **6 actions**. First memory at action 12
  (summarizing actions 1–6); then one per 6 actions, forever. Recent 6 actions are
  never summarized, so editing/undoing the last 6 doesn't corrupt memory.
- *Auto Summarization*: a rolling `Story Summary` plot component, re-summarized
  every **15 actions** and compressed when too long. Memories fill the gap between
  the summary's cadence and the present.
- *Memory Bank*: memories are embedded; retrieval ranks all memories by embedding
  similarity to **the most recent action**, and the top ones that fit a fixed slice
  of the context window are inserted ("Used Memories"). Tier caps: Free 25,
  Champion 100, Legend 200, Mythic 400. When full, least-used memories are evicted
  ("Forgotten Memories"). Latitude explicitly notes the design is borrowed from the
  human brain: compression + cued retrieval.

**Deliberate omission.** Latitude says the Voyage game-state tracker ("health,
quests, inventory, levels, and player characteristics") was **not** carried over
because "AI Dungeon is a collaborative storytelling experience." This is the
single clearest statement that AID has no deterministic world state by design.

**Story Cards / World Info.** Keyword-triggered lore notes. Triggers match the
input *and output*; cards stay active "for a variable period depending on your
context size." Community reports (Jan 2026) that the entry is added *after* the
current output so it cannot affect the same generation that triggered it, that
matching is literal substring ("elf" matches "shelf"), and that cards compete for
the same token budget as chat history and lose.

**Scripting.** A JS API with 3 lifecycle hooks — `onInput`, `onModelContext`,
`onOutput` — each running `sharedLibrary` then the `Input`/`Context`/`Output`
script. Scripts get `info`, `history`, `state`, `storyCards`, `text` and return
`{text, stop}`. Story Cards are mutable from script
(`addStoryCard`/`updateStoryCard`/`removeStoryCard`), which is how the community
builds ad-hoc state trackers. Documented bug: Story Card manipulation fails when
Memory Bank is off. Banned Words was deprecated (logit bias unsupported on modern
models); AI Instructions replaced it.

**Scenarios** are the shareable unit: Prompt, Plot Essentials, Author's Note,
Story Cards, AI Instructions, Scripting. **Heroes** — the announced successor with
stats/skills/classes/inventory/quests/map/factions — was renamed **Voyage** and
spun out as a separate product (see §5).

**What users hate.** Latitude's own survey: "Improved Memory System" is the #1
requested improvement (41%), and AI Memory is rated **5.62/10 — the lowest-rated
feature**. Recurring, dated complaints: summaries that mis-attribute identity
("you are Henry / Avery / Mia"; "You are the forest"); auto-summarization whose
token threshold wasn't enforced so the global summary grew monotonically (a
Latitude dev confirmed this in-thread); no way to see or edit the summarization
prompt; no per-section context quotas ("Adventure & Memories monopolizes
context"); no native HP/inventory/XP tracking — users write 30,000-line scripts
for it. The 2021 content-filter/privacy breach (human moderators reading private
stories, false positives, ~100 leaked stories) is the origin of the local-first /
BYOK reflex and is still cited in 2023–2026 retrospectives. Latitude's "Walls
Approach" post committed to no moderation of unpublished single-player content and
to encrypting stories at rest — the direct ancestor of the BYOK pitch.

---

## 2. NovelAI

**Context sections** are first-class and budgeted individually. Memory (top of
context by default), Author's Note (near the bottom; "the closer to the bottom,
the more impact"), Lorebook entries, and story text each get their own
**Prefix, Suffix, Token Budget, Reserved Tokens, Insertion Order, Insertion
Position, Trim Direction, Max Trim Type, Insertion Type**. Reserved tokens are
allocated before anything is placed, and insertion order decides who gets budget
first — i.e. NovelAI solves the "lore loses to chat history" problem structurally.
Context is assembled in numbered **Stages** and fully inspectable in the Context
Viewer, including *why* each entry was or wasn't included.

**Lorebook**: keys are case-insensitive, support `/regex/` (flags i, s, m, u), and
`A & B` requires both within the search window. `Always On` bypasses keys; `Hide`
hides an entry from the player but not the AI. Placement adds **Key-Relative
Insertion** (insert at the last matched key), **Cascading activation** (keys
matched against non-story context), and **Search Range** up to 10,000 characters.
Categories can be grouped into a **Subcontext** with shared placement.
**Advanced Conditions** (Xialong / GLM-4.6 only) are the closest thing any
consumer product has to a rules engine: `Keyword Match`, `Lore Entry Active`,
`AI Model`, `Story Mode`, `Random Chance` (%), **`Numeric Comparison`** against
`currentStep`/`paragraphCount`/`characterCount` — docs name the use case as "a
sort of countdown clock until a specific story event happens" — `String
Comparison` against `storyText`/`memoryText`/`authorsNoteText`, plus AND/OR/NOT
groups. Multiple top-level conditions OR together.

**Ephemeral Context** is a native timed-state primitive:
`{+3~10,-2:Example}` = activate in 3 steps, stay 10 steps, insert one line from
the bottom; suffix `r` on the delay makes it repeat. This is the only built-in
mechanism for state that changes over turns without a keyword.

**Text Adventure mode** is a prompt-shape, not a system: `>`-prefixed lines are
player *intent*, hidden from the story panel and visible only in Context. `Do`/`Say`
modes auto-prefix (`> You say `, `> You ask `, `> You yell `); `l`/`i`/`x <thing>`/
`n,s,e,w,u,d`/`z` expand to canned actions; `*` or `,` at the end lets the AI
complete the action; bare `!`/`?` are random-action/random-question wildcards;
`"`/`>` switch mode inline; `!` at the start passes text through verbatim as a
non-player-directed story event. There is **no stat sheet, no inventory, no
time** — community threads ask for exactly this and there is no hook for it. The
docs also warn the AI "sometimes won't state the action word for word."

**Special symbols** are the closest thing to a state grammar: `[ London, 1821 ]`
or `[ Monday, 8:00 A.M. ]` switches scene/time; `[ John ]` switches viewpoint;
`----` opens an out-of-prose **information block** (the documented idiom for
glossaries and character lists); `─` (the "LitRPG line") marks stat/attribute/
possession lines; `***` is a scene break; `{ … }` is an instruction; `##` at line
start comments a line out of context.

**State of the product.** Tiers: Tablet $10, Scroll $15 (larger context), Opus $25
(28,672 tokens). AetherRoom was formally cancelled in 2026. Recurring complaints:
lorebook keys failing to activate from story text; context too small; Text
Adventure "is not really a game"; the newest model ignores `{}` commands, refuses
to act as a GM, and hijacks the player's character.

---

## 3. State tracking: how existing tools do it, and what breaks

Three families exist in the SillyTavern ecosystem. **No system keeps state outside
the token stream** — every one round-trips it through the model each turn, which is
exactly where the documented failures live.

**A. In-context state blocks.** An LLM (or a second-pass LLM) emits a
JSON/YAML/XML snapshot, which is re-injected each turn at a chosen depth via
`setExtensionPrompt` or a World Info entry; the snapshot is stored in chat metadata
or per-message fields.
- `SpicyMarinara/rpg-companion-sillytavern` (316★, pushed 2026-08-29, **now
  deprecated** toward `Pasta-Devs/Marinara-Engine`, 681★). Tracks stats, an info
  box (date/weather/temperature/time/location/recent events), present characters
  with relationship badges and thoughts, inventory v2, quests. Two modes:
  *Together* (tracker emitted inside the RP reply, then parsed out — one call,
  risks polluting prose) and *Separate* (a second API call that emits only tracker
  data, then a context summary is injected next turn — cleaner prose, extra call).
  State is stored **per swipe** so each swipe keeps its own tracker.
- `kaldigo/SillyTavern-Tracker` (101★, pushed 2025-08-17, no license): inline /
  single-stage / two-stage modes, JSON or YAML, state at `chat[mesId].tracker`.
- `bmen25124/SillyTavern-WTracker` (40★, MIT): JSON-Schema-defined state with
  optional **grammar sampling** to constrain output; connection profiles so the
  tracker can use a different endpoint.
- `Zaakh/SillyTavern-zTracker` (15★, MIT): multi-module (Scene Tracker / Plot Log /
  Plot Steer), each with its own schema, prompt, connection and history chaining.
- `prolix-oc/SillyTavern-SimTracker` (63★, sunset): JSON block in the message,
  rendered as cards via Handlebars templates, with `{{sim_tracker}}` macros;
  schema is `{worldData:{current_date,current_time}, characters:[{name,…}]}`.
- `Lodactio/Extension-Summaryception` (165★): layered recursive summarization with
  a separate **scribe** model that emits JSON per character.

**B. Deterministic engine state.** Host code owns the numbers and injects a
read-only memo.
- `MultihogAurelius/SillyTavern-MultihogDnDFramework` (85★, GPL-3.0, pushed
  2026-09-26) is the most complete. A dedicated **second-pass model** maintains a
  rolling **State Memo** injected as `## TRACKER STATE 0 (Current)` with a typed
  block grammar `[CHARACTER] [PARTY] [BENCHED PARTY] [COMBAT] [INVENTORY]
  [ABILITIES] [SPELLS] [TIME] [XP] [QUESTS]`; `[TIME]` deltas drive automatic
  buff/debuff decay. It runs a **dual RNG**: a pre-seeded deterministic dice queue
  injected every turn (cheap, smooth for combat), plus tool-call RNG with
  **commitment** — the model must declare a DC before seeing the roll, which is the
  anti-sycophancy trick. It also replaces SillyTavern's own `RollTheDice` tool with
  a DC-aware version, unregisters dice tools during deterministic-queue combat, and
  ships a Lorebook Agent, World Progression (location-centric macro simulator) and
  Map Evolution (dungeons repopulate, third parties scavenge). Memo/map histories
  live as compressed files under `data/<user>/user/files/` with a checksum in
  settings, after a bug report showed 485 MB of snapshots broke SillyTavern's
  startup entirely.

**C. Native primitives.** World Info **timed effects** — `sticky` (active N
messages), `cooldown` (can't re-trigger for N), `delay` (needs ≥N messages) —
stored in `chat_metadata.timedWorldInfo`, plus `{{getvar}}`/`{{setvar}}`/
`{{incvar}}` chat variables, `{{roll::1d20}}`, `{{random}}`, `{{pick}}` (stable
per chat position), and STscript `/inject id= position= depth=`, `/setvar`,
`/getentryfield`. Timed effects are removed if the chat doesn't advance (swipe or
delete), editing the entry clears them, and re-triggering does not refresh the
duration. Only two `@@` decorators actually exist (`@@activate`,
`@@dont_activate`) and they are undocumented; there is no `@@depth` family.

**Dice.** SillyTavern's official Dice extension (33★, AGPL-3.0) uses the `droll`
library. Critically, **manual rolls are "just for show"** — they only reach the
model via a visible system message, a macro, or the optional `RollTheDice` function
tool (off by default).

### Documented failure modes (with evidence)

1. **Lost updates when a summarizer rewrites state.** Multihog issue #86: the
   delta prompt `## OUTPUT ONLY CHANGED OR NEW SECTIONS:` ran even in Full Review
   mode, so "each time I use the instruct window, some portion of the state is
   removed (like all my equipped gear, or my currency value is truncated)."
2. **Model fails to emit state at all.** rpg-companion issues #144/#146/#147/#126:
   "a large JSON block in the narration text and none of the stats or inventory
   update"; incomplete JSON.
3. **Swipe/regeneration desync.** rpg-companion #148: a new swipe reuses the
   previous swipe's context. kaldigo #36: tracker missing from second and
   subsequent `/gen` swipes in group chat.
4. **Token/storage bloat.** Multihog #95: 746 map snapshots (57 unique) grew
   `settings.json` to 485 MB, past V8's string limit; SillyTavern stopped loading.
5. **Concurrency.** kaldigo #32 (stray `(Continue)` re-processed every turn), #35
   (infinite reconnect loop when the tracker's connection profile differs), #38
   (tracker fails when the built-in summarizer shares the same connection).
6. **Mutually-exclusive state isn't expressible.** SillyTavern #5193: no persistent
   `condition` field; inclusion groups only arbitrate within one scan pass;
   `probability=0` disables rather than toggles.
7. **Cross-chat leakage.** SillyTavern #6027: chat-scoped lorebooks get promoted
   into global World Info, so "lorebooks accumulate unrelated lore from prior
   scenarios — especially damaging when lorebooks are used as long-term memory."
8. **Identity corruption.** Multihog #32 emitted `{{user}} (profession)` where a
   character name was expected.

---

## 4. Structured-state approaches: mechanics and failure modes

| Mechanism | How it works | Pros | Cons / known failures |
|---|---|---|---|
| **Tool use / function calling** | Model returns a schema-validated `tool_use`; app executes, returns `tool_result` | Schema-guaranteed args; prose and state separated; parallel calls | Extra round trip; `strict:true` **errors** on unsupported schema (`allOf`, `not`, `if/then/else`; on fine-tunes also `pattern`, `format`, numeric bounds); refusals bypass the schema; content-filter truncation yields partial JSON; text before `tool_result` → 400; **forced `tool_choice` is rejected under manual extended thinking**; with thinking disabled, Claude Opus 5 "occasionally writes a tool call into its user-facing text instead of emitting a structured `tool_use` block" and leaks `<thinking>` tags into visible prose |
| **JSON side-channel / hidden scratchpad** | Model emits JSON or a tagged block; UI strips it | Cheapest; single call | Model does two jobs at once; leakage into prose is documented (SkyrimNet strips `<thinking>` from TTS because DeepSeek-R1/QwQ **voiced scratchpad text**); CoT explanations are systematically unfaithful; "fossil state" when the scribe only writes for characters a passage touched |
| **Separate cheap-model state call** | RP model narrates only; a second call maintains JSON state; app validates and re-injects compact **prose** | No prose contamination; model-agnostic; cheap; testable in isolation | One extra call/turn; needs its own consistency rules; concurrency hazards (Summaryception's documented lock bug) |
| **State block at top of context** | Serialized state prepended to the prompt | Zero extra calls; inspectable; user-editable | Worst position for recall precisely when the story is longest |

**Position matters and is measured.** Lost in the Middle: performance is highest
when the relevant information is at the beginning **or end** and degrades in the
middle. Chroma's context rot: 18 models degrade non-uniformly with input length,
and topically related distractors amplify it. NoLiMa: at 32K tokens 11 of 13
long-context models fall below 50% of their short-context baseline. Anthropic's own
guidance is to put longform data at the top and instructions at the end ("queries
at the end can improve response quality by up to 30 percent"). SillyTavern's docs
encode the same finding: higher insertion order goes closer to the end because it
"has more impact"; Author's Note says "the closer … to the bottom of the prompt,
the more impact it has."

**Constrained decoding has a measurable quality tax.** "The Constraint Tax" found
hard answer-only schema decoding raised validity 61.5%→100% but **lowered answer
accuracy 19.7%→11.0%** on sub-3B models; a calendar tool-call task fell 91.5%→48.0%
executable accuracy at 100% validity. Its prescription — *reason free, constrain
late* — means constrain only the state call, never the narration. dottxt's
comparison found engines differ mainly in *false rejections* (over-constraining),
and on BFCL both llguidance and xgrammar scored **below** the unconstrained
baseline on Qwen3-14B. llama.cpp's GBNF silently skips unsupported schema features
and **does not inject the schema into the prompt** — you must describe the shape in
prose yourself.

**Recommendation.** A separate cheap-model state call, validated client-side
(Pydantic/Zod) with the validation error attached on retry, whose output is
re-injected as **compact prose at the end of context** — not JSON, not at the top.
Treat every field as *as-of turn N*, never as current truth. For multi-bot scenes,
one batched call per turn returning an array of per-character deltas merged by
name beats one call per character.

---

## 5. Published AI GM apps and their architectures

The field splits in two. **Model-as-game** (AI Dungeon, NovelAI, SillyTavern)
lets the LLM both narrate and adjudicate, so state is only what survives the
context window. **Engine-under-the-model** holds world state in a deterministic
store the model may only mutate through validated tools. Only the second family
solves persistent time/location/state, and they converge on four mechanisms:
structured store → hierarchical summarization → vector retrieval → keyword lore
injection.

**Commercial.** *Voyage* (Latitude, launched 2026-04-21) is the flagship. Its
**World Engine** is "a deterministic system that governs world state, character
memory, and rule enforcement" that "sits atop the underlying AI as an impartial
Game Master" and "tracks health, inventory, currency, geography, relationships and
long-term consequences across thousands of turns so the AI can't hallucinate them
away" — five years of R&D and six prototype engines. AI generates code for worlds,
quests and mechanics from a plain-English description; multiple AI systems narrate,
manage gameplay, track characters/objects and remember backstories. 160,000 unique
AI-generated characters in beta; ~3,000 choices per average player. Free to play,
subscriptions at $15/$30/$50; Google AI Futures Fund partnership; Gemini Flash for
images, Gemma for text/audio/video. Latitude's *Heroes* dev logs are the best
public post-mortem of the failure modes: "AI fever dream" — *quest drift* (a rescue
mission becomes a cheese tasting), *NPC amnesia* (a companion returns with a
different personality), *make-believe items* (declaring you had the legendary axe
all along). Their fix is **"reactive entity expansion: planning just enough, at
just the right time"** — when an NPC gives a quest, the brother, the location and
the layout are generated *then*, so every quest is completable; plus a map with
real coordinates, planned-and-maintained characters, a faction system that tracks
stance, and items that exist at specific locations. "A world that resists" — you
cannot pull a rocket launcher in a medieval tavern — is framed as what makes
success meaningful. *NovelAI* is the model-as-game extreme (§2). *Hidden Door*,
*Fables/Friends & Fables*, *DreamGen* and *Talkie* fill out the hosted tier.

**Open source engines worth reading** (all pushed 2026): *Aventuras*
(Tauri+SvelteKit+SQLite, AGPL-3.0, 204★) — `Character`/`Location`/`Item`/
`StoryBeat` rows rewritten by a classifier each turn, with a relative clock
`{years,days,hours,minutes}` and range reconciliation; *NarrativeEngine-P* (MIT,
100★) — a "Divergence Register" fact sheet with `knownBy` permissions that blocks
NPC metagaming, plus a lossless scene archive with two-phase retrieval
(chapter scan → scene retrieval); *loreweaver* (MIT, 62★) — a deterministic engine
owns dice/sheets/clocks while the AI Keeper narrates via function calling and a
Scribe reconciles the ledger; *Project Lunar* (MIT, 38★) — append-only event store
plus Neo4j, with a 4-tier memory and a `WorldReactor` that ticks off-screen change
by elapsed in-narrative time; *Chasm* (MIT) — world state as a **git repo of
markdown** (`WORLD_STATE.md`, `places/*.md`, `characters/*.md`, append-only
`events/*.md`); *Gamentic* (MIT, 24★) — explicit state machine, single SQLite
truth, model mutates state only through validated tools; *openovel* — file-native
dual loop with **no vector store at all**; *Cultivation World Simulator* (2,102★)
— every NPC an independent LLM agent. *KoboldAI-Client* (3,953★) is dormant since
2025-01.

---

## 6. Multi-agent roleplay: designs and isolation

**Generative Agents** (Park et al., UIST 2023) is the reference architecture. A
**memory stream** holds records with a description, creation timestamp and last-access
timestamp. Retrieval scores every record as
`score = α_recency·recency + α_importance·importance + α_relevance·relevance`
(all α=1, each term min-max normalized to [0,1]): recency is exponential decay
(0.995 per in-game hour since last access), importance is an LLM 1–10 poignancy
rating assigned **at creation time**, relevance is cosine similarity of embeddings
against the current query. **Reflection** fires when the summed importance of
recent events exceeds 150 (~2–3× per day): the model is shown the 100 most recent
records and asked for the 3 most salient high-level questions; those become
retrieval queries; the model then extracts 5 insights citing the specific records
that support them, and the reflection is stored *with pointers to its evidence*.
Reflections can reflect on reflections, producing trees. **Planning** is top-down
and recursive: a day plan in 5–8 chunks, decomposed to hours, then to 5–15 minute
actions. At each tick the agent is prompted with a summary description, the time,
its status, the observation, and retrieved context to decide whether to react and
re-plan. Agents hold their own subgraph of the environment tree and **can go
stale** — they are not omniscient.

Measured outcomes and failures: information diffusion from 1→13 of 25 agents for
the party (4%→52%) and 1→8 for the candidacy; network density 0.167→0.74; 5 of 12
invitees attended; **1.3% of 453 relationship claims were hallucinated**. The
paper names the three dominant error modes: *failed retrieval*, *fabricated
embellishment* (Isabella invented an announcement Sam never planned; Yuriko
conflated her neighbour with the economist Adam Smith), and *instruction-tuning
leakage* — agents were overly formal and **overly agreeable**, so Isabella
gradually adopted other agents' interests as her own. As memory grew, agents
picked less appropriate locations (the bar for lunch). Physical norms not stated
in language (a one-person bathroom, closing time) were violated. Cost: thousands
of dollars of tokens and multiple days for 25 agents over two simulated days.

**Dramatron** (DeepMind, arXiv:2209.14958, CHI 2023) is the hierarchical-generation
prior art: log line → title + characters → plot (each scene = location +
narrative-element tag + beat) → location descriptions → per-scene dialogue, with
prompt chaining down the hierarchy and human editing allowed at every level.
Participants' structural criticism is directly relevant: because scenes are
generated in parallel, **consecutive scenes are inconsistent** — the hierarchy buys
long-range coherence at the cost of local continuity. Repetition loops were handled
with a block-repetition detector that reseeds sampling.

**AI Dungeon 2's original mechanism** (BYU blog post, 2019-11-21; no arXiv paper):
a fixed *context sentence* is always fed to the model to keep it grounded in the
chosen setting, and each action is prompted with the context sentence **plus the
past 8 action–result pairs**. The original post names its own failure mode: "the
model has difficulty keeping track of who is who, especially in dialogue."

**Other published director/actor designs.** *IBSEN* (ACL 2024) has a director agent
write plot outlines, instruct actor agents, and **reschedule the plot when human
players participate** — the closest published analogue to auto-casting. *ChatRPG*
(arXiv:2502.19519) is the most instructive negative result: v1 was a single long
prompt and, as context approached the window limit, "only the last part of the
prompt was utilized, and the first part seemed forgotten," with players reporting
enemy/item counts drifting and the GM forgetting an item just picked up; v2
replaced it with **Narrator + Archivist ReAct agents** carrying JSON tools
(`WoundCharacter`/`HealCharacter`/`Battle`, `UpdateCharacter`/`UpdateEnvironment`)
and improved modularity, immersion and curiosity significantly. *SENNA* (IUI '26)
splits five roles — Scribe, Examiner, Navigator, Narrator, Archivist — and drives a
pre-written adventure through a **Narrative Graph**; its empirical finding on
steering is that players preferred redirection grounded in the game's internal
logic and **rejected "hard denials."** *BookWorld* (ACL 2025) uses role agents plus
a **world agent** that selects participants by shared location, with scenes as the
minimal narrative unit, per-agent STM/LTM, a discrete map where travel costs
scenes, and *memoryless temporary* agents for incidental NPCs. *ChatDev* segments
memory by phase, carrying only *solutions* across phases. *MetaGPT* replaces
broadcast with a **shared message pool and role-scoped publish-subscribe**,
explicitly because sharing everything causes "information overload"; its named
failures are "cascading hallucinations caused by naively chaining LLMs," role
flipping, instruction repeating and infinite message loops. *TALES* (arXiv:2504.14128)
found even top agents fail to reach **15%** on games designed for human enjoyment.

**SillyTavern group chats** are the practical multi-bot implementation, and were
read from source (`public/scripts/group-chats.js`). Reply order strategies:
`NATURAL=0, LIST=1, MANUAL=2, POOLED=3`. Natural Order extracts whole-word mentions
from the last message, excludes the previous speaker unless self-responses are on,
then **shuffles and rolls** each remaining member against its `talkativeness`
(default 0.5), falling back to a random chatty member. Pooled picks one random
member who hasn't spoken since the last user message. Auto-mode runs the strategy
hands-free on a 5-second delay; `force_chid` bypasses it. Context handling is
`SWAP=0` (only the active speaker's card enters the prompt — the default) or
`APPEND=1/2` (all members' cards concatenated). The critical fact, stated in the
docs: *"No matter the choice, the group chat history is always shared between all
the members."* Swap swaps the **card**, not the **memory** — **SillyTavern core has
no per-character knowledge isolation at all**. Join mode is documented to cause
"characters being confused about themselves, having merged personalities, uncertain
traits."

**Negative finding.** The widely-cited "SillyTavern group chat auto moderator"
extension **does not appear to exist**. It was searched for across GitHub repo
search, the official asset manifest, the official docs extension index, the
community list, the Tavernary catalog (488 projects) and `sillytavern.dev`;
`SillyTavern/Extension-GroupChatAutoModerator` and `Extension-AutoModerator` both
404. What actually serves the need is the built-in activation strategies, the
`AndreiNicu/SillyTavern` fork's **LLM-routed reply strategy** — a small model returns
an ordered queue of speakers, re-polled when drained, capped by max consecutive
turns with the router biased toward stopping; "Director"/"NPC" tagged cards are
auto-split into a separate roster and off-roster names are performed by a Director
card via a one-shot in-character note — plus `Spiriax/Natural-Extended`,
`thexyzzyone/STGroupResponderSelector`, and `ficklef0x/sillytavern-SmartDirector`
(LLM picks the next speaker as JSON, with 8 fallback parsing strategies and
dedicated presets for reasoning models). `BobTheBinChicken/Ultimate-ChatAssistant`
ships a dedicated narrator with a "Response Request Queue" framed as "a film
director giving scene notes" plus hidden `@@REQUEST_MET@@`/`@@UPDATE_STATE@@`
tokens at three injection depths.

**Knowledge isolation techniques, ranked by enforceability.**
1. **Per-memory visibility ACL filtered before ranking** — the only mechanically
   sound approach found. `yantrikos/chronicler` stores each memory with
   `visible_to: string[]`, tagging it with the audience present when the statement
   was made, and filters **before** ranking because a post-rank filter still leaks
   through the ranker's inclusion decision. Repeating a secret in a group writes a
   *new* memory with the wider ACL; the old one is never mutated. Covered by a
   `secret-stays-private` test. `NarrativeEngine-P`'s `knownBy` is the same idea.
2. **Per-character stores with epistemic tags** — `senjinthedragon/Smart-Memory`
   gives each member an independent store and extracts a per-character knowledge
   map with five tags (**Knows / Suspects / Believes(false) / Unaware / Hiding**),
   labelling memories from absent scenes `[secondhand]`. Prompt-level, not enforced.
3. **Per-message presence hiding** — `leandrojofre/SillyTavern-Presence` restricts
   each character's memory to messages they were present for, with user-editable
   presence icons, an "all-seeing narrator" flag, and `/presenceForget`,
   `/presenceForceNonePresent` commands.
4. **Scene scoping** — BookWorld selects participants by location and makes
   incidental NPCs memoryless; ChatRPG keeps world state in a separate Archivist.
5. **Phase-segmented memory** — carry only outcomes across scene boundaries.

The empirical case for mechanical over prompt-level isolation is
arXiv:2409.11726: LLMs are poor at detecting both *known* and *unknown* knowledge
errors in character, "especially when it comes to familiar knowledge." Nobody in
the consumer tier does this properly — it is an open differentiator.

**Consolidated multi-agent failure checklist.** Retrieval miss / partial-fragment
retrieval; hallucinated embellishment and world-knowledge bleed; formal-speech
inheritance from instruction tuning; cascading hallucination across chained agents;
role flipping, instruction repeating, fake replies, infinite message loops;
context overflow degrading *early* context; entity/state drift and forgotten
items; merged personalities in concatenated-card group chats; character
knowledge-error blindness; and hard narrative denials being rejected by players.
Multi-agent architectures also demand stronger models — BookWorld's ablations
showed the design underperforming direct generation on Llama-3.3-70B.

---

## 7. Design implications

1. **Own the state in code, not in the token stream.** Every surveyed extension
   round-trips state through the model; that is the direct cause of lost updates,
   incomplete JSON, and swipe desync. A relational store (SQLite) with an
   append-only event log and derived current state gives you undo, branching and
   swipe-consistency for free.
2. **Read-only state in, schema-validated writes out.** Inject a compact prose
   state block at the **end** of context; let the model mutate state only through
   validated tools, so field loss is detectable rather than silent.
3. **Per-section token budgets with reserved allocations.** NovelAI's model —
   reserve before placing, ordered insertion, and show the user *why* each entry
   did or didn't fit — is the correct fix for "lore loses to chat history."
4. **Commit before you roll.** Have the model declare a DC/target before the RNG
   result is revealed; use a seeded deterministic queue for bulk combat rolls and
   tool calls for narrative checks.
5. **Separate the GM layer from the prose model.** Prose finetunes hijack player
   agency and refuse to apply consequences; a cheap deterministic adjudicator plus
   a narrator is the pattern that works (Voyage, loreweaver, Multihog).
6. **Reactive entity expansion.** Generate quest components, locations and NPCs at
   the moment they are promised, not lazily and not all at once. This is the
   single highest-leverage fix for quest drift and NPC amnesia.
7. **Per-character knowledge isolation** via `knownBy`-style visibility flags is
   unclaimed territory in the consumer market and a natural differentiator.
8. **Never let a summarizer overwrite authoritative state**; version per message
   and per swipe, and keep large artifacts out of a monolithic settings blob.

---

## Sources

AI Dungeon / Latitude
- https://help.aidungeon.com/faq/the-memory-system
- https://help.aidungeon.com/faq/plot-components
- https://help.aidungeon.com/faq/plot-essentials
- https://help.aidungeon.com/faq/what-is-the-authors-note
- https://help.aidungeon.com/faq/ai-instructions
- https://help.aidungeon.com/faq/story-cards
- https://help.aidungeon.com/faq/what-are-scenarios
- https://help.aidungeon.com/faq/why-does-the-ai-forget-or-mix-things-up
- https://help.aidungeon.com/faq/how-do-i-write-scripts-and-use-scripting
- https://raw.githubusercontent.com/magicoflolis/aidungeon.js/main/Scripting%20Guidebook.md
- https://aidungeon.com/updates
- https://aidungeon.com/pathfinder
- https://latitude.io/news/the-walls-approach
- https://latitude.io/news/17
- https://latitude.io/news/16
- https://latitude.io/news/6
- https://latitude.io/news/1
- https://latitude.io/news/heroes-dev-log-20-our-new-name-for-heroes-is
- https://latitude.io/news/farewell-adventurer
- https://latitude.io/news/about-corrupted-cache-a-recently-observed-ai-phenomenon
- https://www.gamedeveloper.com/design/creating-the-ever-improvising-text-adventures-of-i-ai-dungeon-2-i-
- https://en.wikipedia.org/wiki/AI_Dungeon

NovelAI
- https://docs.novelai.net/en/text/lorebook/
- https://docs.novelai.net/en/text/editor/storysettings/
- https://docs.novelai.net/en/text/editor/advancedsettings/
- https://docs.novelai.net/en/text/textadventure/
- https://docs.novelai.net/en/text/specialsymbols/
- https://docs.novelai.net/en/text/specialmodules/
- https://docs.novelai.net/en/subscription/
- https://blog.novelai.net/project-update-formal-cancellation-of-aetherroom-28eec9bcc0b8

SillyTavern (core + extensions)
- https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- https://docs.sillytavern.app/usage/core-concepts/macros/
- https://docs.sillytavern.app/usage/core-concepts/authors-note/
- https://docs.sillytavern.app/usage/core-concepts/data-bank/
- https://docs.sillytavern.app/usage/core-concepts/groupchats/
- https://docs.sillytavern.app/for-contributors/function-calling/
- https://docs.sillytavern.app/extensions/
- https://docs.sillytavern.app/extensions/summarize/
- https://docs.sillytavern.app/extensions/objective/
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/world-info.js
- https://github.com/SillyTavern/SillyTavern/issues/5193
- https://github.com/SillyTavern/SillyTavern/issues/6027
- https://github.com/SillyTavern/Extension-Dice
- https://github.com/SpicyMarinara/rpg-companion-sillytavern
- https://github.com/SpicyMarinara/rpg-companion-sillytavern/issues/144
- https://github.com/SpicyMarinara/rpg-companion-sillytavern/issues/146
- https://github.com/SpicyMarinara/rpg-companion-sillytavern/issues/147
- https://github.com/SpicyMarinara/rpg-companion-sillytavern/issues/148
- https://github.com/kaldigo/SillyTavern-Tracker
- https://github.com/kaldigo/SillyTavern-Tracker/issues/32
- https://github.com/kaldigo/SillyTavern-Tracker/issues/35
- https://github.com/kaldigo/SillyTavern-Tracker/issues/36
- https://github.com/kaldigo/SillyTavern-Tracker/issues/38
- https://github.com/bmen25124/SillyTavern-WTracker
- https://github.com/Zaakh/SillyTavern-zTracker
- https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework
- https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework/issues/32
- https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework/issues/86
- https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework/issues/95
- https://github.com/Lodactio/Extension-Summaryception
- https://github.com/prolix-oc/SillyTavern-SimTracker
- https://github.com/ficklef0x/sillytavern-SmartDirector
- https://github.com/Min3Mast3r4653/SillyTavern-Extensions-and-Themes
- https://rentry.co/world-info-encyclopedia

Structured state
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/function-calling
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md
- https://blog.dottxt.ai/comparing-the-quality-of-structured-generation-engines.html
- https://arxiv.org/abs/2307.03172
- https://arxiv.org/abs/2502.05167
- https://arxiv.org/abs/2605.26128
- https://research.trychroma.com/context-rot

Multi-agent / narrative
- https://arxiv.org/abs/2304.03442
- https://ar5iv.labs.arxiv.org/html/2304.03442
- https://arxiv.org/abs/2209.14958
- https://github.com/joonspk-research/generative_agents
- https://github.com/google-deepmind/dramatron
- https://arxiv.org/abs/2307.07924 (ChatDev)
- https://arxiv.org/abs/2308.00352 (MetaGPT)
- https://arxiv.org/abs/2407.01093 (IBSEN)
- https://arxiv.org/abs/2502.19519 (ChatRPG)
- https://doi.org/10.1145/3742413.3789218 (SENNA, IUI '26)
- https://arxiv.org/abs/2504.14538 (BookWorld)
- https://arxiv.org/abs/2409.11726 (character knowledge errors)
- https://arxiv.org/abs/2504.14128 (TALES)
- https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/scripts/group-chats.js
- https://github.com/AndreiNicu/SillyTavern
- https://github.com/yantrikos/chronicler
- https://github.com/senjinthedragon/Smart-Memory
- https://github.com/leandrojofre/SillyTavern-Presence
- https://github.com/BobTheBinChicken/Ultimate-ChatAssistant
- https://github.com/MinLL/SkyrimNet-GamePlugin/discussions/387
- https://arxiv.org/abs/2509.00482
- http://web.archive.org/web/20201219195424/https://pcc.cs.byu.edu/2019/11/21/ai-dungeon-2-creating-infinitely-generated-text-adventures-with-deep-learning-language-models/

AI GM engines and products
- https://techcrunch.com/2026/04/21/voyage-is-an-ai-rpg-platform-for-creating-custom-gaming-worlds-with-ai-generated-npc-interactions/
- https://gamesbeat.com/latitude-launches-ai-game-voyage/
- https://voyage.io/
- https://github.com/AventurasTeam/Aventuras
- https://github.com/Sagesheep/NarrativeEngine-P
- https://github.com/1A7432/loreweaver
- https://github.com/horizonfps/project-lunar
- https://github.com/atisharma/chasm
- https://github.com/hec-ovi/gamentic
- https://github.com/Feed-Scription/openovel
- https://github.com/4thfever/cultivation-world-simulator
- https://github.com/KoboldAI/KoboldAI-Client
