import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigationType } from 'react-router';
import { getToken } from './lib/api';
import ChatList from './routes/ChatList';
import Chat from './routes/Chat';
import Settings from './routes/Settings';
import Setup from './routes/Setup';
import Characters from './routes/Characters';
import CharacterNew from './routes/CharacterNew';
import CharacterEdit from './routes/CharacterEdit';
import SceneSetup from './routes/SceneSetup';
import Memory from './routes/Memory';
import State from './routes/State';
import Personas from './routes/Personas';
import Forge from './routes/Forge';
import Presets from './routes/Presets';
import PresetEdit from './routes/PresetEdit';

export default function App() {
  return (
    <>
      <SkipLink />
      <OfflineNotice />
      <RouteTitle />
      <ScrollRestore />
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/" element={<RequireToken>{<ChatList />}</RequireToken>} />
        <Route path="/characters" element={<RequireToken>{<Characters />}</RequireToken>} />
        <Route path="/characters/new" element={<RequireToken>{<CharacterNew />}</RequireToken>} />
        <Route path="/characters/:id/edit" element={<RequireToken>{<CharacterEdit />}</RequireToken>} />
        <Route path="/characters/:id/start" element={<RequireToken>{<SceneSetup />}</RequireToken>} />
        <Route path="/chat/:id" element={<RequireToken>{<Chat />}</RequireToken>} />
        <Route path="/chat/:id/memory" element={<RequireToken>{<Memory />}</RequireToken>} />
        <Route path="/chat/:id/state" element={<RequireToken>{<State />}</RequireToken>} />
        <Route path="/personas" element={<RequireToken>{<Personas />}</RequireToken>} />
        <Route path="/forge" element={<RequireToken>{<Forge />}</RequireToken>} />
        <Route path="/presets" element={<RequireToken>{<Presets />}</RequireToken>} />
        <Route path="/presets/:id" element={<RequireToken>{<PresetEdit />}</RequireToken>} />
        <Route path="/settings" element={<RequireToken>{<Settings />}</RequireToken>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

/**
 * The first thing a keyboard user reaches, and the target every screen shares.
 *
 * The id and `tabIndex` are stamped at runtime rather than written into every
 * route's `<main>`: one place decides, and a route added later cannot forget it.
 */
function SkipLink() {
  const { pathname } = useLocation();
  useEffect(() => {
    const main = document.querySelector('main');
    if (main) {
      main.id = 'main-content';
      main.tabIndex = -1;
    }
  }, [pathname]);

  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        // Focus directly rather than through a fragment navigation: the fragment
        // would race ScrollRestore's own scroll management for the same scroll.
        const main = document.querySelector('main');
        if (!main) return;
        event.preventDefault();
        main.focus();
        main.scrollIntoView();
      }}
    >
      Skip to content
    </a>
  );
}

/**
 * Connection state, said once at the top.
 *
 * Only the browser's own online/offline events — no polling, no heartbeat. The
 * app already fails loudly per request (`OfflineError`); this is the banner that
 * explains WHY before the reader tries anything.
 */
function OfflineNotice() {
  const [offline, setOffline] = useState(() => !navigator.onLine);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="offline-banner" role="status">
      You're offline. Tessera reconnects when the network does.
    </div>
  );
}

/**
 * Where each screen was scrolled to, restored on Back.
 *
 * Keyed by the router's location key and saved from the scroll event itself, so
 * the value is recorded while the old page is still on screen — reading scrollY
 * from an effect cleanup would see the new page, already clamped. The reset to
 * top happens only when the PATHNAME changes: a search-param change on the same
 * screen (a `?seq=` jump landing) must not yank the reader back up, and an
 * in-page anchor belongs to the browser, not to us.
 *
 * The scene screen keeps its own scroll manager and lands on the live end of the
 * transcript; this mainly serves the shelf and the forms, where losing your place
 * is the whole complaint.
 */
const scrollPositions = new Map<string, number>();

function ScrollRestore() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousPath = useRef(location.pathname);

  useLayoutEffect(() => {
    const key = location.key;
    const pathChanged = previousPath.current !== location.pathname;
    previousPath.current = location.pathname;

    if (pathChanged && !location.hash) {
      if (navigationType === 'POP') {
        window.scrollTo(0, scrollPositions.get(key) ?? 0);
      } else {
        window.scrollTo(0, 0);
      }
    }

    const save = () => scrollPositions.set(key, window.scrollY);
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [location.key, location.pathname, location.hash, navigationType]);

  return null;
}

/**
 * The tab title, per route.
 *
 * A single-page app that never sets `document.title` leaves one stale string in the tab
 * strip, in history, and in the window list — which is the label a reader uses to find the
 * window at all. Keyed on the path rather than on each screen so there is one place that
 * decides, and so a screen does not have to know it is a screen.
 */
function RouteTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const name =
      pathname === '/'
        ? 'Scenes'
        : pathname.startsWith('/characters')
          ? 'Characters'
          : pathname.startsWith('/chat/') && pathname.endsWith('/memory')
            ? 'Memory'
            : pathname.startsWith('/chat/') && pathname.endsWith('/state')
              ? 'World state'
              : pathname.startsWith('/chat/')
                ? 'Chat'
                : pathname.startsWith('/personas')
                  ? 'Personas'
                  : pathname.startsWith('/forge')
                    ? 'Forge'
                    : pathname.startsWith('/presets')
                      ? 'Presets'
                      : pathname.startsWith('/settings')
                        ? 'Settings'
                        : pathname.startsWith('/setup')
                          ? 'Setup'
                          : 'Tessera';
    document.title = `${name} · Tessera`;
  }, [pathname]);
  return null;
}

function RequireToken({ children }: { children: ReactNode }) {
  if (!getToken()) return <Navigate to="/setup" replace />;
  return children;
}
