/**
 * What "this fact is true right now" means, as SQL.
 *
 * Two independent conditions, and a fact must satisfy both:
 *
 *  1. **Not superseded** — or superseded by a turn that no longer exists. `extractFacts`
 *     sets `status = 'superseded'` when a later turn replaces a fact, and nothing ever sets
 *     it back. That write was one-way, so a turn that superseded a fact and then left the
 *     transcript (regenerated away, or deleted) kept the fact suppressed forever. Reading
 *     the supersession against the visible path makes the write reversible: when the
 *     superseding turn is off-path, the supersession is ignored and the fact is active
 *     again, exactly as it was before that turn ran.
 *
 *  2. **Learned at a point that exists and has happened** — the `learned_at_seq` rule from
 *     0014. A fact recorded at turn 9 is not true at turn 3, and is not true at all if turn
 *     9 is off-path.
 *
 * `0` in either column means "not attributable to a turn": a backfilled row, or a fact the
 * reader added by hand. It is always visible, because there is no turn to resolve it
 * against and hiding it would delete the reader's existing memories to satisfy a rule
 * written after they were made.
 *
 * Written once and shared, because the prompt and the memory viewer must not disagree about
 * the same row — a viewer that reports "superseded" for a fact the narrator is being given
 * makes the panel lie about the prompt.
 *
 * `seqParam` is the caller's placeholder for the cut point (`null` = "now"), and `alias` is
 * the facts table's alias in that query. Requires a `path(seq, ...)` CTE in scope, which
 * `VISIBLE_PATH_SEQ_CTE` provides.
 */
export function factIsTrueSql(alias: string, seqParam: string): string {
  return `(
    ${alias}.status = 'active'
    OR (
      ${alias}.status = 'superseded'
      AND ${alias}.superseded_at_seq != 0
      AND NOT EXISTS (SELECT 1 FROM path WHERE path.seq = ${alias}.superseded_at_seq)
    )
  )
  AND (
    ${alias}.learned_at_seq = 0
    OR (
      (${seqParam} IS NULL OR ${alias}.learned_at_seq < ${seqParam})
      AND EXISTS (SELECT 1 FROM path WHERE path.seq = ${alias}.learned_at_seq)
    )
  )`;
}

/**
 * The status a fact has right now, as SQL — for the memory viewer, which reads every fact
 * including superseded ones and must report the status the narrator is actually acting on.
 *
 * The same rule as `factIsTrueSql`'s first half, as a value rather than a filter.
 */
export function factStatusSql(alias: string): string {
  return `CASE
    WHEN ${alias}.status != 'superseded' THEN ${alias}.status
    WHEN ${alias}.superseded_at_seq = 0 THEN 'superseded'
    WHEN EXISTS (SELECT 1 FROM path WHERE path.seq = ${alias}.superseded_at_seq) THEN 'superseded'
    ELSE 'active'
  END`;
}
