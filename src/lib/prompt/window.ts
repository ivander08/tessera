/**
 * Sawtooth truncation.
 *
 * Dropping the oldest message one at a time shifts the prefix start every turn, so
 * nothing upstream of the drop point can ever cache. Instead the window start is
 * held FIXED while the window grows, and re-anchored exactly once when the budget
 * is blown. The result is a sawtooth: long stable prefixes punctuated by rare jumps.
 */

export interface WindowEntry {
  seq: number;
  tokens: number;
}

/**
 * Return the seq of the oldest message to include, given a token budget.
 *
 * - If everything from `windowStartSeq` onward fits, `windowStartSeq` is returned
 *   unchanged — the common case, and the only case that keeps the cache warm.
 * - Otherwise the window re-anchors once to the newest messages that fit. At least
 *   one message is always kept, even if a single message exceeds the budget alone.
 */
export function computeWindowStart(
  history: WindowEntry[],
  windowStartSeq: number,
  budgetTokens: number,
): number {
  if (history.length === 0) return windowStartSeq;

  const firstInWindow = history.findIndex((entry) => entry.seq >= windowStartSeq);
  const startIndex = firstInWindow === -1 ? history.length : firstInWindow;

  let total = 0;
  for (let i = startIndex; i < history.length; i++) total += history[i].tokens;
  if (total <= budgetTokens) return windowStartSeq;

  let running = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    running += history[i].tokens;
    if (running > budgetTokens) {
      // `history[i]` is the first message that does not fit. Start just after it,
      // clamped to the newest message so the window is never empty.
      return history[Math.min(i + 1, history.length - 1)].seq;
    }
  }

  return history[0].seq;
}
