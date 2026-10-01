import type { Role } from './types';

export interface AssembleInput {
  /** Static. NEVER contains time, date, or IDs. */
  systemPrompt: string;
  /**
   * The preset's own prompt list, already resolved and ordered.
   *
   * When present this REPLACES the standard head composition entirely. The preset's
   * order names its own positions for the card's description, the persona and the
   * examples, so emitting both would send the same content twice in a different order —
   * and the preset's order is the one its author tested.
   *
   * Null for a preset with no prompt list, which is every preset that only carries
   * sampler values. Those assemble exactly as Tessera did before this existed.
   */
  presetHead?: Array<{ role: Role; content: string }> | null;
  /**
   * Preset entries that sit AFTER the history but before Tessera's own tail blocks.
   *
   * Tessera's memory/state/cast blocks stay last on purpose: they are the app's own
   * per-turn state, and a preset cannot know about them.
   */
  presetAfterHistory?: Array<{ role: Role; content: string }> | null;
  character: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    mesExample: string;
  };
  persona: { name: string; description: string } | null;
  /** Always-on, FIXED order by id. */
  lorebook: Array<{ id: string; content: string }>;
  /** Oldest -> newest, from `window_start_seq`. */
  history: Array<{ role: Role; content: string }>;
  tail: {
    memoryBlock?: string;
    stateBlock?: string;
    /**
     * Who is speaking in this scene, when it is more than one.
     *
     * Tail-only, and deliberately so: the cast GROWS during a scene, and a block that
     * changed would rewrite the cached prefix every time a character was introduced.
     */
    castBlock?: string;
    /** Keyword-triggered lorebook entries that fired this turn. */
    loreBlock?: string;
    authorsNote?: string;
    /** Card `post_history_instructions`. Tail-only: cannot perturb the cached prefix. */
    postHistoryInstructions?: string;
    /**
     * What this turn is asking for, when it is not an ordinary reply.
     *
     * `continue` and `impersonate` are not "answer the user" — one extends the last
     * message, the other writes the reader's own next line. Without a line saying so,
     * the model only sees a trailing assistant turn and has to guess.
     */
    instruction?: string;
    userMessage: string;
  };
}
