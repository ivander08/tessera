import { getChat } from './db';
import { loadEffectiveSettings } from './effective';
import { loadProviderKey, keyErrorMessage } from './keys';
import { getProvider } from './providers';
import type { NormalizedUsage, Provider } from './providers/types';
import { badRequest, notFound, readJson } from './http';
import { buildPrompt, send } from './prompt';
import { persistAssistant, persistUserMessage } from './persist';
import {
  abandonMessage,
  addAlternativeRow,
  lastActiveMessage,
  loadMessage,
  type MessageRow,
} from './messages';
import { tailId } from './branch';
import { parseSse } from '../../src/lib/sse';
import { estimateChatTokens } from '../../src/lib/tokenEstimate';
import { maybeUpdateState } from './scene';
import { recordSpeakers } from './cast';
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
  /** The message a `regenerate` or `continue` acts on. See `resolveTarget`. */
  targetId?: string | null;
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
        await runTurn(controller, env, ctx, chat, mode, body.content ?? '', body.targetId ?? null);
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
  requestedTargetId: string | null,
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
  //
  // The client names the message for the modes that act on one, and that name wins. It
  // is the only side that knows which turn the button was pressed on: after a stopped or
  // failed turn the chat's last row is the user's own message, so inferring "the last
  // message" would refuse to redo a reply that is plainly on screen.
  //
  // The id is verified to belong to this chat rather than trusted, so a stale or forged
  // one cannot reach into another conversation.
  let target: MessageRow | null = null;
  if (mode !== 'send') {
    target = requestedTargetId
      ? await loadMessage(env, chat.id, requestedTargetId)
      : await lastActiveMessage(env, chat.id);
  }
  if (mode !== 'send' && !target) {
    return fail(controller, 'There is no message to work from yet.', 'empty_chat');
  }
  if (mode === 'regenerate' && target?.role !== 'assistant') {
    return fail(controller, 'The last message is not one of mine to redo.', 'wrong_role');
  }
  if (mode === 'continue' && target?.role !== 'assistant' && target?.role !== 'user') {
    return fail(controller, 'The last message is not one of mine to continue.', 'wrong_role');
  }

  // A `continue` whose target is a USER row is the recovery case, not a misuse.
  //
  // A turn that stopped before the reply arrived — the reader pressed Stop in the first
  // second, the provider died, or the connection dropped — leaves the reader's own
  // message as the end of the visible path, with no assistant row after it. "Continue"
  // there means "answer it". The row is REUSED rather than duplicated, so the reader's
  // text is not written twice, and no cleanup on the abort path has to be reliable for
  // the chat to become usable again.
  const answeringPendingUser = mode === 'continue' && target?.role === 'user';

  // Where a new row attaches.
  //
  //  - `send` answers the end of the visible path, which is the newest thing the reader
  //    can see. Using the newest ROW would be wrong once the chat branches: the newest
  //    row might be an abandoned branch, and the new turn would vanish into it.
  //  - `regenerate` and `continue` keep the target's own parent, because they produce
  //    another version of that position rather than a step after it.
  const parentId =
    mode === 'send' ? await tailId(env, chat.id) : (target?.parent_id ?? null);

  // For `send`, the user message is persisted BEFORE the provider is called, so a crash
  // costs a reply and never the user's own words. The other modes add no user text, so
  // there is nothing to lose and nothing to persist up front.
  //
  // The exception is a `continue` recovering a stopped turn: the reader's row already
  // exists and is the target, so it is reused. Writing it again would put the same text
  // on the path twice.
  const user =
    mode === 'send'
      ? await persistUserMessage(env, chat.id, content, parentId)
      : null;
  const userSeq = answeringPendingUser ? target!.seq : (user?.seq ?? null);

  // Every failure from here on has already written the reader's message. Abandoning it
  // keeps an unreplied row off the visible path, so the next turn parents to the last real
  // turn instead of stacking a second user message in front of the model.
  const userRow = user;
  async function failAfterPersist(message: string, code: string): Promise<void> {
    if (userRow) {
      await abandonMessage(env, chat.id, userRow.id).catch((error: unknown) => {
        console.warn(`[turn] could not abandon orphan row ${userRow.id}: ${messageOf(error)}`);
      });
    }
    fail(controller, message, code);
  }

  // The reply answers the reader's message when there is one, and otherwise follows the
  // message it is continuing. Parenting a `send` reply to `parentId` would make it a
  // sibling of the message it answers: two active children of one parent, and the walk
  // would show the reply while dropping the reader's own line. Parenting a `continue`
  // anywhere but the target would splice it into the wrong place in the scene.
  const replyParentId =
    mode === 'send'
      ? (user?.id ?? parentId)
      : answeringPendingUser
        ? // Answer the reader's own row, which is what the stopped `send` was going to do.
          target!.id
        : mode === 'continue'
          ? (target?.id ?? parentId)
          : parentId;

  // From here on the reader's message is already written, so a throw must abandon it
  // rather than fall through to the stream handler at the top, which writes nothing and
  // leaves the row on the visible path. `buildPrompt` is the known thrower — a chat with
  // no character — but everything below shares the same obligation.
  try {
    const prompt = await buildPrompt(env, chat, settings, {
      mode,
      userSeq,
      // A recovery `continue` has no new text, but the prompt's tail needs the reader's
      // message — that is what the reply is answering. Without it the model would be
      // asked to continue a conversation whose last user turn it cannot see.
      userContent: answeringPendingUser ? target!.content : content,
      // The recovery case is an ordinary reply, not a continuation: the last thing on the
      // path is the READER's message, so "carry it forward as the same speaker" would ask
      // the model to write more of the reader's own text. It answers instead.
      tailExtra: answeringPendingUser
        ? ''
        : mode === 'impersonate'
          ? IMPERSONATE_INSTRUCTION
          : mode === 'continue'
            ? CONTINUE_INSTRUCTION
            : '',
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
      return await failAfterPersist(messageOf(error), 'network');
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      return await failAfterPersist(provider.readError(response.status, text), 'provider_http');
    }

    const {
      text: assistantText,
      usage,
      error,
      finishReason,
    } = await pipeStream(controller, provider, response.body);

    if (assistantText.length === 0) {
      return await failAfterPersist(error ?? 'The provider returned no content.', 'stream');
    }

    const costUsd = resolveCost(usage);

    // Where the text lands depends on the mode.
    //
    // `regenerate` extends an existing message's swipe group, so the conversation keeps
    // exactly one active row per position and swiping back recovers the previous attempt.
    // When it targets a message that already has a continuation, that continuation is not
    // touched: the new alternative becomes the active child, the path walk stops at it, and
    // the old branch drops out of the transcript until you swipe back.
    //
    // `continue` writes a NEW turn answering the last reply. It used to append to that
    // reply's own group, which meant the continuation replaced the message instead of
    // following it — the reader asked for more and watched the previous paragraph vanish.
    // Two assistant turns in a row is what the gesture means.
    const messageId =
      mode === 'regenerate'
        ? await addAlternativeRow(env, chat.id, target!.id, assistantText)
        : await persistAssistant(env, chat.id, assistantText, usage, costUsd, {
            role: mode === 'impersonate' ? 'user' : 'assistant',
            parentId: replyParentId,
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
      // `length` is the provider's own word for "I hit the cap". The reply is kept as it
      // arrived — rewriting it would be a second call the reader did not ask for — but the
      // transcript says so, because a sentence that stops mid-clause otherwise looks like
      // the model failing rather than the budget doing its job.
      truncated: finishReason === 'length',
    });

    if (usage) await calibrate(env, settings.model, usage.promptTokens, prompt.messages);

    // State advances only on a completed turn. Regenerating or continuing rewrites what
    // the scene says, so folding it into state would record a draft as canon.
    //
    // The recovery `continue` is the exception: it completes the turn that was stopped, so
    // it is the `send` it stands in for and advances state the same way. Without this the
    // recovered turn would be the one turn in the chat that never touched the world state.
    if (mode === 'send' || answeringPendingUser) {
      const stateUser = answeringPendingUser ? target!.content : content;
      // `maybeUpdateState` reads the chat's setup and skips the call entirely when the
      // reader set the mode to `off`, so a scene that tracks nothing pays nothing.
      ctx.waitUntil(
        maybeUpdateState(env, chat.id, { user: stateUser, assistant: assistantText }, messageId).catch(
          (err: unknown) => {
            console.warn(`[state] update failed for chat=${chat.id}: ${messageOf(err)}`);
          },
        ),
      );
      // Memory runs on the same trigger and for the same reason: the turn is already
      // delivered and persisted, so bookkeeping must not delay it. `scheduleMemory`
      // decides whether enough has accumulated; most turns it does nothing.
      ctx.waitUntil(scheduleMemory(env, chat.id));

      // Anyone the narrator introduced. Behind `waitUntil` for the same reason: the reply
      // is already delivered, so a cast member must never delay it — and a failure here
      // costs a cast entry, not a turn.
      ctx.waitUntil(
        recordSpeakers(env, chat.id, assistantText).catch((err: unknown) => {
          console.warn(`[cast] speaker detection failed for chat=${chat.id}: ${messageOf(err)}`);
        }),
      );
    }
  } catch (error) {
    return await failAfterPersist(messageOf(error), 'internal');
  }
}

/** Kept here rather than in the prompt builder: they are mode-specific, not layout. */
const IMPERSONATE_INSTRUCTION =
  'Write the next message from the perspective of the other participant in this scene. ' +
  'Write only their words and actions, in the same style as their previous messages. ' +
  'Do not narrate for anyone else.';

const CONTINUE_INSTRUCTION =
  'Write the next message in this scene, continuing directly from where the last one ' +
  'left off. Do not repeat any of it, do not summarise it, and do not begin a new ' +
  'scene. Pick up the thread and carry it forward as the same speaker.';

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
): Promise<{
  text: string;
  usage: NormalizedUsage | null;
  error: string | null;
  finishReason: string | null;
}> {
  let text = '';
  let usage: NormalizedUsage | null = null;
  let finishReason: string | null = null;

  try {
    for await (const event of parseSse(body)) {
      if (event.data === '[DONE]') break;
      const frame = provider.parseFrame(event.data);
      if (!frame) continue;
      if (frame.error) return { text, usage, error: frame.error, finishReason };
      if (frame.text) {
        text += frame.text;
        send(controller, { type: 'delta', text: frame.text });
      }
      if (frame.usage) usage = frame.usage;
      if (frame.finishReason) finishReason = frame.finishReason;
    }
  } catch (error) {
    // A client disconnect lands here too. Whatever text arrived is still a reply.
    return { text, usage, error: messageOf(error), finishReason };
  }

  return { text, usage, error: null, finishReason };
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

