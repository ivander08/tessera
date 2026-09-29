import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { getToken } from './lib/api';
import ChatList from './routes/ChatList';
import Chat from './routes/Chat';
import Settings from './routes/Settings';
import Setup from './routes/Setup';
import Characters from './routes/Characters';
import CharacterNew from './routes/CharacterNew';
import Memory from './routes/Memory';
import State from './routes/State';

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/" element={<RequireToken>{<ChatList />}</RequireToken>} />
      <Route path="/characters" element={<RequireToken>{<Characters />}</RequireToken>} />
      <Route path="/characters/new" element={<RequireToken>{<CharacterNew />}</RequireToken>} />
      <Route path="/chat/:id" element={<RequireToken>{<Chat />}</RequireToken>} />
      <Route path="/chat/:id/memory" element={<RequireToken>{<Memory />}</RequireToken>} />
      <Route path="/chat/:id/state" element={<RequireToken>{<State />}</RequireToken>} />
      <Route path="/settings" element={<RequireToken>{<Settings />}</RequireToken>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RequireToken({ children }: { children: ReactNode }) {
  if (!getToken()) return <Navigate to="/setup" replace />;
  return children;
}
