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
  swipe_group: string | null;
  /** Who wrote this assistant row; null means the chat's own character. */
  speaker: string | null;
  /** The world state as of this turn, as stored JSON, or null. */
  state_json: string | null;
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
                               swipe_group, prompt_tokens, completion_tokens, cached_tokens,
                               cost_usd, speaker, state_json, created_at`;

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
 */
const WALK = `
  WITH RECURSIVE path(${BRANCH_COLUMNS}, depth) AS (
    SELECT ${BRANCH_COLUMNS}, 0
      FROM messages
     WHERE chat_id = ?1
       AND id = (
         SELECT id FROM messages
          WHERE chat_id = ?1 AND parent_id IS NULL AND active = 1
          ORDER BY seq DESC LIMIT 1
       )
    UNION ALL
    SELECT ${BRANCH_COLUMNS.split(',').map((column) => `m.${column.trim()}`).join(', ')}, path.depth + 1
      FROM path
      JOIN messages m ON m.parent_id = path.id
     WHERE m.chat_id = ?1
       AND m.active = 1
       AND m.seq = (
         SELECT MAX(c.seq) FROM messages c
          WHERE c.chat_id = ?1 AND c.parent_id = path.id AND c.active = 1
       )
  )
  SELECT ${BRANCH_COLUMNS} FROM path ORDER BY depth
`;

export async function loadPath(env: Env, chatId: string): Promise<BranchRow[]> {
  const { results } = await env.DB.prepare(WALK).bind(chatId).all<BranchRow>();
  return results;
}

/**
 * The visible transcript, bounded to `limit` rows, oldest-first.
 *
 * Walks UP from the end of the path rather than down from the opening. A forward walk
 * cannot be bounded by a LIMIT: the recursion runs to completion before the LIMIT is
 * applied, so cost grows with the whole conversation. Starting at the tail and climbing
 * stops as soon as the count is reached.
 *
 * `cursor` is the id of the oldest row the caller already holds. Omit it for the newest
 * window; pass `rows[0].id` to page backwards. The cursor row itself is NOT returned
 * again — the walk starts at its parent.
 */
export async function loadPathTail(
  env: Env,
  chatId: string,
  limit: number,
  cursor?: string | null,
): Promise<BranchRow[]> {
  // The SQL alone returns one row for `limit 0` — the seed always produces a row and the
  // recursive term is what is bounded — so the empty case has to be handled here.
  if (limit <= 0) return [];

  const { results } = await env.DB.prepare(TAIL)
    .bind(chatId, cursor ?? null, limit)
    .all<BranchRow>();
  return results;
}

/**
 * The bounded backward walk.
 *
 * Three details are load-bearing, each found by getting it wrong:
 *
 *  1. The seed's `ORDER BY`/`LIMIT` must be wrapped in a subquery — SQLite rejects
 *     `ORDER BY` before `UNION ALL`.
 *  2. The seed anchors on an ID, not a seq. `m.seq < ?2` would only ever find a row with
 *     no active child, which is true of the tail and false of every mid-path row, so
 *     paging backwards returned nothing. With a cursor the seed resolves the cursor's
 *     parent instead, which is the next row up the path.
 *  3. Every column in the recursive term is qualified with `p.`, because `up` holds the
 *     same names. `SELECT *` there would pick up `n` from the wrong side.
 */
const TAIL = `
  WITH RECURSIVE up(${BRANCH_COLUMNS}, n) AS (
    SELECT * FROM (
      SELECT ${BRANCH_COLUMNS}, 0 AS n
        FROM messages m
       WHERE m.chat_id = ?1 AND m.active = 1
         AND (
           (?2 IS NULL AND NOT EXISTS (
              SELECT 1 FROM messages c
               WHERE c.parent_id = m.id AND c.chat_id = ?1 AND c.active = 1))
           OR
           (?2 IS NOT NULL AND m.id = (
              SELECT p.parent_id FROM messages p WHERE p.id = ?2 AND p.chat_id = ?1))
         )
       ORDER BY m.seq DESC LIMIT 1
    )
    UNION ALL
    SELECT p.seq, p.id, p.parent_id, p.role, p.content, p.content_tokens, p.active,
           p.swipe_group, p.prompt_tokens, p.completion_tokens, p.cached_tokens,
           p.cost_usd, p.speaker, p.state_json, p.created_at, up.n + 1
      FROM up JOIN messages p ON p.id = up.parent_id
     WHERE p.chat_id = ?1 AND p.active = 1 AND up.n + 1 < ?3
  )
  SELECT ${BRANCH_COLUMNS} FROM up ORDER BY n DESC
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
          WHERE chat_id = ?1 AND (${match})
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
          WHERE chat_id = ?1 AND parent_id IS NULL
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
 * A row with no active child. One query rather than a walk — the tail is the only position
 * that has nothing after it, which is a property of the row itself.
 */
export async function tailId(env: Env, chatId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT m.id FROM messages m
      WHERE m.chat_id = ?1
        AND m.active = 1
        AND NOT EXISTS (
          SELECT 1 FROM messages c
           WHERE c.chat_id = m.chat_id AND c.parent_id = m.id AND c.active = 1
        )
      ORDER BY m.seq DESC LIMIT 1`,
  )
    .bind(chatId)
    .first<{ id: string }>();
  return row?.id ?? null;
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

/** The same walk as `WALK`, narrowed to the seqs a summary still needs to cover. */
const PATH_SEQS_AFTER = `
  WITH RECURSIVE path(seq, id, depth) AS (
    SELECT seq, id, 0
      FROM messages
     WHERE chat_id = ?1
       AND id = (
         SELECT id FROM messages
          WHERE chat_id = ?1 AND parent_id IS NULL AND active = 1
          ORDER BY seq DESC LIMIT 1
       )
    UNION ALL
    SELECT m.seq, m.id, path.depth + 1
      FROM path
      JOIN messages m ON m.parent_id = path.id
     WHERE m.chat_id = ?1
       AND m.active = 1
       AND m.seq = (
         SELECT MAX(c.seq) FROM messages c
          WHERE c.chat_id = ?1 AND c.parent_id = path.id AND c.active = 1
       )
  )
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
    const candidates: BranchRow[] = children.filter((row: BranchRow) => row.active === 1);
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
