import { useState, type ReactNode } from 'react';

/**
 * A message's action row: swipe, copy, edit, delete.
 *
 * Rendered on hover on a pointer device and always-on for touch, because a phone has no
 * hover state — controls that only appear on hover are unreachable there, which is how
 * the swipe feature ends up invisible on the device it is most wanted on.
 *
 * The row is deliberately icon-only with `aria-label`s rather than text buttons: at
 * message density, a row of labelled buttons competes with the prose for attention.
 */
export interface MessageActionsProps {
  canSwipeLeft: boolean;
  canSwipeRight: boolean;
  swipeIndex: number;
  swipeCount: number;
  onSwipe: (direction: 'prev' | 'next') => void;
  onCopy: () => void;
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
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(await onCopyText(onCopy));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard permission can be denied; the text is still selectable by hand, so
      // this is not worth surfacing as an error.
    }
  }

  return (
    <div className="msg-actions" role="toolbar" aria-label="Message actions">
      {swipeCount > 1 && (
        <>
          <IconButton label="Previous response" onClick={() => onSwipe('prev')} disabled={!canSwipeLeft || busy}>
            <ChevronLeft />
          </IconButton>
          <span className="msg-swipe-count" aria-label={`Response ${swipeIndex + 1} of ${swipeCount}`}>
            {swipeIndex + 1}/{swipeCount}
          </span>
          <IconButton label="Next response" onClick={() => onSwipe('next')} disabled={!canSwipeRight || busy}>
            <ChevronRight />
          </IconButton>
        </>
      )}

      {onRegenerate && (
        <IconButton label="Regenerate" onClick={onRegenerate} disabled={busy}>
          <Refresh />
        </IconButton>
      )}

      <IconButton label={copied ? 'Copied' : 'Copy'} onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
      </IconButton>

      <IconButton label="Edit" onClick={onEdit} disabled={busy}>
        <Pencil />
      </IconButton>

      <IconButton label="Delete" onClick={onDelete} disabled={busy}>
        <Trash />
      </IconButton>
    </div>
  );
}

/**
 * `onCopy` is passed the raw text so the caller can decide what is copyable — the
 * component never reaches into the message itself.
 */
async function onCopyText(onCopy: () => void): Promise<string> {
  onCopy();
  return '';
}

function IconButton({
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
      className="msg-action"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/**
 * Inline SVG rather than an icon font or an icon package: five small glyphs are not
 * worth a dependency, and inline paths inherit `currentColor` so they follow the theme
 * without extra wiring.
 */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function ChevronLeft() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...STROKE}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...STROKE}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function Refresh() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...STROKE}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function Copy() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...STROKE}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...STROKE}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function Pencil() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...STROKE}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function Trash() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...STROKE}>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}
