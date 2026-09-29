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
      },
      'kn-test',
    );
    expect(url).toBe('https://kenari.id/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-v4-1-flash');
    expect(body).not.toHaveProperty('session_id');
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
});
