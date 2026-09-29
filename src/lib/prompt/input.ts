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
  /** Oldest -> newest, from `window_start_seq`. */
  history: Array<{ role: Role; content: string }>;
  tail: {
    memoryBlock?: string;
    stateBlock?: string;
    authorsNote?: string;
    /** Card `post_history_instructions`. Tail-only: cannot perturb the cached prefix. */
    postHistoryInstructions?: string;
    userMessage: string;
  };
}
