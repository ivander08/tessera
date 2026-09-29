import { isAuthorized, unauthorized } from './auth';
import { preflight, withCors } from './cors';
import { badRequest, json, notFound, readJson } from './http';
import { getChat, getCharacter, getSettings, putSetting } from './db';
import { loadProviderKey, storeProviderKey } from './keys';
import { getProvider } from './providers';
import { handleChat } from './chat';
import {
  createCharacter,
  deleteCharacter,
  getAvatar,
  listCharacters,
} from './characters';
import { createFact, listMemory, mutateMemory } from './memory/api';
import { deletePreset, getPreset, importPreset, listPresets } from './presets';
import { onWorkerWake } from './jobs';

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

  const avatarMatch = /^\/api\/characters\/([^/]+)\/avatar$/.exec(path);
  if (avatarMatch) {
    if (method !== 'GET') return notFound();
    return getAvatar(env, decodeURIComponent(avatarMatch[1]));
  }

  const characterMatch = /^\/api\/characters\/([^/]+)$/.exec(path);
  if (characterMatch) {
    if (method !== 'DELETE') return notFound();
    return deleteCharacter(env, decodeURIComponent(characterMatch[1]));
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

  const presetMatch = /^\/api\/presets\/([^/]+)$/.exec(path);
  if (presetMatch) {
    const presetId = decodeURIComponent(presetMatch[1]);
    if (method === 'GET') return getPreset(env, presetId);
    if (method === 'DELETE') return deletePreset(env, presetId);
    return notFound();
  }

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
  const body = await readJson<{ characterId?: string; personaId?: string; title?: string }>(req);
  if (!body?.characterId) return badRequest('characterId required');

  const character = await getCharacter(env, body.characterId);
  if (!character) return notFound('character not found');

  const now = Date.now();
  const id = crypto.randomUUID();
  const card = JSON.parse(character.card_json) as { firstMes?: string };

  await env.DB.prepare(
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      body.characterId,
      body.personaId ?? null,
      body.title ?? character.name,
      // Minted once and reused for the chat's life. Without it OpenRouter only
      // pins a provider AFTER it has already seen a cache hit — the turn that missed.
      crypto.randomUUID(),
      now,
      now,
    )
    .run();

  // The card's first greeting becomes the chat's first assistant message.
  if (card.firstMes) {
    await env.DB.prepare(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
       VALUES (?, ?, NULL, 'assistant', ?, ?)`,
    )
      .bind(crypto.randomUUID(), id, card.firstMes, now)
      .run();
  }

  return json(await getChat(env, id), 201);
}

async function listMessages(env: Env, chatId: string): Promise<Response> {
  const chat = await getChat(env, chatId);
  if (!chat) return notFound('chat not found');
  const { results } = await env.DB.prepare(
    `SELECT seq, id, role, content, content_tokens, prompt_tokens, completion_tokens,
            cached_tokens, cost_usd, created_at
       FROM messages WHERE chat_id = ? ORDER BY seq`,
  )
    .bind(chatId)
    .all();
  return json({ chat, messages: results });
}

async function listModels(env: Env, providerId: string): Promise<Response> {
  const provider = getProvider(providerId);
  if (!provider) return notFound('unknown provider');

  const key = await loadProviderKey(env, providerId);
  const url =
    providerId === 'openrouter'
      ? 'https://openrouter.ai/api/v1/models'
      : 'https://kenari.id/v1/models';

  const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!res.ok) return json({ error: provider.readError(res.status, await res.text()) }, 502);

  // OpenRouter passes through `supported_parameters`; Kenari passes through
  // `pricing`. The client uses both to grey out knobs a model cannot honour.
  const payload = (await res.json()) as { data?: unknown };
  return json(Array.isArray(payload.data) ? payload.data : []);
}
