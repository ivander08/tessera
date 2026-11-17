import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';

import { enqueue, finish, claim, start, type JobRow } from './jobs';
import { makeTestEnv } from './test/harness';

/**
 * The requeue path.
 *
 * The defect this pins: `enqueue` used `ON CONFLICT DO NOTHING` on the idempotency key,
 * so once a job failed, the key existed with status `failed` and every later `enqueue`
 * with the same key was a no-op. The scheduler derives its range from `MAX(covers_to)`
 * on summaries, which only advances when a job *succeeds*, so the same key was recomputed
 * every turn, hit the dead row, and the runner (which only claims `status = 'queued'`)
 * never saw it again. Measured on a real 341-message chat: one transient failure — a
 * cheap model that spent its whole token budget thinking — stopped every summary and
 * fact extraction from that point on. The chat had one summary where seventeen were due.
 */
const makeEnv = (): { env: Env; db: Database } => {
  const { env, db } = makeTestEnv();
  return { env, db };
};

const KEY = 'summarize:chat-a:10:30';

/** Jobs carry `chat_id REFERENCES chats(id)`, so a test chat row is the fixture. */
function seedChat(db: Database, id: string): void {
  db.run(
    `INSERT INTO characters (id, name, card_json, source_format, tokens, created_at)
     VALUES ('char-a', 'Test', '{}', 'ccv2', 1, 0)`,
  );
  db.run(
    `INSERT INTO chats (id, character_id, title, session_id, window_start_seq, created_at, updated_at)
     VALUES (?, 'char-a', 'Test', 'session', 0, 0, 0)`,
    [id],
  );
}

async function jobByKey(env: Env, key: string): Promise<JobRow> {
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE idempotency_key = ?')
    .bind(key)
    .first<Record<string, unknown>>();
  return row as unknown as JobRow;
}

describe('a failed memory job', () => {
  beforeEach(() => {});

  test('is requeued by the next enqueue with the same key', async () => {
    const { env, db } = makeEnv();
    seedChat(db, 'chat-a');
    const id = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });
    await finish(env, id, 'failed', undefined, 'model burned its budget thinking');

    // The same scheduling turn recomputes the same key — this is what used to be a no-op.
    const again = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });

    expect(again).toBe(id);
    const row = await jobByKey(env, KEY);
    expect(row.status).toBe('queued');
    expect(row.error).toBe('model burned its budget thinking');
    // The attempts counter survives the requeue: it is the bound.
    expect(row.attempts).toBe(0);
  });

  test('stops requeueing after the attempts cap', async () => {
    const { env, db } = makeEnv();
    seedChat(db, 'chat-a');
    await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });

    // MAX_ATTEMPTS is 3; two full claim-fail cycles put the row at attempts 2, still
    // under the cap, so the third enqueue requeues it and the claim makes it 3. From
    // there the next enqueue must leave it dead.
    for (let cycle = 0; cycle < 3; cycle++) {
      const queued = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });
      const claimed = await claim(env, queued, 60_000);
      expect(claimed).not.toBeNull();
      await start(env, claimed as JobRow, 60_000);
      await finish(env, (claimed as JobRow).id, 'failed', undefined, 'still failing');
    }

    const capped = await jobByKey(env, KEY);
    expect(capped.status).toBe('failed');
    expect(capped.attempts).toBe(3);

    // Now past the cap: the same enqueue is a no-op that returns the dead row, and the
    // row stays failed rather than being resurrected every turn.
    const again = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });
    expect(again).toBe(capped.id);
    expect((await jobByKey(env, KEY)).status).toBe('failed');
  });

  test('a delivered job is never resurrected', async () => {
    const { env, db } = makeEnv();
    seedChat(db, 'chat-a');
    const id = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });
    await finish(env, id, 'delivered', JSON.stringify({ ok: true }));

    const again = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });
    expect(again).toBe(id);
    const row = await jobByKey(env, KEY);
    expect(row.status).toBe('delivered');
  });

  test('a claimed or generating job is not touched by a requeue', async () => {
    const { env, db } = makeEnv();
    seedChat(db, 'chat-a');
    const id = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });
    const claimed = await claim(env, id, 60_000);
    expect(claimed).not.toBeNull();

    const again = await enqueue(env, 'chat-a', 'summarize', KEY, { fromSeq: 10, toSeq: 30 });
    expect(again).toBe(id);
    const row = await jobByKey(env, KEY);
    // The other isolate still owns it; only its lease can hand it back.
    expect(row.status).toBe('claimed');
  });
});

describe('a job that used every attempt', () => {
  // The prod failure: one budget-starved call at the end of October left the same key
  // failing, `ON CONFLICT DO NOTHING` matching the dead row, and that chat's facts stopped
  // growing for sixteen days with nothing said. The attempts floor must bound a loop
  // without making a transient failure permanent.
  test('is revived after the cooldown, with its counter reset', async () => {
    const { env, db } = makeEnv();
    seedChat(db, 'chat-a');
    await enqueue(env, 'chat-a', 'extract', KEY, { fromSeq: 10, toSeq: 30 });

    for (let cycle = 0; cycle < 3; cycle++) {
      const queued = await enqueue(env, 'chat-a', 'extract', KEY, { fromSeq: 10, toSeq: 30 });
      const claimed = await claim(env, queued, 60_000);
      await start(env, claimed as JobRow, 60_000);
      await finish(env, (claimed as JobRow).id, 'failed', undefined, 'budget starved');
    }
    expect((await jobByKey(env, KEY)).status).toBe('failed');

    // Age the row past the cooldown, which is what a stuck chat looks like after half an
    // hour of no progress.
    db.run("UPDATE jobs SET updated_at = ? WHERE idempotency_key = ?", [Date.now() - 31 * 60 * 1000, KEY]);

    const again = await enqueue(env, 'chat-a', 'extract', KEY, { fromSeq: 10, toSeq: 30 });
    const row = await jobByKey(env, KEY);
    expect(again).toBe(row.id);
    expect(row.status).toBe('queued');
    // Reset, so the revived job gets a full set of attempts rather than dying on the first.
    expect(row.attempts).toBe(0);
  });

  test('is not revived before the cooldown', async () => {
    const { env, db } = makeEnv();
    seedChat(db, 'chat-a');
    await enqueue(env, 'chat-a', 'extract', KEY, { fromSeq: 10, toSeq: 30 });

    for (let cycle = 0; cycle < 3; cycle++) {
      const queued = await enqueue(env, 'chat-a', 'extract', KEY, { fromSeq: 10, toSeq: 30 });
      const claimed = await claim(env, queued, 60_000);
      await start(env, claimed as JobRow, 60_000);
      await finish(env, (claimed as JobRow).id, 'failed', undefined, 'budget starved');
    }

    db.run("UPDATE jobs SET updated_at = ? WHERE idempotency_key = ?", [Date.now() - 5 * 60 * 1000, KEY]);
    await enqueue(env, 'chat-a', 'extract', KEY, { fromSeq: 10, toSeq: 30 });
    expect((await jobByKey(env, KEY)).status).toBe('failed');
  });
});
