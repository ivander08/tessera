import { getChat } from './db';
import { loadEffectiveSettings } from './effective';
import { loadProviderKey, keyErrorMessage } from './keys';
import { getProvider } from './providers';
import type { NormalizedUsage, Provider } from './providers/types';
import { badRequest, notFound, readJson } from './http';
import { buildPrompt, send } from './prompt';
import { persistTurn, reserveUserMessage } from './persist';
import {
  addAlternativeRow,
  lastActiveMessage,
  loadMessage,
  type MessageRow,
} from './messages';
import { tailId } from './branch';
import { parseSse } from '../../src/lib/sse';
import type { Role } from '../../src/lib/prompt/types';
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
        await runTurn(
          controller,
          env,
          ctx,
          chat,
          mode,
          body.content ?? '',
          body.targetId ?? null,
          // The client's own abort. Pressing Stop cancels the fetch, which aborts this
          // signal — and that is the ONLY way the server can tell "the reader pressed Stop"
          // from "the connection dropped", which want different behaviour. See `pipeStream`.
          req.signal,
        );
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
  /** Aborted when the client goes away — Stop, or a closed tab. */
  signal: AbortSignal,
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

  // The end of the visible path, which is what a step forward attaches to. Resolved for
  // every mode, not just the ones that use it directly: `resolveAttachment` falls back to it
  // for a `continue` with no target, and a null there would root a row at the opening.
  const tail = await tailId(env, chat.id);

  // The world state this turn is written against. See `stateSeqFor` for the rule and why a
  // regenerate is the only mode that differs.
  const stateSeq = stateSeqFor(mode, target);

  // Where a new row attaches, and where the model's output attaches. Both are decided by
  // one pure function so the rules can be asserted without a provider.
  const { parentId, replyParentId } = resolveAttachment(mode, target, tail);

  // The reader's message is NOT written yet. Writing it before the provider was called was
  // the reason Stop could not be implemented honestly: a Worker cannot do database work
  // after the client disconnects — the isolate is torn down mid-cleanup and the row is left
  // on the visible path — so a stopped turn could never remove what it had already written.
  //
  // Instead the id is reserved now, because the reply is parented to it, and BOTH rows are
  // written together on the success path. Stop therefore means the scene is byte-identical
  // to what it was, which is the only reading of the button a reader can trust.
  //
  // The exception is a `continue` recovering a stopped turn: that reader row already exists
  // and is the target, so it is reused rather than reserved.
  const reserved = mode === 'send' ? reserveUserMessage() : null;
  const userId = reserved?.id ?? null;
  // The history window must stop where the transcript stops. For a recovery `continue` the
  // reader's row is the tail rather than history, and for a `regenerate` the target and
  // everything after it are being replaced. See `historyCutoffFor`.
  const historyCutoff = historyCutoffFor(mode, target, answeringPendingUser);

  // The reply answers the reader's message when there is one, so it is that row's child
  // rather than the position the reader's message occupies.
  const outputParentId = userId ?? replyParentId;

  // Nothing has been written yet, so a failure has nothing to clean up. `failAfterPersist`
  // survives only for the recovery-`continue` case, where the reader's row genuinely
  // pre-exists — but even there it is left alone, because it is the reader's text and the
  // next Continue answers it.

  // Nothing is written until the reply is complete, so a failure simply reports itself.
  // The old `failAfterPersist` existed to undo an early write; there is no longer one to
  // undo, and a Worker cannot reliably do cleanup after a disconnect anyway.
  const failTurn = (message: string, code: string): void => fail(controller, message, code);

  try {
    const prompt = await buildPrompt(env, chat, settings, {
      mode,
      historyCutoff,
      stateSeq,
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
          ? settings.presetImpersonation || IMPERSONATE_INSTRUCTION
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
        disableReasoning: settings.disableReasoning,
      },
      apiKey.key,
    );

    let response: Response;
    try {
      response = await fetch(request.url, request.init);
    } catch (error) {
      return failTurn(messageOf(error), 'network');
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      return failTurn(provider.readError(response.status, text), 'provider_http');
    }

    const {
      text: assistantText,
      usage,
      error,
      finishReason,
      aborted,
    } = await pipeStream(controller, provider, response.body, signal);

    // Stop: NOTHING is written. Not the partial reply, and not the reader's own message
    // either — the scene is exactly as it was before the turn, which is the only reading of
    // the button a reader can trust. Reporting an error here would be wrong too: pressing
    // Stop is not a failure.
    if (aborted) return;

    if (assistantText.length === 0) {
      return failTurn(error ?? 'The provider returned no content.', 'stream');
    }

    const costUsd = resolveCost(usage);

    // Where the text lands depends on the mode.
    //
    // `regenerate` adds a VARIANT of an existing position, so the conversation keeps exactly
    // one active row per position and swiping back recovers the previous attempt. The
    // variant has no children, so the scene below it is shorter until it grows its own —
    // that is the model working as designed, not a defect.
    //
    // Everything else writes a new step in the scene, and the reader's own row lands in the
    // same batch so the two cannot come apart.
    const messageId =
      mode === 'regenerate'
        ? await addAlternativeRow(env, chat.id, target!.id, assistantText)
        : (
            await persistTurn(
              env,
              chat.id,
              // The reader's row, written now rather than up front. Null for the modes that
              // add no reader text.
              userId ? { id: userId, content, parentId } : null,
              {
                content: assistantText,
                parentId: outputParentId,
                role: mode === 'impersonate' ? 'user' : 'assistant',
                usage,
                costUsd,
              },
            )
          ).replyId;

    // The seq of the row just written. Provenance for anything derived from this reply —
    // cast members, and the fact range below — needs the turn's own coordinate, and `seq`
    // is only assigned by the insert.
    const replyRow = await env.DB.prepare('SELECT seq FROM messages WHERE id = ?')
      .bind(messageId)
      .first<{ seq: number }>();
    const replySeq = replyRow?.seq ?? 0;

    // State advances only on a completed turn. Regenerating or continuing rewrites what
    // the scene says, so folding it into state would record a draft as canon.
    //
    // The recovery `continue` is the exception: it completes the turn that was stopped, so
    // it is the `send` it stands in for and advances state the same way. Without this the
    // recovered turn would be the one turn in the chat that never touched the world state.
    //
    // This runs BEFORE the `done` frame, and that ordering is load-bearing. The turn's own
    // scene line is the snapshot this writes onto `messageId`, and the client refetches the
    // transcript the moment it sees `done`. Run behind `waitUntil` (which is where it used
    // to be) the update takes ~3s against the live cheap model, the refetch found
    // `state_json` still null, and the newest reply inherited the PREVIOUS turn's clock —
    // while the state panel, fetched later from the live document, showed the new one.
    // Reported exactly that way: "22:02 inline, 22:23 in the panel".
    //
    // `maybeUpdateState` never throws — every failure path returns `{ applied: false }` —
    // so a provider problem costs the snapshot, not the turn.
    if (mode === 'send' || answeringPendingUser) {
      const stateUser = answeringPendingUser ? target!.content : content;
      try {
        await maybeUpdateState(
          env,
          chat.id,
          { user: stateUser, assistant: assistantText },
          messageId,
          stateSeq,
        );
      } catch (err: unknown) {
        console.warn(`[state] update failed for chat=${chat.id}: ${messageOf(err)}`);
      }
    }

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

    if (mode === 'send' || answeringPendingUser) {
      // Memory runs on the same trigger and for the same reason: the turn is already
      // delivered and persisted, so bookkeeping must not delay it. `scheduleMemory`
      // decides whether enough has accumulated; most turns it does nothing.
      ctx.waitUntil(scheduleMemory(env, chat.id));

      // Anyone the narrator introduced. Behind `waitUntil` for the same reason: the reply
      // is already delivered, so a cast member must never delay it — and a failure here
      // costs a cast entry, not a turn.
      ctx.waitUntil(
        recordSpeakers(env, chat.id, assistantText, replySeq).catch((err: unknown) => {
          console.warn(`[cast] speaker detection failed for chat=${chat.id}: ${messageOf(err)}`);
        }),
      );
    }
  } catch (error) {
    return failTurn(messageOf(error), 'internal');
  }
}

/**
 * The fallback when the attached preset sets no `impersonationPrompt`. A preset's own
 * instruction wins when present — it is the author's statement of how their model should
 * write the reader's line, and the built-in text is only a generic approximation.
 */
const IMPERSONATE_INSTRUCTION =
  'Write the next message from the perspective of the other participant in this scene. ' +
  'Write only their words and actions, in the same style as their previous messages. ' +
  'Do not narrate for anyone else.';

/**
 * Where a turn's rows attach, as a pure function so the rules can be asserted directly.
 *
 * This is the decision that broke a real chat. Two different questions live here, and
 * conflating them put a reader's own line at the top of their scene:
 *
 *  - **Where does the reader's message go?** `send` and `impersonate` both produce the NEXT
 *    message in the scene, so their parent is the end of the visible path. `impersonate` is
 *    the model writing the reader's next line — a step forward like any other. Parenting it
 *    to the target's parent made it a SIBLING of the message it was meant to follow.
 *    Measured on a real chat: an impersonated line landed with `parent_id = NULL`, an
 *    alternative OPENING, so the path walk was `ROOT → that line` and the entire scene
 *    disappeared from view.
 *
 *    `regenerate` produces another VARIANT of one position, so its parent is the target's
 *    own parent. A variant is not a replacement: the original keeps its children, so a new
 *    variant shows a shorter scene until it grows its own continuation. That is the model
 *    working as designed, not a defect.
 *
 *  - **Where does the model's output go?** `send` answers the reader's message, so the reply
 *    is that row's child — parenting it to the reader's parent instead would make it a
 *    sibling of the message it answers, and the walk would show the reply while dropping the
 *    reader's own line. `continue` extends the message it was pointed at, so it is that
 *    message's child; reusing the target's parent made a continuation a VARIANT of the reply
 *    it was continuing, so asking for more turned the previous paragraph into a swipe.
 *    `impersonate` writes the reader's next line, which IS the new tail.
 */
/**
 * The transcript point a turn's world state must be read from.
 *
 * `null` means "now" — the live document — and is what every forward turn wants. A
 * `regenerate` instead names the row it is re-rolling, and the state is read from BEFORE it.
 *
 * Why strictly before: the snapshot on a row is the state that row's own turn PRODUCED
 * (`updateState` attaches it to the reply it just wrote), so reading "at or before" the
 * target would hand the model the outcome of the very reply being rewritten. The reported
 * failure was a character walking back INTO a room she had already left, because the state
 * said she was elsewhere — and that fact came from the turn being re-rolled.
 *
 * A pure function so the rule can be asserted without a provider, the same shape
 * `resolveAttachment` uses beside it. The bug it prevents was a correct-looking helper
 * called with the wrong argument, which a test of the helper alone cannot catch.
 */
export function stateSeqFor(
  mode: TurnMode,
  target: { seq: number } | null,
): number | null {
  return mode === 'regenerate' ? (target?.seq ?? null) : null;
}

/**
 * The row at which the history window must stop.
 *
 * `null` keeps the whole visible path — that is `send` and `impersonate`, which append to
 * the end of the transcript and have nothing after them to exclude.
 *
 * `regenerate` cuts at the target, because the reply being re-rolled and every turn after it
 * are about to be replaced. The client already hides them from the transcript; the prompt
 * has to agree, or the model writes an early turn while reading how the story turned out.
 *
 * A recovery `continue` also cuts at the target: that reader row already exists and is
 * passed as the tail, so leaving it in the history would send it twice.
 *
 * Exported as a pure rule beside `resolveAttachment` for the same reason — the bug it
 * prevents is a correct-looking value computed at the wrong moment, which a test of
 * `buildPrompt` alone cannot catch because `buildPrompt` only ever receives the result.
 */
export function historyCutoffFor(
  mode: TurnMode,
  target: { seq: number } | null,
  answeringPendingUser: boolean,
): number | null {
  if (mode === 'regenerate') return target?.seq ?? null;
  if (answeringPendingUser) return target?.seq ?? null;
  return null;
}

export function resolveAttachment(
  mode: TurnMode,
  target: { id: string; parent_id: string | null; role: Role } | null,
  tail: string | null,
): { parentId: string | null; replyParentId: string | null } {
  // A variant sits beside its siblings; a continuation extends its target; everything else
  // is a step forward from the end of the path.
  //
  // Every branch is total: `parentId` is never left null for a mode that has a target, so
  // the fallback in `replyParentId` below cannot quietly root a row at the opening.
  const parentId =
    mode === 'regenerate'
      ? (target?.parent_id ?? null)
      : mode === 'continue'
        ? (target?.id ?? tail)
        : tail;

  const answeringPendingUser = mode === 'continue' && target?.role === 'user';
  const replyParentId = answeringPendingUser
    ? // Answer the reader's own row, which is what the stopped `send` was going to do.
      target!.id
    : mode === 'regenerate'
      ? parentId
      : mode === 'send'
        ? parentId
        : (target?.id ?? parentId);

  return { parentId, replyParentId };
}

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
  signal: AbortSignal,
): Promise<{
  text: string;
  usage: NormalizedUsage | null;
  error: string | null;
  finishReason: string | null;
  /**
   * The reader pressed Stop. Whatever text arrived is DISCARDED and nothing is written.
   *
   * Stop has to mean the scene is untouched, or the button cannot be trusted: a reader who
   * stops an unwanted generation must not then have to delete the fragment it left behind.
   * The alternative — keeping the partial and marking it stopped — leaves debris in the
   * scene every time someone changes their mind mid-reply.
   *
   * Distinguished from a dropped connection, which is NOT an abort: a reader whose wifi
   * blinked should keep the paragraph that arrived. Only an explicit client abort discards.
   */
  aborted: boolean;
}> {
  let text = '';
  let usage: NormalizedUsage | null = null;
  let finishReason: string | null = null;

  try {
    for await (const event of parseSse(body)) {
      // Stop, checked per frame rather than only when the stream throws: a provider that
      // has gone quiet sends nothing to throw on, and the reader would wait out the rest of
      // a reply they already cancelled.
      if (signal.aborted) return { text, usage, error: null, finishReason, aborted: true };

      if (event.data === '[DONE]') break;
      const frame = provider.parseFrame(event.data);
      if (!frame) continue;
      if (frame.error) return { text, usage, error: frame.error, finishReason, aborted: false };
      if (frame.text) {
        text += frame.text;
        send(controller, { type: 'delta', text: frame.text });
      }
      if (frame.usage) usage = frame.usage;
      if (frame.finishReason) finishReason = frame.finishReason;
    }
  } catch (error) {
    // A write to a closed controller throws, which is how a client disconnect surfaces
    // here. An abort at that moment is the reader pressing Stop; anything else is the
    // connection failing, and the text that arrived is still a reply.
    return {
      text,
      usage,
      error: messageOf(error),
      finishReason,
      aborted: signal.aborted,
    };
  }

  return { text, usage, error: null, finishReason, aborted: signal.aborted };
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

