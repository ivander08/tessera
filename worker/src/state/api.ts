import { badRequest, json, notFound, readJson } from '../http';
import { validatePatch, type WorldState } from '../../../src/lib/state/schema';
import { loadStateForViewer, stateAnchor } from './update';
import { renderStateBlock } from '../../../src/lib/prompt/stateBlock';
import { estimateTokens } from '../../../src/lib/tokenEstimate';
import { loadSceneSetup } from '../scene';

/**
 * The world-state viewer.
 *
 * Exists because the state engine writes a row after every turn and, until now, the only
 * way to read it was `wrangler d1 execute`. That is not a workflow — and worse, a
 * hallucinated value is invisible until it has poisoned several turns. Reading the real
 * stored documents immediately surfaced two problems: a cast list containing the pronoun
 * "me", and a user name the narrator had invented and recorded as fact.
 *
 * Editing goes through `validatePatch`, the same choke point the model's proposals use,
 * so a hand edit cannot put the document into a shape the prompt renderer cannot handle.
 */

export async function getState(env: Env, chatId: string): Promise<Response> {
  // The document the next turn will actually read: the visible path's newest snapshot, not
  // the live row. The two disagree after a swipe, and showing the live row here while the
  // transcript's scene line shows the path is what made a hand-corrected clock look
  // unpersisted — the panel was editing one document and the transcript was displaying
  // another.
  const state = await loadStateForViewer(env, chatId);
  // The same setup the prompt builder reads, so the panel shows exactly what the model
  // sees — including which optional sections the craft toggles turn off.
  const setup = await loadSceneSetup(env, chatId);
  const options = { bonds: setup.craft.bonds, threads: setup.craft.threads };

  const { results } = await env.DB.prepare(
    'SELECT json, updated_at FROM state WHERE chat_id = ?',
  )
    .bind(chatId)
    .all<{ json: string; updated_at: number }>();

  const row = results[0];
  return json({
    chatId,
    state,
    updatedAt: row?.updated_at ?? null,
    // Rendered here rather than on the client so the viewer shows exactly what the model
    // receives, not an approximation of it.
    rendered: renderStateBlock(state, 800, undefined, options),
    tokens: estimateTokens(renderStateBlock(state, 800, undefined, options)),
  });
}

/**
 * Applies a hand edit as a patch.
 *
 * A patch, not a replacement, because it reuses the validation that already exists and
 * because `null` already means "clear this key" — so removing a field and clearing one
 * are the same operation, which is what a user expects.
 */
export async function patchState(env: Env, req: Request): Promise<Response> {
  const body = await readJson<{ chatId?: string; patch?: unknown }>(req);
  if (!body?.chatId) return badRequest('chatId required');
  if (!body.patch || typeof body.patch !== 'object') return badRequest('patch required');

  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(body.chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  // The edit merges over what the next turn will read, not over the live row: the live row
  // is overwritten every turn and after a swipe can describe a version that has left the
  // screen. Merging over it resurrected values from that version.
  const current = await loadStateForViewer(env, body.chatId);
  const result = validatePatch(current, body.patch);
  if (!result.ok) return badRequest(result.reason);

  // The corrected document must also land ON the visible path, on the newest scene line.
  // Every turn reads the path at its anchor, so a correction that lived only in the live
  // row would be overwritten by the next turn — which would read the path, see the value
  // the reader had just corrected, and re-derive the wrong world from it. Reported as "I
  // fix the clock in the panel and the next reply moves it back".
  //
  // The anchor is the newest assistant row rather than the tail: the scene line is drawn
  // on replies, and between a send and its reply the tail is the reader's own row, which
  // shows no line. The state the next turn reads is identical either way — a send reads the
  // tail inclusive, so it inherits this snapshot.
  const anchor = await stateAnchor(env, body.chatId);

  const statements = [
    env.DB.prepare(
      `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).bind(body.chatId, JSON.stringify(result.next), Date.now()),
  ];
  if (anchor) {
    statements.push(
      env.DB.prepare('UPDATE messages SET state_json = ? WHERE chat_id = ? AND id = ?')
        .bind(JSON.stringify(result.next), body.chatId, anchor.id),
    );
  }
  await env.DB.batch(statements);

  return json({ ok: true, state: result.next });
}

/** Wipes the document, for when the engine has drifted too far to correct field by field. */
export async function clearState(env: Env, chatId: string): Promise<Response> {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const empty: WorldState = {};
  // The path snapshot goes with the live row, or the scene line would keep showing the
  // document the reader just cleared while the panel showed nothing.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).bind(chatId, JSON.stringify(empty), Date.now()),
    env.DB.prepare('UPDATE messages SET state_json = NULL WHERE chat_id = ?').bind(chatId),
  ]);

  return json({ ok: true, state: empty });
}
