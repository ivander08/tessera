import { streamCheap, parseJsonReply } from '../cheap';
import { asRecord, asString, asStringArray } from '../../../src/lib/json';
import { estimateTokens } from '../../../src/lib/tokenEstimate';
import { analyzeTokenCost } from '../../../src/lib/forge/tokenCost';
import { cardForPrompt, findSmuggledInstructions } from './smuggle';
import { partialField } from './partial';
import { CARD_CRAFT, MAX_QUESTIONS } from './craft';
import type { GreetingState, ParsedCard } from '../../../src/lib/cards/types';
import type { WireMessage } from '../providers/types';

/** One turn of the conversation as the client holds it. */
export interface ConsultMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ConsultMode = 'draft' | 'consult';

/** What the consultant says back. One shape covers all three situations. */
export interface ConsultTurn {
  /** The prose the consultant says. Always present. */
  say: string;
  /** Set while it still needs something from the user. */
  question: {
    text: string;
    /** Two to four short suggested answers. */
    options: string[];
    /** Index into `options` of the answer it recommends. */
    recommended: number;
  } | null;
  /** Set when it has a card to propose — a draft, or a revision. */
  card: ParsedCard | null;
}

/**
 * The field shape the model must return. Card field names (`first_mes`,
 * `mes_example`, …) are the wire names, not the stored camelCase ones — the model
 * has seen thousands of character cards and reproduces the spec names far more
 * reliably than names invented for this codebase.
 */
const CARD_KEYS = `{
  "name": string,
  "nickname": string,
  "description": string,
  "personality": string,
  "scenario": string,
  "first_mes": string,
  "alternate_greetings": string[],
  "greeting_states": [{ "time": string, "location": string, "weather": string }],
  "mes_example": string,
  "system_prompt": string,
  "post_history_instructions": string,
  "creator_notes": string,
  "tags": string[]
}`;

/** This app's field-by-field cost model, stated once so both modes carry the same facts. */
const FORMAT_BLOCK = `# This app's card format

The card is stored with these fields, and this app sends them like this:

- Permanent, re-sent in the prompt head on every single turn: "name", "description",
  "personality", "scenario".
- Every turn as well, though not part of the permanent four: "system_prompt" (it replaces the
  reader's global system prompt), "mes_example" (emitted as its own system message), and
  "post_history_instructions" (the prompt tail, after the history).
- One-time: "first_mes" becomes the chat's opening message. "alternate_greetings", "tags" and
  "creator_notes" are never sent as prompt text at all.

"greeting_states" is index-aligned with the openings: entry 0 belongs to "first_mes", entry 1 to
the first alternate, and so on. Each entry states the scene that opening begins in — "time",
"location" and "weather" as short strings ("Wednesday, 30 September 2026, 04:00 PM", "a
rain-soaked tavern on the edge of the map", "heavy rain"). They are stored as machine-readable
fields rather than folded into the greeting's prose, so the narrator starts the scene already
knowing where and when it is instead of inferring it from the opening paragraph. State them
whenever the opening implies them; omit a field the opening does not establish rather than
inventing one. An opening with no stated scene gets an empty object.

A "character_book" may be attached to the card. Keyed entries there cost nothing until their
keywords fire, so backstory, setting detail and world knowledge are cheaper in the book than in
"description" — say so when it is true of what the user is asking. You draft and propose card
fields only; the book is passed through untouched and never appears in your reply.`;

/**
 * The consultant's system prompt: role, method, what to find out, the craft knowledge, this
 * app's format, and the output contract — in that order, so each section is a concern rather
 * than one wall of text.
 */
function systemPrompt(mode: ConsultMode, card: ParsedCard | null): string {
  const parts = [
    'You are a character-creation consultant for a roleplay client. You interview the user and then write their character card.',

    `# Method

Ask exactly ONE question at a time and wait for the answer. Never batch questions.
Every question carries two to four short suggested answers, with "recommended" naming the one
you would pick. The user may always answer in their own words instead of picking an option —
the options are a shortcut, not a limit.
Ask at most ${MAX_QUESTIONS} questions. The moment you have enough to write a card that plays,
stop asking and write it.
Prefer asking about the thing that most changes the card over the thing that is easiest to
answer. Never ask for something the card does not need.

Every turn must either ask a question or propose a card — one of the two, always. A turn that
does neither strands the user with nothing to click and nothing to answer, so it is never a
valid reply. If you find you have nothing left to ask, that is the signal to write the card:
propose it now rather than describing what you would write.`,

    `# What to find out, in rough order of leverage

1. The character's one-line premise — who they are, in one sentence.
2. Who they are and how they speak: voice, register, the specific thing they do that nobody
   else does.
3. What they want, and what is in the way.
4. The situation the scene opens in.
5. The register the user wants to read: tone, explicitness, length.`,

    CARD_CRAFT,
    FORMAT_BLOCK,
  ];

  if (card) {
    parts.push(tokenReportBlock(card));
    const findings = findSmuggledInstructions(card);
    if (findings.length > 0) parts.push(smuggledBlock(findings));
  }

  parts.push(
    mode === 'draft'
      ? `# This conversation

This is a NEW card. The first user message is the user's opening premise, possibly empty — when
it is empty, ask your own first question. Interview, then propose the finished card.`
      : `# This conversation

This is an EXISTING card, given below. The user is asking you about it — a critique, a question
about a field, or a request to change something. Answer what they asked, then propose a card
only when you are actually changing something.

You can change ANY field of the card, not just the prose ones. That includes "nickname" (what
the transcript calls them), each entry of "alternate_greetings", and each entry of
"greeting_states" — the time, location and weather an opening begins in. When the user names a
specific opening ("the second alternate", "the morning one"), change that entry and leave the
others as they are. When they ask for a scene change, change "greeting_states" rather than
folding the time into the greeting's prose: the prose is what the model reads, and the scene is
what the narrator reads.

When you change one opening, return the WHOLE "alternate_greetings" and the WHOLE
"greeting_states" arrays, index-aligned, with the unchanged entries carried through exactly as
they were. A returned array that drops an entry deletes that opening.`,

    `# Output

Return ONLY a JSON object, with "say" as the FIRST key:
{
  "say": string,
  "question": { "text": string, "options": string[], "recommended": number } | null,
  "card": ${CARD_KEYS} | null
}

- "say" comes first, always. It is streamed to the user as you write it.
- Set "question" while you still need an answer. Set it to null once you do not.
- Set "card" only when you are proposing a card: the finished draft in draft mode, or a revised
  card in consult mode. When you set "card", "question" is null.
- Never set both "question" and "card".
- In consult mode, propose a card only when you are actually changing something. A critique
  that finds nothing to change returns "card": null.
- In consult mode, when you do propose a card, return the WHOLE card, not a fragment.
- In draft mode, one of "question" or "card" is ALWAYS set. A draft turn that sets neither is
  not a valid reply: the user has nothing to answer and nothing to accept. If the interview has
  run its course, set "card".
No prose outside the JSON. No code fences.`,
  );

  return parts.join('\n\n');
}

/**
 * The app's own token arithmetic, so "is this too long" is answered with a number rather
 * than a guess. Rendered as the compact list the consultant can quote from.
 */
function tokenReportBlock(card: ParsedCard): string {
  const report = analyzeTokenCost(card, estimateTokens);
  const lines = report.fields
    .filter((field) => field.tokens > 0)
    .map((field) => `${field.field}: ${field.tokens} tokens (${field.perTurn ? 'per turn' : 'one-time'})`);

  return `# What this card costs

The card the user is asking about, priced by this app's own estimator:

${lines.join('\n')}

${report.permanentPerTurn} permanent tokens per turn, plus ${report.oneTime} one-time. Use these
numbers when the user asks about length. Report the cost and what could move to a cheaper tier;
never state that a card is too long or too short as a fact.`;
}

/**
 * The deterministic findings, handed over as already-known. This is the one critique that is
 * free and always correct, so the consultant never misses it and never contradicts it.
 */
function smuggledBlock(findings: string[]): string {
  const list = findings.map((excerpt) => `- ${JSON.stringify(excerpt)}`).join('\n');
  return `# Already-known findings

These directives are in the card's "description" or "personality" and belong in "system_prompt"
or "post_history_instructions". They were found by a deterministic scan, so they are certain —
do not contradict them, and do not spend a turn asking about them:

${list}`;
}

/**
 * The card as the model reads it, plus the two notes that only make sense in consult mode.
 */
function cardMessage(card: ParsedCard): string {
  return `The card under discussion:\n\n${JSON.stringify(cardForPrompt(card), null, 2)}`;
}

/**
 * How one turn of the transcript is written to the wire.
 *
 * The user's turns go as they are; the assistant's are wrapped back into the JSON envelope
 * it is asked to produce. That is not cosmetic — measured against the live provider with
 * everything else held identical, a transcript whose assistant turns are bare prose gets
 * prose back on the NEXT turn, three runs out of three, while the same transcript with the
 * envelope returns parseable JSON three runs out of three. The model continues the format it
 * can see, and once one turn drifts the conversation never recovers.
 *
 * The envelope carries only `say`, which is what the next turn actually needs to read: the
 * question it asked is in the user's own answer to it, and re-sending the options would
 * invite the model to re-ask the same question.
 */
function wireContent(message: ConsultMessage): string {
  if (message.role === 'user') return message.content;
  return JSON.stringify({ say: message.content, question: null, card: null });
}

export async function consult(
  env: Env,
  opts: {
    mode: ConsultMode;
    messages: ConsultMessage[];
    /** The card being discussed. Consult mode only. */
    card?: ParsedCard | null;
    onDelta?: (text: string) => void;
  },
): Promise<ConsultTurn> {
  const card = opts.card ?? null;
  const system = systemPrompt(opts.mode, card);

  const messages: WireMessage[] = [];
  // The card goes in as a system message rather than in the first user turn: it is context
  // the model reads, not something the user said, and a transcript that claimed otherwise
  // would make the user's own question look like it was about a card they pasted.
  if (card) messages.push({ role: 'system', content: cardMessage(card) });
  for (const message of opts.messages) {
    messages.push({ role: message.role, content: wireContent(message) });
  }
  // A conversation must end with something the model answers. `streamCheap` sends whatever it
  // is given, so the opening move of an empty interview is made explicit here.
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: opts.mode === 'draft' ? 'Start.' : 'What do you think?' });
  }

  let streamed = false;
  const onDelta = opts.onDelta
    ? (text: string) => {
        // Only real output counts. The buffered path reports the whole reply as one delta and
        // an empty reply as an empty one, and retrying after either would be invisible — which
        // is the point of the flag.
        if (text.length === 0) return;
        streamed = true;
        opts.onDelta?.(text);
      }
    : undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await streamCheap(
      env,
      { system, messages, maxTokens: 4096, json: true },
      onDelta,
    );

    try {
      return parseConsultTurn(text);
    } catch (error) {
      // Retrying after the user has already read half a reply would visibly restart it, so
      // the retry only happens when nothing was streamed.
      if (streamed || attempt === 1) {
        throw new Error(`consult: the model did not return a usable turn (${
          error instanceof Error ? error.message : String(error)
        }).`);
      }
    }
  }

  throw new Error('consult: the model did not return a usable turn.');
}

/**
 * The reply, validated. A turn with neither a question nor a card is legal and means "just
 * talking" — what consult mode returns for a question that needs no change.
 *
 * ## Why a prose reply is a turn, not a failure
 *
 * Measured: `deepseek-v4-flash` answers the JSON envelope on most turns and, on some,
 * ignores it and writes the reply as prose — the opening line was *"I'd love to..."* in the
 * report that produced this. Treating that as an error is wrong twice over. The words are
 * exactly what the user asked for and were already streamed to their screen, so throwing
 * them away turns a usable answer into a red box; and the retry cannot help, because the
 * retry is skipped once anything has streamed, which it always has by then.
 *
 * So a reply that will not parse as the envelope is read as the `say` field it plainly is,
 * with no question and no card. The user gets the consultant's actual words and can keep
 * talking. The only remaining error is an empty reply, which is a real failure.
 */
export function parseConsultTurn(text: string): ConsultTurn {
  const trimmed = text.trim();
  const parsed = tryParse(trimmed);

  if (!parsed.ok) {
    // Not JSON at all. Two shapes land here and both have a readable `say`:
    //  - the model answered in prose, ignoring the envelope;
    //  - the envelope was cut off by the token cap mid-reply, in which case `partialField`
    //    recovers the `say` text written so far. `say` is required to be the first key, so
    //    a truncated envelope always has one.
    // Falling back to the raw text would show the user `{"say": "I'd love…`, which is worse
    // than either.
    const say = (partialField(trimmed, 'say') ?? unwrapFencedProse(trimmed)).trim();
    if (say.length === 0) throw new Error('the model returned no reply.');
    return { say, question: null, card: null };
  }

  // A bare JSON string is the model having answered `say` and nothing else.
  if (typeof parsed.value === 'string') {
    const say = parsed.value.trim();
    if (say.length === 0) throw new Error('the model returned no reply.');
    return { say, question: null, card: null };
  }

  const record = asRecord(parsed.value);
  if (!record) {
    // Valid JSON, but not a shape a turn can be read out of — `null`, a number, an array.
    throw new Error('the model returned no reply.');
  }

  const say = asString(record.say);
  if (say.trim().length === 0) throw new Error('the model returned no reply.');

  const question = parseQuestion(record.question);
  const card = record.card === null || record.card === undefined ? null : toParsedCard(record.card);

  return { say, question, card };
}

/** The parsed reply, or a flag saying the text is not JSON at all. */
function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: parseJsonReply<unknown>(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * A prose reply, with a code fence removed if the model wrapped it in one.
 *
 * Models add fences reflexively, and a fenced block that is not JSON is still prose the
 * reader should see rather than three backticks and the word `json`.
 */
function unwrapFencedProse(text: string): string {
  const fenced = /^```(?:[a-z]*)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

function parseQuestion(value: unknown): ConsultTurn['question'] {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  if (!record) return null;

  const text = asString(record.text).trim();
  const options = asStringArray(record.options)
    .map((option) => option.trim())
    .filter((option) => option.length > 0);

  // A question with nothing to click is not a question; the free-text box alone is not what
  // the caller renders, so this collapses rather than returning an unanswerable prompt.
  if (options.length === 0) return null;

  const raw = record.recommended;
  const recommended =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(Math.max(Math.floor(raw), 0), options.length - 1)
      : 0;

  return { text, options, recommended };
}

/**
 * Validates and maps a model reply onto the stored card shape.
 *
 * A missing name is an error rather than a default, for the same reason it is at
 * import time: a card with no name cannot be filed. Every other field defaults,
 * because a card missing its scenario still chats.
 */
export function toParsedCard(value: unknown): ParsedCard {
  const record = asRecord(value);
  if (!record) throw new Error('reply was not a JSON object');

  const name = asString(record.name).trim();
  if (name.length === 0) throw new Error('reply had no name');

  const alternateGreetings = asStringArray(record.alternate_greetings);
  // `nickname` distinguishes three states, and they are all meaningful: absent means the model
  // did not touch it, `""` means "call them by their name again", and text means a rename.
  // Collapsing `""` to absent would make clearing a nickname impossible.
  const hasNickname = 'nickname' in record && typeof record.nickname === 'string';

  return {
    name,
    ...(hasNickname ? { nickname: asString(record.nickname).trim() } : {}),
    description: asString(record.description),
    personality: asString(record.personality),
    scenario: asString(record.scenario),
    firstMes: asString(record.first_mes),
    mesExample: asString(record.mes_example),
    systemPrompt: asString(record.system_prompt),
    postHistoryInstructions: asString(record.post_history_instructions),
    alternateGreetings,
    greetingStates: toGreetingStates(record.greeting_states, alternateGreetings.length + 1),
    creatorNotes: asString(record.creator_notes),
    tags: asStringArray(record.tags),
    characterBook: null,
    sourceFormat: 'ccv2',
    // Drafted cards carry no image; the field is required so a constructor cannot
    // silently omit it.
    avatarHint: null,
    raw: value,
  };
}

/**
 * The opening scenes, normalised to exactly one entry per opening — or `undefined` when the
 * model did not send the field at all.
 *
 * The two lists are index-aligned everywhere they are read — chat creation looks up
 * `greetingStates[greetingIndex]` — so a short list is not merely incomplete, it silently
 * loses the scene of every later opening, and a long one is dead weight. Padding with `{}`
 * means "this opening states no scene", which is the honest reading of an omitted entry and
 * exactly what the editor writes for an opening the reader left blank.
 *
 * `undefined` is deliberately not the same as `[]`. A reply that omits the field is a model
 * that did not touch the scenes, and the caller must keep the ones the card already has —
 * collapsing it to an empty array would silently wipe every opening's time and place on the
 * next Apply, which is the worst thing this function could do.
 */
function toGreetingStates(value: unknown, count: number): GreetingState[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from({ length: count }, (_, index) => {
    const entry = asRecord(value[index]);
    if (!entry) return {};
    const state: GreetingState = {};
    for (const field of ['time', 'location', 'weather'] as const) {
      const text = asString(entry[field]).trim();
      if (text.length > 0) state[field] = text;
    }
    return state;
  });
}
