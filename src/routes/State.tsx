import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiJson } from '../lib/api';
import type { WorldState } from '../lib/state/schema';
import { messageOf, useAsync } from '../lib/hooks';

interface StatePayload {
  chatId: string;
  state: WorldState;
  updatedAt: number | null;
  rendered: string;
  tokens: number;
}

/** Field order mirrors the prompt block, so the two read the same way. */
const FIELDS: Array<{ key: keyof WorldState; label: string; hint: string; list?: boolean }> = [
  { key: 'time', label: 'Time', hint: 'In-world clock, e.g. "late evening". Not a timestamp.' },
  { key: 'location', label: 'Location', hint: 'Where the scene is.' },
  { key: 'weather', label: 'Weather', hint: 'Optional atmosphere.' },
  { key: 'present', label: 'Present', hint: 'Characters in the scene, one per line.', list: true },
  { key: 'inventory', label: 'Inventory', hint: 'Things being carried, one per line.', list: true },
  { key: 'notes', label: 'Notes', hint: 'Anything the narrator should not forget.', list: true },
];

/**
 * The world-state viewer.
 *
 * The engine writes this after every turn and it feeds the prompt's tail, so a wrong
 * value is not cosmetic — it is what the narrator believes next turn. Reading the real
 * documents is how you catch it: the first look at stored state found a cast list
 * containing the pronoun "me" and a user name the narrator had invented.
 *
 * Edits are sent as a patch, so clearing a field and leaving it alone are distinct
 * operations rather than the same one.
 */
export default function State() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<StatePayload>(`/api/state/${encodeURIComponent(id)}`),
    [id],
  );

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const state = data?.state ?? {};

  function currentValue(key: keyof WorldState, list?: boolean): string {
    if (edits[key] !== undefined) return edits[key];
    const value = state[key];
    if (value === undefined) return '';
    return list ? (value as string[]).join('\n') : String(value);
  }

  async function save() {
    setBusy(true);
    setStatus(null);

    // Build a patch from the fields actually touched, so untouched fields are not
    // rewritten with a normalised version of themselves.
    const patch: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(edits)) {
      const field = FIELDS.find((f) => f.key === key);
      if (!field) continue;
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        patch[key] = null; // null clears, which is what emptying the box means
      } else if (field.list) {
        patch[key] = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
      } else {
        patch[key] = trimmed;
      }
    }

    if (Object.keys(patch).length === 0) {
      setBusy(false);
      setStatus('Nothing changed.');
      return;
    }

    try {
      await apiJson(`/api/state/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ chatId: id, patch }),
      });
      setEdits({});
      setStatus('Saved. The next turn will use this.');
      reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setBusy(true);
    setStatus(null);
    try {
      await apiJson(`/api/state/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setEdits({});
      setStatus('Cleared.');
      reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-5 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-[var(--font-lg)] font-semibold">World state</h1>
        <Link to={`/chat/${id}`} className="app-link">
          ← Chat
        </Link>
      </header>

      {loading && <p className="text-sm text-[var(--ink-dim)]">Loading…</p>}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {data && (
        <>
          <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
            {data.updatedAt
              ? `Last written ${new Date(data.updatedAt).toLocaleString()}`
              : 'Never written — the engine runs after a completed turn.'}
            {' · '}
            {data.tokens} tokens in the prompt tail
          </p>

          {Object.keys(state).length === 0 && (
            <p className="text-sm text-[var(--ink-dim)]">
              Empty. The engine proposes changes after each turn; if this stays empty, the
              cheap model is not configured or is failing.
            </p>
          )}

          {FIELDS.map((field) => (
            <label key={String(field.key)} className="block space-y-1">
              <span className="flex items-baseline justify-between">
                <span className="text-[var(--font-sm)] font-medium">{field.label}</span>
                <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">{field.hint}</span>
              </span>
              {field.list ? (
                <textarea
                  className="field"
                  rows={3}
                  value={currentValue(field.key, true)}
                  onChange={(event) => setEdits({ ...edits, [String(field.key)]: event.target.value })}
                  placeholder="one per line"
                />
              ) : (
                <input
                  className="field"
                  value={currentValue(field.key)}
                  onChange={(event) => setEdits({ ...edits, [String(field.key)]: event.target.value })}
                />
              )}
            </label>
          ))}

          {state.conditions && Object.keys(state.conditions).length > 0 && (
            <div className="space-y-1">
              <span className="text-[var(--font-sm)] font-medium">Conditions</span>
              <p className="text-[var(--font-sm)] text-[var(--ink-dim)]">
                {Object.entries(state.conditions)
                  .map(([who, what]) => `${who}: ${what}`)
                  .join(' · ')}
              </p>
              <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                Read-only here — the engine maintains conditions per character.
              </p>
            </div>
          )}

          <section className="space-y-1">
            <h2 className="text-[var(--font-sm)] font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
              As the model sees it
            </h2>
            <pre className="card overflow-x-auto p-3 text-[var(--font-xs)] whitespace-pre-wrap">
              {data.rendered || '(nothing — the block is omitted entirely when empty)'}
            </pre>
          </section>

          <div className="flex items-center gap-3">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => void clearAll()} disabled={busy}>
              Clear all
            </button>
            {status && <span className="text-[var(--font-sm)] text-[var(--ink-dim)]">{status}</span>}
          </div>
        </>
      )}
    </main>
  );
}
