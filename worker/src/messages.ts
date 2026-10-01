import type { Role } from '../../src/lib/prompt/types';
import { badRequest, json, notFound, readJson } from './http';
import { estimateTokens as estimate } from '../../src/lib/tokenEstimate';
import { loadPath } from './branch';
import type { BranchRow } from './branch';
import { BRANCH_COLUMNS } from './branch';

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

/**
 * Every version of one position: the rows answering the same parent.
 *
 * Removed versions are excluded. `active = 0` alone cannot say "gone" — it also means "a
 * version you can swipe back to" — so a deleted row carries `deleted = 1` and leaves this
 * set entirely. Without that, deleting the current version promotes a survivor, and
 * deleting THAT one promotes the first back: a reader deleting through three versions
 * watches the one they removed first reappear.
 */
async function siblingsOf(env: Env, chatId: string, parentId: string | null): Promise<BranchRow[]> {
  // Targeted rather than a scan of the chat. This runs on every swipe, and a chat with a
  // long history should not pay for its length to move one position.
  if (parentId === null) {
    const { results } = await env.DB.prepare(
      `SELECT ${BRANCH_COLUMNS} FROM messages
        WHERE chat_id = ?1 AND parent_id IS NULL AND deleted = 0 ORDER BY seq`,
    )
      .bind(chatId)
      .all<BranchRow>();
    return results;
  }

  const { results } = await env.DB.prepare(
    `SELECT ${BRANCH_COLUMNS} FROM messages
      WHERE chat_id = ?1 AND parent_id = ?2 AND deleted = 0 ORDER BY seq`,
  )
    .bind(chatId, parentId)
    .all<BranchRow>();
  return results;
}

/**
 * Deactivates every active row at one position.
 *
 * Two messages are versions of the same position exactly when they share a parent, so the
 * position is the parent — no id list needed. That matters: the previous version bound one
 * parameter per sibling, and D1 rejects a statement with more than 100. A position with
 * 101 versions would have failed to swipe, regenerate or delete, and the failure would
 * look like a random 500 rather than a limit.
 *
 * `IS ?` rather than `= ?` because the opening's parent is NULL, and `= NULL` matches
 * nothing. A bound NULL works with `IS`, which is what lets one statement cover the root.
 *
 * Callers pass a statement rather than awaiting one so this can join their batch.
 */
function deactivatePosition(env: Env, chatId: string, parentId: string | null) {
  return env.DB.prepare(
    `UPDATE messages SET active = 0
      WHERE chat_id = ?1 AND parent_id IS ?2 AND active = 1`,
  ).bind(chatId, parentId);
}

/**
 * Takes one row out of the transcript without deleting it.
 *
 * Used when a turn fails after the reader's message is already written: the text is theirs
 * and must survive, but an unreplied row on the visible path becomes the parent of the next
 * turn, which puts two `user` messages in a row in front of the model.
 *
 * Deactivated, never removed — the same reasoning as every other lifecycle operation here.
 */
async function abandonMessage(env: Env, chatId: string, id: string): Promise<void> {
  await env.DB.prepare('UPDATE messages SET active = 0 WHERE id = ? AND chat_id = ?')
    .bind(id, chatId)
    .run();
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
  speaker: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();

  // Deactivate the other versions of this position. Doing it here rather than at the
  // call site keeps the one-active-child invariant in a single place.
  //
  // The deactivation runs BEFORE the insert in the same batch, so it cannot switch off
  // the row just added.
  await env.DB.batch([
    deactivatePosition(env, chatId, parentId),
    env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, speaker, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(id, chatId, parentId, role, content, estimate(content), speaker, now),
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
  //
  // The deactivation is by position, not by id list: `siblings.length` parameters would
  // breach D1's 100-parameter cap on a heavily regenerated position.
  await env.DB.batch([
    deactivatePosition(env, body.chatId, current.parent_id ?? null),
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

  // Everything that answered the OLD row now answers the new one. Without this the edit
  // deactivates the row its continuation was parented to, the walk cannot reach past it,
  // and the reply the reader was reading vanishes — which is exactly what a reader sees
  // as "editing my line deleted the character's answer".
  //
  // The children are reparented, not copied: a continuation is a fact about the position,
  // not about the version of the text that happened to sit there. The old row is left
  // inactive and childless, still swipable back to.
  await env.DB.prepare(
    'UPDATE messages SET parent_id = ? WHERE chat_id = ? AND parent_id = ?',
  )
    .bind(id, body.chatId, message.id)
    .run();

  return json({ ok: true, id });
}

interface DeleteBody {
  chatId?: string;
  id?: string;
}

/**
 * Deleting removes ONE version of a position, not the whole position.
 *
 * It used to deactivate every version at the position, on the reasoning that "delete this
 * turn" should take the turn and its continuation out together. That is right for the LAST
 * version and wrong for every other one: X on a swipe alternative destroyed the whole turn
 * and everything written after it, which a reader experiences as their scene silently
 * truncating. Measured on a real chat: deleting one of three versions of a reply removed
 * the reply AND the four turns that followed it.
 *
 * The removal is recorded as `deleted = 1`, not as `active = 0`. Those are different facts
 * — "gone" versus "not the current version" — and conflating them makes deleting twice
 * impossible: with only `active`, removing the current version promotes a survivor, and
 * removing that one promotes the first back. A reader deleting through three versions
 * would watch the one they removed first reappear.
 *
 * So:
 *
 *  - Other versions remain -> mark this one deleted, hand the continuation to the newest
 *    survivor, and the reader swipes on. The turn stays.
 *  - This was the last version -> mark it deleted, which empties the position and takes the
 *    turn out of the transcript with everything after it.
 *
 * Nothing is removed from the table either way. A hard DELETE would fire the FTS delete
 * trigger, so recall would lose the message, and it would leave a hole in `seq` that the
 * windowing walk has to reason about.
 */
export async function deleteMessage(env: Env, req: Request): Promise<Response> {
  const body = await readJson<DeleteBody>(req);
  if (!body?.chatId || !body.id) return badRequest('chatId and id required');

  const message = await loadMessage(env, body.chatId, body.id);
  if (!message) return notFound('message not found');

  const parentId = message.parent_id ?? null;
  const siblings = await siblingsOf(env, body.chatId, parentId);
  const survivors = siblings.filter((row) => row.id !== message.id);

  // The last version: the position empties, so the path walk stops there and the message
  // leaves the transcript with everything after it. `groupEmpty` tells the UI there is no
  // version left to show.
  if (survivors.length === 0) {
    await env.DB.prepare('UPDATE messages SET deleted = 1, active = 0 WHERE id = ? AND chat_id = ?')
      .bind(message.id, body.chatId)
      .run();
    return json({ ok: true, groupEmpty: true });
  }

  // Another version takes over. The newest survivor is the natural successor: it is the
  // most recently written text at this position, which is what the reader last asked for.
  const successor = survivors[survivors.length - 1];

  // Only an ACTIVE row needs a successor promoted. X-ing an inactive version is a pure
  // removal — promoting anything would leave two active children of one parent.
  if (message.active !== 1) {
    await env.DB.prepare('UPDATE messages SET deleted = 1 WHERE id = ? AND chat_id = ?')
      .bind(message.id, body.chatId)
      .run();
    return json({ ok: true, groupEmpty: false, id: successor.id });
  }

  // Deactivate the position, then promote the successor. Doing it by position rather than
  // by id is what keeps the one-active-child invariant even on a chat that already has two
  // active children from before this fix — the same self-healing shape `swipeMessage` uses.
  await env.DB.batch([
    deactivatePosition(env, body.chatId, parentId),
    env.DB.prepare('UPDATE messages SET deleted = 1 WHERE id = ? AND chat_id = ?')
      .bind(message.id, body.chatId),
    env.DB.prepare('UPDATE messages SET active = 1 WHERE id = ? AND chat_id = ?')
      .bind(successor.id, body.chatId),
    // The continuation followed the row that just left, so it follows the one that
    // replaced it. Without this the reply the reader was reading drops off the walk —
    // the same failure an edit had, reached by a different door.
    env.DB.prepare('UPDATE messages SET parent_id = ? WHERE chat_id = ? AND parent_id = ?')
      .bind(successor.id, body.chatId, message.id),
  ]);

  // Not empty: the turn is still on screen, showing a different version.
  return json({ ok: true, groupEmpty: false, id: successor.id });
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
  speaker: string | null = null,
): Promise<string> {
  const message = await loadMessage(env, chatId, targetId);
  if (!message) throw new Error('message not found');

  return await addVersion(env, chatId, message.parent_id ?? null, message.role, content, speaker);
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

export { loadMessage, abandonMessage };
export type { MessageRow };
