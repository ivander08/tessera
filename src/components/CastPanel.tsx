import { useState } from 'react';
import { apiJson } from '../lib/api';
import type { CharacterSummary } from '../lib/apiTypes';
import { messageOf, useAsync } from '../lib/hooks';
import { Avatar } from './Avatar';
import { ConfirmPrompt } from './ConfirmPrompt';
import { useToast } from './Toast';

/**
 * Who is in the scene.
 *
 * A cast is a list of SPEAKERS, not of characters. The narrator may write any name into
 * the scene and it appears immediately with a letter avatar and a voice colour; this panel
 * is where the reader sees who has turned up and decides whether any of them deserves a
 * real card.
 *
 * Promoting is the point of the panel. An introduced character has a name and a colour but
 * no portrait, no card and no voice of their own — promoting attaches a real character, so
 * they can be edited like anyone else.
 */
export interface CastMember {
  id: string;
  character_id: string | null;
  name: string;
  color: string | null;
  isPrimary: boolean;
}

export function CastPanel({ chatId, onChanged }: { chatId: string; onChanged?: () => void }) {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<{ cast: CastMember[] }>(`/api/chats/${encodeURIComponent(chatId)}/cast`),
    [chatId],
  );
  const characters = useAsync(() => apiJson<CharacterSummary[]>('/api/characters'), []);

  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // The member the reader has asked to remove, held until they confirm. Null is "no sheet
  // open", which is also what a cancel returns to.
  const [confirming, setConfirming] = useState<{ id: string; name: string } | null>(null);

  async function promote(memberId: string, characterId: string) {
    setBusy(true);
    try {
      await apiJson(
        `/api/chats/${encodeURIComponent(chatId)}/cast/${encodeURIComponent(memberId)}/promote`,
        { method: 'POST', body: JSON.stringify({ characterId }) },
      );
      toast.success('Promoted to a full character.');
      setPicking(null);
      reload();
      onChanged?.();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(memberId: string) {
    setBusy(true);
    try {
      await apiJson(
        `/api/chats/${encodeURIComponent(chatId)}/cast/${encodeURIComponent(memberId)}`,
        { method: 'DELETE' },
      );
      toast.success('Removed from the scene.');
      setConfirming(null);
      reload();
      onChanged?.();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {loading && <p className="sheet-sub">Loading…</p>}
      {error && <div className="note danger">{error}</div>}

      {data && (
        <>
          <div className="panel panel-pad" style={{ display: 'grid', gap: 10 }}>
            {data.cast.map((member) => (
              <div key={member.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Avatar
                  src={
                    member.character_id
                      ? `/api/characters/${encodeURIComponent(member.character_id)}/avatar`
                      : null
                  }
                  name={member.name}
                  className="cast-avatar"
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    className="turn-speaker"
                    style={member.color ? { color: `var(${member.color})` } : undefined}
                  >
                    {member.name}
                  </div>
                  <div className="form-hint" style={{ marginTop: 2 }}>
                    {member.isPrimary
                      ? 'The character this scene is written from'
                      : member.character_id
                        ? 'A real character'
                        : 'Introduced by the narrator — no card yet'}
                  </div>
                </div>

                {!member.isPrimary && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn quiet"
                      disabled={busy}
                      onClick={() => setPicking(picking === member.id ? null : member.id)}
                    >
                      {member.character_id ? 'Change' : 'Promote'}
                    </button>
                    <button
                      type="button"
                      className="btn quiet"
                      disabled={busy}
                      style={{ color: 'var(--danger)' }}
                      onClick={() => setConfirming({ id: member.id, name: member.name })}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* The picker opens inline under the row it applies to, so the reader can see
              which member they are attaching a card to. */}
          {picking && (
            <section className="section">
              <span className="eyebrow">Attach a card</span>
              {characters.loading && <p className="sheet-sub">Loading…</p>}
              <div className="panel panel-pad" style={{ display: 'grid', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                {(characters.data ?? []).map((character) => (
                  <button
                    key={character.id}
                    type="button"
                    className="pick-row"
                    disabled={busy}
                    onClick={() => void promote(picking, character.id)}
                  >
                    <Avatar
                      src={character.avatar}
                      name={character.shownName ?? character.name}
                      className="cast-avatar"
                    />
                    <span className="pick-name">{character.shownName ?? character.name}</span>
                  </button>
                ))}
              </div>
              <p className="form-hint" style={{ marginTop: 8 }}>
                The cast member is renamed to the card's shown name, and its portrait is used
                from then on. Lines already written keep the name they were written under.
              </p>
            </section>
          )}
        </>
      )}

      {confirming && (
        <ConfirmPrompt
          title="Remove from the cast"
          message={`Remove ${confirming.name} from this scene? Their lines stay in the transcript.`}
          confirmLabel="Remove"
          busy={busy}
          danger
          onConfirm={() => void remove(confirming.id)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
