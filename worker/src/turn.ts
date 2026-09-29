import { getChat } from './db';
import { loadEffectiveSettings } from './effective';
import { loadProviderKey, keyErrorMessage } from './keys';
import { getProvider } from './providers';
import type { NormalizedUsage, Provider } from './providers/types';
import { badRequest, notFound, readJson } from './http';
import { buildPrompt, send } from './prompt';
import { persistAssistant, persistUserMessage } from './persist';
import { addAlternativeRow, lastActiveMessage } from './messages';
import { parseSse } from '../../src/lib/sse';
import { estimateChatTokens } from '../../src/lib/tokenEstimate';
import { updateState } from './state/update';
import { scheduleMemory } from './memory/schedule';
import type { ChatRow } from './db';

/**
 * Continuation modes. All three share one pipeline — assemble, stream, persist — and
 * differ only in what they put at the end of the prompt and which role the reply takes.
 *
 *  - `send`        a normal turn. The user's message becomes the tail.
 *  - `regenerate`  re-roll the LAST assistant message. Nothing is appended to history;
 *                  the reply lands as a new alternative in that message's swipe group,
 *                  which is why swiping back is free.
 *  - `impersonate` the model writes the USER's next line. The reply is stored as a user
 *                  message, so the chat advances as if the user had typed it.
 *  - `continue`    extend the last assistant message. The reply is appended to that
 *                  message's own group rather than starting a new turn, so the prose
 *                  flows on without a seam.
 */
export type TurnMode = 'send' | 'regenerate' | 'impersonate' | 'continue';

interface TurnBody {
  chatId?: string;
  content?: string;
  mode?: TurnMode;
}

export async function handleTurn(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<TurnBody>(req);
  if (!body?.chatId) return badRequest('chatId required');

  const mode: TurnMode = body.mode ?? 'send';
  // Only `send` carries text from the user; the other modes are driven by the chat's own
  // last message, so requiring content would force the client to send a placeholder.
  if (mode === 'send' && (typeof body.content !== 'string' || body.content.length === 0)) {
    return badRequest('content required');
  }

  const chat = await getChat(env, body.chatId);
  if (!chat) return notFound('chat not found');

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await runTurn(controller, env, ctx, chat, mode, body.content ?? '');
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

async function runTurn(
  controller: ReadableStreamDefaultController<Uint8Array>,
  env: Env,
  ctx: ExecutionContext,
  chat: ChatRow,
  mode: TurnMode,
  content: string,
): Promise<void> {
  // Preset layered over global settings: a preset exists to override the defaults, so
  // it wins for anything it defines.
  const settings = await loadEffectiveSettings(env, chat.preset_id);
  const provider = settings.provider ? getProvider(settings.provider) : null;
  if (!settings.provider || !settings.model || !provider) {
    return fail(controller, 'No provider or model configured. Open /settings.', 'unconfigured');
  }

  const apiKey = await loadProviderKey(env, settings.provider);
  if (!apiKey.ok) {
    return fail(controller, keyErrorMessage(settings.provider, apiKey.reason), 'no_key');
  }

  // Resolve what this turn attaches to, and where its output goes.
  const target = mode === 'send' ? null : await lastActiveMessage(env, chat.id);
  if (mode !== 'send' && !target) {
    return fail(controller, 'There is no message to work from yet.', 'empty_chat');
  }
  if (mode === 'regenerate' && target?.role !== 'assistant') {
    return fail(controller, 'The last message is not one of mine to redo.', 'wrong_role');
  }
  if (mode === 'continue' && target?.role !== 'assistant') {
    return fail(controller, 'The last message is not one of mine to continue.', 'wrong_role');
  }

  // For `send`, the user message is persisted BEFORE the provider is called, so a crash
  // costs a reply and never the user's own words. The other modes add no user text, so
  // there is nothing to lose and nothing to persist up front.
  const userSeq = mode === 'send' ? await persistUserMessage(env, chat.id, content) : null;

  const prompt = await buildPrompt(env, chat, settings, {
    mode,
    userSeq,
    userContent: content,
    tailExtra: mode === 'impersonate' ? IMPERSONATE_INSTRUCTION : mode === 'continue' ? CONTINUE_INSTRUCTION : '',
  });

  const request = provider.buildRequest(
    {
      model: settings.model,
      messages: prompt.messages,
      stream: true,
      maxTokens: settings.maxTokens,
      // Stop strings come from the preset; without them the model runs past where the
      // preset author intended the reply to end.
      knobs: settings.stopStrings.length > 0
        ? { ...settings.knobs, stop: settings.stopStrings }
        : settings.knobs,
      sessionId: chat.session_id,
    },
    apiKey.key,
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

  if (assistantText.length === 0) {
    return fail(controller, error ?? 'The provider returned no content.', 'stream');
  }

  const costUsd = resolveCost(usage);

  // Where the text lands depends on the mode. `regenerate` and `continue` extend an
  // existing message's swipe group, so the conversation keeps exactly one active row per
  // position and swiping back recovers the previous attempt.
  const messageId =
    mode === 'regenerate' || mode === 'continue'
      ? await addAlternativeRow(env, chat.id, target!.id, assistantText)
      : await persistAssistant(env, chat.id, assistantText, usage, costUsd, {
          role: mode === 'impersonate' ? 'user' : 'assistant',
        });

  send(controller, {
    type: 'done',
    messageId,
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

  // State advances only on a completed turn. Regenerating or continuing rewrites what
  // the scene says, so folding it into state would record a draft as canon.
  if (mode === 'send') {
    ctx.waitUntil(
      updateState(env, chat.id, { user: content, assistant: assistantText }).catch((err: unknown) => {
        console.warn(`[state] update failed for chat=${chat.id}: ${messageOf(err)}`);
      }),
    );
    // Memory runs on the same trigger and for the same reason: the turn is already
    // delivered and persisted, so bookkeeping must not delay it. `scheduleMemory`
    // decides whether enough has accumulated; most turns it does nothing.
    ctx.waitUntil(scheduleMemory(env, chat.id));
  }
}

/** Kept here rather than in the prompt builder: they are mode-specific, not layout. */
const IMPERSONATE_INSTRUCTION =
  'Write the next message from the perspective of the other participant in this scene. ' +
  'Write only their words and actions, in the same style as their previous messages. ' +
  'Do not narrate for anyone else.';

const CONTINUE_INSTRUCTION =
  'Continue the previous message from exactly where it stops. Do not repeat any of it. ' +
  'Do not begin a new message or add a speaker label.';

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

/**
 * Cost is whatever the provider reported. Kenari reports none, and converting its
 * micro-IDR rate card needs a configured exchange rate — inventing a number would be
 * worse than showing none, so the UI renders "unpriced" rather than a guess.
 */
function resolveCost(usage: NormalizedUsage | null): number | null {
  return usage?.costUsd ?? null;
}

async function calibrate(
  env: Env,
  model: string,
  returnedPromptTokens: number,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  const localCount = estimateChatTokens(messages);
  if (localCount <= 0 || returnedPromptTokens <= 0) return;

  const existing = await env.DB.prepare(
    'SELECT factor, samples FROM token_calibration WHERE model = ?',
  )
    .bind(model)
    .first<{ factor: number; samples: number }>();

  const observed = returnedPromptTokens / localCount;
  if (observed < 0.5 || observed > 2) return;

  const factor = 0.8 * (existing?.factor ?? 1) + 0.2 * observed;

  await env.DB.prepare(
    `INSERT INTO token_calibration (model, factor, samples, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET factor = excluded.factor, samples = excluded.samples,
       updated_at = excluded.updated_at`,
  )
    .bind(model, factor, (existing?.samples ?? 0) + 1, Date.now())
    .run();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

