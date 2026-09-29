import { decryptKey, encryptKey } from '../../src/lib/crypto';
import type { Bytes } from '../../src/lib/crypto';

/**
 * Why a key could not be used, when it could not be.
 *
 * `missing` and `undecryptable` need different actions from the user: the first means
 * paste a key, the second means the key is there but `TESSERA_TOKEN` changed and the
 * stored ciphertext can no longer be opened. Collapsing them into one "no key" message
 * tells the user something false about their own settings.
 */
export type ProviderKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: 'missing' | 'undecryptable' };

export async function loadProviderKey(env: Env, providerId: string): Promise<ProviderKeyResult> {
  const row = await env.DB.prepare('SELECT key_enc, iv FROM provider_keys WHERE provider = ?')
    .bind(providerId)
    .first<{ key_enc: Bytes; iv: Bytes }>();
  if (!row) return { ok: false, reason: 'missing' };

  try {
    return { ok: true, key: await decryptKey(row.key_enc, row.iv, env.TESSERA_TOKEN) };
  } catch (error) {
    console.error('[keys] decrypt failed', {
      provider: providerId,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'undecryptable' };
  }
}

export function keyErrorMessage(providerId: string, reason: 'missing' | 'undecryptable'): string {
  return reason === 'undecryptable'
    ? `The stored ${providerId} key can no longer be decrypted because TESSERA_TOKEN changed. Re-enter it at /settings.`
    : `No API key stored for ${providerId}. Open /settings.`;
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
