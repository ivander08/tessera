import type { ChatRequest, ParsedFrame, Provider } from './types';

/** OpenAI-compatible surface of the Go subscription. */
const ENDPOINT = 'https://opencode.ai/inference/go/openai/v1/chat/completions';
/** The catalogue lives one path over; it is the same gateway and the same key. */
const MODELS = 'https://opencode.ai/zen/go/v1/models';

interface OpencodeFrame {
  error?: { message?: string };
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

/**
 * Opencode Go — flat-rate gateway over opencode.ai, OpenAI-compatible.
 *
 * Three things are measured, not documented:
 *  - A chat request WITHOUT `x-opencode-session` is rejected outright: `400
 *    MissingSessionID`, "Request is missing x-opencode-session and cannot be routed
 *    efficiently." So the session id is a requirement, not a cache hint — `ChatRequest`
 *    already carries one for sticky routing, and it is passed through here.
 *  - Cloudflare fronts the gateway and answers `403 error code: 1010` to a request whose
 *    user-agent it dislikes (a Python default was refused while `opencode/1.0` was
 *    accepted). The header is set explicitly rather than inherited from `fetch`.
 *  - Reasoning is off via `reasoning_effort: "none"`. Every model in the catalogue
 *    advertises `capabilities.reasoning: true`, and the effort ladder for some of them has
 *    no "none" rung — but measured against `hy4-flash-free`, `glm-5.3-flash` and
 *    `deepseek-v4.1-flash`, the key was accepted by all three and produced zero
 *    `reasoning_content` characters. A cheap trivial call then answered in 1-2 s, against
 *    15-50 s on the Kenari gateway.
 *
 * `reasoning_content` frames are deliberately ignored: the narrator has no reasoning UI,
 * and the flag above is what keeps them from being produced at all.
 */
export const opencodeGo: Provider = {
  id: 'opencode-go',
  modelsUrl: MODELS,

  modelsHeaders(apiKey) {
    const headers: Record<string, string> = { 'User-Agent': 'tessera' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  },

  buildRequest(req: ChatRequest, apiKey: string) {
    return {
      url: ENDPOINT,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'tessera',
          'x-opencode-session': req.sessionId,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          max_tokens: req.maxTokens,
          ...req.knobs,
          ...(req.disableReasoning ? { reasoning_effort: 'none' } : {}),
        }),
      },
    };
  },

  parseFrame(payload: string): ParsedFrame | null {
    let frame: OpencodeFrame;
    try {
      frame = JSON.parse(payload) as OpencodeFrame;
    } catch {
      return null;
    }

    if (frame.error) return { error: frame.error.message ?? 'opencode-go stream error' };

    const out: ParsedFrame = {};
    const delta = frame.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) out.text = delta;

    const reason = frame.choices?.[0]?.finish_reason;
    if (typeof reason === 'string' && reason.length > 0) out.finishReason = reason;

    if (frame.usage) {
      out.usage = {
        promptTokens: frame.usage.prompt_tokens ?? 0,
        completionTokens: frame.usage.completion_tokens ?? 0,
        cachedTokens: frame.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: frame.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
        // The catalogue carries USD prices per 1M tokens, but the response does not
        // report a cost, and the narrator's cost column is already null for Kenari.
        costUsd: null,
      };
    }

    return out.text === undefined && out.usage === undefined && out.finishReason === undefined
      ? null
      : out;
  },

  readError(status: number, body: string): string {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as {
          error?: { message?: string } | string;
          message?: string;
        };
        const message =
          typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error?.message ?? parsed.message;
        if (message) return `opencode-go ${status}: ${message}`;
      } catch {
        // fall through to the raw body
      }
    }
    return `opencode-go ${status}: ${trimmed.slice(0, 300)}`;
  },
};
