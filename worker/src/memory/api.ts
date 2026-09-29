import { badRequest, json, notFound, readJson } from '../http';

/**
 * HTTP surface for the memory viewer (`src/routes/Memory.tsx`).
 *
 * Three route lines are needed in `worker/src/index.ts`:
 *
 *   const memoryMatch = /^\/api\/chats\/([^/]+)\/memory$/.exec(path);
 *   if (memoryMatch && method === 'GET') return listMemory(env, decodeURIComponent(memoryMatch[1]));
 *   if (path === '/api/memory/facts' && method === 'POST') return createFact(env, req);
 *   const memoryEntry = /^\/api\/memory\/(facts|summaries)\/([^/]+)$/.exec(path);
 *   if (memoryEntry) return mutateMemory(env, req, memoryEntry[1], decodeURIComponent(memoryEntry[2]));
 *
 * Nothing here touches the prompt. Editing or deleting a memory changes only the
 * side tables; the message history is append-only and stays that way.
 */

interface SummaryRow {
  id: string;
  tier: 'scene' | 'arc';
  covers_from: number;
  covers_to: number;
  content: string;
  tokens: number | null;
  created_at: number;
}

interface FactRow {
  id: string;
  text: string;
  subject: string | null;
  status: 'active' | 'superseded';
  superseded_by: string | null;
  pinned: number;
  created_at: number;
}

export async function listMemory(env: Env, chatId: string): Promise<Response> {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const [summaries, facts] = await Promise.all([
    // Newest coverage first: the arc/scene you just made is the one you want to read.
    env.DB.prepare(
      `SELECT id, tier, covers_from, covers_to, content, tokens, created_at
         FROM summaries WHERE chat_id = ? ORDER BY covers_from DESC`,
    )
      .bind(chatId)
      .all<SummaryRow>(),
    env.DB.prepare(
      `SELECT id, text, subject, status, superseded_by, pinned, created_at
         FROM facts WHERE chat_id = ? ORDER BY pinned DESC, created_at`,
    )
      .bind(chatId)
      .all<FactRow>(),
  ]);

  return json({ summaries: summaries.results, facts: facts.results });
}

/**
 * Create a fact by hand.
 *
 * Facts are normally proposed by an extraction pass, but that pass is not part of this
 * milestone and a fact the user types themselves is still a fact: it belongs in
 * `facts` (searchable, pinnable) rather than nowhere. Without this the `pinned` and
 * `superseded` columns could never be exercised at all.
 */
export async function createFact(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ chatId?: string; text?: string; subject?: string; pinned?: boolean }>(req);
  if (!body?.chatId || typeof body.text !== 'string' || body.text.trim().length === 0) {
    return badRequest('chatId and text required');
  }

  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(body.chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      id,
      body.chatId,
      body.text.trim(),
      typeof body.subject === 'string' && body.subject.length > 0 ? body.subject : null,
      body.pinned ? 1 : 0,
      Date.now(),
    )
    .run();

  return json({ id }, 201);
}

/**
 * PATCH edits a fact's text, subject, pin or status; DELETE removes it. Summaries are
 * editable and deletable but carry no pin — a summary is derived text, and a pin on
 * derived text is the same as recalling it always, which `recall` deliberately does
 * not do.
 */
export async function mutateMemory(
  env: Env,
  req: Request,
  kind: string,
  id: string,
): Promise<Response> {
  if (kind !== 'facts' && kind !== 'summaries') return notFound();

  if (req.method === 'DELETE') {
    // The FTS delete trigger keeps the index in step, so no manual unindexing here.
    await env.DB.prepare(`DELETE FROM ${kind} WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }

  if (req.method !== 'PATCH') return notFound();

  if (kind === 'summaries') {
    const body = await readJson<{ content?: string }>(req);
    if (typeof body?.content !== 'string' || body.content.trim().length === 0) {
      return badRequest('content required');
    }
    await env.DB.prepare('UPDATE summaries SET content = ? WHERE id = ?')
      .bind(body.content.trim(), id)
      .run();
    return json({ ok: true });
  }

  const body = await readJson<{
    text?: string;
    subject?: string | null;
    pinned?: boolean;
    status?: string;
  }>(req);
  if (!body) return badRequest('invalid body');

  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  if (body.text !== undefined) {
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return badRequest('text must be a non-empty string');
    }
    sets.push('text = ?');
    values.push(body.text.trim());
  }
  if (body.subject !== undefined) {
    sets.push('subject = ?');
    values.push(typeof body.subject === 'string' && body.subject.length > 0 ? body.subject : null);
  }
  if (body.pinned !== undefined) {
    sets.push('pinned = ?');
    values.push(body.pinned ? 1 : 0);
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'superseded') {
      return badRequest("status must be 'active' or 'superseded'");
    }
    sets.push('status = ?');
    values.push(body.status);
  }

  if (sets.length === 0) return badRequest('nothing to update');

  values.push(id);
  await env.DB.prepare(`UPDATE facts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  return json({ ok: true });
}
