import { Modal } from './Modal';

/**
 * A yes/no question, in the app's own sheet.
 *
 * Replaces `window.confirm`, for the same reasons `NamePrompt` replaces `window.prompt`:
 * the browser dialog cannot be themed, it blocks the whole page, it is suppressed outright
 * in some embedded webviews, and on the desktop it is titled with the origin rather than
 * with anything about the reader's work.
 *
 * The destructive action is the SECOND button and it is not the default. Every flow this
 * replaces deletes something, and a sheet that puts "Delete" where the eye lands first is
 * a sheet that gets mis-clicked.
 */
export function ConfirmPrompt({
  title,
  message,
  confirmLabel,
  busy = false,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** The whole question, including what the action costs. Rendered as written. */
  message: string;
  confirmLabel: string;
  busy?: boolean;
  /** Styles the confirm button as destructive. Every current caller passes true. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{message}</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn primary${danger ? ' danger' : ''}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
