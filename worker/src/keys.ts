import { decryptKey, encryptKey } from '../../src/lib/crypto';
import type { Bytes } from '../../src/lib/crypto';

export async function loadProviderKey(env: Env, providerId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT key_enc, iv FROM provider_keys WHERE provider = ?')
    .bind(providerId)
    .first<{ key_enc: Bytes; iv: Bytes }>();
  if (!row) return null;
  try {
    return await decryptKey(row.key_enc, row.iv, env.TESSERA_TOKEN);
  } catch (error) {
    console.error('[keys] decrypt failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    // A changed TESSERA_TOKEN makes stored keys undecryptable. Report "not
    // configured" rather than throwing deep inside a chat request.
    return null;
  }
}

export async function storeProviderKey(env: Env, providerId: string, key: string): Promise<void> {
  const { enc, iv } = await encryptKey(key, env.TESSERA_TOKEN);
  await env.DB.prepare(
    `INSERT INTO provider_keys (provider, key_enc, iv, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       key_enc = excluded.key_enc, iv = excluded.iv, updated_at = excluded.updated_at`,
  )
    .bind(providerId, new Uint8Array(enc), new Uint8Array(iv), Date.now())
    .run();
}
