import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

/**
 * The floating frame the consultant lives in.
 *
 * Desktop: a panel you drag by its header, because the field you are asking about is
 * somewhere on the form behind it — a fixed column would have pushed that form into half the
 * width, which is what this replaces.
 *
 * Phone: a bottom sheet anchored above the commit row, resized by dragging its grab bar. It
 * cannot be moved horizontally because there is nowhere to move it to.
 *
 * Position is kept as an offset from the bottom-right corner rather than as absolute
 * coordinates. That way the panel stays where the reader put it when the window resizes,
 * instead of drifting off the edge.
 *
 * The drag handlers are handed to the CHILD rather than applied to a header rendered here:
 * `ConsultPanel` already owns its header, and a second one in this file would be two headers
 * to keep in step.
 */
export function ConsultDock({
  children,
  className = '',
  label = 'Character consultant',
}: {
  children: (handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  }) => ReactNode;
  /**
   * An extra class on the dock itself, for a screen that needs to adjust where the dock
   * sits. The chat adds one because it has no `.sheet-commit` row for the sheet to measure.
   */
  className?: string;
  /** What a screen reader calls this dialog. The chat's dock advises, it does not consult. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Distance from the right and bottom edges, in px.
  const [offset, setOffset] = useState({ right: 24, bottom: 88 });
  const [height, setHeight] = useState(520);
  // Drag state lives in a ref: a move handler that re-rendered on every pointer event would
  // put the whole transcript through React sixty times a second.
  const drag = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  const resize = useRef<{ y: number; height: number } | null>(null);
  // A second, coarser flag for the settle transition: the refs above are deliberately not
  // render-visible, but `is-dragging` has to change the class, so this one is state. It
  // flips once per gesture, not once per move, so it costs nothing.
  const [dragging, setDragging] = useState(false);

  // Clamp into the viewport when the window shrinks, so a panel dragged to the far corner of
  // a large window is still on screen on a laptop.
  useEffect(() => {
    function clamp() {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      setOffset((current) => ({
        right: Math.max(8, Math.min(current.right, window.innerWidth - box.width - 8)),
        bottom: Math.max(8, Math.min(current.bottom, window.innerHeight - 120)),
      }));
    }
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  // On a phone the sheet sits ON TOP of the commit row, so it needs that row's real height.
  // A guessed constant left a gap under the sheet when the row wrapped to two lines, which
  // it does at 420px with three buttons.
  useEffect(() => {
    const row = document.querySelector('.sheet-commit');
    if (!row) return;
    const measure = () => {
      const height = row.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--commit-height', `${Math.round(height)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--commit-height');
    };
  }, []);

  /** True on a phone-width viewport, where the sheet is anchored and only resizes. */
  function anchored(): boolean {
    return window.matchMedia('(max-width: 1000px)').matches;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (anchored()) return;
    // A press on a button is a click, not the start of a drag.
    if ((event.target as HTMLElement).closest('button')) return;
    drag.current = { x: event.clientX, y: event.clientY, ...offset };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const start = drag.current;
    if (!start) return;
    const box = ref.current?.getBoundingClientRect();
    const width = box?.width ?? 440;
    const heightNow = box?.height ?? 520;
    setOffset({
      right: Math.max(8, Math.min(start.right - (event.clientX - start.x), window.innerWidth - width - 8)),
      bottom: Math.max(8, Math.min(start.bottom - (event.clientY - start.y), window.innerHeight - heightNow - 8)),
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  /** The phone's grab bar: drag up to grow, down to shrink. */
  function onGrabDown(event: ReactPointerEvent<HTMLElement>) {
    resize.current = { y: event.clientY, height };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onGrabMove(event: ReactPointerEvent<HTMLElement>) {
    const start = resize.current;
    if (!start) return;
    const next = start.height + (start.y - event.clientY);
    setHeight(Math.max(160, Math.min(next, window.innerHeight - 140)));
  }

  function onGrabUp(event: ReactPointerEvent<HTMLElement>) {
    resize.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      ref={ref}
      className={`consult-dock${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      // Position goes through custom properties rather than `right`/`bottom` directly, so the
      // phone's media query can ignore the desktop offset without fighting an inline style —
      // an inline `bottom` beats a media query, which pinned the sheet 88px up the screen
      // instead of against the commit row.
      style={
        {
          '--dock-right': `${offset.right}px`,
          '--dock-bottom': `${offset.bottom}px`,
          '--dock-height': `${height}px`,
        } as React.CSSProperties
      }
      role="dialog"
      aria-label={label}
    >
      {/* Phone only: the handle that resizes the sheet. */}
      <div
        className="consult-grab"
        role="separator"
        aria-label="Resize the consultant"
        onPointerDown={onGrabDown}
        onPointerMove={onGrabMove}
        onPointerUp={onGrabUp}
        onPointerCancel={onGrabUp}
      >
        <span />
      </div>

      {children({ onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag })}
    </div>
  );
}
