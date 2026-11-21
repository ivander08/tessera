import { useEffect, useRef } from 'react';

/**
 * One history entry per open sheet, so the browser's Back closes the sheet before it
 * leaves the route.
 *
 * That is the mobile-web convention: a drawer that swallows the hardware Back button
 * and dumps the reader on the previous screen is the most-reported navigation bug in
 * hybrid apps. Each sheet pushes its own entry carrying a unique id; a `popstate` closes
 * the sheet only when ITS id is the one that went, so a sheet stacked over another (a
 * `ConfirmPrompt` over a panel) does not take the one below it down with it.
 *
 * The entry is discarded with `history.back()` on unmount while it is still on top —
 * that is the X / Escape / scrim path. The id check matters there too: if Back already
 * popped the entry, popping again would eat the route underneath.
 *
 * The previous entry's state is spread into the new one rather than replaced: React
 * Router keeps its own bookkeeping (`key`, `idx`) in `history.state`, and overwriting
 * it corrupts the router's idea of the stack.
 *
 * `close` must be stable across renders (both dialog components pass a `useCallback`
 * with no deps): the effect that owns the pushed entry re-runs on identity change and
 * would claim a second entry.
 */
let sheetCounter = 0;

export function useSheetHistory(close: () => void): void {
  const pushedRef = useRef(false);

  useEffect(() => {
    const id = `sheet-${(sheetCounter += 1)}`;
    window.history.pushState({ ...(window.history.state ?? {}), sheetId: id }, '');
    pushedRef.current = true;

    const onPopState = (event: PopStateEvent) => {
      // Our id is still current: the pop belonged to a sheet stacked above us.
      if (event.state?.sheetId === id) return;
      pushedRef.current = false;
      close();
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      if (pushedRef.current && window.history.state?.sheetId === id) {
        pushedRef.current = false;
        window.history.back();
      }
    };
  }, [close]);
}
