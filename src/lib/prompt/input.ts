import type { Role } from './types';

export interface AssembleInput {
  /** Static. NEVER contains time, date, or IDs. */
  systemPrompt: string;
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
  /**
   * The preset's pre-history instructions, emitted last in the head when present.
   *
   * Head, not tail: that is what "pre-history" means — it precedes the conversation and
   * frames it — and the value is static per chat, so it belongs in the cached prefix.
   */
  preHistory?: string;
  /**
   * How the scene should be written. Static for the chat's life, so it lives in the cached
   * prefix; changing it costs one cache miss, which is correct for a deliberate act.
   */
  craftBlock?: string;
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
    /**
     * The unrestricted-content policy, when the reader has it on.
     *
     * Tail-only, and deliberately: measured against the local model, the same text in the
     * cached prefix was refused and in the tail was complied with. Read last, as the final
     * system text before the reader's message, it outweighs the conversation that follows.
     */
    contentPolicy?: string;
    /**
     * The vocalisation block, when the reader has it on.
     *
     * Tail-only for the same measured reason as `contentPolicy`: in the prefix the model
     * ignored it and described every sound instead of writing it; in the tail the same
     * text produced the sounds. See `renderVocalisation`.
     */
    vocalisation?: string;
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
