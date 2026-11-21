import { notFound } from '../http';
import { searchAll, searchChat } from '../search';

/** `GET /api/chats/:id/search` — full-text hits over the chat's own messages. */
export async function searchRoute(req: Request, env: Env, chatId: string, url: URL): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return searchChat(env, chatId, url);
}

/** `GET /api/search` — the same index, asked across every scene. */
export async function searchAllRoute(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return searchAll(env, url);
}
