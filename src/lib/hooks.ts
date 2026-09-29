import { useEffect, useRef, useState } from 'react';
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

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
