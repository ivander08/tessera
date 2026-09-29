import { getChat, getCharacter, getPersona, loadChatSettings } from './db';
import type { ChatRow, ChatSettings } from './db';
import { loadProviderKey } from './keys';
import { getProvider } from './providers';
import type { NormalizedUsage, Provider } from './providers/types';
import { badRequest, notFound, readJson } from './http';
import { assemble } from '../../src/lib/prompt/assemble';
import type { AssembledPrompt } from '../../src/lib/prompt/types';
import { computeWindowStart } from '../../src/lib/prompt/window';
import { parseSse } from '../../src/lib/sse';
import { applyCalibration, estimateChatTokens, estimateTokens } from '../../src/lib/tokenEstimate';
import { alwaysOnLore, parseLorebook } from '../../src/lib/cards/lorebook';
import type { CharacterCardJson } from '../../src/lib/cards/types';
import { asNumber, asRecord } from '../../src/lib/json';
import { renderMemoryBlock } from '../../src/lib/prompt/memoryBlock';
import { renderStateBlock } from '../../src/lib/prompt/stateBlock';
import { recall } from './memory/recall';
import { loadState, updateState } from './state/update';
import type { Role, WireMessage } from '../../src/lib/prompt/types';

interface ChatBody {
  chatId?: string;
  content?: string;
}

interface HistoryRow {
  seq: number;
  role: Role;
  content: string;
  content_tokens: number | null;
}

type Frame =
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; usage: NormalizedUsage; costUsd: number | null }
  | { type: 'error'; message: string; code: string };

export async function handleChat(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<ChatBody>(req);
  if (!body?.chatId || typeof body.content !== 'string' || body.content.length === 0) {
    return badRequest('chatId and content required');
  }

  const chat = await getChat(env, body.chatId);
  if (!chat) return notFound('chat not found');

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await runTurn(controller, env, ctx, chat, body.content as string);
      } catch (error) {
        try {
          send(controller, { type: 'error', message: messageOf(error), code: 'internal' });
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

function send(controller: ReadableStreamDefaultController<Uint8Array>, frame: Frame): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
}

async function runTurn(
  controller: ReadableStreamDefaultController<Uint8Array>,
  env: Env,
  ctx: ExecutionContext,
  chat: ChatRow,
  content: string,
): Promise<void> {
  const settings = await loadChatSettings(env);
  const provider = settings.provider ? getProvider(settings.provider) : null;
  if (!settings.provider || !settings.model || !provider) {
    return fail(controller, 'No provider or model configured. Open /settings.', 'unconfigured');
  }

  const apiKey = await loadProviderKey(env, settings.provider);
  if (!apiKey) {
    return fail(controller, `No API key stored for ${settings.provider}. Open /settings.`, 'no_key');
  }

  // Persist the user message BEFORE calling the provider. A crash after this point
  // costs a reply, never the user's own words. Config checks run first so a message
  // that was never going to be sent does not enter the append-only log.
  const userSeq = await persistUserMessage(env, chat.id, content);

  const prompt = await buildPrompt(env, chat, settings, userSeq, content);
  await runPrefixGuard(env, chat, prompt);

  const request = provider.buildRequest(
    {
      model: settings.model,
      messages: prompt.messages,
      stream: true,
      maxTokens: settings.maxTokens,
      knobs: settings.knobs,
      sessionId: chat.session_id,
    },
    apiKey,
  );

  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch (error) {
    return fail(controller, messageOf(error), 'network');
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    return fail(controller, provider.readError(response.status, text), 'provider_http');
  }

  const { text: assistantText, usage, error } = await pipeStream(controller, provider, response.body);

  // Zero characters is not a partial reply. An empty assistant row would pollute the
  // append-only log and force the next turn to send an empty message, which some
  // providers reject outright.
  if (assistantText.length === 0) {
    return fail(controller, error ?? 'The provider returned no content.', 'stream');
  }

  const costUsd = await resolveCost(env, settings, usage);

  // Whatever arrived is persisted, success or failure: a partial reply is still a
  // reply, and dropping it wastes the user's money and breaks the append-only log.
  const assistantId = await persistAssistant(env, chat.id, assistantText, usage, costUsd);

  send(controller, {
    type: 'done',
    messageId: assistantId,
    usage: usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
    },
    costUsd,
  });

  if (usage) await calibrate(env, settings.model, usage.promptTokens, prompt.messages);

  // World-state tracking runs as a SEPARATE cheap-model call after the reply is
  // already delivered and persisted. Two reasons it is here and not inside the
  // narrator's request: the narrator must never see the state schema (a side-channel
  // in the main reply leaks into visible prose and measurably degrades writing), and
  // the user should not wait on bookkeeping to read their own reply.
  //
  // `waitUntil` keeps the Worker alive for it without blocking the response stream.
  ctx.waitUntil(
    updateState(env, chat.id, { user: content, assistant: assistantText }).catch((error: unknown) => {
      // Failures here degrade to "state did not advance this turn", never to a failed
      // turn — the reply is already on screen and in the log.
      console.warn(`[state] update failed for chat=${chat.id}: ${messageOf(error)}`);
    }),
  );
}

function fail(
  controller: ReadableStreamDefaultController<Uint8Array>,
  message: string,
  code: string,
): void {
  send(controller, { type: 'error', message, code });
}

async function pipeStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  provider: Provider,
  body: ReadableStream<Uint8Array>,
): Promise<{ text: string; usage: NormalizedUsage | null; error: string | null }> {
  let text = '';
  let usage: NormalizedUsage | null = null;

  try {
    for await (const event of parseSse(body)) {
      if (event.data === '[DONE]') break;
      const frame = provider.parseFrame(event.data);
      if (!frame) continue;
      if (frame.error) return { text, usage, error: frame.error };
      if (frame.text) {
        text += frame.text;
        send(controller, { type: 'delta', text: frame.text });
      }
      if (frame.usage) usage = frame.usage;
    }
  } catch (error) {
    // A client disconnect lands here too. Whatever text arrived is still a reply.
    return { text, usage, error: messageOf(error) };
  }

  return { text, usage, error: null };
}

async function buildPrompt(
  env: Env,
  chat: ChatRow,
  settings: ChatSettings,
  userSeq: number,
  userContent: string,
): Promise<AssembledPrompt> {
  const character = chat.character_id ? await getCharacter(env, chat.character_id) : null;
  if (!character) throw new Error('chat has no character');
  const card = JSON.parse(character.card_json) as CharacterCardJson;
  const personaRow = chat.persona_id ? await getPersona(env, chat.persona_id) : null;

  // Everything BEFORE the user message just persisted. That message is passed in
  // explicitly as the tail rather than inferred from the last row: inferring it means
  // any orphan user row (from a turn that failed before the provider answered) turns
  // the next request into two consecutive user turns, which providers reject.
  const { results } = await env.DB.prepare(
    `SELECT seq, role, content, content_tokens FROM messages
      WHERE chat_id = ? AND seq < ? ORDER BY seq`,
  )
    .bind(chat.id, userSeq)
    .all<HistoryRow>();

  // The budget is expressed in real prompt tokens, but `content_tokens` is a local
  // estimate with a per-model bias. Applying the stored factor here is what keeps the
  // budget honest for a model whose tokenizer differs from the estimator — without it,
  // a 16k budget silently becomes 10k for one model and 25k for another.
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

  // Recall is driven by the user's own turn and rendered into the TAIL. A recalled
  // message spliced back into `history` would rewrite the cached prefix and cost every
  // subsequent turn its cache.
  const memoryBlock = await buildMemoryBlock(env, chat.id, userContent, calibration);
  const stateBlock = await buildStateBlock(env, chat.id, calibration);

  return assemble(
    {
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
      history: results
        .filter((row) => row.seq >= windowStart)
        .map((row) => ({ role: row.role, content: row.content })),
      tail: {
        memoryBlock,
        stateBlock,
        authorsNote: settings.authorsNote,
        postHistoryInstructions: card.postHistoryInstructions,
        userMessage: userContent,
      },
    },
    estimateChatTokens,
  );
}

/** Tokens reserved for the memory block, taken out of the history budget. */
const MEMORY_BLOCK_TOKENS = 800;

/**
 * Renders the world-state document for the prompt TAIL.
 *
 * The state changes as the scene moves, so it can never sit in the head. Returns ''
 * when there is no state yet, so `assemble` omits the segment entirely.
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
 * Assembles the memory block for this turn. Returns '' when there is nothing to say,
 * so `assemble` omits the segment rather than emitting an empty system message.
 *
 * Failures here degrade to "no memory this turn" rather than failing the turn: a
 * missing FTS index or an unconfigured summarizer must not cost the user their reply.
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

/**
 * M3.3 prefix guard. Tripwire for the failure this project exists to prevent: a
 * well-meaning future edit — a clock, a "last active" line — silently rewriting the
 * cached prefix.
 *
 * The prefix legitimately CHANGES every turn: history appends, so it grows. Growth is
 * expected and must not warn, or the warning becomes noise nobody reads. What must
 * never happen is an existing index mutating in place, or the prefix shrinking
 * without a re-anchor. Those are what this compares.
 */
async function runPrefixGuard(env: Env, chat: ChatRow, prompt: AssembledPrompt): Promise<void> {
  const current = prompt.messages.slice(0, prompt.tailStart).map((m) => m.content.slice(0, 120));
  const head = JSON.stringify(current);

  if (chat.last_prefix_head) {
    const previous = JSON.parse(chat.last_prefix_head) as string[];
    const shared = Math.min(previous.length, current.length);
    for (let i = 0; i < shared; i++) {
      if (previous[i] !== current[i]) {
        console.warn(
          `[prefix-guard] chat=${chat.id} prefix mutated at message[${i}]: ` +
            `was ${JSON.stringify(previous[i])} now ${JSON.stringify(current[i])}`,
        );
        break;
      }
    }
  }

  await env.DB.prepare('UPDATE chats SET last_prefix_hash = ?, last_prefix_head = ? WHERE id = ?')
    .bind(prompt.prefixHash, head, chat.id)
    .run();
}

async function persistUserMessage(env: Env, chatId: string, content: string): Promise<number> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, created_at)
     VALUES (?, ?, NULL, 'user', ?, ?, ?) RETURNING seq`,
  )
    .bind(crypto.randomUUID(), chatId, content, estimateTokens(content), now)
    .first<{ seq: number }>();
  await env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId).run();
  return row?.seq ?? 0;
}

/**
 * `prompt_tokens` is the denominator of the cache meter; `content_tokens` is the
 * windowing input. They are different numbers and are stored separately — the
 * provider reports the former, the tokenizer estimates the latter.
 */
async function persistAssistant(
  env: Env,
  chatId: string,
  content: string,
  usage: NormalizedUsage | null,
  costUsd: number | null,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages
       (id, chat_id, parent_id, role, content, content_tokens, prompt_tokens,
        completion_tokens, cached_tokens, cache_write_tokens, cost_usd, created_at)
     VALUES (?, ?, NULL, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      chatId,
      content,
      estimateTokens(content),
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.cachedTokens ?? null,
      usage?.cacheWriteTokens ?? null,
      costUsd,
      now,
    )
    .run();
  await env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId).run();
  return id;
}

/**
 * Kenari reports no cost. Its rate card is micro-IDR per 1M tokens; converting to USD
 * needs a configured rate, so `costUsd` stays null until one exists rather than
 * inventing a number.
 */
async function resolveCost(
  env: Env,
  settings: ChatSettings,
  usage: NormalizedUsage | null,
): Promise<number | null> {
  if (!usage) return null;
  if (usage.costUsd !== null) return usage.costUsd;
  if (settings.provider !== 'kenari' || !settings.model || !settings.idrPerUsd) return null;

  const cached = await env.DB.prepare("SELECT value FROM settings WHERE key = 'kenari_pricing'").first<{
    value: string;
  }>();
  if (!cached) return null;
  const table = asRecord(JSON.parse(cached.value));
  const row = table ? asRecord(table[settings.model]) : null;
  if (!row) return null;

  const input = typeof row.input === 'number' ? row.input : null;
  const output = typeof row.output === 'number' ? row.output : null;
  if (input === null || output === null) return null;

  const idr =
    (usage.promptTokens / 1e6) * (input / 1e6) + (usage.completionTokens / 1e6) * (output / 1e6);
  return idr / settings.idrPerUsd;
}

/**
 * The stored correction factor for a model, or 1 when nothing has been observed yet.
 * Calibration converges the cheap local estimate onto whatever tokenizer the model
 * actually uses, which is why the local count is only ever a pre-flight input.
 */
async function loadCalibration(env: Env, model: string | null): Promise<number> {
  if (!model) return 1;
  const row = await env.DB.prepare('SELECT factor FROM token_calibration WHERE model = ?')
    .bind(model)
    .first<{ factor: number }>();
  return asNumber(row?.factor, 1);
}

/** M2.2 calibration: converge the local estimate on the provider's real tokenizer. */
async function calibrate(
  env: Env,
  model: string,
  returnedPromptTokens: number,
  messages: WireMessage[],
): Promise<void> {
  const localCount = estimateChatTokens(messages);
  if (localCount <= 0 || returnedPromptTokens <= 0) return;

  const existing = await env.DB.prepare(
    'SELECT factor, samples FROM token_calibration WHERE model = ?',
  )
    .bind(model)
    .first<{ factor: number; samples: number }>();

  const observed = returnedPromptTokens / localCount;
  // One pathological response must not poison the estimate.
  if (observed < 0.5 || observed > 2) return;

  const factor = 0.8 * asNumber(existing?.factor, 1) + 0.2 * observed;

  await env.DB.prepare(
    `INSERT INTO token_calibration (model, factor, samples, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET factor = excluded.factor, samples = excluded.samples,
       updated_at = excluded.updated_at`,
  )
    .bind(model, factor, asNumber(existing?.samples, 0) + 1, Date.now())
    .run();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
