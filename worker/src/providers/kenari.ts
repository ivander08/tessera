import type { ChatRequest, ParsedFrame, Provider } from './types';

const ENDPOINT = 'https://kenari.id/v1/chat/completions';

interface KenariFrame {
  error?: { message?: string };
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

/**
 * Kenari is OpenAI-compatible. Two differences matter:
 *  - Model IDs are bare, with no `author/` prefix (`deepseek-v4-1-flash`, not
 *    `kenari/deepseek-v4-1-flash`).
 *  - Responses carry no cost field. Cost is derived from `GET /v1/models`, whose
 *    `pricing` block is micro-IDR per 1M tokens. Until an IDR->USD rate is
 *    configured, `costUsd` stays null and the IDR figure lives in `settings`.
 */
export const kenari: Provider = {
  id: 'kenari',

  buildRequest(req: ChatRequest, apiKey: string) {
    return {
      url: ENDPOINT,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          max_tokens: req.maxTokens,
          ...req.knobs,
        }),
      },
    };
  },

  parseFrame(payload: string): ParsedFrame | null {
    let frame: KenariFrame;
    try {
      frame = JSON.parse(payload) as KenariFrame;
    } catch {
      return null;
    }

    if (frame.error) return { error: frame.error.message ?? 'kenari stream error' };

    const out: ParsedFrame = {};
    const delta = frame.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) out.text = delta;

    // The terminal frame repeats finish_reason with an empty delta and adds `usage`. It is
    // the only place the provider says WHY it stopped, and `length` is the difference
    // between a finished reply and one cut off mid-sentence.
    const reason = frame.choices?.[0]?.finish_reason;
    if (typeof reason === 'string' && reason.length > 0) out.finishReason = reason;

    if (frame.usage) {
      out.usage = {
        promptTokens: frame.usage.prompt_tokens ?? 0,
        completionTokens: frame.usage.completion_tokens ?? 0,
        cachedTokens: frame.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: frame.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
        costUsd: null,
      };
    }

    return out.text === undefined && out.usage === undefined && out.finishReason === undefined
      ? null
      : out;
  },

  /**
   * A 401 from Kenari is a short plain-text string, not a JSON envelope — it is
   * rejected before the API layer runs. Blindly calling `res.json()` here throws
   * and hides the real reason.
   */
  readError(status: number, body: string): string {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { error?: { message?: string } | string };
        const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
        if (message) return `kenari ${status}: ${message}`;
      } catch {
        // fall through to the raw body
      }
    }
    return `kenari ${status}: ${trimmed.slice(0, 300)}`;
  },
};

/**
 * Cost in IDR from the model list rate card.
 * `input`/`output` are micro-IDR per 1M tokens, so tokens/1e6 * rate/1e6 gives IDR.
 */
export function kenariCostIdr(
  pricing: { input: number | null; output: number | null },
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (pricing.input === null || pricing.output === null) return null;
  return (
    (promptTokens / 1e6) * (pricing.input / 1e6) +
    (completionTokens / 1e6) * (pricing.output / 1e6)
  );
}
