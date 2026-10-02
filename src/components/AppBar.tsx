import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

/**
 * The titlebar, and the app's only navigation.
 *
 * Before this, each screen hand-rolled its own pair of links, so which destinations
 * existed depended on where you already were — Personas, Presets and Forge were reachable
 * only by typing the URL. One menu, on every screen, listing everything.
 *
 * Escape closes it, a click outside closes it, and navigating closes it. A menu that
 * stays open after you use it is the kind of small wrongness that makes an app feel
 * unfinished.
 *
 * Clicks inside a SHEET opened from this menu are exempt from both closers. `Modal`
 * portals to `document.body`, so sheet content is not a descendant of the menu's own
 * wrapper, and React portal events still bubble through the React tree back to the menu.
 * Without the exemption every row in the sheet read as a click outside, and the menu
 * unmounted the subtree that owned the sheet before the row's handler could run.
 */
export interface AppBarProps {
  /** Left-aligned content: usually a back link. */
  lead?: ReactNode;
  title?: ReactNode;
  /** Right-aligned content, before the menu button. */
  trailing?: ReactNode;
  /** Chat-scoped entries, shown above the app-wide ones. */
  scoped?: ReactNode;
  /**
   * Where the title links to, or null to leave it plain text.
   *
   * Defaults to the scene list, because the title is the app's most reliable way back: it
   * is in the same place on every screen and it is what a reader reaches for when they
   * are lost.
   *
   * It is suppressed when the bar already has a `lead` back link, which goes somewhere
   * more specific — the character list, the chat you came from. Two arrows side by side
   * pointing at different places is not a richer affordance, it is a question.
   */
  titleHref?: string | null;
}

export function AppBar({
  lead,
  title,
  trailing,
  scoped,
  titleHref,
}: AppBarProps) {
  // One way back. A screen with its own back link keeps that one and shows a plain title.
  const href = titleHref !== undefined ? titleHref : lead ? null : '/';
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement | null>(null);
  const location = useLocation();

  // Close on navigation: the menu is a list of places to go, so arriving anywhere means
  // it has done its job.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      // A sheet opened from this menu is portaled to `document.body` (see `Modal`), so it
      // is NOT a DOM descendant of `wrap`. Without this exemption the containment test
      // below fails for every node inside the sheet, the menu unmounts the subtree that
      // owns the sheet, and the click that was meant for a row lands on `body` instead —
      // the sheet closes and nothing happens.
      if (target instanceof Element && target.closest('.sheet-backdrop')) return;
      if (!wrap.current?.contains(target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="bar">
      {lead}
      {href && title ? (
        <Link to={href} className="bar-home" title="All chats">
          {title}
        </Link>
      ) : (
        title
      )}
      <div className="bar-spacer" />
      {trailing}

      <div className="menu-wrap" ref={wrap}>
        <button
          type="button"
          className="icon-btn"
          aria-label="Menu"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => {
            setOpen((wasOpen) => !wasOpen);
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              className="menu"
              role="menu"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              // `pointerEvents` rides in the exit variant rather than in a `style` driven
              // by a closing flag: AnimatePresence only starts the exit once the child is
              // removed from the tree, so a flag that keeps it rendered deadlocks the
              // animation and the menu never leaves.
              exit={{ opacity: 0, y: -4, scale: 0.98, pointerEvents: 'none' }}
              transition={{ duration: reduced ? 0 : 0.12, ease: [0.22, 0.68, 0.36, 1] }}
              // It unfurls from the button that opened it rather than from its own centre.
              style={{ transformOrigin: 'top right' }}
              onClick={(event) => {
                // The menu is a list of things to do, and most of them change what is on
                // screen — a link navigates, an action writes a setting. Leaving it open over
                // the result is the "menu that will not go away" feel.
                //
                // Entries that open a SHEET opt out with `data-menu-keep`: the sheet is owned
                // by this subtree, so closing the menu would unmount it before it paints.
                const target = event.target as HTMLElement;
                // A sheet opened from this menu is portaled out of `wrap`; its clicks are not
                // menu clicks, and closing here would unmount the sheet before it can act.
                if (target.closest('.sheet-backdrop')) return;
                if (target.closest('[data-menu-keep]')) return;
                if (target.closest('button, a')) setOpen(false);
              }}
            >
              {scoped && (
                <>
                  {scoped}
                  <div className="menu-sep" />
                </>
              )}

              {/* The way home goes first. Everything else in this menu is a destination,
                  and the one you need most often is the one you came from. */}
              <MenuLink to="/" label="All chats" />
              <MenuLink to="/settings" label="Settings" />

              <div className="menu-sep" />
              <div className="menu-label">Library</div>
              <MenuLink to="/characters" label="Characters" />
              <MenuLink to="/personas" label="Personas" />
              <MenuLink to="/presets" label="Presets" />

              <div className="menu-sep" />
              <div className="menu-label">Make</div>
              <MenuLink to="/forge" label="Forge a character" />
              <MenuLink to="/characters/new" label="Import a card" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}

function MenuLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="menu-item" role="menuitem">
      {label}
    </Link>
  );
}

/**
 * The way back, written as the trail you are on.
 *
 * A bare chevron says "back" but not "back to what", and the titlebar already has a
 * title next to it — so the two together read as a breadcrumb: `< Characters  WS-G Probe`.
 * The parent is a link, the current screen is the title beside it, and nothing is
 * duplicated between them.
 *
 * This is the same control on every screen that has one, which is why it lives here
 * rather than being spelled differently by each route.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="crumb" title={`Back to ${label}`}>
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      <span>{label}</span>
    </Link>
  );
}

/** The separator between a parent and the current screen in a titlebar breadcrumb. */
export function CrumbSep() {
  return (
    <span className="crumb-sep" aria-hidden="true">
      ›
    </span>
  );
}

/** A menu entry that runs an action rather than navigating. */
export function MenuAction({ label, onClick, hint }: { label: string; onClick: () => void; hint?: string }) {
  return (
    <button type="button" className="menu-item" role="menuitem" onClick={onClick}>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <span className="data">{hint}</span>}
    </button>
  );
}

/** A non-interactive heading inside the menu. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}

export function MenuSep() {
  return <div className="menu-sep" />;
}
