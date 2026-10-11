import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { animate, useReducedMotion } from 'motion/react';

/**
 * Apple's momentum projection.
 *
 * The resting point of a gesture with velocity `v` is `(v/1000)·d/(1−d)` — the sum of a
 * geometric series, which is what a deceleration actually is. `v²/(2·decel)` is the
 * constant-deceleration formula and projects roughly three times too far; the exponential
 * form is the one the platform uses.
 */
function project(velocity: number, deceleration = 0.998): number {
  return ((velocity / 1000) * deceleration) / (1 - deceleration);
}

/**
 * Progressive resistance past a bound.
 *
 * A hard clamp stops the element dead at the edge, which reads as the gesture having been
 * dropped rather than having hit something. This follows the pointer the whole way but by
 * progressively less, so the edge is felt before it is reached.
 *
 * Returns the DAMPED OVERSHOOT, whose magnitude is always less than the overshoot it was
 * given. It replaces the raw overshoot rather than adding to it: `raw + rubberband(...)`
 * would push the element further than the pointer, which is the opposite of resistance.
 */
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** A value with progressive resistance applied at both bounds. */
function resisted(value: number, min: number, max: number, dimension: number): number {
  if (value < min) return min + rubberband(value - min, dimension);
  if (value > max) return max + rubberband(value - max, dimension);
  return value;
}

/** The phone sheet's resting heights, as fractions of the space above the commit row. */
const DETENTS = [0.35, 0.65, 1];

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
  const reduced = useReducedMotion();
  // Distance from the right and bottom edges, in px.
  const [offset, setOffset] = useState({ right: 24, bottom: 88 });
  const [height, setHeight] = useState(() =>
    // A 520px sheet plus a ~58px commit row does not fit a 568px-tall phone, which put the
    // close button off-screen. The ceiling is the viewport, not a constant.
    typeof window === 'undefined' ? 520 : Math.min(520, window.innerHeight - 140),
  );
  /**
   * Live drag state. Everything the move handler needs is captured at `pointerdown`,
   * including the element's own box — measuring inside the move handler forces a synchronous
   * layout on every pointer event, and writing the value to React state re-rendered the
   * panel and the whole transcript through the render prop sixty times a second.
   */
  const drag = useRef<{
    x: number;
    y: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    samples: Array<{ t: number; x: number; y: number }>;
    /** The live, banded position. Written by the move handler, read by the release. */
    current: { right: number; bottom: number };
  } | null>(null);
  const resize = useRef<{
    y: number;
    height: number;
    samples: Array<{ t: number; y: number }>;
    /** The live, banded height. Written by the move handler, read by the release. */
    current: number;
  } | null>(null);
  // A second, coarser flag for the settle transition: the refs above are deliberately not
  // render-visible, but `is-dragging` has to change the class, so this one is state. It
  // flips once per gesture, not once per move, so it costs nothing.
  const [dragging, setDragging] = useState(false);

  /** True on a phone-width viewport, where the sheet is anchored and only resizes. */
  const anchored = useCallback(
    () => window.matchMedia('(max-width: 1000px)').matches,
    [],
  );

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
      setHeight((current) => Math.min(current, window.innerHeight - 140));
    }
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  // On a phone the sheet sits ON TOP of the commit row, so it needs that row's real height.
  // A guessed constant left a gap under the sheet when the row wrapped to two lines, which
  // it does once the three buttons no longer fit on one — which is a function of the button
  // text, not of a breakpoint. Measuring is the honest answer; there is no width tier that
  // predicts it.
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

  /**
   * Velocity in px/s over the last ~80ms of a gesture.
   *
   * Sampling a window rather than taking the last two events: a pointer that paused before
   * release has a velocity of zero, and a two-sample estimate from a slow frame reads as a
   * flick. Zero when the samples do not span enough time to mean anything.
   */
  function velocityOf(samples: Array<{ t: number; x: number; y: number }>): { x: number; y: number } {
    if (samples.length < 2) return { x: 0, y: 0 };
    const last = samples[samples.length - 1];
    let first = samples[0];
    for (let i = samples.length - 1; i >= 0; i -= 1) {
      if (last.t - samples[i].t > 80) break;
      first = samples[i];
    }
    const dt = last.t - first.t;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: ((last.x - first.x) / dt) * 1000, y: ((last.y - first.y) / dt) * 1000 };
  }

  /** Writes the live value straight to the DOM. No state, no re-render, no measurement. */
  function writeRight(value: number): void {
    ref.current?.style.setProperty('--dock-right', `${value}px`);
  }

  function writeBottom(value: number): void {
    ref.current?.style.setProperty('--dock-bottom', `${value}px`);
  }

  function writeHeight(value: number): void {
    ref.current?.style.setProperty('--dock-height', `${value}px`);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (anchored()) return;
    // A press on a button is a click, not the start of a drag.
    if ((event.target as HTMLElement).closest('button')) return;
    const box = ref.current?.getBoundingClientRect();
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ...offset,
      width: box?.width ?? 440,
      height: box?.height ?? 520,
      samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }],
      current: { ...offset },
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const start = drag.current;
    if (!start) return;
    start.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    if (start.samples.length > 5) start.samples.shift();

    const maxRight = window.innerWidth - start.width - 8;
    const maxBottom = window.innerHeight - start.height - 8;
    // Measured from the POINTERDOWN origin, which is never updated. Re-basing on the previous
    // banded value would feed each frame's resistance into the next one and the panel would
    // accelerate away instead of easing at the edge.
    const rawRight = start.right - (event.clientX - start.x);
    const rawBottom = start.bottom - (event.clientY - start.y);

    const right = resisted(rawRight, 8, maxRight, start.width);
    const bottom = resisted(rawBottom, 8, maxBottom, start.height);

    start.current = { right, bottom };
    writeRight(right);
    writeBottom(bottom);
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    const start = drag.current;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!start) return;

    const velocity = velocityOf(start.samples);
    const width = start.width;
    const heightNow = start.height;
    const maxRight = window.innerWidth - width - 8;
    const maxBottom = window.innerHeight - heightNow - 8;

    // Where the gesture was heading, not where the finger stopped. A flick carries the panel
    // on past the release point and a slow drag projects to roughly where it already is, so
    // the same code gives both behaviours — which is what the projection is for. `right`
    // grows leftward, so its velocity is negated.
    const from = { right: start.current.right, bottom: start.current.bottom };
    const to = {
      right: Math.max(8, Math.min(start.right - project(velocity.x), maxRight)),
      bottom: Math.max(8, Math.min(start.bottom - project(velocity.y), maxBottom)),
    };

    if (reduced) {
      writeRight(to.right);
      writeBottom(to.bottom);
      setOffset(to);
      return;
    }

    // One spring per axis, each with its own release velocity. A single animation over an
    // object cannot take a per-key velocity, and a scalar `Math.hypot` handed to a two-key
    // animation resolves it in a single frame — the panel teleports instead of travelling.
    const finish = () => setOffset({ right: to.right, bottom: to.bottom });
    const spring = (axis: 'right' | 'bottom', fromValue: number, toValue: number, v: number) =>
      animate(fromValue, toValue, {
        type: 'spring',
        // No overshoot for a reposition: the panel is being put somewhere, not thrown.
        bounce: 0,
        duration: 0.4,
        // px/s straight from the gesture, so the spring starts at the speed the finger left.
        velocity: v,
        onUpdate: (value: number) => {
          if (axis === 'right') writeRight(value);
          else writeBottom(value);
        },
      });

    spring('right', from.right, to.right, -velocity.x);
    void spring('bottom', from.bottom, to.bottom, -velocity.y).then(finish);
  }

  /** The phone's grab bar: drag up to grow, down to shrink. */
  function onGrabDown(event: ReactPointerEvent<HTMLElement>) {
    resize.current = {
      y: event.clientY,
      height,
      samples: [{ t: event.timeStamp, y: event.clientY }],
      current: height,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onGrabMove(event: ReactPointerEvent<HTMLElement>) {
    const start = resize.current;
    if (!start) return;
    start.samples.push({ t: event.timeStamp, y: event.clientY });
    if (start.samples.length > 5) start.samples.shift();

    const max = window.innerHeight - 140;
    const raw = start.height + (start.y - event.clientY);
    const next = resisted(raw, 160, max, start.height);
    start.current = next;
    writeHeight(next);
  }

  function onGrabUp(event: ReactPointerEvent<HTMLElement>) {
    const start = resize.current;
    resize.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!start) return;

    const samples = start.samples.map((sample) => ({ t: sample.t, x: 0, y: sample.y }));
    const releaseVelocity = velocityOf(samples).y;
    const max = window.innerHeight - 140;
    // Snap to the detent nearest where the gesture was heading, not nearest where the
    // finger stopped: a flick upward from a short sheet should open it, not stay put. The
    // projection starts from the LIVE height, which is the banded one the finger actually
    // pulled to.
    const projected = start.current + project(releaseVelocity);
    const target = DETENTS.map((fraction) => Math.round(max * fraction)).reduce((best, candidate) =>
      Math.abs(candidate - projected) < Math.abs(best - projected) ? candidate : best,
    );
    const clamped = Math.max(160, Math.min(target, max));

    if (reduced) {
      writeHeight(clamped);
      setHeight(clamped);
      return;
    }
    animate(start.current, clamped, {
      type: 'spring',
      // A flick carries momentum, so the sheet may pass its detent; a slow drag may not.
      bounce: Math.abs(releaseVelocity) > 300 ? 0.2 : 0,
      duration: 0.4,
      velocity: releaseVelocity,
      onUpdate: writeHeight,
      onComplete: () => setHeight(clamped),
    });
  }

  /**
   * Committed position is written to the DOM from an effect rather than through the `style`
   * prop. The prop would be re-applied on every render, and a render that lands mid-gesture —
   * `setDragging(false)` fires one at release — would clobber the value the gesture is
   * writing. State only changes when a gesture COMMITS, so the effect and the direct writes
   * never disagree.
   */
  useEffect(() => {
    writeRight(offset.right);
    writeBottom(offset.bottom);
  }, [offset]);

  useEffect(() => {
    writeHeight(height);
  }, [height]);

  /** The keyboard path. ARIA requires a separator to be operable, not merely labelled. */
  function onGrabKey(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = event.shiftKey ? 8 : 24;
    const max = window.innerHeight - 140;
    setHeight(Math.max(160, Math.min(height + (event.key === 'ArrowUp' ? step : -step), max)));
  }

  return (
    <div
      ref={ref}
      className={`consult-dock${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label={label}
    >
      {/* Phone only: the handle that resizes the sheet. */}
      <div
        className="consult-grab"
        role="separator"
        aria-label="Resize the consultant"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(height)}
        aria-valuemin={160}
        aria-valuemax={typeof window === 'undefined' ? 520 : window.innerHeight - 140}
        tabIndex={0}
        onKeyDown={onGrabKey}
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
