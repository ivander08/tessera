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
 * Build a safe MATCH expression from free text.
 *
 * ## Why this is OR, not AND
 *
 * Recall is driven by the reader's whole message, and a whole message is mostly
 * connective tissue. The obvious expression — AND every token — asks for a row
 * containing "the" AND "is" AND "it?" as well as the words that matter, and in practice
 * that matches nothing at all.
 *
 * Measured on a 514-message chat: the query "the chest below is locked and I have lost
 * the thing that opens it" ANDed to exactly ONE row — the question itself, because it
 * was the only row in the chat containing all 24 of its own words. Recall returned the
 * reader's question as "a relevant earlier moment" and the answer, four hundred messages
 * back, was never retrieved. The model then invented an answer, which is the worst
 * possible outcome: a confidently wrong reply that looks like recall.
 *
 * OR has the opposite failure mode and a much smaller one: a common word can pull in an
 * irrelevant row, and bm25 ranks those last, so they occupy the tail of a bounded result
 * list. Missing the answer entirely cannot be recovered from; a mediocre extra hit can.
 *
 * Stopwords are dropped as well, because they contribute nothing to bm25 except noise
 * and they inflate the expression. A query that is ALL stopwords keeps them — an empty
 * MATCH is a syntax error, and `''` tells the caller to skip recall entirely.
 */
export function buildMatchQuery(userText: string): string {
  const tokens = userText
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return '';

  const meaningful = tokens.filter((token) => !STOPWORDS.has(token.toLowerCase()));
  const used = meaningful.length > 0 ? meaningful : tokens;

  // A long message is mostly prose; the cap keeps the expression bounded and the terms
  // that carry meaning tend to be the less common ones anyway.
  const capped = used.slice(0, MAX_TERMS);
  return capped.map(escapeFtsToken).join(' OR ');
}

/**
 * Words that carry no retrieval signal in prose.
 *
 * Deliberately short. An aggressive list risks dropping a word that is genuinely the
 * subject of a question ("who", "where"); this only removes articles, pronouns,
 * auxiliaries and the copula, which no row is ever found by.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'no', 'not', 'of',
  'on', 'or', 'our', 'out', 'she', 'should', 'so', 'some', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'up', 'us',
  'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you',
  'your',
]);

/** Bounded so one long message cannot produce an unbounded MATCH expression. */
const MAX_TERMS = 24;
