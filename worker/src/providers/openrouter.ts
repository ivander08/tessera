import type { ChatRequest, ParsedFrame, Provider } from './types';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Whether a model id names a reasoning model.
 *
 * A name check rather than the live `supported_parameters` list, because `buildRequest` is
 * synchronous and has no model catalogue. It is the safe direction to be wrong in: a
 * reasoning model that slips through simply reasons, while a non-reasoning model that got
 * the parameter would fail the request under `require_parameters`.
 */
const REASONING_MODEL = /(^|[/-])(r1|o1|o3|o4|thinking|reasoning|reasoner)/i;

interface OpenRouterFrame {
  error?: { message?: string; code?: number | string };
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

export const openrouter: Provider = {
  id: 'openrouter',

  buildRequest(req: ChatRequest, apiKey: string) {
    return {
      url: ENDPOINT,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://tessera.workers.dev',
          'X-OpenRouter-Title': 'Tessera',
          'X-OpenRouter-Categories': 'roleplay',
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          max_tokens: req.maxTokens,
          // Sticky routing key. Without it OpenRouter only pins a provider AFTER it
          // has already observed a cache hit, which is exactly the turn that misses.
          session_id: req.sessionId,
          // `require_parameters: true` keeps load balancing ON while guaranteeing the
          // routed provider honours every parameter sent. `order`/`sort`/`only`/`ignore`
          // are deliberately absent: any of them pins the provider and silently kills
          // both load balancing and sticky routing — the mechanism caching depends on.
          provider: { require_parameters: true },
          ...req.knobs,
          // `reasoning.enabled: false` is OpenRouter's own control, translated per backend
          // (effort "none" for OpenAI/DeepSeek, an omitted thinking block for Anthropic).
          //
          // Sent only when the model's id says it reasons. `require_parameters: true` is
          // what makes that check necessary rather than tidy: OpenRouter refuses to route
          // to any provider that would drop a parameter in the request, so sending this to
          // a model that does not advertise `reasoning` leaves no eligible provider at all
          // and the turn fails outright.
          ...(req.disableReasoning && REASONING_MODEL.test(req.model)
            ? { reasoning: { enabled: false } }
            : {}),
        }),
      },
    };
  },

  parseFrame(payload: string): ParsedFrame | null {
    let frame: OpenRouterFrame;
    try {
      frame = JSON.parse(payload) as OpenRouterFrame;
    } catch {
      return null;
    }

    // Mid-stream failures arrive as `data:` frames while HTTP status stays 200.
    if (frame.error) {
      return { error: frame.error.message ?? 'openrouter stream error' };
    }

    const out: ParsedFrame = {};
    const delta = frame.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) out.text = delta;

    // The only place the provider says WHY it stopped. `length` is the difference between
    // a finished reply and one cut off mid-sentence, and it arrives on the terminal frame
    // with an empty delta.
    const reason = frame.choices?.[0]?.finish_reason;
    if (typeof reason === 'string' && reason.length > 0) out.finishReason = reason;

    // That terminal frame also carries `usage`. It is an accounting frame, not a second
    // terminal event.
    if (frame.usage) {
      out.usage = {
        promptTokens: frame.usage.prompt_tokens ?? 0,
        completionTokens: frame.usage.completion_tokens ?? 0,
        cachedTokens: frame.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: frame.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
        costUsd: typeof frame.usage.cost === 'number' ? frame.usage.cost : null,
      };
    }

    return out.text === undefined && out.usage === undefined && out.finishReason === undefined
      ? null
      : out;
  },

  readError(status: number, body: string): string {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) return `openrouter ${status}: ${parsed.error.message}`;
    } catch {
      // fall through to the raw body
    }
    return `openrouter ${status}: ${body.slice(0, 300)}`;
  },
};
