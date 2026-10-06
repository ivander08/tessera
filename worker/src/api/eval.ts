import { badRequest, json, readJson } from '../http';
import { complete } from '../cheap';

/**
 * `POST /api/eval/judge` — the eval harness's rating call.
 *
 * It needs a model call but no provider credentials of its own, so it goes through the
 * configured cheap model like every other side-channel. It exposes no data — a caller
 * supplies the system and user text and gets a completion back — and it carries the same
 * bearer auth as every other route.
 */
export async function evalJudgeRoute(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ system?: string; user?: string }>(req);
  if (!body || typeof body.user !== 'string' || body.user.length === 0) {
    return badRequest('user is required');
  }
  try {
    const reply = await complete(env, {
      system: typeof body.system === 'string' ? body.system : undefined,
      user: body.user,
      // 1200 was exhausted by glm-5-3-flash on every long transcript: it reasons before
      // answering, and a full transcript in the user turn pushed its thinking past the
      // cap, leaving `content` empty — the same shape that stalled the memory pipeline
      // (see `scheduleMemory`). 2500 leaves room for both the thinking and the answer.
      maxTokens: 2500,
      json: true,
    });
    return json({ text: reply.text });
  } catch (error) {
    // The harness must be able to record a rating failure per scenario rather than
    // aborting the whole run, so the message comes back as a 200-shaped error body the
    // script can catch and skip.
    return json({ error: error instanceof Error ? error.message : String(error) });
  }
}
