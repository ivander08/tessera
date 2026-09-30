import { useState, type ReactNode } from 'react';

/**
 * A turn's actions: swipe, regenerate, copy, edit, delete.
 *
 * Revealed on hover where hover exists and always visible where it does not — a phone
 * has no hover state, so hover-only controls are simply unreachable there, which is how
 * swipe ends up invisible on the device it is most wanted on.
 *
 * Icons are inline SVG at a consistent 16px grid with a 1.6 stroke, drawn to the same
 * optical weight. Mixed weights are what makes an icon row look assembled rather than
 * designed.
 */
export interface TurnActionsProps {
  canSwipeLeft: boolean;
  canSwipeRight: boolean;
  swipeIndex: number;
  swipeCount: number;
  onSwipe: (direction: 'prev' | 'next') => void;
  /** Returns the text to put on the clipboard. */
  onCopy: () => string;
  onEdit: () => void;
  onDelete: () => void;
  onRegenerate?: () => void;
  busy?: boolean;
}

export function MessageActions({
  canSwipeLeft,
  canSwipeRight,
  swipeIndex,
  swipeCount,
  onSwipe,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
  busy = false,
}: TurnActionsProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(onCopy());
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch {
      // Clipboard permission can be refused. The text is still selectable by hand, so
      // this is not worth surfacing as an error.
    }
  }

  return (
    <div className="turn-tools" role="toolbar" aria-label="Message actions">
      {swipeCount > 1 && (
        <>
          <Tool label="Previous response" onClick={() => onSwipe('prev')} disabled={!canSwipeLeft || busy}>
            <ChevronLeft />
          </Tool>
          <span className="tool-count" aria-label={`Response ${swipeIndex + 1} of ${swipeCount}`}>
            {swipeIndex + 1}/{swipeCount}
          </span>
          <Tool label="Next response" onClick={() => onSwipe('next')} disabled={!canSwipeRight || busy}>
            <ChevronRight />
          </Tool>
        </>
      )}

      {onRegenerate && (
        <Tool label="Regenerate" onClick={onRegenerate} disabled={busy}>
          <Redo />
        </Tool>
      )}

      <Tool label={copied ? 'Copied' : 'Copy'} onClick={() => void copy()}>
        {copied ? <Check /> : <CopyGlyph />}
      </Tool>

      <Tool label="Edit" onClick={onEdit} disabled={busy}>
        <Pen />
      </Tool>

      <Tool label="Delete" onClick={onDelete} disabled={busy}>
        <Cross />
      </Tool>
    </div>
  );
}

function Tool({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tool"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** One shared path config, so every glyph has the same optical weight. */
const stroke = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.35,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function ChevronLeft() {
  return (
    <svg {...stroke}>
      <path d="M10 3.5L5.5 8l4.5 4.5" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg {...stroke}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  );
}

function Redo() {
  return (
    <svg {...stroke}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </svg>
  );
}

function CopyGlyph() {
  return (
    <svg {...stroke}>
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.25 5.75V4.5A1.5 1.5 0 0 0 8.75 3h-4.5A1.5 1.5 0 0 0 2.75 4.5v4.5a1.5 1.5 0 0 0 1.5 1.5h1.25" />
    </svg>
  );
}

function Check() {
  return (
    <svg {...stroke}>
      <path d="M3.5 8.5L6.5 11.5l6-7" />
    </svg>
  );
}

function Pen() {
  return (
    <svg {...stroke}>
      <path d="M11.4 2.9a1.6 1.6 0 0 1 2.3 2.3l-7.3 7.3-3 .7.7-3z" />
      <path d="M10.2 4.1l2.3 2.3" />
    </svg>
  );
}

function Cross() {
  return (
    <svg {...stroke}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
