import type { WireMessage } from '../../../src/lib/prompt/types';

export interface ChatRequest {
  model: string;
  messages: WireMessage[];
  stream: true;
  maxTokens: number;
  knobs: Record<string, number | string | string[]>;
  /** Per-chat, stable for the chat's life. Sticky routing depends on it. */
  sessionId: string;
  /**
   * Ask the provider not to reason before answering.
   *
   * The narrator has no UI for a reasoning trace, so thinking is pure latency and output
   * tokens the reader never sees. It is a request-level flag rather than a sampler knob
   * because the two providers spell it differently, and because `knobs` holds numbers.
   */
  disableReasoning: boolean;
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** null when the provider reports no cost. */
  costUsd: number | null;
}

export interface ParsedFrame {
  text?: string;
  usage?: NormalizedUsage;
  error?: string;
  /** The provider's stop reason, when it reported one. `'length'` means the cap was hit. */
  finishReason?: string;
}

export interface Provider {
  id: 'openrouter' | 'kenari';
  buildRequest(req: ChatRequest, apiKey: string): { url: string; init: RequestInit };
  /** Parse one SSE data payload. Returns null for frames that carry no content. */
  parseFrame(payload: string): ParsedFrame | null;
  /** Reads a non-2xx pre-stream response. Never assumes JSON — Kenari 401s are plain text. */
  readError(status: number, body: string): string;
}

export type { WireMessage };
