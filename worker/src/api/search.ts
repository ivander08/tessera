import { notFound } from '../http';
import { searchChat } from '../search';

/** `GET /api/chats/:id/search` — full-text hits over the chat's own messages. */
export async function searchRoute(req: Request, env: Env, chatId: string, url: URL): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return searchChat(env, chatId, url);
}
