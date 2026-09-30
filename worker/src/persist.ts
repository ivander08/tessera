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
 * Writes the reader's message and returns its id and seq.
 *
 * The id is what the reply will be parented to, so it has to come back: a turn is two
 * rows in a chain, and parenting both to the message before the reader's would leave two
 * active children of one parent — the transcript walk would take the newer and drop the
 * reader's own line from the scene.
 */
export async function persistUserMessage(
  env: Env,
  chatId: string,
  content: string,
  parentId: string | null,
): Promise<{ id: string; seq: number }> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const row = await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, created_at)
     VALUES (?, ?, ?, 'user', ?, ?, ?) RETURNING seq`,
  )
    .bind(id, chatId, parentId, content, estimateTokens(content), now)
    .first<{ seq: number }>();
  await env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId).run();
  return { id, seq: row?.seq ?? 0 };
}

/**
 * Writes an assistant row and returns its id.
 *
 * `speaker` names who wrote it, and is null for the chat's own character — which is every
 * row in a single-character scene and every row written before casts existed. A group
 * reply is also null: it contains several speakers and the CONTENT carries the
 * attribution, so a single name on the row would be a half-truth. The column is written
 * only when it is informative, and `includeNames` falls back to the chat's character for
 * the null case.
 */
export async function persistAssistant(
  env: Env,
  chatId: string,
  content: string,
  usage: NormalizedUsage | null,
  costUsd: number | null,
  options: { role?: Role; parentId?: string | null; speaker?: string | null } = {},
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
        completion_tokens, cached_tokens, cache_write_tokens, cost_usd, speaker, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      chatId,
      options.parentId ?? null,
      role,
      content,
      estimateTokens(content),
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.cachedTokens ?? null,
      usage?.cacheWriteTokens ?? null,
      costUsd,
      options.speaker ?? null,
      now,
    )
    .run();
  await env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId).run();
  return id;
}
