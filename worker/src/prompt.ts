import { getCharacter, getPersona } from './db';
import type { ChatRow, ChatSettings } from './db';
import { assemble } from '../../src/lib/prompt/assemble';
import type { AssembledPrompt } from '../../src/lib/prompt/types';
import type { AssembleInput } from '../../src/lib/prompt/input';
import { computeWindowStart } from '../../src/lib/prompt/window';
import { estimateChatTokens, estimateTokens, applyCalibration } from '../../src/lib/tokenEstimate';
import { alwaysOnLore, parseLorebook } from '../../src/lib/cards/lorebook';
import type { CharacterCardJson } from '../../src/lib/cards/types';
import { renderMemoryBlock } from '../../src/lib/prompt/memoryBlock';
import { renderStateBlock } from '../../src/lib/prompt/stateBlock';
import { recall } from './memory/recall';
import { loadState } from './state/update';
import { asNumber } from '../../src/lib/json';
import type { Role } from '../../src/lib/prompt/types';
import type { Frame } from './frame';

export { type Frame };

interface HistoryRow {
  seq: number;
  role: Role;
  content: string;
  content_tokens: number | null;
}

export function send(
  controller: ReadableStreamDefaultController<Uint8Array>,
  frame: Frame,
): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
}

export interface PromptOptions {
  mode: 'send' | 'regenerate' | 'impersonate' | 'continue';
  /** Set only for `send`: the row the user's message occupies, which is excluded. */
  userSeq: number | null;
  userContent: string;
  /** Mode-specific instruction appended to the tail, after the author's note. */
  tailExtra: string;
}

/**
 * Assembles the prompt for one turn.
 *
 * The mode changes only two things: which rows count as history, and what the tail ends
 * with. Everything before `tailStart` is identical across modes, which is what keeps the
 * cached prefix valid when the user re-rolls a reply.
 */
export async function buildPrompt(
  env: Env,
  chat: ChatRow,
  settings: ChatSettings,
  options: PromptOptions,
): Promise<AssembledPrompt> {
  const character = chat.character_id ? await getCharacter(env, chat.character_id) : null;
  if (!character) throw new Error('chat has no character');
  const card = JSON.parse(character.card_json) as CharacterCardJson;
  const personaRow = chat.persona_id ? await getPersona(env, chat.persona_id) : null;

  // Only ACTIVE rows are sent. A swiped-away alternative is still in the table — that is
  // what makes swiping back free — but it is not part of the conversation the model sees.
  //
  // For `send`, the just-persisted user message is excluded from history and passed in
  // as the tail instead. Inferring it from the last row would turn any orphan user row
  // (from a turn that failed before the provider answered) into two consecutive user
  // turns, which providers reject.
  const { results } = options.userSeq === null
    ? await env.DB.prepare(
        `SELECT seq, role, content, content_tokens FROM messages
          WHERE chat_id = ? AND active = 1 ORDER BY seq`,
      )
        .bind(chat.id)
        .all<HistoryRow>()
    : await env.DB.prepare(
        `SELECT seq, role, content, content_tokens FROM messages
          WHERE chat_id = ? AND active = 1 AND seq < ? ORDER BY seq`,
      )
        .bind(chat.id, options.userSeq)
        .all<HistoryRow>();

  // The budget is expressed in real prompt tokens, but `content_tokens` is a local
  // estimate with a per-model bias. Applying the stored factor keeps the budget honest
  // for a model whose tokenizer differs from the estimator.
  const calibration = await loadCalibration(env, settings.model);

  const windowStart = computeWindowStart(
    results.map((row) => ({
      seq: row.seq,
      tokens: applyCalibration(row.content_tokens ?? estimateTokens(row.content), calibration),
    })),
    chat.window_start_seq,
    settings.contextBudget,
  );
  if (windowStart !== chat.window_start_seq) {
    // Persisted once per re-anchor, not per turn — the sawtooth is the point.
    await env.DB.prepare('UPDATE chats SET window_start_seq = ? WHERE id = ?')
      .bind(windowStart, chat.id)
      .run();
  }

  const history = results
    .filter((row) => row.seq >= windowStart)
    .map((row) => ({ role: row.role, content: row.content }));

  // Recall is driven by whatever the user just said. In the non-send modes there is no
  // new user text, so the last thing in the conversation stands in for it.
  const recallQuery = options.userContent || history[history.length - 1]?.content || '';

  // Both blocks go in the TAIL. Recalled content and world state change as the scene
  // moves; putting either in the head would rewrite the cached prefix every turn.
  const [memoryBlock, stateBlock] = await Promise.all([
    buildMemoryBlock(env, chat.id, recallQuery, calibration),
    buildStateBlock(env, chat.id, calibration),
  ]);

  const input: AssembleInput = {
    systemPrompt: card.systemPrompt || settings.systemPrompt,
    character: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      mesExample: card.mesExample,
    },
    persona: personaRow
      ? { name: personaRow.name, description: personaRow.description ?? '' }
      : null,
    lorebook: alwaysOnLore(parseLorebook(card.characterBook)),
    history,
    tail: {
      memoryBlock,
      stateBlock,
      authorsNote: settings.authorsNote,
      postHistoryInstructions: card.postHistoryInstructions,
      userMessage: options.userContent,
    },
  };

  return assemble(input, estimateChatTokens);
}

/** Tokens reserved for the memory block, taken out of the history budget. */
const MEMORY_BLOCK_TOKENS = 800;

/**
 * Renders the world-state document for the prompt TAIL.
 *
 * Returns '' when there is no state yet, so `assemble` omits the segment entirely.
 */
async function buildStateBlock(env: Env, chatId: string, calibration: number): Promise<string> {
  try {
    const state = await loadState(env, chatId);
    return renderStateBlock(state, Math.round(800 * calibration));
  } catch (error) {
    console.warn(`[state] render failed for chat=${chatId}: ${messageOf(error)}`);
    return '';
  }
}

/**
 * Assembles the memory block for this turn. Returns '' when there is nothing to say, so
 * `assemble` omits the segment rather than emitting an empty system message.
 *
 * Failures degrade to "no memory this turn" rather than failing the turn: a missing FTS
 * index or an unconfigured summarizer must not cost the user their reply.
 */
async function buildMemoryBlock(
  env: Env,
  chatId: string,
  query: string,
  calibration: number,
): Promise<string> {
  try {
    const [hits, summaries] = await Promise.all([
      recall(env, chatId, query, 8),
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
      Math.round(MEMORY_BLOCK_TOKENS * calibration),
      estimateTokens,
    );
  } catch (error) {
    console.warn(`[memory] recall failed for chat=${chatId}: ${messageOf(error)}`);
    return '';
  }
}

async function loadCalibration(env: Env, model: string | null): Promise<number> {
  if (!model) return 1;
  const row = await env.DB.prepare('SELECT factor FROM token_calibration WHERE model = ?')
    .bind(model)
    .first<{ factor: number }>();
  return asNumber(row?.factor, 1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
