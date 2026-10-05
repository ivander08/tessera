import { json, notFound } from '../http';
import { getChat, getCharacter, getPersona as loadPersonaRow } from '../db';
import { loadAlternatives, loadPathTail } from '../branch';
import { getState, patchState, clearState } from '../state/api';
import { chatAdvise } from '../chatAdvise';
import type { WorldState } from '../../../src/lib/state/schema';

/** How many turns the transcript returns when the client does not ask for a window. */
const DEFAULT_WINDOW = 60;
/** A window larger than this is not a window. Keeps one request from reading a chat. */
const MAX_WINDOW = 200;

/**
 * One page of the transcript.
 *
 * The window is served from the END of the visible path, because that is what the reader
 * is looking at and what the client needs first. Paging backwards is the client passing
 * `cursor` â€” the id of the oldest row it already holds â€” which is answered by the same
 * bounded walk rather than by re-reading the chat and slicing.
 */
export async function listMessages(env: Env, chatId: string, url: URL): Promise<Response> {
  const chat = await getChat(env, chatId);
  if (!chat) return notFound('chat not found');

  // A bad query string takes the default rather than failing the request: this is a read
  // of a scene the reader is already in, and a malformed parameter is not worth an error
  // page.
  const asked = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(asked) && asked >= 1
    ? Math.min(Math.floor(asked), MAX_WINDOW)
    : DEFAULT_WINDOW;
  const cursor = url.searchParams.get('cursor');

  // The character rides along so the transcript can show its shown name and avatar
  // without a second round trip on every render.
  const character = chat.character_id ? await getCharacter(env, chat.character_id) : null;
  const persona = chat.persona_id ? await loadPersonaRow(env, chat.persona_id) : null;

  // One row more than asked for, which is how "is there anything older?" is answered
  // without a second COUNT over the whole chat.
  const tail = await loadPathTail(env, chatId, limit + 1, cursor);
  const hasMore = tail.length > limit;
  const path = hasMore ? tail.slice(1) : tail;

  // The versions at each of the returned positions. Bounded by what is on screen â€” a
  // chat with many abandoned branches costs the same as one with none.
  const siblings = await loadAlternatives(
    env,
    chatId,
    path.map((row) => row.parent_id),
  );

  // Only the active chain is returned as the transcript. An abandoned branch is still in
  // the table â€” that is what makes swiping back lossless â€” but it is not part of the
  // scene the reader is in.
  //
  // `swipes` lists every version of a position, which is every row sharing a parent.
  // That includes versions whose own continuation is currently hidden: swiping to one
  // makes it active, and its continuation becomes reachable again with it.
  //
  // A position with exactly one version omits both fields. Measured on a real 617-message
  // chat: 616 of the 617 `swipes` arrays held nothing but the row's own id, which was
  // 32 KB of the response carrying no information. Absent and "length 1" mean the same
  // thing to the client, so the common case pays nothing.
  const messages = path.map((row) => {
    const alternatives = siblings.get(row.parent_id ?? '') ?? [];
    const base = {
      seq: row.seq,
      id: row.id,
      role: row.role,
      content: row.content,
      content_tokens: row.content_tokens,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      cached_tokens: row.cached_tokens,
      cost_usd: row.cost_usd,
      active: row.active,
      created_at: row.created_at,
      speaker: row.speaker,
      // The world state as of this turn, when one was recorded. Null for most rows: state
      // advances on any completed turn that writes the character's prose â€” a send, a
      // regenerate, a recovery continue â€” and only when the exchange changed something.
      state: parseSnapshot(row.state_json),
    };
    if (alternatives.length <= 1) return base;
    return {
      ...base,
      swipes: alternatives.map((entry) => entry.id),
      swipeIndex: alternatives.findIndex((entry) => entry.id === row.id),
    };
  });

  return json({
    chat,
    character: character
      ? {
          id: character.id,
          name: character.name,
          avatar: character.avatar,
          // CCv3's `nickname` is the name the reader sees; `name` is the card's own
          // title, which is often a dated label like "Quill 25/09/2026".
          shownName: readShownName(character.card_json) || character.name,
        }
      : null,
    persona: persona ? { id: persona.id, name: persona.name, avatar: persona.avatar } : null,
    messages,
    hasMore,
    // The cursor for the next page. Null on an empty chat, where there is nothing to page
    // back from.
    oldestId: path[0]?.id ?? null,
  });
}

/**
 * Reads a row's stored state snapshot.
 *
 * Returns null for absent or unreadable JSON rather than throwing: a hand-edited row must
 * not be able to break the whole transcript, and a row with no snapshot is the normal case
 * â€” state advances on a completed turn that writes prose, and only when something changed.
 */
function parseSnapshot(json: string | null): WorldState | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as WorldState)
      : null;
  } catch {
    return null;
  }
}

/** Reads the card's `nickname`, falling back to nothing. Never throws on bad JSON. */
function readShownName(cardJson: string): string {
  try {
    const card = JSON.parse(cardJson) as { nickname?: unknown };
    return typeof card.nickname === 'string' ? card.nickname : '';
  } catch {
    return '';
  }
}

/** `GET`/`PATCH`/`DELETE /api/state/:chatId`. */
export async function stateRoute(req: Request, env: Env, chatId: string): Promise<Response> {
  const method = req.method;
  if (method === 'GET') return getState(env, chatId);
  if (method === 'PATCH') return patchState(env, req);
  if (method === 'DELETE') return clearState(env, chatId);
  return notFound();
}

/** `POST /api/chats/:id/advise` — the craft consultant's read on the scene so far. */
export async function adviseRoute(req: Request, env: Env, chatId: string): Promise<Response> {
  if (req.method !== 'POST') return notFound();
  return chatAdvise(env, req, chatId);
}

export {
  addAlternative,
  deleteMessage,
  editMessage,
  swipeMessage,
} from '../messages';
