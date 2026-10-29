import type { NormalizedUsage } from './providers/types';
import { estimateTokens } from '../../src/lib/tokenEstimate';
import type { Role } from '../../src/lib/prompt/types';

/**
 * Message writes, in one place so every caller agrees on what each column means.
 *
 * `content_tokens` is what this row's own text costs — the only column windowing may
 * sum. `prompt_tokens` is the provider's report of the whole prompt for the turn that
 * produced the row, and is the denominator of the cache meter. They are different
 * numbers, and conflating them makes windowing sum prompt sizes as if they were message
 * sizes, which is how the context budget ends up apparently blown at a tenth of its
 * limit.
 */

/**
 * The id a reader's message WILL have, before the row is written.
 *
 * A turn needs the id before the provider is called, because the reply is parented to it.
 * The row itself lands immediately after — see `insertUserMessage` — and this hands out the
 * id that row will carry.
 */
export function reserveUserMessage(): { id: string } {
  return { id: crypto.randomUUID() };
}

/**
 * Writes the reader's own message, on its own, BEFORE the provider is called.
 *
 * It goes up front because it must outlive the turn it starts. A Worker cannot do database
 * work after the client disconnects — the isolate is torn down and a write attempted after
 * an abort dies with "Network connection lost" — so anything not already committed when the
 * connection drops is gone for good. That is the reported failure: the reader sends a long
 * message, presses Stop or loses signal, and their own text disappears along with the reply
 * it never got.
 *
 * `active = 1` is passed explicitly so the new row is the visible one on the path, matching
 * what `addVersion` does, rather than depending on the column default.
 */
export async function insertUserMessage(
  env: Env,
  chatId: string,
  message: {
    id: string;
    content: string;
    parentId: string | null;
  },
): Promise<number> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, 1, ?)`,
    ).bind(message.id, chatId, message.parentId, message.content, estimateTokens(message.content), now),
    env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId),
  ]);
  // The row is written BEFORE the prompt is assembled (so it survives a Stop or a
  // dropped connection), and the caller cuts the history window at this seq: the walk
  // would otherwise include the reader's own new row, and the same text also rides in
  // the tail as `userContent` — the message arriving at the model twice.
  //
  // A read rather than a `RETURNING` on the insert, because the two writes are one
  // atomic batch and the batch seam does not hand back a row: the insert is a plain
  // write on both the real driver and the stub drivers, and the seq is read back after
  // it commits.
  const row = await env.DB.prepare('SELECT seq FROM messages WHERE id = ?')
    .bind(message.id)
    .first<{ seq: number }>();
  if (!row) throw new Error('user message not found after insert');
  return row.seq;
}

/**
 * Writes the reply that answers the reader's message.
 *
 * Only the reply: the reader's row is already committed by `insertUserMessage` before the
 * provider is called, so it cannot be taken away by however this turn ends. The reply is
 * the part that is only written on success, because a discarded reply is not debris the
 * reader wants to delete.
 */
export async function persistTurn(
  env: Env,
  chatId: string,
  reply: {
    content: string;
    parentId: string | null;
    role: Role;
    usage: NormalizedUsage | null;
    costUsd: number | null;
    speaker?: string | null;
  },
): Promise<{ replyId: string }> {
  const now = Date.now();
  const replyId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
         (id, chat_id, parent_id, role, content, content_tokens, prompt_tokens,
          completion_tokens, cached_tokens, cache_write_tokens, cost_usd, speaker, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      replyId,
      chatId,
      reply.parentId,
      reply.role,
      reply.content,
      estimateTokens(reply.content),
      reply.usage?.promptTokens ?? null,
      reply.usage?.completionTokens ?? null,
      reply.usage?.cachedTokens ?? null,
      reply.usage?.cacheWriteTokens ?? null,
      reply.costUsd,
      reply.speaker ?? null,
      now,
    ),
    env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId),
  ]);

  return { replyId };
}
