import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiJson } from '../lib/api';
import { resolveAssetUrl } from '../lib/assets';
import type { CharacterSummary } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';

/** `chat_count` comes back from `GET /api/characters` alongside the summary columns. */
interface CharacterRow extends CharacterSummary {
  chat_count: number;
}

/**
 * The character list.
 *
 * The whole row opens the editor, because editing is the common action and a separate
 * "Edit" button that is one of four is a smaller target on a phone than the row itself.
 * The other actions sit beside it rather than inside it: a button nested in a link is
 * reachable only by whichever handler wins, and on touch that is a coin flip.
 *
 * Deleting a character deletes its chats too, so the confirmation says so by name and
 * count instead of asking "are you sure?" about an unstated thing.
 */
export default function Characters() {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<CharacterRow[]>('/api/characters'),
    [],
  );
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function startChat(characterId: string) {
    setBusyId(characterId);
    setStatus(null);
    try {
      const chat = await apiJson<{ id: string }>('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ characterId }),
      });
      navigate(`/chat/${chat.id}`);
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function fork(character: CharacterRow) {
    const name = window.prompt('Name for the copy', `${character.name} (copy)`);
    if (name === null) return;
    setBusyId(character.id);
    setStatus(null);
    try {
      const created = await apiJson<{ id: string }>('/api/characters/fork', {
        method: 'POST',
        body: JSON.stringify({ id: character.id, name }),
      });
      navigate(`/characters/${created.id}/edit`);
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(character: CharacterRow) {
    const chats =
      character.chat_count === 0
        ? ' It has no chats.'
        : ` It also deletes ${character.chat_count} chat${character.chat_count === 1 ? '' : 's'} with it.`;
    if (!window.confirm(`Delete "${character.name}"?${chats} This cannot be undone.`)) return;

    setBusyId(character.id);
    setStatus(null);
    try {
      await apiJson(`/api/characters/${encodeURIComponent(character.id)}`, { method: 'DELETE' });
      setStatus(`Deleted ${character.name}.`);
      reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-[var(--font-lg)] font-semibold">Characters</h1>
        <nav className="flex gap-3 text-[var(--font-sm)]">
          <Link to="/characters/new" className="app-link">
            Import
          </Link>
          <Link to="/" className="app-link">
            Chats
          </Link>
        </nav>
      </header>

      {loading && <p className="text-sm text-[var(--ink-dim)]">Loading…</p>}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {status && <p className="mb-3 text-sm text-[var(--ink-dim)]">{status}</p>}

      {data && data.length === 0 && (
        <p className="text-sm text-[var(--ink-dim)]">
          Nothing imported yet.{' '}
          <Link to="/characters/new" className="text-[var(--accent)]">
            Import a card
          </Link>
          .
        </p>
      )}

      <ul className="divide-y divide-[var(--line)]">
        {data?.map((character) => (
          <li key={character.id} className="space-y-2 py-3">
            <Link
              to={`/characters/${character.id}/edit`}
              className="flex items-center gap-3"
            >
              {character.avatar ? (
                <img
                  src={resolveAssetUrl(character.avatar) ?? undefined}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-full bg-[var(--surface-overlay)]" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{character.name}</p>
                <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
                  {character.source_format} · {character.tokens ?? 0} permanent tokens
                  {character.chat_count > 0 && ` · ${character.chat_count} chats`}
                </p>
              </div>
            </Link>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void startChat(character.id)}
                disabled={busyId === character.id}
                className="btn min-h-10"
              >
                New chat
              </button>
              <Link to={`/characters/${character.id}/edit`} className="btn min-h-10 no-underline">
                Edit
              </Link>
              <button
                type="button"
                onClick={() => void fork(character)}
                disabled={busyId === character.id}
                className="btn min-h-10"
              >
                Fork
              </button>
              <button
                type="button"
                onClick={() => void remove(character)}
                disabled={busyId === character.id}
                className="btn min-h-10 text-[var(--danger)]"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
