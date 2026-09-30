/** Shared row shapes returned by the Worker. */

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
  /** Alternative ids at this position, in order. Length 1 when never regenerated. */
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
