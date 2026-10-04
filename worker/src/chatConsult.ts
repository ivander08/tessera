import { getChat, getCharacter, getPersona } from './db';
import { loadCast } from './cast';
import { loadStateForViewer } from './state/update';
import { loadPathTail, type BranchRow } from './branch';
import { loadSceneSetup } from './scene';
import { recall } from './memory/recall';
import { streamCheap } from './cheap';
import { CONTENT_BLOCK, parseReply, unwrapFencedProse } from './forge/consult';
import { partialField } from './forge/partial';
import { renderStateBlock } from '../../src/lib/prompt/stateBlock';
import { renderMemoryBlock } from '../../src/lib/prompt/memoryBlock';
import { estimateTokens } from '../../src/lib/tokenEstimate';
import { asRecord, asString, asStringArray } from '../../src/lib/json';
import type { RecallHit } from '../../src/lib/memoryTypes';
import type { WireMessage } from './providers/types';

/** One turn of the conversation as the client holds it. Mirrors `ConsultMessage`. */
export interface ChatConsultMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** What the chat consultant says back: advice, and an optional question about the scene. */
export interface ChatConsultTurn {
  say: string;
  question: {
    text: string;
    /** Messages the reader could send verbatim. */
    options: string[];
    /** Index into `options` of the one this consultant would pick. */
    recommended: number;
  } | null;
}

/** How much of the visible path the consultant reads. The narrator's minimum window is 40. */
const TRANSCRIPT_ROWS = 40;
/** Ceiling for the character block, in estimated tokens. */
const CHARACTER_TOKENS = 1200;
/** Ceiling for the rendered world state. */
const STATE_TOKENS = 400;
/** Ceiling for the rendered memory block. */
const MEMORY_TOKENS = 600;
/** Ceiling for the transcript block. */
const TRANSCRIPT_TOKENS = 2000;

/**
 * The chat consultant: answers a question about the scene the reader is in.
 *
 * Distinct from `forgeConsult`, which is card-scoped and knows nothing about chats,
 * memories or world state. This one reads the same sources the narrator reads — character,
 * persona, cast, state, memory, transcript — so its advice is about the scene that actually
 * exists rather than a scene the model inferred from the last few lines.
 *
 * It deliberately does NOT call `buildPrompt`: that mutates `chats.window_start_seq`,
 * computes narrator budgets, and appends a narrator-shaped tail. Side-channel work must not
 * move the chat's own bookkeeping, so the context is assembled from the exported loaders —
 * the pattern `memory/api.ts` and `export.ts` already follow.
 */
export async function chatConsult(
  env: Env,
  opts: {
    chatId: string;
    messages: ChatConsultMessage[];
    onDelta?: (text: string) => void;
  },
): Promise<ChatConsultTurn> {
  const { system, blocks } = await chatConsultContext(env, opts.chatId);

  // Every block is its own system message, matching how `assemble` layers the narrator's
  // context: the model reads them as context rather than as something the reader said.
  const messages: WireMessage[] = blocks.map((content) => ({ role: 'system' as const, content }));
  for (const message of opts.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  // A conversation must end with something the model answers, and the opening move of an
  // empty dock has nothing else to answer.
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: 'What should I do next?' });
  }

  let streamed = false;
  const onDelta = opts.onDelta
    ? (text: string) => {
        // Only real output counts: retrying after the reader has already watched half a
        // reply arrive would visibly restart it.
        if (text.length === 0) return;
        streamed = true;
        opts.onDelta?.(text);
      }
    : undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, finishReason } = await streamCheap(
      env,
      { system, messages, maxTokens: 4096, json: true },
      onDelta,
    );

    try {
      return parseChatConsultTurn(text);
    } catch (error) {
      if (streamed || attempt === 1) {
        const detail = error instanceof Error ? error.message : String(error);
        // `length` is the provider saying the reply hit the output cap mid-sentence.
        const cause =
          finishReason === 'length'
            ? 'the reply ran out of output budget before it finished'
            : detail;
        throw new Error(`chat consult: the model did not return a usable turn (${cause}).`);
      }
    }
  }

  throw new Error('chat consult: the model did not return a usable turn.');
}

/**
 * The scene as the consultant reads it: the system prompt, and one context block per source.
 *
 * Separate from the call itself so what the consultant is TOLD can be asserted without a
 * model in the loop — the assembly is the part that can be wrong in a way no prompt
 * inspection would catch, because it reads six different tables.
 */
export async function chatConsultContext(
  env: Env,
  chatId: string,
): Promise<{ system: string; blocks: string[] }> {
  const chat = await getChat(env, chatId);
  if (!chat) throw new Error('chat not found');

  const [character, persona, cast, setup, state, rows] = await Promise.all([
    chat.character_id ? getCharacter(env, chat.character_id) : Promise.resolve(null),
    chat.persona_id ? getPersona(env, chat.persona_id) : Promise.resolve(null),
    loadCast(env, chatId),
    loadSceneSetup(env, chatId),
    // The state as of the end of the visible path — what the narrator will be told next
    // turn. The live row is overwritten every turn and after a swipe can describe a version
    // that has left the screen, which would make the advice about a scene that is not there.
    loadStateForViewer(env, chatId),
    loadPathTail(env, chatId, TRANSCRIPT_ROWS),
  ]);

  const card = parseCard(character?.card_json);
  // The character's shown name, then its plain name, then the cast's primary member: the
  // same fallback chain `cast.ts` uses, so an assistant row is labelled the way the
  // transcript labels it.
  const cardName =
    asString(card?.nickname).trim() || asString(card?.name).trim() || cast[0]?.name || 'Assistant';

  const blocks: string[] = [];
  const present: string[] = [];

  const characterText = card ? characterBlock(card) : '';
  if (characterText.length > 0) {
    blocks.push(characterText);
    present.push('the character card');
  }

  const personaText = persona ? personaBlock(persona.name, persona.description) : '';
  if (personaText.length > 0) {
    blocks.push(personaText);
    present.push("the reader's persona");
  }

  // A cast of one is "no cast": that member is the character the block above already
  // describes, and naming it twice reads as a second person in the scene. `Chat.tsx` draws
  // the same line.
  if (cast.length > 1) {
    blocks.push(`Cast in this scene: ${cast.map((member) => member.name).join(', ')}`);
    present.push('the cast');
  }

  const stateText = renderStateBlock(state, STATE_TOKENS, estimateTokens, {
    bonds: setup.craft.bonds,
    threads: setup.craft.threads,
  });
  if (stateText.length > 0) {
    blocks.push(`World state:\n${stateText}`);
    present.push('the world state');
  }

  const memoryText = await memoryBlock(env, chatId, rows);
  if (memoryText.length > 0) {
    blocks.push(memoryText);
    present.push('the memories');
  }

  const transcriptText = transcriptBlock(rows, cardName, persona?.name ?? null);
  if (transcriptText.length > 0) {
    blocks.push(transcriptText);
    present.push('the recent transcript');
  }

  return { system: chatConsultPrompt(present), blocks };
}

/**
 * The consultant's system prompt.
 *
 * `context` is one sentence naming the blocks that follow, so the model knows what it has
 * before it starts guessing. The content stance is the CARD consultant's own block rather
 * than a copy: two copies drift, and the two consultants must state it identically.
 */
export function chatConsultPrompt(context: string[]): string {
  const given =
    context.length === 0
      ? 'You have no stored context for this scene, so ask the reader for whatever you need.'
      : `You are given ${sentenceList(context)}, in that order. They are the real scene, not a summary of one — read them before you answer and never contradict them.`;

  return [
    'You are a story consultant for a roleplay chat. The reader is mid-scene and is asking you for advice about what to do next.',

    `# What you are given

${given}`,

    `# What you do

- Suggest a reply the reader could send next, written as the reader's own line.
- Propose a direction that raises tension or pays off a thread the scene has left open.
- Explain what a character likely wants, and what would move them.
- Point out a contradiction with something already established, and say which fact it contradicts.

Give one to three suggestions, each specific enough to use as written. A suggestion that
restates the question, or that asks the reader to decide, is not advice.`,

    `# Tone

Direct and concrete. No preamble, no restating the question, no general writing advice, no
lists of things the reader could consider. Say the thing you would write.`,

    CONTENT_BLOCK,

    `# Output

Return ONLY a JSON object, with "say" as the FIRST key:
{
  "say": string,
  "question": { "text": string, "options": string[], "recommended": number } | null
}

- "say" comes first, always. It is streamed to the reader as you write it, and the object is
  read from the start, so a "say" that is not first arrives as nothing at all.
- "say" is your advice, in prose. Write it for the reader, not the character.
- "question" is set only when you need one more fact before you can answer, and is otherwise
  null. Most turns answer without asking anything.
- "question.options" are the concrete suggestions — the lines the reader could send, written
  verbatim, one per entry. A turn that offers lines to send MUST put them here: advice
  described in "say" and not listed in "options" is advice the reader has to retype, and it
  arrives with no button to use it.
- "question.recommended" is the index of the option you would pick, or -1 if you would not
  pick between them.
- NEVER include a "card" key. You do not edit the character card.
No prose outside the JSON. No code fences.`,
  ].join('\n\n');
}

/**
 * The reply, validated.
 *
 * The envelope is recovered with the card consultant's own scanner (`parseReply`) rather
 * than a bare `JSON.parse`. Measured on `deepseek-v4-flash`: asked for three ways to reply,
 * it wrote a paragraph of prose and appended the envelope AFTER it — and a bare parse then
 * either failed or, worse, adopted the whole text as `say`, putting raw JSON in front of the
 * reader. The scanner finds the envelope inside the prose, which is the same recovery the
 * card consultant has needed since its own version of this bug.
 *
 * A reply with no recoverable envelope is read as the `say` field it plainly is: the words
 * are what the reader asked for and they have already been streamed to the screen, so
 * discarding them turns a usable answer into a red box. The only real failure is an empty
 * reply.
 */
export function parseChatConsultTurn(text: string): ChatConsultTurn {
  const trimmed = text.trim();
  const parsed = parseReply(trimmed);

  if (!parsed.ok) {
    // No envelope. `partialField` recovers the `say` text written so far when the document
    // was cut off mid-reply; `unwrapFencedProse` covers the model having answered in prose
    // outright. Both are the card consultant's fallbacks, for the same reasons.
    const say = (partialField(trimmed, 'say') ?? unwrapFencedProse(trimmed)).trim();
    if (say.length === 0) throw new Error('chat consult: the model returned nothing usable.');
    return { say, question: null };
  }

  // A bare JSON string is the model having answered `say` and nothing else.
  if (typeof parsed.value === 'string') {
    const say = parsed.value.trim();
    if (say.length === 0) throw new Error('chat consult: the model returned nothing usable.');
    return { say, question: null };
  }

  const record = asRecord(parsed.value);
  if (!record) throw new Error('chat consult: the model returned nothing usable.');

  const say = asString(record.say).trim();
  if (say.length === 0) throw new Error('chat consult: the model returned nothing usable.');

  return { say, question: parseQuestion(record.question) };
}

/**
 * A question is only a question if it has something to click. An absent or out-of-range
 * recommendation does NOT discard it: the options are the valuable part and the
 * recommendation is a nicety, so a reply that offers three usable lines and declines to pick
 * one (the contract's own `-1`) keeps all three and simply shows no "best" badge.
 *
 * The card consultant's parser clamps an unusable recommendation to the first option, which
 * is right there — a card interview always wants a default answer. Here it would put a "best"
 * badge on a line the consultant explicitly did not choose, so `-1` is preserved instead.
 */
function parseQuestion(value: unknown): ChatConsultTurn['question'] {
  const record = asRecord(value);
  if (!record) return null;

  const options = asStringArray(record.options)
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (options.length === 0) return null;

  const raw = record.recommended;
  const recommended =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < options.length ? raw : -1;

  return { text: asString(record.text).trim(), options, recommended };
}

/** The stored card, or null when the row is missing or its JSON is unreadable. */
function parseCard(json: string | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

/** `a`, `a and b`, `a, b and c` — a sentence, not a comma-spliced list. */
function sentenceList(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `Label: value` lines, one per non-empty field. */
function renderFields(fields: Array<{ name: string; value: string }>): string {
  return fields
    .filter((field) => field.value.length > 0)
    .map((field) => `${field.name}: ${field.value}`)
    .join('\n');
}

/**
 * The character as the consultant reads them, capped at `CHARACTER_TOKENS`.
 *
 * Shedding order: the example dialogue first — it demonstrates a voice the description and
 * personality already state — then the description is truncated, because it is the one
 * field long enough to survive a cut.
 */
function characterBlock(card: Record<string, unknown>): string {
  const fields = [
    { name: 'Name', value: asString(card.name).trim() },
    { name: 'Description', value: asString(card.description).trim() },
    { name: 'Personality', value: asString(card.personality).trim() },
    { name: 'Scenario', value: asString(card.scenario).trim() },
    { name: 'Example dialogue', value: asString(card.mesExample).trim() },
  ];

  let kept = fields;
  if (estimateTokens(renderFields(kept)) > CHARACTER_TOKENS) {
    kept = fields.filter((field) => field.name !== 'Example dialogue');
  }

  const rest = kept.filter((field) => field.name !== 'Description');
  const description = kept.find((field) => field.name === 'Description');
  if (description) {
    const room = Math.max(80, CHARACTER_TOKENS - estimateTokens(renderFields(rest)));
    description.value = fitSentences(description.value, room);
  }

  return renderFields(kept);
}

/** The reader's own character, omitted entirely when the chat has no persona. */
function personaBlock(name: string, description: string | null): string {
  const text = (description ?? '').trim();
  return text.length > 0
    ? `Persona (the reader's character):\nName: ${name}\nDescription: ${text}`
    : `Persona (the reader's character):\nName: ${name}`;
}

/**
 * What the narrator's memory would have been given for this turn.
 *
 * The query is the reader's most recent line, and the summaries are the newest three by
 * coverage — the same two sources `buildPrompt` uses, so the consultant is not told a
 * different story from the one the narrator was told.
 */
async function memoryBlock(env: Env, chatId: string, rows: BranchRow[]): Promise<string> {
  const lastUser = [...rows].reverse().find((row) => row.role === 'user');
  const query = lastUser?.content ?? '';

  try {
    const [hits, summaries] = await Promise.all([
      query.trim().length > 0 ? recall(env, chatId, query, 8) : Promise.resolve([] as RecallHit[]),
      env.DB.prepare(
        `SELECT id, content FROM summaries WHERE chat_id = ?
          ORDER BY covers_to DESC LIMIT 3`,
      )
        .bind(chatId)
        .all<{ id: string; content: string }>(),
    ]);

    return renderMemoryBlock(
      {
        summaries: summaries.results.map((row) => ({
          kind: 'summary' as const,
          refId: row.id,
          text: row.content,
          score: 0,
        })),
        facts: hits.filter((hit) => hit.kind === 'fact'),
        recalled: hits.filter((hit) => hit.kind !== 'fact'),
      },
      MEMORY_TOKENS,
      estimateTokens,
    );
  } catch (error) {
    // A missing FTS index must not cost the reader their advice, the same way it must not
    // cost them a reply in `buildPrompt`.
    console.warn(`[chat consult] recall failed for chat=${chatId}: ${String(error)}`);
    return '';
  }
}

/**
 * The visible path, oldest first, one line per row.
 *
 * The prefix rule is the narrator's (`withSpeakerName`): the reader's rows carry the persona
 * name, system rows stand alone, and everything else is labelled with who spoke. It has to
 * match, or the consultant would read the same scene differently from the model writing it.
 *
 * The cap drops from the OLDEST end: the reader is asking about the current moment, so the
 * newest lines are the ones worth the tokens.
 */
function transcriptBlock(rows: BranchRow[], cardName: string, personaName: string | null): string {
  const lines = rows.map((row) => {
    if (row.role === 'user') return `${personaName ?? 'User'}: ${row.content}`;
    if (row.role === 'system') return row.content;
    return `${row.speaker ?? cardName}: ${row.content}`;
  });
  if (lines.length === 0) return '';

  let start = 0;
  let text = lines.join('\n');
  while (start < lines.length - 1 && estimateTokens(text) > TRANSCRIPT_TOKENS) {
    start++;
    text = lines.slice(start).join('\n');
  }

  return `Transcript (oldest first):\n${text}`;
}

/**
 * Trims `text` to `maxTokens`, cutting at the last sentence boundary that fits.
 *
 * A single sentence longer than the budget would leave nothing, so it falls back to a hard
 * cut at a word boundary — an over-long description truncated mid-thought still tells the
 * consultant who the character is, and omitting it does not.
 */
function fitSentences(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  let out = '';
  for (const sentence of sentences) {
    if (estimateTokens(out + sentence) > maxTokens) break;
    out += sentence;
  }
  if (out.trim().length > 0) return out.trim();

  let end = text.length;
  while (end > 0 && estimateTokens(text.slice(0, end)) > maxTokens) {
    end -= Math.max(1, Math.floor(end / 8));
  }
  return text.slice(0, end).trim();
}
