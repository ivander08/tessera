/**
 * FTS5 MATCH query construction.
 *
 * A raw user string is NOT a safe MATCH expression. `messages_fts` is queried with
 * whatever the recall caller passes, and an unescaped query can inject FTS5 operators:
 * `-` (NOT), `*` (prefix), `NEAR(...)`, `^` (column filter), `OR`/`AND`, and bare `"`
 * which opens a phrase that swallows the rest of the string. A user typing
 * `Ada - refuses` would silently become "Ada AND NOT refuses" and return the wrong
 * memories; a stray `"` throws `fts5: syntax error` and takes down the whole recall.
 *
 * The fix is the documented one: quote every token, doubling internal quotes. Inside
 * a quoted phrase FTS5 treats all punctuation as text and no operator is recognised.
 * Tokens are whitespace-separated, so an injected operator arrives as its own token
 * and gets quoted like any other word — `NEAR` becomes the literal word "NEAR".
 */
export function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build a safe MATCH expression from free text. Tokens are ANDed, which is FTS5's
 * default for space-separated terms — a recall query wants rows containing all of the
 * user's words, not any of them.
 *
 * Empty or whitespace-only input returns `''`. The caller must skip the query in that
 * case rather than running `MATCH ''`, which is a syntax error.
 */
export function buildMatchQuery(userText: string): string {
  const tokens = userText.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map(escapeFtsToken).join(' ');
}
