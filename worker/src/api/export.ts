import { notFound } from '../http';
import { exportChat } from '../export';

/** `GET /api/chats/:id/export`. */
export async function exportRoute(req: Request, env: Env, chatId: string, url: URL): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return exportChat(env, chatId, url);
}
