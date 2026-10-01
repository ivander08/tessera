import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The save indicator.
 *
 * Every save surface in the app used to report its own way: four success idioms, four
 * failure idioms, and in two places the same uncoloured span for both — so a failed save
 * looked exactly like a successful one. One primitive means a save reads the same
 * everywhere, and "did it work" is answered by colour rather than by reading a sentence.
 *
 * Rendered into `document.body` through a portal, like `Modal`. The container is
 * `pointer-events: none` and never blocks the composer; a toast sits over the bottom of
 * the screen, which is where the composer is.
 *
 * Success auto-dismisses because it needs no acknowledgement. Failure persists because a
 * failed save is something the reader has to act on, and a message that vanishes before it
 * is read is worse than none.
 */

export type ToastKind = 'success' | 'failure';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  /** Green, auto-dismisses. Use for every successful save. */
  success: (text: string) => void;
  /** Red, stays until dismissed. Use for every failed save. */
  failure: (text: string) => void;
  dismiss: (id: number) => void;
}

/** A save loop must not stack toasts off the top of the screen; the oldest goes first. */
const MAX_VISIBLE = 3;
const SUCCESS_MS = 2500;

const ToastContext = createContext<ToastApi | null>(null);

/** The handle `setTimeout` returns under the app's lib set (DOM `number`, Bun `Timeout`). */
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  // Timers are keyed by toast id and reconciled in an effect rather than scheduled inside
  // the state updater: a `setTimeout` called from a reducer runs twice under StrictMode,
  // and a dropped toast's timer would then outlive the toast and fire a stale `setState`.
  const timers = useRef(new Map<number, TimerHandle>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextId.current++;
    setToasts((current) => {
      const next = [...current, { id, kind, text }];
      const overflow = next.length - MAX_VISIBLE;
      return overflow > 0 ? next.slice(overflow) : next;
    });
  }, []);

  // One reconciliation for both jobs: schedule a success's auto-dismiss, and clear the
  // timer of any toast that left the list (dismissed, dropped by the cap, or unmounted).
  useEffect(() => {
    const live = new Set(toasts.map((item) => item.id));
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const item of toasts) {
      if (item.kind === 'success' && !timers.current.has(item.id)) {
        timers.current.set(
          item.id,
          setTimeout(() => dismiss(item.id), SUCCESS_MS),
        );
      }
    }
  }, [toasts, dismiss]);

  // Unmount clears everything, so a pending timer cannot call `setState` after the
  // provider is gone.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (text) => push('success', text),
      failure: (text) => push('failure', text),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((item) => (
            <div key={item.id} className={`toast ${item.kind}`}>
              <span className="toast-text">{item.text}</span>
              <button
                type="button"
                className="toast-close"
                aria-label="Dismiss"
                onClick={() => dismiss(item.id)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** Throws outside the provider, so a missing mount is a loud error rather than a no-op. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used within a ToastProvider');
  return api;
}
