/**
 * CORS for local development.
 *
 * In production the SPA is served by the same process as `/api/*`, so every call is
 * same-origin and no CORS applies. The only cross-origin caller left is `vite dev`
 * running the SPA on its own port while the API runs elsewhere, which is what the
 * allowlist below exists for.
 *
 * `Authorization: Bearer …` is not a CORS-safelisted request header, so EVERY `/api/*`
 * call is preflighted. The preflight carries no `Authorization` header by design, which
 * is why it must be answered before the auth check — routing it through `isAuthorized`
 * would 401 every one of them and the dev SPA would simply never work.
 *
 * The allowlist is explicit rather than `*`: the bearer token is the only credential, and
 * `*` would let any page on the internet drive this API from a user's browser.
 */

const ALLOWED_ORIGINS: Record<string, true> = {
  // `wrangler dev` serving the SPA to a second dev port (e.g. `vite` on 5180).
  // 5173 is Vite's default and belongs to whatever else is running on this machine;
  // this project claims its own port so `bun run dev` never collides. Keep in sync
  // with `server.port` in `vite.config.ts`.
  'http://localhost:5180': true,
  'http://127.0.0.1:5180': true,
};

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS[origin]) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    // Cache the preflight so the round trip is not paid on every single request.
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/** `204` for a preflight, or `null` when this is not a preflight. */
export function preflight(req: Request, origin: string | null): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/**
 * Adds the CORS headers to a response without disturbing its body stream. Returning the
 * original response would drop the headers, and buffering the body to re-wrap it would
 * defeat streaming — which is the whole point of the chat endpoint.
 */
export function withCors(res: Response, origin: string | null): Response {
  const headers = corsHeaders(origin);
  if (Object.keys(headers).length === 0) return res;
  const merged = new Headers(res.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: merged,
  });
}
