/**
 * Shared recall shape.
 *
 * Lives in `src/lib` because both sides need it: the Worker's `recall()` produces it
 * and the shared `renderMemoryBlock()` consumes it. `src/lib/**` must not import from
 * `worker/**`, so the type cannot live next to the implementation.
 */
export type RecallKind = 'message' | 'fact' | 'event' | 'summary';

export interface RecallHit {
  kind: RecallKind;
  /** `messages.id`, `facts.id` or `summaries.id` — never a seq, so it survives re-anchors. */
  refId: string;
  text: string;
  /** bm25 relevance: negative, and more negative is better. Summary hits carry 0. */
  score: number;
  /**
   * The in-world date this hit happened or became true, verbatim, or null.
   *
   * A recalled MESSAGE carries the clock recorded beside that turn — not a claim the message
   * makes, but the reading that places it in the story, which is what answers "when did that
   * happen". A fact, an event and a summary carry the date of what they assert.
   */
  at?: string | null;
}
