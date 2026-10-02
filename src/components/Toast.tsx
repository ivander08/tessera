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
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

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
  // Ids on their way out. A dismissed toast is not dropped from `toasts` — that would
  // unmount it in one frame and the stack below would snap upward. It is moved here, the
  // exit variant runs, and `onExitComplete` removes it for real.
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(() => new Set());
  const nextId = useRef(1);
  const reduced = useReducedMotion();
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
    setLeaving((current) => new Set(current).add(id));
  }, []);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, kind, text }]);
  }, []);

  // One reconciliation for three jobs: schedule a success's auto-dismiss, clear the timer
  // of any toast that is leaving or gone, and push the oldest over the cap into `leaving`
  // rather than slicing it out — the cap has to leave through the same door, or the stack
  // still snaps when a fourth save lands.
  useEffect(() => {
    const live = toasts.filter((item) => !leaving.has(item.id));
    const overflow = live.length - MAX_VISIBLE;
    if (overflow > 0) {
      setLeaving((current) => {
        const next = new Set(current);
        for (const item of live.slice(0, overflow)) next.add(item.id);
        return next;
      });
      return;
    }
    const liveIds = new Set(live.map((item) => item.id));
    for (const [id, timer] of timers.current) {
      if (!liveIds.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const item of live) {
      if (item.kind === 'success' && !timers.current.has(item.id)) {
        timers.current.set(
          item.id,
          setTimeout(() => dismiss(item.id), SUCCESS_MS),
        );
      }
    }
  }, [toasts, leaving, dismiss]);

  // Unmount clears everything, so a pending timer cannot call `setState` after the
  // provider is gone.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  // The exit has finished for everything in `leaving`; now they can leave the array.
  const settle = useCallback(() => {
    setToasts((current) => current.filter((item) => !leaving.has(item.id)));
    setLeaving((current) => (current.size === 0 ? current : new Set()));
  }, [leaving]);

  const api = useMemo<ToastApi>(
    () => ({
      success: (text) => push('success', text),
      failure: (text) => push('failure', text),
      dismiss,
    }),
    [push, dismiss],
  );

  const visible = toasts.filter((item) => !leaving.has(item.id));
  const exitDuration = reduced ? 0 : 0.16;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-stack" role="status" aria-live="polite">
          <AnimatePresence initial={false} onExitComplete={settle}>
            {visible.map((item) => (
              // `layout` is what makes the survivors slide rather than jump when one
              // leaves — the siblings' positions are not animatable CSS properties, so
              // this is the case a transition genuinely cannot do.
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: exitDuration, ease: [0.22, 0.68, 0.36, 1] }}
                className={`toast ${item.kind}`}
              >
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
              </motion.div>
            ))}
          </AnimatePresence>
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
