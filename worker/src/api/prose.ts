import { badRequest, json, readJson } from '../http';
import { inspectReply, repairReply } from '../prose/repair';
import {
  claimProse,
  clearProseStatus,
  pendingProse,
  readProseStatus,
  setProseStatus,
} from '../prose/state';

/**
 * `POST /api/prose/fix` — the Fix prose button.
 *
 * Detection runs first and is free, so a clean reply costs no model call and can say so.
 * A reply with problems is CLAIMED before the repair starts: two clicks, or a click that
 * races the auto pass, must not spend two calls and write two versions. Losing the claim
 * is not an error — the caller is told which state won and can watch that one settle.
 *
 * The repair is added as the active version in this mode, so the model's original stays
 * one swipe away.
 */
export async function proseFixRoute(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ chatId?: string; messageId?: string }>(req);
  if (!body?.chatId || !body.messageId) return badRequest('chatId and messageId required');

  try {
    const inspection = await inspectReply(env, body.chatId, body.messageId);
    if (inspection.setup.proseGuard === 'off') {
      return json({ error: 'prose guard is off for this chat' }, 400);
    }

    if (inspection.violations.length === 0) {
      await setProseStatus(env, body.messageId, 'clean', []);
      return json({ violations: [] });
    }

    // `null` is an old reply written before the status columns existed. The button has to
    // keep working on those chats; it simply has no prior state to respect.
    if (!(await claimProse(env, body.messageId, ['issues', 'failed', null]))) {
      const status = await readProseStatus(env, body.messageId);
      return json({ already: true, status, violations: inspection.violations });
    }

    try {
      const result = await repairReply(
        env,
        body.chatId,
        body.messageId,
        { activate: true },
        inspection,
      );
      if (result.discarded) {
        await clearProseStatus(env, body.messageId);
        return json({ discarded: true, violations: [] });
      }
      await setProseStatus(env, body.messageId, 'done', result.violations);
      return json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setProseStatus(env, body.messageId, 'failed', inspection.violations, message).catch(
        () => {},
      );
      return json({ error: message }, 500);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

/**
 * `GET /api/prose/status?chatId=` — what the client polls.
 *
 * Only the rows still `queued` or `repairing` are returned, because that is the entire
 * question the poll answers: is there anything left to wait for? An empty list means the
 * client reloads once and stops. The per-row status the chips render comes from the
 * transcript, so a settled row never has to be merged in here.
 */
export async function proseStatusRoute(env: Env, url: URL): Promise<Response> {
  const chatId = url.searchParams.get('chatId');
  if (!chatId) return badRequest('chatId required');
  return json({ pending: await pendingProse(env, chatId) });
}
