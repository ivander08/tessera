import { json, notFound } from '../http';
import { getCharacter } from '../db';
import {
  createCharacter,
  deleteCharacter,
  deleteCharacterAvatar,
  forkCharacter,
  getAvatar,
  getCharacterDetail,
  listCharacters,
  updateCharacter,
} from '../characters';

/** `GET`/`POST /api/characters`. */
export async function charactersRoute(req: Request, env: Env): Promise<Response> {
  const method = req.method;
  if (method === 'GET') return listCharacters(env);
  if (method === 'POST') return createCharacter(env, req);
  return notFound();
}

/** `POST /api/characters/fork` — the card editor's copy of an existing card. */
export async function forkRoute(req: Request, env: Env): Promise<Response> {
  return forkCharacter(env, req);
}

/** `GET /api/characters/:id/openings` — the picker on the character screen. */
export async function openingsRoute(env: Env, characterId: string): Promise<Response> {
  const character = await getCharacter(env, characterId);
  if (!character) return notFound('character not found');

  const card = JSON.parse(character.card_json) as {
    firstMes?: string;
    alternateGreetings?: string[];
  };

  const openings = [card.firstMes ?? '', ...(card.alternateGreetings ?? [])]
    .map((content, index) => ({ index, content }))
    .filter((entry) => entry.content.trim().length > 0);

  return json(openings);
  }

/** `GET`/`DELETE /api/characters/:id/avatar`. */
export async function avatarRoute(req: Request, env: Env, id: string): Promise<Response> {
  const method = req.method;
  const avatarId = id;
  if (method === 'GET') return getAvatar(env, avatarId);
  if (method === 'DELETE') return deleteCharacterAvatar(env, avatarId);
  return notFound();
}

/** `POST /api/characters/:id/fork`. */
export async function characterForkRoute(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return notFound();
  return forkCharacter(env, req);
}

/** `GET`/`PATCH`/`DELETE /api/characters/:id`. */
export async function characterRoute(req: Request, env: Env, id: string): Promise<Response> {
  const method = req.method;
  const characterId = id;
  if (method === 'GET') return getCharacterDetail(env, characterId);
  if (method === 'PATCH') return updateCharacter(env, req);
  if (method === 'DELETE') return deleteCharacter(env, characterId);
  return notFound();
}
