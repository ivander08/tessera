export type Role = 'system' | 'user' | 'assistant';

export interface WireMessage {
  role: Role;
  content: string;
}

export interface AssembledPrompt {
  /** Messages in exact wire order: immutable head, then growing body, then volatile tail. */
  messages: WireMessage[];
  /** Index of the first tail message. messages.slice(0, tailStart) is the cacheable prefix. */
  tailStart: number;
  /** sha256 over stableStringify(messages.slice(0, tailStart)). */
  prefixHash: string;
  headTokens: number;
  bodyTokens: number;
  tailTokens: number;
  /**
   * Output-token ceiling for this reply, when the craft length names one.
   *
   * Set by `buildPrompt`, never by `assemble`: the cap comes from the scene's craft
   * document, which only the worker loads. `undefined` means "the preset's own budget
   * governs" — the field only ever narrows what the caller would have sent.
   */
  responseLengthCap?: number;
}
