import { badRequest, json, readJson } from '../http';
import { repairReply } from '../prose/repair';

/**
 * `POST /api/prose/fix` — the Fix prose button.
 *
 * One request, one message. It returns the violations whether or not a repair was written:
 * "nothing found" is a useful answer and the alternative is a button that looks broken on
 * every clean reply. The repair itself is added as an active swipe alternative, so the
 * model's original stays one swipe away.
 */
export async function proseFixRoute(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ chatId?: string; messageId?: string }>(req);
  if (!body?.chatId || !body.messageId) return badRequest('chatId and messageId required');

  try {
    const result = await repairReply(env, body.chatId, body.messageId, { activate: true });
    return json(result);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}
