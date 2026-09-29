import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';

/**
 * Memory viewer: read, edit, pin and delete what the chat remembers.
 *
 * Everything here is side-table data. Editing a summary or deleting a fact changes
 * only `summaries` / `facts` — the message history is append-only and stays that way,
 * so a wrong memory can be corrected without rewriting the transcript it came from.
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
    <main className="mx-auto max-w-3xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Memory</h1>
        <nav className="flex gap-3 text-sm">
          <Link to={`/chat/${encodeURIComponent(id)}`} className="text-ink-dim hover:text-ink">
            ← Chat
          </Link>
        </nav>
      </header>

      {loading && <p className="text-sm text-ink-dim">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {actionError && <p className="mb-3 text-sm text-red-400">{actionError}</p>}

      {data && (
        <div className="space-y-8">
          <Section
            title="Facts"
            count={data.facts.length}
            empty="No facts yet. Facts are proposed after each turn, or added by hand below."
          >
            <NewFact chatId={id} onCreated={() => reload()} onError={setActionError} />
            <ul className="divide-y divide-white/5">
              {data.facts.map((fact) => (
                <FactRow
                  key={fact.id}
                  fact={fact}
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
          </Section>

          <Section title="Arcs" count={arcs.length} empty="No arcs yet. Ten scenes fold into one.">
            <ul className="divide-y divide-white/5">
              {arcs.map((entry) => (
                <SummaryRow
                  key={entry.id}
                  entry={entry}
                  onSave={(content) =>
                    mutate(`/api/memory/summaries/${entry.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ content }),
                    })
                  }
                  onDelete={() =>
                    mutate(`/api/memory/summaries/${entry.id}`, { method: 'DELETE' })
                  }
                />
              ))}
            </ul>
          </Section>

          <Section
            title="Scenes"
            count={scenes.length}
            empty="No scenes yet. Summarization runs in the background as a chat grows."
          >
            <ul className="divide-y divide-white/5">
              {scenes.map((entry) => (
                <SummaryRow
                  key={entry.id}
                  entry={entry}
                  onSave={(content) =>
                    mutate(`/api/memory/summaries/${entry.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ content }),
                    })
                  }
                  onDelete={() =>
                    mutate(`/api/memory/summaries/${entry.id}`, { method: 'DELETE' })
                  }
                />
              ))}
            </ul>
          </Section>
        </div>
      )}
    </main>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-dim">
        {title} <span className="font-normal normal-case">({count})</span>
      </h2>
      {count === 0 && <p className="text-sm text-ink-dim">{empty}</p>}
      {children}
    </section>
  );
}

function FactRow({
  fact,
  onSave,
  onTogglePin,
  onToggleStatus,
  onDelete,
}: {
  fact: FactEntry;
  onSave: (text: string) => void;
  onTogglePin: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const superseded = fact.status === 'superseded';

  return (
    <li className={`py-3 ${superseded ? 'opacity-40' : ''}`}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onTogglePin}
          title={fact.pinned === 1 ? 'Unpin' : 'Pin — always recalled'}
          aria-pressed={fact.pinned === 1}
          className={`mt-0.5 shrink-0 text-sm ${fact.pinned === 1 ? 'text-accent' : 'text-ink-dim hover:text-ink'}`}
        >
          {fact.pinned === 1 ? '★' : '☆'}
        </button>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                className="w-full resize-none rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onSave(draft);
                    setEditing(false);
                  }}
                  disabled={draft.trim().length === 0}
                  className="rounded bg-accent px-3 py-1 text-sm font-medium text-black disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(fact.text);
                    setEditing(false);
                  }}
                  className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{fact.text}</p>
          )}
          <p className="mt-1 text-xs text-ink-dim">
            {fact.subject ?? 'no subject'} · {fact.status}
            {fact.superseded_by && ` by ${fact.superseded_by.slice(0, 8)}`}
          </p>
        </div>

        <div className="flex shrink-0 gap-2 text-xs">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-ink-dim hover:text-ink"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={onToggleStatus}
            title={superseded ? 'Restore to active' : 'Mark superseded'}
            className="text-ink-dim hover:text-ink"
          >
            {superseded ? 'Restore' : 'Supersede'}
          </button>
          <button type="button" onClick={onDelete} className="text-ink-dim hover:text-red-400">
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

function SummaryRow({
  entry,
  onSave,
  onDelete,
}: {
  entry: SummaryEntry;
  onSave: (content: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);

  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded bg-white/10 px-2 py-0.5 font-mono text-xs text-ink-dim">
          {entry.covers_from}–{entry.covers_to}
        </span>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={6}
                className="w-full resize-none rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onSave(draft);
                    setEditing(false);
                  }}
                  disabled={draft.trim().length === 0}
                  className="rounded bg-accent px-3 py-1 text-sm font-medium text-black disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(entry.content);
                    setEditing(false);
                  }}
                  className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{entry.content}</p>
          )}
          <p className="mt-1 text-xs text-ink-dim">
            {entry.tokens ?? 0} tokens · {new Date(entry.created_at).toLocaleString()}
          </p>
        </div>

        <div className="flex shrink-0 gap-2 text-xs">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-ink-dim hover:text-ink"
            >
              Edit
            </button>
          )}
          <button type="button" onClick={onDelete} className="text-ink-dim hover:text-red-400">
            Delete
          </button>
        </div>
      </div>
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

  async function submit(event: React.FormEvent) {
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
    <form onSubmit={submit} className="mb-2 flex gap-2">
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Add a fact the chat should always know"
        className="flex-1 rounded border border-white/15 bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={draft.trim().length === 0}
        className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-40"
      >
        Add
      </button>
    </form>
  );
}
