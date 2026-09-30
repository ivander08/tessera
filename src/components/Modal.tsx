import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A sheet over the current screen.
 *
 * Used where a task would otherwise mean navigating away from what you were doing —
 * editing a preset mid-scene, adjusting the type you are reading. The cost of losing your
 * place is higher than the cost of a dialog.
 *
 * Rendered into `document.body` through a portal rather than where it is declared. It is
 * opened from inside the chat menu, which scrolls and is absolutely positioned — a fixed
 * sheet nested in a scroll container is positioned against that container, so it lands
 * off-screen the moment the menu is taller than the viewport.
 *
 * Escape closes it and the scrim is a button, so it can be dismissed without hunting for
 * an X. The body scrolls rather than the sheet growing past the viewport, which is what
 * makes this usable on a phone.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while the sheet is open, or a flick inside the
    // sheet drags the transcript underneath it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div className="sheet-backdrop" role="presentation">
      <button
        type="button"
        className="sheet-scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="sheet-panel" role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-panel-head">
          <div className="sheet-panel-title">
            <span className="eyebrow">{title}</span>
            {subtitle && <p className="sheet-panel-sub">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="sheet-panel-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
