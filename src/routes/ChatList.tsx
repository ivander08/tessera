import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import type { ChatSummary } from '../lib/apiTypes';
import { useAsync } from '../lib/hooks';

export default function ChatList() {
  const { data, error, loading } = useAsync(
    () => apiJson<ChatSummary[]>('/api/chats'),
    [],
  );

  return (
    <main className="mx-auto max-w-3xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Chats</h1>
        <nav className="flex gap-3 text-sm">
          <Link to="/characters" className="text-ink-dim hover:text-ink">
            Characters
          </Link>
          <Link to="/settings" className="text-ink-dim hover:text-ink">
            Settings
          </Link>
        </nav>
      </header>

      {loading && <p className="text-sm text-ink-dim">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {data && data.length === 0 && (
        <p className="text-sm text-ink-dim">
          No chats yet. Import a character first — <Link to="/characters/new" className="text-accent">import one</Link>.
        </p>
      )}

      <ul className="divide-y divide-white/5">
        {data?.map((chat) => (
          <li key={chat.id}>
            <Link
              to={`/chat/${chat.id}`}
              className="flex items-center gap-3 py-3 hover:bg-white/5"
            >
              {chat.character_avatar ? (
                <img src={chat.character_avatar} alt="" className="h-10 w-10 rounded-full object-cover" />
              ) : (
                <div className="h-10 w-10 rounded-full bg-white/10" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{chat.title ?? chat.character_name ?? 'Untitled'}</p>
                <p className="truncate text-sm text-ink-dim">{chat.preview ?? 'No messages'}</p>
              </div>
              <time className="shrink-0 text-xs text-ink-dim">
                {new Date(chat.updated_at).toLocaleDateString()}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
