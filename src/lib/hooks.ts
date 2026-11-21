import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { OfflineError, UnauthorizedError, clearToken } from './api';

/**
 * Every screen needs the same three failure behaviours: a 401 sends you to token
 * entry, an unreachable Worker is reported without wiping the token, and anything
 * else shows its message. One hook so no screen re-invents it.
 *
 * `deps` drives re-fetching the same way a `useEffect` dependency array does. The
 * loader itself is held in a ref rather than a dependency: it is a fresh closure on
 * every render, so depending on it directly would re-fetch in a loop, and wrapping it
 * in `useCallback(load, deps)` would silently ignore the caller's deps.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const navigate = useNavigate();

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadRef
      .current()
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        if (cause instanceof UnauthorizedError) {
          clearToken();
          navigate('/setup', { replace: true });
          return;
        }
        setError(
          cause instanceof OfflineError ? `Worker unreachable: ${cause.message}` : messageOf(cause),
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps are the contract
  }, [...deps, nonce, navigate]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Warn before a refresh or a tab close throws away a form's edits.
 *
 * `beforeunload` is the only mechanism for these exits: the browser owns the reload
 * button and the window close, so the most this can do is ask the browser's own question.
 *
 * `returnValue` is set next to `preventDefault` because Chrome shows the prompt only when
 * it is assigned. The string it used to carry is no longer displayed, so empty is enough.
 *
 * In-app link navigation is deliberately outside this hook's scope: a capture-level click
 * guard nags on every route hop the app's own links take, and warning on those is not the
 * standard minimum. Screens that want the extra catch use `useUnsavedGuard` below.
 *
 * Nothing is registered while `dirty` is false, so a clean form leaves no listener behind
 * to speak for a page it has no opinion about.
 */
export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

/**
 * `useUnsavedChanges` plus the in-app link catch.
 *
 * An in-app navigation is a plain anchor click through `react-router`'s `<Link>`, which
 * fires no event the router exposes without a data router — and this app renders
 * `<BrowserRouter>` with plain `<Routes>`, so `useBlocker` is not available. A
 * capture-phase click listener on the document catches the anchor before React Router's
 * handler sees it, which is the whole mechanism.
 *
 * Only same-origin navigations are intercepted: an external link is not leaving unsaved
 * work behind in this app.
 */
export function useUnsavedGuard(dirty: boolean, message = 'You have unsaved changes.'): void {
  useUnsavedChanges(dirty);

  useEffect(() => {
    if (!dirty) return;

    function onClick(event: MouseEvent) {
      // Modified clicks open a new tab and leave this document untouched.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      if (anchor.getAttribute('target') === '_blank') return;

      const target = new URL(anchor.href, window.location.href);
      if (target.origin !== window.location.origin) return;
      if (target.pathname === window.location.pathname && target.search === window.location.search) {
        return;
      }
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [dirty, message]);
}
