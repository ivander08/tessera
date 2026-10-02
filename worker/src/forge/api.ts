import { badRequest, readJson } from '../http';
import { asRecord, asString, asStringArray } from '../../../src/lib/json';
import { send } from '../prompt';
import { consult, type ConsultMessage, type ConsultMode, type ConsultTurn } from './consult';
import { partialField } from './partial';
import type { GreetingState, ParsedCard } from '../../../src/lib/cards/types';

/**
 * The consult stream's own protocol, separate from the chat stream's `Frame` union in
 * `worker/src/frame.ts` — the two share only the `data: <json>\n\n` envelope. Exactly one
 * terminal frame ends a stream: `turn` on success, `error` on failure.
 *
 * `phase` is progress, not content: it names which part of the reply is being written, and
 * exists because `say` arrives long before the card does. The pane renders it as the wait
 * label, so a card that takes another twenty seconds to write does not read as a hang.
 */
export type ConsultPhase = 'say' | 'question' | 'card';

export type ConsultFrame =
  | { type: 'delta'; text: string }
  | { type: 'phase'; phase: ConsultPhase }
  | { type: 'turn'; turn: ConsultTurn }
  | { type: 'error'; message: string; code: string };

/**
 * Which part of the reply the stream has reached.
 *
 * `say` is required to be the first key, so the appearance of a later key is what says the
 * prose is finished. Read from the raw buffer rather than by parsing it: the document is
 * half-written by definition, and a key is recognizable long before the object around it
 * is. The match is safe on a partial document because a quote inside a string value is
 * escaped (`\"card\"`), so only a real key can match — a card the model *describes* in its
 * `say` text cannot be mistaken for the card it is about to write.
 */
function phaseOf(buffer: string): ConsultPhase {
  if (/"card"\s*:\s*\{/.test(buffer)) return 'card';
  if (/"question"\s*:\s*\{/.test(buffer)) return 'question';
  return 'say';
}

/** The four card formats `characters.source_format` can hold. */
const FORMATS: Record<string, ParsedCard['sourceFormat']> = {
  ccv2: 'ccv2',
  ccv3: 'ccv3',
  charx: 'charx',
  byaf: 'byaf',
};

/**
 * Coerces a card that crossed the wire into the shape the forge functions take.
 *
 * A card arrives either from `characters.card_json` (camelCase, no `raw`) or from the
 * browser's editor (a `ParsedCard`, with `raw`). Both are the same card; the difference
 * is provenance. Fields are defaulted rather than asserted because the token counter
 * hands every value to a counter, and `undefined.length` is a 500 rather than a message
 * about the card.
 */
function asCard(value: unknown): ParsedCard | null {
  const record = asRecord(value);
  if (!record) return null;

  const name = asString(record.name).trim();
  if (name.length === 0) return null;

  return {
    name,
    // The client sends these and the consultant is asked to change them, so dropping them
    // here silently removed two fields from the card the model was shown: it was told to edit
    // a `greeting_states` that had never arrived, and it reported the array as empty.
    nickname: asString(record.nickname) || undefined,
    description: asString(record.description),
    personality: asString(record.personality),
    scenario: asString(record.scenario),
    firstMes: asString(record.firstMes),
    mesExample: asString(record.mesExample),
    systemPrompt: asString(record.systemPrompt),
    postHistoryInstructions: asString(record.postHistoryInstructions),
    alternateGreetings: asStringArray(record.alternateGreetings),
    greetingStates: asGreetingStates(record.greetingStates),
    creatorNotes: asString(record.creatorNotes),
    tags: asStringArray(record.tags),
    characterBook: record.characterBook ?? null,
    sourceFormat: FORMATS[asString(record.sourceFormat)] ?? 'ccv2',
    avatarHint: asString(record.avatarHint) || null,
    raw: record.raw ?? null,
  };
}

/**
 * The opening scenes as the client sent them, or undefined when it sent none.
 *
 * Undefined rather than `[]` matters: an empty array is a card whose openings state no scene,
 * while an absent field is a client that did not send one. Collapsing the two would make the
 * consultant think a card with scenes has none — which is exactly the bug this fixes.
 */
function asGreetingStates(value: unknown): GreetingState[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) return {};
    const state: GreetingState = {};
    for (const field of ['time', 'location', 'weather'] as const) {
      const text = asString(record[field]);
      if (text.length > 0) state[field] = text;
    }
    return state;
  });
}

/**
 * Reads the conversation the client sent, or names the first thing wrong with it.
 *
 * Every entry is validated rather than coerced: a message whose `content` is not a string
 * becomes the literal text "undefined" in the prompt if it is defaulted, and the model then
 * answers a question nobody asked.
 */
function asMessages(value: unknown): ConsultMessage[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'messages required';

  const messages: ConsultMessage[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const role = asString(record?.role);
    const content = record?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return 'each message needs a role and content';
    }
    messages.push({ role, content });
  }

  return messages;
}

/**
 * `POST /api/forge/consult` — `{ mode, messages, card? }` → an SSE stream.
 *
 * Streaming because a draft turn is measured at 15–28 seconds and a dead wait that long reads
 * as a hang. Frames are `data: <json>\n\n`:
 *   { type: 'delta', text }              the `say` field, as it is written
 *   { type: 'turn', turn }               the parsed turn; exactly one, terminal on success
 *   { type: 'error', message, code }     terminal on failure
 * Exactly one terminal frame ends a stream, matching `worker/src/frame.ts`.
 */
export async function forgeConsult(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ mode?: unknown; messages?: unknown; card?: unknown }>(req);

  const mode = asString(body?.mode);
  if (mode !== 'draft' && mode !== 'consult') {
    return badRequest('mode must be "draft" or "consult"');
  }

  const messages = asMessages(body?.messages);
  if (typeof messages === 'string') return badRequest(messages);

  const card = asCard(body?.card);
  if (mode === 'consult' && !card) return badRequest('card with a name required');

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The `say` field as decoded so far, tracked against what has already been sent. The
      // scanner returns a prefix, so re-emitting an unchanged prefix would repeat text.
      let buffer = '';
      let emitted = '';
      // Which part of the reply is being written. Sent only when it changes: a frame per
      // delta would be the same fact repeated a hundred times.
      let phase: ConsultPhase = 'say';

      try {
        const turn = await consult(env, {
          mode: mode as ConsultMode,
          messages,
          card,
          onDelta: (fragment) => {
            buffer += fragment;
            const prefix = partialField(buffer, 'say');
            if (prefix !== null && prefix.length > emitted.length) {
              emitted = prefix;
              send<ConsultFrame>(controller, { type: 'delta', text: prefix });
            }

            const next = phaseOf(buffer);
            if (next !== phase) {
              phase = next;
              send<ConsultFrame>(controller, { type: 'phase', phase });
            }
          },
        });

        send<ConsultFrame>(controller, { type: 'turn', turn });
      } catch (error) {
        try {
          send<ConsultFrame>(controller, {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
            code: 'forge_consult_failed',
          });
        } catch {
          // controller already closed by the client
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
