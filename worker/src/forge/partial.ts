/**
 * The decoded prefix of a top-level JSON string field, from a document still being written.
 *
 * Returns `null` when the field has not started, the empty string when it has started but
 * holds nothing yet, and the decoded value so far otherwise. Never throws: a half-written
 * document is the normal input here, not an error case.
 *
 * The consultant prompt requires `say` to be the FIRST key of the object, so this has
 * something to show within the first few tokens. A reply that orders its keys differently
 * simply yields no deltas and arrives in one piece at the end, which is what the behaviour
 * was before streaming existed.
 *
 * Not implemented by slicing and calling `JSON.parse` inside `try`/`catch`: the slice is
 * routinely malformed (an incomplete `\u` escape, an unterminated string), and the catch
 * would discard the whole visible prefix on whichever character happens to be mid-escape,
 * making the stream stutter backwards.
 */
export function partialField(buffer: string, field: string): string | null {
  const key = `"${field}"`;
  const keyAt = buffer.indexOf(key);
  if (keyAt < 0) return null;

  let at = keyAt + key.length;

  // Whitespace, the colon, whitespace, then the opening quote. Anything else means the
  // field has not started — a nested object of the same name, or a value that is not a
  // string at all.
  while (isSpace(buffer[at])) at++;
  if (buffer[at] !== ':') return null;
  at++;
  while (isSpace(buffer[at])) at++;
  if (buffer[at] !== '"') return null;
  at++;

  let out = '';
  while (at < buffer.length) {
    const char = buffer[at];

    if (char === '"') break;

    if (char !== '\\') {
      out += char;
      at++;
      continue;
    }

    const escape = buffer[at + 1];
    if (escape === undefined) break;

    if (escape === 'u') {
      // An escape split across two chunks is normal, not an error: stop here and let the
      // next call, with the rest of the buffer, decode it.
      const hex = buffer.slice(at + 2, at + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      at += 6;
      continue;
    }

    const simple = SIMPLE_ESCAPES[escape];
    // An unknown escape cannot be decoded, and guessing would show the user text the model
    // never wrote.
    if (simple === undefined) break;
    out += simple;
    at += 2;
  }

  return out;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}
