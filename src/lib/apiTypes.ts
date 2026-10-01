/** Shared row shapes returned by the Worker. */

import type { WorldState } from './state/schema';

export interface CharacterSummary {
  id: string;
  name: string;
  /**
   * The card's own title, e.g. "Quill 25/09/2026". This is what the library lists and
   * what you search for; it is not what the reader sees in the transcript.
   */
  avatar: string | null;
  source_format: string;
  tokens: number | null;
  created_at: number;
  /**
   * CCv3's `nickname` — the name the character is called in the transcript. Distinct
   * from `name`, which is the card's title. Falls back to `name` when unset.
   */
  shownName?: string;
}

export interface ChatSummary {
  id: string;
  title: string | null;
  updated_at: number;
  character_id: string | null;
  character_name: string | null;
  character_avatar: string | null;
  preview: string | null;
}

export interface MessageRow {
  seq: number;
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  content_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  created_at: number;
  /**
   * Who wrote this assistant row, or null for the chat's own character.
   *
   * Null is the ordinary case: every row in a single-character scene, and every row
   * written before casts existed. A group reply is also null — it contains several
   * speakers, and the content carries the attribution.
   */
  speaker?: string | null;
  /**
   * The world state as of this turn, when one was recorded.
   *
   * Null or absent for most rows: state only advances on a completed `send`, and only
   * when something actually changed. A row without a snapshot inherits the most recent
   * one at or before it, which is what was true at the time.
   */
  state?: WorldState | null;
  /**
   * Alternative ids at this position, in order.
   *
   * Absent when the position has never been regenerated. The server omits it rather than
   * sending a one-element array containing the row's own id: on a real 617-message chat
   * that was 616 arrays of pure noise, 32 KB of the response. Absent and "length 1" mean
   * the same thing, so a reader must treat `undefined` as one version.
   */
  swipes?: string[];
  swipeIndex?: number;
}

export interface ChatCharacter {
  id: string;
  name: string;
  avatar: string | null;
  /** What the reader sees in the transcript. */
  shownName: string;
}

export interface ChatPersona {
  id: string;
  name: string;
  /** The persona's picture, when they have one. Null means the Avatar falls back to their initial. */
  avatar: string | null;
}

export interface ChatDetail {
  id: string;
  character_id: string | null;
  persona_id: string | null;
  title: string | null;
  preset_id: string | null;
  window_start_seq: number;
  session_id: string;
  created_at: number;
  updated_at: number;
}

/**
 * One page of a chat's transcript.
 *
 * The window is served from the END of the visible path — the reader is looking at the
 * newest turns — so the transcript is not the whole conversation and does not say how
 * long the conversation is. `hasMore` is the only promise the server makes about what is
 * out of view, and `oldestId` is how the client asks for it.
 */
export interface Transcript {
  chat: ChatDetail;
  character: ChatCharacter | null;
  persona: ChatPersona | null;
  messages: MessageRow[];
  /** True when older turns exist before the first message in `messages`. */
  hasMore: boolean;
  /** Id of the oldest returned message; pass as `cursor` to page backwards. */
  oldestId: string | null;
}

export interface ModelInfo {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: Record<string, string | number | null>;
}

export interface ProviderKeyRow {
  provider: string;
  updated_at: number;
}
