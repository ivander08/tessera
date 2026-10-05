import { notFound } from '../http';
import { addCast, listCast, promoteCast, removeCast } from '../castApi';

/** `GET`/`POST /api/chats/:chatId/cast`. */
export async function castRoute(req: Request, env: Env, chatId: string): Promise<Response> {
  const method = req.method;
  const castChatId = chatId;
  if (method === 'GET') return listCast(env, castChatId);
  if (method === 'POST') return addCast(env, castChatId, req);
  return notFound();
}

/**
 * `POST /api/chats/:chatId/cast/:id/promote`.
 *
 * Dispatched before the bare member route, or "promote" is captured as a cast id.
 */
export async function promoteRoute(req: Request, env: Env, chatId: string, id: string): Promise<Response> {
  if (req.method !== 'POST') return notFound();
  return promoteCast(env, chatId, id, req);
}

/** `DELETE /api/chats/:chatId/cast/:id`. */
export async function castMemberRoute(req: Request, env: Env, chatId: string, id: string): Promise<Response> {
  if (req.method !== 'DELETE') return notFound();
  return removeCast(env, chatId, id);
}
