# World state: does the engine actually fill it?

**Date:** 2026-09-30
**Model:** `kenari` / `deepseek-v4-1-flash` (the cheap model — the state engine uses it, not the narrator)
**Verdict:** it works, and it works well. Every field in the schema was observed populated with
correct, specific values. Two things were wrong and are now fixed: the prompt asked for
in-fiction time instead of real-world time, and there was no way to record that a character
had left the scene.

---

## How it works

After every completed `send` turn, a separate call to the cheap model proposes a JSON patch.
`validatePatch` accepts or rejects it whole, and the accepted result is rendered into the
prompt **tail** — never the head, so it costs nothing in cache terms. It runs via
`ctx.waitUntil` *after* the reply is delivered, so state written by turn N is visible from
turn N+1.

**Measured lag: ~3 seconds after the reply arrives.** An earlier check in this session
looked 6 seconds after a reply and concluded nothing had been written; it had, by then. The
update is not synchronous with the reply and a check that is too eager reads as a failure.

---

## Field-by-field, observed

Test chat: `b92d536f-d276-40a8-950c-e6dd583fbe74`, a 601-message seeded conversation.

| Field | Populated? | Example observed |
|---|---|---|
| `time` | yes | `Friday, 27 February 2026, 05:35 AM` |
| `location` | yes | `Sydney, on the coast, sitting on the edge of the bed` |
| `weather` | yes | `warm, clear morning` |
| `present` | yes | `["Quill"]` |
| `away` | yes | `{"Quill": "the hold"}` |
| `inventory` | yes | `["ledger", "brass key"]` |
| `notes` | yes | see below |
| `conditions` | **never observed** | — |

### Notes is the workhorse

It is the field that carries the things the narrator must not forget, and it captures them
faithfully:

```
Notes:
- Barometer readings are entered on the slate by the barometer in the chart space each
  watch; the binnacle slate is only for compass error.
- The last three barometer readings are carried to show the trend.
- A green oilskin pouch behind the barometer holds the tide-table for the outer roads,
  including a minus eleven minute correction for the ninth buoy.
```

Note the third entry: that fact was stated **600 messages earlier and outside the context
window**. The state engine does not recall it from the transcript — the model was told it in
the same exchange that produced the note. See `memory-recall.md` for the retrieval path.

### `conditions` was never populated

Not once, across every turn run here. It is in the schema, in the prompt, and in the
validator, and the model never proposed it. That is not surprising — nothing in these
scenes established an injury or illness, which is what the field is for. **Unproven rather
than broken**, but it should not be relied on.

---

## Two things that were wrong

### 1. Time was in-fiction, not real

The prompt asked for "in-fiction time of day or date", so the engine recorded:

```
Time: past midnight, day 301
```

The reader's actual intent, stated directly: *"time in my head is supposed to be the actual
time. Let's say, Friday, 27 February 2026, 05:35 AM."* — and likewise for location, which
should name a real place at real specificity ("Sydney's coast, on the bed"), not a generic
one.

Fixed in `worker/src/state/update.ts`. The prompt now asks for a full real-world date and
time, and for location to name the city or region when it is known. Verified after the
change:

```
time:     Friday, 27 February 2026, 05:35 AM
location: Sydney, on the coast, sitting on the edge of the bed
weather:  warm, clear morning
```

### 2. A character who left the scene stayed in it

The schema had one `location` and one `present` list. A story that cuts away — "meanwhile,
Ada is in the courtyard" — had nowhere to record that Ada was no longer in the room, so the
narrator kept writing her into scenes she had walked out of.

Added `away`: a map of character name to where they are instead. It renders directly after
`present`, because the two answer the same question and a narrator that reads only one of
them writes the other person into the scene:

```
Present: 
Elsewhere: Quill is at the hold
```

Only characters who are *away* appear, so the common case (everyone in the room) costs zero
extra tokens. The validator enforces the invariant that nobody can be both present and away
— a model that writes both is confused, and the contradiction would reach the prompt as two
facts. `present` wins, because the reader can see who is there.

Per-character *locations* for people in the same scene, and per-character clocks or
timezones, are deliberately not modelled. A scene that spans timezones is rare enough that
inventing a timezone table would cost every other scene for it.

---

## Drift: the failure this subsystem is known for

The project's own notes record a real incident: a cast list containing the pronoun `"me"`,
and a user name the narrator had invented and stored as fact. `validatePatch` filters
role-words from `present` and now from `away` too, and logs what it drops.

Across every turn run in this session, **no drift was observed**. The values stayed
consistent with what was said: the location moved when the scene moved, the inventory
gained the ledger and the key when the reader said they were carrying them, and nobody
invented a place or an item. The `notes` entries are paraphrases of what was actually said,
not fabrications.

This is one model on one set of scenes, so it is evidence rather than a guarantee. The
choke point is what makes it safe: nothing but a validated patch can write the document,
and an unknown key or wrong type is rejected whole rather than partially applied.

---

## What the narrator actually receives

The full rendered block, from the chat under test:

```
World state:
Date/Time: Friday, 27 February 2026, 05:35 AM
Location: Sydney, on the coast, sitting on the edge of the bed
Weather: warm, clear morning
Present: Quill
Inventory: ledger, brass key
Elsewhere: Quill is at the hold
Notes:
- Quill has gone down to the hold; the narrator remains alone on the cobbles.
- The narrator will keep the brass key on their person and the ledger dry under their coat.
```

Deterministic: sections emit in a fixed order and the maps are sorted by name, so the same
state renders byte-for-byte identically every turn. Budgeted: over its 800-token allowance
it sheds whole sections, lowest value first (`notes`, then `inventory`, `conditions`, `away`,
`weather`, `present`), rather than truncating mid-sentence.

## Reproducing

```bash
TOK="<token>"
CHAT="<chat id>"
# Send a turn that establishes time, place and weather, wait ~10s, then read it back.
curl -s -N -X POST "https://tessera.ivanderseah08.workers.dev/api/chat" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  --data-binary "{\"chatId\":\"$CHAT\",\"content\":\"It is Friday, 27 February 2026, 05:35 AM. I am in Sydney, on the coast, on the bed.\",\"mode\":\"send\"}"
sleep 10
curl -s -H "Authorization: Bearer $TOK" "https://tessera.ivanderseah08.workers.dev/api/state/$CHAT"
```

The scratch chat `b92d536f-d276-40a8-950c-e6dd583fbe74` was left in place so these values
can be re-read. The seeded history in it is synthetic; the state document is not.
