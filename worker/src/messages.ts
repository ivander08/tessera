import type { Role } from '../../src/lib/prompt/types';
import { badRequest, json, notFound, readJson } from './http';
import { estimateTokens as estimate } from '../../src/lib/tokenEstimate';
import { loadBranchRows, loadPath } from './branch';
import type { BranchRow } from './branch';

/**
 * Message lifecycle: swipes, edit, delete, regenerate, impersonate, continue.
 *
 * The invariant every one of these preserves: `messages` stays append-only, and a
 * mutation never rewrites a row's text — it deactivates the old version and appends the
 * new one.
 *
 * ## Positions are parents, not groups
 *
 * Two messages are versions of the same position exactly when they answer the same row.
 * That is the whole definition, and it is why the lifecycle keys on `parent_id` rather
 * than on a separate group id: a group column would be a second source of truth that
 * could disagree with the tree, and a regenerate writes a row whose group id does not
 * exist yet. The tree is already the authority for what the reader sees, so it is the
 * authority here too.
 *
 * Two consequences that matter:
 *
 *  - Swiping back is free and lossless. The alternative is still there, and so is
 *    everything that followed it.
 *  - Regenerating the LAST message costs almost nothing in cache terms, because every
 *    earlier message is byte-identical, so the provider's cached prefix still matches.
 *    Editing an older message necessarily invalidates the prefix from that point on —
 *    the model genuinely saw different text — and the meter will show it.
 */

interface MessageRow {
  seq: number;
  id: string;
  chat_id: string;
  /** The row this one answers. Null for an opening greeting. */
  parent_id: string | null;
  role: Role;
  content: string;
  active: number;
}

async function loadMessage(env: Env, chatId: string, id: string): Promise<MessageRow | null> {
  return await env.DB.prepare(
    'SELECT seq, id, chat_id, parent_id, role, content, active FROM messages WHERE id = ? AND chat_id = ?',
  )
    .bind(id, chatId)
    .first<MessageRow>();
}

/** Every version of one position: the rows answering the same parent. */
async function siblingsOf(env: Env, chatId: string, parentId: string | null): Promise<BranchRow[]> {
  const rows = await loadBranchRows(env, chatId);
  return rows.filter((row) => (row.parent_id ?? null) === parentId);
}

/**
 * Appends a new version of a position and makes it the active one.
 *
 * The group is the parent, so the new row inherits it rather than minting one — that is
 * what keeps a regenerated reply in the same slot as the reply it replaced.
 */
async function addVersion(
  env: Env,
  chatId: string,
  parentId: string | null,
  role: Role,
  content: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const siblings = await siblingsOf(env, chatId, parentId);

  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).bind(id, chatId, parentId, role, content, estimate(content), now),
    env.DB.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').bind(now, chatId),
  ];

  // Deactivate the other versions of this position. Doing it here rather than at the
  // call site keeps the one-active-child invariant in a single place.
  if (siblings.length > 0) {
    statements.unshift(
      env.DB.prepare(
        `UPDATE messages SET active = 0 WHERE chat_id = ? AND id IN (${siblings
          .map(() => '?')
          .join(', ')})`,
      ).bind(chatId, ...siblings.map((row) => row.id)),
    );
  }

  await env.DB.batch(statements);
  return id;
}

interface SwipeBody {
  chatId?: string;
  id?: string;
  content?: string;
  direction?: 'next' | 'prev' | number;
}

/** Moves within a position: `next`/`prev` step, a number jumps to that index. */
export async function swipeMessage(env: Env, req: Request): Promise<Response> {
  const body = await readJson<SwipeBody>(req);
  if (!body?.chatId || !body.id) return badRequest('chatId and id required');

  const current = await loadMessage(env, body.chatId, body.id);
  if (!current) return notFound('message not found');

  const siblings = await siblingsOf(env, body.chatId, current.parent_id ?? null);

  if (siblings.length <= 1) {
    // Nothing to swipe to. Reporting the size lets the UI hide the arrows rather than
    // showing controls that do nothing.
    return json({ ok: true, index: 0, count: siblings.length, id: current.id });
  }

  const currentIndex = siblings.findIndex((row) => row.id === current.id);
  const target = resolveIndex(body.direction, currentIndex, siblings.length);
  const chosen = siblings[target];

  // Activating a version is the whole operation. Its continuation — if it has one — is
  // still in the table and becomes reachable again the moment this row is the active
  // child, which is what makes swiping back restore the messages that followed.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE messages SET active = 0 WHERE chat_id = ? AND id IN (${siblings
        .map(() => '?')
        .join(', ')})`,
    ).bind(body.chatId, ...siblings.map((row) => row.id)),
    env.DB.prepare('UPDATE messages SET active = 1 WHERE id = ?').bind(chosen.id),
  ]);

  return json({ ok: true, index: target, count: siblings.length, id: chosen.id });
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

  // An edit is a new version of the same position, not a rewrite. The old text stays
  // swipable, which is what makes an accidental edit recoverable.
  const id = await addVersion(env, body.chatId, message.parent_id ?? null, message.role, body.content.trim());
  return json({ ok: true, id });
}

interface DeleteBody {
  chatId?: string;
  id?: string;
}

/**
 * Deleting deactivates the whole position rather than removing rows.
 *
 * Deactivating every version means the path walk stops there, so the message and
 * everything after it leave the transcript together. That is the behaviour a reader
 * expects from "delete this turn" — and because nothing is removed, the deletion is
 * recoverable by swiping back.
 *
 * A hard DELETE would fire the FTS delete trigger, so recall would lose the message, and
 * it would leave a hole in `seq` that the windowing walk has to reason about.
 */
export async function deleteMessage(env: Env, req: Request): Promise<Response> {
  const body = await readJson<DeleteBody>(req);
  if (!body?.chatId || !body.id) return badRequest('chatId and id required');

  const message = await loadMessage(env, body.chatId, body.id);
  if (!message) return notFound('message not found');

  const siblings = await siblingsOf(env, body.chatId, message.parent_id ?? null);
  await env.DB.prepare(
    `UPDATE messages SET active = 0 WHERE chat_id = ? AND id IN (${siblings
      .map(() => '?')
      .join(', ')})`,
  )
    .bind(body.chatId, ...siblings.map((row) => row.id))
    .run();

  // The position is empty now, so the UI drops it rather than leaving a blank slot.
  return json({ ok: true, groupEmpty: true });
}

interface AddSwipeBody {
  chatId?: string;
  id?: string;
  content?: string;
}

/**
 * Adds an alternative to a message's position and makes it active, returning the new
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

  return await addVersion(env, chatId, message.parent_id ?? null, message.role, content);
}

/** Appends an alternative to a position without changing which one is active. */
export async function addAlternative(env: Env, req: Request): Promise<Response> {
  const body = await readJson<AddSwipeBody>(req);
  if (!body?.chatId || !body.id || typeof body.content !== 'string') {
    return badRequest('chatId, id and content required');
  }

  const message = await loadMessage(env, body.chatId, body.id);
  if (!message) return notFound('message not found');

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, body.chatId, message.parent_id, message.role, body.content, estimate(body.content), now)
    .run();

  return json({ ok: true, id });
}

/**
 * The end of the visible path, which is where an un-targeted regenerate or continue
 * attaches. Returns null for an empty chat.
 *
 * Deliberately not "the newest active row": once a chat branches, the newest row can
 * belong to an abandoned branch, and acting on it would edit a scene the reader cannot
 * see.
 */
export async function lastActiveMessage(env: Env, chatId: string): Promise<MessageRow | null> {
  const path = await loadPath(env, chatId);
  const tail = path[path.length - 1];
  if (!tail) return null;
  return await loadMessage(env, chatId, tail.id);
}

export { loadMessage };
export type { MessageRow };
