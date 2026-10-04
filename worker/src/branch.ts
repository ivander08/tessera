import type { Role } from '../../src/lib/prompt/types';

/**
 * The conversation tree.
 *
 * A chat is not a list, it is a tree with exactly one visible path through it. Every row
 * carries `parent_id` — the row it was written in response to — and the reader sees the
 * chain that starts at the opening greeting and follows the active alternative at each
 * step.
 *
 * That is what makes regenerating an OLD message behave the way a reader expects. Rolling
 * a new version of the opening does not rewrite the story after it: the new version is an
 * alternative at that position with no continuation yet, so the old continuation is off
 * the path and disappears from the transcript. Swiping back to the old version puts its
 * continuation back on the path, intact, because none of it was ever deleted.
 *
 * ## Invariants
 *
 *  - `seq` still orders creation and is still the sole tie-breaker. Along any path, `seq`
 *    strictly increases, because a row is always written after the row it answers.
 *  - Exactly one row per position is active. The walk follows active children only, so a
 *    deactivated row takes its whole continuation out of the transcript without touching
 *    a single descendant.
 *  - Alternatives at one position share a parent.
 *
 * ## Why the walk is SQL, not a loop over every row
 *
 * The first version of this module loaded EVERY row for the chat and walked the tree in
 * JavaScript. That was fine for a test chat and wrong for a real one: a turn reads the
 * path three times (the prompt, the tail lookup, the API read), so a 600-message chat cost
 * ~1,800 row reads per turn, and a long conversation grows without bound. D1 bills row
 * reads and caps them daily, so the cost was not theoretical — it exhausted the free tier.
 *
 * The recursive CTE below reads exactly the rows on the visible path. Hidden branches cost
 * nothing to have, which is the point of keeping them.
 */

/** A message row, with the columns the walk and the readers need. */
export interface BranchRow {
  seq: number;
  id: string;
  parent_id: string | null;
  role: Role;
  content: string;
  content_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  active: number;
  /** Who wrote this assistant row; null means the chat's own character. */
  speaker: string | null;
  /** The world state as of this turn, as stored JSON, or null. */
  state_json: string | null;
  /**
   * 1 when the reader removed this version. Distinct from `active = 0`, which means "not
   * the current version but still swipable to". A removed row is in neither set.
   */
  deleted: number;
  created_at: number;
}

/**
 * The columns every reader of a message row needs.
 *
 * Exported because the queries that avoid the walk — the sibling list a swipe reads — must
 * return exactly the same shape, or a row that came from one path would be missing fields
 * the other path provides.
 *
 * Used by `loadPath`, `loadAlternatives`, `pathSeqsAfter` and `loadPathTail`; every one of
 * them has to be kept in step when a column is added, and the recursive terms have to
 * qualify each column because the CTE holds the same names.
 */
export const BRANCH_COLUMNS = `seq, id, parent_id, role, content, content_tokens, active,
                               prompt_tokens, completion_tokens, cached_tokens,
                               cost_usd, speaker, state_json, deleted, created_at`;

/**
 * The single-chat walk down the visible path, as a `WITH RECURSIVE` prefix.
 *
 * The recursive step joins on `m.seq = (SELECT MAX(c.seq) …)`, NOT on
 * `m.parent_id = <cte>.id` with `active`/`deleted` in the WHERE. The two are
 * equivalent — the subquery already restricts to this chat, and to active,
 * undeleted children — but only the first plans as a point lookup.
 *
 * Written the second way, the planner drives the step from `messages` and
 * satisfies `chat_id`/`active` from `idx_messages_active`, so every recursion
 * step scans every active row in the chat: O(n²) in conversation length. On a
 * 161-message chat that read 20,435 rows for a 139-row path, and 2.1M rows in
 * six hours in production. With the join below it reads 418. Measured both
 * ways; see `branch.test.ts`.
 *
 * `columns` is the CTE's column list, exactly as the callers need it; `depth`
 * is appended. `?1` is always the chat id.
 */
export function visiblePathCte(name: string, columns: string): string {
  const qualified = columns
    .split(',')
    .map((column) => `m.${column.trim()}`)
    .join(', ');
  return `WITH RECURSIVE ${name}(${columns}, depth) AS (
    SELECT ${columns}, 0
      FROM messages
     WHERE chat_id = ?1
       AND id = (
         SELECT id FROM messages
          WHERE chat_id = ?1 AND parent_id IS NULL AND active = 1 AND deleted = 0
          ORDER BY seq DESC LIMIT 1
       )
    UNION ALL
    SELECT ${qualified}, ${name}.depth + 1
      FROM ${name}
      JOIN messages m ON m.seq = (
        SELECT MAX(c.seq) FROM messages c
         WHERE c.chat_id = ?1 AND c.parent_id = ${name}.id
           AND c.active = 1 AND c.deleted = 0
      )
  )`;
}

/**
 * The visible transcript, walked in the database.
 *
 * Starts at the active root and repeatedly takes the newest active child. `depth` orders
 * the result, because `seq` no longer does once a path can skip a branch — an alternative
 * written later can sit earlier in the conversation.
 *
 * The `MAX(seq)` child is chosen per step rather than joining every active child and
 * sorting afterwards: the invariant is one active child, and this makes the walk terminate
 * on a single row even if the data disagrees.
 *
 * The recursive step is the shared one in `visiblePathCte`; see there for why the join
 * has to be written on `m.seq` rather than `m.parent_id`.
 */
const WALK = `
  ${visiblePathCte('path', BRANCH_COLUMNS)}
  SELECT ${BRANCH_COLUMNS} FROM path ORDER BY depth
`;

export async function loadPath(env: Env, chatId: string): Promise<BranchRow[]> {
  const { results } = await env.DB.prepare(WALK).bind(chatId).all<BranchRow>();
  return results;
}

/**
 * The visible transcript, bounded to `limit` rows, oldest-first.
 *
 * Walks the visible path in the database — the same walk as `WALK` — and returns its
 * newest `limit` rows. `cursor` is the id of the oldest row the caller already holds.
 * Omit it for the newest window; pass `rows[0].id` to page backwards. The cursor row
 * itself is NOT returned again. A cursor that is no longer on the path matches no depth
 * and returns nothing, which is the honest answer: the page it names cannot be reached
 * from the visible transcript.
 */
export async function loadPathTail(
  env: Env,
  chatId: string,
  limit: number,
  cursor?: string | null,
  /**
   * Only rows whose `seq` is below this. Used by a `regenerate`, which must read the target's
   * ANCESTRY: the newest `limit` rows of the path are the end of the story, and filtering
   * those afterwards would leave an early re-roll with no history at all.
   *
   * A plain `seq <` is correct rather than a depth comparison, because a child is always
   * inserted after its parent — so on any single path, seq increases from root to leaf.
   */
  beforeSeq?: number | null,
): Promise<BranchRow[]> {
  // `LIMIT 0` already returns nothing, so this is a contract rather than a correction: a
  // caller asking for no rows gets no rows, and never a walk it did not ask for.
  if (limit <= 0) return [];

  const { results } = await env.DB.prepare(TAIL)
    .bind(chatId, cursor ?? null, limit, beforeSeq ?? null)
    .all<BranchRow>();
  return results;
}

/**
 * The bounded forward walk.
 *
 * Walks DOWN from the active root — the same walk as `WALK` — and keeps the newest `limit`
 * rows of it. The previous version seeded itself on "an active row with no active child"
 * and climbed `parent_id`: that seed matches the leaf of any abandoned continuation, not
 * the end of the visible path, so swiping back to an earlier version returned the turns
 * hanging off the version that was left. Measured on a real chat: the window was the two
 * rows under an inactive reply, and the opening, greeting and first exchange were gone
 * from the screen.
 *
 * The depth bound is applied after the recursion, not inside it. A `LIMIT` inside the
 * recursive term would stop the walk at an arbitrary row rather than at the end of the
 * path, and the cursor is an id on the path — it only means something once every depth is
 * known.
 *
 * The CTE is named `tail_path` rather than `path`: it is the same walk as `WALK`, but a
 * different query, and the callers that inspect statements need to tell them apart.
 */
const TAIL = `
  ${visiblePathCte('tail_path', BRANCH_COLUMNS)}
  SELECT ${BRANCH_COLUMNS} FROM (
    SELECT ${BRANCH_COLUMNS}, depth FROM tail_path
     WHERE (?2 IS NULL OR depth < (SELECT depth FROM tail_path p2 WHERE p2.id = ?2))
       AND (?4 IS NULL OR seq < ?4)
     ORDER BY depth DESC
     LIMIT ?3
  )
  ORDER BY depth
`;

/**
 * The other versions of each position on the path.
 *
 * Only the positions actually on screen are asked about, so a chat with a hundred
 * abandoned branches costs the same as one with none. Returns them grouped by the parent
 * they answer, which is what a position is.
 */
export async function loadAlternatives(
  env: Env,
  chatId: string,
  parentIds: Array<string | null>,
): Promise<Map<string, BranchRow[]>> {
  const grouped = new Map<string, BranchRow[]>();
  // The opening's position is `parent_id IS NULL`, which `IN (...)` cannot express — and
  // it matters: regenerating the greeting is the first thing a reader does. Dropping it
  // would leave the opening with no alternatives, so swiping it would show no arrows.
  const wantsRoot = parentIds.some((id) => id === null);
  const ids = parentIds.filter((id): id is string => typeof id === 'string');
  if (!wantsRoot && ids.length === 0) return grouped;

  // D1 caps a statement at 100 bound parameters, and one of them is the chat id. A chat
  // long enough to exceed that is exactly the chat this query exists to keep cheap, so
  // the ids are chunked rather than assumed to fit. 90 leaves room for the chat id and
  // for the query to grow a parameter without silently breaking on the boundary.
  const CHUNK = 90;
  const statements = [];
  for (let start = 0; start < ids.length; start += CHUNK) {
    const slice = ids.slice(start, start + CHUNK);
    const placeholders = slice.map((_, index) => `?${index + 2}`).join(', ');
    // One parenthesised disjunction, not two clauses joined by OR. `a AND b OR c` parses
    // as `(a AND b) OR c`, which would drop the chat filter for the root case and return
    // every chat's openings.
    //
    // The root clause rides only on the FIRST chunk. Repeating it would return the
    // opening once per chunk, and the caller reads the list as "every version of this
    // position" — so a duplicated opening becomes duplicate swipe entries.
    const withRoot = wantsRoot && start === 0;
    const match = `parent_id IN (${placeholders})${withRoot ? ' OR parent_id IS NULL' : ''}`;

    statements.push(
      env.DB.prepare(
        `SELECT ${BRANCH_COLUMNS} FROM messages
          WHERE chat_id = ?1 AND deleted = 0 AND (${match})
          ORDER BY seq`,
      ).bind(chatId, ...slice),
    );
  }

  // The root case must run even when there are no ids at all, which the loop above cannot
  // produce.
  if (statements.length === 0) {
    statements.push(
      env.DB.prepare(
        `SELECT ${BRANCH_COLUMNS} FROM messages
          WHERE chat_id = ?1 AND deleted = 0 AND parent_id IS NULL
          ORDER BY seq`,
      ).bind(chatId),
    );
  }

  // One round trip for all of them, so chunking costs latency only when it has to.
  const batches = await env.DB.batch<BranchRow>(statements);
  for (const result of batches) {
    for (const row of result.results ?? []) {
      const key = row.parent_id ?? '';
      const list = grouped.get(key);
      if (list) list.push(row);
      else grouped.set(key, [row]);
    }
  }
  return grouped;
}

/**
 * The row a new message written right now would answer: the end of the visible path.
 *
 * Delegates to the same bounded walk the transcript uses. The previous version picked the
 * newest active row with no active child, which is the leaf of an abandoned continuation as
 * often as it is the tail — on a real chat it returned a row that the walk could not reach,
 * so a `send` wrote the reader's message and its reply to a parent the transcript never
 * visits. Both rows were persisted and neither was ever visible again.
 */
export async function tailId(env: Env, chatId: string): Promise<string | null> {
  const rows = await loadPathTail(env, chatId, 1);
  return rows[rows.length - 1]?.id ?? null;
}

/**
 * The `seq` of the visible messages written after `afterSeq`, in transcript order.
 *
 * This is the summarizer's input: which messages a new summary should cover. It returns
 * seqs and nothing else, so deciding a range does not drag every message body across the
 * wire.
 *
 * ## What this replaced, and why it mattered
 *
 * The previous version computed a message's "position" with a correlated subquery over a
 * `swipe_group` column that no code has written since branching replaced it — so the
 * subquery evaluated `COALESCE(NULL, id) = COALESCE(NULL, id)` for every row and returned
 * the row's own `seq`. It was an O(n²) scan to compute a column that was already there.
 *
 * It ran after EVERY turn, so the cost grew with the square of the conversation. On a
 * 600-message chat it read 776,000 rows in three calls and exhausted D1's free-tier daily
 * allowance, which took the whole site down. The walk below is O(path) instead, and it is
 * also the only way to get the answer RIGHT: a row can be active while sitting on an
 * abandoned branch, and a plain `seq > ?` scan would summarize text the reader cannot see.
 */
export async function pathSeqsAfter(
  env: Env,
  chatId: string,
  afterSeq: number,
  limit: number,
): Promise<number[]> {
  const { results } = await env.DB.prepare(PATH_SEQS_AFTER)
    .bind(chatId, afterSeq, limit)
    .all<{ seq: number }>();
  return results.map((row) => row.seq);
}

/**
 * The visible path, as seqs only, for callers that need to test membership.
 *
 * A `WITH RECURSIVE` prefix rather than a complete query, so a caller can append its own
 * `SELECT`. It exists because "is this seq still in the scene?" is asked from two places
 * that have nothing else in common — the summary reader and full-text recall — and a third
 * copy of a fifteen-line walk is how one of them silently drifts.
 *
 * `seq` is the only column: the callers join against it, and dragging message bodies
 * through a recursive CTE to answer a yes/no question would cost the read it is meant to
 * save.
 */
export const VISIBLE_PATH_SEQ_CTE = visiblePathCte('path', 'seq, id');

/** The same walk as `WALK`, narrowed to the seqs a summary still needs to cover. */
const PATH_SEQS_AFTER = `
  ${visiblePathCte('path', 'seq, id')}
  SELECT seq FROM path WHERE seq > ?2 ORDER BY depth LIMIT ?3
`;

/**
 * The visible transcript: the active chain from the opening greeting to its end.
 *
 * Pure, so the walk can be tested without a database. It takes rows in any order — used
 * by the tests and by any caller that already has the rows in hand.
 */
export function walkPath(rows: BranchRow[]): BranchRow[] {
  const byParent = new Map<string | null, BranchRow[]>();
  for (const row of rows) {
    const key = row.parent_id ?? null;
    const list = byParent.get(key);
    if (list) list.push(row);
    else byParent.set(key, [row]);
  }

  const path: BranchRow[] = [];
  // Guards against a cycle, which a bad backfill could in principle create. Without it
  // the walk would spin forever inside a request.
  const seen = new Set<string>();
  let current: string | null = null;

  for (;;) {
    const children: BranchRow[] = byParent.get(current) ?? [];
    const candidates: BranchRow[] = children.filter(
      (row: BranchRow) => row.active === 1 && row.deleted !== 1,
    );
    if (candidates.length === 0) break;

    // One active child is the invariant. If data ever disagrees, the newest wins — it is
    // the one the reader produced last, and the walk must still terminate on one row.
    let next: BranchRow = candidates[0];
    for (const row of candidates) if (row.seq > next.seq) next = row;

    if (seen.has(next.id)) break;
    seen.add(next.id);
    path.push(next);
    current = next.id;
  }

  return path;
}
