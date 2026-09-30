import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';

/** The row shape `/api/personas` returns. */
export interface PersonaSummary {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  created_at: number;
  /** How many chats currently have this persona attached. */
  chat_count: number;
}

const USER_MACRO = '{{user}}';

/**
 * Picks the persona for one chat.
 *
 * Personas exist so `{{user}}` resolves to a name. The Worker deliberately leaves the
 * placeholder visible when no persona is set — substituting the pronoun "You" produces
 * "She calls You by name", which the model reads as a proper noun and invents a name
 * around. So the hint below the control is not decoration: a visible `{{user}}` in a
 * reply is the symptom this control fixes, and the wording is the same on both sides.
 *
 * The selection is optimistic and reverts on failure, because a `<select>` cannot be
 * half-changed: leaving the new value on screen after a rejected write would claim a
 * change the Worker never made.
 */
export function PersonaPicker({
  chatId,
  current,
  onChange,
}: {
  chatId: string;
  current: string | null;
  onChange: (personaId: string | null) => void;
}) {
  const { data, error } = useAsync(() => apiJson<PersonaSummary[]>('/api/personas'), []);
  const personas = data ?? [];

  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The parent owns the truth; this only mirrors it. Without the reset, a chat switched
  // underneath the control (a route change reusing the component) would keep showing the
  // previous chat's persona.
  useEffect(() => {
    setValue(current ?? '');
  }, [current]);

  // `chats.persona_id` is foreign-keyed, so an id missing from this list means the row
  // was deleted elsewhere since the list was read. A `<select>` whose value matches no
  // option renders blank, which reads as "no persona set" when the chat in fact has one,
  // so the id is resolved explicitly and reported honestly either way.
  const orphanId = current !== null && data !== null && !personas.some((p) => p.id === current) ? current : null;
  const orphan = useAsync(
    () =>
      orphanId === null
        ? Promise.resolve(null)
        : apiJson<PersonaSummary>(`/api/personas/${encodeURIComponent(orphanId)}`),
    [orphanId],
  );

  async function pick(next: string) {
    const previous = value;
    setValue(next);
    setBusy(true);
    setProblem(null);
    try {
      await apiJson('/api/persona', {
        method: 'POST',
        body: JSON.stringify({ chatId, personaId: next.length > 0 ? next : null }),
      });
      onChange(next.length > 0 ? next : null);
    } catch (cause) {
      setValue(previous);
      setProblem(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className="text-[var(--text-xs)] text-[var(--ink-faint)]">Persona — who you are in this chat</span>
        <select
          className="field min-h-10"
          value={value}
          disabled={busy}
          onChange={(event) => void pick(event.target.value)}
        >
          <option value="">None</option>
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
          {orphanId !== null && (
            <option value={orphanId}>{orphan.data?.name ?? 'Missing persona'}</option>
          )}
        </select>
      </label>

      {value.length === 0 && (
        <p className="text-[var(--text-xs)] text-[var(--ink-faint)]">
          <code className="md-code">{USER_MACRO}</code> will be left as a literal placeholder.{' '}
          <Link to="/personas" className="text-[var(--brass)] underline underline-offset-2">
            {personas.length === 0 ? 'Create a persona' : 'Manage personas'}
          </Link>
        </p>
      )}

      {orphanId !== null && (
        <p className="text-[var(--text-xs)] text-[var(--danger)]">
          {orphan.data
            ? 'This persona is no longer in the list — it was deleted elsewhere.'
            : 'This chat points at a persona that no longer exists.'}
        </p>
      )}

      {error && <p className="text-[var(--text-xs)] text-[var(--danger)]">{error}</p>}
      {problem && <p className="text-[var(--text-xs)] text-[var(--danger)]">{problem}</p>}
    </div>
  );
}
