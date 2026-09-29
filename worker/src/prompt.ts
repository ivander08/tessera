import { getCharacter, getPersona } from './db';
import type { ChatRow, ChatSettings } from './db';
import { assemble } from '../../src/lib/prompt/assemble';
import type { AssembledPrompt } from '../../src/lib/prompt/types';
import type { AssembleInput } from '../../src/lib/prompt/input';
import { computeWindowStart } from '../../src/lib/prompt/window';
import { estimateChatTokens, estimateTokens, applyCalibration } from '../../src/lib/tokenEstimate';
import { alwaysOnLore, matchLore, parseLorebook } from '../../src/lib/cards/lorebook';
import type { CharacterCardJson } from '../../src/lib/cards/types';
import { renderMemoryBlock } from '../../src/lib/prompt/memoryBlock';
import { dynamicMacrosIn, substituteHead, substituteTail } from '../../src/lib/prompt/macros';
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
  // Ordered by the group's FIRST seq, not the row's own: an alternative appended to an
  // early position carries a late seq, so ordering by `seq` would feed the model an
  // edited opening greeting at the end of the history. The group minimum is where the
  // position sits in the conversation and never changes.
  //
  // For `send`, the just-persisted user message is excluded from history and passed in
  // as the tail instead. Inferring it from the last row would turn any orphan user row
  // (from a turn that failed before the provider answered) into two consecutive user
  // turns, which providers reject.
  const positionExpr = `COALESCE(
    (SELECT MIN(m2.seq) FROM messages m2
      WHERE m2.chat_id = messages.chat_id
        AND COALESCE(m2.swipe_group, m2.id) = COALESCE(messages.swipe_group, messages.id)),
    messages.seq
  )`;

  // The cut is by POSITION, not by the row's own seq. An edited message carries a late
  // seq, so filtering `seq < userSeq` would drop it from history entirely — the model
  // would lose a message the reader can see.
  const { results } =
    options.userSeq === null
      ? await env.DB.prepare(
          `SELECT seq, role, content, content_tokens FROM messages
            WHERE chat_id = ? AND active = 1 ORDER BY ${positionExpr}`,
        )
          .bind(chat.id)
          .all<HistoryRow>()
      : await env.DB.prepare(
          `SELECT seq, role, content, content_tokens FROM messages
            WHERE chat_id = ? AND active = 1
              AND ${positionExpr} < (
                SELECT ${positionExpr} FROM messages WHERE chat_id = ? AND seq = ?
              )
            ORDER BY ${positionExpr}`,
        )
          .bind(chat.id, chat.id, options.userSeq)
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

  // Keyword-triggered lorebook entries. Matched against the last `scanDepth` messages
  // and rendered into the TAIL — an entry firing on turn 12 must not rewrite the prefix
  // turns 1-11 already cached. Before this existed, the only way to use a card's world
  // knowledge was to mark every entry constant, which pays for all of it every turn.
  const loreEntries = parseLorebook(card.characterBook);
  const scanned = [...history.map((row) => row.content), options.userContent].filter(Boolean);
  const matched = matchLore(loreEntries, scanned, {
    scanDepth: settings.loreScanDepth,
    tokenBudget: Math.round(settings.loreTokenBudget * calibration),
    recursive: settings.loreRecursive,
    count: estimateTokens,
  });
  const loreBlock = matched.length > 0
    ? matched.map((hit) => hit.content).join('\n\n')
    : '';

  // `{{char}}` and `{{user}}` resolve to values fixed for the chat's life, so applying
  // them to the head leaves the cached prefix byte-identical between turns. The dynamic
  // tier is deliberately NOT applied here — a card with `{{time}}` in its description
  // would otherwise rewrite the prefix every turn.
  //
  // `{{user}}` is only substituted when a persona actually exists. Falling back to the
  // pronoun "You" is worse than leaving the placeholder: it produces "She calls You by
  // name", which reads as a proper noun and makes the model invent a name for the user.
  // A visible `{{user}}` is a prompt to go set a persona; a wrong name is a mystery.
  const macroContext = personaRow
    ? { char: card.name, user: personaRow.name, persona: personaRow.name }
    : { char: card.name, user: null, persona: null };

  // Warn rather than silently accept: this is the one way a card can kill the cache
  // without anyone editing the app.
  const headSources = [
    card.systemPrompt || settings.systemPrompt,
    card.description,
    card.personality,
    card.scenario,
    card.mesExample,
  ];
  const offending = [...new Set(headSources.flatMap(dynamicMacrosIn))];
  if (offending.length > 0) {
    console.warn(
      `[prefix-guard] chat=${chat.id} card has dynamic macros in the cached head ` +
        `(${offending.map((m) => `{{${m}}}`).join(', ')}); they are left unexpanded so the ` +
        `prefix stays stable. Move them to the tail to have them resolve.`,
    );
  }

  const input: AssembleInput = {
    systemPrompt: substituteHead(card.systemPrompt || settings.systemPrompt, macroContext),
    character: {
      name: card.name,
      description: substituteHead(card.description, macroContext),
      personality: substituteHead(card.personality, macroContext),
      scenario: substituteHead(card.scenario, macroContext),
      mesExample: substituteHead(card.mesExample, macroContext),
    },
    persona: personaRow
      ? { name: personaRow.name, description: substituteHead(personaRow.description ?? '', macroContext) }
      : null,
    lorebook: alwaysOnLore(parseLorebook(card.characterBook)).map((entry) => ({
      id: entry.id,
      content: substituteHead(entry.content, macroContext),
    })),
    history: history.map((row) => ({
      role: row.role,
      content: substituteHead(row.content, macroContext),
    })),
    tail: {
      // The tail gets both tiers: it is after `tailStart`, so it cannot disturb the
      // cached prefix however much it changes.
      memoryBlock: substituteTail(memoryBlock, macroContext),
      stateBlock: substituteTail(stateBlock, macroContext),
      loreBlock: substituteTail(loreBlock, macroContext),
      authorsNote: substituteTail(settings.authorsNote, macroContext),
      postHistoryInstructions: substituteTail(card.postHistoryInstructions, macroContext),
      userMessage: substituteTail(options.userContent, macroContext),
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
