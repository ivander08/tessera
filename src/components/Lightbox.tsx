import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

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
 *
 * Same `closing` shape as `Modal`: the parent owns the open state and would unmount this
 * in one frame, so the exit runs before we hand control back.
 */
export function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const [closing, setClosing] = useState(false);

  const requestClose = useCallback(() => setClosing(true), []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') requestClose();
    }
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [requestClose]);

  const duration = reduced ? 0 : 0.2;

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${name}, full size`}>
      <AnimatePresence onExitComplete={onClose}>
        {!closing && (
          <motion.button
            key="scrim"
            type="button"
            className="lightbox-scrim"
            aria-label="Close"
            onClick={requestClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 0.68, 0.36, 1] }}
          />
        )}
        {!closing && (
          <motion.figure
            key="figure"
            className="lightbox-figure"
            initial={{ y: 14, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 10, opacity: 0 }}
            transition={{ duration, ease: [0.22, 0.68, 0.36, 1] }}
          >
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
              <button type="button" className="btn quiet" onClick={requestClose}>
                Close
              </button>
            </figcaption>
          </motion.figure>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
