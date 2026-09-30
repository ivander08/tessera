import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A portrait, full size.
 *
 * The images in a card grid are small by necessity — a shelf shows many at once — but the
 * reader uploads a real picture and occasionally wants to actually look at it. Zooming is
 * also how you check whether a card's avatar came through at all, which matters because
 * avatars are the field most likely to be missing from an import.
 *
 * Rendered through a portal so a plate inside a transformed or clipped grid can still
 * cover the viewport, and dismissed by click anywhere, Escape, or the close button.
 */
export function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${name}, full size`}>
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={onClose} />
      <figure className="lightbox-figure">
        {failed ? (
          // A stored avatar that will not decode is worth saying out loud: the row exists
          // and the path is right, so the reader's next move is to re-upload, and nothing
          // else on the screen tells them that.
          <div className="lightbox-missing">
            <span className="eyebrow">No image</span>
            <p>{name} has no avatar stored, or it could not be decoded.</p>
          </div>
        ) : (
          <img src={src} alt={name} onError={() => setFailed(true)} />
        )}
        <figcaption>
          <span className="bar-title">{name}</span>
          <button type="button" className="btn quiet" onClick={onClose}>
            Close
          </button>
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}
