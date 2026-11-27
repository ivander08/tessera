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
 * Detection runs first. A reply with problems is CLAIMED before the repair starts: two
 * clicks, or a click that races the auto pass, must not spend two calls and write two
 * versions. Losing the claim is not an error — the caller is told which state won and can
 * watch that one settle.
 *
 * A reply the detector finds nothing wrong with is NOT a dead end. The reader can still
 * ask for it to be rewritten: the same claim, the same model, but aimed at the voice
 * (`polish`) rather than at a violation list. This is the manual way to correct prose that
 * is clean by every rule and still flat. The original stays one swipe away.
 */
export async function proseFixRoute(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ chatId?: string; messageId?: string }>(req);
  if (!body?.chatId || !body.messageId) return badRequest('chatId and messageId required');

  try {
    const inspection = await inspectReply(env, body.chatId, body.messageId);
    if (inspection.setup.proseGuard === 'off') {
      return json({ error: 'prose guard is off for this chat' }, 400);
    }

    const polish = inspection.violations.length === 0;

    // `null` is an old reply written before the status columns existed. `clean` is a row
    // that passed detection; the reader may still want it rewritten.
    if (!(await claimProse(env, body.messageId, ['clean', 'issues', 'failed', null]))) {
      const status = await readProseStatus(env, body.messageId);
      return json({ already: true, status, violations: inspection.violations });
    }

    try {
      const result = await repairReply(
        env,
        body.chatId,
        body.messageId,
        { activate: true, polish },
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
      if (polish) {
        // Nothing was wrong, so a failed polish is not a failed repair. Restore the clean
        // verdict and let the caller show the reason; a failed chip on a clean reply would
        // be a lie the reader cannot act on.
        await setProseStatus(env, body.messageId, 'clean', []).catch(() => {});
      } else {
        await setProseStatus(env, body.messageId, 'failed', inspection.violations, message).catch(
          () => {},
        );
      }
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
