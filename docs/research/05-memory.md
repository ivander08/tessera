# Memory, Summarization & State Tracking for AI Roleplay — Design Research

Scope: SillyTavern's memory stack, agent-memory architectures (MemGPT/Letta, mem0, Zep/Graphiti, Cognee),
scene/world state tracking in RP, multi-bot orchestration, and long-chat token budgeting.
All defaults below were read from source, not panels, unless noted. Versions/dates noted inline.

---

## (a) SillyTavern's memory stack, in detail

SillyTavern has **four independent memory systems**, none of which is "the" memory feature.
(https://arcanumrpgs.com/blog/sillytavern-memory/)

| System | Stores | On by default | Defaults (from source) |
|---|---|---|---|
| Summarize (built-in `memory` ext) | one rolling summary | installed, **inert** | `source: 'extras'`, `promptInterval: 10`, `promptWords: 200`, `depth: 2`, `position: IN_PROMPT`, `role: SYSTEM` |
| Vector Storage | embeddings of past messages | **off** (`enabled_chats: false`) | `protect: 5`, `insert: 3`, `query: 2`, `message_chunk_size: 400`, `score_threshold: 0.25` |
| Data Bank (Chat Attachments) | attached files | off | `chunk_size_db: 2500`, `chunk_count_db: 5`, `file_depth_db: 4` |
| World Info / lorebooks | keyword-triggered entries | per-entry | `world_info_depth: 2`, `world_info_budget: 25` (% of max context), `world_info_recursive: false`, `world_info_max_recursion_steps: 0`, `world_info_match_whole_words: false` |

Source: `public/scripts/extensions/memory/index.js`, `public/scripts/extensions/vectors/index.js`,
`public/scripts/world-info.js` on the `release` branch of SillyTavern/SillyTavern (33.9k stars, AGPL-3.0,
last push 2026-09-23).

### Summarize — three documented failure modes

1. **Silent no-op.** `source` defaults to `'extras'` (the discontinued Extras Python server, retired
   April 2024). `onChatEvent()` opens with `if (source === 'extras' && !modules.includes('summarize')) return;`
   — no error, no toast. The summary box stays empty forever. Fix: set source to **Main API**.
   Docs themselves hedge: "take that statement with a grain of salt… outputs may lose some important
   details or contain hallucinations." (https://docs.sillytavern.app/extensions/summarize/)
2. **Recursive degeneration.** The shipped prompt is *"Ignore previous instructions. Summarize the most
   important facts and events in the story so far. **If a summary already exists in your memory, use that as a
   base and expand with new facts.** Limit the summary to `{{words}}` words or less."* Each summary is built
   from the previous summary + new messages — never from the source chat. An error at message 40 is carried
   forward indefinitely and reads more factual with each pass. Target length stays at 200 words regardless of
   chat length, so compression ratio degrades monotonically.
3. **Rollback on edit.** The summary is stored in chat-file metadata against the last in-context message;
   deleting or editing that message reverts to the previous summary. `Restore Previous` does this deliberately;
   `Pause` freezes it (and is the documented way to hand-maintain a summary).

Build modes: Raw-blocking, Raw-non-blocking, Classic-blocking. Classic reuses the processed prompt and is
recommended for llama.cpp-class backends; Raw generates a fresh prompt each time and destroys prompt cache.

### Vector Storage — it *relocates* history, it does not append

`rearrangeChat()` (line 776 of `vectors/index.js`) queries for relevant messages, **removes each matched
message from its chronological position in the chat array**, and re-inserts them together as a block under a
`Past events:\n{{text}}` template near the end of the prompt. Sorted by relevance, not time. Consequences:
the model sees a hole where the exchange was plus out-of-order fragments labelled as past events. This explains
reports of "vector storage made chronology worse." `protect: 5` is the safety margin.

Docs are explicit about the cache tradeoff: *"Chat Vectorization restructures the prompt prefix between the LLM
calls, which can lead to frequent cache misses. When used with caching, vectorization is often counter-productive…
You have to choose one or the other, but not both."* (https://docs.sillytavern.app/extensions/chat-vectorization/)

Retrieval defaults are tiny relative to modern contexts: 3 chunks of ≤400 chars, selected by similarity to the
last 2 messages, at a 0.25 threshold. Against 128k that is a rounding error — a targeted recall mechanism, not
a memory extension. Vectorized World Info entries lose keyword determinism ("it's impossible to predict exactly
what entries will be inserted").

### Memory Books (third-party, 312★, AGPL-3.0, pushed 2026-09-28)

The most complete external design. Everything lands in **ordinary lorebook entries** — no hidden store.
(https://github.com/aikohanasaki/SillyTavern-MemoryBooks)

- **Scene memory**: user marks or auto-detects a message range → one model call → strict JSON
  `{title, content, keywords}` → one lorebook entry. Prompt assembly order is fixed:
  memory prompt → `=== ADDITIONAL CONTEXT FOR REFERENCE ===` → `=== PREVIOUS SCENE CONTEXT (DO NOT PROCESS) ===`
  → `=== SCENE TRANSCRIPT ===` (`Speaker: message` per line).
- **Cadence**: docs recommend `Auto-Summary Interval` 20–30 messages, `Buffer` 0–2 (generation lags the live
  conversation). Trigger can be message count *or* token count.
- **Token saving**: auto-hide processed messages (`Do not auto-hide` / all-through-last-memory /
  last-memory-only), with "messages to leave unhidden" as the overlap margin. Hidden ≠ deleted. Recommended
  beginner config: show boundary divider + jump button, leave 2 messages unhidden, enable unhide-before-generation,
  **no auto-hide until a memory has been verified**.
- **Hierarchical consolidation**: `Scene → Arc → Chapter → Book → Legend → Series → Epic`. Consolidation runs
  from existing entries (never raw chat), expects strict JSON with `member_ids` mapping sources to outputs and
  an `unassigned_items` bucket for outliers. Source entries can be **disabled** after consolidation so the
  higher tier takes over retrieval. A readiness prompt fires at a per-tier minimum count but never consolidates
  silently. It is manual by design.
- **Side Prompts** are the state-tracker primitive: a separate prompt that maintains *one mutable lorebook entry*
  (not a new entry per run) for relationship/quest/inventory/mood tracking. Templates ship for Character
  Development, Relationship Dynamics, Plot Threads, Mood, World Building. A side prompt receives its own prior
  entry as "state, not evidence that all old statements remain valid," up to 7 previous memories, and an
  Additional Context set.
- **Compaction vs consolidation**: consolidation merges *many* entries upward; compaction shortens *one* entry
  in place with a review diff.
- **Auto-rollback** on message deletion: full rollback / affected-only (leaves a permanent coverage gap) / cancel.
  Off by default. Edit and swipe do not trigger it.
- **Group/Narrator routing** (see §d).
- Known failure modes from the issue tracker: token-warning threshold on large scenes (a 117k-token scene
  warns), generation failures with provider/JSON truncation, prompt framing bias
  ("=== PREVIOUS SCENE CONTEXT (DO NOT SUMMARIZE) ===" — issue #49, a real complaint that the scaffolding
  fights the summarizer's natural tendency), and auto-hide colliding with the Presence extension because both
  mutate SillyTavern's shared message-visibility state.

### Smart Context (deprecated) and Author's Note

Smart Context (ChromaDB via Extras) is **explicitly unmaintained**: *"THIS EXTENSION IS NO LONGER MAINTAINED
AND NOT RECOMMENDED TO USE."* Its design is still instructive: strategies `Replace oldest history` (removes
messages and substitutes memories — no demarcation, confuses weak models), `Add to Bottom` (no truncation, but
memories land at the end and can over-dominate), `Custom Depth`, and `% Strategy` (replaces a fixed *percentage*
of in-context history, rounded to multiples of 5). It starts only after 10 messages.
(https://docs.sillytavern.app/extensions/smart-context/)

Author's Note: default `depth 4`, `position 1` (after scenario), `interval 1` (every message), role SYSTEM.
Depth 0 = very end of chat history (max impact); depth 4 = 4th entity from the end. The docs state plainly
*"The closer the Author's Note is to the bottom of the prompt, the more impact it has on the next AI response."*
Frequency N = inserted into every Nth user input.
(https://docs.sillytavern.app/usage/core-concepts/authors-note/)

### World Info mechanics worth stealing

- Activation is a **scan over the last `depth` messages** (default 2). The single most common lorebook complaint
  across platforms: if the keyword isn't in the last 2 messages, the entry does not fire. Community working
  value is 4–8; STMB recommends scan depth 8, max recursion steps 2.
- Budget = `round(world_info_budget × maxContext / 100)`, default 25%, with an absolute token cap
  (`world_info_budget_cap`) that overrides it. When the budget is exhausted, *no further entries activate* and
  a toast fires: `World info budget reached after N entries.` Constant entries are inserted first, then by
  descending order. Direct keyword hits outrank recursion hits. (`world-info.js` lines 4736–5070)
- Recursion: entries activate other entries by mentioning their keywords, with `Non-recursable`,
  `Prevent further recursion`, and `Delay until recursion` (level-grouped). `Min Activations` (scan backwards
  until N entries fire) is mutually exclusive with `Max Recursion Steps`.
- **Timed effects** are the closest thing ST has to stateful memory: `Sticky` (stay active N messages),
  `Cooldown` (cannot re-fire for N messages), `Delay` (only after N messages exist). Measured in messages, not
  exchanges; removed if the chat doesn't advance (swipe/delete).
- Insertion positions: before/after char defs, before/after example messages, top/bottom of Author's Note,
  `@D` at depth D with a role, or **Outlet** (`{{outlet::Name}}`) — the latter is a clean mechanism for
  letting an extension decide placement itself. Outlets cannot nest and cannot be used inside entries
  (infinite-loop guard).
- `Probability` (trigger %), `Inclusion Group` (only one of N entries inserts, weighted or by priority),
  `Use Group Scoring` (most key matches wins) are all cheap ways to add variety without model calls.
- Third-party **STLO** (34★) adds lorebook-level priority (1–5) and per-lorebook budgets, with
  `Final Order = Priority × 10_000 + Order Adjustment + Original Entry Order`. Requires the "evenly"
  insertion strategy. Needed because ST's own budget is global, so one greedy lorebook starves the rest.
  (https://github.com/aikohanasaki/SillyTavern-LorebookOrdering)

---

## (b) Agent-memory architectures and what transfers

### MemGPT / Letta — paged context with explicit memory pressure

MemGPT (arXiv:2310.08560) splits the context into **main context** (system prompt + working-context memory
blocks) and a **FIFO queue** of messages. The queue manager implements the eviction policy:

- **warning token count ≈ 70%** of the context window → inject a system message warning the LLM of impending
  eviction ("memory pressure"), so the agent can call memory tools to save what matters.
- **flush token count = 100%** → evict ~**50%** of the window, generate a **new recursive summary from the
  existing recursive summary + evicted messages**, and keep that summary at FIFO index 0.

Two ideas transfer directly to a client-side app:

1. **The model is told it is running out of room, before it runs out.** This is a prompt-level affordance,
   not an infrastructure one.
2. **Memory blocks**: labelled, size-limited, always-visible units prepended in XML, with a `description` that
   tells the agent how to read/write the block. Letta's docs note the description is "the main information used
   by the agent to determine how to read and write to that block" — a bad description makes the block useless.
   Blocks can be read-only and shared between agents.
   (https://docs.letta.com/v1-sdk/memory/memory-blocks)

Letta's own framing is worth adopting wholesale: **"RAG is not agent memory"** — embedding search is single-step,
reactive, and will never retrieve a fact that isn't semantically similar to the current query (the birthday/blue
cake example). The fix is a curated, always-in-context state plus *agentic* (multi-step, tool-driven) retrieval.
(https://www.letta.com/blog/rag-vs-agent-memory/)

**Sleep-time compute** (arXiv:2504.13171, Letta blog Apr 2025) is directly relevant to a local app: run a
*second* model instance during idle time to rewrite the primary agent's memory blocks. Letta recommends a
**stronger, slower model for the sleep-time agent and a fast model for the conversational agent**, with a
configurable frequency. This is exactly the architecture for "summarize while the user is away" without
blocking the chat turn.

### mem0 — extraction + update, now ADD-only

Two phases: extraction (LLM pulls salient facts from a message pair) and update (LLM chooses
ADD/UPDATE/DELETE/NOOP against the top-s similar memories via tool call). Config in the paper: `m = 10`
previous messages of context, `s = 10` similar memories, GPT-4o-mini. Graph variant `Mem0g` stores
`(entity, relation, entity)` triplets in Neo4j with conflict detection that **marks contradicting edges invalid
rather than deleting them**, preserving temporal reasoning.
(arXiv:2504.19413; https://docs.mem0.ai/core-concepts/how-it-works)

The current production docs have moved to **ADD-only extraction** — "New facts are stored alongside old ones.
Nothing is overwritten or deleted" — precisely because premature consolidation loses information. Reported
benchmarks: LoCoMo 92.5, LongMemEval 94.4, BEAM 1M 64.1 / 10M 48.6, at **~6,700–6,900 tokens per query** vs
25,000+ for full-context. Note knowledge-update scores *suffer* under ADD-only (93.6 LongMemEval; BEAM
contradiction_resolution 35.7 / 32.5) — the honest tradeoff. Multi-signal retrieval (semantic + BM25 keyword +
entity + temporal), fused by rank, "outperformed every individual signal across every category tested."
(https://docs.mem0.ai/core-concepts/memory-evaluation)

**Transferable for a BYOK client:** the extraction/update split and the ADD-only default. Storing a dated,
immutable fact log and resolving contradictions at *read* time is strictly safer than asking a small local
model to rewrite a memory in place.

### Zep / Graphiti — bi-temporal facts

Graphiti (31.3k★, Apache-2.0, pushed 2026-09-28) builds a temporal knowledge graph where every fact edge has a
**validity window**: when it became true and when it was superseded. Invalidation is non-destructive — "old facts
are invalidated, not deleted. Query what's true now, or what was true at any point in time." Everything traces
back to **episodes** (raw ingested data) for provenance. Retrieval is hybrid: semantic + BM25 + graph traversal,
"without reliance on LLM summarization." Zep's paper (arXiv:2501.13956) reports DMR 94.8% vs MemGPT 93.4%, and
up to +18.5% on LongMemEval with 90% lower latency.
(https://github.com/getzep/graphiti)

**Transferable:** the bi-temporal edge is the right data model for RP facts that change ("Alice's sword is
broken" → later repaired). It costs a graph DB, which is too heavy for a local app — but the *schema* (fact,
valid_from, invalid_at, source_message_id) works fine in SQLite.

### Cognee — runs keyless, locally

Cognee (31.2k★, Apache-2.0, pushed 2026-09-29) is the most relevant precedent for a no-server app: since v1.6.0
it builds and searches memory with **local models and no cloud LLM key** — GLiNER for entity extraction, a local
embedding model, both downloaded on first use. Operations are `remember` / `recall` / `improve` / `forget`.
Session distillation "curates accepted lessons into permanent memory." Since 1.0 it can run the whole memory
layer on a **single Postgres** (relational + pgvector + graph), though the Postgres-as-graph-store path is
labelled a demo feature. (https://github.com/topoteretes/cognee)

**Verdict on transfer:** MemGPT's memory blocks + memory-pressure warning, mem0's ADD-only dated fact log,
Graphiti's bi-temporal validity windows, and Letta's sleep-time consolidation all transfer to a client-side app.
Neo4j/graph-DB dependency and managed-context-graph services do not.

---

## (c) Scene / world state tracking in RP

There is **no enforcement layer anywhere in this ecosystem.** TableForge puts it best: SillyTavern has four
places state can live, "each solves a different problem, none enforces anything, and the model only respects
state it can currently see." The two rules that prevent drift: (1) treat "narrator contradicted the ledger" as a
prompt-visibility bug before blaming the model; (2) keep **one canonical ledger** and demote everything else to
commentary — when prose and ledger disagree, the ledger wins, out loud, in the chat.
(https://tableforge.gg/blog/sillytavern-game-state)

### Existing implementations

| Project | Stars / status | Approach |
|---|---|---|
| **RPG Companion** (SpicyMarinara) | 316★, deprecated → community fork `Pasta-Devs/Marinara-Engine` | User stats w/ bars, info box (date/weather/temp/time/location/recent events), present characters w/ relationship badges + thoughts, RPG attributes, multi-location inventory (v2 format), quests. `updateDepth: 4` context messages. |
| **Tracker** (kaldigo) | 101★, last push 2025-08 | Customizable trackers, documentation PDF |
| **Tracker Enhanced** (harrywenjie) | 21★, unmaintained | Independent connection for tracker generation; injects a configurable "Roleplay Injection Prompt" line so the RP model understands the payload; reuses completion preset knobs but disables instruct templates |
| **State Engine** (StygianTechnica) | 0★, v0.5.0-dev, pushed 2026-09-26 | Strict-typed variables in ST's native store, exposed via `{{getvar::name}}`. Categories: Manual, Counter, **Prompted (AI-derived)**, **Cycling**. Preset triggers: `startup`, `new_chat`, `user`, `pre_generation`, `ai`, `group_draft`. Batches prompted updates into one request per trigger. Seeds 5 starter packs (Story Progression, Location and Time, Relationships, Combat and Encounter, Mixed) |
| **Guided Generations** | 227★, GPL-3.0, pushed 2026-07-31 | Persistent Guides: Situational / Thinking / Clothes / **State** / Rules / Custom, each generatable and injectable |
| **STscript variables** | built-in | `/setvar`, `/addvar`, `/incvar`, arrays and objects, `index=` for nested access |

The two injection strategies for trackers are the central design fork:

- **Together mode** (RPG Companion default): the tracker block is emitted *inside the main reply* and
  regex-extracted afterwards. One API call, faster, but tracker formatting pollutes the RP response and
  degrades prose quality.
- **Separate mode**: a second model call produces only tracker data, which is displayed in the sidebar and
  re-injected as a context summary for the next generation. Cleaner prose, +1 call, slower.

RPG Companion explicitly detects "guided generations" (ephemeral `instruct`/`quiet_prompt` requests) and
suppresses its injections to avoid conflicting instructions — a good precedent for cooperating extensions.

### AI Dungeon's Memory System — the most mature commercial design

Two cooperating features (https://help.aidungeon.com/faq/the-memory-system):

- **Memories**: every **6 actions** are summarized by a dedicated summarization model into one Memory. First
  Memory is created at action 12 (covering actions 1–6), then every 6 thereafter, so the most recent 6 actions
  are never summarized — **you can undo or edit the last 6 actions without invalidating memory**.
- **Auto Summarization**: a running `Story Summary` plot component, re-summarized every **15 actions**, with
  Memories filling the gap in between so nothing is untracked. It self-compresses when it grows too long.
  Turning it on for an existing adventure re-summarizes every action until caught up.
- **Memory Bank**: embeds each Memory, retrieves by relevance to the **most recent action** when the full
  history no longer fits, and inserts the top memories into an allocated context slice. When the bank is full,
  the **least-used** memories are forgotten — frequently-used old memories can survive forever.
- Bank capacity is tiered: Free 25 / Champion 100 / Legend 200 / Mythic 400.

The notable omission is deliberate: Latitude explicitly did *not* port Voyage's "game state" (health, quests,
inventory, levels) because AI Dungeon is collaborative storytelling, not a traditional RPG.

### What breaks

1. **Drift / contradiction.** Nothing reconciles prose, variables, and World Info. Each unnoticed contradiction
   silently becomes canon.
2. **Visibility failure.** A perfectly maintained HP variable does nothing if the model never sees it. This is
   the most common "my tracker doesn't work" cause.
3. **Token bloat.** A tracker block injected every turn at depth 4 with 20 fields is a fixed cost on every
   single request, before the story starts.
4. **Stale-state-as-evidence.** STMB's own guidance is that the prior tracker entry is "state, not evidence
   that all old statements remain valid" — models otherwise re-assert resolved facts.
5. **Swipe/branch desync.** RPG Companion stores tracker data per swipe; STMB has a whole auto-rollback
   subsystem for deletions and branches. Both exist because state and history diverge on every re-roll.

---

## (d) Multi-bot / group chat orchestration

### SillyTavern group chats (defaults from `group-chats.js`)

Reply order strategies — **Natural Order is the default**:

1. **Name mentions** from the last message, whole-word matches only. Deterministic and runs first: *typing a
   character's name is the reliable way to make them speak.* Nicknames that aren't the card name match nothing.
2. **Talkativeness roll** — each remaining member rolls `Math.random()` against their per-character
   `talkativeness` (default `0.5`, edited in Advanced Definitions, not the group panel). Members are shuffled
   first, so order is not list order.
3. **Fallback** — if nobody activated, one random member is picked, preferring talkativeness > 0.

Cross-cutting: **the last speaker is banned from replying again** unless `Allow Self Responses` is enabled.
Auto-mode follows the same strategy and fires the next turn **5 seconds** after the previous character finishes.
`Manual` strategy does not reply to user messages at all — a frequent false bug report.
Other strategies: `List Order` (strict position), `Pooled Order` (one random member who hasn't spoken since the
last user message). `Force Talk` overrides everything, including mute.

**Knowledge isolation is the core tradeoff**, and the chat history is *always shared* in both modes:

- **Swap character cards (default)**: only the active speaker's card enters context. Characters know only what
  was said in front of them. Secrets stay secret; two characters written as siblings meet as strangers.
- **Join character cards**: description, scenario, personality, message examples, and depth prompts of every
  member are concatenated in list order. ST's own docs warn this causes *"characters being confused about
  themselves, having merged personalities, uncertain traits."* The structural reason: a character card is a
  second-person instruction about who the model is, so concatenating four of them hands the model four
  conflicting identity statements. `Join Prefix`/`Join Suffix` (with `{{char}}` and `<FIELDNAME>`) wrap each
  block and are the difference between Join working and producing "four-way personality soup."
  Join also has a performance argument: the context stops being rewritten per speaker, preserving prompt cache
  on llama.cpp.

(https://docs.sillytavern.app/usage/core-concepts/groupchats/ ; https://arcanumrpgs.com/blog/sillytavern-group-chat/)

### Knowledge isolation done properly — Memory Books group/Narrator modes

This is the most sophisticated existing answer to per-character knowledge, and it is worth copying:

- **Native group mode**: participants are derived from actual message authors (character cards), never from
  prose. One group Memory Book, with an **inclusive character filter** listing participants so the entry
  activates when any participant is the current speaker. Advanced layout: one canonical group book plus one
  per-character book, routed by STLO character overrides so each speaker activates only their own book.
- **Character-focused summaries**: with "Use separate group and character prompts" enabled, the same scene
  yields a *canonical* group version plus a per-character version preserving individual knowledge, mistaken
  beliefs, private reactions, and priorities. Example from the docs — the same event rendered as: group
  "Alice discovered the transmitter and concealed it from Bob"; Alice "…deliberately concealed it… suspected
  Clara understood"; Bob "searched the room but found nothing suspicious"; Clara "saw Alice discover and
  conceal the transmitter… chose not to intervene."
- **Narrator mode** handles the case where one Narrator card writes many fictional characters in prose, so
  message authors cannot identify the cast. It requires a user-declared cast, per-character books, and an
  explicit **Active Cast** selection snapshotted at generation start and stamped into the response metadata.
  SillyTavern records one author; Narrator mode supplies the rest via metadata.
- **The honest limitation, stated by the authors**: *"Character filters and separate Memory Books improve
  relevance and routing. They should not be treated as a strict privacy or access-control system."* The
  canonical group book still contains the group version. Missing scenes are "chronology gaps," not proof of
  absence. Linked copies are **not live-synchronized** — regenerating one does not update the others.

(https://github.com/aikohanasaki/SillyTavern-MemoryBooks — USER_GUIDE.md, AI Reference Manual §11–12)

### Narrator / director patterns

- **Narrator as a group member** with talkativeness ≈ 0 and a short distinctive name, summoned by name or
  `Force Talk`. Near-zero talkativeness plus Force Talk gives an on-demand narrator instead of a competing voice.
- **Guided Generations** (227★): injects ephemeral instructions before a reply (`Guided Response`), regenerates
  with new guidance (`Guided Swipe`), and maintains *Persistent Guides* for Situational / Thinking / Clothes /
  State / Rules / Custom context that are generated then held.
- **Story Mode / Scene Director** (0★, thin): 43 genre templates, author-style emulation, a loose three-act arc
  (Setup ~33% / Escalation ~33% / Resolution ~33%) with phase-specific guidance, and **signal-based pacing**
  via literal in-band markers (`@@BEAT:N@@`, `@@NEXT_SCENE@@`) that the model emits and the extension parses.
- **RPG Companion's plot buttons** progress the plot with randomized events or natural progression on click.

### Academic turn-taking — the one paper worth reading

Nonomura & Mori, *"Who speaks next?"* (Frontiers in AI, June 2025, doi 10.3389/frai.2025.1582287) implements
Sacks/Schegloff/Jefferson turn-taking rules for LLM agents:

- Each agent runs `think()` per turn, outputting `{thought, action: speak|listen, importance: 0–9}`.
- `selectMostImportant()`: one speaker → they speak; multiple → highest `importance` wins, ties broken randomly;
  all listen → **the previous speaker continues**.
- Three memory layers: **History** (last *k* turns, shared by all agents), **shortTermHistory** (per-agent
  thought log, preserving policy/consistency), **longTermHistory** (LLM-normalized facts extracted from
  utterances, retrieved by cosine similarity to the previous utterance, top-*l*).

Reported result: the adjacency-pair next-speaker mechanism **significantly reduced dialogue breakdowns** and
improved information sharing and logical reasoning versus baselines. This is a concrete, testable alternative
to SillyTavern's random talkativeness roll.

Counterweight: **DEBATE** (arXiv:2510.25110) benchmarks 2,792 humans in 4-person debates against LLM role-play
agents and finds LLM groups show **stronger convergence in both public and private opinions, positive stance
drift, and greater regression to the mean**. Multi-agent RP will trend toward premature consensus unless the
speaker-selection and prompt design actively resist it.

---

## (e) Long-chat token budgeting: concrete parameters

### Generative Agents — the retrieval scoring formula

Park et al., arXiv:2304.03442. The memory stream stores `{description, creation_ts, last_access_ts}`.

- **Recency**: exponential decay over hours since last retrieval, **decay factor 0.995**.
- **Importance**: LLM-rated integer 1–10 at creation time (prompt: "On the scale of 1 to 10, where 1 is purely
  mundane… and 10 is extremely poignant…"). Examples: "cleaning up the room" → 2, "asking your crush out on a
  date" → 8.
- **Relevance**: cosine similarity between the query embedding and the memory embedding.
- Final score = `α_recency·recency + α_importance·importance + α_relevance·relevance`, all α = **1**, each term
  min-max normalized to [0,1] over the candidate set. Top-ranked memories that fit the context window are included.

**Reflection**: triggered when the **sum of importance scores of recent events exceeds 150** (agents reflected
roughly 2–3 times/day). The reflection procedure takes the **100 most recent memory records**, asks for the
**3 most salient high-level questions**, retrieves relevant memories per question, then asks for **5 high-level
insights**, each citing the record indices that support it. Reflections are stored back into the memory stream
with those citations, so reflection trees grow: leaves are observations, higher nodes are increasingly abstract.
Reflection and planning ablations both measurably reduced believability.

**Environment tree**: the world is a tree of areas/objects flattened to natural language for prompting, with
per-agent partial subgraphs ("agents are not omniscient: their tree may get out of date as they leave an area").
This is the correct model for a dungeon/world simulator — per-agent, per-location knowledge with staleness.

### LongMemEval — measured wins, with numbers

Wu et al., arXiv:2410.10813. Five abilities: information extraction, multi-session reasoning, knowledge updates,
temporal reasoning, abstention. Standard settings: LongMemEval_S ≈ 115k tokens/question, LongMemEval_M ≈ 500
sessions / 1.5M tokens.

Measured optimizations:
- **Value granularity**: decomposing sessions into **rounds** (one user message + one assistant response) beat
  whole sessions. Further compressing to individual user facts *hurt* overall performance through information
  loss but *improved* multi-session reasoning.
- **Key expansion**: indexing with the value *plus* extracted summaries, keyphrases, user facts, and timestamped
  events gave **+9.4% recall@k** and **+5.4% QA accuracy**.
- **Time-aware query expansion**: associating timestamps with facts and narrowing the search range improved
  temporal-reasoning recall by **+6.8% to +11.3%**.
- **Reading strategy**: Chain-of-Note + structured JSON output improved QA accuracy by **up to 10 absolute points**
  across three LLMs, *even with perfect recall*. Always sort retrieved items by timestamp before reading.

Baselines: GPT-4o scores 0.870 oracle vs 0.606 on LongMemEval_S (**30.3% drop**) just from context length.
ChatGPT's memory feature dropped 37% and Coze 64% versus offline reading with the same model. Commercial
systems "tend to overwrite crucial information as the chat continues" (ChatGPT) or "often fail to record
indirectly provided user information" (Coze).

### Chroma: context rot

Hong, Troynikov, Huber, July 2025 (https://research.trychroma.com/context-rot). 18 models. Findings:
- Performance degrades **non-uniformly** with input length even on trivially simple tasks, holding task
  complexity constant.
- **Lower needle–question similarity degrades faster with length.** Semantic retrieval is much harder than
  lexical retrieval at long context.
- **Distractors** (topically related but non-answering) degrade performance non-uniformly, and the effect
  **amplifies with input length** — including on the newest models.
- Haystack *structure* matters: shuffling sentences to preserve topic while destroying logical continuity
  consistently changed results.
- NoLiMa-style multi-hop questions (needle → latent association → answer) drop far harder than NIAH.

Practical implication for a roleplay app: **adding tokens is not free even when they fit.** A 200k context
window does not mean 200k usable tokens of coherent story.

### Hierarchical summarization, with parameters

- **Summaryception** (Lodactio, 165★, AGPL-3.0, pushed 2026-09-06) is the most explicit layered design.
  Defaults: **10 verbatim turns**, **3 turns per batch**, **30 snippets per layer**, **3 snippets per
  promotion**, **max 5 layers**. Promotion merges 3 snippets → 1, so each layer multiplies coverage 3×:
  L0 covers 90 turns, L1 270, L2 810, L3 2,430, L4 7,290 — roughly **11,000 turns in ~14–16k tokens**.
  Its key trick is **context-aware incremental summarization**: the summarizer receives that layer's existing
  summaries plus the new passage and is told "Summarize only necessary elements to coherently continue the
  Prior Context. Exclude anything already covered," producing a *narrative delta* (~80–100 tokens early,
  ~30–50 later) rather than a redundant recap. It also **temporarily disables all Chat Completion preset
  toggles** during summarization so 4k tokens of creative-writing instructions don't compete with a 200-token
  extraction task. Failed batches are never ghosted, so nothing is lost on API failure.
  Forks add per-character memory banks and lorebook ingestion of stable facts with a review queue.
- **Recursively Summarizing Books with Human Feedback** (arXiv:2109.10862) is the origin of the recursive
  summary-of-summaries approach: summarize small sections, then recursively summarize the summaries. Sensible
  book summaries; matched human-written quality in ~5% of cases.
- **RAPTOR** (arXiv:2401.18059): recursively embed, cluster, and summarize chunks bottom-up into a tree, then
  retrieve from **multiple levels of abstraction** rather than only leaf chunks. +20% absolute on QuALITY
  with GPT-4. The retrieval-side counterpart to Summaryception's storage-side layering.
- **MemoryBank** (arXiv:2305.10250) applies the **Ebbinghaus forgetting curve** — memories decay with time and
  are reinforced by use, with importance weighting. AI Dungeon's "least-used memories are forgotten" is the
  same idea in production.

### A concrete budget for a client-side app

For a 128k-context model, allocating roughly:
- system prompt + character card: ~1–2k
- always-in-context state block (time, location, inventory, relationships): **≤800 tokens**, regenerated each
  turn, structured (JSON or key-value, not prose)
- World Info / lorebook: **≤15–25%** of context (ST's default is 25%), capped absolutely
- recent verbatim turns: **~15–25%**, enough to cover the last 8–12 exchanges
- rolling summary / arc recap: **~5–10%**, with an explicit word budget that *grows with chat length* rather
  than staying fixed at 200
- retrieved memories (vector/graph): **3–10 items**, score threshold 0.25–0.5, injected near the end
- headroom: **≥20%** left unused, because attention degrades before the window fills

Summarize on a cadence tied to *context pressure*, not a fixed message count: trigger when the prompt reaches
~70% of the window (MemGPT's warning token count), buffer 2–5 messages behind the live conversation, and
summarize **per message or per round** rather than wholesale (qvink's MessageSummarize README enumerates the
built-in Summarize failure modes this fixes: whole-chat summarization misses details, LLM-managed summary state
degrades over time, edits don't propagate to the summary, no way to distinguish recent from important).

---

## Sources

### SillyTavern — official
- https://docs.sillytavern.app/extensions/summarize/
- https://docs.sillytavern.app/extensions/chat-vectorization/
- https://docs.sillytavern.app/extensions/smart-context/
- https://docs.sillytavern.app/usage/core-concepts/data-bank/
- https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- https://docs.sillytavern.app/usage/core-concepts/groupchats/
- https://docs.sillytavern.app/usage/core-concepts/authors-note/
- https://docs.sillytavern.app/usage/st-script/
- https://docs.sillytavern.app/extensions/
- https://github.com/SillyTavern/SillyTavern (33,910★, AGPL-3.0, pushed 2026-09-23)
- Source read from `release` branch: `public/scripts/extensions/memory/index.js`,
  `public/scripts/extensions/vectors/index.js`, `public/scripts/world-info.js`,
  `public/scripts/group-chats.js`, `public/scripts/authors-note.js`, `public/script.js`

### SillyTavern — third-party extensions
- https://github.com/aikohanasaki/SillyTavern-MemoryBooks (312★, AGPL-3.0, pushed 2026-09-28)
  - https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/USER_GUIDE.md
  - https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/userguides/1%20Memory_Books_AI_Reference_Manual.md
  - https://raw.githubusercontent.com/aikohanasaki/SillyTavern-MemoryBooks/main/userguides/old_guides_no_longer_updated/howSTMBworks-en.md
- https://github.com/aikohanasaki/SillyTavern-LorebookOrdering (34★, AGPL-3.0)
- https://github.com/qvink/SillyTavern-MessageSummarize (168★, AGPL-3.0, pushed 2026-07-29)
- https://github.com/Lodactio/Extension-Summaryception (165★, AGPL-3.0, pushed 2026-09-06)
- https://github.com/SpicyMarinara/rpg-companion-sillytavern (316★, deprecated)
- https://github.com/harrywenjie/SillyTavern-Tracker-Enhanced (21★, unmaintained)
- https://github.com/kaldigo/SillyTavern-Tracker (101★, pushed 2025-08)
- https://github.com/StygianTechnica/SillyTavern-StateEngine (v0.5.0-dev, pushed 2026-09-26)
- https://github.com/Samueras/GuidedGenerations-Extension (227★, GPL-3.0)
- https://github.com/YingHaoCui/SillyTavern-SceneDirector
- https://github.com/lackyas/SillyTavern-Presence (32★, unmaintained)
- https://github.com/pixelnull/sillytavern-DeepLore (87★)

### SillyTavern — issues
- https://github.com/SillyTavern/SillyTavern/issues/5697 (Vector Storage broken, open)
- https://github.com/SillyTavern/SillyTavern/issues/3945 (Summarize ignores branch history)
- https://github.com/SillyTavern/SillyTavern/issues/866 (Summarize injected across characters in group chat)
- https://github.com/SillyTavern/SillyTavern/issues/1297 (MemGPT feature request, closed)
- https://github.com/SillyTavern/SillyTavern/issues/3469 (multiple lorebooks per chat, open)
- https://github.com/SillyTavern/SillyTavern/issues/4260 (warn that chat vectorization breaks cache hits)
- https://github.com/SillyTavern/SillyTavern/issues/1671 (RAG documentation)
- https://github.com/aikohanasaki/SillyTavern-MemoryBooks/issues/49 (context framing creates bias)
- https://github.com/aikohanasaki/SillyTavern-MemoryBooks/issues/55 (token warning threshold on large scenes)
- https://github.com/aikohanasaki/SillyTavern-MemoryBooks/issues/69, /60 (memory generation failures)

### Agent-memory architectures
- MemGPT — https://arxiv.org/abs/2310.08560
- Letta memory blocks — https://docs.letta.com/v1-sdk/memory/memory-blocks
- Letta stateful agents — https://docs.letta.com/v1-sdk/concepts/stateful-agents
- Letta context engineering — https://www.letta.com/blog/guide-to-context-engineering/
- Letta "RAG is not agent memory" — https://www.letta.com/blog/rag-vs-agent-memory/
- Letta sleep-time compute — https://www.letta.com/blog/sleep-time-compute/ ; https://arxiv.org/abs/2504.13171
- Letta memory & dreaming — https://docs.letta.com/configuration/memory/index.md
- mem0 paper — https://arxiv.org/abs/2504.19413 ; https://arxiv.org/html/2504.19413v1
- mem0 how it works — https://docs.mem0.ai/core-concepts/how-it-works
- mem0 evaluation — https://docs.mem0.ai/core-concepts/memory-evaluation
- Zep paper — https://arxiv.org/abs/2501.13956
- Graphiti — https://github.com/getzep/graphiti
- Zep concepts — https://help.getzep.com/concepts
- Cognee — https://github.com/topoteretes/cognee
- mem0 (66,292★), Letta (24,969★), Graphiti (31,298★), Cognee (31,199★), zep (4,939★) — GitHub API, 2026-09-29

### Memory / retrieval research
- Generative Agents — https://arxiv.org/abs/2304.03442 ; https://arxiv.org/html/2304.03442v2
- LongMemEval — https://arxiv.org/abs/2410.10813 ; https://arxiv.org/html/2410.10813v2
- Chroma context rot — https://research.trychroma.com/context-rot
- Context rot commentary — https://www.understandingai.org/p/context-rot-the-emerging-challenge
- Recursively Summarizing Books — https://arxiv.org/abs/2109.10862
- RAPTOR — https://arxiv.org/abs/2401.18059
- MemoryBank — https://arxiv.org/abs/2305.10250
- A-Mem — https://arxiv.org/html/2502.12110v9 ; https://github.com/agiresearch/A-mem (1,188★, MIT)
- Long-term memory survey — https://arxiv.org/abs/2404.13501

### Multi-agent roleplay / turn-taking
- Who speaks next? — https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1582287/full
- DEBATE — https://arxiv.org/html/2510.25110v1
- SOTOPIA — https://arxiv.org/abs/2310.11667

### State tracking / world simulation
- AI Dungeon Memory System — https://help.aidungeon.com/faq/the-memory-system
- AI Dungeon Story Cards — https://help.aidungeon.com/faq/story-cards
- TableForge game state — https://tableforge.gg/blog/sillytavern-game-state
- Arcanum RPGS token budget — https://arcanumrpgs.com/blog/ai-roleplay-token-budget/
- Arcanum RPGS ST memory — https://arcanumrpgs.com/blog/sillytavern-memory/
- Arcanum RPGS ST group chat — https://arcanumrpgs.com/blog/sillytavern-group-chat/
