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
 * Warn before a form's edits are thrown away.
 *
 * Two exits need covering and they need different mechanisms. A reload or a tab close
 * cannot be intercepted with a custom dialog, so `beforeunload` asks the browser's own
 * question. In-app navigation is a plain anchor click through `react-router`'s `<Link>`,
 * which fires no event the router exposes without a data router — and this app renders
 * `<BrowserRouter>` with plain `<Routes>`, so `useBlocker` is not available. A
 * capture-phase click listener on the document catches the anchor before React Router's
 * handler sees it, which is the whole mechanism.
 *
 * Only same-origin navigations are intercepted: an external link is not leaving unsaved
 * work behind in this app.
 */
export function useUnsavedGuard(dirty: boolean, message = 'You have unsaved changes.'): void {
  useEffect(() => {
    if (!dirty) return;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Some browsers ignore `preventDefault` here and show the prompt only when
      // `returnValue` is set. The string itself is not shown any more.
      event.returnValue = message;
      return message;
    }

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

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, message]);
}
