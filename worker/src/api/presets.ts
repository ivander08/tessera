import { notFound } from '../http';
import {
  applyPresetToChat,
  createPreset,
  deletePreset,
  duplicatePreset,
  getChatPreset,
  getPreset,
  listPresets,
  updatePreset,
} from '../presets';

/** `GET`/`POST /api/presets`. */
export async function presetsRoute(req: Request, env: Env): Promise<Response> {
  const method = req.method;
  if (method === 'GET') return listPresets(env);
  if (method === 'POST') return createPreset(env, req);
  return notFound();
}

/** `POST /api/presets/duplicate`. */
export async function duplicatePresetRoute(req: Request, env: Env): Promise<Response> {
  return duplicatePreset(env, req);
}

/** `POST /api/preset/apply` — applies a preset's knobs to one chat. */
export async function applyPresetRoute(req: Request, env: Env): Promise<Response> {
  return applyPresetToChat(env, req);
}

/** `GET`/`PATCH`/`DELETE /api/presets/:id`. */
export async function presetRoute(req: Request, env: Env, id: string): Promise<Response> {
  const method = req.method;
  const presetId = id;
  if (method === 'GET') return getPreset(env, presetId);
  if (method === 'PATCH') return updatePreset(env, req);
  if (method === 'DELETE') return deletePreset(env, presetId);
  return notFound();
}

/** `GET /api/chats/:chatId/preset`. */
export async function chatPresetRoute(env: Env, chatId: string): Promise<Response> {
  return getChatPreset(env, chatId);
}
