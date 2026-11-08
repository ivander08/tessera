import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar, BackLink } from '../components/AppBar';
import { ConfirmPrompt } from '../components/ConfirmPrompt';
import { useToast } from '../components/Toast';
import { summaryDateSpan } from '../lib/prompt/memoryBlock';
import type { RecallHit } from '../lib/memoryTypes';
import type { SceneSetup } from '../lib/scene/setup';

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
  /** The in-world clock readings bounding the covered range, or null when none was recorded. */
  covers_date_from: string | null;
  covers_date_to: string | null;
  content: string;
  tokens: number | null;
  created_at: number;
  /** 1 when the reader removed it. Listed so it can be restored. */
  deleted: number;
}

interface FactEntry {
  id: string;
  text: string;
  subject: string | null;
  status: 'active' | 'superseded';
  superseded_by: string | null;
  pinned: number;
  /** A standing fact, or something that happened at a moment. */
  kind: 'fact' | 'event';
  /** The in-world date, verbatim, or null when none was recorded. */
  at: string | null;
  created_at: number;
  /** 1 when the reader removed it. Listed so it can be restored. */
  deleted: number;
}

interface MemoryPayload {
  summaries: SummaryEntry[];
  facts: FactEntry[];
  /** The recall hits the narrator was given for the most recent reader message. */
  recalled: RecallHit[];
  /** The memory block exactly as it is rendered into the prompt. */
  rendered: string;
  /** The text recall was run against. */
  query: string;
}

export default function Memory({ embedded = false }: { embedded?: boolean } = {}) {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<MemoryPayload>(`/api/chats/${encodeURIComponent(id)}/memory`),
    [id],
  );

  // Polled rather than pushed: the extraction runs on the Worker's own schedule, so there is
  // nothing to subscribe to. A failed or queued job is the state a reader is most likely to
  // be looking at this panel to understand.
  const { data: jobs, reload: reloadJobs } = useAsync(
    () =>
      apiJson<{
        job: { kind: string; status: string; attempts: number; error: string | null } | null;
      }>(`/api/chats/${encodeURIComponent(id)}/memory/jobs`),
    [id],
  );
  const job = jobs?.job ?? null;
  const jobLine =
    job === null || job.status === 'delivered'
      ? null
      : job.status === 'failed'
        ? `Last extraction failed${job.attempts > 1 ? ` after ${job.attempts} attempts` : ''}: ${job.error ?? 'no reason recorded'}`
        : 'Extracting…';

  // The mode lives in the chat's scene setup. Read here as well as in the section below,
  // because this screen has to say plainly that the lists are paused when it is on.
  const scene = useAsync(
    () => apiJson<{ setup: SceneSetup }>(`/api/chats/${encodeURIComponent(id)}/scene`),
    [id],
  );
  const memoryMode = scene.data?.setup.memoryMode ?? 'auto';

  const toast = useToast();
  // A delete here is permanent — the transcript is untouched, but the row and its recall
  // index entry are gone — so every one of the four kinds asks first.
  const [confirming, setConfirming] = useState<{
    id: string;
    kind: 'fact' | 'summary' | 'event';
    tier?: 'scene' | 'arc';
  } | null>(null);

  /** Every mutation re-reads the list: the Worker is the only writer worth trusting. */
  async function mutate(path: string, init: RequestInit, done: string): Promise<void> {
    try {
      await apiJson(path, init);
      toast.success(done);
      reload();
      reloadJobs();
    } catch (cause) {
      toast.failure(messageOf(cause));
    }
  }

  /** Both reads move together: a new fact or summary is the same event as a new job row. */
  function refresh(): void {
    reload();
    reloadJobs();
  }

  const scenes = data?.summaries.filter((entry) => entry.tier === 'scene') ?? [];
  const arcs = data?.summaries.filter((entry) => entry.tier === 'arc') ?? [];
  // Facts and events share a table and a recall index; the discriminator is what separates
  // the standing state of the world from its history. The server sends one list, because
  // that is what recall ranks, and the split happens here where it is displayed.
  const facts = data?.facts.filter((entry) => entry.kind !== 'event') ?? [];
  const events = data?.facts.filter((entry) => entry.kind === 'event') ?? [];

  const body = (
    <>
      {!embedded && (
        <div className="sheet-head">
          <div>
            <h1 className="title">Memory</h1>
            <p className="sheet-sub">
              What the narrator remembers from earlier in this chat, and the facts it has
              committed to. Scenes and arcs are summaries; facts are single statements that
              are still true. This is what gets recalled into the prompt tail when it is
              relevant — it never enters the cached prefix.
            </p>
          </div>
        </div>
      )}

      {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}
        <MemoryModeSection chatId={id} />

        {data && (
          <>
            {memoryMode === 'box' && (
              <p className="note" style={{ marginTop: 0 }}>
                The memory engine is paused for this chat. What you see below is kept, but the
                narrator is sent only your memory notes.
              </p>
            )}
            <section className="section">
              <span className="eyebrow">
                Facts{' '}
                <span className="data">
                  {facts.filter((fact) => fact.status === 'active' && fact.deleted === 0).length}
                </span>{' '}
                active
                {facts.some((fact) => fact.status === 'superseded') && (
                  <>
                    {' · '}
                    <span className="data">
                      {facts.filter((fact) => fact.status === 'superseded').length}
                    </span>{' '}
                    superseded
                  </>
                )}
              </span>
              <Compaction chatId={id} facts={facts} onApplied={refresh} />
              <NewFact chatId={id} onCreated={refresh} />

              {facts.length === 0 ? (
                <div className="empty">
                  Nothing is remembered as a fact yet.
                  <br />
                  Facts are drawn out of the conversation as it goes — add one above if there
                  is something this chat should always know.
                </div>
              ) : (
                <ul className="panel">
                  {facts.map((fact, index) => (
                    <FactRow
                      key={fact.id}
                      fact={fact}
                      bordered={index > 0}
                      onSave={(text) =>
                        mutate(
                          `/api/memory/facts/${fact.id}`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({ text }),
                          },
                          'Fact saved.',
                        )
                      }
                      onSetDate={(at) =>
                        mutate(
                          `/api/memory/facts/${fact.id}`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({ at }),
                          },
                          at ? 'Date saved.' : 'Date cleared.',
                        )
                      }
                      onTogglePin={() =>
                        mutate(
                          `/api/memory/facts/${fact.id}`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({ pinned: fact.pinned !== 1 }),
                          },
                          fact.pinned === 1 ? 'Fact unpinned.' : 'Fact pinned.',
                        )
                      }
                      onToggleStatus={() =>
                        mutate(
                          `/api/memory/facts/${fact.id}`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({
                              status: fact.status === 'active' ? 'superseded' : 'active',
                            }),
                          },
                          fact.status === 'active' ? 'Fact superseded.' : 'Fact restored.',
                        )
                      }
                      onDelete={() => setConfirming({ id: fact.id, kind: 'fact' })}
                      onRestore={() =>
                        mutate(
                          `/api/memory/facts/${fact.id}`,
                          { method: 'PATCH', body: JSON.stringify({ deleted: false }) },
                          'Fact restored.',
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* Events sit after the facts because they are the history rather than the
                standing state, and they are what a "when did that happen" question is
                asking for — which is why the date is the first thing on each row. */}
            <section className="section">
              <span className="eyebrow">
                What happened <span className="data">{events.length}</span>
              </span>
              <p className="form-hint" style={{ marginTop: 0 }}>
                Things that happened at a moment, with the date they happened. Facts stay
                true; events only happen once, so they are never superseded.
              </p>

              {events.length === 0 ? (
                <div className="empty">
                  Nothing dated has happened yet.
                  <br />
                  Events are recorded with the date the scene was at, so a question like
                  "when did we first meet" has an answer. Set an opening date when you start
                  a scene so the first one is anchored.
                </div>
              ) : (
                <ul className="panel">
                  {events.map((event, index) => (
                    <FactRow
                      key={event.id}
                      fact={event}
                      bordered={index > 0}
                      onSave={(text) =>
                        mutate(
                          `/api/memory/facts/${event.id}`,
                          { method: 'PATCH', body: JSON.stringify({ text }) },
                          'Event saved.',
                        )
                      }
                      onSetDate={(at) =>
                        mutate(
                          `/api/memory/facts/${event.id}`,
                          { method: 'PATCH', body: JSON.stringify({ at }) },
                          at ? 'Date saved.' : 'Date cleared.',
                        )
                      }
                      onDelete={() => setConfirming({ id: event.id, kind: 'event' })}
                      onRestore={() =>
                        mutate(
                          `/api/memory/facts/${event.id}`,
                          { method: 'PATCH', body: JSON.stringify({ deleted: false }) },
                          'Event restored.',
                        )
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
                    mutate(
                      `/api/memory/summaries/${entryId}`,
                      {
                        method: 'PATCH',
                        body: JSON.stringify({ content }),
                      },
                      'Arc saved.',
                    )
                  }
                  onDelete={(entryId) =>
                    setConfirming({ id: entryId, kind: 'summary', tier: 'arc' })
                  }
                  onRestore={(entryId) =>
                    mutate(
                      `/api/memory/summaries/${entryId}`,
                      { method: 'PATCH', body: JSON.stringify({ deleted: false }) },
                      'Arc restored.',
                    )
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
                    mutate(
                      `/api/memory/summaries/${entryId}`,
                      {
                        method: 'PATCH',
                        body: JSON.stringify({ content }),
                      },
                      'Scene summary saved.',
                    )
                  }
                  onDelete={(entryId) =>
                    setConfirming({ id: entryId, kind: 'summary', tier: 'scene' })
                  }
                  onRestore={(entryId) =>
                    mutate(
                      `/api/memory/summaries/${entryId}`,
                      { method: 'PATCH', body: JSON.stringify({ deleted: false }) },
                      'Scene summary restored.',
                    )
                  }
                />
              )}

              {/* One quiet line. The extraction job's state is otherwise invisible: a chat
                  whose summaries are queued or repeatedly failing looks identical to one
                  with nothing to remember. */}
              {jobLine && <p className="form-hint">{jobLine}</p>}
            </section>

            <section className="section">
              <span className="eyebrow">
                Recall <span className="data">{data.recalled.length}</span>
              </span>
              <p className="form-hint" style={{ marginTop: 0 }}>
                What the narrator was given from earlier in this scene when you last spoke
                {data.query.length > 0 ? <> — searched for <em>{data.query.slice(0, 80)}</em></> : null}.
                This is the block that goes into the prompt tail, so it never costs a cache miss.
              </p>
              {data.recalled.length === 0 ? (
                <div className="empty">Nothing was recalled for the last message.</div>
              ) : (
                <ul className="panel">
                  {data.recalled.map((hit, index) => (
                    <li
                      key={`${hit.kind}:${hit.refId}`}
                      className="panel-pad"
                      style={{ borderTop: index > 0 ? '1px solid var(--line)' : undefined }}
                    >
                      <span className="tag accent">{hit.kind}</span>{' '}
                      {/* The date the block renders, in the same bracket form. The panel's
                          whole purpose is to show what the narrator was given, and a row
                          that omitted the date while the prompt carried it would be the
                          panel disagreeing with the prompt about the same hit. */}
                      {hit.at && <span className="data">[{hit.at}] </span>}
                      <span style={{ color: 'var(--ink-dim)', fontSize: 'var(--text-sm)' }}>{hit.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              <details className="md-details" style={{ marginTop: 12 }}>
                <summary className="md-summary">The block as the model receives it</summary>
                <div className="md-details-body">
                  <pre className="data" style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>
                    {data.rendered || '(nothing — the block is omitted entirely when empty)'}
                  </pre>
                </div>
              </details>
            </section>
          </>
        )}

      {confirming && (
        <ConfirmPrompt
          title={
            confirming.kind === 'fact'
              ? 'Delete this fact'
              : confirming.kind === 'event'
                ? 'Delete this event'
                : confirming.tier === 'arc'
                  ? 'Delete this arc'
                  : 'Delete this summary'
          }
          message={
            confirming.kind === 'fact'
              ? 'Delete this fact? It stops being recalled, and you can restore it here.'
              : confirming.kind === 'event'
                ? 'Delete this event? It stops being recalled, and you can restore it here.'
                : 'Delete this summary? It stops being used, and you can restore it here. The messages it covers stay in the transcript either way.'
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const target = confirming;
            setConfirming(null);
            if (target.kind === 'fact') {
              void mutate(`/api/memory/facts/${target.id}`, { method: 'DELETE' }, 'Fact deleted.');
            } else if (target.kind === 'event') {
              void mutate(`/api/memory/facts/${target.id}`, { method: 'DELETE' }, 'Event deleted.');
            } else if (target.tier === 'arc') {
              void mutate(
                `/api/memory/summaries/${target.id}`,
                { method: 'DELETE' },
                'Arc deleted.',
              );
            } else {
              void mutate(
                `/api/memory/summaries/${target.id}`,
                { method: 'DELETE' },
                'Scene summary deleted.',
              );
            }
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );

  if (embedded) return body;

  return (
    <>
      <AppBar
        lead={<BackLink to={`/chat/${encodeURIComponent(id)}`} label="chat" />}
        title={<span className="bar-title">Memory</span>}
      />
      <main className="sheet">{body}</main>
    </>
  );
}

/** The actions a row's text sits under. Wraps rather than squeezing the text column. */
function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2" style={{ marginTop: 10 }}>{children}</div>;
}

/** One line of provenance: who a fact is about, and what happened to it. */
function Provenance({ children }: { children: React.ReactNode }) {
  return (
    <p className="data" style={{ margin: '6px 0 0' }}>
      {children}
    </p>
  );
}

function FactRow({
  fact,
  bordered,
  onSave,
  onSetDate,
  onTogglePin,
  onToggleStatus,
  onDelete,
  onRestore,
}: {
  fact: FactEntry;
  bordered: boolean;
  onSave: (text: string) => void;
  /** Events and facts both take a date; facts are superseded, events are not. */
  onSetDate?: (at: string | null) => void;
  onTogglePin?: () => void;
  onToggleStatus?: () => void;
  onDelete: () => void;
  /** Undoes a delete. Present because DELETE is a tombstone, not a removal. */
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const [editingDate, setEditingDate] = useState(false);
  const [dateDraft, setDateDraft] = useState(fact.at ?? '');
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(false);
  const superseded = fact.status === 'superseded';
  const pinned = fact.pinned === 1;
  const isEvent = fact.kind === 'event';
  const removed = fact.deleted === 1;

  // Focus goes back to the control that opened the box. The button unmounts while the
  // textarea is up, so this cannot be done from the click handler — the node does not
  // exist yet at that point.
  useEffect(() => {
    if (wasEditing.current && !editing) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  return (
    <li
      className={`p-4 ${bordered ? 'border-t border-line' : ''}${superseded || removed ? ' is-superseded' : ''}`}
    >
      {editing ? (
        <div className="space-y-3">
          {/* Labelled and focused on open: this box had neither, so a screen reader
              announced an unnamed textarea and the keyboard stayed on BODY. */}
          <textarea
            className="field"
            rows={3}
            value={draft}
            aria-label={`Edit ${isEvent ? 'event' : 'fact'}`}
            autoFocus
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
          {(pinned || superseded || removed) && (
            <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 8 }}>
              {pinned && (
                <span className="tag accent" title="Recalled into every prompt">
                  pinned
                </span>
              )}
              {superseded && <span className="tag">superseded</span>}
              {removed && (
                <span className="tag" title="Not recalled until restored">
                  removed
                </span>
              )}
            </div>
          )}

          {/* The date leads, because it is the thing a question about memory is usually
              asking for. An event with no date says so plainly rather than showing a blank
              where a date should be — that is the field the reader most often needs to fix,
              and it is the one an extraction pass cannot always fill. */}
          {editingDate ? (
            <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 8 }}>
              <input
                className="field"
                style={{ flex: 1, minWidth: 180 }}
                value={dateDraft}
                aria-label={isEvent ? 'When this happened' : 'When this became true'}
                placeholder="Wednesday, 14 April 2026"
                onChange={(event) => setDateDraft(event.target.value)}
              />
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  onSetDate?.(dateDraft.trim().length > 0 ? dateDraft.trim() : null);
                  setEditingDate(false);
                }}
              >
                Save
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDateDraft(fact.at ?? '');
                  setEditingDate(false);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <p style={{ margin: '0 0 6px' }}>
              <button
                type="button"
                className="btn quiet data"
                title={isEvent ? 'Change when this happened' : 'Change when this became true'}
                onClick={() => setEditingDate(true)}
              >
                {fact.at ? `[${fact.at}]` : isEvent ? 'no date — add one' : 'no date'}
              </button>
            </p>
          )}

          <p className="prose whitespace-pre-wrap" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
            {fact.text}
          </p>

          <Provenance>
            {fact.subject ?? 'no subject'} · {fact.status}
            {fact.superseded_by && ` by ${fact.superseded_by.slice(0, 8)}`}
          </Provenance>

          <RowActions>
            <button
              type="button"
              className="btn quiet"
              ref={editButtonRef}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            {/* Events are never superseded: a thing that happened cannot become false. */}
            {!isEvent && (
              <>
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
              </>
            )}
            {removed ? (
              <button type="button" className="btn quiet" onClick={onRestore}>
                Restore
              </button>
            ) : (
              <button type="button" className="btn quiet danger" onClick={onDelete}>
                Delete
              </button>
            )}
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
  onRestore,
}: {
  entries: SummaryEntry[];
  onSave: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
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
          onRestore={() => onRestore(entry.id)}
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
  onRestore,
}: {
  entry: SummaryEntry;
  bordered: boolean;
  onSave: (content: string) => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  const removed = entry.deleted === 1;

  return (
    <li
      className={`p-4 ${bordered ? 'border-t border-line' : ''}${removed ? ' is-superseded' : ''}`}
    >
      {editing ? (
        <div className="space-y-3">
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
          {/* The in-world span leads, for the same reason it does on a fact: it is what a
              question about memory is asking for, and it is the part that survives the arc
              fold where the seq range does not. */}
          {entry.covers_date_from && (
            <p className="data" style={{ margin: '0 0 6px' }}>
              [{summaryDateSpan(entry.covers_date_from, entry.covers_date_to)}]
            </p>
          )}

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
            {removed ? (
              <button type="button" className="btn quiet" onClick={onRestore}>
                Restore
              </button>
            ) : (
              <button type="button" className="btn quiet danger" onClick={onDelete}>
                Delete
              </button>
            )}
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
}: {
  chatId: string;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState('');
  // Owned here rather than by the parent: the message is about this field, so it renders
  // under it. At the top of the FACTS section it sat 125px from the input it described, and
  // it outlived the failure — a later successful add left the old error on screen.
  const [failure, setFailure] = useState<string | null>(null);

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
      setFailure(null);
      onCreated();
    } catch (cause) {
      setFailure(messageOf(cause));
    }
  }

  return (
    <form onSubmit={submit} style={{ marginBottom: 14 }}>
      <div className="flex gap-2" style={{ alignItems: 'center' }}>
        <input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (failure) setFailure(null);
          }}
          placeholder="Add a fact this chat should always know"
          className="field"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="submit" className="btn primary" disabled={draft.trim().length === 0}>
          Add
        </button>
      </div>
      {failure && (
        <p className="form-hint" style={{ marginTop: 6, color: 'var(--danger)' }}>
          {failure}
        </p>
      )}
    </form>
  );
}

/**
 * The memory box: the alternative to the whole engine.
 *
 * A reader who does not want extracted facts, summaries and recall can switch this chat to
 * a single block of their own text. It is sent verbatim in the prompt tail, so it is the
 * whole memory — not a supplement to a machine record they cannot see.
 *
 * The switch applies immediately (it is a choice about how the chat works, not a form
 * field), and the box saves explicitly: text typed into a memory is worth more than a
 * keystroke-level autosave. The helper buttons propose a rewrite; they never apply one.
 */
function MemoryModeSection({ chatId }: { chatId: string }) {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<{ setup: SceneSetup }>(`/api/chats/${encodeURIComponent(chatId)}/scene`),
    [chatId],
  );
  const [mode, setMode] = useState<SceneSetup['memoryMode']>('auto');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [assisting, setAssisting] = useState<'tidy' | 'compact' | 'expand' | null>(null);
  const toast = useToast();

  // Seed from the stored setup once it arrives. Keyed on the object, not on each keystroke:
  // typing does not change `data`, so an edit in progress is never clobbered.
  useEffect(() => {
    if (!data) return;
    setMode(data.setup.memoryMode);
    setText(data.setup.memoryBox);
  }, [data]);

  async function patch(body: Record<string, unknown>, done: string): Promise<void> {
    setBusy(true);
    try {
      await apiJson(`/api/chats/${encodeURIComponent(chatId)}/scene`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      toast.success(done);
      reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function assist(action: 'tidy' | 'compact' | 'expand'): Promise<void> {
    setAssisting(action);
    try {
      const result = await apiJson<{ ok: boolean; text: string }>(
        `/api/chats/${encodeURIComponent(chatId)}/memory/assist`,
        { method: 'POST', body: JSON.stringify({ text, action }) },
      );
      // Into the box, not into the database: the reader reviews, then saves.
      setText(result.text);
      toast.success('Proposed — review it, then Save.');
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setAssisting(null);
    }
  }

  if (loading) return null;
  if (error) {
    return (
      <section className="section">
        <span className="eyebrow">Memory mode</span>
        <p className="note danger">{error}</p>
      </section>
    );
  }

  return (
    <section className="section">
      <span className="eyebrow">Memory mode</span>
      <div className="field-list two items-end">
        <label className="block" htmlFor="memory-mode">
          <span className="form-label">
            <span>How this chat remembers</span>
          </span>
          <select
            id="memory-mode"
            className="field"
            value={mode}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as SceneSetup['memoryMode'];
              setMode(next);
              void patch(
                { memoryMode: next },
                next === 'box'
                  ? 'Memory box on — the engine is paused for this chat.'
                  : 'Automatic memory on.',
              );
            }}
          >
            <option value="auto">Automatic — scene summaries and extracted facts</option>
            <option value="box">Memory box — my own notes, nothing else</option>
          </select>
        </label>
      </div>

      {mode === 'box' && (
        <>
          <label className="block" htmlFor="memory-box" style={{ marginTop: 14 }}>
            <span className="form-label">
              <span>Your notes</span>
              <span className="form-hint">
                Sent to the narrator word for word, in the prompt tail. Headings, bullets, a
                paragraph — anything you would say to a co-writer. Oldest lines are the first
                to be dropped if it outgrows the memory budget.
              </span>
            </span>
            <textarea
              id="memory-box"
              className="field"
              rows={10}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'Sydney is dying. She has not said it yet.\nHer mother does not know.'}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn primary"
              disabled={busy || assisting !== null}
              onClick={() => void patch({ memoryBox: text }, 'Memory notes saved.')}
            >
              {busy ? 'Saving…' : 'Save notes'}
            </button>
            {(['tidy', 'compact', 'expand'] as const).map((action) => (
              <button
                key={action}
                type="button"
                className="btn"
                disabled={busy || assisting !== null}
                title={
                  action === 'tidy'
                    ? 'Reorganise the same facts so they read at a glance.'
                    : action === 'compact'
                      ? 'Shorten without losing what still matters.'
                      : 'Add what the recent transcript establishes.'
                }
                onClick={() => void assist(action)}
              >
                {assisting === action
                  ? 'Working…'
                  : action === 'tidy'
                    ? 'Tidy'
                    : action === 'compact'
                      ? 'Compact'
                      : 'Add from the scene'}
              </button>
            ))}
          </div>
          <p className="form-hint" style={{ marginTop: 8 }}>
            The helpers propose a rewrite in the box; nothing is saved until you press Save.
          </p>
        </>
      )}
    </section>
  );
}

interface CompactOp {
  op: 'merge' | 'rewrite' | 'supersede';
  ids: string[];
  text: string;
  reason: string;
}

interface CompactProposal {
  ops: CompactOp[];
  examined: number;
  remaining: number;
}

/**
 * Fact cleanup, proposed by the cheap model and applied by the reader.
 *
 * The store grows because the extractor can only supersede what it is shown, and it is
 * shown sixty facts. This reads a batch of them, proposes merges and retirements, and
 * writes nothing until Apply — the same contract as every other destructive action here.
 *
 * One batch per press on purpose: every press is one model call, and the reader can see
 * what it costs (`remaining`) before spending another.
 */
function Compaction({
  chatId,
  facts,
  onApplied,
}: {
  chatId: string;
  facts: FactEntry[];
  onApplied: () => void;
}) {
  const [proposal, setProposal] = useState<CompactProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const byId = new Map(facts.map((fact) => [fact.id, fact.text]));

  async function propose(): Promise<void> {
    setBusy(true);
    try {
      const result = await apiJson<{ proposal: CompactProposal }>(
        `/api/chats/${encodeURIComponent(chatId)}/memory/compact`,
        { method: 'POST', body: '{}' },
      );
      setProposal(result.proposal);
      if (result.proposal.ops.length === 0) toast.success('Nothing to clean up in this batch.');
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!proposal) return;
    setBusy(true);
    try {
      const result = await apiJson<{ applied: number; skipped: number }>(
        `/api/chats/${encodeURIComponent(chatId)}/memory/compact/apply`,
        { method: 'POST', body: JSON.stringify({ ops: proposal.ops }) },
      );
      toast.success(
        result.skipped > 0
          ? `Applied ${result.applied}; ${result.skipped} skipped (the fact changed since it was read).`
          : `Applied ${result.applied} change${result.applied === 1 ? '' : 's'}.`,
      );
      setProposal(null);
      onApplied();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const label = (op: CompactOp): string =>
    op.op === 'merge'
      ? `Merge ${op.ids.length} facts`
      : op.op === 'rewrite'
        ? 'Rewrite'
        : 'Retire';

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 6 }}>
        <button
          type="button"
          className="btn"
          disabled={busy || facts.length === 0}
          onClick={() => void propose()}
        >
          {busy ? 'Reading…' : 'Compact'}
        </button>
        <span className="form-hint">
          Merges duplicates and retires facts the story has moved past. Proposes only —
          nothing changes until you apply it.
        </span>
      </div>

      {proposal && (
        <div className="panel panel-pad" style={{ marginTop: 12 }}>
          <span className="eyebrow">
            {proposal.ops.length === 0
              ? 'No changes proposed'
              : `${proposal.ops.length} change${proposal.ops.length === 1 ? '' : 's'} proposed`}
            <span className="form-hint"> · {proposal.examined} facts read</span>
          </span>

          {proposal.ops.map((op, index) => (
            <div key={index} className="consult-field">
              <span className="eyebrow consult-field-label">
                {label(op)}
                {op.reason.length > 0 && (
                  <span className="form-hint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    {' '}
                    — {op.reason}
                  </span>
                )}
              </span>
              {op.ids.map((id) => (
                <p key={id} className="consult-before">
                  {byId.get(id) ?? id}
                </p>
              ))}
              {op.text.length > 0 && <p className="consult-after">{op.text}</p>}
            </div>
          ))}

          {proposal.remaining > 0 && (
            <p className="form-hint" style={{ marginTop: 10 }}>
              {proposal.remaining} more facts were not read in this pass. Compact again after
              applying this set.
            </p>
          )}

          {proposal.ops.length > 0 && (
            <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                {busy ? 'Applying…' : 'Apply'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setProposal(null)}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
