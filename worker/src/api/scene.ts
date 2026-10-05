import { notFound } from '../http';
import { getSceneSetup, patchSceneSetup } from '../scene';

/** `GET`/`PATCH /api/chats/:chatId/scene`. */
export async function sceneRoute(req: Request, env: Env, chatId: string): Promise<Response> {
  const method = req.method;
  const sceneChatId = chatId;
  if (method === 'GET') return getSceneSetup(env, sceneChatId);
  if (method === 'PATCH') return patchSceneSetup(env, sceneChatId, req);
  return notFound();
}
