import { statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * The `ASSETS` binding, over `dist/`.
 *
 * In the Worker runtime this was the Static Assets binding, configured with
 * `not_found_handling: "single-page-application"` in `wrangler.jsonc`. That single config
 * line is the only thing being reimplemented here: a request for a real file gets the
 * file, and anything else gets `index.html` so the client-side router can answer it.
 *
 * Two properties matter and are the reason this is not a one-liner:
 *
 * - The resolved path must stay inside `dist/`. A request for `/../../etc/passwd` decodes
 *   to a path that escapes the root; the containment check below is what makes traversal
 *   impossible rather than merely unlikely.
 * - A missing file is not an error. `/chat/abc-123` is a route, not a typo, and answering
 *   it with a 404 would break every deep link and every reload.
 */

const DIST = resolve(import.meta.dir, '..', 'dist');
const INDEX = join(DIST, 'index.html');

/**
 * Extensions that mean "this was meant to be a file".
 *
 * A miss on one of these is a genuine 404 — a stale `/assets/index-abc123.js` after a
 * deploy must not silently return HTML, or the browser reports a syntax error in an HTML
 * document instead of a missing chunk. Everything else falls back to the SPA.
 */
const ASSET_EXTENSIONS: Record<string, true> = {
  '.js': true,
  '.mjs': true,
  '.css': true,
  '.map': true,
  '.json': true,
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.svg': true,
  '.webp': true,
  '.ico': true,
  '.woff': true,
  '.woff2': true,
  '.ttf': true,
  '.otf': true,
  '.txt': true,
  '.webmanifest': true,
};

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/**
 * The file for a URL path, or null when there is none.
 *
 * `decodeURIComponent` can throw on a malformed escape (`/%`), which is a bad request
 * rather than a missing file — both end up as "no file", which is the right answer here.
 */
function fileFor(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const candidate = resolve(DIST, `.${normalize(decoded)}`);
  // `resolve` collapses `..`, so this is the check that actually holds the line. The
  // trailing separator keeps `/dist-other` from passing as a child of `/dist`.
  if (candidate !== DIST && !candidate.startsWith(DIST + sep)) return null;

  try {
    if (!statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

/** The SPA shell, for a route rather than a file. */
async function indexHtml(): Promise<Response> {
  const file = Bun.file(INDEX);
  if (!(await file.exists())) {
    // `dist/` is a build artifact and is gitignored. Saying so beats a bare 404 when
    // someone runs the server before `bun run build`.
    return new Response('dist/index.html is missing — run `bun run build` first.', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }
  return new Response(file, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function serveAssets(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (req.method === 'GET' || req.method === 'HEAD') {
    const path = fileFor(pathname);
    if (path) return new Response(Bun.file(path));
  }

  // A miss that names an asset extension is a real 404; anything else is a client route.
  const lastDot = pathname.lastIndexOf('.');
  const extension = lastDot === -1 ? '' : pathname.slice(lastDot).toLowerCase();
  if (ASSET_EXTENSIONS[extension]) return notFound();

  return await indexHtml();
}
