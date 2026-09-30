import { useState } from 'react';
import { useParams } from 'react-router';
import { apiJson } from '../lib/api';
import type { WorldState } from '../lib/state/schema';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar, BackLink } from '../components/AppBar';

interface StatePayload {
  chatId: string;
  state: WorldState;
  updatedAt: number | null;
  rendered: string;
  tokens: number;
}

interface Field {
  key: keyof WorldState;
  label: string;
  hint: string;
  list?: boolean;
  /** A map of name -> text, edited as `Name: text` lines. */
  map?: boolean;
}

/**
 * Grouped the way a scene is described — where and when, who and what, then the rest.
 * The order also mirrors the prompt block, so the two read the same way down the page.
 */
const GROUPS: Array<{ heading: string; fields: Field[] }> = [
  {
    heading: 'Where and when',
    fields: [
      {
        key: 'time',
        label: 'Time',
        hint: 'Real date and time — "Wednesday, 30 September 2026, 05:34 AM".',
      },
      {
        key: 'location',
        label: 'Location',
        hint: 'Place and spot — "Sydney, on the coast, sitting on the bed".',
      },
      { key: 'weather', label: 'Weather', hint: 'What it is doing outside, if it was said.' },
    ],
  },
  {
    heading: 'Who and what',
    fields: [
      { key: 'present', label: 'Present', hint: 'Characters in the scene, one per line.', list: true },
      {
        key: 'outfits',
        label: 'Outfits',
        hint: 'Character: what they are wearing. One per line.',
        map: true,
      },
      { key: 'inventory', label: 'Inventory', hint: 'Things being carried, one per line.', list: true },
    ],
  },
  {
    heading: 'Notes',
    fields: [{ key: 'notes', label: 'What not to forget', hint: 'One per line.', list: true }],
  },
];

const ALL_FIELDS: Field[] = GROUPS.flatMap((group) => group.fields);

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
export default function State({ embedded = false }: { embedded?: boolean } = {}) {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<StatePayload>(`/api/state/${encodeURIComponent(id)}`),
    [id],
  );

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const state = data?.state ?? {};

  function currentValue(key: keyof WorldState, list?: boolean, map?: boolean): string {
    if (edits[key] !== undefined) return edits[key];
    const value = state[key];
    if (value === undefined) return '';
    if (list) return (value as string[]).join('\n');
    // Sorted by key, so the textarea is stable across reloads — a record's iteration
    // order is insertion order, which depends on the order patches happened to arrive.
    if (map) {
      return Object.entries(value as Record<string, string>)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([name, text]) => `${name}: ${text}`)
        .join('\n');
    }
    return String(value);
  }

  async function save() {
    setBusy(true);
    setStatus(null);

    // Build a patch from the fields actually touched, so untouched fields are not
    // rewritten with a normalised version of themselves.
    const patch: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(edits)) {
      const field = ALL_FIELDS.find((f) => f.key === key);
      if (!field) continue;
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        patch[key] = null; // null clears, which is what emptying the box means
      } else if (field.list) {
        patch[key] = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
      } else if (field.map) {
        // Split on the FIRST colon only: an outfit can contain one ("a coat: navy"), and
        // a value that loses its tail is worse than a line that is skipped.
        const entries: Record<string, string> = {};
        for (const line of trimmed.split('\n')) {
          const at = line.indexOf(':');
          if (at < 0) continue;
          const name = line.slice(0, at).trim();
          const text = line.slice(at + 1).trim();
          if (name.length === 0) continue;
          entries[name] = text;
        }
        if (Object.keys(entries).length === 0) continue;
        patch[key] = entries;
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

  // Embedded in the chat's side panel, the screen keeps its content and loses its
  // chrome: the panel already has a title bar and a close button, and a second AppBar
  // inside a dialog would be a frame inside a frame.
  const body = (
    <>
      {loading && <p className="sheet-sub">Loading…</p>}
      {error && <div className="note danger">{error}</div>}

      {data && (
        <>
          {!embedded && (
            <div className="sheet-head">
              <div>
                <h1 className="title">World state</h1>
                <p className="sheet-sub">
                  This is what the narrator believes next turn. A wrong value here is not
                  cosmetic — it shapes the writing until it is corrected.
                </p>
              </div>
            </div>
          )}

          <p className="data" style={{ margin: 0 }}>
            {data.updatedAt
              ? `last written ${new Date(data.updatedAt).toLocaleString()}`
              : 'never written — the engine runs after a completed turn'}
              {' · '}
              {data.tokens} tokens in the prompt tail
            </p>

            {Object.keys(state).length === 0 && (
              <div className="note" style={{ marginTop: 20 }}>
                Nothing recorded yet. The engine proposes changes after each completed turn, so an
                empty document on a fresh chat is correct. If it stays empty after several turns,
                the cheap model is not configured or is failing.
              </div>
            )}

            {GROUPS.map((group) => (
              <section key={group.heading} className="section">
                <span className="eyebrow">{group.heading}</span>
                {group.fields.map((field) => (
                  <label key={String(field.key)} className="form-row">
                    <span className="form-label">
                      <span>{field.label}</span>
                      <span className="form-hint">{field.hint}</span>
                    </span>
                    {field.list || field.map ? (
                      <textarea
                        className="field"
                        rows={3}
                        value={currentValue(field.key, field.list, field.map)}
                        onChange={(event) =>
                          setEdits({ ...edits, [String(field.key)]: event.target.value })
                        }
                        placeholder={field.map ? 'Name: what they are wearing' : 'one per line'}
                      />
                    ) : (
                      <input
                        className="field"
                        value={currentValue(field.key)}
                        onChange={(event) =>
                          setEdits({ ...edits, [String(field.key)]: event.target.value })
                        }
                      />
                    )}
                  </label>
                ))}
              </section>
            ))}

            {state.away && Object.keys(state.away).length > 0 && (
              <section className="section">
                <span className="eyebrow">Elsewhere</span>
                <div className="panel panel-pad">
                  {Object.entries(state.away).map(([who, where]) => (
                    <div key={who} style={{ display: 'flex', gap: 10 }}>
                      <span style={{ minWidth: 90, color: 'var(--ink)' }}>{who}</span>
                      <span style={{ color: 'var(--ink-dim)' }}>{where}</span>
                    </div>
                  ))}
                </div>
                <p className="form-hint" style={{ marginTop: 8 }}>
                  Characters who have left the scene and where they went. This is what stops the
                  narrator writing someone into a room they walked out of.
                </p>
              </section>
            )}

            {state.conditions && Object.keys(state.conditions).length > 0 && (
              <section className="section">
                <span className="eyebrow">Conditions</span>
                <div className="panel panel-pad">
                  {Object.entries(state.conditions).map(([who, what]) => (
                    <div key={who} style={{ display: 'flex', gap: 10 }}>
                      <span style={{ minWidth: 90, color: 'var(--ink)' }}>{who}</span>
                      <span style={{ color: 'var(--ink-dim)' }}>{what}</span>
                    </div>
                  ))}
                </div>
                <p className="form-hint" style={{ marginTop: 8 }}>
                  Maintained per character by the engine. Edit them by describing the change in
                  the chat rather than here.
                </p>
              </section>
            )}

            <section className="section">
              <span className="eyebrow">As the narrator sees it</span>
              <div className="panel panel-pad">
                <pre
                  className="data"
                  style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.65 }}
                >
                  {data.rendered || '(nothing — the block is omitted entirely when empty)'}
                </pre>
              </div>
              <p className="form-hint" style={{ marginTop: 8 }}>
                Rendered into the prompt tail, after the cached prefix, so changing it never costs
                a cache miss.
              </p>
            </section>

            <div style={{ marginTop: 30 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
                  Save changes
                </button>
                <button type="button" className="btn danger" onClick={() => void clearAll()} disabled={busy}>
                  Clear everything
                </button>
              </div>
              {status && (
                <p className="form-hint" style={{ marginTop: 10 }}>
                  {status}
                </p>
              )}
            </div>
          </>
        )}
    </>
  );

  if (embedded) return body;

  return (
    <>
      <AppBar
        lead={<BackLink to={`/chat/${id}`} label="Back to chat" />}
        title={<span className="bar-title">World state</span>}
      />
      <main className="sheet">{body}</main>
    </>
  );
}
