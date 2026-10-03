import { getCharacter, getPersona } from './db';
import type { ChatRow } from './db';
import type { EffectiveSettings } from './effective';
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
import { renderCraftBlock, renderContentPolicy, renderVocalisation } from '../../src/lib/prompt/craftBlock';
import { recall } from './memory/recall';
import { loadStateAt } from './state/update';
import { loadSceneSetup } from './scene';
import { loadPathTail, VISIBLE_PATH_SEQ_CTE, type BranchRow } from './branch';
import { loadCast, type CastRow } from './cast';
import { asNumber } from '../../src/lib/json';
import type { Frame } from './frame';
import type { Role } from '../../src/lib/prompt/types';

export { type Frame };

/**
 * One SSE event. `data: <json>\n\n`, the only shape either stream writes.
 *
 * Generic over the frame rather than fixed to `Frame`: the chat stream and the consult
 * stream are different protocols, and neither one's union belongs in the other's file. All
 * this needs is a tagged object to serialize.
 */
export function send<F extends { type: string }>(
  controller: ReadableStreamDefaultController<Uint8Array>,
  frame: F,
): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
}

export interface PromptOptions {
  mode: 'send' | 'regenerate' | 'impersonate' | 'continue';
  /** Set only for `send`: the row the user's message occupies, which is excluded. */
  userSeq: number | null;
  /**
   * The row being re-rolled, whose world state must be read from BEFORE it.
   *
   * `null` means "use the live state", which is what every forward turn wants. A `regenerate`
   * passes the target's seq: the snapshot on a row is the state that row's own turn produced,
   * so including it would hand the model the outcome of the very reply being rewritten.
   */
  stateSeq: number | null;
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
  settings: EffectiveSettings,
  options: PromptOptions,
): Promise<AssembledPrompt> {
  const character = chat.character_id ? await getCharacter(env, chat.character_id) : null;
  if (!character) throw new Error('chat has no character');
  const card = JSON.parse(character.card_json) as CharacterCardJson;
  const personaRow = chat.persona_id ? await getPersona(env, chat.persona_id) : null;

  // The craft document lives in `chat_scene_setup`, not on the chat row. One D1 row read,
  // the same read `maybeUpdateState` already performs after every turn.
  const setup = await loadSceneSetup(env, chat.id);
  // Rendered once: the same text feeds the head measurement and the assembled head.
  const craftBlock = renderCraftBlock(setup.craft);

  // The history is the VISIBLE PATH through the conversation tree, not every active row.
  //
  // Those were the same thing while a chat was a flat list. With branching they diverge:
  // regenerating an early reply leaves the old continuation in the table, inactive and
  // off the path, so a flat filter would feed the model a scene the reader can no longer
  // see — and worse, one containing two different versions of the same turn.
  //
  // `walkPath` follows the active alternative at each position, so what the model reads
  // is exactly what is on screen.
  //
  // For `send`, the just-persisted user message is excluded from history and passed in
  // as the tail instead. Inferring it from the last row would turn any orphan user row
  // (from a turn that failed before the provider answered) into two consecutive user
  // turns, which providers reject.
  //
  // BOUNDED, and that is the point. This used to be `loadPath`, which walks the whole
  // conversation and then throws away everything before `window_start_seq` — so a turn on
  // a 2,000-message chat read 2,000 rows to send perhaps 60. The cost was quadratic in
  // conversation length on the hottest path in the app, and D1 bills row reads.
  //
  // The tail is the right set to load, because the persisted window start is held FIXED
  // while the window grows and only re-anchors when the budget is blown. That invariant
  // is what bounds the distance from `window_start_seq` to the tail: it is at most one
  // budget's worth of tokens, so a count derived from the budget is a real bound rather
  // than a guess. The floor keeps short chats whole and the ceiling keeps a single huge
  // message from being dropped — `computeWindowStart` has to SEE the message that does
  // not fit in order to decide where to re-anchor.
  const cutoff = options.userSeq === null ? null : options.userSeq;

  // The budget is expressed in real prompt tokens, but `content_tokens` is a local
  // estimate with a per-model bias. Applying the stored factor keeps the budget honest
  // for a model whose tokenizer differs from the estimator.
  const calibration = await loadCalibration(env, settings.model);

  const headTokens = estimateChatTokens(
    headMessages(card, personaRow, settings, craftBlock),
  );
  const historyBudget = Math.max(
    MIN_HISTORY_BUDGET,
    settings.contextBudget - headTokens - TAIL_RESERVE_TOKENS,
  );

  const readWindow = (rows: BranchRow[]): Array<{
    seq: number;
    role: Role;
    content: string;
    content_tokens: number | null;
    speaker: string | null;
  }> => {
    const usable = cutoff === null ? rows : rows.filter((row) => row.seq < cutoff);
    return usable.map((row) => ({
      seq: row.seq,
      role: row.role,
      content: row.content,
      content_tokens: row.content_tokens,
      speaker: row.speaker,
    }));
  };

  let limit = promptWindowLimit(historyBudget, calibration);
  let loaded = await loadPathTail(env, chat.id, limit, null);
  let results = readWindow(loaded);

  const entries = (rows: typeof results) =>
    rows.map((row) => ({
      seq: row.seq,
      tokens: applyCalibration(row.content_tokens ?? estimateTokens(row.content), calibration),
    }));

  let windowStart = computeWindowStart(entries(results), chat.window_start_seq, historyBudget);

  // The window wants rows older than the oldest one loaded, which means the load was too
  // small. Doubling ONCE is enough in every case the invariant above allows, and a loop
  // here would turn a wrong budget into an unbounded read — the exact failure this is
  // fixing. `loaded.length === limit` is what distinguishes "there is more to read" from
  // "that is the whole chat".
  if (windowStart < (results[0]?.seq ?? Infinity) && loaded.length === limit) {
    limit *= 2;
    loaded = await loadPathTail(env, chat.id, limit, null);
    results = readWindow(loaded);
    windowStart = computeWindowStart(entries(results), chat.window_start_seq, historyBudget);
    if (windowStart < (results[0]?.seq ?? Infinity) && loaded.length === limit) {
      // Still short. The prompt is still correct — it is windowed to what was loaded —
      // but the window start is older than the data, which means the budget arithmetic
      // does not match the conversation. Worth saying out loud rather than hiding.
      console.warn(
        `[window] chat=${chat.id} window_start_seq=${chat.window_start_seq} is older than ` +
          `the oldest of ${loaded.length} loaded rows (seq ${results[0]?.seq}); the context ` +
          `budget and the stored calibration disagree.`,
      );
    }
  }

  if (windowStart !== chat.window_start_seq) {
    // Persisted once per re-anchor, not per turn — the sawtooth is the point.
    await env.DB.prepare('UPDATE chats SET window_start_seq = ? WHERE id = ?')
      .bind(windowStart, chat.id)
      .run();
  }

  // The cast, loaded once and used for two things: the tail block below, and the
  // `includeNames` prefixing here. Bounded by the same cut point as the memory and state
  // reads: a speaker introduced by a reply that has since been regenerated away was never
  // in this scene, and naming them puts a stranger in the room.
  const cast = await loadCast(env, chat.id, options.stateSeq);
  const multiSpeaker = cast.length > 1;

  // `includeNames` is the preset's lever for a scene with several speakers: prefix each
  // history row with who wrote it, so the model can tell who said what in a long script.
  // It was parsed, plumbed through `EffectiveSettings` and exposed in the preset editor
  // long before anything consumed it.
  const includeNames = settings.includeNames;

  const history = results
    .filter((row) => row.seq >= windowStart)
    .map((row) => ({ role: row.role, content: row.content, speaker: row.speaker }));
  // Recall is driven by whatever the user just said. In the non-send modes there is no
  // new user text, so the last thing in the conversation stands in for it.
  const recallQuery = options.userContent || history[history.length - 1]?.content || '';

  // Both blocks go in the TAIL. Recalled content and world state change as the scene
  // moves; putting either in the head would rewrite the cached prefix every turn.
  const [memoryBlock, stateBlock] = await Promise.all([
    buildMemoryBlock(env, chat.id, recallQuery, calibration, options.stateSeq),
    buildStateBlock(env, chat.id, calibration, options.stateSeq, {
      bonds: setup.craft.bonds,
      threads: setup.craft.threads,
    }),
  ]);

  // The cast block, when there is more than one speaker. It names the SHOWN name — the
  // CCv3 nickname, which is what the transcript calls the character — rather than the
  // card's title, which is often a dated label.
  //
  // Tail, not head: a cast grows during a scene, and a head block that changed would
  // rewrite the cached prefix every time someone was introduced.
  const castBlock = multiSpeaker ? renderCastBlock(cast, personaRow?.name ?? null) : '';

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
    // Order: the card's own system prompt, then the preset's, then the global default.
    // The card is the most specific statement of how this character should be played.
    systemPrompt: substituteHead(
      card.systemPrompt || settings.presetSystemPrompt || settings.systemPrompt,
      macroContext,
    ),
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
    craftBlock,
    preHistory: substituteHead(settings.presetPreHistory, macroContext),
    history: history.map((row) => ({
      role: row.role,
      content: substituteHead(
        includeNames ? withSpeakerName(row, character.name, personaRow?.name ?? null) : row.content,
        macroContext,
      ),
    })),
    tail: {
      // The tail gets both tiers: it is after `tailStart`, so it cannot disturb the
      // cached prefix however much it changes.
      memoryBlock: substituteTail(memoryBlock, macroContext),
      stateBlock: substituteTail(stateBlock, macroContext),
      castBlock: substituteTail(castBlock, macroContext),
      loreBlock: substituteTail(loreBlock, macroContext),
      contentPolicy: renderContentPolicy(setup.craft),
      vocalisation: renderVocalisation(setup.craft),
      authorsNote: substituteTail(settings.authorsNote, macroContext),
      // Precedence, per the CCv2/v3 spec: the CARD's post-history instructions replace
      // the user's global setting. That is what the field is for — it is the card's own
      // final directive, sent after the user message, and the spec says frontends MUST
      // let it override the global value.
      //
      // `{{original}}` inside it expands to the global value, which is how a card can
      // extend the user's jailbreak rather than replace it.
      postHistoryInstructions: substituteTail(
        applyOriginal(card.postHistoryInstructions, settings.presetPostHistory || settings.authorsNote),
        macroContext,
      ),
      // The mode's own instruction — "write the next message", "write their next line".
      // It sat in `PromptOptions` unwired until now, so `continue` and `impersonate`
      // were sending nothing that told the model what they were asking for.
      //
      // The preset's reply-length rule rides in the same slot and BEFORE the mode's
      // instruction, so a mode that is more specific about what to write still has the
      // last word. Both are per-turn state, so neither can disturb the cached prefix.
      instruction: substituteTail(
        [settings.responseLengthRule, options.tailExtra].filter((part) => part.length > 0).join('\n'),
        macroContext,
      ),
      userMessage: substituteTail(options.userContent, macroContext),
    },
  };

  // Assistant prefill: the reply must start with this text. It is appended as a trailing
  // assistant message rather than a tail system instruction, because that is the only
  // form providers actually honour — a system message saying "start with X" is a request,
  // a trailing assistant turn is a fact the model continues from.
  const assembled = assemble(input, estimateChatTokens);

  if (settings.assistantPrefill.length > 0) {
    const prefill = substituteTail(settings.assistantPrefill, macroContext);
    assembled.messages.push({ role: 'assistant', content: prefill });
    // `tailStart` is unchanged, so the prefill sits AFTER the cacheable prefix — it is
    // per-turn state and must never enter the head.
  }

  return assembled;
}

/**
 * Tokens reserved for everything that is not history.
 *
 * The tail is assembled AFTER the window is chosen, so its size cannot be measured when
 * the window is decided — it has to be reserved. The number covers the memory block
 * (800), the state block (800), a matched lore block (up to the preset's budget), the
 * authors note, and the reply the model is about to write.
 *
 * Deliberately generous. Reserving too much costs a slightly shorter history and a
 * slightly less warm cache; reserving too little is what produced a prompt that ran over
 * the configured context and would eventually be rejected outright by a provider with a
 * hard limit.
 */
const TAIL_RESERVE_TOKENS = 3000;

/** Even an enormous card must leave room for a conversation. */
const MIN_HISTORY_BUDGET = 2048;

/**
 * The head, as wire messages.
 *
 * A second construction of the same text `assemble` will build, because the budget has to
 * be decided before `assemble` runs. It mirrors the head order exactly — system prompt,
 * character, mesExample, persona, lorebook — so the measurement matches what is sent.
 * The lorebook here is the always-on set only; keyword-triggered entries land in the tail
 * and are covered by the reservation.
 */
function headMessages(
  card: CharacterCardJson,
  persona: { name: string; description: string | null } | null,
  settings: EffectiveSettings,
  /** Tessera's craft settings, emitted last in the head. Empty when every block is off. */
  craftBlock?: string,
): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  const push = (content: string | undefined): void => {
    if (content) out.push({ role: 'system', content });
  };

  push(card.systemPrompt || settings.presetSystemPrompt || settings.systemPrompt);

  const lines: string[] = [];
  if (card.name.length > 0) lines.push(`Name: ${card.name}`);
  if (card.description.length > 0) lines.push(`Description: ${card.description}`);
  if (card.personality.length > 0) lines.push(`Personality: ${card.personality}`);
  if (card.scenario.length > 0) lines.push(`Scenario: ${card.scenario}`);
  push(lines.join('\n'));

  push(card.mesExample);

  if (persona) {
    const personaLines: string[] = [];
    if (persona.name.length > 0) personaLines.push(`Name: ${persona.name}`);
    if (persona.description) personaLines.push(`Description: ${persona.description}`);
    push(personaLines.join('\n'));
  }

  for (const entry of alwaysOnLore(parseLorebook(card.characterBook))) push(entry.content);

  // Last, mirroring `assemble`.
  push(craftBlock);

  return out;
}

/** Tokens reserved for the memory block, taken out of the history budget. */
const MEMORY_BLOCK_TOKENS = 800;

/**
 * How many history rows a bounded walk should read for this budget.
 *
 * The budget is a token count, so it has to become a row count somehow. Rather than
 * assume an average message size — which is wrong in both directions, badly, for a scene
 * of one-word exchanges and for a scene of long paragraphs — the conversion uses the
 * floor and ceiling to bracket the answer and lets the re-anchor check in `buildPrompt`
 * correct it. A row is counted as at least 40 tokens, which is on the low side for prose
 * and therefore over-reads rather than under-reads.
 *
 * `MIN` is what keeps a short chat whole: below it, reading the tail IS reading the chat.
 * `MAX` is the ceiling that stops a chat with tiny messages from reading thousands of
 * rows to fill a budget they will never fill.
 */
const MIN_WINDOW_ROWS = 40;
const MAX_WINDOW_ROWS = 400;
const MIN_TOKENS_PER_ROW = 40;

function promptWindowLimit(contextBudget: number, calibration: number): number {
  const rows = Math.ceil((contextBudget * Math.max(calibration, 0.5)) / MIN_TOKENS_PER_ROW);
  return Math.min(MAX_WINDOW_ROWS, Math.max(MIN_WINDOW_ROWS, rows));
}

/**
 * The `Speakers in this scene:` block.
 *
 * Tells the narrator there is more than one voice and how to write them. The script form
 * is the contract `speakersIn` and `splitSpeakers` parse, so the instruction and the
 * parser are one design: a reply written any other way renders as a single speaker, which
 * is a correct degradation rather than a failure.
 *
 * Each member is listed by its SHOWN name — the CCv3 nickname, which is what the
 * transcript renders — because `loadCast` already resolved it from the card. The reader is
 * named last and marked as the reader, because the narrator must NOT write their lines: a
 * model that thinks it controls the reader writes the story for them.
 */
function renderCastBlock(cast: CastRow[], personaName: string | null): string {
  const lines = ['Speakers in this scene:'];
  for (const member of cast) {
    lines.push(
      member.is_primary === 1
        ? `- ${member.name} (the character you write)`
        : `- ${member.name} (a supporting character)`,
    );
  }
  lines.push(`- ${personaName ?? 'the reader'} (the reader)`);
  lines.push(
    "Write the reply as a script: each speaker's name on its own line, then their words " +
      'and actions. Write only the characters you control. Give each speaker a distinct ' +
      'voice and let them talk to each other, not only to the reader.',
  );
  return lines.join('\n');
}

/**
 * Prefixes a history row with who wrote it, for `includeNames`.
 *
 * The prefix has to be STABLE — the same row must render the same text on every turn or
 * the cached prefix changes and the whole cache is lost. That is why the speaker is read
 * from the row rather than inferred from the current cast: the cast grows, and inferring
 * would silently re-label old turns.
 *
 * A row with no stored speaker is the chat's own character, which is every row in a
 * single-character scene.
 */
function withSpeakerName(
  row: { role: Role; content: string; speaker: string | null },
  cardName: string,
  personaName: string | null,
): string {
  if (row.role === 'user') return `${personaName ?? 'User'}: ${row.content}`;
  if (row.role === 'system') return row.content;
  return `${row.speaker ?? cardName}: ${row.content}`;
}

/**
 * Renders the world-state document for the prompt TAIL.
 *
 * `atSeq` is the transcript point the state must describe. `null` renders nothing: a chat
 * with no recorded point has no state to state, and the empty document would render as an
 * empty block anyway. When it names a row, the state is read as of that moment
 * (`loadStateAt`) rather than as the live document, which is what stops a regenerate from
 * being told how the scene turns out.
 *
 * Returns '' when there is no state at that point, so `assemble` omits the segment entirely.
 */
async function buildStateBlock(
  env: Env,
  chatId: string,
  calibration: number,
  atSeq: number | null,
  options: { bonds?: boolean; threads?: boolean },
): Promise<string> {
  try {
    const state = await loadStateAt(env, chatId, atSeq);
    return renderStateBlock(state, Math.round(800 * calibration), undefined, options);
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
  beforeSeq: number | null,
): Promise<string> {
  try {
    const [hits, summaries] = await Promise.all([
      recall(env, chatId, query, 8, beforeSeq),
      env.DB.prepare(
        // Two bounds, for two different ways a summary can be wrong here.
        //
        // `covers_to < ?2` excludes a summary of a LATER turn: a regenerate re-rolls an
        // earlier one, and a summary covering what has not happened yet describes the
        // future. This is the leak that made a re-roll of #3 aware of #9.
        //
        // The `EXISTS` excludes a summary whose range is no longer on the VISIBLE PATH.
        // Deleting the last version of a turn removes everything written after it, but the
        // summaries that covered those rows are in a side table and survive the delete.
        // Without this they keep being injected, describing a scene the reader removed.
        // `covers_to` is tested against the path rather than merely against `?2` because a
        // deleted turn's rows are still in the table with their old seqs.
        `${VISIBLE_PATH_SEQ_CTE}
         SELECT id, content FROM summaries
          WHERE chat_id = ?1
            AND (?2 IS NULL OR covers_to < ?2)
            AND EXISTS (SELECT 1 FROM path WHERE path.seq = summaries.covers_to)
          ORDER BY covers_to DESC LIMIT 3`,
      )
        .bind(chatId, beforeSeq)
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

/**
 * Expands `{{original}}` to the user's own setting.
 *
 * The spec requires this and gives the reason: a card that does not use it silently
 * discards the reader's configured instructions, which is a surprise they cannot see or
 * debug. With it, a card can append its own directive to theirs instead of replacing it.
 */
function applyOriginal(cardValue: string, userValue: string): string {
  if (cardValue.length === 0) return userValue;
  if (!cardValue.includes('{{original}}')) return cardValue;
  return cardValue.replaceAll('{{original}}', userValue);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
