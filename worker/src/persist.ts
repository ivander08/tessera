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
 * The id and seq a reader's message WILL have, without writing it.
 *
 * A turn needs the row's id before the provider is called — the reply is parented to it —
 * but writing it that early is what made Stop impossible to implement honestly. A Worker
 * cannot do database work after the client disconnects: the isolate is torn down, and any
 * cleanup attempted after an abort dies with "Network connection lost". So the row is
 * written by the SUCCESS path only, and this hands out the id the reply will point at.
 *
 * `seq` is only needed for the prompt's windowing, which happens before the write, so the
 * caller passes the tail's seq and the real one is assigned by SQLite on insert.
 */
export function reserveUserMessage(): { id: string } {
  return { id: crypto.randomUUID() };
}

/**
 * Writes the reader's message, and the reply that answers it, in one batch.
 *
 * Both rows land together or neither does, which is what makes Stop mean "the scene is
 * unchanged" rather than "the scene has my message in it and no answer".
 */
export async function persistTurn(
  env: Env,
  chatId: string,
  user: { id: string; content: string; parentId: string | null } | null,
  reply: {
    content: string;
    parentId: string | null;
    role: Role;
    usage: NormalizedUsage | null;
    costUsd: number | null;
    speaker?: string | null;
  },
): Promise<{ userId: string | null; replyId: string }> {
  const now = Date.now();
  const replyId = crypto.randomUUID();
  const statements = [];

  if (user) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, created_at)
         VALUES (?, ?, ?, 'user', ?, ?, ?)`,
      ).bind(user.id, chatId, user.parentId, user.content, estimateTokens(user.content), now),
    );
  }

  statements.push(
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
  );

  statements.push(env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId));

  await env.DB.batch(statements);
  return { userId: user?.id ?? null, replyId };
}
