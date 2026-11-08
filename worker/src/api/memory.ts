import { notFound } from '../http';
import {
  assistMemoryRoute,
  compactApplyRoute,
  compactRoute,
  createFact,
  listMemory,
  listMemoryJobs,
  mutateMemory,
} from '../memory/api';

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

/** `POST /api/chats/:chatId/memory/assist` — the memory box's AI helper. */
export async function memoryAssistRoute(
  req: Request,
  env: Env,
  chatId: string,
): Promise<Response> {
  if (req.method !== 'POST') return notFound();
  return assistMemoryRoute(env, req, chatId);
}

/** `POST /api/chats/:chatId/memory/compact` — propose a fact-store cleanup. */
export async function memoryCompactRoute(
  req: Request,
  env: Env,
  chatId: string,
): Promise<Response> {
  if (req.method !== 'POST') return notFound();
  return compactRoute(env, chatId);
}

/** `POST /api/chats/:chatId/memory/compact/apply` — apply the reviewed proposal. */
export async function memoryCompactApplyRoute(
  req: Request,
  env: Env,
  chatId: string,
): Promise<Response> {
  if (req.method !== 'POST') return notFound();
  return compactApplyRoute(env, req, chatId);
}
