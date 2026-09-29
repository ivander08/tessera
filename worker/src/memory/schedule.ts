import { enqueue, claim, start, finish, type JobRow } from '../jobs';
import { summarize } from './summarize';
import { consolidate, SCENES_PER_ARC } from './consolidate';
import { loadCheapModel } from '../cheap';

/**
 * Memory maintenance: the wiring that makes summarization actually happen.
 *
 * Until this existed, `summarize`, `consolidate` and the whole job queue were built,
 * tested, and never called. The memory viewer said "summarization runs in the background
 * as a chat grows", which was not true — nothing ever enqueued a job, so no summary was
 * ever produced and `recall` could only ever find raw messages.
 *
 * The cadence is measured in MESSAGES, not turns, and that choice is why this is cheap:
 * summarizing every turn would spend a model call per turn to re-describe text that has
 * not changed. Every `SUMMARY_EVERY` messages costs one call and produces a scene that
 * stays valid.
 */

/** Messages between summaries. Roughly ten turns of paired user/assistant rows. */
export const SUMMARY_EVERY = 20;

/**
 * Queues a summary for whatever has accumulated since the last one.
 *
 * Called after a completed turn, via `waitUntil`, so it never delays the reply. The
 * idempotency key is the covered range, which makes a double-enqueue harmless — the
 * `ON CONFLICT DO NOTHING` in `enqueue` means a retry after a crash is free rather than
 * a duplicate summary of the same text.
 */
export async function scheduleMemory(env: Env, chatId: string): Promise<void> {
  try {
    // No cheap model means no summarization. Bailing here rather than inside the job
    // keeps a failing job out of the queue entirely.
    if (!(await loadCheapModel(env))) return;

    // Active rows only: a swiped-away alternative is not part of the story.
    // Ordered by POSITION, matching the prompt builder, so the summarized range is the
    // range the reader actually saw.
    const positionExpr = `COALESCE(
      (SELECT MIN(m2.seq) FROM messages m2
        WHERE m2.chat_id = messages.chat_id
          AND COALESCE(m2.swipe_group, m2.id) = COALESCE(messages.swipe_group, messages.id)),
      messages.seq
    )`;

    const lastSummary = await env.DB.prepare(
      'SELECT MAX(covers_to) AS covered FROM summaries WHERE chat_id = ?',
    )
      .bind(chatId)
      .first<{ covered: number | null }>();
    const covered = lastSummary?.covered ?? 0;

    const { results } = await env.DB.prepare(
      `SELECT seq, ${positionExpr} AS position FROM messages
        WHERE chat_id = ? AND active = 1 AND ${positionExpr} > ?
        ORDER BY position`,
    )
      .bind(chatId, covered)
      .all<{ seq: number; position: number }>();

    if (results.length < SUMMARY_EVERY) return;

    // Summarize up to the last complete block, leaving the remainder for next time so a
    // summary is never a one-message fragment.
    const upTo = results[SUMMARY_EVERY - 1].seq;
    const oldest = results[0].seq;

    await enqueue(env, chatId, 'summarize', `summarize:${chatId}:${oldest}:${upTo}`, {
      fromSeq: oldest,
      toSeq: upTo,
    });
  } catch (error) {
    // Memory is an enhancement. A failure here must never surface as a failed turn.
    console.warn(`[memory] scheduling failed for chat=${chatId}: ${messageOf(error)}`);
  }
}

interface SummarizePayload {
  fromSeq: number;
  toSeq: number;
}

/**
 * Runs one pending memory job, if any.
 *
 * Called on worker wake alongside the stale-lease sweep. One job per wake is deliberate:
 * a cold start has a CPU budget, and draining a backlog on every request would compete
 * with the request that triggered it.
 */
export async function runPendingMemoryJob(env: Env): Promise<void> {
  try {
    if (!(await loadCheapModel(env))) return;

    const pending = await env.DB.prepare(
      `SELECT id, chat_id, kind, status, attempts, lease_until, payload, error, created_at, updated_at
         FROM jobs WHERE status = 'queued'
        ORDER BY created_at LIMIT 1`,
    ).first<JobRow>();
    if (!pending) return;

    const job = await claim(env, pending.id, 60_000);
    if (!job) return; // another isolate took it

    // `start` renews the lease and fences on the attempts counter, so a superseded
    // isolate cannot finish a job another one has already taken over.
    if (!(await start(env, job, 60_000))) return;

    try {
      if (job.kind === 'summarize') {
        const payload = JSON.parse(job.payload ?? '{}') as SummarizePayload;
        await summarize(env, job.chat_id, payload.fromSeq, payload.toSeq);

        // Consolidation is checked here rather than on a schedule: it only has work to do
        // when a scene has just been added, and asking otherwise is a wasted query.
        await consolidate(env, job.chat_id).catch((error: unknown) => {
          console.warn(`[memory] consolidate failed for chat=${job.chat_id}: ${messageOf(error)}`);
        });

        await finish(env, job.id, 'delivered', JSON.stringify({ ok: true }));
      } else {
        // An unknown kind is a bug or a leftover from an older version. Failing it is
        // better than retrying forever.
        await finish(env, job.id, 'failed', undefined, `unknown job kind: ${job.kind}`);
      }
    } catch (error) {
      await finish(env, job.id, 'failed', undefined, messageOf(error));
      console.warn(`[memory] job ${job.id} failed: ${messageOf(error)}`);
    }
  } catch (error) {
    console.warn(`[memory] job runner failed: ${messageOf(error)}`);
  }
}

/** How many scenes must accumulate before they fold into an arc. Re-exported for tests. */
export { SCENES_PER_ARC };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
