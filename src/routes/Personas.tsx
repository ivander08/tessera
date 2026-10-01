import { useState } from 'react';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { Avatar } from '../components/Avatar';
import { ConfirmPrompt } from '../components/ConfirmPrompt';

/** The row shape `/api/personas` returns. */
interface PersonaSummary {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  created_at: number;
  /** How many chats currently have this persona attached. */
  chat_count: number;
}

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
  // The persona the reader has asked to delete, held until they confirm.
  const [confirming, setConfirming] = useState<PersonaSummary | null>(null);

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
    await mutate(
      () => apiJson(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'DELETE' }),
      `Deleted "${persona.name}".`,
    );
    setConfirming(null);
  }

  /**
   * The question the sheet asks. Deleting a persona detaches it from its chats rather
   * than deleting them, and the message says so — the cost of the action is not obvious
   * from the word "Delete".
   */
  function deleteQuestion(persona: PersonaSummary): string {
    const chats = persona.chat_count === 1 ? '1 chat' : `${persona.chat_count} chats`;
    return persona.chat_count > 0
      ? `Delete "${persona.name}"? It will be detached from ${chats}. The chats and their messages are kept — they just stop resolving {{user}}.`
      : `Delete "${persona.name}"?`;
  }

  return (
    <>
      <AppBar title={<span className="bar-title">Personas</span>} />

      <main className="sheet">
      <p className="note">
        A persona is <span style={{ color: 'var(--ink)' }}>you</span> — the name and description
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

      {loading && <p className="sheet-sub" style={{ marginTop: 16 }}>Loading…</p>}
      {error && <div className="note danger" style={{ marginTop: 16 }}>{error}</div>}
      {problem && <div className="note danger" style={{ marginTop: 16 }}>{problem}</div>}
      {status && <p className="form-hint" style={{ marginTop: 16 }}>{status}</p>}

      <section className="section">
        <span className="eyebrow">
          Saved personas
          {data && data.length > 0 && <span className="data"> {data.length}</span>}
        </span>

        {data && data.length === 0 && (
          <p className="sheet-sub" style={{ marginTop: 0 }}>
            No personas yet. Add one above and attach it to a chat from the chat header.
          </p>
        )}

        {data?.map((persona) => (
          <div key={persona.id} className="panel panel-pad" style={{ marginBottom: 12 }}>
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
                <PersonaChip persona={persona} />
                <div className="min-w-0 flex-1">
                  <p className="row-title">{persona.name}</p>
                  {persona.description ? (
                    <p
                      className="sheet-sub"
                      style={{ whiteSpace: 'pre-wrap', marginTop: 5 }}
                    >
                      {persona.description}
                    </p>
                  ) : (
                    <p className="form-hint" style={{ marginTop: 5 }}>
                      No description.
                    </p>
                  )}
                  <p className="form-hint" style={{ marginTop: 7 }}>
                    {persona.chat_count === 0
                      ? 'Not used by any chat'
                      : `Used by ${persona.chat_count} ${persona.chat_count === 1 ? 'chat' : 'chats'}`}
                  </p>
                </div>
                <div className="row-actions" style={{ flexDirection: 'column', gap: 6 }}>
                  <button
                    type="button"
                    className="btn quiet"
                    onClick={() => setEditingId(persona.id)}
                    disabled={busy}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn quiet danger"
                    onClick={() => setConfirming(persona)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </section>
      </main>

      {confirming && (
        <ConfirmPrompt
          title="Delete this persona"
          message={deleteQuestion(confirming)}
          confirmLabel="Delete"
          busy={busy}
          danger
          onConfirm={() => void remove(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

/** The persona's chip: their image when they have one, otherwise their initial. */
function PersonaChip({ persona }: { persona: PersonaSummary }) {
  return <Avatar src={persona.avatar} name={persona.name} />;
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
    <section className="section">
      <span className="eyebrow">New persona</span>
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
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <label className="block space-y-2">
        <span className="form-hint" style={{ display: 'block' }}>
          Name — replaces {'{{user}}'}
        </span>
        <input
          className="field min-h-10"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ivan"
          required
        />
      </label>

      <label className="block space-y-2">
        <span className="form-hint" style={{ display: 'block' }}>
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

      <label className="block space-y-2">
        <span className="form-hint" style={{ display: 'block' }}>
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
