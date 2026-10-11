import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
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
      <RouteTitle />
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
