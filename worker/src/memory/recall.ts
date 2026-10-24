import { buildMatchQuery, matchTerms } from './fts';
import { VISIBLE_PATH_SEQ_CTE } from '../branch';
import { factIsTrueSql } from './facts';
import { summaryDateSpan } from '../../../src/lib/prompt/memoryBlock';

export type { RecallHit, RecallKind } from '../../../src/lib/memoryTypes';
import type { RecallHit } from '../../../src/lib/memoryTypes';

interface FtsRow {
  score: number;
  text: string;
  ref_id: string;
  /** The in-world clock reading recorded beside the row, or null. */
  at: string | null;
}

interface FactFtsRow extends FtsRow {
  kind: string;
}

interface SummaryFtsRow extends FtsRow {
  covers_to: number;
  covers_date_from: string | null;
  covers_date_to: string | null;
}

interface PinnedRow {
  id: string;
  text: string;
  at: string | null;
  kind: string;
}

/**
 * How many pinned facts are injected regardless of the query.
 *
 * A bound exists because pinning has no natural limit and the block budget trims facts
 * last, so an unbounded pin set produced a block that could not be shrunk to fit. Twenty is
 * generous for "things the narrator must not forget" and small enough to leave the rest of
 * the tail for the scene.
 */
const MAX_PINNED = 20;

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
 * bounds only the ranked matches, and `MAX_PINNED` bounds the pins themselves.
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

  // The summary read cannot use FTS — `summaries` has no index and does not need one for a
  // handful of rows — so it gets the same terms as LIKE patterns instead. They come from
  // the same tokenizer the other two sources use, so all three agree on what the query
  // means.
  const terms = matchTerms(query).map(likeTerm);
  const termCount = terms.length;

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
              m.content AS text, m.id AS ref_id,
              json_extract(m.state_json, '$.time') AS at
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
      //
      // The provenance bounds are what stop a fact outliving the turn that produced it.
      // A fact recorded at turn 9 is not true at turn 3, and if turn 9 is regenerated away
      // it is not true at all — injecting it anyway writes a scene where an event that
      // never happened has already happened. `learned_at_seq = 0` is a fact with no
      // recorded origin (a backfilled row, or a manually added one) and stays visible.
      //
      // Events are NOT filtered out here. They are the same table and the same index, and
      // they are exactly what a "when did that happen" query is looking for, so excluding
      // them would remove the hits the reader most wants. The discriminator rides back on
      // the row and the caller splits the two lists.
      `${VISIBLE_PATH_SEQ_CTE}
       SELECT facts_fts.rowid AS rowid, bm25(facts_fts) AS score,
              f.text AS text, f.id AS ref_id, f.at AS at, f.kind AS kind
         FROM facts_fts
         JOIN facts f ON f.rowid = facts_fts.rowid
        WHERE facts_fts MATCH ?2 AND f.chat_id = ?1 AND f.deleted = 0
          AND ${factIsTrueSql('f', '?4')}
        ORDER BY score
        LIMIT ?3`,
    )
      .bind(chatId, match, limit, beforeSeq)
      .all<FactFtsRow>(),

    env.DB.prepare(
      // Same two bounds as the prompt's summary read: not from a later turn, and its range
      // still on the visible path. See the note in `buildMemoryBlock`.
      //
      // The date span is read from the row rather than from the prose: it is the clock
      // reading that was actually recorded for the covered range, so it stays right even
      // when the summariser omits a date from its text.
      //
      // Matching is per TERM, ORed, not `content LIKE '%<whole message>%'`. The verbatim
      // version asked for the reader's entire sentence to appear inside a summary — which
      // a summary by construction never contains, since its whole job is to rephrase. It
      // also silently truncated at 48 bytes (D1's LIKE cap), so a long message searched
      // for its first clause and nothing else. Measured on a real chat: a message about the
      // register of deeds and key 417 matched no summary, while a summary containing both
      // words existed. `likePatterns` returns one bound parameter per term.
      `${VISIBLE_PATH_SEQ_CTE}
       SELECT id AS ref_id, content AS text, covers_to, covers_date_from, covers_date_to
         FROM summaries
        WHERE chat_id = ?1 AND deleted = 0 AND (${summaryTermClauses(termCount)})
          AND (?${termCount + 2} IS NULL OR covers_to < ?${termCount + 2})
          AND EXISTS (SELECT 1 FROM path WHERE path.seq = summaries.covers_to)
        ORDER BY covers_to DESC
        LIMIT ?${termCount + 3}`,
    )
      .bind(chatId, ...terms, beforeSeq, limit)
      .all<SummaryFtsRow>(),

    env.DB.prepare(
      // Pinning overrides RANKING, never status or provenance: a pinned fact that has since
      // been superseded is still superseded, and a pinned fact recorded at turn 5 is still
      // not true at turn 4.
      //
      // Bounded, because "pinned" means "always include" and there is no upper limit on how
      // many a reader can pin. Unbounded, a large pin set made the rendered block exceed its
      // own token budget: facts are trimmed LAST (see `renderMemoryBlock`), so the loop that
      // shrinks the block had nothing left to give and returned an oversized tail — recalled
      // memory crowding out the scene it was supposed to help write. Newest first, so the
      // most recent intentions survive the cap.
      `${VISIBLE_PATH_SEQ_CTE}
       SELECT id, text, at, kind FROM facts
        WHERE chat_id = ?1 AND pinned = 1 AND deleted = 0
          AND ${factIsTrueSql('facts', '?2')}
        ORDER BY created_at DESC
        LIMIT ?3`,
    )
      .bind(chatId, beforeSeq, MAX_PINNED)
      .all<PinnedRow>(),
  ]);

  // bm25 is NOT comparable across tables: it is computed over the rows of one index, with
  // that index's own document count and average length. Measured on a real chat, the same
  // query scored messages -12 to -17 and facts -4 to -9, so sorting the merged list by raw
  // score put every message ahead of every fact — the "Established facts" section could
  // never render, and the narrator answered from raw transcript instead of the distilled
  // statement the subsystem exists to provide. `rankScores` maps each source's own ordering
  // onto a shared scale, so the merge compares rank within a source rather than a number
  // that only means something inside one index.
  const matched: RecallHit[] = rankScores([
    ...messages.results.map((row) => ({
      kind: 'message' as const,
      refId: row.ref_id,
      text: row.text,
      score: row.score,
      // The clock recorded BESIDE this turn, not a claim the message makes. It is what lets
      // a recalled moment be placed in the story — "when did we first meet" is answered by
      // the transcript as much as by the extracted events, and the reading was on disk and
      // unread until now.
      at: row.at,
    })),
    ...facts.results.map((row) => ({
      kind: row.kind === 'event' ? ('event' as const) : ('fact' as const),
      refId: row.ref_id,
      text: row.text,
      score: row.score,
      at: row.at,
    })),
    // A LIKE hit is a weaker signal than a bm25 hit, so it scores 0 and sorts last.
    ...summaries.results.map((row) => ({
      kind: 'summary' as const,
      refId: row.ref_id,
      text: row.text,
      score: 0,
      at: summaryDateSpan(row.covers_date_from, row.covers_date_to),
    })),
  ]);

  const seen = new Set<string>();
  const out: RecallHit[] = [];
  for (const row of pinned.results) {
    seen.add(`fact:${row.id}`);
    out.push({
      kind: row.kind === 'event' ? 'event' : 'fact',
      refId: row.id,
      text: row.text,
      score: 0,
      at: row.at,
    });
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
 * Merge hits from several bm25 indexes onto one comparable scale, best-first.
 *
 * Each source arrives already sorted best-first by its own `bm25`, and those numbers are
 * only meaningful inside the index that produced them: document count and average document
 * length are per-index, so a fact index and a message index produce disjoint score ranges
 * for the same query. Sorting a merged list by the raw numbers is therefore not a ranking,
 * it is a comparison of units — measured on a real chat, messages scored -12..-17 and facts
 * -4..-9 for the same query, so facts sorted behind every message and never reached the
 * prompt.
 *
 * Normalising by RANK WITHIN the source is what makes the merge honest. A hit that is the
 * best match in its own source scores the same as the best match in any other, so the
 * strongest fact competes with the strongest message rather than losing to a mediocre one.
 * A source that returned nothing contributes nothing, and a single-hit source is not
 * unfairly promoted: with one hit, rank 0 of 1 is still the best available.
 *
 * Summaries are the exception and are handled by the caller: a LIKE match is not a bm25
 * rank at all, so it is pinned to the worst score and sorts last regardless.
 */
function rankScores(hits: RecallHit[]): RecallHit[] {
  const bySource = new Map<string, RecallHit[]>();
  for (const hit of hits) {
    const list = bySource.get(hit.kind);
    if (list) list.push(hit);
    else bySource.set(hit.kind, [hit]);
  }

  const ranked: RecallHit[] = [];
  for (const [kind, list] of bySource) {
    // Already best-first from SQL; sorted here so the contract does not depend on it.
    const ordered = [...list].sort((a, b) => a.score - b.score);
    ordered.forEach((hit, index) => {
      // 0 for the best, approaching 1 for the worst — the same direction as bm25, where a
      // lower number is a better match.
      ranked.push({
        ...hit,
        score: kind === 'summary' ? 1 : ordered.length > 1 ? index / (ordered.length - 1) : 0,
      });
    });
  }
  return ranked.sort((a, b) => a.score - b.score);
}

/**
 * One LIKE pattern for one term.
 *
 * D1 caps a LIKE/GLOB pattern at 50 bytes, so the wildcards and escapes are counted and
 * the term is truncated to fit without splitting a multi-byte character. A term is a word,
 * so this only bites on pathological input — the previous version truncated the READER'S
 * WHOLE MESSAGE to 48 bytes, which is why a long question searched for its first clause
 * and silently found nothing.
 */
function likeTerm(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (char) => `\\${char}`);
  const encoder = new TextEncoder();
  let bytes = 2; // the two `%` wildcards
  let out = '';
  for (const char of escaped) {
    const size = encoder.encode(char).length;
    if (bytes + size > 48) break;
    bytes += size;
    out += char;
  }
  return `%${out}%`;
}

/**
 * `(?n LIKE ?n AND ?n LIKE ?n …)` for `count` terms, ORed.
 *
 * Built rather than written because the number of terms varies with the query. Each term
 * is one bound parameter, so the caller binds chat id, then the terms, then the remaining
 * arguments — see the numbering in the summary query.
 */
function summaryTermClauses(count: number): string {
  const clauses: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // `?1` is the chat id, so the patterns start at `?2`.
    clauses.push(`content LIKE ?${index + 2} ESCAPE '\\'`);
  }
  return clauses.join(' OR ');
}
