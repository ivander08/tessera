import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import type { CharacterSummary } from '../lib/apiTypes';
import { useAsync } from '../lib/hooks';

export default function Characters() {
  const { data, error, loading } = useAsync(
    () => apiJson<CharacterSummary[]>('/api/characters'),
    [],
  );

  return (
    <main className="mx-auto max-w-2xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Characters</h1>
        <nav className="flex gap-3 text-sm">
          <Link to="/characters/new" className="text-accent">
            Import
          </Link>
          <Link to="/" className="text-ink-dim hover:text-ink">
            Chats
          </Link>
        </nav>
      </header>

      {loading && <p className="text-sm text-ink-dim">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {data && data.length === 0 && (
        <p className="text-sm text-ink-dim">
          Nothing imported yet.{' '}
          <Link to="/characters/new" className="text-accent">
            Import a card
          </Link>
          .
        </p>
      )}

      <ul className="divide-y divide-white/5">
        {data?.map((character) => (
          <li key={character.id} className="flex items-center gap-3 py-3">
            {character.avatar ? (
              <img src={character.avatar} alt="" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <div className="h-10 w-10 rounded-full bg-white/10" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{character.name}</p>
              <p className="text-xs text-ink-dim">
                {character.source_format} · {character.tokens ?? 0} permanent tokens
              </p>
            </div>
            <NewChatButton characterId={character.id} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function NewChatButton({ characterId }: { characterId: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        const chat = await apiJson<{ id: string }>('/api/chats', {
          method: 'POST',
          body: JSON.stringify({ characterId }),
        });
        window.location.href = `/chat/${chat.id}`;
      }}
      className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
    >
      New chat
    </button>
  );
}
