/** Shared row shapes returned by the Worker. */

export interface CharacterSummary {
  id: string;
  name: string;
  avatar: string | null;
  source_format: string;
  tokens: number | null;
  created_at: number;
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
