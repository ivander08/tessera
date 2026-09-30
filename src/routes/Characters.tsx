import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiJson } from '../lib/api';
import type { CharacterSummary } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { Avatar } from '../components/Avatar';

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
 * The row wraps rather than shrinks. Four buttons and a name do not fit on one 390px
 * line, and a name ellipsised to nothing so that Delete can sit at the right margin is
 * the wrong trade — the action bar drops to its own line instead.
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
  const [failure, setFailure] = useState<string | null>(null);

  async function startChat(character: CharacterRow) {
    setBusyId(character.id);
    setStatus(null);
    setFailure(null);
    try {
      const chat = await apiJson<{ id: string }>('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ characterId: character.id }),
      });
      navigate(`/chat/${chat.id}`);
    } catch (cause) {
      setFailure(`Could not start a chat with ${character.name}: ${messageOf(cause)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function fork(character: CharacterRow) {
    const name = window.prompt('Name for the copy', `${character.name} (copy)`);
    if (name === null) return;
    setBusyId(character.id);
    setStatus(null);
    setFailure(null);
    try {
      const created = await apiJson<{ id: string }>('/api/characters/fork', {
        method: 'POST',
        body: JSON.stringify({ id: character.id, name }),
      });
      navigate(`/characters/${created.id}/edit`);
    } catch (cause) {
      setFailure(`Could not fork ${character.name}: ${messageOf(cause)}`);
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
    setFailure(null);
    try {
      await apiJson(`/api/characters/${encodeURIComponent(character.id)}`, { method: 'DELETE' });
      setStatus(`Deleted ${character.name}.`);
      reload();
    } catch (cause) {
      setFailure(`Could not delete ${character.name}: ${messageOf(cause)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <AppBar title={<span className="bar-title">Characters</span>} />

      <main className="sheet">
        <div className="sheet-head">
          <div>
            {data && data.length > 0 && (
              <p className="sheet-sub">
                {data.length} {data.length === 1 ? 'card' : 'cards'} in the library
              </p>
            )}
          </div>
          <Link to="/characters/new" className="btn">
            Import a card
          </Link>
        </div>

        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}
        {failure && <div className="note danger">{failure}</div>}
        {status && <div className="note">{status}</div>}

        {data && data.length === 0 && (
          <div className="empty">
            No characters yet.
            <br />
            <Link to="/characters/new" className="md-link">
              Import a card
            </Link>{' '}
            or{' '}
            <Link to="/forge" className="md-link">
              write one from a premise
            </Link>
            .
          </div>
        )}

        <div style={failure || status ? { marginTop: 14 } : undefined}>
          {data?.map((character) => {
            const shown = character.shownName ?? character.name;
            const busy = busyId === character.id;
            return (
              <div key={character.id} className="row" style={{ flexWrap: 'wrap', rowGap: 10 }}>
                <Link
                  to={`/characters/${character.id}/edit`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flex: '1 1 220px',
                    minWidth: 0,
                    color: 'inherit',
                    textDecoration: 'none',
                  }}
                >
                  <Avatar src={character.avatar} name={shown} />
                  <div className="row-main">
                    <div className="row-title">{shown}</div>
                    <div className="row-sub">
                      {character.name !== shown && `${character.name} · `}
                      {character.source_format} ·{' '}
                      <span className="data">{character.tokens ?? 0}</span> permanent tokens
                      {character.chat_count > 0 && (
                        <>
                          {' · '}
                          <span className="data">{character.chat_count}</span>{' '}
                          {character.chat_count === 1 ? 'chat' : 'chats'}
                        </>
                      )}
                    </div>
                  </div>
                </Link>

                <div className="row-actions" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => void startChat(character)}
                    disabled={busy}
                    className="btn primary"
                  >
                    New chat
                  </button>
                  <Link to={`/characters/${character.id}/edit`} className="btn">
                    Edit
                  </Link>
                  <button type="button" onClick={() => void fork(character)} disabled={busy} className="btn">
                    Fork
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(character)}
                    disabled={busy}
                    className="btn danger"
                    style={{ color: 'var(--danger)' }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}
