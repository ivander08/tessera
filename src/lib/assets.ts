import { apiOrigin } from './api';

/**
 * Resolves a server-relative path to a URL the current shell can load.
 *
 * The Worker stores avatar paths as `/api/characters/<id>/avatar`. In a browser tab
 * that is already absolute and correct. In the Capacitor and Tauri shells the SPA is
 * served from the shell's own origin, where `/api/...` would resolve against a server
 * that does not exist — so the Worker origin has to be prefixed.
 *
 * An already-absolute URL (a `data:` URL, or a fully-qualified one) is returned
 * untouched: prefixing it would corrupt it.
 */
export function resolveAssetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return path;
  return `${apiOrigin()}${path.startsWith('/') ? '' : '/'}${path}`;
}
