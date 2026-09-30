# Memory recall over a long conversation

**Date:** 2026-09-30
**Model:** `kenari` / `deepseek-v4-1-flash` for both the narrator and the cheap model
**Preset:** `Experiment 64k` — `contextSize: 64000`, attached to the test chat
**Verdict:** memory recall **works**, and it was **broken until this session**. The bug
that broke it is described below; the test at the end is the same test that failed before
the fix.

---

## What was tested

Whether the app can answer a question about something said hundreds of messages earlier,
when that message is far outside the context window — so that the *only* way to know it is
the memory system's recall.

### Setup

A scratch chat was seeded directly in D1 with 601 messages (300 user/assistant pairs),
**110,917 tokens** of prose. The context window is 64,000, so the early messages cannot be
in the prompt by any normal means.

One fact was planted at **seq 1920** (message 4 of 300), and appears nowhere else in the
seeded history:

> Remember this and keep it: the tide-table for the outer roads lives in the green oilskin
> pouch behind the barometer, and the correction for the ninth buoy is minus eleven minutes.

Everything else was filler that deliberately shared vocabulary with the fact — the same
ship, the same barometer, the same buoys — so keyword search had to actually rank the right
row rather than match everything.

```
601 rows, 110917 tokens, fact at seq 1920
64000-token window  ->  the fact is unreachable by context
```

---

## The bug: recall searched with AND, and found the question

`buildMatchQuery` joined every token of the reader's message with FTS5's implicit AND.

A whole message is mostly connective tissue. Asking for a row containing "the" **and**
"is" **and** "it?" as well as the words that matter matches nothing.

Measured on the first test chat (514 messages), the probe message:

```
Bosun, the chest below is locked and I have lost the thing that opens it. What was it, and what number was on it?
```

ANDed to **exactly one row** — the probe itself:

```
seq=1306 role=user
  Bosun, the chest below is locked and I have lost the thing that opens it. What was it, and
```

Recall returned the reader's own question as *"a relevant earlier moment"*. The answer,
at seq 743, was never retrieved. The model then invented one:

> As to a number: I keep no number on a key. Numbers go in the ledger marked 12 — the cargo
> tallies, and as of this morning the word *short*, written against the lamp oil where no
> one can rub it out.

The real answer was **the brass key marked 417**. The model said no such key existed and
produced a different number. A confidently wrong reply that looks like recall is the worst
possible failure mode for this subsystem — worse than admitting it does not know.

### The fix

`worker/src/memory/fts.ts` now:

1. **ORs the terms** instead of ANDing them. Missing the answer is unrecoverable; an extra
   mediocre hit is ranked last by bm25 and wastes a line of a bounded block.
2. **Drops stopwords** (articles, pronouns, auxiliaries, the copula) before building the
   expression, so the query is the words that carry retrieval signal.
3. **Strips surrounding punctuation**, so `it?` and `it.` become the word `it` rather than
   two tokens FTS5 has never seen. This also removes `-` and `*` entirely, so the NOT and
   prefix operators cannot be spelled at all — strictly safer than quoting them.
4. **Caps at 24 terms**, so one long message cannot produce an unbounded MATCH expression.

The same probe message now reduces to:

```
forgotten OR outer OR roads OR Remind
```

which finds the planted row.

---

## The test, after the fix

Three turns were sent to the seeded chat. The relevant one:

**Asked:**

> One more thing — I have forgotten what I was told about the outer roads. Remind me.

**Replied:**

> The tide-table for the outer roads lives in the green oilskin pouch behind the barometer,
> sir — the one in the chart space. And the correction for the ninth buoy is minus eleven
> minutes.
>
> It is written where I will see it, and I have not had to be told twice. If you doubt me,
> you have only to open the pouch and see how I keep it.

Both halves of the planted fact — **the green oilskin pouch behind the barometer** and
**minus eleven minutes for the ninth buoy** — came back correctly. Neither appears in the
seeded filler, and neither can be in the context window. This is recall.

An earlier turn in the same conversation shows it is not a one-off, and that the model
attributes the memory correctly rather than reciting it:

> And behind the barometer is the green oilskin pouch, as you set down. The tide-table for
> the outer roads lives in it, and the correction for the ninth buoy is minus eleven
> minutes.

### What this does not prove

- **Summaries did not carry it.** Six scene summaries were produced on the first test chat,
  and none of them contained the planted fact — they are one-paragraph scene sketches. The
  recall that worked here is the FTS path over raw messages, not the summary path. The
  summary tier is a story-so-far aid, not a fact store.
- **No facts were extracted.** `facts` was empty on both chats after many turns. The
  extraction pass that populates that table either is not running or is not producing
  anything on this model. Recall still works because it searches `messages_fts` directly,
  but the "established facts" section of the memory block is dead weight in practice.
- **A single hop was tested.** This shows one fact at ~600 messages back is retrievable. It
  does not show that a hundred such facts would all be ranked into the top 8 results, which
  is the limit recall passes to the prompt.

---

## Numbers observed

| Thing | Value |
|---|---|
| Seeded history | 601 messages, 110,917 tokens |
| Context window under test | 64,000 tokens |
| Fact distance from the end | ~600 messages |
| Summaries produced (first chat) | 6 |
| Facts produced (both chats) | 0 |
| Recall limit passed to the prompt | 8 hits |
| Result after fix | fact reproduced verbatim |

## How to reproduce

```bash
TOK="<token>"
CHAT="<a chat id>"
curl -s -N -X POST "https://tessera.ivanderseah08.workers.dev/api/chat" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  --data-binary "{\"chatId\":\"$CHAT\",\"content\":\"Remind me about the outer roads.\",\"mode\":\"send\"}"
```

The scratch chats were left in place rather than deleted, so the result above can be
re-checked: `b92d536f-d276-40a8-950c-e6dd583fbe74` (clean, shows correct recall) and
`16cbd0c7-671f-4755-bc9b-f62a5eaad788` (poisoned by the pre-fix confabulation, kept as the
counter-example).
