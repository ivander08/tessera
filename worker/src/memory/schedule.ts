import { enqueue, claim, recoverStale, start, finish, type JobRow } from '../jobs';
import { pathSeqsAfter } from '../branch';
import { summarize } from './summarize';
import { extractFacts } from './extract';
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

    // Active rows only, and only the ones on the visible path: a swiped-away alternative
    // is not part of the story and must never be summarized.
    //
    // The range to cover is `covered + 1` onward, so asking for the first `SUMMARY_EVERY`
    // visible messages after the last summary is enough to decide both whether to enqueue
    // and what to enqueue. Nothing beyond that block is read.
    const lastSummary = await env.DB.prepare(
      'SELECT MAX(covers_to) AS covered FROM summaries WHERE chat_id = ?',
    )
      .bind(chatId)
      .first<{ covered: number | null }>();
    const covered = lastSummary?.covered ?? 0;

    const seqs = await pathSeqsAfter(env, chatId, covered, SUMMARY_EVERY);
    if (seqs.length < SUMMARY_EVERY) return;

    // Summarize the whole block, so a summary is never a one-message fragment.
    const oldest = seqs[0];
    const upTo = seqs[seqs.length - 1];

    await enqueue(env, chatId, 'summarize', `summarize:${chatId}:${oldest}:${upTo}`, {
      fromSeq: oldest,
      toSeq: upTo,
    });

    // Facts are extracted over the SAME block, in their own job rather than inside the
    // summarizer. Two reasons: one failure must not lose the other's work, and the
    // summarizer is asked to compress while this one is asked to be precise — asking a
    // single call for both produces a summary with facts filed off it.
    //
    // Measured before this existed: zero facts after 157 turns.
    await enqueue(env, chatId, 'extract', `extract:${chatId}:${oldest}:${upTo}`, {
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
 * How many queued jobs one wake will drain.
 *
 * Was one, which does not keep pace. A scene block now enqueues TWO jobs (summary +
 * extraction), so a single job per wake falls behind by construction — measured on a real
 * 157-turn chat, coverage reached 160 messages behind, and a 6th job sat claimed with an
 * expired lease for over ten minutes because `recoverStale` runs once per isolate and a
 * warm isolate never cold-starts.
 *
 * Four is a compromise: enough that a two-job block drains well within one wake and a
 * short backlog clears, small enough that a long backlog cannot consume the CPU budget of
 * the request that triggered the wake. The work is all behind `waitUntil`, so this costs
 * latency only to itself.
 */
const JOBS_PER_WAKE = 4;

/**
 * Runs pending memory jobs.
 *
 * Called on worker wake alongside the stale-lease sweep. Bounded rather than unbounded:
 * draining an arbitrarily long backlog on every request would compete with the request
 * that triggered it.
 */
export async function runPendingMemoryJob(env: Env): Promise<void> {
  try {
    if (!(await loadCheapModel(env))) return;

    // Reclaim anything whose owner was evicted mid-run BEFORE draining, so a job stranded
    // by a warm isolate that never cold-starts is picked up rather than sitting claimed
    // forever. This is the failure the report caught: a job in `generating` with an
    // expired lease and nothing to reclaim it.
    await recoverStale(env).catch(() => {});

    for (let round = 0; round < JOBS_PER_WAKE; round += 1) {
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

      await runJob(env, job);
    }
  } catch (error) {
    console.warn(`[memory] job runner failed: ${messageOf(error)}`);
  }
}

/** One job, with its own failure handling so a bad job does not stop the drain. */
async function runJob(env: Env, job: JobRow): Promise<void> {
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
      return;
    }

    if (job.kind === 'extract') {
      const payload = JSON.parse(job.payload ?? '{}') as SummarizePayload;
      const result = await extractFacts(env, job.chat_id, payload.fromSeq, payload.toSeq);
      await finish(env, job.id, 'delivered', JSON.stringify(result));
      return;
    }

    // An unknown kind is a bug or a leftover from an older version. Failing it is better
    // than retrying forever.
    await finish(env, job.id, 'failed', undefined, `unknown job kind: ${job.kind}`);
  } catch (error) {
    await finish(env, job.id, 'failed', undefined, messageOf(error));
    console.warn(`[memory] job ${job.id} failed: ${messageOf(error)}`);
  }
}

/** How many scenes must accumulate before they fold into an arc. Re-exported for tests. */
export { SCENES_PER_ARC };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
