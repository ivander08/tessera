import type { GuardViolation } from '../../../src/lib/prose/guard';

/**
 * The prose guard's persisted state.
 *
 * The state lives on the original reply (`messages.prose_status`, migration 0020), not on
 * the repaired sibling. The original is what was inspected, what stays on screen in auto
 * mode, and what a retry re-runs — so it is also the row a claim locks.
 *
 * The claim is the guard's only concurrency control. Auto runs behind `waitUntil` while
 * the reader may be pressing Fix on the same row; both go through `claimProse`, and only
 * one wins. A `repairing` row whose worker was evicted is claimable again after
 * `STALE_AFTER_MS`, which is what stops a dead isolate from leaving a permanent spinner.
 */

export type ProseStatus = 'clean' | 'issues' | 'queued' | 'repairing' | 'done' | 'failed';

export interface ProseState {
  status: ProseStatus;
  violations: GuardViolation[];
  error: string | null;
}

/** How long a `repairing` claim is trusted before another caller may take it. */
export const STALE_AFTER_MS = 120_000;

export async function setProseStatus(
  env: Env,
  messageId: string,
  status: ProseStatus,
  violations: GuardViolation[],
  error: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE messages
        SET prose_status = ?, prose_violations = ?, prose_error = ?, prose_updated_at = ?
      WHERE id = ?`,
  )
    .bind(status, JSON.stringify(violations), error, Date.now(), messageId)
    .run();
}

/** Forgets the guard's state. Used when the reply changed under a running repair. */
export async function clearProseStatus(env: Env, messageId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE messages
        SET prose_status = NULL, prose_violations = NULL, prose_error = NULL,
            prose_updated_at = NULL
      WHERE id = ?`,
  )
    .bind(messageId)
    .run();
}

/**
 * Takes the row for one repair, atomically. Returns false when another caller got it.
 *
 * `from` is the set of states this caller may claim. `null` means "never inspected",
 * which the Fix button must still accept: the guard shipped after the chats it runs on.
 * A stale `repairing` claim is always allowed through, whatever `from` says, and so is a
 * stale `queued` one — that is what an evicted auto worker leaves behind.
 */
export async function claimProse(
  env: Env,
  messageId: string,
  from: Array<ProseStatus | null>,
  staleMs = STALE_AFTER_MS,
): Promise<boolean> {
  const statuses = from.filter((status): status is ProseStatus => status !== null);
  const allowUninspected = from.includes(null);
  const params: unknown[] = [Date.now(), messageId];
  const clauses: string[] = [];

  if (statuses.length > 0) {
    const placeholders = statuses.map((_, index) => `?${params.length + 1 + index}`);
    for (const status of statuses) params.push(status);
    clauses.push(`prose_status IN (${placeholders.join(', ')})`);
  }
  if (allowUninspected) clauses.push('prose_status IS NULL');

  const staleParam = `?${params.length + 1}`;
  params.push(Date.now() - staleMs);
  clauses.push(
    `(prose_status = 'repairing' AND (prose_updated_at IS NULL OR prose_updated_at < ${staleParam}))`,
  );
  // An auto turn that wrote `queued` and was evicted before its `waitUntil` ran leaves no
  // worker at all. After the same stale window the button may take it, rather than leaving
  // the row waiting on a job that no longer exists.
  clauses.push(
    `(prose_status = 'queued' AND (prose_updated_at IS NULL OR prose_updated_at < ${staleParam}))`,
  );

  const result = await env.DB.prepare(
    `UPDATE messages
        SET prose_status = 'repairing', prose_updated_at = ?1, prose_error = NULL
      WHERE id = ?2 AND (${clauses.join(' OR ')})`,
  )
    .bind(...params)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** The current status, or null for a row the guard never inspected. */
export async function readProseStatus(
  env: Env,
  messageId: string,
): Promise<ProseStatus | null> {
  const row = await env.DB.prepare('SELECT prose_status FROM messages WHERE id = ?')
    .bind(messageId)
    .first<{ prose_status: ProseStatus | null }>();
  return row?.prose_status ?? null;
}

/** Only the rows a client is still waiting on. Empty means "reload once". */
export async function pendingProse(
  env: Env,
  chatId: string,
): Promise<Array<{ messageId: string; status: ProseStatus }>> {
  const { results } = await env.DB.prepare(
    `SELECT id, prose_status FROM messages
      WHERE chat_id = ? AND prose_status IN ('queued', 'repairing')
      ORDER BY seq`,
  )
    .bind(chatId)
    .all<{ id: string; prose_status: ProseStatus }>();
  return results.map((row) => ({ messageId: row.id, status: row.prose_status }));
}

/**
 * The guard's state for a window of rows, keyed by id.
 *
 * The transcript cannot carry these on the branch walk without widening every path read,
 * so they are fetched for the rows the client is about to see. Chunked for the same reason
 * `loadAlternatives` chunks: D1 caps a statement at 100 bound parameters.
 */
export async function proseForMessages(
  env: Env,
  ids: string[],
): Promise<Map<string, ProseState>> {
  const states = new Map<string, ProseState>();
  const CHUNK = 90;

  for (let start = 0; start < ids.length; start += CHUNK) {
    const slice = ids.slice(start, start + CHUNK);
    if (slice.length === 0) continue;
    const placeholders = slice.map((_, index) => `?${index + 1}`).join(', ');
    const { results } = await env.DB.prepare(
      `SELECT id, prose_status, prose_violations, prose_error FROM messages
        WHERE id IN (${placeholders}) AND prose_status IS NOT NULL`,
    )
      .bind(...slice)
      .all<{
        id: string;
        prose_status: ProseStatus;
        prose_violations: string | null;
        prose_error: string | null;
      }>();

    for (const row of results) {
      states.set(row.id, {
        status: row.prose_status,
        violations: parseViolations(row.prose_violations),
        error: row.prose_error,
      });
    }
  }

  return states;
}

/** Unreadable JSON is "no details", never a broken transcript. */
function parseViolations(json: string | null): GuardViolation[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as GuardViolation[]) : [];
  } catch {
    return [];
  }
}
