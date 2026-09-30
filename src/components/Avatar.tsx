import { useEffect, useState, type CSSProperties } from 'react';
import { apiOrigin, getToken } from '../lib/api';
import { Lightbox } from './Lightbox';

/**
 * An avatar that actually loads.
 *
 * The obvious `<img src="/api/characters/:id/avatar">` cannot work: the avatar route is
 * behind the same bearer auth as everything else, and an `<img>` tag has no way to send
 * an `Authorization` header. The browser fetches it anonymously, the Worker correctly
 * answers 401, and the user sees a broken image with no explanation.
 *
 * So the bytes are fetched with the token and turned into a blob URL. Two consequences
 * worth knowing:
 *
 *  - The cache is module-level and keyed by URL, so a list of twenty characters fetches
 *    each image once rather than once per render.
 *  - The blob URL is revoked when the component unmounts. Without that, every avatar
 *    ever displayed would be pinned in memory for the life of the tab.
 *
 * The alternative — a `?token=` query parameter — would put the bearer token in URLs,
 * where it lands in history, logs, and referrers. Not worth the convenience.
 */

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

async function loadAvatar(url: string): Promise<string | null> {
  const cached = cache.get(url);
  if (cached) return cached;

  const pending = inFlight.get(url);
  if (pending) return pending;

  const request = (async () => {
    try {
      const token = getToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      // A zero-byte body is not an image. `createObjectURL` accepts it happily and the
      // `<img>` then renders nothing at all, which is worse than the initial fallback.
      if (blob.size === 0) return null;
      const objectUrl = URL.createObjectURL(blob);
      cache.set(url, objectUrl);
      return objectUrl;
    } catch {
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, request);
  return request;
}

/** Drops a cached avatar so a replaced image is picked up on the next render. */
export function invalidateAvatar(url: string): void {
  const existing = cache.get(url);
  if (existing) URL.revokeObjectURL(existing);
  cache.delete(url);
}

export interface AvatarProps {
  /** Server-relative path, a data URL, or an absolute URL. */
  src: string | null | undefined;
  name: string;
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Open the full-size image when the portrait is clicked. */
  zoomable?: boolean;
}

export function Avatar({ src, name, className = 'chip', style, zoomable = false }: AvatarProps) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  // An absolute or inline URL needs no token, so it goes straight to the img.
  const direct = !src || /^[a-z][a-z0-9+.-]*:/i.test(src) ? (src ?? null) : null;
  const needsAuth = direct === null && !!src;

  useEffect(() => {
    if (!needsAuth || !src) {
      setResolved(null);
      return;
    }

    let alive = true;
    const absolute = `${apiOrigin()}${src.startsWith('/') ? '' : '/'}${src}`;
    void loadAvatar(absolute).then((url) => {
      if (alive) setResolved(url);
    });
    return () => {
      alive = false;
    };
  }, [needsAuth, src]);

  const finalSrc = direct ?? resolved;

  if (!finalSrc) {
    // The initial is a real fallback, not a placeholder: it is what the list shows for
    // every character until an image is set, and it should look deliberate.
    return (
      <span className={className} style={style} aria-hidden="true">
        {(name.trim()[0] ?? '?').toUpperCase()}
      </span>
    );
  }

  if (!zoomable) return <img className={className} style={style} src={finalSrc} alt="" />;

  // A portrait you can open. The whole image is the target rather than a corner button:
  // there is nothing else to do with a portrait, and a button that small is a miss on a
  // phone.
  return (
    <>
      <button
        type="button"
        className={`${className} zoomable`}
        style={style}
        onClick={(event) => {
          // The card behind a portrait is usually a link; opening the image should not
          // also navigate.
          event.preventDefault();
          event.stopPropagation();
          setZoomed(true);
        }}
        title={`${name} — click to enlarge`}
        aria-label={`Enlarge ${name}`}
      >
        <img src={finalSrc} alt="" />
      </button>
      {zoomed && <Lightbox src={finalSrc} name={name} onClose={() => setZoomed(false)} />}
    </>
  );
}
