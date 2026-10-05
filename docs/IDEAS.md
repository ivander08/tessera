# Ideas

Ranked by (value × feasibility) / cost. Every entry names the file that would change and
the research section it rests on. The three entries marked **DIFFERENTIATED** are the ones
no shipping competitor has, per `docs/research/03-competitors.md` §12.

The constraint every idea below must respect is stated once, in
[§ The caching rule](#the-caching-rule), and referenced where an idea would tempt someone
to break it.

---

## 1. Branch-aware memory — **DIFFERENTIATED**

**Pitch.** Memory that rewinds with the chat: swipe back to an earlier reply and the
summaries and facts from the abandoned branch stop being in the prompt.

**Why it is the shortest path.** The hard part is already built. `messages.parent_id`
(`migrations/0005_branching.sql`) plus `walkPath`/`loadPath` (`worker/src/branch.ts:109`,
`:340`) already resolve exactly the scene on screen, and `messages.state_json`
(`migrations/0011_message_state.sql`) is already a per-row snapshot rather than a
per-chat document. The only memory table still chat-scoped is `summaries`: it is keyed by
`covers_from`/`covers_to` seq with no notion of which branch it covered
(`migrations/0001_memory.sql`). `facts` no longer has this gap — migrations 0014/0015 gave
it `learned_at_seq`/`superseded_at_seq` provenance and `factIsTrueSql`
(`worker/src/memory/facts.ts:31`) already enforces the ancestry predicate — so the
remaining gap is `summaries` only.

**Concrete change.** Record the tail id each summary/fact was derived from, then filter
`recall` (`worker/src/memory/recall.ts:35`) by "derived from a row that is an ancestor of the
current tail". The path walk already exists in `worker/src/branch.ts`.

This is a migration, not one column: it adds a tail id to `summaries` and `facts`, writes it
in the two enqueue paths, and adds the ancestry predicate to four statements in `recall`
(all four are chat-scoped today). Two corrections to an earlier draft of this entry, both
worth stating because they change the estimate:

- **`scheduleMemory` does NOT already have the tail.** It reads the range it is covering from
  `pathSeqsAfter` (`worker/src/memory/schedule.ts:52`), which returns seqs and nothing else.
  The tail *is* already available one level up, though: `worker/src/turn.ts:147` computes
  `tailId(env, chat.id)` for the same turn and could pass it down, so the plumbing is one
  extra argument rather than a new walk.
- **The ancestry filter cannot be a simple seq comparison.** Once a chat branches, a row can
  be active while sitting on an abandoned branch, which is exactly why `pathSeqsAfter` walks
  parents instead of filtering `seq > ?`. The same applies here: the filter is a recursive
  ancestor check, or a stored tail id compared against the walked path, not `seq <=`.

**Citation.** `docs/research/03-competitors.md` §12.1 — Smart-Memory's own docs warn that
long-term memories are shared across checkpoints and branches and **do not roll back**, and
it ships a read-only mode as the workaround. No product has memory that rewinds with the
chat.

**Cache.** The recalled block already renders into the tail
(`src/lib/prompt/memoryBlock.ts`, emitted after `tailStart` in `src/lib/prompt/assemble.ts`).
Filtering it by branch changes the tail only — do not be tempted to filter the *history*
array instead, which would rewrite the prefix.

---

## 2. Per-character epistemic isolation — **DIFFERENTIATED**

**Pitch.** Each character knows, suspects, believes falsely, is unaware of, or is hiding
something from each other character — and only the responding character's own beliefs are
in the prompt.

**Why now.** Tessera already has a cast (`worker/src/cast.ts`, `chat_cast` in
`migrations/0008_cast.sql`) and already injects a cast block into the tail. What is missing
is that every member sees the same world state.

**Concrete change.** A `knownBy`-style map keyed by character name, validated in
`src/lib/state/schema.ts:111` alongside the existing `conditions`/`outfits` maps (both are
already name-keyed `Record<string, string>`, so the shape and the "replaces wholesale, not
merges" rule are precedents in the file), written by the same cheap-model patch in
`worker/src/state/update.ts`, and filtered per responder when the tail is assembled in
`src/lib/prompt/assemble.ts:35`. Cross-persona edges must survive a member's departure,
which is why the map is keyed by name rather than by cast row id — `removeCastMember`
already keeps the departed member's lines in the transcript.

**Citation.** `docs/research/03-competitors.md` §12.3 — the report's own conclusion for the
most durable gap. SocialMemBench (arXiv 2605.17789v1) measured four OSS frameworks
(Mem0, LangMem, Graphiti, Cognee) at **0.12–0.18** against a **0.345** uncompressed
baseline; theory-of-mind questions scored **0.05–0.10** across all four; Graphiti scored
**0.00** on departed-member recall. The paper names the missing primitive: a
`KNOWS_ABOUT` cross-persona edge, "absent from every framework we evaluated."
`docs/research/06-dungeon.md` §7 rule 7 states the same opportunity independently.

**Cache.** Per-responder filtering means the block differs between speakers. It is a tail
segment, so that is affordable — but the filter must be applied when rendering the block,
not by rewriting history.

---

## 3. A world clock that survives the chat — **DIFFERENTIATED**

**Pitch.** One canonical time/location store per world, inherited down a location
hierarchy, advancing by rule rather than by narration, shared by every chat set in it.

**Why it is close.** `timePace` already exists (`src/lib/scene/setup.ts:24`,
`TIME_PACE_OPTIONS` at `:35`) and the engine already owns the clock rather than the model:
`worker/src/state/update.ts` is the only writer of the `state` row and
`validatePatch` accepts or rejects the whole patch. What is missing is *scope* — the state
row is per chat (`migrations/0002_state.sql`, `PRIMARY KEY (chat_id)`) — and *inheritance*:
`location` is a free string with no parent.

**Concrete change.** A `worlds` table plus a `world_id` on `chats`, a location parent chain,
and a resolution step in `worker/src/state/update.ts` that merges world → parent location →
this chat before rendering. `src/lib/prompt/stateBlock.ts` already renders the merged
document, so the renderer needs no change.

**Citation.** `docs/research/03-competitors.md` §12.2 — WyvernChat's Worlds is a nested
Environments → Locations hierarchy with documented **parent-location inheritance** and an
instruction-precedence stack (World → Environment → Location, last wins); Marinara's Game
Mode computes time in engine code (talking +15 min, travel +2 h, day rolls at midnight).
§12.2's own summary of the gap: "a single canonical world clock + location + inventory store
that survives **across sessions, across characters, and across chat branches**, queryable as
data rather than prose." §12.7 names the composite wedge.

**Cache.** A clock that advances per turn must never reach the head. It belongs in the
state block, which `src/lib/prompt/assemble.ts:35` already emits after `tailStart`.

---

## 4. Tune the memory cadence and the token budgets that already exist

**Pitch.** The summarizer runs on a fixed message count and the budgets are fixed numbers;
both have measured starting points in the research that are better than the current
guesses.

**Concrete change.** `SUMMARY_EVERY = 20` (`worker/src/memory/schedule.ts`) is a message
count; the research argues for triggering on context pressure (~70% of the window) instead.
`DEFAULT_STATE_BUDGET = 800` (`src/lib/prompt/stateBlock.ts:55`) matches the researched
allocation; `SCENES_PER_ARC = 10` (`worker/src/memory/consolidate.ts:16`) and the summary
tier structure do not. `computeWindowStart` (`src/lib/prompt/window.ts:23`) already
implements the sawtooth the research prescribes — that one is done.

**Citation.** `docs/research/05-memory.md` §(c) — AI Dungeon writes a memory of exactly
**6 actions** and regenerates a full plot summary every **15 actions**. §(e) — the concrete
budget: state block **≤800 tokens**, lorebook **≤15–25%**, recent verbatim turns **~15–25%**,
rolling summary **~5–10%**, headroom **≥20%**; summarize on context pressure rather than a
fixed count (MemGPT's warning token count); Chroma's context rot (18 models) as the reason
"adding tokens is not free even when they fit."

---

## 5. Harden the state tracker against the documented failure modes

**Pitch.** The state engine already avoids most of the field's failure modes; pin the ones
it avoids so a future change cannot reintroduce them.

**Already done, worth keeping.** State is owned in code, not round-tripped through the
model: one writer (`worker/src/state/update.ts`), one validator
(`src/lib/state/schema.ts:111`), per-row snapshots (`migrations/0011_message_state.sql`).
That is §7 rules 1, 2 and 8 of the dungeon research, and it is the answer to failure modes
1–3 in §3 (lost updates from a summarizer rewriting state, incomplete JSON, swipe desync).

**Still missing.** Failure mode 8 — identity corruption. Multihog #32 emitted
`{{user}} (profession)` where a character name was expected. `src/lib/state/schema.ts`
already has `isName` and a `NOT_A_NAME` list (it dropped `present: ["me"]` in practice);
the same guard should apply to the keys of `outfits`, `conditions` and `away`, which are
currently free strings.

**Citation.** `docs/research/06-dungeon.md` §3 (documented failure modes, with issue
numbers) and §7 (design implications).

---

## 6. Larger bets

Clearly larger than the five above: each needs a new subsystem, not a new column.

- **Persistent visual identity.** A per-character record of face, current outfit and
  injuries, fed into every generation. `src/lib/state/schema.ts` already tracks `outfits`
  and `conditions` per name, so the state half exists; the generation half does not.
  Citation: `docs/research/03-competitors.md` §12.4 — Marinara's Beholder (body-slot
  clothing, wounds, held items) plus Attach Card Appearance are the closest, and they are
  two separate opt-in agents.
- **Voice identity.** A per-character voice that persists across sessions the way text
  memory does. Citation: `docs/research/03-competitors.md` §12.5 — Kokoro-82M at RTF 0.1238
  on CPU makes self-hosting real; the unserved part is persistence, not synthesis.
  See also `docs/research/13a-tts.md`.
- **A dungeon that is generated once and then remembered as data.** Topology, loot state,
  enemy positions and opened doors as records rather than re-narration. Citation:
  `docs/research/03-competitors.md` §12.6 and `docs/research/06-dungeon.md` §5 —
  Marinara's maps are authored/AI-drafted then held; Multihog's Map Evolution approximates
  autonomy in a single extension.

---

## QoL

Small, high-frequency wins found while reading this codebase.

- **Replace the four remaining `window.confirm` flows.** `src/components/CastPanel.tsx:57`,
  `src/routes/Characters.tsx:92`, `src/routes/Personas.tsx:57`, `src/routes/Presets.tsx:144`.
  The `Modal`-based sheet now used for forking (`src/components/NamePrompt.tsx`) is the
  pattern; a confirmation needs only the two-button form of it. The native dialog is
  suppressed outright in some embedded webviews, so the in-app sheet is the only form
  that works everywhere.
- **De-duplicate `/personas` by name.** The live database holds **four personas all named
  `Ivan`** (`GET /api/personas` returns 5 rows, 2 distinct names), so the picker in
  `src/components/PersonaMenu.tsx` shows four identical rows with different descriptions
  and no way to tell which chat points at which. The API already returns `chat_count`; a
  count beside each duplicate, or a merge action, makes the choice decidable.
- **Surface the unresolved `{{user}}` instead of substituting silently.** `Chat.tsx`
  resolves `{{user}}` to `User` when the chat has no persona
  (`src/lib/prompt/macros.ts:65-68` leaves the placeholder literal precisely so the gap is
  visible). Rendering it as a name hides that. The right affordance is the persona sheet
  one tap away: "this reply says `{{user}}` — attach a persona?" `PersonaMenu` already
  documents the intent, and `GET /api/chats/<id>/messages` already returns
  `persona: null` for exactly this case.

---

## 7. Assessed external memory designs (2026-10-04)

Three SillyTavern memory extensions were assessed as candidates for tessera's memory
design. Verdicts below; the steals are ideas, not commitments.

**recall** (lathlearns/recall, MIT) — model rejected: a single manually-triggered rolling
summary is weaker than tessera's auto tiers plus the derive-from-original rule
(`worker/src/memory/summarize.ts` re-reads the original messages of the covered range for
every summary, so errors stay local instead of compounding). Three steals, ranked:

- **Staleness detection.** Hash the covered message range per summary and mark the
  summary stale when an edit lands inside it. Today `editMessage`
  (`worker/src/messages.ts:224`) rewrites `content` and the covered summary keeps being
  injected unchanged — no hash, no flag. Facts already have the precedent: migrations
  0014/0015 gave them per-row read-time coordinates (`learned_at_seq`,
  `superseded_at_seq`); a summary's covered range is the same family of coordinate, but
  an edit does not disturb it.
- **One-off steering.** A text the writer passes into the next summarize/extract job
  payload — recorded once, never replayed.
- **Pressure-triggered cadence.** Summarize at ~70% of the window instead of a fixed
  `SUMMARY_EVERY = 20` (`worker/src/memory/schedule.ts:23`); `docs/research/05-memory.md`
  §(e) already argues this.

**VectFox** (KritBlade/VectFox, AGPL) — architecture interesting, adoption scoped down.
The one steal worth building soon is **agent-lite query expansion**: a cheap model
rewrites the recall query into 2–4 lexical variants before `recall()`
(`worker/src/memory/recall.ts`) runs. **EventBase-style event-granular extraction** is a
medium-effort option that first needs a fact/event boundary decision. Dense vectors
rejected: D1 has no vector type, so they would mean adding Vectorize or Qdrant plus an
embedding provider — for one user.

**Summaryception** (Lodactio/Extension-Summaryception, AGPL) — rejected outright:
recursive re-summarization of summaries contradicts product principle #4 ("derive, don't
trust") and the fixed-depth argument in `worker/src/memory/consolidate.ts`; its motivating
problem (hard truncation of long chats) does not exist in tessera.

Only recall is MIT; the other two are AGPL — irrelevant for ideas, relevant if code is
ever copied.

Every steal renders into the tail only — `memoryBlock` is a tail segment
(`src/lib/prompt/assemble.ts:66`) — so all are cache-safe; staleness corrections ride on
the prefix misses that message edits already cause (`worker/src/messages.ts:38`).

## The caching rule

Stated once, because it constrains every idea above.

Providers cache the **exact token prefix from position 0**. Anything that varies per turn
and lands in the prefix destroys the cache for every later turn of that chat. Tessera's
layout encodes this: `src/lib/prompt/assemble.ts:35` emits a head that is byte-identical for
the life of a chat and a tail that may vary, and `src/lib/prompt/macros.ts` splits fixed
macros (safe in the head) from dynamic ones (tail only, and `substituteHead` deliberately
does not apply them).

Where each idea would tempt a violation:

| Idea | The tempting mistake | Why it breaks |
|---|---|---|
| 1. Branch-aware memory | Filter the history array by branch instead of filtering the recalled block | The window start shifts every time the reader swipes, so nothing upstream can ever cache |
| 2. Epistemic isolation | Put each member's belief map in the character block, which is head | The head would differ per speaker and per turn |
| 3. World clock | Render the advancing clock next to the location in the head | Every turn rewrites the prefix |
| 4. Memory tuning | Regenerate the summary and put it at the top of context | Invalidates the prefix every N turns — the naive design the research explicitly rejects |

Citation: `docs/research/12-caching.md` §0 and §4 — every major provider caches only the
exact prefix from token 0; §3 lists the anti-patterns in damage order; §4.3 gives the
cache-safe auto-summarisation design. `docs/research/03-competitors.md` §12.8 states it as
the one architectural hazard nobody in this market has solved.
