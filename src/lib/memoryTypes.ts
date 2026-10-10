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
   * Optional because a recalled MESSAGE has no single date — it is a turn, and the clock
   * beside it is the scene's reading at that moment rather than a claim the hit makes. A
   * fact, an event and a summary all carry one, and it is rendered so the narrator can say
   * WHEN rather than only WHAT.
   */
  at?: string | null;
}
