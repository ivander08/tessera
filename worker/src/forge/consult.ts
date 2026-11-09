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
  /**
   * Set when a CONSULT turn proposes a revision.
   *
   * The revision is already applied: this is the whole card, so the client's diff and Apply
   * stay unchanged. What is new is that the model wrote it as edits, which is why an add-one-
   * line request costs twenty output tokens instead of re-typing nine thousand characters.
   */
  card: ParsedCard | null;
  /**
   * The edits the reply carried, before they were applied. Kept so the client can say WHAT
   * happened ("description · appended") rather than only showing the resulting diff, and so a
   * reply whose edits were all dropped is distinguishable from a reply that proposed none.
   */
  changes?: CardEdit[];
  /** Edits that could not be applied, so the caller can report a partial result honestly. */
  dropped?: number;
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
"location" and "weather" as short strings ("Friday, 27 February 2026, 05:35" — 24-hour clock,
no AM/PM — "a rain-soaked tavern on the edge of the map", "heavy rain"). They are stored as
machine-readable fields rather than folded into the greeting's prose, so the narrator starts the
scene already knowing where and when it is instead of inferring it from the opening paragraph.
State them whenever the opening implies them; omit a field the opening does not establish rather
than inventing one. An opening with no stated scene gets an empty object.

A "character_book" may be attached to the card. Keyed entries there cost nothing until their
keywords fire, so backstory, setting detail and world knowledge are cheaper in the book than in
"description" — say so when it is true of what the user is asking. You draft and propose card
fields only; the book is passed through untouched and never appears in your reply.`;

/**
 * The app's content stance, stated for the consultant.
 *
 * The consultant has to know what this app is for, or it hedges: it asks a euphemistic
 * question, softens an explicit request into a summary, or offers a tamer version "if that is
 * more comfortable". Cards here are explicit when the character calls for it, and the reader's
 * own prompt already says so — `<craft_content>` in `src/lib/prompt/craftBlock.ts` is the
 * narrator's copy of this stance, and this block is the consultant's.
 */
export const CONTENT_BLOCK = `# What this app writes

This is an unrestricted adult-fiction engine, and a card is written for it — not for a general
assistant. Explicit sexual content, profanity, violence and taboo material are normal card
material here, written with the same concrete specificity as anything else. The reader's own
prompt already carries a content policy permitting all of it, so nothing you put in a card is
content the app cannot send.

That changes what you write and how you ask:

- When the user asks for explicit content, write it explicitly: bodies, acts, sensation, and
  what is said. Do not soften it, summarise it, imply it and move on, or fade to black.
- Ask about it directly, in the same register the user is writing in. If they are explicit, be
  explicit back: ask what the character is into in bed, what she wants done to her, what she
  does to her partner — not whether she is "affectionate". A vague question writes a vague card.
- Never hedge, never add a content warning, never ask whether the user is sure, and never
  propose a tamer version of what was asked for.
- The permanent fields are re-sent on every turn of every scene, including the ones where
  nothing intimate is happening, so explicit material in "description" or "personality" is
  explicit in every scene. Say that as a cost, with the token numbers, never as a warning.`;

/**
 * The consultant's system prompt: role, method, what to find out, the craft knowledge, this
 * app's format, and the output contract — in that order, so each section is a concern rather
 * than one wall of text.
 */
export function systemPrompt(mode: ConsultMode, card: ParsedCard | null): string {
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
5. The register the user wants to read: tone, explicitness, length. When the card is for adult
   play — and most are — this is not a checkbox to get out of the way: ask what the character
   is like in bed. What she wants done to her, what she does to her partner, what she says, how
   she sounds, what she will not do. Get concrete answers and put them in the card.

Probe. One question is not an interview. When an answer is thin, ask the next question that
opens it up rather than moving on: "she's shy" is not an answer until you know how the shyness
behaves — what she does instead of saying the thing, what it takes to get past it. Ask for the
specific behaviour the card will actually generate, and keep asking while the answers are
still generic. The ceiling of ${MAX_QUESTIONS} questions is there to stop you over-asking; it
is not a target to reach, but if the card is still vague at question three, keep going.`,

    CARD_CRAFT,
    FORMAT_BLOCK,
    CONTENT_BLOCK,
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
"greeting_states" — the time, location and weather an opening begins in.

You do it by listing EDITS, not by re-typing the card. An edit names one field and one
operation, and the app applies it to the card the user is looking at. That is why you never
need to repeat text you are not changing: an untouched field stays exactly as it was.

Openings are numbered from 0: index 0 is "first_mes", index 1 is the first alternate, and so
on — the same "Opening 1"/"Opening 2" the user sees, shifted by one. Leave every other index
alone; an index you do not mention is not touched, and there is no way to delete an opening by
omitting it.

When the user asks for a scene change, edit "greeting_states" rather than folding the time into
the greeting's prose: the prose is what the model reads, and the scene is what the narrator
reads.`,

    mode === 'draft'
      ? `# Output

Return ONLY a JSON object, with "say" as the FIRST key:
{
  "say": string,
  "question": { "text": string, "options": string[], "recommended": number } | null,
  "card": ${CARD_KEYS} | null
}

- "say" comes first, always. It is streamed to the user as you write it.
- Set "question" while you still need an answer. Set it to null once you do not.
- Set "card" only when you are proposing the finished draft. When you set "card", "question"
  is null.
- Never set both "question" and "card".
- One of them is ALWAYS set. A draft turn that sets neither is not a valid reply: the user
  has nothing to answer and nothing to accept. If the interview has run its course, set "card".
- **If your "say" says you are making a card — "here it is", "drafted" — you MUST set
  "card".** A turn whose prose announces a draft and ships nothing makes the user ask again.
No prose outside the JSON. No code fences.`

      : `# Output

Return ONLY a JSON object, with "say" as the FIRST key:
{
  "say": string,
  "question": { "text": string, "options": string[], "recommended": number } | null,
  "changes": [
    { "field": string, "op": "replace" | "append" | "add" | "remove", "index"?: number, "value"?: any }
  ]
}

"field" is a wire name from the card above: "name", "nickname", "description", "personality",
"scenario", "first_mes", "alternate_greetings", "greeting_states", "mes_example",
"system_prompt", "post_history_instructions", "creator_notes", "tags".

The operations:

- "replace" — PROSE AND SCALARS ("description", "personality", "scenario", "first_mes",
  "mes_example", "system_prompt", "post_history_instructions", "creator_notes", "name",
  "nickname"). "value" is the new text for the WHOLE field, so include everything you want to
  keep. A field you are not changing gets no edit at all.
- "replace" with "index" — ONE ENTRY of "alternate_greetings" (a string) or of
  "greeting_states" (an object with "time"/"location"/"weather"). Every other entry is left
  alone.
- "append" — PROSE ONLY. "value" is added to the end of the field, on a new line. This is the
  cheap way to add a line, a rule or a paragraph without restating the field.
- "add" / "remove" — "tags" only. "value" is one tag, exactly as it should appear.

Examples:
  {"field":"description","op":"append","value":"- Keeps a crate of vinyl under the bed."}
  {"field":"post_history_instructions","op":"replace","value":"..."}
  {"field":"alternate_greetings","op":"replace","index":2,"value":"..."}
  {"field":"greeting_states","op":"replace","index":2,"value":{"time":"Friday, 22:40"}}
  {"field":"tags","op":"add","value":"slow-burn"}

Rules:
- Set "question" while you still need an answer; set "changes" when you are making the change.
  Never both.
- Making NO change is a legal, common answer: return "question": null and "changes": [].
  A critique that finds nothing to change is exactly this.
- **If your "say" says you are making a change — "adding", "I've added", "here it is",
  "updated", "appended" — you MUST return the edits.** A turn whose prose announces a revision
  and whose "changes" is empty ships nothing: the user sees the announcement and no diff, and
  has to ask again. If you are not ready, do not say you changed it — ask the next question
  instead, or say plainly that you need one more thing first.
- Put the smallest change that does the job. One appended line beats a rewritten field.
- Never return "card" in this conversation. Edits are the contract here.
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
    const { text, finishReason } = await streamCheap(
      env,
      { system, messages, maxTokens: 8192, json: true },
      onDelta,
    );

    try {
      const turn = parseConsultTurn(text);

      // Edits are the consult-mode contract: apply them to the card the user is looking at,
      // and hand the client a WHOLE card so its diff and Apply are untouched. A reply that
      // still returns a whole `card` (a model ignoring the new contract) goes through the
      // field-merge instead, so both shapes work.
      if (card && turn.changes && turn.changes.length > 0) {
        const result = applyEdits(card, turn.changes);
        return { ...turn, card: result.card, dropped: result.dropped };
      }
      if (card && turn.card) {
        return { ...turn, card: mergeProposal(card, turn.card) };
      }
      return turn;
    } catch (error) {
      // Retrying after the user has already read half a reply would visibly restart it, so
      // the retry only happens when nothing was streamed.
      if (streamed || attempt === 1) {
        const detail = error instanceof Error ? error.message : String(error);
        // `length` is the provider saying the reply hit the output cap mid-sentence. Naming
        // it turns "the consultant went quiet" into something the user can act on.
        const cause =
          finishReason === 'length'
            ? 'the reply ran out of output budget before it finished'
            : detail;
        throw new Error(`consult: the model did not return a usable turn (${cause}).`);
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
  // The whole reply first, which is what a well-behaved turn is. Failing that, the first
  // complete JSON object inside it: a sentence before the object or a sign-off after it is a
  // formatting habit, not a wrong answer, and throwing away the card it contains is what made
  // the consultant announce a card and deliver nothing.
  const parsed = parseReply(trimmed);

  if (!parsed.ok) {
    // The envelope was not recoverable. Two shapes land here:
    //  - the model answered in prose, ignoring the envelope;
    //  - the envelope was cut off by the token cap mid-reply.
    // `partialField` recovers the `say` text written so far in both cases, and showing that
    // beats showing the user `{"say": "I'd love…`.
    const say = (partialField(trimmed, 'say') ?? unwrapFencedProse(trimmed)).trim();

    // But an ENVELOPE that was being written and could not be read is not "just talking". The
    // user watched "Writing the card…" appear, the model's own prose says it shipped the
    // change, and silently returning card: null is what made it insist it had — with no diff
    // and no Apply button to show for it. Name the failure instead; the client renders it and
    // the user can ask again.
    //
    // Gated on the reply being an envelope attempt (it opens with `{`): a prose answer that
    // merely *mentions* `"card": {…}` is still prose, and the existing fallback must keep
    // showing it rather than turning a usable answer into an error box.
    if (trimmed.startsWith('{') && /"card"\s*:\s*\{/.test(trimmed)) {
      throw new Error(
        'the reply was cut off or malformed while it was writing the card — ask again, ' +
          'or ask for a smaller change',
      );
    }

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
  const changes = readEdits(record.changes);

  return { say, question, card, ...(changes.length > 0 ? { changes } : {}) };
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
 * The reply as a parsed value: the whole text when it is one JSON object, otherwise the first
 * complete object embedded in it.
 *
 * A model that writes `Here it is:\n{…}` or `{…}\n\nLet me know if that works.` has produced
 * the right object wrapped in a sentence. Parsing only the whole text fails on both, and the
 * card they contain was then silently discarded — the reported bug, where the consultant
 * announced a revision and the pane showed no diff and no Apply button. The envelope is the
 * authority; the prose around it is a formatting habit.
 *
 * Every `{` is tried in order and the first one that yields a complete, parseable object wins,
 * so a stray brace in the surrounding prose does not shadow the real envelope.
 *
 * Exported because the CHAT consultant needs exactly this and nothing else: measured on
 * `deepseek-v4-flash`, it answers a question with a paragraph of prose and the envelope
 * appended after it, and the envelope is the authority in both cases. The scanner is the
 * non-trivial part; a second copy would be two implementations of one recovery rule.
 */
export function parseReply(text: string): { ok: true; value: unknown } | { ok: false } {
  const whole = tryParse(text);
  if (whole.ok) return whole;

  for (let from = 0; ; ) {
    const found = extractJsonObject(text, from);
    if (found === null) return { ok: false };
    const parsed = tryParse(found.text);
    if (parsed.ok) {
      // Only a turn envelope is accepted. Prose can contain a perfectly valid nested object —
      // a `say` that writes `"card": {"name": "Ada"}` as an example — and adopting that as the
      // reply would replace the words with a nameless object. The envelope always has `say`.
      const record = asRecord(parsed.value);
      if (record && typeof record.say === 'string') return parsed;
    }
    from = found.end;
  }
}

/**
 * The first balanced `{…}` at or after `from`, or null.
 *
 * String state and escapes are tracked so a brace inside a string value — a `say` that
 * mentions `{` — is not counted as structure. `end` is the index just past the closing brace,
 * so the caller can resume after a candidate that turned out not to be JSON.
 */
function extractJsonObject(text: string, from: number): { text: string; end: number } | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let at = from; at < text.length; at++) {
    const char = text[at];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = at;
      depth++;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return { text: text.slice(start, at + 1), end: at + 1 };
    }
  }

  return null;
}

/**
 * A prose reply, with a code fence removed if the model wrapped it in one.
 *
 * Models add fences reflexively, and a fenced block that is not JSON is still prose the
 * reader should see rather than three backticks and the word `json`.
 */
export function unwrapFencedProse(text: string): string {
  const fenced = /^```(?:[a-z]*)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * The edits a reply carried, validated as untrusted input but not applied here.
 *
 * Shape only: whether a field name is real and an index is in range is decided at apply time,
 * against the card — that is the only place the current lengths are known. Anything with the
 * wrong shape is dropped rather than failing the turn, because a malformed line must not
 * throw away the edits that were fine.
 */
function readEdits(value: unknown): CardEdit[] {
  if (!Array.isArray(value)) return [];
  const edits: CardEdit[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const field = asString(record.field).trim();
    const op = record.op;
    if (field.length === 0) continue;
    if (op !== 'replace' && op !== 'append' && op !== 'add' && op !== 'remove') continue;

    const index = typeof record.index === 'number' ? record.index : undefined;
    edits.push(
      index === undefined
        ? { field, op, value: record.value }
        : { field, op, index, value: record.value },
    );
  }
  return edits;
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

/** The stored names of the prose fields a reply can revise. */
type ProseField =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'firstMes'
  | 'mesExample'
  | 'systemPrompt'
  | 'postHistoryInstructions'
  | 'creatorNotes';

/**
 * The prose fields as the wire names them, paired with the stored names.
 *
 * `name` is not here: a reply without it is an error, so it is never "unchanged".
 */
const PROSE_FIELDS: ReadonlyArray<readonly [wire: string, field: ProseField]> = [
  ['description', 'description'],
  ['personality', 'personality'],
  ['scenario', 'scenario'],
  ['first_mes', 'firstMes'],
  ['mes_example', 'mesExample'],
  ['system_prompt', 'systemPrompt'],
  ['post_history_instructions', 'postHistoryInstructions'],
  ['creator_notes', 'creatorNotes'],
];

/**
 * One edit a reply proposes, as it came off the wire.
 *
 * `index` is only meaningful for the two list-valued fields; `value` is typing-free because
 * the wire is untrusted JSON and every operation narrows it before use.
 */
export interface CardEdit {
  field: string;
  op: 'replace' | 'append' | 'add' | 'remove';
  index?: number;
  value?: unknown;
}

/** Fields an edit may touch, and how each one is applied. */
const EDITABLE_PROSE = new Set(PROSE_FIELDS.map(([wire]) => wire));
const APPENDABLE = new Set([
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
]);

/**
 * Applies a list of edits to a card.
 *
 * This is the whole point of the protocol: a model asked to add one line used to return the
 * entire card — 9k characters for this app's own card, 35-70 seconds of streaming, and any
 * paraphrase in an untouched field read as a change the user never asked for. Edits name only
 * what changes, so the untouched text cannot drift.
 *
 * An edit that cannot be applied — an unknown field, a missing index, a wrong value type — is
 * dropped, not fatal. The rest of the list is what the user asked for, and a rejection at the
 * first bad line would ship nothing. The count of dropped edits is returned so a caller can
 * say so rather than silently under-delivering.
 */
export function applyEdits(
  current: ParsedCard,
  edits: CardEdit[],
): { card: ParsedCard; applied: number; dropped: number } {
  const next: ParsedCard = { ...current };
  let applied = 0;
  let dropped = 0;

  // A shallow copy of the two lists, so an entry replacement does not mutate the caller's
  // card through the shared array reference.
  let greetings = [...current.alternateGreetings];
  let states = [...(current.greetingStates ?? [])];
  let tags = [...current.tags];
  let listsTouched = false;

  for (const edit of edits) {
    const field = typeof edit.field === 'string' ? edit.field.trim() : '';
    const ok = (() => {
      if (edit.op === 'append') {
        if (!APPENDABLE.has(field) || typeof edit.value !== 'string') return false;
        const existing = String(next[PROSE_BY_WIRE(field)] ?? '');
        const addition = edit.value.trim();
        if (addition.length === 0) return false;
        const merged = existing.trim().length === 0 ? addition : `${existing.replace(/\s+$/, '')}\n${addition}`;
        next[PROSE_BY_WIRE(field)] = merged;
        return true;
      }

      if (edit.op === 'add' || edit.op === 'remove') {
        if (field !== 'tags' || typeof edit.value !== 'string') return false;
        const tag = edit.value.trim();
        if (tag.length === 0) return false;
        const at = tags.findIndex((entry) => entry.toLowerCase() === tag.toLowerCase());
        if (edit.op === 'add') {
          if (at >= 0) return false;
          tags = [...tags, tag];
        } else {
          if (at < 0) return false;
          tags = tags.filter((_, index) => index !== at);
        }
        listsTouched = true;
        return true;
      }

      if (edit.op !== 'replace') return false;

      if (field === 'alternate_greetings') {
        const index = edit.index;
        if (typeof index !== 'number' || !Number.isInteger(index) || typeof edit.value !== 'string') {
          return false;
        }
        if (index < 0 || index > greetings.length) return false;
        if (index === greetings.length) greetings = [...greetings, edit.value];
        else greetings = greetings.map((entry, at) => (at === index ? (edit.value as string) : entry));
        listsTouched = true;
        return true;
      }

      if (field === 'greeting_states') {
        const index = edit.index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return false;
        const state = asRecord(edit.value);
        if (!state) return false;
        const cleaned: GreetingState = {};
        for (const key of ['time', 'location', 'weather'] as const) {
          const text = asString(state[key]).trim();
          if (text.length > 0) cleaned[key] = text;
        }
        // Pad with "no scene" up to the index, exactly as `toGreetingStates` does: the two
        // lists are index-aligned everywhere they are read, so a hole would shift every later
        // scene onto the wrong opening.
        while (states.length <= index) states.push({});
        states = states.map((entry, at) => (at === index ? cleaned : entry));
        listsTouched = true;
        return true;
      }

      if (!EDITABLE_PROSE.has(field) && field !== 'name' && field !== 'nickname') return false;
      if (typeof edit.value !== 'string') return false;
      const field2 = PROSE_BY_WIRE(field);
      if (field2 === 'name' && edit.value.trim().length === 0) return false;
      next[field2] = edit.value;
      return true;
    })();

    if (ok) applied += 1;
    else dropped += 1;
  }

  if (listsTouched) {
    next.alternateGreetings = greetings;
    next.tags = tags;
    next.greetingStates = states;
  }

  return { card: next, applied, dropped };
}

/** The stored field name for a wire name. */
function PROSE_BY_WIRE(wire: string): ProseField | 'name' | 'nickname' {
  const found = PROSE_FIELDS.find(([wireName]) => wireName === wire);
  if (found) return found[1];
  return wire === 'name' ? 'name' : 'nickname';
}

/**
 * A proposed revision, applied to the card it revises.
 *
 * `toParsedCard` defaults every prose field, so by the time a card is a `ParsedCard` the
 * difference between "the model did not touch this" and "the model sent an empty string" is
 * gone — and both apply paths (`CharacterEdit`, `CharacterNew`) read the parsed card as if an
 * absent field meant unchanged. It never did: a model that proposes only a description would
 * have blanked personality, scenario, the prompt fields, tags and every opening on Apply.
 *
 * So the merge happens here, where the reply's own keys are still visible (`parsed.raw`), and
 * a revision that reaches the client is always the WHOLE card. Three states stay meaningful:
 * a key that is absent keeps the current value, `""` clears the field, and text replaces it.
 * `nickname` already worked this way; the rest now matches it.
 *
 * `greeting_states` is index-aligned with the openings, so when the model changes the openings
 * and not the scenes, the current scenes are refitted to the new count rather than left
 * pointing at the wrong greetings.
 */
export function mergeProposal(current: ParsedCard, parsed: ParsedCard): ParsedCard {
  const raw = asRecord(parsed.raw) ?? {};
  const sent = (wire: string) => wire in raw;

  const merged: ParsedCard = {
    ...current,
    // A revision is a card too: provenance and the book are never the model's to change.
    sourceFormat: current.sourceFormat,
    avatarHint: current.avatarHint,
    characterBook: current.characterBook,
    raw: parsed.raw,
    // Required by the contract, so it is always this reply's answer.
    name: parsed.name,
  };

  // `nickname` is written even when it is empty — that is how a rename is undone.
  if (sent('nickname')) merged.nickname = parsed.nickname;

  for (const [wire, field] of PROSE_FIELDS) {
    if (sent(wire)) merged[field] = parsed[field] as string;
  }

  if (sent('alternate_greetings')) merged.alternateGreetings = parsed.alternateGreetings;
  if (sent('tags')) merged.tags = parsed.tags;

  if (sent('greeting_states')) merged.greetingStates = parsed.greetingStates;
  else if (merged.greetingStates) {
    // One scene per opening: pad a short list with "no scene", drop entries past the last
    // opening. Leaving the count alone would point later scenes at the wrong greeting.
    const existing = merged.greetingStates;
    const count = merged.alternateGreetings.length + 1;
    merged.greetingStates = Array.from({ length: count }, (_, index) => existing[index] ?? {});
  }

  return merged;
}

/**
 * Validates and maps a model reply onto the stored card shape.
 *
 * A missing name is an error rather than a default, for the same reason it is at
 * import time: a card with no name cannot be filed. Every other field defaults,
 * because a card missing its scenario still chats.
 *
 * A defaulted field is NOT the same as an unchanged one. A reply used as a revision has to go
 * through `mergeProposal`, which reads `raw` to tell the two apart. (Draft mode wants the
 * defaults: a new card is not revising anything.)
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
