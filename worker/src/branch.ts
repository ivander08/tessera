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
 * The alternative — splicing out and rewriting the rows that followed — would destroy
 * text the reader may still want, and would make an accidental regenerate unrecoverable.
 * Append-only costs nothing here: the hidden branch is a few hundred bytes of text, and
 * every row stays swipable.
 *
 * ## Invariants
 *
 *  - `seq` still orders creation and is still the sole tie-breaker. Along any path, `seq`
 *    strictly increases, because a row is always written after the row it answers.
 *  - Exactly one row per position is active. The walk follows active children only, so a
 *    deactivated row takes its whole continuation out of the transcript without touching
 *    a single descendant.
 *  - Alternatives at one position share a parent. Regenerating and swiping therefore move
 *    within a position rather than creating a new one.
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
  created_at: number;
}

const COLUMNS = `seq, id, parent_id, role, content, content_tokens, active, swipe_group,
                  prompt_tokens, completion_tokens, cached_tokens, cost_usd, created_at`;

/** Every row for one chat, active or not, in creation order. */
export async function loadBranchRows(env: Env, chatId: string): Promise<BranchRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM messages WHERE chat_id = ? ORDER BY seq`,
  )
    .bind(chatId)
    .all<BranchRow>();
  return results;
}

/**
 * The visible transcript: the active chain from the opening greeting to its end.
 *
 * Pure, so the walk can be tested without a database. It takes rows in any order.
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

/** The visible transcript, loaded and walked in one step. */
export async function loadPath(env: Env, chatId: string): Promise<BranchRow[]> {
  return walkPath(await loadBranchRows(env, chatId));
}

/**
 * The row a new message written right now would answer: the end of the visible path.
 *
 * Null for an empty chat, which is what the opening greeting is parented to.
 */
export async function tailId(env: Env, chatId: string): Promise<string | null> {
  const path = await loadPath(env, chatId);
  return path.length > 0 ? path[path.length - 1].id : null;
}
