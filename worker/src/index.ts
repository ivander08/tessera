import { isAuthorized, unauthorized } from './auth';
import { preflight, withCors } from './cors';
import { badRequest, json, notFound, readJson } from './http';
import { getChat, getCharacter, getPersona as loadPersonaRow, getSettings, putSetting } from './db';
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
  importPreset,
  listPresets,
  updatePreset,
} from './presets';
import { clearState, getState, patchState } from './state/api';
import { loadBranchRows, walkPath } from './branch';
import type { BranchRow } from './branch';
import { substituteHead } from '../../src/lib/prompt/macros';
import {
  forgeCards,
  forgeCritique,
  forgeDraft,
  forgeSmuggle,
  forgeSuggest,
  forgeTokens,
} from './forge/api';
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
      const body = await readJson<{ key?: string; value?: string }>(req);
      if (!body?.key || typeof body.value !== 'string') return badRequest('key and value required');
      await putSetting(env, body.key, body.value);
      return json({ ok: true });
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
    if (method === 'POST') return createChat(env, req);
    return notFound();
  }

  const messagesMatch = /^\/api\/chats\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch) {
    if (method !== 'GET') return notFound();
    return listMessages(env, decodeURIComponent(messagesMatch[1]));
  }

  const stateMatch = /^\/api\/state\/([^/]+)$/.exec(path);
  if (stateMatch) {
    const stateChatId = decodeURIComponent(stateMatch[1]);
    if (method === 'GET') return getState(env, stateChatId);
    if (method === 'PATCH') return patchState(env, req);
    if (method === 'DELETE') return clearState(env, stateChatId);
    return notFound();
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
    if (method === 'POST') return importPreset(env, req);
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

  if (path === '/api/forge/cards' && method === 'GET') return forgeCards(env);
  if (path === '/api/forge/draft' && method === 'POST') return forgeDraft(env, req);
  if (path === '/api/forge/critique' && method === 'POST') return forgeCritique(env, req);
  if (path === '/api/forge/smuggle' && method === 'POST') return forgeSmuggle(env, req);
  if (path === '/api/forge/tokens' && method === 'POST') return forgeTokens(env, req);
  if (path === '/api/forge/suggest' && method === 'POST') return forgeSuggest(env, req);

  if (path === '/api/chat' && method === 'POST') return handleChat(req, env, ctx);

  return notFound();
}

async function listChats(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.title, c.updated_at, c.character_id,
            ch.name AS character_name, ch.avatar AS character_avatar,
            (SELECT substr(m.content, 1, 140) FROM messages m
              WHERE m.chat_id = c.id ORDER BY m.seq DESC LIMIT 1) AS preview
       FROM chats c
       LEFT JOIN characters ch ON ch.id = c.character_id
      ORDER BY c.updated_at DESC`,
  ).all();
  return json(results);
}

async function createChat(env: Env, req: Request): Promise<Response> {
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
    nickname?: string;
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
  const openings = [card.firstMes ?? '', ...(card.alternateGreetings ?? [])].filter(
    (entry) => entry.trim().length > 0,
  );
  const chosen = openings[body.greetingIndex ?? 0] ?? openings[0];

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

    await env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
       VALUES (?, ?, NULL, 'assistant', ?, ?)`,
    )
      .bind(crypto.randomUUID(), id, greeting, now)
      .run();
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

async function listMessages(env: Env, chatId: string): Promise<Response> {
  const chat = await getChat(env, chatId);
  if (!chat) return notFound('chat not found');

  // The character rides along so the transcript can show its shown name and avatar
  // without a second round trip on every render.
  const character = chat.character_id ? await getCharacter(env, chat.character_id) : null;
  const persona = chat.persona_id ? await loadPersonaRow(env, chat.persona_id) : null;

  const rows = await loadBranchRows(env, chatId);
  const path = walkPath(rows);

  // Alternatives per position, so the client can render swipe arrows and swipe back
  // without a round trip per direction. Siblings share a parent, which is what makes a
  // position a position rather than a sequence.
  const siblings = new Map<string | null, BranchRow[]>();
  for (const row of rows) {
    const key = row.parent_id ?? null;
    const list = siblings.get(key);
    if (list) list.push(row);
    else siblings.set(key, [row]);
  }

  // Only the active chain is returned as the transcript. An abandoned branch is still in
  // the table — that is what makes swiping back lossless — but it is not part of the
  // scene the reader is in.
  //
  // `swipes` lists every version of a position, which is every row sharing a parent.
  // That includes versions whose own continuation is currently hidden: swiping to one
  // makes it active, and its continuation becomes reachable again with it.
  const messages = path.map((row) => {
    const alternatives = siblings.get(row.parent_id ?? null) ?? [];
    return {
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
    persona: persona ? { id: persona.id, name: persona.name } : null,
    messages,
  });
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
