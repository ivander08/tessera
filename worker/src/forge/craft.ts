/**
 * What the consultant knows about writing a character card.
 *
 * This is the feature's actual value: a model asked to interview someone about a character
 * without it produces a generic questionnaire and an encyclopaedia entry. The rules below are
 * transcribed from `docs/research/07-charcraft.md` — the repository's sourced survey of card
 * craft, 587 lines with citations — and are written as instructions because that is how they
 * are used.
 *
 * Kept as one exported constant rather than inlined into the system prompt so the system
 * prompt reads as a sequence of concerns — role, method, knowledge, output shape — instead of
 * one wall of text.
 */
export const CARD_CRAFT = `# How a card works

A card is not a document. It is a fragment of a prompt reassembled from scratch on every
generation, and its fields have different lifetimes. Every disagreement about card length is
really an argument about which tier a fact belongs in, so decide the tier before you write
the fact.

- Permanent — "name", "description", "personality", "scenario". Re-sent in the prompt head on
  every turn, forever. This is where length compounds.
- Front-loaded — "first_mes", "alternate_greetings", "mes_example". Paid once, or until
  evicted. The cheapest place to buy style.
- On-demand — keyed "character_book" entries, and "post_history_instructions" in the tail.
  Paid only when they fire.

# Field by field

## name
Required, and the only required field. A name carries priors: a name implies a class, a
genre, an era, and a model already knows some names better than others. Prefer a short name
the transcript can carry for a thousand turns over a long formal one.

## description
Who the character is: appearance, history, voice, mannerisms, contradictions. Show, don't
tell. The prose style of the description leaks into the model's voice, so write it in the
register the character should be played in — a terse description produces a terse character.

Prefer a behaviour engine over an adjective list. "Claire needs something to be happening;
silence doesn't stay quiet long in her head" generates behaviour, while "confident,
charming, quick to anger, quietly depressed" generates nothing. Resolve contradictory traits
before writing them — "toxic but also a sweetheart" produces slop. One sharp trait beats
three vague ones.

## personality
A short trait list. Its real job is re-stating traits that decay over a long chat, not
duplicating the description. It may be left empty when the description already carries the
character.

## scenario
The circumstances the scene opens in. It must be a static fact of the world, never an event:
a scenario that locks the character into one specific happening traps them, and the model
will keep dragging the scene back to it. May be blank.

## first_mes
The highest-leverage single field, because the model picks up its style and length from the
opening more than from anything else. Give the user something concrete to react to — a
question, an object, a gesture, a decision pending — then stop, with the situation open
rather than resolved. Roughly five to seven lines. Write it in {{char}}'s voice, present
tense.

## greeting_states
Every opening — "first_mes" and each entry of "alternate_greetings" — gets a matching entry in
"greeting_states", in the same order. It is the scene that opening begins in, as three short
strings: "time", "location" and "weather". The greeting's prose says what is happening; this
says where and when, in the form the narrator can read directly instead of inferring from the
paragraph. An opening that begins "the rain has not let up since the market closed" states
"weather": "heavy rain" here. An opening that does not establish a time gets no "time" key —
leave it out rather than inventing one. An opening with no scene at all gets an empty object.
State the full real-world date and clock time: "Friday, 27 February 2026, 05:35 AM". A bare
clock ("the small hours") is a fallback for an opening that names no date; a machine
timestamp (an epoch number or an ISO string) is never correct.

## mes_example
The {{user}}: / {{char}}: block format, two to six short exchanges, showing voice rather than
describing it. Show how they speak when it matters, not small talk.

## system_prompt
Behavioural instructions only: how the character speaks, what the narrator should and should
not do. In this app it overrides the reader's global system prompt, so anything essential to
the character belongs in the description instead.

## post_history_instructions
The last text the model reads before generating, so it carries more weight than the system
prompt. One or two sentences.

## creator_notes
Human-facing authorial intent. Never sent to the model.

## tags
Five to ten short lowercase tags.

# Hard rules

- Never write {{user}}'s words, actions, thoughts, or feelings — not in "first_mes", not in
  "mes_example", not anywhere. Writing them teaches the model that impersonating the reader
  is allowed, and it is the most-reported failure in the field. Scene-setting and emotional
  context are fine; deciding what the reader does is not.
- Never put behavioural instructions in "description" or "personality". Directives ("always",
  "never", "you must", "do not", "respond with") belong in "system_prompt" or
  "post_history_instructions". Instructions smuggled into the description are the single
  loudest complaint about published cards — dozens of them end up being half the tokens.
- Prefer positive phrasing. A model follows "always stay on solid ground" more reliably than
  "never jump off the cliff".
- Do not write an encyclopaedia entry. The characteristic failure of a generated card is
  encyclopaedia prose about a person rather than a token-efficient description of a persona
  for roleplay. Constrain toward dialogue and demonstration.
- Do not pad. State each fact once, in the tier where it belongs.

# Token cost

Name the shape of the cost, never a target. There is no controlled A/B test anywhere holding
a character constant while varying token count, so every published "optimal length" is one
author's heuristic. Report what a field costs — permanent, every turn, forever — and let the
user decide. Never assert a card is too long or too short as a fact; say what it costs and
what could move to a cheaper tier.`;

/** How many interview questions the consultant may ask before it must draft. */
export const MAX_QUESTIONS = 8;
