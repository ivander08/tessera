import { describe, expect, test } from 'bun:test';
import { corsHeaders, preflight, withCors } from './cors';

/**
 * The native shells cannot reach the API at all without these headers, and the failure
 * is silent in the app — the webview just refuses the request. So the origins are pinned
 * here rather than left to whatever string someone types next.
 */
describe('cors', () => {
  test('allows every origin the native shells actually use', () => {
    // Tauri v2 on Windows defaults to http, NOT https. Getting this wrong makes the
    // desktop build unable to make a single API call.
    for (const origin of [
      'http://tauri.localhost',
      'https://tauri.localhost',
      'tauri://localhost',
      'https://localhost',
    ]) {
      expect(corsHeaders(origin)['access-control-allow-origin']).toBe(origin);
    }
  });

  test('echoes the exact origin and varies on it, never a wildcard', () => {
    const headers = corsHeaders('https://localhost');
    expect(headers['access-control-allow-origin']).toBe('https://localhost');
    expect(headers['access-control-allow-origin']).not.toBe('*');
    // Without Vary a shared cache could serve one origin's response to another.
    expect(headers.vary).toBe('Origin');
  });

  test('allows the preflight request headers a bearer-token call needs', () => {
    const headers = corsHeaders('https://localhost');
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
      headers: { origin: 'https://localhost' },
    });
    const res = preflight(req, 'https://localhost');
    expect(res?.status).toBe(204);
    expect(res?.headers.get('access-control-allow-origin')).toBe('https://localhost');
  });

  test('is not a preflight for non-OPTIONS requests', () => {
    const req = new Request('https://x/api/chats', { headers: { origin: 'https://localhost' } });
    expect(preflight(req, 'https://localhost')).toBeNull();
  });

  test('adds headers to a response without losing its body or status', () => {
    const original = new Response('{"ok":true}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = withCors(original, 'http://tauri.localhost');

    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get('content-type')).toBe('application/json');
    expect(wrapped.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
  });

  test('leaves an unlisted origin response untouched', () => {
    const original = new Response('x', { status: 200 });
    const wrapped = withCors(original, 'https://evil.example');
    expect(wrapped.headers.get('access-control-allow-origin')).toBeNull();
  });
});
