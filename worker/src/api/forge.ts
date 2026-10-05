import { forgeConsult } from '../forge/api';

/** `POST /api/forge/consult` — the card consultant's stream. */
export async function forgeRoute(req: Request, env: Env): Promise<Response> {
  return forgeConsult(env, req);
}
