import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * The open-sheet stack, innermost last.
 *
 * A sheet can open a sheet — `CastPanel` renders a `ConfirmPrompt` over itself — and
 * without this an Escape closes both at once, which means one keypress dismisses a
 * question the reader never answered.
 */
const sheetStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Everything a modal panel needs beyond its own animation: a focus trap, focus
 * restoration, `inert` on the page behind it, and an Escape that only fires for the
 * topmost sheet.
 *
 * `inert` rather than `aria-hidden` plus a pointer-events guard: it removes the subtree
 * from the tab order, from hit testing and from the accessibility tree in one attribute,
 * which is exactly the three things a background page needs to stop doing. It is
 * supported in every current browser.
 */
export function useDialogFocus(
  panelRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  useEffect(() => {
    const id = Symbol('sheet');
    sheetStack.push(id);

    const panel = panelRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const app = document.getElementById('root');
    // Reference-counted, not a plain set/remove: a `ConfirmPrompt` over a `CastPanel` is
    // two sheets on one page, and the inner one closing must not hand the background back
    // while the outer one is still up.
    if (sheetStack.length === 1) app?.setAttribute('inert', '');

    function focusables(): HTMLElement[] {
      if (!panel) return [];
      return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
    }

    // Focus moves into the sheet rather than staying on the control that opened it: a
    // dialog the reader cannot reach with the keyboard is a dialog they cannot answer.
    const first = focusables()[0];
    (first ?? panel)?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (sheetStack[sheetStack.length - 1] === id) {
          event.stopPropagation();
          onEscape();
        }
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      const nodes = focusables();
      if (nodes.length === 0) {
        // Nothing to move between, so keep focus on the panel rather than letting Tab
        // walk out into the inert document behind it.
        event.preventDefault();
        panel.focus();
        return;
      }
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === firstNode || active === panel || !panel.contains(active)) {
          event.preventDefault();
          lastNode.focus();
        }
      } else if (active === lastNode || !panel.contains(active)) {
        event.preventDefault();
        firstNode.focus();
      }
    }

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = sheetStack.indexOf(id);
      if (at >= 0) sheetStack.splice(at, 1);
      if (sheetStack.length === 0) app?.removeAttribute('inert');
      // Back to whatever opened the sheet, so the keyboard does not restart at the top of
      // the page after a dialog that was dismissed without changing anything.
      previous?.focus?.();
    };
  }, [panelRef, onEscape]);
}
