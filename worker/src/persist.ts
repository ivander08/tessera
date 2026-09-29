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

export async function persistUserMessage(env: Env, chatId: string, content: string): Promise<number> {
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

export async function persistAssistant(
  env: Env,
  chatId: string,
  content: string,
  usage: NormalizedUsage | null,
  costUsd: number | null,
  options: { role?: Role } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  // Impersonation writes a USER row: the model produced the text, but the chat has to
  // advance as though the user had typed it, or the next turn sees two assistant
  // messages in a row and providers reject it.
  const role = options.role ?? 'assistant';

  await env.DB.prepare(
    `INSERT INTO messages
       (id, chat_id, parent_id, role, content, content_tokens, prompt_tokens,
        completion_tokens, cached_tokens, cache_write_tokens, cost_usd, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      chatId,
      role,
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
