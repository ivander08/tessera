import { useState } from 'react';
import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import { resolveAssetUrl } from '../lib/assets';
import { messageOf, useAsync } from '../lib/hooks';
import type { PersonaSummary } from '../components/PersonaPicker';

/**
 * Persona manager.
 *
 * A persona is the reader's own identity in a chat: its name and description fill
 * `{{user}}` and `{{persona}}` in the character card. Without one the Worker leaves the
 * placeholder visible on purpose — filling it with the pronoun "You" produces "She calls
 * You by name", which the model reads as a proper noun and invents a name around. So the
 * note at the top is the whole reason this screen exists, not an introduction to it.
 *
 * Renaming is not free: the name is substituted into the cached head, so the next turn
 * in every chat using this persona is a full cache miss. That is inherent — the model
 * genuinely saw a different name — but the list shows the chat count so the cost is
 * visible before the edit rather than after it.
 */
export default function Personas() {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<PersonaSummary[]>('/api/personas'),
    [],
  );

  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  /**
   * Every mutation re-reads the list: the Worker is the only writer worth trusting.
   * Returns whether it worked, so a failed save leaves the editor open with the text
   * still in it rather than closing as though the change had landed.
   */
  async function mutate(run: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    setStatus(null);
    try {
      await run();
      setStatus(done);
      reload();
      return true;
    } catch (cause) {
      setProblem(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(persona: PersonaSummary) {
    const chats = persona.chat_count === 1 ? '1 chat' : `${persona.chat_count} chats`;
    const confirmed = window.confirm(
      persona.chat_count > 0
        ? `Delete "${persona.name}"? It will be detached from ${chats}. The chats and their messages are kept — they just stop resolving {{user}}.`
        : `Delete "${persona.name}"?`,
    );
    if (!confirmed) return;

    await mutate(
      () => apiJson(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'DELETE' }),
      `Deleted "${persona.name}".`,
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-5 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-[var(--font-lg)] font-semibold">Personas</h1>
        <nav className="flex gap-3">
          <Link to="/" className="app-link inline-flex min-h-10 items-center">
            Chats
          </Link>
          <Link to="/settings" className="app-link inline-flex min-h-10 items-center">
            Settings
          </Link>
        </nav>
      </header>

      <p className="card p-3 text-[var(--font-sm)] text-[var(--ink-dim)]">
        A persona is <span className="text-[var(--ink)]">you</span> — the name and description
        the character is talking to. Cards written with <code className="md-code">{'{{user}}'}</code>{' '}
        get that placeholder replaced with the persona's name. With no persona set it is left
        visible rather than guessed at, so a card that says{' '}
        <em>"She calls {'{{user}}'} by name"</em> reads exactly like that in the reply.
      </p>

      <NewPersona
        busy={busy}
        onCreate={(name, description, avatar) =>
          mutate(
            () =>
              apiJson('/api/personas', {
                method: 'POST',
                body: JSON.stringify({ name, description, avatar }),
              }),
            `Created "${name}".`,
          )
        }
        onError={setProblem}
      />

      {loading && <p className="text-sm text-[var(--ink-dim)]">Loading…</p>}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {problem && <p className="text-sm text-[var(--danger)]">{problem}</p>}
      {status && <p className="text-sm text-[var(--ink-dim)]">{status}</p>}

      {data && data.length === 0 && (
        <p className="text-sm text-[var(--ink-dim)]">
          No personas yet. Add one above and attach it to a chat from the chat header.
        </p>
      )}

      <ul className="space-y-2">
        {data?.map((persona) => (
          <li key={persona.id} className="card p-3">
            {editingId === persona.id ? (
              <PersonaForm
                initial={persona}
                submitLabel="Save"
                busy={busy}
                onSubmit={async (name, description, avatar) => {
                  const ok = await mutate(
                    () =>
                      apiJson('/api/personas', {
                        method: 'PATCH',
                        body: JSON.stringify({ id: persona.id, name, description, avatar }),
                      }),
                    `Saved "${name}". The next turn in each of its chats is a full cache miss — the name is part of the cached prefix.`,
                  );
                  if (ok) setEditingId(null);
                  return ok;
                }}
                onCancel={() => setEditingId(null)}
                onError={setProblem}
              />
            ) : (
              <div className="flex items-start gap-3">
                <Avatar persona={persona} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{persona.name}</p>
                  {persona.description ? (
                    <p className="text-[var(--font-sm)] whitespace-pre-wrap text-[var(--ink-dim)]">
                      {persona.description}
                    </p>
                  ) : (
                    <p className="text-[var(--font-sm)] text-[var(--ink-faint)]">No description.</p>
                  )}
                  <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                    {persona.chat_count === 0
                      ? 'Not used by any chat'
                      : `Used by ${persona.chat_count} ${persona.chat_count === 1 ? 'chat' : 'chats'}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1 text-[var(--font-sm)]">
                  <button
                    type="button"
                    className="app-link min-h-10 text-left"
                    onClick={() => setEditingId(persona.id)}
                    disabled={busy}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="min-h-10 text-left text-[var(--ink-dim)]"
                    onClick={() => void remove(persona)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

function Avatar({ persona }: { persona: PersonaSummary }) {
  const url = resolveAssetUrl(persona.avatar);
  if (url) {
    return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />;
  }
  return (
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--surface-overlay)] text-[var(--font-xs)] text-[var(--ink-faint)]">
      {persona.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function NewPersona({
  busy,
  onCreate,
  onError,
}: {
  busy: boolean;
  onCreate: (name: string, description: string, avatar: string | null) => Promise<boolean>;
  onError: (message: string | null) => void;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-[var(--font-sm)] font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
        New persona
      </h2>
      <PersonaForm
        submitLabel="Create"
        busy={busy}
        onSubmit={(name, description, avatar) => onCreate(name, description, avatar)}
        onCancel={null}
        onError={onError}
      />
    </section>
  );
}

/**
 * Shared by create and edit, because the two forms must not drift: a field the API
 * accepts but only one form exposes is how a persona becomes uneditable.
 *
 * Empty strings are sent as `null`, not `''`. The API stores what it is given, and an
 * empty description is indistinguishable from a missing one downstream.
 */
function PersonaForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  onError,
}: {
  initial?: PersonaSummary;
  submitLabel: string;
  busy: boolean;
  onSubmit: (name: string, description: string, avatar: string | null) => boolean | Promise<boolean>;
  onCancel: (() => void) | null;
  onError?: (message: string | null) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [avatar, setAvatar] = useState(initial?.avatar ?? '');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim().length === 0) {
      onError?.('A name is required — it is what replaces {{user}}.');
      return;
    }
    onError?.(null);
    const ok = await onSubmit(
      name.trim(),
      description.trim(),
      avatar.trim().length > 0 ? avatar.trim() : null,
    );
    // A rejected write keeps the text on screen so it can be retried without retyping.
    if (ok && !initial) {
      setName('');
      setDescription('');
      setAvatar('');
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2">
      <label className="block space-y-1">
        <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">Name — replaces {'{{user}}'}</span>
        <input
          className="field min-h-10"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ivan"
          required
        />
      </label>

      <label className="block space-y-1">
        <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">
          Description — sent to the model every turn
        </span>
        <textarea
          className="field"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Who you are in the scene, in the character's terms."
        />
      </label>

      <label className="block space-y-1">
        <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">
          Avatar URL — optional, shown in the list only
        </span>
        <input
          className="field min-h-10"
          value={avatar}
          onChange={(event) => setAvatar(event.target.value)}
          placeholder="https://…"
        />
      </label>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn primary min-h-10" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn min-h-10" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
