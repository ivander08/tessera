import { notFound } from '../http';
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  setChatPersona,
  updatePersona,
} from '../personas';

/** `GET`/`POST`/`PATCH /api/personas`. */
export async function personasRoute(req: Request, env: Env): Promise<Response> {
  const method = req.method;
  if (method === 'GET') return listPersonas(env);
  if (method === 'POST') return createPersona(env, req);
  if (method === 'PATCH') return updatePersona(env, req);
  return notFound();
}

/** `POST /api/persona` — which persona a chat speaks through. */
export async function chatPersonaRoute(req: Request, env: Env): Promise<Response> {
  return setChatPersona(env, req);
}

/** `GET`/`DELETE /api/personas/:id`. */
export async function personaRoute(req: Request, env: Env, id: string): Promise<Response> {
  const method = req.method;
  const personaId = id;
  if (method === 'GET') return getPersona(env, personaId);
  if (method === 'DELETE') return deletePersona(env, personaId);
  return notFound();
}
