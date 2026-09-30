import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar, BackLink } from '../components/AppBar';

/**
 * Memory viewer: read, edit, pin and delete what the chat remembers.
 *
 * Everything here is side-table data. Editing a summary or deleting a fact changes
 * only `summaries` / `facts` — the message history is append-only and stays that way,
 * so a wrong memory can be corrected without rewriting the transcript it came from.
 *
 * Facts are listed first because they are the part that is always relevant, whatever the
 * chat grows to. The summaries are the long tail, folded away so it does not have to be
 * re-read into every prompt.
 */

interface SummaryEntry {
  id: string;
  tier: 'scene' | 'arc';
  covers_from: number;
  covers_to: number;
  content: string;
  tokens: number | null;
  created_at: number;
}

interface FactEntry {
  id: string;
  text: string;
  subject: string | null;
  status: 'active' | 'superseded';
  superseded_by: string | null;
  pinned: number;
  created_at: number;
}

interface MemoryPayload {
  summaries: SummaryEntry[];
  facts: FactEntry[];
}

export default function Memory() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<MemoryPayload>(`/api/chats/${encodeURIComponent(id)}/memory`),
    [id],
  );

  const [actionError, setActionError] = useState<string | null>(null);

  /** Every mutation re-reads the list: the Worker is the only writer worth trusting. */
  async function mutate(path: string, init: RequestInit): Promise<void> {
    setActionError(null);
    try {
      await apiJson(path, init);
      reload();
    } catch (cause) {
      setActionError(messageOf(cause));
    }
  }

  const scenes = data?.summaries.filter((entry) => entry.tier === 'scene') ?? [];
  const arcs = data?.summaries.filter((entry) => entry.tier === 'arc') ?? [];

  return (
    <>
      <AppBar
        lead={<BackLink to={`/chat/${encodeURIComponent(id)}`} label="Back to chat" />}
        title={<span className="bar-title">Memory</span>}
      />

      <div className="sheet">
        <div className="sheet-head">
          <div>
            <h1 className="title">Memory</h1>
            <p className="sheet-sub">
              What this chat carries forward: the facts it always knows, and summaries of the
              scenes behind it. Correcting an entry here changes only the memory — the
              transcript it came from is never rewritten.
            </p>
          </div>
        </div>

        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}
        {actionError && <div className="note danger">{actionError}</div>}

        {data && (
          <>
            <section className="section">
              <span className="eyebrow">
                Facts <span className="data">{data.facts.length}</span>
              </span>

              <NewFact chatId={id} onCreated={() => reload()} onError={setActionError} />

              {data.facts.length === 0 ? (
                <div className="empty">
                  Nothing is remembered as a fact yet.
                  <br />
                  Facts are drawn out of the conversation as it goes — add one above if there
                  is something this chat should always know.
                </div>
              ) : (
                <ul className="panel">
                  {data.facts.map((fact, index) => (
                    <FactRow
                      key={fact.id}
                      fact={fact}
                      bordered={index > 0}
                      onSave={(text) =>
                        mutate(`/api/memory/facts/${fact.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ text }),
                        })
                      }
                      onTogglePin={() =>
                        mutate(`/api/memory/facts/${fact.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ pinned: fact.pinned !== 1 }),
                        })
                      }
                      onToggleStatus={() =>
                        mutate(`/api/memory/facts/${fact.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({
                            status: fact.status === 'active' ? 'superseded' : 'active',
                          }),
                        })
                      }
                      onDelete={() =>
                        mutate(`/api/memory/facts/${fact.id}`, { method: 'DELETE' })
                      }
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="section">
              <span className="eyebrow">
                Arcs <span className="data">{arcs.length}</span>
              </span>

              {arcs.length === 0 ? (
                <div className="empty">
                  No arcs yet.
                  <br />
                  Ten scene summaries fold into one, so the first arc appears only once a chat
                  has run very long.
                </div>
              ) : (
                <SummaryList
                  entries={arcs}
                  onSave={(entryId, content) =>
                    mutate(`/api/memory/summaries/${entryId}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ content }),
                    })
                  }
                  onDelete={(entryId) =>
                    mutate(`/api/memory/summaries/${entryId}`, { method: 'DELETE' })
                  }
                />
              )}
            </section>

            <section className="section">
              <span className="eyebrow">
                Scenes <span className="data">{scenes.length}</span>
              </span>

              {scenes.length === 0 ? (
                <div className="empty">
                  No scenes yet — and on a new chat that is correct, not broken.
                  <br />
                  The cheap model writes one every ~20 messages, so this list fills in as the
                  chat grows.
                </div>
              ) : (
                <SummaryList
                  entries={scenes}
                  onSave={(entryId, content) =>
                    mutate(`/api/memory/summaries/${entryId}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ content }),
                    })
                  }
                  onDelete={(entryId) =>
                    mutate(`/api/memory/summaries/${entryId}`, { method: 'DELETE' })
                  }
                />
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}

/** The actions a row's text sits under. Wraps rather than squeezing the text column. */
function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2 mt-2">{children}</div>;
}

/** One line of provenance: who a fact is about, and what happened to it. */
function Provenance({ children }: { children: React.ReactNode }) {
  return (
    <p className="data" style={{ margin: '5px 0 0' }}>
      {children}
    </p>
  );
}

function FactRow({
  fact,
  bordered,
  onSave,
  onTogglePin,
  onToggleStatus,
  onDelete,
}: {
  fact: FactEntry;
  bordered: boolean;
  onSave: (text: string) => void;
  onTogglePin: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const superseded = fact.status === 'superseded';
  const pinned = fact.pinned === 1;

  return (
    <li
      className={`p-3 ${bordered ? 'border-t border-line' : ''}`}
      // Superseded facts stay in the list — the history is the point — but they are
      // dimmed so the ones still in force read first.
      style={superseded ? { opacity: 0.55 } : undefined}
    >
      {editing ? (
        <div className="space-y-2">
          <textarea
            className="field"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn primary"
              disabled={draft.trim().length === 0}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(fact.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {(pinned || superseded) && (
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {pinned && (
                <span className="tag brass" title="Recalled into every prompt">
                  pinned
                </span>
              )}
              {superseded && <span className="tag">superseded</span>}
            </div>
          )}

          <p className="prose whitespace-pre-wrap" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
            {fact.text}
          </p>

          <Provenance>
            {fact.subject ?? 'no subject'} · {fact.status}
            {fact.superseded_by && ` by ${fact.superseded_by.slice(0, 8)}`}
          </Provenance>

          <RowActions>
            <button type="button" className="btn quiet" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="btn quiet"
              title={pinned ? 'Stop always recalling this' : 'Always recall this'}
              onClick={onTogglePin}
            >
              {pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              className="btn quiet"
              title={
                superseded
                  ? 'Put this back in force'
                  : 'Mark as no longer true, keeping it in the record'
              }
              onClick={onToggleStatus}
            >
              {superseded ? 'Restore' : 'Supersede'}
            </button>
            <button type="button" className="btn quiet danger" onClick={onDelete}>
              Delete
            </button>
          </RowActions>
        </>
      )}
    </li>
  );
}

function SummaryList({
  entries,
  onSave,
  onDelete,
}: {
  entries: SummaryEntry[];
  onSave: (id: string, content: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <ul className="panel">
      {entries.map((entry, index) => (
        <SummaryRow
          key={entry.id}
          entry={entry}
          bordered={index > 0}
          onSave={(content) => onSave(entry.id, content)}
          onDelete={() => onDelete(entry.id)}
        />
      ))}
    </ul>
  );
}

function SummaryRow({
  entry,
  bordered,
  onSave,
  onDelete,
}: {
  entry: SummaryEntry;
  bordered: boolean;
  onSave: (content: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);

  return (
    <li className={`p-3 ${bordered ? 'border-t border-line' : ''}`}>
      {editing ? (
        <div className="space-y-2">
          <textarea
            className="field"
            rows={6}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn primary"
              disabled={draft.trim().length === 0}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(entry.content);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p
            className="prose whitespace-pre-wrap"
            style={{ fontSize: 'var(--text-sm)', margin: 0 }}
          >
            {entry.content}
          </p>

          <Provenance>
            messages {entry.covers_from}–{entry.covers_to} · {entry.tokens ?? 0} tokens ·{' '}
            {new Date(entry.created_at).toLocaleString()}
          </Provenance>

          <RowActions>
            <button type="button" className="btn quiet" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn quiet danger" onClick={onDelete}>
              Delete
            </button>
          </RowActions>
        </>
      )}
    </li>
  );
}

/**
 * Facts are normally proposed by an extraction pass, but a fact the user types
 * themselves is still a fact — it belongs where it will be recalled and pinned, not
 * nowhere. Without this the pin and supersede controls would have nothing to act on.
 */
function NewFact({
  chatId,
  onCreated,
  onError,
}: {
  chatId: string;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    try {
      await apiJson('/api/memory/facts', {
        method: 'POST',
        body: JSON.stringify({ chatId, text }),
      });
      setDraft('');
      onCreated();
    } catch (cause) {
      onError(messageOf(cause));
    }
  }

  return (
    <form onSubmit={submit} className="flex gap-2" style={{ marginBottom: 10 }}>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Add a fact this chat should always know"
        className="field"
        style={{ flex: 1, minWidth: 0 }}
      />
      <button type="submit" className="btn primary" disabled={draft.trim().length === 0}>
        Add
      </button>
    </form>
  );
}
