import { useState } from 'react';
import { apiJson } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Modal } from './Modal';

/**
 * Switches who the reader is in this chat.
 *
 * A persona is what `{{user}}` resolves to. With none set, that placeholder is left
 * visible in card text rather than guessed at, so the choice belongs where the writing
 * happens — not buried in a settings page you would have to leave the scene to reach.
 *
 * The list lives in its own sheet rather than inline in the menu. A menu entry per
 * persona means the reader with a hundred of them has to scroll past all of them to
 * reach Settings, and the menu's own entries stop being findable. One entry that opens a
 * searchable list keeps the menu a fixed length no matter how much the reader owns.
 */
interface PersonaRow {
  id: string;
  name: string;
  description: string | null;
}

export function PersonaMenu({
  chatId,
  current,
  onChanged,
}: {
  chatId: string;
  current: string | null;
  onChanged?: () => void;
}) {
  const personas = useAsync(() => apiJson<PersonaRow[]>('/api/personas'), []);
  const [selected, setSelected] = useState<string | null>(current);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  async function choose(personaId: string | null) {
    // Optimistic: the sheet closes on choosing and the write is one round trip, so a
    // pending state would flash more than it would inform.
    setSelected(personaId);
    setOpen(false);
    try {
      await apiJson('/api/persona', {
        method: 'POST',
        body: JSON.stringify({ chatId, personaId }),
      });
      onChanged?.();
    } catch {
      // Put it back, so the checkmark never lies about what is stored.
      setSelected(current);
    }
  }

  const rows = personas.data ?? [];
  const active = selected ?? current;
  const activeName = rows.find((row) => row.id === active)?.name ?? 'No persona';
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows;

  return (
    <>
      {/* The sheet lives in this subtree, so the menu must not close on this click —
          closing it unmounts the sheet before it can paint. The whole menu does close
          once a choice is made, which is what `choose` does explicitly. */}
      <button
        type="button"
        className="menu-item"
        data-menu-keep
        onClick={() => setOpen(true)}
      >
        <span className="menu-item-label">You are</span>
        <span className="menu-item-value">{activeName}</span>
      </button>

      {open && (
        <Modal
          title="You are"
          subtitle="The name and description the character is talking to. Replaces {{user}} in the card's text."
          onClose={() => setOpen(false)}
        >
          {rows.length > 6 && (
            <input
              className="field"
              style={{ marginBottom: 10 }}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter personas"
              aria-label="Filter personas"
            />
          )}

          {personas.loading && <p className="sheet-sub">Loading…</p>}

          {!personas.loading && rows.length === 0 && (
            <p className="sheet-sub">
              No personas yet. One is worth setting — without it, cards that say{' '}
              <code className="md-code">{'{{user}}'}</code> leave the placeholder visible
              rather than guessing a name.
            </p>
          )}

          <div className="pick-list">
            {shown.map((persona) => (
              <button
                key={persona.id}
                type="button"
                className={`pick-row${active === persona.id ? ' is-active' : ''}`}
                onClick={() => void choose(persona.id)}
              >
                <span className="pick-name">{persona.name}</span>
                {persona.description && (
                  <span className="pick-note">{persona.description}</span>
                )}
                {active === persona.id && <span className="pick-tick">✓</span>}
              </button>
            ))}
          </div>

          {needle && shown.length === 0 && (
            <p className="sheet-sub">Nothing matches “{filter}”.</p>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            {active && (
              <button type="button" className="btn" onClick={() => void choose(null)}>
                Use no persona
              </button>
            )}
            <a className="btn" href="/personas">
              Manage personas
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}
