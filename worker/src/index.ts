import { isAuthorized, unauthorized } from './auth';
import { preflight, withCors } from './cors';
import { badRequest, json, notFound, readJson } from './http';
import { getChat, getCharacter, getPersona as loadPersonaRow, getSettings, putSetting, putSettings } from './db';
import { loadProviderKey, storeProviderKey } from './keys';
import { getProvider } from './providers';
import { handleChat } from './chat';
import {
  createCharacter,
  deleteCharacter,
  deleteCharacterAvatar,
  forkCharacter,
  getAvatar,
  getCharacterDetail,
  listCharacters,
  updateCharacter,
} from './characters';
import { createFact, listMemory, mutateMemory } from './memory/api';
import {
  addAlternative,
  deleteMessage,
  editMessage,
  swipeMessage,
} from './messages';
import {
  applyPresetToChat,
  deletePreset,
  duplicatePreset,
  getChatPreset,
  getPreset,
  createPreset,
  listPresets,
  updatePreset,
} from './presets';
import { clearState, getState, patchState } from './state/api';
import { getSceneSetup, patchSceneSetup, loadSceneSetup } from './scene';
import { addCast, listCast, promoteCast, removeCast } from './castApi';
import { searchChat } from './search';
import { exportChat } from './export';
import { seedOpeningState } from './state/update';
import { loadAlternatives, loadPathTail } from './branch';
import { substituteHead } from '../../src/lib/prompt/macros';
import { asRecord, asString } from '../../src/lib/json';
import { EMPTY_STATE, validatePatch } from '../../src/lib/state/schema';
import type { WorldState } from '../../src/lib/state/schema';
import { forgeConsult } from './forge/api';
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  setChatPersona,
  updatePersona,
} from './personas';
import { onWorkerWake } from './jobs';
import { runPendingMemoryJob } from './memory/schedule';
import { complete } from './cheap';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get('origin');

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

    // Answered before the auth check: a preflight carries no `Authorization` header by
    // design, so routing it through `isAuthorized` would 401 every one of them and the
    // native shells would never be able to make a request at all.
    const preflightResponse = preflight(req, origin);
    if (preflightResponse) return preflightResponse;

    // M4: reclaim any job whose owner was evicted mid-generation. Memoized per
    // isolate, so this costs one UPDATE on a cold start and nothing thereafter.
    // `waitUntil` because the sweep must not delay the user's request, and must not
    // be cancelled the moment the response is returned.
    ctx.waitUntil(onWorkerWake(env));
    // One memory job per cold start, if any is queued. Bounded deliberately: draining a
    // backlog here would compete with the request that triggered the wake.
    ctx.waitUntil(runPendingMemoryJob(env));

    // The sole unauthenticated route, so a probe cannot leak whether a token exists.
    if (path === '/api/health') {
      if (req.method !== 'GET') return notFound();
      return withCors(json({ ok: true, app: env.APP_NAME }), origin);
    }

    if (!(await isAuthorized(req, env))) return withCors(unauthorized(), origin);

    try {
      return withCors(await route(req, env, url, ctx), origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return withCors(json({ error: message }, 500), origin);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/settings') {
    if (method === 'GET') return json(await getSettings(env));
    if (method === 'PUT') {
      const body = await readJson<{ key?: unknown; value?: unknown; settings?: unknown }>(req);

      // The map form is what the settings screen sends: eleven keys, one request, one D1
      // batch. The single-key form stays because it is the natural shape for one setting
      // (the theme panel's autosave, the eval harness) and rewriting those callers would
      // trade a clear request for a wrapper object.
      if (body?.settings !== undefined) {
        const entries = asSettingsMap(body.settings);
        if (typeof entries === 'string') return badRequest(entries);
        await putSettings(env, entries);
        return json({ ok: true, written: entries.length });
      }

      const key = asString(body?.key);
      if (key.length === 0 || typeof body?.value !== 'string') {
        return badRequest('key and value required');
      }
      await putSetting(env, key, body.value);
      return json({ ok: true, written: 1 });
    }
    return notFound();
  }

  if (path === '/api/keys' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT provider, updated_at FROM provider_keys ORDER BY provider',
    ).all<{ provider: string; updated_at: number }>();
    // Never returns key material.
    return json(results);
  }

  const keyMatch = /^\/api\/keys\/([a-z0-9_-]+)$/.exec(path);
  if (keyMatch) {
    const provider = keyMatch[1];
    if (!getProvider(provider)) return notFound('unknown provider');
    if (method === 'PUT') {
      const body = await readJson<{ key?: string }>(req);
      if (!body?.key) return badRequest('key required');
      await storeProviderKey(env, provider, body.key);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM provider_keys WHERE provider = ?').bind(provider).run();
      return json({ ok: true });
    }
    return notFound();
  }

  const modelsMatch = /^\/api\/models\/([a-z0-9_-]+)$/.exec(path);
  if (modelsMatch) {
    if (method !== 'GET') return notFound();
    return listModels(env, modelsMatch[1]);
  }

  if (path === '/api/characters') {
    if (method === 'GET') return listCharacters(env);
    if (method === 'POST') return createCharacter(env, req);
    return notFound();
  }

  // Order matters: `/api/characters/fork` and `/:id/fork` must match BEFORE the bare
  // `:id` route, or "fork" is captured as a character id and 404s.
  if (path === '/api/characters/fork' && method === 'POST') return forkCharacter(env, req);

  const openingsMatch = /^\/api\/characters\/([^/]+)\/openings$/.exec(path);
  if (openingsMatch) {
    if (method !== 'GET') return notFound();
    return listOpenings(env, decodeURIComponent(openingsMatch[1]));
  }

  const avatarMatch = /^\/api\/characters\/([^/]+)\/avatar$/.exec(path);
  if (avatarMatch) {
    const avatarId = decodeURIComponent(avatarMatch[1]);
    if (method === 'GET') return getAvatar(env, avatarId);
    if (method === 'DELETE') return deleteCharacterAvatar(env, avatarId);
    return notFound();
  }

  const forkMatch = /^\/api\/characters\/([^/]+)\/fork$/.exec(path);
  if (forkMatch) {
    if (method !== 'POST') return notFound();
    return forkCharacter(env, req);
  }

  const characterMatch = /^\/api\/characters\/([^/]+)$/.exec(path);
  if (characterMatch) {
    const characterId = decodeURIComponent(characterMatch[1]);
    if (method === 'GET') return getCharacterDetail(env, characterId);
    if (method === 'PATCH') return updateCharacter(env, req);
    if (method === 'DELETE') return deleteCharacter(env, characterId);
    return notFound();
  }

  if (path === '/api/chats') {
    if (method === 'GET') return listChats(env);
    if (method === 'POST') return createChat(env, req, ctx);
    return notFound();
  }

  const messagesMatch = /^\/api\/chats\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch) {
    if (method !== 'GET') return notFound();
    return listMessages(env, decodeURIComponent(messagesMatch[1]), url);
  }

  const stateMatch = /^\/api\/state\/([^/]+)$/.exec(path);
  if (stateMatch) {
    const stateChatId = decodeURIComponent(stateMatch[1]);
    if (method === 'GET') return getState(env, stateChatId);
    if (method === 'PATCH') return patchState(env, req);
    if (method === 'DELETE') return clearState(env, stateChatId);
    return notFound();
  }

  const sceneMatch = /^\/api\/chats\/([^/]+)\/scene$/.exec(path);
  if (sceneMatch) {
    const sceneChatId = decodeURIComponent(sceneMatch[1]);
    if (method === 'GET') return getSceneSetup(env, sceneChatId);
    if (method === 'PATCH') return patchSceneSetup(env, sceneChatId, req);
    return notFound();
  }

  const castMatch = /^\/api\/chats\/([^/]+)\/cast$/.exec(path);
  if (castMatch) {
    const castChatId = decodeURIComponent(castMatch[1]);
    if (method === 'GET') return listCast(env, castChatId);
    if (method === 'POST') return addCast(env, castChatId, req);
    return notFound();
  }

  // Before the bare `/cast/:id` route, or "promote" is captured as a cast id.
  const promoteMatch = /^\/api\/chats\/([^/]+)\/cast\/([^/]+)\/promote$/.exec(path);
  if (promoteMatch) {
    if (method !== 'POST') return notFound();
    return promoteCast(env, decodeURIComponent(promoteMatch[1]), decodeURIComponent(promoteMatch[2]), req);
  }

  const castMemberMatch = /^\/api\/chats\/([^/]+)\/cast\/([^/]+)$/.exec(path);
  if (castMemberMatch) {
    const castChatId = decodeURIComponent(castMemberMatch[1]);
    const memberId = decodeURIComponent(castMemberMatch[2]);
    if (method === 'DELETE') return removeCast(env, castChatId, memberId);
    return notFound();
  }

  const searchMatch = /^\/api\/chats\/([^/]+)\/search$/.exec(path);
  if (searchMatch) {
    if (method !== 'GET') return notFound();
    return searchChat(env, decodeURIComponent(searchMatch[1]), url);
  }

  const exportMatch = /^\/api\/chats\/([^/]+)\/export$/.exec(path);
  if (exportMatch) {
    if (method !== 'GET') return notFound();
    return exportChat(env, decodeURIComponent(exportMatch[1]), url);
  }

  if (path === '/api/personas') {
    if (method === 'GET') return listPersonas(env);
    if (method === 'POST') return createPersona(env, req);
    if (method === 'PATCH') return updatePersona(env, req);
    return notFound();
  }

  if (path === '/api/persona' && method === 'POST') return setChatPersona(env, req);

  const personaMatch = /^\/api\/personas\/([^/]+)$/.exec(path);
  if (personaMatch) {
    const personaId = decodeURIComponent(personaMatch[1]);
    if (method === 'GET') return getPersona(env, personaId);
    if (method === 'DELETE') return deletePersona(env, personaId);
    return notFound();
  }

  if (path === '/api/message/swipe' && method === 'POST') return swipeMessage(env, req);
  if (path === '/api/message/edit' && method === 'POST') return editMessage(env, req);
  if (path === '/api/message/delete' && method === 'POST') return deleteMessage(env, req);
  if (path === '/api/message/alternative' && method === 'POST') return addAlternative(env, req);

  const memoryMatch = /^\/api\/chats\/([^/]+)\/memory$/.exec(path);
  if (memoryMatch && method === 'GET') {
    return listMemory(env, decodeURIComponent(memoryMatch[1]));
  }

  if (path === '/api/memory/facts' && method === 'POST') return createFact(env, req);

  const memoryEntryMatch = /^\/api\/memory\/(facts|summaries)\/([^/]+)$/.exec(path);
  if (memoryEntryMatch) {
    return mutateMemory(
      env,
      req,
      memoryEntryMatch[1],
      decodeURIComponent(memoryEntryMatch[2]),
    );
  }

  const chatDetailMatch = /^\/api\/chats\/([^/]+)$/.exec(path);
  if (chatDetailMatch) {
    if (method !== 'DELETE') return notFound();
    await env.DB.prepare('DELETE FROM chats WHERE id = ?')
      .bind(decodeURIComponent(chatDetailMatch[1]))
      .run();
    return json({ ok: true });
  }

  if (path === '/api/presets') {
    if (method === 'GET') return listPresets(env);
    if (method === 'POST') return createPreset(env, req);
    return notFound();
  }

  if (path === '/api/presets/duplicate' && method === 'POST') return duplicatePreset(env, req);
  if (path === '/api/preset/apply' && method === 'POST') return applyPresetToChat(env, req);

  const presetMatch = /^\/api\/presets\/([^/]+)$/.exec(path);
  if (presetMatch) {
    const presetId = decodeURIComponent(presetMatch[1]);
    if (method === 'GET') return getPreset(env, presetId);
    if (method === 'PATCH') return updatePreset(env, req);
    if (method === 'DELETE') return deletePreset(env, presetId);
    return notFound();
  }

  const chatPresetMatch = /^\/api\/chats\/([^/]+)\/preset$/.exec(path);
  if (chatPresetMatch && method === 'GET') {
    return getChatPreset(env, decodeURIComponent(chatPresetMatch[1]));
  }

  if (path === '/api/forge/consult' && method === 'POST') return forgeConsult(env, req);

  if (path === '/api/chat' && method === 'POST') return handleChat(req, env, ctx);

  // The eval harness's rating call. It needs a model call but no provider credentials of
  // its own, so it goes through the Worker's configured cheap model like every other
  // side-channel. It exposes no data — a caller supplies the system and user text and gets
  // a completion back — and it carries the same bearer auth as every other route.
  if (path === '/api/eval/judge' && method === 'POST') {
    const body = await readJson<{ system?: string; user?: string }>(req);
    if (!body || typeof body.user !== 'string' || body.user.length === 0) {
      return badRequest('user is required');
    }
    try {
      const reply = await complete(env, {
        system: typeof body.system === 'string' ? body.system : undefined,
        user: body.user,
        maxTokens: 1200,
        json: true,
      });
      return json({ text: reply.text });
    } catch (error) {
      // The harness must be able to record a rating failure per scenario rather than
      // aborting the whole run, so the message comes back as a 200-shaped error body the
      // script can catch and skip.
      return json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  return notFound();
}

async function listChats(env: Env): Promise<Response> {
  // The preview is the last message the reader can actually SEE, not the last row
  // written. `ORDER BY seq DESC` would show a reply from an abandoned branch — text that
  // is not on screen — which is exactly the confusion branching exists to avoid.
  //
  // "Last row with no active child" is not the same thing: after a swipe back, the
  // abandoned continuation keeps `active = 1` on its rows, so its leaf is still an active
  // row with no active child and it would win. The walk below is the same walk the
  // transcript uses — down from the active root, newest active child at each step — and
  // the preview is its last row.
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE path(chat_id, seq, id, parent_id, content, depth) AS (
       SELECT c.id, m.seq, m.id, m.parent_id, m.content, 0
         FROM chats c
         JOIN messages m
           ON m.chat_id = c.id AND m.parent_id IS NULL AND m.active = 1 AND m.deleted = 0
       UNION ALL
       SELECT path.chat_id, m.seq, m.id, m.parent_id, m.content, path.depth + 1
         FROM path
         JOIN messages m ON m.chat_id = path.chat_id AND m.parent_id = path.id
        WHERE m.active = 1
          AND m.deleted = 0
          AND m.seq = (
            SELECT MAX(c2.seq) FROM messages c2
             WHERE c2.chat_id = path.chat_id AND c2.parent_id = path.id
               AND c2.active = 1 AND c2.deleted = 0
          )
     )
     SELECT c.id, c.title, c.updated_at, c.character_id,
            ch.name AS character_name, ch.avatar AS character_avatar,
            (SELECT substr(p.content, 1, 140) FROM path p
              WHERE p.chat_id = c.id
              ORDER BY p.depth DESC LIMIT 1) AS preview
       FROM chats c
       LEFT JOIN characters ch ON ch.id = c.character_id
      ORDER BY c.updated_at DESC`,
  ).all();
  return json(results);
}

async function createChat(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{
    characterId?: string;
    personaId?: string;
    title?: string;
    /** Which opening to start from: 0 is `first_mes`, then the alternates in order. */
    greetingIndex?: number;
  }>(req);
  if (!body?.characterId) return badRequest('characterId required');

  const character = await getCharacter(env, body.characterId);
  if (!character) return notFound('character not found');

  const now = Date.now();
  const id = crypto.randomUUID();
  const card = JSON.parse(character.card_json) as {
    firstMes?: string;
    alternateGreetings?: string[];
    greetingStates?: Array<{ time?: string; location?: string; weather?: string }>;
    nickname?: string;
    description?: string;
  };

  await env.DB.prepare(
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      body.characterId,
      body.personaId ?? null,
      // The chat's own title is the card's title, not the shown name — the library lists
      // chats by the card, while the transcript calls the character by their nickname.
      body.title ?? character.name,
      // Minted once and reused for the chat's life. Without it OpenRouter only
      // pins a provider AFTER it has already seen a cache hit — the turn that missed.
      crypto.randomUUID(),
      now,
      now,
    )
    .run();

  // Which opening the scene starts from. Index 0 is `first_mes`; the alternates follow in
  // their stored order, which is the order the card editor lets you arrange them in.
  //
  // Macros are substituted HERE, at the point the text is stored, because the stored
  // value is what the reader sees. Substituting only on the way to the model left the
  // reader looking at a literal `{{user}}` in the opening line — the one message that is
  // guaranteed to be read. The persona is fixed for the chat's life, so baking it in
  // here cannot go stale.
  // Each opening with the scene the card gives it. Zipped BEFORE the empty filter, so an
  // opening that is dropped takes its own scene with it instead of shifting every later
  // scene onto the wrong opening. The state list is index-aligned with the card's own
  // `[firstMes, ...alternateGreetings]`; carrying the scene alongside the content means
  // the pick below cannot select one opening's prose and another's scene.
  const candidates = [card.firstMes ?? '', ...(card.alternateGreetings ?? [])].map(
    (content, index) => ({ content, state: card.greetingStates?.[index] ?? null }),
  );
  const openings = candidates.filter((entry) => entry.content.trim().length > 0);
  const picked = openings[body.greetingIndex ?? 0] ?? openings[0];
  const chosen = picked?.content;

  if (chosen) {
    const persona = body.personaId ? await loadPersonaRow(env, body.personaId) : null;
    // The shown name is what the narrator should call itself, so `{{char}}` resolves to
    // the nickname when there is one — otherwise a card titled "Quill 25/09/2026" would
    // have the character introduce itself by a date.
    const greeting = substituteHead(chosen, {
      char: card.nickname || character.name,
      user: persona?.name ?? null,
      persona: persona?.name ?? null,
    });

    const greetingId = crypto.randomUUID();
    // The opening's own scene, when the card states one. A card can carry an entry with
    // every field blank — the editor writes `{}` for an opening the reader gave no scene —
    // and that is "nothing stated", not "a scene of empty strings": it must not skip the
    // model seed, and it must not put empty fields into the document.
    const stated = Object.entries(picked?.state ?? {}).filter(
      ([, value]) => typeof value === 'string' && value.trim().length > 0,
    );
    const openingStatePatch = stated.length > 0 ? Object.fromEntries(stated) : null;

    await env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
       VALUES (?, ?, NULL, 'assistant', ?, ?)`,
    )
      .bind(greetingId, id, greeting, now)
      .run();

    // A card that states its opening scene is taken at its word: the reader wrote the
    // time and place themselves, so asking a model to infer them from the greeting would
    // spend a call to overwrite an answer with a guess. The values are applied through
    // `validatePatch`, the same choke point every other state write uses, and attached to
    // the greeting row so the first turn can show its scene line.
    const explicit = openingStatePatch ? validatePatch({ ...EMPTY_STATE }, openingStatePatch) : null;

    if (explicit?.ok) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO state (chat_id, json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        ).bind(id, JSON.stringify(explicit.next), now),
        env.DB.prepare('UPDATE messages SET state_json = ? WHERE id = ?')
          .bind(JSON.stringify(explicit.next), greetingId),
      ]);
    } else {
      // The opening seed, if the reader asked for it. Behind `waitUntil` so creating a chat
      // does not wait on a model call, and failing silently: a scene with no opening state
      // is perfectly workable, and the first completed turn will establish one anyway.
      //
      // The greeting is substituted BEFORE it is passed, so the seed reads the same text
      // the reader sees rather than a literal `{{user}}`.
      ctx.waitUntil(
        loadSceneSetup(env, id)
          .then((setup) => {
            if (!setup.generateOpeningState) return { applied: false, reason: 'disabled' };
            return seedOpeningState(
              env,
              id,
              greeting,
              {
                name: card.nickname || character.name,
                description: typeof card.description === 'string' ? card.description : '',
              },
              setup,
            );
          })
          .catch((error: unknown) => {
            console.warn(`[state] opening seed failed for chat=${id}: ${String(error)}`);
          }),
      );
    }
  }

  return json(await getChat(env, id), 201);
}

/** The openings a chat could start from, for the picker on the character screen. */
async function listOpenings(env: Env, characterId: string): Promise<Response> {
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

/** How many turns the transcript returns when the client does not ask for a window. */
const DEFAULT_WINDOW = 60;
/** A window larger than this is not a window. Keeps one request from reading a chat. */
const MAX_WINDOW = 200;

/**
 * One page of the transcript.
 *
 * The window is served from the END of the visible path, because that is what the reader
 * is looking at and what the client needs first. Paging backwards is the client passing
 * `cursor` — the id of the oldest row it already holds — which is answered by the same
 * bounded walk rather than by re-reading the chat and slicing.
 */
async function listMessages(env: Env, chatId: string, url: URL): Promise<Response> {
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

  // The versions at each of the returned positions. Bounded by what is on screen — a
  // chat with many abandoned branches costs the same as one with none.
  const siblings = await loadAlternatives(
    env,
    chatId,
    path.map((row) => row.parent_id),
  );

  // Only the active chain is returned as the transcript. An abandoned branch is still in
  // the table — that is what makes swiping back lossless — but it is not part of the
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
      // only advances on a completed `send`, and only when something actually changed.
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
 * — state only advances on a completed turn, and only when something changed.
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

/**
 * A settings map from the wire, or the reason it is not one.
 *
 * Every value must be a string, because that is what the column holds and what every
 * reader of it expects: a number that arrived as a JSON number would be stored as `5`
 * and read back as `"5"` by some paths and `5` by others. Rejecting the whole map is
 * deliberate — a partial write would leave the form half-saved, which is the failure the
 * batch exists to prevent.
 */
function asSettingsMap(value: unknown): Array<{ key: string; value: string }> | string {
  const record = asRecord(value);
  if (!record) return 'settings must be an object of key/value strings';

  const entries: Array<{ key: string; value: string }> = [];
  for (const [key, entry] of Object.entries(record)) {
    if (key.length === 0) return 'settings keys must not be empty';
    if (typeof entry !== 'string') return `setting "${key}" must be a string`;
    entries.push({ key, value: entry });
  }
  if (entries.length === 0) return 'settings must not be empty';
  return entries;
}

async function listModels(env: Env, providerId: string): Promise<Response> {
  const provider = getProvider(providerId);
  if (!provider) return notFound('unknown provider');

  const key = await loadProviderKey(env, providerId);
  const url =
    providerId === 'openrouter'
      ? 'https://openrouter.ai/api/v1/models'
      : 'https://kenari.id/v1/models';

  // The model list is public on both providers, so a missing or undecryptable key
  // still returns the list — the settings screen needs it to offer a model at all.
  const res = await fetch(url, {
    headers: key.ok ? { Authorization: `Bearer ${key.key}` } : {},
  });
  if (!res.ok) return json({ error: provider.readError(res.status, await res.text()) }, 502);

  // OpenRouter passes through `supported_parameters`; Kenari passes through
  // `pricing`. The client uses both to grey out knobs a model cannot honour.
  const payload = (await res.json()) as { data?: unknown };
  return json(Array.isArray(payload.data) ? payload.data : []);
}
