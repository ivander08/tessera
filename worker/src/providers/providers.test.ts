import { describe, expect, test } from 'bun:test';
import { kenari } from './kenari';
import { openrouter } from './openrouter';

describe('openrouter adapter', () => {
  test('sends session_id and require_parameters, and no provider pinning', () => {
    const { url, init } = openrouter.buildRequest(
      {
        model: 'anthropic/claude-sonnet-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        maxTokens: 100,
        knobs: { temperature: 0.9 },
        sessionId: 'session-abc',
        disableReasoning: false,
      },
      'sk-test',
    );

    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.session_id).toBe('session-abc');
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.temperature).toBe(0.9);

    // Any of these disables load balancing and pins the provider, which silently
    // disables sticky routing — the mechanism caching depends on.
    expect(body.provider).not.toHaveProperty('order');
    expect(body.provider).not.toHaveProperty('sort');
    expect(body.provider).not.toHaveProperty('only');
    expect(body.provider).not.toHaveProperty('ignore');

    // Deprecated and ineffective; full usage is always returned inline.
    expect(body).not.toHaveProperty('usage');
  });

  test('reads text and usage from the terminal accounting frame', () => {
    expect(openrouter.parseFrame(JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }))).toEqual({
      text: 'Hello',
    });

    const terminal = openrouter.parseFrame(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 40,
          cost: 0.0031,
          prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 },
        },
      }),
    );
    expect(terminal?.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 40,
      cachedTokens: 1024,
      cacheWriteTokens: 0,
      costUsd: 0.0031,
    });
    // An accounting frame carries no text, so it must not be treated as a delta.
    expect(terminal?.text).toBeUndefined();
  });

  test('surfaces a mid-stream error that arrives with HTTP 200', () => {
    const frame = openrouter.parseFrame(
      JSON.stringify({ error: { message: 'rate limited', code: 429 } }),
    );
    expect(frame?.error).toBe('rate limited');
  });

  test('ignores frames that carry neither text nor usage', () => {
    expect(openrouter.parseFrame(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toBeNull();
  });

  test('does not throw on a malformed payload', () => {
    expect(openrouter.parseFrame('not json')).toBeNull();
  });

  test('carries finish_reason, including the terminal frame that has nothing else', () => {
    // The reason is the ONLY way anything downstream can tell a finished reply from one
    // cut off at the cap, and it arrives on a frame that carries no text.
    const terminal = openrouter.parseFrame(
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    );
    expect(terminal).not.toBeNull();
    expect(terminal?.finishReason).toBe('length');

    expect(
      openrouter.parseFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        ?.finishReason,
    ).toBe('stop');
  });

  test('a frame with no reason, no text and no usage is still dropped', () => {
    expect(openrouter.parseFrame(JSON.stringify({ choices: [{ delta: {} }] }))).toBeNull();
  });

  /**
   * The reasoning flag, which is the difference between a reply and no reply on a model
   * that reasons by default.
   *
   * `require_parameters: true` makes the model check load-bearing rather than tidy:
   * OpenRouter refuses to route to any provider that would drop a parameter, so the
   * parameter must never be sent to a model that does not advertise it.
   */
  test('suppresses reasoning only for models whose id says they reason', () => {
    const bodyFor = (model: string) => {
      const { init } = openrouter.buildRequest(
        {
          model,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          maxTokens: 100,
          knobs: {},
          sessionId: 'session-abc',
          disableReasoning: true,
        },
        'sk-test',
      );
      return JSON.parse(String(init.body)) as Record<string, unknown>;
    };

    expect(bodyFor('deepseek/deepseek-r1').reasoning).toEqual({ enabled: false });
    expect(bodyFor('openai/o3-mini').reasoning).toEqual({ enabled: false });

    // A model that does not reason must not be sent the parameter at all: under
    // `require_parameters` that request would have no eligible provider and fail.
    expect(bodyFor('anthropic/claude-sonnet-5.5')).not.toHaveProperty('reasoning');
    expect(bodyFor('meta-llama/llama-3.3-70b-instruct')).not.toHaveProperty('reasoning');
  });

  test('sends no reasoning parameter when the setting is off', () => {
    const { init } = openrouter.buildRequest(
      {
        model: 'deepseek/deepseek-r1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        maxTokens: 100,
        knobs: {},
        sessionId: 'session-abc',
        disableReasoning: false,
      },
      'sk-test',
    );
    expect(JSON.parse(String(init.body))).not.toHaveProperty('reasoning');
  });
});

describe('kenari adapter', () => {
  test('uses bare model ids and no session_id', () => {
    const { url, init } = kenari.buildRequest(
      {
        model: 'deepseek-v4-1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        maxTokens: 100,
        knobs: {},
        sessionId: 'ignored',
        disableReasoning: false,
      },
      'kn-test',
    );
    expect(url).toBe('https://kenari.id/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-v4-1-flash');
    expect(body).not.toHaveProperty('session_id');
    // Nothing is sent unless the setting asks for it: this is the flag that has to be
    // absent for a model whose reasoning the reader wants.
    expect(body).not.toHaveProperty('enable_thinking');
  });

  test('uses enable_thinking, which is the flag the backend actually honours', () => {
    // Measured on `deepseek-v4-flash`, which reasons by default and spent a whole reply
    // on it: `enable_thinking: false` produced zero reasoning tokens and a normal answer,
    // while the OpenRouter-style `reasoning: { enabled: false }` that kenari documents as
    // the unified control still produced 10,000 characters of reasoning and no content.
    const { init } = kenari.buildRequest(
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        maxTokens: 100,
        knobs: {},
        sessionId: 'ignored',
        disableReasoning: true,
      },
      'kn-test',
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.enable_thinking).toBe(false);
    // The documented control is NOT what gets sent — the measurement is the contract.
    expect(body).not.toHaveProperty('reasoning');
  });

  test('reports no cost — Kenari sends no cost field', () => {
    const frame = kenari.parseFrame(
      JSON.stringify({
        choices: [{ delta: { content: 'x' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } },
      }),
    );
    expect(frame?.usage?.costUsd).toBeNull();
    expect(frame?.usage?.cachedTokens).toBe(8);
  });

  test('reads a plain-text 401 rather than assuming JSON', () => {
    expect(kenari.readError(401, 'Invalid API key')).toBe('kenari 401: Invalid API key');
  });

  test('still reads a JSON error envelope when one is sent', () => {
    expect(kenari.readError(429, JSON.stringify({ error: { message: 'slow down' } }))).toBe(
      'kenari 429: slow down',
    );
  });

  test('carries finish_reason, including the terminal frame that has nothing else', () => {
    // Whether Kenari actually sends this was not observable from the code, so it is read
    // when present and the turn falls back to the token count when it is not.
    const terminal = kenari.parseFrame(
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    );
    expect(terminal).not.toBeNull();
    expect(terminal?.finishReason).toBe('length');

    expect(
      kenari.parseFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        ?.finishReason,
    ).toBe('stop');
  });

  test('a frame with no reason, no text and no usage is still dropped', () => {
    expect(kenari.parseFrame(JSON.stringify({ choices: [{ delta: {} }] }))).toBeNull();
  });
});
