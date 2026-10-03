import { buildMatchQuery } from './fts';
import { VISIBLE_PATH_SEQ_CTE } from '../branch';

export type { RecallHit, RecallKind } from '../../../src/lib/memoryTypes';
import type { RecallHit } from '../../../src/lib/memoryTypes';

interface FtsRow {
  score: number;
  text: string;
  ref_id: string;
}

interface PinnedRow {
  id: string;
  text: string;
}

/**
 * Full-text recall over a chat's own history.
 *
 * Results are RETURNED, never applied. The caller renders them into the prompt TAIL.
 * Splicing a recalled message back into the history array would rewrite the cached
 * prefix and cost every subsequent turn its cache — which is the one thing this
 * project exists to avoid.
 *
 * Three sources, deliberately ranked the same way so they can be merged:
 *   - `messages_fts` — bm25 over every message in the chat.
 *   - `facts_fts`    — bm25 over extracted facts.
 *   - `summaries`    — plain LIKE. Summaries are a handful of rows per chat, so an
 *                      index would cost writes for no benefit; bm25 on a table that
 *                      small is noise anyway.
 *
 * Pinned facts lead the result unconditionally: that is what pinning means. `limit`
 * bounds only the ranked matches.
 *
 * `beforeSeq` bounds the two SOURCED sources — message hits and summary hits — to the part
 * of the story that already happened at that point. A regenerate re-rolls an earlier turn,
 * and without this a summary covering a later turn is recalled and injected, telling the
 * model how the scene turned out. `null` means "now", which is what every forward turn
 * passes and is the behaviour that predates this parameter.
 *
 * Facts are deliberately NOT bounded: a fact is a timeless statement about the world
 * ("Ink has drawn the coast for eleven years"), not an event at a position in the
 * transcript, and it carries no seq to bound by. Bounding them would be meaningless rather
 * than conservative.
 */
export async function recall(
  env: Env,
  chatId: string,
  query: string,
  limit: number,
  beforeSeq: number | null = null,
): Promise<RecallHit[]> {
  const match = buildMatchQuery(query);
  // `MATCH ''` is an fts5 syntax error, not an empty result. An empty query also has
  // nothing to rank against, so pinned facts are not returned either.
  if (match.length === 0 || limit <= 0) return [];

  const [messages, facts, summaries, pinned] = await Promise.all([
    env.DB.prepare(
      // FTS5 stores only a rowid, so the base table must be joined back to filter by
      // chat — otherwise recall returns matches from every chat in the database.
      //
      // The path join is what keeps a recalled message on the VISIBLE transcript: a
      // regenerated-away or deleted version is still in `messages` and still in the FTS
      // index, so without it recall quotes text the reader removed.
      `${VISIBLE_PATH_SEQ_CTE}
       SELECT messages_fts.rowid AS rowid, bm25(messages_fts) AS score,
              m.content AS text, m.id AS ref_id
         FROM messages_fts
         JOIN messages m ON m.seq = messages_fts.rowid
         JOIN path ON path.seq = m.seq
        WHERE messages_fts MATCH ?2 AND m.chat_id = ?1
          AND (?4 IS NULL OR m.seq < ?4)
        ORDER BY score
        LIMIT ?3`,
    )
      .bind(chatId, match, limit, beforeSeq)
      .all<FtsRow>(),

    env.DB.prepare(
      // `status = 'active'` is required, not incidental: the caller renders fact hits
      // under "Established facts". A superseded fact is one the story has moved past,
      // so recalling it would state something the narrative has already contradicted.
      `SELECT facts_fts.rowid AS rowid, bm25(facts_fts) AS score,
              f.text AS text, f.id AS ref_id
         FROM facts_fts
         JOIN facts f ON f.rowid = facts_fts.rowid
        WHERE facts_fts MATCH ? AND f.chat_id = ? AND f.status = 'active'
        ORDER BY score
        LIMIT ?`,
    )
      .bind(match, chatId, limit)
      .all<FtsRow>(),

    env.DB.prepare(
      // Same two bounds as the prompt's summary read: not from a later turn, and its range
      // still on the visible path. See the note in `buildMemoryBlock`.
      `${VISIBLE_PATH_SEQ_CTE}
       SELECT id AS ref_id, content AS text, covers_to
         FROM summaries
        WHERE chat_id = ?1 AND content LIKE ?2 ESCAPE '\\'
          AND (?4 IS NULL OR covers_to < ?4)
          AND EXISTS (SELECT 1 FROM path WHERE path.seq = summaries.covers_to)
        ORDER BY covers_to DESC
        LIMIT ?3`,
    )
      .bind(chatId, likePattern(query), limit, beforeSeq)
      .all<FtsRow>(),

    env.DB.prepare(
      // Pinning overrides RANKING, never status: a pinned fact that has since been
      // superseded is still superseded, and must not be presented as established.
      `SELECT id, text FROM facts
        WHERE chat_id = ? AND pinned = 1 AND status = 'active'
        ORDER BY created_at`,
    )
      .bind(chatId)
      .all<PinnedRow>(),
  ]);

  const matched: RecallHit[] = [
    ...messages.results.map((row) => ({
      kind: 'message' as const,
      refId: row.ref_id,
      text: row.text,
      score: row.score,
    })),
    ...facts.results.map((row) => ({
      kind: 'fact' as const,
      refId: row.ref_id,
      text: row.text,
      score: row.score,
    })),
    // A LIKE hit is a weaker signal than a bm25 hit, so it scores 0 and sorts last.
    ...summaries.results.map((row) => ({
      kind: 'summary' as const,
      refId: row.ref_id,
      text: row.text,
      score: 0,
    })),
  ].sort((a, b) => a.score - b.score);

  const seen = new Set<string>();
  const out: RecallHit[] = [];
  for (const row of pinned.results) {
    seen.add(`fact:${row.id}`);
    out.push({ kind: 'fact', refId: row.id, text: row.text, score: 0 });
  }
  for (const entry of matched) {
    if (out.length >= limit + pinned.results.length) break;
    if (seen.has(`${entry.kind}:${entry.refId}`)) continue;
    seen.add(`${entry.kind}:${entry.refId}`);
    out.push(entry);
  }
  return out;
}

/**
 * D1 caps a LIKE/GLOB pattern at 50 bytes. Escape the wildcards so a query containing
 * `%` or `_` matches literally, then truncate to fit the cap without splitting a
 * multi-byte character.
 */
function likePattern(query: string): string {
  const escaped = query.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  const encoder = new TextEncoder();
  let bytes = 0;
  let out = '';
  for (const char of `%${escaped}%`) {
    const size = encoder.encode(char).length;
    if (bytes + size > 48) break;
    bytes += size;
    out += char;
  }
  return out;
}
