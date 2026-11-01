/**
 * Sawtooth truncation.
 *
 * Dropping the oldest message one at a time shifts the prefix start every turn, so
 * nothing upstream of the drop point can ever cache. Instead the window start is
 * held FIXED while the window grows, and re-anchored exactly once when the budget
 * is blown. The result is a sawtooth: long stable prefixes punctuated by rare jumps.
 *
 * RE-ANCHORING TO THE EXACT BUDGET DEFEATS THAT. It leaves no headroom: the next turn
 * adds a message, blows the budget by one message, and moves the anchor again. Every
 * turn then starts the prompt at a different message, and a provider's prefix cache —
 * which can only match from the beginning — reuses nothing but the static head.
 *
 * Measured on a live 900-message window at a 64k budget: 10% of the prompt cached on
 * most turns, with the occasional 92% turn on the turns where the anchor happened not to
 * move. Re-anchoring to a LOW-WATER MARK instead leaves 15% of the budget as headroom,
 * which is tens of turns of growth before the next jump: the prompt's prefix stays
 * byte-identical and the whole window keeps hitting the cache.
 */

export interface WindowEntry {
  seq: number;
  tokens: number;
}

/**
 * How full the window may get before it re-anchors.
 *
 * The cost is that the first turn after a jump reads 15% less context; the benefit is
 * that every turn between jumps reads the same prefix, so it is cached. 0.85 is the
 * smallest headroom that survives the coarsest message sizes without handing back the
 * cache to a chat whose turns are all short.
 */
const REANCHOR_FILL = 0.85;

/**
 * Return the seq of the oldest message to include, given a token budget.
 *
 * - If everything from `windowStartSeq` onward fits, `windowStartSeq` is returned
 *   unchanged — the common case, and the only case that keeps the cache warm.
 * - Otherwise the window re-anchors once to the newest messages that fit the lower
 *   re-anchor target, leaving headroom so the next turns do not move it again.
 *   At least one message is always kept, even if a single message exceeds the budget.
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

  // The jump lands on the low-water mark, not on the ceiling: the headroom it leaves is
  // what lets the following turns keep the prefix they cached.
  const target = Math.floor(budgetTokens * REANCHOR_FILL);
  let running = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    running += history[i].tokens;
    if (running > target) {
      // `history[i]` is the first message that does not fit. Start just after it,
      // clamped to the newest message so the window is never empty.
      return history[Math.min(i + 1, history.length - 1)].seq;
    }
  }

  return history[0].seq;
}
