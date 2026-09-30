# Session handoff — 2026-09-29

Everything is committed on `main`. **10 commits are pushed**; the last one (`6703a62`) is
local only — push it when convenient:

```sh
git push origin main
```

## Where things are

Live at **https://tessera.ivanderseah08.workers.dev** (Worker version `8cc99fd9`).
APK at `android/app/build/outputs/apk/debug/app-debug.apk` (5.5 MB).

279 tests, `tsc -b` clean, lint clean.

## Resolved: the cache "stall" was a step function

Investigated and closed. `verify/cache-progress.ts` over 24 consecutive turns shows the
cached count holding flat for several turns and then jumping by ~128-134:

```
turn  5: 131 cached   turn 12: 267   turn 18: 396   turn 23: 523
```

That is the provider extending the cached prefix in fixed-size blocks. The prefix was
advancing normally the whole time; my e2e assertion ("the cached share grows every turn")
was asserting the wrong property, because it fails on exactly the turns between block
boundaries. It now asserts what a real regression would break: caching engages, the
cached count never goes backwards, and the prompt grows rather than resetting.

`verify/meter-validity.ts` then confirmed the meter is honest at this scale:

```
warming:   cached 523, 524, 524, 654, 656, 657, 659, 659
timestamp injected into the system prompt:  cached 0, 0, 0, 0
restored:  cached 784, 917, 917, 917
```

A deliberate prefix break collapses the hit rate to zero and restoring recovers it. That
is the check the plan calls the most important one in the project, and it passes.

## Two known code-quality items

1. **`worker/src/effective.ts` duplicates `parsePresetConfig`.** PresetsUI pointed out
   that `effective.ts` reads `config_json` with inline type checks rather than calling
   the clamped parser in `src/lib/presets/presetConfig.ts`. One clamp, one implementation.
2. **`useAsync` has a `useCallback`-shaped hole** — it is a ref-based hook now, but
   several routes still pass `[]` as deps where they mean "re-run when X changes".

## What is built

| Area | State |
|---|---|
| Prompt assembler, sawtooth windowing, prefix guard | done — 90% cache at turn 40 |
| SSE parser, provider adapters (OpenRouter, Kenai) | done |
| Chat: swipes, edit, delete, regenerate, impersonate, continue | done |
| Branching: regenerating an old reply forks the scene; swiping back restores it | done — `branch.ts` + migration 0005 |
| Markdown rendering (CommonMark, `<details>`, XSS-safe) | done |
| Theme system (tokens as data, light/dark, custom CSS) | done |
| Macros (`{{char}}`/`{{user}}` head-safe, dynamic tail-only) | done |
| Personas + `{{user}}` resolution | done |
| World state: engine, viewer, edit, weather | done |
| Keyword lorebook (full ST matching) | done |
| Memory: summaries, FTS5 recall, job queue | done — verified running |
| Presets (chub-shaped, ST import, per-chat) | done |
| Character CRUD: edit, fork, avatars | done |
| Forge: draft, critique, token cost | done |
| Android APK | built |
| Desktop (Tauri) | built — MSI 3.69 MiB, NSIS 2.79 MiB |

## Traps that bit, so they bite again

- **`bun run build` strips `VITE_API_BASE` from `dist/`.** Running it after `build:native`
  and then `cap sync` packages a bundle that cannot reach the API. `src/lib/native/bundle.test.ts`
  guards it; it caught me once.
- **`wrangler dev` does not reload `.dev.vars`.** Restart it after changing the token.
- **The transcript is a tree, not a list.** `messages.parent_id` is the structure and
  `worker/src/branch.ts#walkPath` is the only thing that decides what is on screen: follow
  the ACTIVE child of each position, stop when a position has none. Consequences worth
  knowing before touching messages:
  - Two rows are versions of one position exactly when they share a parent. Nothing keys
    on `swipe_group` any more — it is left in the schema, unread.
  - Regenerating an old reply does NOT rewrite the turns after it. The new version becomes
    the active child, so the old continuation leaves the path and comes back when you swipe
    to the old version. Never "delete the rows after X" — that is the behaviour this
    replaced, and it is unrecoverable.
  - A `send` writes TWO rows in a chain: the user message is parented to the path tail and
    the reply is parented to the user message. Parenting both to the tail makes them
    siblings, and the walk then drops the reader's own line. `branch.test.ts` covers it.
  - A row's `seq` strictly increases along a path, which is why the prompt cut for `send`
    can filter on it.
- **D1 bills ROWS READ, and the free tier caps it at 5M/day — the whole site 500s when it
  runs out.** This is not a soft limit; every query fails until 00:00 UTC. It happened on
  2026-09-30 and took the site down for a day. Two causes, both now fixed and guarded:
  - `scheduleMemory` computed a message's "position" with a correlated subquery over
    `swipe_group`, a column no code has written since branching replaced it. So it
    evaluated `COALESCE(NULL, id) = COALESCE(NULL, id)` for every row — an O(n²) scan to
    return the row's own `seq`. It runs after EVERY turn, so it read 776,000 rows on a
    600-message chat. `worker/src/memory/memory.test.ts` now fails if any query the
    scheduler runs mentions `swipe_group`.
  - The path walk's per-step lookup used the wrong index. `idx_messages_parent` is
    `(chat_id, parent_id, seq)` and cannot satisfy `active = 1`, so the planner scanned
    every active message in the chat at every step. `0006_walk_index.sql` replaces it with
    `(chat_id, parent_id, active, seq)`: 1,417ms → 3.29ms at 5,000 messages.
  - Anything that reads messages per turn must be bounded by the PATH, not the chat. If a
    new query's cost grows with conversation length, it will eventually cost a day.
- **`swipe_group` is dead.** No code writes it. Never read it; `parent_id` is the
  structure. A query that mentions it is a bug — see above.
- **`wrangler d1 migrations apply --remote` must run before the Worker deploy** that needs
  the new schema. A missing index does not error, it just gets slow — and slow is what the
  read cap punishes.
- **A D1 BLOB does not come back as an `ArrayBuffer`.** It arrives as a plain array of
  byte numbers, and `new Response(numberArray)` is not a `BodyInit` — it serializes to
  nothing, so the avatar endpoint answered `200 image/png` with a zero-byte body while the
  bytes sat intact in the table. `characters.ts#asBytes` coerces; do not trust the generic
  on `.first<T>()` for a blob column.
- **`html`/`body`/`#root` must stay `min-height: 100%`.** With `height: 100%` the root box
  is exactly one viewport tall, and a sticky element is confined to its containing block —
  so the titlebar and composer silently stop sticking after the first screen of scroll.
- **`js-tiktoken` cannot go in the Worker** (2.3 MB vocabulary, exceeds startup CPU).
  Use `src/lib/tokenEstimate.ts` there.
- **Kenari buffers SSE at its gateway** — verified across five models. So a regression in
  our own streaming is invisible from the client. `worker/src/chat.streaming.test.ts`
  pins it against a deliberately slow upstream.
- **A `position: fixed` sheet must be portalled.** The chat menu scrolls and is absolutely
  positioned, so a dialog declared inside it is positioned against the menu and lands
  off-screen. `Modal` renders through `createPortal` to `document.body`.

## Not done

- Share-sheet **handler** (intent filters are compiled in; nothing reads the intent yet)
- Release signing for the APK / installers
- iOS
- The cache investigation above

## Session — six fixes (509 tests, `tsc -b` clean, lint clean)

**Thoughts removed.** `worker/src/thoughts.ts`, the route, the `Turn.tsx` component, the
`Chat.tsx` callback and the CSS are gone. `migrations/0010_message_thoughts.sql` was
deleted while its ledger row remains — `wrangler d1 migrations apply` ignores a ledger row
with no file, and `--local` reports "No migrations to apply". `messages.thoughts` is a dead
nullable column in every existing database; nothing reads it and `BRANCH_COLUMNS` does not
select it. Do not re-add the file and do not add a `DROP COLUMN`.

**A failed turn no longer orphans the reader's row.** `persistUserMessage` still runs
BEFORE the provider call — that ordering is deliberate, a crash must cost a reply and never
the reader's own words. Instead `messages.ts#abandonMessage` deactivates that one row from
every post-persist failure (`network`, `provider_http`, `stream`, and a throw from
`buildPrompt` or anything after it, which is now wrapped). An inactive row is off the walk,
so `tailId` returns the last real turn and the next `send` does not stack two `user`
messages in front of the model. Existing orphans are left alone — the defect is
forward-looking.

**`timePace: 'manual'` means manual.** `SYSTEM` used to describe `time` unconditionally —
the key said "advance it as the scene moves" and a Rules bullet said "record it in full" —
while the pace rule was appended AFTER the whole string, so the specific instruction won and
`manual` advanced the clock anyway. The time key description and its recording rule now
come from `TIME_KEY` / `TIME_BULLET` per pace, spliced into `SYSTEM` placeholders by
`buildSystemPrompt(pace)`. `seedOpeningState` takes the pace too. Measured live, one chat
per pace, one exchange stating "half past nine": `manual` stayed at 04:00, `minute` → 04:01,
`hour` → 05:00, `scene` → 09:30.

**A summary is a summary.** `summarize.ts` forbids quoted dialogue in `SYSTEM` and
`looksLikeSceneProse` catches the failure mechanically — quoted speech or a present-tense
dialogue tag — retrying ONCE with the transcript re-sent plus a nudge. A retry that is also
scene prose, or empty, does not replace the first attempt. `consolidate.ts` was left alone:
an arc summarises already-summarised text, which cannot contain dialogue.

**Recall is observable.** `listMemory` returns `recalled`, `rendered` and `query`,
following the `getState` `rendered` precedent — the panel shows the block the narrator was
actually given, not an approximation. The query is the last `user` row's content, which is
what `buildPrompt` uses for the modes that carry no new text. Note that recall runs
`messages_fts` over the whole chat, so the query row matches ITSELF and appears among the
hits; that is what the model really receives.

**Truncation is visible.** `finish_reason` is read into `ParsedFrame` by both providers, and
the terminal frame carrying only a reason is no longer dropped. `pipeStream` returns it, the
`done` frame carries `truncated`, and the turn renders "Stopped at the output limit." with a
Continue link. **Kenari does send `finish_reason`** — confirmed live: with `maxTokens: 16`
the frame was `finish_reason: 'length'`, so the `completionTokens >= maxTokens` fallback was
not needed. The stored global `maxTokens` was `256` against a code default of `1024`; it is
now `1024`.

### Two more traps

- **`.app-link` is a dangling class.** `ThemeEditor.tsx` has used it since the design rework
  and no stylesheet defines it, so that button renders as bare text under Tailwind's
  preflight. The truncation marker scopes its own rule (`.turn-truncated .app-link`) rather
  than defining the class globally, which would restyle Settings as a side effect.
- **A deleted summary range cannot be re-covered by the scheduler.** `enqueue` keys on
  `summarize:<chat>:<from>:<to>`, so the ledger row from the original job blocks a second
  enqueue of the same range forever. This is the queue's double-write guard working as
  designed, not a bug to fix in passing — but it means "delete a summary and let the
  scheduler rebuild it" does not happen. Rebuild by enqueuing the NEXT uncovered range, or
  by deleting the old job row too.

