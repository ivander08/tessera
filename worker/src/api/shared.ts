import { getSettings, putSetting, putSettings } from '../db';
import { loadProviderKey, storeProviderKey } from '../keys';
import { getProvider } from '../providers';
import { badRequest, json, notFound, readJson } from '../http';
import { asRecord, asString } from '../../../src/lib/json';

/** `GET`/`PUT /api/settings`. */
export async function settingsRoute(req: Request, env: Env): Promise<Response> {
  const method = req.method;
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

/** `GET /api/keys` — which providers have a key stored, never the key itself. */
export async function listProviderKeys(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT provider, updated_at FROM provider_keys ORDER BY provider',
  ).all<{ provider: string; updated_at: number }>();
  // Never returns key material.
  return json(results);
}

/** `PUT`/`DELETE /api/keys/:provider`. */
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

/** `GET /api/models/:provider` — the provider's own model list, passed through. */
export async function modelsRoute(req: Request, env: Env, providerId: string): Promise<Response> {
  if (req.method !== 'GET') return notFound();
  return listModels(env, providerId);
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
