import { json, notFound } from './http';
import { buildMatchQuery } from './memory/fts';

/**
 * Search within a scene.
 *
 * The worker already maintains `messages_fts` and `recall` already queries it, so this
 * exposes the same index rather than building a second one. What is different is the
 * question: `recall` asks "what is relevant to this turn" and renders into the prompt;
 * this asks "where did that happen" and answers the reader.
 *
 * The empty guard is load-bearing and was verified directly against FTS5: `MATCH ''`,
 * `MATCH '...'` and `MATCH '!!!'` all raise `fts5: syntax error` at the SQL level rather
 * than returning nothing. So a query with no searchable token must early-return, exactly
 * as `recall` does — without it, searching for punctuation is a 500.
 */

/** Hits returned when the client does not ask for a count. */
const DEFAULT_LIMIT = 50;
/** A search result larger than this is not a result list. */
const MAX_LIMIT = 100;
/** Characters of context either side of the match. */
const SNIPPET_TOKENS = 12;

export interface SearchHit {
  seq: number;
  id: string;
  role: string;
  speaker: string | null;
  snippet: string;
}

export async function searchChat(env: Env, chatId: string, url: URL): Promise<Response> {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const query = url.searchParams.get('q') ?? '';
  const match = buildMatchQuery(query);

  // An empty expression is a syntax error, not an empty result set.
  if (match.length === 0) return json({ hits: [] });

  const asked = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(asked) && asked >= 1
    ? Math.min(Math.floor(asked), MAX_LIMIT)
    : DEFAULT_LIMIT;

  // FTS5 stores only a rowid, so the base table must be joined back to scope the results
  // to one chat — otherwise a search returns matches from every chat in the database.
  //
  // `snippet(messages_fts, 0, …)`: column index 0 is `content`, which is the only column
  // `messages_fts` has — it is declared `fts5(content, content='messages', …)`.
  //
  // Ordered by `bm25`, so the best match leads rather than the oldest.
  const { results } = await env.DB.prepare(
    `SELECT m.seq AS seq, m.id AS id, m.role AS role, m.speaker AS speaker,
            snippet(messages_fts, 0, '«', '»', '…', ?3) AS snippet
       FROM messages_fts
       JOIN messages m ON m.seq = messages_fts.rowid
      WHERE messages_fts MATCH ?1 AND m.chat_id = ?2
      ORDER BY bm25(messages_fts)
      LIMIT ?4`,
  )
    .bind(match, chatId, SNIPPET_TOKENS, limit)
    .all<SearchHit>();

  return json({ hits: results });
}
