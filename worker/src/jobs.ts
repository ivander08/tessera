/**
 * Durable job queue: queued -> claimed -> generating -> ready -> delivered | failed.
 *
 * WHY A LEASE AND NOT JUST A STATUS:
 * Horde Studio lost user messages by consuming a pending reply before the model call
 * that produced it had finished — the queue row said the work was done, the model
 * said otherwise, and the turn was gone. The inverse failure is just as bad: a Worker
 * is evicted mid-generation (or the client disconnects), the row stays `generating`
 * forever, and no later request will ever retry it because the status says someone
 * still owns it.
 *
 * `lease_until` is what makes a crash recoverable instead of a lost turn. A claim is
 * valid only until its lease expires, so an owner that dies mid-flight leaves the row
 * reclaimable by the next wake-up rather than permanently wedged. `attempts` counts
 * every claim, so a job that keeps failing can be identified and stopped.
 *
 * `idempotency_key` is UNIQUE and enqueue is INSERT ... ON CONFLICT DO NOTHING, so the
 * same logical job enqueued twice (a retried request, two racing Workers) yields one
 * row. Without it, a retry after a timeout silently doubles the model spend.
 */

export type JobStatus =
  | 'queued'
  | 'claimed'
  | 'generating'
  | 'ready'
  | 'delivered'
  | 'failed';

export interface JobRow {
  id: string;
  chat_id: string;
  kind: string;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  lease_until: number | null;
  payload: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Re-enqueues of one failed job before the row is left dead for inspection.
 */
const MAX_ATTEMPTS = 3;

/**
 * Enqueue a job, or return the existing job's id if `idempotencyKey` was already used.
 *
 * `ON CONFLICT DO NOTHING RETURNING` yields no row on a duplicate, so the id is
 * re-read. That read is deliberately not a transaction: the only two outcomes are
 * "the row already existed" and "another Worker inserted it between the two
 * statements", and both are the same row, because the key is UNIQUE.
 */

export async function enqueue(
  env: Env,
  chatId: string,
  kind: string,
  idempotencyKey: string,
  payload: unknown,
): Promise<string> {
  const now = Date.now();
  const serialized = payload === undefined || payload === null ? null : JSON.stringify(payload);

  const inserted = await env.DB.prepare(
    `INSERT INTO jobs (id, chat_id, kind, idempotency_key, status, attempts, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING
     RETURNING id`,
  )
    .bind(crypto.randomUUID(), chatId, kind, idempotencyKey, serialized, now, now)
    .first<{ id: string }>();

  if (inserted) return inserted.id;

  // A FAILED job with the same key is not a duplicate to ignore — it is the previous
  // attempt at this exact work, and it died. Leaving it `failed` here would stall the
  // pipeline forever: the scheduler derives its range from `MAX(covers_to)`, so the same
  // key is recomputed on every later turn, `ON CONFLICT DO NOTHING` keeps hitting the
  // dead row, and the runner only picks `status = 'queued'`. Measured on a real 341-
  // message chat: one transient failure (a cheap model that spends its whole token
  // budget thinking) stopped every summary and fact extraction from that point on, and
  // no amount of further turns unblocked it.
  //
  // Requeueing with a floor on attempts keeps this bounded — a job that keeps failing
  // stops after `MAX_ATTEMPTS`, which is what the counter has always been for.
  const requeued = await env.DB.prepare(
    `UPDATE jobs
        SET status = 'queued', lease_until = NULL, updated_at = ?
      WHERE idempotency_key = ? AND status = 'failed' AND attempts < ?
      RETURNING id`,
  )
    .bind(now, idempotencyKey, MAX_ATTEMPTS)
    .first<{ id: string }>();
  if (requeued) return requeued.id;

  const existing = await env.DB.prepare('SELECT id FROM jobs WHERE idempotency_key = ?')
    .bind(idempotencyKey)
    .first<{ id: string }>();
  if (!existing) throw new Error(`job ${idempotencyKey} vanished between insert and read`);
  return existing.id;
}

/**
 * Claim a job for this Worker.
 *
 * Claims a row that is `queued`, or one whose lease has already expired while still
 * `claimed`/`generating` — the crashed-owner case. The whole decision is one UPDATE,
 * so two Workers racing for the same job cannot both win: the second UPDATE matches
 * no row and returns null.
 *
 * `attempts` is incremented by the claim, not by the caller, so a job that is
 * repeatedly reclaimed shows it even if every owner dies before reporting anything.
 */
export async function claim(env: Env, jobId: string, leaseMs: number): Promise<JobRow | null> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE jobs
        SET status = 'claimed',
            attempts = attempts + 1,
            lease_until = ?,
            updated_at = ?
      WHERE id = ?
        AND (status = 'queued'
             OR (status IN ('claimed','generating') AND (lease_until IS NULL OR lease_until < ?)))
      RETURNING *`,
  )
    .bind(now + leaseMs, now, jobId, now)
    .first<JobRow>();
  return row ?? null;
}

/** A job is only `finish`ed into a state it does not come back from. */
export type TerminalStatus = 'ready' | 'delivered' | 'failed';

/**
 * Transition `claimed` -> `generating` once the model call has actually begun.
 *
 * Separate from `finish` on purpose. `finish` clears the lease, because a job that is
 * no longer being worked on must not look reclaimable. If it were allowed to set
 * `generating`, the row would have no lease, `recoverStale` would read it as an
 * abandoned owner, and a job that is running perfectly well would be requeued and run
 * a second time. `start` therefore RENEWS the lease instead.
 *
 * `job` is the row `claim` returned, and `attempts` is used as a FENCING TOKEN.
 * Without one, a job id does not prove ownership: if this Worker's lease lapsed and
 * another Worker reclaimed the job, `status = 'claimed'` is true again and this Worker
 * would carry on as if nothing had happened — and both would write a summary for the
 * same range. `claim` increments `attempts` on every successful claim, so the number
 * is strictly monotonic per job and cannot collide the way a millisecond timestamp
 * can when two claims land in the same tick.
 *
 * Returns false when the job is no longer ours, and the caller must then discard its
 * result rather than publishing it.
 */
export async function start(env: Env, job: JobRow, leaseMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE jobs SET status = 'generating', lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND attempts = ?
      RETURNING id`,
  )
    .bind(now + leaseMs, now, job.id, job.attempts)
    .first<{ id: string }>();
  return row !== null;
}

/**
 * Move a job to a state it does not come back from.
 *
 * The parameter is `TerminalStatus`, not `JobStatus`: `finish(id, 'generating')` would
 * clear the lease on a running job and hand it straight to `recoverStale`. Use `start`
 * for that transition.
 *
 * The lease is cleared here so a completed job can never be dragged back to the queue
 * by a recovery sweep, even after the lease it once held would have expired.
 */
export async function finish(
  env: Env,
  jobId: string,
  status: TerminalStatus,
  result?: unknown,
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = ?, result = ?, error = ?, lease_until = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      status,
      result === undefined || result === null ? null : JSON.stringify(result),
      error ?? null,
      Date.now(),
      jobId,
    )
    .run();
}

/**
 * Reclaim every job whose owner's lease expired. Called on Worker wake.
 *
 * Without this, a Worker evicted mid-generation leaves its job `generating` with a
 * dead lease that nothing ever re-reads, and the turn is lost exactly the way Horde
 * Studio lost it. Reclaiming sets the row back to `queued` with the lease cleared, so
 * the normal claim path picks it up — attempts is NOT incremented here, because the
 * retry's own claim will count it.
 *
 * Returns how many jobs were recovered, so the caller can log it.
 */
export async function recoverStale(env: Env): Promise<number> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE jobs
        SET status = 'queued', lease_until = NULL, updated_at = ?
      WHERE status IN ('claimed','generating')
        AND (lease_until IS NULL OR lease_until < ?)`,
  )
    .bind(now, now)
    .run();
  return result.meta.changes ?? 0;
}

let wakePromise: Promise<void> | null = null;

/**
 * Worker-wake hook. Call once from the fetch handler; it is safe to call on every
 * request because the work happens at most once per isolate.
 *
 * `recoverStale` is an UPDATE, and on Free tier writes are the scarce resource, so
 * running it on every request would spend the daily row budget on a sweep that almost
 * always matches nothing. Once per isolate is the right granularity: an isolate is
 * created on a cold start, which is exactly when a previous one may have died holding
 * a lease.
 *
 * Failures are swallowed and logged. A recovery sweep that throws must never fail the
 * user's request — the request is the thing that matters, and the sweep will simply
 * run again on the next cold start.
 */
export function onWorkerWake(env: Env): Promise<void> {
  wakePromise ??= recoverStale(env)
    .then((recovered) => {
      if (recovered > 0) console.log(`[jobs] recovered ${recovered} stale job(s) on wake`);
    })
    .catch((error: unknown) => {
      console.error('[jobs] stale-job recovery failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  return wakePromise;
}
