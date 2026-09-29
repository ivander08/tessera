import type { Role } from '../../src/lib/prompt/types';
import { badRequest, json, notFound, readJson } from './http';
import { estimateTokens as estimate } from '../../src/lib/tokenEstimate';

/**
 * Message lifecycle: swipes, edit, delete, regenerate, impersonate, continue.
 *
 * The invariant every one of these preserves: `messages` stays append-only, and `seq`
 * stays the sole ordering authority for what is sent. A mutation never rewrites a row —
 * it marks the old one `active = 0` and appends the new version in the same
 * `swipe_group`. Two consequences that matter:
 *
 *  - Swiping back is free and lossless. The alternative is still there.
 *  - Regenerating the LAST message costs almost nothing in cache terms, because every
 *    earlier message is byte-identical, so the provider's cached prefix still matches.
 *    Editing an older message necessarily invalidates the prefix from that point on —
 *    the model genuinely saw different text — and the meter will show it.
 */

interface MessageRow {
  seq: number;
  id: string;
  chat_id: string;
  role: Role;
  content: string;
  active: number;
  swipe_group: string | null;
}

async function loadMessage(env: Env, chatId: string, id: string): Promise<MessageRow | null> {
  return await env.DB.prepare(
    'SELECT seq, id, chat_id, role, content, active, swipe_group FROM messages WHERE id = ? AND chat_id = ?',
  )
    .bind(id, chatId)
    .first<MessageRow>();
}

/**
 * Returns the swipe group a message belongs to, creating one if it has none.
 *
 * The anchor row MUST be given the group id, not just the new sibling. Getting this
 * wrong is silent and specific: the original keeps `swipe_group = NULL`, so a query for
 * the group returns only the new row, the swipe handler sees a group of one, and swiping
 * back does nothing at all — exactly the case that happens on the first regenerate.
 */
async function ensureGroup(env: Env, message: MessageRow): Promise<string> {
  if (message.swipe_group) return message.swipe_group;
  await env.DB.prepare('UPDATE messages SET swipe_group = ? WHERE id = ?')
    .bind(message.id, message.id)
    .run();
  return message.id;
}

/** The newest row in a swipe group, which is the one the reader sees. */
async function newestInGroup(env: Env, chatId: string, group: string): Promise<MessageRow | null> {
  return await env.DB.prepare(
    `SELECT seq, id, chat_id, role, content, active, swipe_group FROM messages
      WHERE chat_id = ? AND swipe_group = ? ORDER BY seq DESC LIMIT 1`,
  )
    .bind(chatId, group)
    .first<MessageRow>();
}

/**
 * Adds a row to a swipe group and makes it the active one. The group is created lazily
 * from the target's own id, so a message that has never been swiped becomes its own
 * group the first time it is.
 */
async function addSwipe(
  env: Env,
  chatId: string,
  group: string,
  role: Role,
  content: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare('UPDATE messages SET active = 0 WHERE chat_id = ? AND swipe_group = ?').bind(
      chatId,
      group,
    ),
    env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, swipe_group, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?)`,
    ).bind(id, chatId, role, content, estimate(content), group, now),
    env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId),
  ]);

  return id;
}

interface SwipeBody {
  chatId?: string;
  id?: string;
  content?: string;
  direction?: 'next' | 'prev' | number;
}

/** Moves within a group: `next`/`prev` step, a number jumps to that index. */
export async function swipeMessage(env: Env, req: Request): Promise<Response> {
  const body = await readJson<SwipeBody>(req);
  if (!body?.chatId || !body.id) return badRequest('chatId and id required');

  const current = await loadMessage(env, body.chatId, body.id);
  if (!current) return notFound('message not found');

  const group = await ensureGroup(env, current);

  const { results } = await env.DB.prepare(
    'SELECT id FROM messages WHERE chat_id = ? AND swipe_group = ? ORDER BY seq',
  )
    .bind(body.chatId, group)
    .all<{ id: string }>();

  if (results.length <= 1) {
    // Nothing to swipe to. Reporting the group size lets the UI hide the arrows rather
    // than showing controls that do nothing.
    return json({ ok: true, index: 0, count: results.length, id: current.id });
  }

  const currentIndex = results.findIndex((row) => row.id === current.id);
  const target = resolveIndex(body.direction, currentIndex, results.length);
  const chosen = results[target];

  await env.DB.batch([
    env.DB.prepare('UPDATE messages SET active = 0 WHERE chat_id = ? AND swipe_group = ?').bind(
      body.chatId,
      group,
    ),
    env.DB.prepare('UPDATE messages SET active = 1 WHERE id = ?').bind(chosen.id),
  ]);

  return json({ ok: true, index: target, count: results.length, id: chosen.id });
}

function resolveIndex(direction: SwipeBody['direction'], current: number, count: number): number {
  if (typeof direction === 'number') {
    return Math.max(0, Math.min(count - 1, direction));
  }
  if (direction === 'prev') return (current - 1 + count) % count;
  // `next` and anything unrecognised advance. Wrapping means the arrows are never dead
  // ends, which is how swipes behave everywhere else.
  return (current + 1) % count;
}

interface EditBody {
  chatId?: string;
  id?: string;
  content?: string;
}

export async function editMessage(env: Env, req: Request): Promise<Response> {
  const body = await readJson<EditBody>(req);
  if (!body?.chatId || !body.id || typeof body.content !== 'string') {
    return badRequest('chatId, id and content required');
  }
  if (body.content.trim().length === 0) return badRequest('content must not be empty');

  const message = await loadMessage(env, body.chatId, body.id);
  if (!message) return notFound('message not found');

  // An edit is a new alternative, not a rewrite. The old text stays swipable, which is
  // what makes an accidental edit recoverable.
  const group = await ensureGroup(env, message);
  const id = await addSwipe(env, body.chatId, group, message.role, body.content.trim());
  return json({ ok: true, id, group });
}

interface DeleteBody {
  chatId?: string;
  id?: string;
}

/**
 * Deleting deactivates rather than removing the row.
 *
 * A hard DELETE would fire the FTS delete trigger, so recall would lose the message, and
 * it would leave a hole in `seq` that the windowing walk has to reason about. Setting
 * `active = 0` removes it from the prompt while leaving both the index and the ordering
 * intact — and makes an accidental delete recoverable by swiping back.
 */
export async function deleteMessage(env: Env, req: Request): Promise<Response> {
  const body = await readJson<DeleteBody>(req);
  if (!body?.chatId || !body.id) return badRequest('chatId and id required');

  const message = await loadMessage(env, body.chatId, body.id);
  if (!message) return notFound('message not found');

  const group = await ensureGroup(env, message);
  await env.DB.prepare('UPDATE messages SET active = 0 WHERE chat_id = ? AND swipe_group = ?')
    .bind(body.chatId, group)
    .run();

  const remaining = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND swipe_group = ? AND active = 1',
  )
    .bind(body.chatId, group)
    .first<{ n: number }>();

  // If that was the only row in the group, the whole position is gone; say so, so the UI
  // can drop it rather than leaving an empty slot.
  return json({ ok: true, groupEmpty: (remaining?.n ?? 0) === 0 });
}

interface AddSwipeBody {
  chatId?: string;
  id?: string;
  content?: string;
}

/**
 * Adds an alternative to a message's swipe group and makes it active, returning the new
 * row's id.
 *
 * Split from the HTTP handler of the same name because the chat pipeline needs the
 * operation, not a Response. Returning JSON from the middle of a streaming turn would be
 * a category error.
 */
export async function addAlternativeRow(
  env: Env,
  chatId: string,
  targetId: string,
  content: string,
): Promise<string> {
  const message = await loadMessage(env, chatId, targetId);
  if (!message) throw new Error('message not found');

  const group = await ensureGroup(env, message);
  return await addSwipe(env, chatId, group, message.role, content);
}

/** Appends an alternative to a group without changing which one is active. */
export async function addAlternative(env: Env, req: Request): Promise<Response> {
  const body = await readJson<AddSwipeBody>(req);
  if (!body?.chatId || !body.id || typeof body.content !== 'string') {
    return badRequest('chatId, id and content required');
  }

  const message = await loadMessage(env, body.chatId, body.id);
  if (!message) return notFound('message not found');

  const group = await ensureGroup(env, message);

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, swipe_group, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, body.chatId, message.role, body.content, estimate(body.content), group, now)
    .run();

  return json({ ok: true, id, group });
}

/**
 * The last active message in the chat, which is where a regenerate or a continue
 * attaches. Returns null for an empty chat.
 */
export async function lastActiveMessage(env: Env, chatId: string): Promise<MessageRow | null> {
  return await env.DB.prepare(
    `SELECT seq, id, chat_id, role, content, active, swipe_group FROM messages
      WHERE chat_id = ? AND active = 1 ORDER BY seq DESC LIMIT 1`,
  )
    .bind(chatId)
    .first<MessageRow>();
}

export { newestInGroup };
