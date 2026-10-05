import { badRequest, json, notFound, readJson } from '../http';
import { loadProviderKey, storeProviderKey } from '../keys';
import { getProvider } from '../providers';

/** `GET /api/keys` — which providers have a key stored, never the key itself. */
export async function listProviderKeys(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT provider, updated_at FROM provider_keys ORDER BY provider',
  ).all<{ provider: string; updated_at: number }>();
  // Never returns key material.
  return json(results);
}

/**
 * `PUT`/`DELETE /api/keys/:provider`.
 *
 * The provider is resolved by the caller, so an unknown one is answered there.
 */
export async function providerKeyRoute(req: Request, env: Env, provider: string): Promise<Response> {
  const method = req.method;
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

/** `GET /api/models/:provider` — the provider's own list, passed through unmodified. */
export async function modelsRoute(req: Request, env: Env, providerId: string): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return listModels(env, providerId);
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
