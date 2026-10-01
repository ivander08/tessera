import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiJson } from '../lib/api';
import type { CharacterSummary } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { Avatar } from '../components/Avatar';
import { ConfirmPrompt } from '../components/ConfirmPrompt';
import { NamePrompt } from '../components/NamePrompt';

/** `chat_count` comes back from `GET /api/characters` alongside the summary columns. */
interface CharacterRow extends CharacterSummary {
  chat_count: number;
}

/**
 * The row icons are 30px rather than the 34px default: three of them plus the labelled
 * action have to sit beside a name on a 390px line, and 4px off each of three buttons is
 * 12px the name gets to keep.
 */
const ICON_BTN = { width: 30, height: 30 } as const;

/** The same 16px, 1.7-stroke grid the transcript's tools use. */
const STROKE = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/**
 * The character list.
 *
 * The whole row opens the editor, because editing is the common action and an icon is a
 * smaller target than the row itself. The other actions sit beside it rather than inside
 * it: a button nested in a link is reachable only by whichever handler wins, and on touch
 * that is a coin flip.
 *
 * One labelled action and three icons on one line. Four labelled buttons did not fit at
 * 390px and wrapped onto a second line under every name, which turned the list into a
 * wall of chrome. What a row is for is the name, so the name is what gets the width; the
 * metadata ellipsises and the full text is one tap away in the editor.
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
  // The character being forked, while the name sheet is open. Null means no sheet.
  const [forking, setForking] = useState<CharacterRow | null>(null);
  // The character the reader has asked to delete, held until they confirm.
  const [confirming, setConfirming] = useState<CharacterRow | null>(null);

  function startChat(character: CharacterRow) {
    // The wizard asks how the scene should behave before it opens; it creates the chat
    // itself, so nothing is written until the reader has answered or skipped.
    navigate(`/characters/${character.id}/start`);
  }

  async function fork(character: CharacterRow, name: string) {
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
      setForking(null);
    }
  }

  async function remove(character: CharacterRow) {
    setBusyId(character.id);
    setStatus(null);
    setFailure(null);
    try {
      await apiJson(`/api/characters/${encodeURIComponent(character.id)}`, { method: 'DELETE' });
      setStatus(`Deleted ${character.name}.`);
      setConfirming(null);
      reload();
    } catch (cause) {
      setFailure(`Could not delete ${character.name}: ${messageOf(cause)}`);
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The question the sheet asks, built from the row it is about.
   *
   * Deleting a character deletes its chats too, so the confirmation says so by name and
   * count rather than asking "are you sure?" about an unstated thing.
   */
  function deleteQuestion(character: CharacterRow): string {
    const chats =
      character.chat_count === 0
        ? ' It has no chats.'
        : ` It also deletes ${character.chat_count} chat${character.chat_count === 1 ? '' : 's'} with it.`;
    return `Delete "${character.name}"?${chats} This cannot be undone.`;
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
          <div className="row-actions" style={{ gap: 6 }}>
            <Link to="/characters/new?blank=1" className="btn primary">
              New character
            </Link>
            <Link to="/characters/new" className="btn quiet">
              Import a card
            </Link>
          </div>
        </div>

        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}
        {failure && <div className="note danger">{failure}</div>}
        {status && <div className="note">{status}</div>}

        {data && data.length === 0 && (
          <div className="empty">
            No characters yet.
            <br />
            <Link to="/characters/new?blank=1" className="md-link">
              Write one yourself
            </Link>
            ,{' '}
            <Link to="/characters/new" className="md-link">
              import a card
            </Link>
            , or{' '}
            <Link to="/forge" className="md-link">
              let the forge draft one from a premise
            </Link>
            .
          </div>
        )}

        <div className="plates" style={failure || status ? { marginTop: 14 } : undefined}>
          {data?.map((character) => {
            const shown = character.shownName ?? character.name;
            const busy = busyId === character.id;
            return (
              <article key={character.id} className="plate">
                {/* The portrait opens the character's own screen, which is where the
                    avatar is actually set — clicking a picture to change it is the most
                    direct thing it can do here. */}
                <Link to={`/characters/${character.id}/edit`} className="plate-portrait">
                  <Avatar src={character.avatar} name={shown} />
                </Link>

                <div className="plate-body">
                  <div className="plate-head">
                    <Link to={`/characters/${character.id}/edit`} className="plate-name" title={shown}>
                      {shown}
                    </Link>
                  </div>
                  <p className="plate-preview">
                    {character.name !== shown && `${character.name} · `}
                    <span className="data">{character.tokens ?? 0}</span> tokens
                    {character.chat_count > 0 && (
                      <>
                        {' · '}
                        <span className="data">{character.chat_count}</span>{' '}
                        {character.chat_count === 1 ? 'chat' : 'chats'}
                      </>
                    )}
                  </p>

                  <div className="plate-actions">
                    <button
                      type="button"
                      onClick={() => void startChat(character)}
                      disabled={busy}
                      className="btn primary"
                    >
                      New chat
                    </button>
                    <Link
                      to={`/characters/${character.id}/edit`}
                      className="icon-btn"
                      aria-label={`Edit ${shown}`}
                      title="Edit"
                      style={ICON_BTN}
                    >
                      <PencilGlyph />
                    </Link>
                    <button
                      type="button"
                      onClick={() => setForking(character)}
                      disabled={busy}
                      className="icon-btn"
                      aria-label={`Fork ${shown}`}
                      title="Fork"
                      style={ICON_BTN}
                    >
                      <ForkGlyph />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(character)}
                      disabled={busy}
                      className="icon-btn"
                      aria-label={`Delete ${shown}`}
                      title="Delete"
                      style={{ ...ICON_BTN, color: 'var(--danger)' }}
                    >
                      <TrashGlyph />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </main>

      {forking && (
        <NamePrompt
          title="Fork this character"
          label="Name for the copy"
          initial={`${forking.name} (copy)`}
          busy={busyId === forking.id}
          onSubmit={(name) => void fork(forking, name)}
          onCancel={() => setForking(null)}
        />
      )}

      {confirming && (
        <ConfirmPrompt
          title="Delete this character"
          message={deleteQuestion(confirming)}
          confirmLabel="Delete"
          busy={busyId === confirming.id}
          danger
          onConfirm={() => void remove(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

function PencilGlyph() {
  return (
    <svg {...STROKE}>
      <path d="M2.8 13.2l.7-2.9 7-7a1.6 1.6 0 0 1 2.2 2.2l-7 7z" />
      <path d="M9.6 4.4l2 2" />
    </svg>
  );
}

function ForkGlyph() {
  return (
    <svg {...STROKE}>
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.25 5.75V4.5A1.5 1.5 0 0 0 8.75 3h-4.5A1.5 1.5 0 0 0 2.75 4.5v4.5a1.5 1.5 0 0 0 1.5 1.5h1.25" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg {...STROKE}>
      <path d="M2.8 4.4h10.4" />
      <path d="M6.4 4.4V3.2a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v1.2" />
      <path d="M4.2 4.4l.7 8.2a1.3 1.3 0 0 0 1.3 1.2h3.6a1.3 1.3 0 0 0 1.3-1.2l.7-8.2" />
      <path d="M6.6 6.9v4.6M9.4 6.9v4.6" />
    </svg>
  );
}
