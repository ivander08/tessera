import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';

/**
 * Asks for a name, in the app's own sheet.
 *
 * Replaces `window.prompt`, which is a browser chrome dialog: it cannot be themed, it
 * blocks the whole page, and it is titled with the origin — `localhost:8787 says` — which
 * is not a sentence about the reader's character.
 */
export function NamePrompt({
  title,
  label,
  initial,
  busy = false,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement | null>(null);

  // Focused and selected so the suggested name can be typed over immediately.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const trimmed = value.trim();

  return (
    <Modal title={title} onClose={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length > 0 && !busy) onSubmit(trimmed);
        }}
      >
        <label className="form-row">
          <span className="form-hint">{label}</span>
          <input
            ref={input}
            className="field"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="submit" className="btn primary" disabled={busy || trimmed.length === 0}>
            {busy ? 'Working…' : 'Create'}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
