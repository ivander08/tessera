import { isAuthorized, unauthorized } from './auth';
import { preflight, withCors } from './cors';
import { json, notFound } from './http';
import { getProvider } from './providers';
import { handleChat } from './chat';
import { onWorkerWake } from './jobs';
import { runPendingMemoryJob } from './memory/schedule';
import {
  chatPersonaRoute,
  personaRoute,
  personasRoute,
} from './api/personas';
import {
  applyPresetRoute,
  chatPresetRoute,
  duplicatePresetRoute,
  presetRoute,
  presetsRoute,
} from './api/presets';
import { castMemberRoute, castRoute, promoteRoute } from './api/cast';
import { charactersRoute, avatarRoute, characterForkRoute, characterRoute, forkRoute, openingsRoute } from './api/characters';
import {
  addAlternative,
  adviseRoute,
  deleteMessage,
  editMessage,
  listMessages,
  stateRoute,
  swipeMessage,
} from './api/chat';
import { chatsRoute } from './api/chats';
import { evalJudgeRoute } from './api/eval';
import { exportRoute } from './api/export';
import { forgeRoute } from './api/forge';
import { factRoute, memoryEntryRoute, memoryRoute } from './api/memory';
import { sceneRoute } from './api/scene';
import { searchRoute } from './api/search';
import {
  listProviderKeys,
  modelsRoute,
  providerKeyRoute,
  settingsRoute,
} from './api/shared';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get('origin');

    // Everything outside `/api/*` is the SPA's own asset tree. In the Worker runtime that
    // is the `ASSETS` binding; the self-hosted server answers the same call from `dist/`.
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

    // Answered before the auth check: a preflight carries no `Authorization` header by
    // design, so routing it through `isAuthorized` would 401 every one of them and the
    // dev SPA — the one caller that crosses origins — could never make a request.
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
};

async function route(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/settings') return settingsRoute(req, env);

  if (path === '/api/keys' && method === 'GET') return listProviderKeys(env);

  const keyMatch = /^\/api\/keys\/([a-z0-9_-]+)$/.exec(path);
  if (keyMatch) {
    const provider = keyMatch[1];
    if (!getProvider(provider)) return notFound('unknown provider');
    return providerKeyRoute(req, env, provider);
  }

  const modelsMatch = /^\/api\/models\/([a-z0-9_-]+)$/.exec(path);
  if (modelsMatch) return modelsRoute(req, env, modelsMatch[1]);

  if (path === '/api/characters') return charactersRoute(req, env);

  // Order matters: `/api/characters/fork` and `/:id/fork` must match BEFORE the bare
  // `:id` route, or "fork" is captured as a character id and 404s.
  if (path === '/api/characters/fork' && method === 'POST') return forkRoute(req, env);

  const openingsMatch = /^\/api\/characters\/([^/]+)\/openings$/.exec(path);
  if (openingsMatch) {
    if (method !== 'GET') return notFound();
    return openingsRoute(env, decodeURIComponent(openingsMatch[1]));
  }

  const avatarMatch = /^\/api\/characters\/([^/]+)\/avatar$/.exec(path);
  if (avatarMatch) return avatarRoute(req, env, decodeURIComponent(avatarMatch[1]));

  const forkMatch = /^\/api\/characters\/([^/]+)\/fork$/.exec(path);
  if (forkMatch) return characterForkRoute(req, env);

  const characterMatch = /^\/api\/characters\/([^/]+)$/.exec(path);
  if (characterMatch) return characterRoute(req, env, decodeURIComponent(characterMatch[1]));

  if (path === '/api/chats') return chatsRoute(req, env, ctx);

  const messagesMatch = /^\/api\/chats\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch) {
    if (method !== 'GET') return notFound();
    return listMessages(env, decodeURIComponent(messagesMatch[1]), url);
  }

  const stateMatch = /^\/api\/state\/([^/]+)$/.exec(path);
  if (stateMatch) return stateRoute(req, env, decodeURIComponent(stateMatch[1]));

  const sceneMatch = /^\/api\/chats\/([^/]+)\/scene$/.exec(path);
  if (sceneMatch) return sceneRoute(req, env, decodeURIComponent(sceneMatch[1]));

  const castMatch = /^\/api\/chats\/([^/]+)\/cast$/.exec(path);
  if (castMatch) return castRoute(req, env, decodeURIComponent(castMatch[1]));

  // Before the bare `/cast/:id` route, or "promote" is captured as a cast id.
  const promoteMatch = /^\/api\/chats\/([^/]+)\/cast\/([^/]+)\/promote$/.exec(path);
  if (promoteMatch) {
    return promoteRoute(
      req,
      env,
      decodeURIComponent(promoteMatch[1]),
      decodeURIComponent(promoteMatch[2]),
    );
  }

  const castMemberMatch = /^\/api\/chats\/([^/]+)\/cast\/([^/]+)$/.exec(path);
  if (castMemberMatch) {
    return castMemberRoute(
      req,
      env,
      decodeURIComponent(castMemberMatch[1]),
      decodeURIComponent(castMemberMatch[2]),
    );
  }

  const searchMatch = /^\/api\/chats\/([^/]+)\/search$/.exec(path);
  if (searchMatch) {
    return searchRoute(req, env, decodeURIComponent(searchMatch[1]), url);
  }

  const adviseMatch = /^\/api\/chats\/([^/]+)\/advise$/.exec(path);
  if (adviseMatch) return adviseRoute(req, env, decodeURIComponent(adviseMatch[1]));

  const exportMatch = /^\/api\/chats\/([^/]+)\/export$/.exec(path);
  if (exportMatch) return exportRoute(req, env, decodeURIComponent(exportMatch[1]), url);

  if (path === '/api/personas') return personasRoute(req, env);

  if (path === '/api/persona' && method === 'POST') return chatPersonaRoute(req, env);

  const personaMatch = /^\/api\/personas\/([^/]+)$/.exec(path);
  if (personaMatch) return personaRoute(req, env, decodeURIComponent(personaMatch[1]));

  if (path === '/api/message/swipe' && method === 'POST') return swipeMessage(env, req);
  if (path === '/api/message/edit' && method === 'POST') return editMessage(env, req);
  if (path === '/api/message/delete' && method === 'POST') return deleteMessage(env, req);
  if (path === '/api/message/alternative' && method === 'POST') return addAlternative(env, req);

  const memoryMatch = /^\/api\/chats\/([^/]+)\/memory$/.exec(path);
  if (memoryMatch) return memoryRoute(req, env, decodeURIComponent(memoryMatch[1]));

  if (path === '/api/memory/facts' && method === 'POST') return factRoute(req, env);

  const memoryEntryMatch = /^\/api\/memory\/(facts|summaries)\/([^/]+)$/.exec(path);
  if (memoryEntryMatch) {
    return memoryEntryRoute(
      req,
      env,
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

  if (path === '/api/presets') return presetsRoute(req, env);

  if (path === '/api/presets/duplicate' && method === 'POST') return duplicatePresetRoute(req, env);
  if (path === '/api/preset/apply' && method === 'POST') return applyPresetRoute(req, env);

  const presetMatch = /^\/api\/presets\/([^/]+)$/.exec(path);
  if (presetMatch) return presetRoute(req, env, decodeURIComponent(presetMatch[1]));

  const chatPresetMatch = /^\/api\/chats\/([^/]+)\/preset$/.exec(path);
  if (chatPresetMatch) {
    if (method !== 'GET') return notFound();
    return chatPresetRoute(env, decodeURIComponent(chatPresetMatch[1]));
  }

  if (path === '/api/forge/consult' && method === 'POST') return forgeRoute(req, env);

  if (path === '/api/chat' && method === 'POST') return handleChat(req, env, ctx);

  if (path === '/api/eval/judge' && method === 'POST') return evalJudgeRoute(req, env);

  return notFound();
}
