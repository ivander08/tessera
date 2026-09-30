import { useState } from 'react';
import { apiJson } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { MenuAction, MenuLabel } from './AppBar';

/**
 * Switches who the reader is in this chat, from the chat's own menu.
 *
 * A persona is what `{{user}}` resolves to. With none set, that placeholder is left
 * visible in card text rather than guessed at, so the choice belongs where the writing
 * happens — not buried in a settings page you would have to leave the scene to reach.
 *
 * The list scrolls rather than growing without bound. A menu that renders a hundred
 * personas runs off the bottom of the screen and puts "No persona" out of reach, which
 * is the failure the reader reported.
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

  async function choose(personaId: string | null) {
    // Optimistic: the menu closes on navigation and the write is one round trip, so a
    // pending state would flash more than it would inform.
    setSelected(personaId);
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

  return (
    <>
      <MenuLabel>You are</MenuLabel>

      {!personas.loading && rows.length === 0 && (
        <MenuAction
          label="No personas yet — make one"
          onClick={() => {
            window.location.href = '/personas';
          }}
        />
      )}

      <div className="menu-scroll">
        {rows.map((persona) => (
          <MenuAction
            key={persona.id}
            label={persona.name}
            hint={active === persona.id ? '✓' : undefined}
            onClick={() => void choose(persona.id)}
          />
        ))}
      </div>

      {active && <MenuAction label="No persona" onClick={() => void choose(null)} />}
    </>
  );
}
