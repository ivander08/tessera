import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

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
 */
export interface AppBarProps {
  /** Left-aligned content: usually a back link. */
  lead?: ReactNode;
  title?: ReactNode;
  /** Right-aligned content, before the menu button. */
  trailing?: ReactNode;
  /** Chat-scoped entries, shown above the app-wide ones. */
  scoped?: ReactNode;
  onMenuOpen?: () => void;
}

export function AppBar({ lead, title, trailing, scoped, onMenuOpen }: AppBarProps) {
  const [open, setOpen] = useState(false);
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
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
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
      {title}
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
            setOpen((wasOpen) => {
              if (!wasOpen) onMenuOpen?.();
              return !wasOpen;
            });
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        {open && (
          <div className="menu" role="menu" onClick={(event) => {
            // The menu is a list of things to do, and every one of them changes what is
            // on screen — a link navigates, an action opens a sheet or writes a setting.
            // Leaving it open over the result is the "menu that will not go away" feel.
            //
            // The pencil opts out: it opens the preset editor, which is owned by the menu
            // subtree and would be unmounted by closing it.
            const target = event.target as HTMLElement;
            if (target.closest('[data-menu-keep]')) return;
            if (target.closest('button, a')) setOpen(false);
          }}>
            {scoped && (
              <>
                {scoped}
                <div className="menu-sep" />
              </>
            )}

            <div className="menu-label">Library</div>
            <MenuLink to="/characters" label="Characters" />
            <MenuLink to="/personas" label="Personas" />
            <MenuLink to="/presets" label="Presets" />

            <div className="menu-sep" />
            <div className="menu-label">Make</div>
            <MenuLink to="/forge" label="Forge a character" />
            <MenuLink to="/characters/new" label="Import a card" />

            <div className="menu-sep" />
            <MenuLink to="/" label="All chats" />
            <MenuLink to="/settings" label="Settings" />
          </div>
        )}
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

/** A back link sized and coloured for the titlebar. */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="icon-btn" aria-label={label} title={label}>
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </Link>
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
