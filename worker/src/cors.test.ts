import { describe, expect, test } from 'bun:test';
import { corsHeaders, preflight, withCors } from './cors';

/**
 * These origins are the only cross-origin callers the API has left: `vite dev` serving the
 * SPA on its own port while the API runs elsewhere. Production is same-origin, so a
 * regression here is invisible in the deployed app and shows up only as the dev SPA
 * failing every request — hence the pinning rather than trusting a string someone types.
 */
describe('cors', () => {
  test('allows both dev origins the SPA is served from', () => {
    for (const origin of ['http://localhost:5180', 'http://127.0.0.1:5180']) {
      expect(corsHeaders(origin)['access-control-allow-origin']).toBe(origin);
    }
  });

  test('echoes the exact origin and varies on it, never a wildcard', () => {
    const headers = corsHeaders('http://localhost:5180');
    expect(headers['access-control-allow-origin']).toBe('http://localhost:5180');
    expect(headers['access-control-allow-origin']).not.toBe('*');
    // Without Vary a shared cache could serve one origin's response to another.
    expect(headers.vary).toBe('Origin');
  });

  test('allows the preflight request headers a bearer-token call needs', () => {
    const headers = corsHeaders('http://localhost:5180');
    expect(headers['access-control-allow-headers']).toContain('authorization');
    expect(headers['access-control-allow-methods']).toContain('OPTIONS');
  });

  test('gives an unlisted origin no CORS headers at all', () => {
    expect(corsHeaders('https://evil.example')).toEqual({});
    expect(corsHeaders(null)).toEqual({});
  });

  test('answers OPTIONS with 204 and no auth requirement', () => {
    const req = new Request('https://x/api/chats', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5180' },
    });
    const res = preflight(req, 'http://localhost:5180');
    expect(res?.status).toBe(204);
    expect(res?.headers.get('access-control-allow-origin')).toBe('http://localhost:5180');
  });

  test('is not a preflight for non-OPTIONS requests', () => {
    const req = new Request('https://x/api/chats', { headers: { origin: 'http://localhost:5180' } });
    expect(preflight(req, 'http://localhost:5180')).toBeNull();
  });

  test('adds headers to a response without disturbing its body stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.enqueue(new TextEncoder().encode('true}'));
        controller.close();
      },
    });
    const original = new Response(stream, {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = withCors(original, 'http://localhost:5180');

    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get('content-type')).toBe('application/json');
    expect(wrapped.headers.get('access-control-allow-origin')).toBe('http://localhost:5180');
    // Re-wrapping must hand the same live body through, not a buffered copy: the chat
    // endpoint streams its reply, and reading it to completion here would end that.
    expect(await wrapped.text()).toBe('{"ok":true}');
  });

  test('leaves an unlisted origin response untouched', () => {
    const original = new Response('x', { status: 200 });
    const wrapped = withCors(original, 'https://evil.example');
    expect(wrapped.headers.get('access-control-allow-origin')).toBeNull();
  });
});
