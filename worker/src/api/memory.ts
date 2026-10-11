import { notFound } from '../http';
import { createFact, listMemory, listMemoryJobs, mutateMemory } from '../memory/api';

/** `GET /api/chats/:chatId/memory`. */
export async function memoryRoute(req: Request, env: Env, chatId: string): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return listMemory(env, chatId);
}

/** `GET /api/chats/:chatId/memory/jobs` — the newest extraction job's state. */
export async function memoryJobsRoute(req: Request, env: Env, chatId: string): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return listMemoryJobs(env, chatId);
}

/** `POST /api/memory/facts` — a fact the reader wrote by hand. */
export async function factRoute(req: Request, env: Env): Promise<Response> {
  return createFact(env, req);
}

/** `PATCH`/`DELETE /api/memory/(facts|summaries)/:id`. */
export async function memoryEntryRoute(req: Request, env: Env, kind: string, id: string): Promise<Response> {
  return mutateMemory(env, req, kind, id);
}
