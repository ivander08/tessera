const HKDF_INFO = 'tessera-provider-keys-v1';

/**
 * Provider API keys are entered in the UI, so they live in D1 rather than Worker
 * secrets. They are encrypted with a key derived from `TESSERA_TOKEN`, which is
 * never written to D1 — so a database dump alone does not reveal them.
 */
async function deriveKey(token: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptKey(
  plaintext: string,
  token: string,
): Promise<{ enc: ArrayBuffer; iv: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(token);
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { enc, iv: iv.buffer as ArrayBuffer };
}

/**
 * D1 hands BLOB columns back as `number[]` in some runtimes and `ArrayBuffer` in
 * others, so every byte-taking API here normalizes rather than trusting the caller's
 * declared type. Passing an array straight to `crypto.subtle.decrypt` fails with
 * "parameter 3 is not of type 'BufferSource'".
 */
export type Bytes = ArrayBuffer | Uint8Array | number[];

function toBytes(value: Bytes): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) {
    // Copy into a view backed by a plain ArrayBuffer: a Uint8Array may be backed by
    // SharedArrayBuffer, which WebCrypto rejects as a BufferSource.
    const copy = new Uint8Array(value.length);
    copy.set(value);
    return copy;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value);
}

export async function decryptKey(enc: Bytes, iv: Bytes, token: string): Promise<string> {
  const key = await deriveKey(token);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBytes(iv) },
    key,
    toBytes(enc),
  );
  return new TextDecoder().decode(plain);
}
