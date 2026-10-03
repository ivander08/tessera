import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { streamConsult, type ConsultFrame } from '../lib/api';
import type { CharacterCardJson, GreetingState, ParsedCard } from '../lib/cards/types';
import { messageOf } from '../lib/hooks';
import { handleComposerEnter } from '../lib/composer';
import { estimateTokens } from '../lib/tokenEstimate';
import { diffText, summarizeDiff, type DiffLine } from '../lib/text/diff';
import { Markdown } from './Markdown';
import { useToast } from './Toast';

/** One turn of the conversation, as the client holds it. Mirrors `ConsultMessage`. */
export interface ConsultMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The parsed reply. Mirrors `ConsultTurn` in `worker/src/forge/consult.ts`. */
export interface ConsultTurn {
  say: string;
  question: {
    text: string;
    options: string[];
    recommended: number;
  } | null;
  card: ParsedCard | null;
}

/**
 * The part of the consultant's state that outlives the pane.
 *
 * Owned by the parent so closing the consultant and reopening it continues the conversation
 * instead of starting a new one — which is what closing a panel should mean. The transient
 * parts of the conversation deliberately do NOT live here: a stream in flight when the pane
 * closes is abandoned, and a failure message belongs to the turn that produced it.
 */
export interface ConsultSession {
  messages: ConsultMessage[];
  /** The question or proposed card awaiting an answer, if any. */
  turn: ConsultTurn | null;
  /** A half-typed answer, kept so closing mid-sentence does not lose it. */
  answer: string;
  /** The opening premise in draft mode, kept for the same reason. */
  brief: string;
}

/** A session with nothing in it, for a fresh consult. */
export function emptyConsultSession(): ConsultSession {
  return { messages: [], turn: null, answer: '', brief: '' };
}

/** The permanent fields, which is what the token summary is about. */
const PERMANENT: Array<keyof CharacterCardJson> = ['name', 'description', 'personality', 'scenario'];

/**
 * The card's text fields, in the order the editor presents them. `tags` and the greetings are
 * handled separately below because they are lists rather than a one-line diff.
 *
 * `name` and `nickname` are here because the consultant may rename a card — "call her Syd,
 * not Sydney" is a change a reader asks for — and a rename that is not shown in the diff is
 * the most alarming kind of silent edit.
 */
const TEXT_FIELDS: Array<{ key: keyof CharacterCardJson; label: string }> = [
  { key: 'name', label: 'name' },
  { key: 'nickname', label: 'shown name' },
  { key: 'description', label: 'description' },
  { key: 'personality', label: 'personality' },
  { key: 'scenario', label: 'scenario' },
  { key: 'systemPrompt', label: 'system_prompt' },
  { key: 'mesExample', label: 'mes_example' },
  { key: 'postHistoryInstructions', label: 'post_history_instructions' },
  { key: 'firstMes', label: 'first_mes' },
  { key: 'creatorNotes', label: 'creator_notes' },
];

/** The three fields of one opening's scene, as the editor labels them. */
const GREETING_STATE_FIELDS = ['time', 'location', 'weather'] as const;

/**
 * How the openings are named in a diff.
 *
 * The editor labels them "Opening 1", "Opening 2" — the first is `first_mes` and the rest are
 * alternates — so the diff uses the same words. `alternate_greetings[1]` is the wire name and
 * means nothing to a reader looking at a form that says "Opening 2".
 */
function openingLabel(index: number): string {
  return `Opening ${index + 1}`;
}

/** One changed field, with the diff that describes it. */
interface FieldChange {
  label: string;
  /** The text diff, when the field is prose. Absent for a list or a scene change. */
  diff?: ReturnType<typeof diffText>;
  /** A one-line before/after, for values too short to warrant a diff (tags, a scene field). */
  before?: string;
  after?: string;
  /** A list of before/after rows, for tags and greeting states. */
  rows?: Array<{ label: string; before: string; after: string }>;
  /** True when the whole value was added or removed rather than edited. */
  whole?: 'added' | 'removed';
}

/**
 * The consultant: an interview that ends in a card.
 *
 * One component serves both situations, because they are the same conversation with a
 * different starting point. In `draft` mode there is no card and the user's premise is the
 * first turn; in `consult` mode the card is supplied and the user asks about it.
 *
 * Rendered as a PANE, not a dialog. A modal covers the card the user is asking about, and
 * the whole point of consult mode is to look at a field and talk about it at the same time.
 * `ConsultPane` places it beside the form on a wide screen and as a sticky sheet below it on
 * a narrow one.
 *
 * The conversation lives in this component's state and nowhere else. It is a dozen turns of
 * short text, so resending it per turn is cheaper than a session store, and the consequence
 * — a reload loses the interview — matches how the rest of the screen behaves.
 */
export function ConsultPanel({
  mode,
  card,
  onApply,
  onDone,
  onClose,
  session,
  onSession,
  dragHandlers,
}: {
  mode: 'draft' | 'consult';
  /** The card being discussed. Consult mode only. */
  card?: CharacterCardJson | null;
  /** Consult mode: the user accepted a proposed card. */
  onApply?: (card: ParsedCard) => void;
  /** Draft mode: a card was drafted and the user asked to keep it. */
  onDone?: (card: ParsedCard) => void;
  /** Consult mode: dismiss the pane. Absent in draft mode, where it is the whole screen. */
  onClose?: () => void;
  /**
   * The conversation so far, owned by the parent so it survives this pane unmounting. The
   * component writes back through `onSession`, and reads it on mount — which is what makes
   * close-then-reopen continue the interview rather than restart it.
   */
  session: ConsultSession;
  onSession: (session: ConsultSession) => void;
  /**
   * Drag handlers for the header, supplied by `ConsultDock` when this panel floats. The header
   * is the grab bar, so the handlers belong here rather than on a second header rendered by
   * the dock — one header, one place it can drift.
   */
  dragHandlers?: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
}) {
  const { messages, turn, answer, brief } = session;
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Which part of the reply is being written.
   *
   * The prose arrives in a few seconds and the card in the same reply can take twenty more,
   * so without this the pane looks finished while it is still working — the reported bug
   * was "there's no indicator that the AI is currently cooking up the diff". `say` is
   * required to be the first key, so the appearance of `question` or `card` is exactly the
   * moment the prose stops and the part the user is waiting for starts.
   */
  const [phase, setPhase] = useState<'say' | 'question' | 'card'>('say');
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  /**
   * Writes the durable part back to the parent.
   *
   * Every call takes the whole session rather than a patch: the parent's copy is the only
   * copy, and a partial write would let a field set by one handler be clobbered by a stale
   * read in another. `pending` is deliberately not here — a stream in flight when the pane
   * closes is abandoned, and re-showing half a sentence on reopen would misrepresent it as a
   * finished reply.
   */
  const setSession = onSession;
  // The latest session, read by `patch`. The streaming callbacks below outlive the render
  // that started them, so reading the fields straight from the closure re-wrote a cleared
  // composer (and the premise box) with the text that had just been sent.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const patch = (next: Partial<ConsultSession>) => {
    const merged = { ...sessionRef.current, ...next };
    sessionRef.current = merged;
    setSession(merged);
  };

  const transcriptRef = useRef<HTMLDivElement | null>(null);

  /**
   * Pins the transcript to its foot.
   *
   * `scrollTop` is set to `scrollHeight` rather than calling `scrollIntoView` on a sentinel:
   * the sentinel scroll is animated and can land short when the content above it is still
   * settling (a long streamed reply, a card whose height changes as it renders), which is
   * the reported "it stops above the card". The assignment is instant and exact.
   *
   * Two frames are needed when the content just changed: the first fires before the new
   * layout is measurable, the second after it. Harmless when the first already landed.
   */
  function scrollToBottom() {
    const box = transcriptRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    requestAnimationFrame(() => {
      box.scrollTop = box.scrollHeight;
    });
  }

  // Follow the reply as it streams. The text is the progress indicator, so it must stay in
  // view without the user scrolling after it. `failure` is in the list for the same reason: a
  // card that failed to arrive renders its message at the foot of the transcript, and a
  // failure the reader has to scroll to find reads as "nothing happened".
  useEffect(() => {
    scrollToBottom();
  }, [pending, messages.length, turn, failure, busy]);

  async function send(content: string) {
    const text = content.trim();
    if (busy) return;

    // The user's turn is appended BEFORE the request so the transcript shows what was asked
    // while the answer streams, rather than after it.
    const next = [...messages, { role: 'user' as const, content: text }];
    patch({ messages: next, answer: '', turn: null });
    setPending('');
    setFailure(null);
    setPhase('say');
    setBusy(true);

    let streamed = '';
    // Whether a terminal frame arrived. Read in `finally` instead of the `pending` state,
    // which is captured stale by this closure — checking it there re-showed the streamed text
    // after the turn frame had already committed the same words to the transcript.
    let settled = false;

    try {
      await streamConsult(
        { mode, messages: next, card: card ?? undefined },
        (frame: ConsultFrame) => {
          if (frame.type === 'delta') {
            streamed = frame.text;
            setPending(frame.text);
            return;
          }
          if (frame.type === 'phase') {
            setPhase(frame.phase);
            return;
          }
          if (frame.type === 'error') {
            settled = true;
            setFailure(frame.message);
            return;
          }
          const parsed = frame.turn as ConsultTurn;
          settled = true;
          patch({ messages: [...next, { role: 'assistant', content: parsed.say }], turn: parsed });
          setPending('');
        },
      );
    } catch (cause) {
      settled = true;
      setFailure(messageOf(cause));
    } finally {
      // A stream that ended without a terminal frame still showed the user something; the
      // partial text stays on screen rather than vanishing, which is what makes the failure
      // readable.
      if (!settled && streamed.length > 0) setPending(streamed);
      setBusy(false);
    }
  }

  async function save(card: ParsedCard) {
    if (!onDone) return;
    setSaving(true);
    try {
      await onDone(card);
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  const proposed = turn?.card ?? null;
  const canType = !busy && (messages.length > 0 || mode === 'consult');

  return (
    <section className="consult-pane">
      <header className="consult-pane-head" {...dragHandlers}>
        <span className="eyebrow">
          {mode === 'draft' ? 'New character' : 'Consulting this card'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {mode === 'consult' && (
            <span className="form-hint">changes apply to the form, not saved</span>
          )}
          {onClose && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Close the consultant"
              title="Close the consultant"
              onClick={onClose}
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </span>
      </header>

      <div className="consult-transcript" ref={transcriptRef}>
        {mode === 'draft' && messages.length === 0 && (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="form-label">
                <span>What are you making?</span>
              </span>
              <span className="form-hint" style={{ display: 'block', marginBottom: 5 }}>
                One line is enough — the consultant asks the rest, one question at a time.
              </span>
              <textarea
                className="field"
                rows={2}
                value={brief}
                onChange={(event) => patch({ brief: event.target.value })}
                placeholder="A retired cartographer who refuses to admit the maps are wrong."
              />
            </label>
            <button
              type="button"
              className="btn primary min-h-10"
              onClick={() => void send(brief)}
              disabled={busy}
            >
              {busy ? 'Starting…' : 'Start the interview'}
            </button>
            <p className="form-hint" style={{ margin: 0 }}>
              Or send it empty and let the consultant ask first.
            </p>
          </div>
        )}

        {messages.map((message, index) =>
          message.role === 'user' ? (
            <p key={index} className="consult-asked">
              {message.content}
            </p>
          ) : (
            <div key={index} className="prose">
              <Markdown content={message.content} />
            </div>
          ),
        )}

        {pending.length > 0 && (
          <div className="prose">
            <Markdown content={pending} />
            <span className="caret" aria-hidden="true" />
          </div>
        )}

        {/* The prose is done and the card is still being written. Without this the pane
            looks finished the moment `say` stops streaming, while the model is still
            composing the part the user is actually waiting for. */}
        {busy && pending.length > 0 && phase !== 'say' && (
          <p className="consult-working" role="status">
            <span className="thinking" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {phase === 'card' ? 'Writing the card…' : 'Writing the question…'}
          </p>
        )}

        {/* Before the first token there is nothing to read, so the wait itself is drawn —
            the same three rising dots the chat uses, so a wait reads the same everywhere. */}
        {busy && pending.length === 0 && (
          <span className="thinking" aria-label="The consultant is writing">
            <i />
            <i />
            <i />
          </span>
        )}

        {turn?.question && !busy && (
          <div className="panel panel-pad">
            <p className="consult-question">
              <span className="consult-question-label">{turn.question.text}</span>
            </p>
            <div className="consult-options">
              {turn.question.options.map((option, index) => {
                const recommended = index === turn.question?.recommended;
                return (
                  <button
                    key={index}
                    type="button"
                    className={`btn consult-option${recommended ? ' primary' : ''}`}
                    onClick={() => void send(option)}
                  >
                    <span>{option}</span>
                    {recommended && <span className="consult-badge">best</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {failure && <div className="note danger">{failure}</div>}

        {proposed && (
          <ProposedCard
            card={proposed}
            current={card ?? null}
            mode={mode}
            busy={saving}
            onApply={() => {
              if (mode === 'draft') {
                void save(proposed);
                return;
              }
              onApply?.(proposed);
              // The proposed card is spent once applied; the transcript stays, so the user
              // can keep asking about the card they just changed.
              patch({ turn: null });
              toast.success('Applied to the form — nothing is saved until you press Save.');
            }}
          />
        )}

        <div ref={bottomRef} />
      </div>

      {/* Every question is answerable in the user's own words. The options are a shortcut,
          so the box is present whenever there is anything to answer — and in consult mode it
          is also the only way in, since there is no premise box to open with. */}
      {canType && (
        <div className="consult-compose">
          {/* A textarea, not an `input`: a premise, a pasted character description or a
              long answer is routinely several lines, and an `input` cannot hold a newline
              at all. `rows={1}` keeps the one-line look until the text wraps. */}
          <textarea
            className="field"
            rows={1}
            value={answer}
            onChange={(event) => patch({ answer: event.target.value })}
            onKeyDown={(event) => {
              // Enter sends on a keyboard; on a phone it makes a newline and the Send button
              // sends, because a soft keyboard has no Shift. See `handleComposerEnter`.
              handleComposerEnter(event, () => {
                if (answer.trim().length === 0) return;
                void send(answer);
              });
            }}
            placeholder={
              turn?.question
                ? 'Or answer in your own words…'
                : mode === 'consult'
                  ? 'Ask about the card…'
                  : 'Say anything else…'
            }
          />
          <button
            type="button"
            className="btn primary"
            onClick={() => void send(answer)}
            disabled={answer.trim().length === 0}
          >
            Send
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Builds the list of changes between the card in the form and the card proposed.
 *
 * The diff is the interesting part in consult mode: a wall of text the user has already read
 * tells them nothing about what changed, and "apply" is a decision about the change. Every
 * text field is diffed; the lists and the opening scenes get a before/after row each, because
 * a one-line change to a time does not need a paragraph of context around it.
 */
function collectChanges(current: CharacterCardJson, proposed: ParsedCard): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of TEXT_FIELDS) {
    const before = String(current[field.key] ?? '');
    const after = String(proposed[field.key] ?? '');
    if (before === after) continue;
    const diff = diffText(before, after);
    if (diff.hunks.length === 0) continue;
    changes.push({ label: field.label, diff });
  }

  const beforeTags = current.tags.join(', ');
  const afterTags = proposed.tags.join(', ');
  if (beforeTags !== afterTags) {
    changes.push({ label: 'tags', before: beforeTags, after: afterTags });
  }

  // Each opening is diffed on its own, so "change the time of the second alternate" shows up
  // as a change to that opening rather than as an edit somewhere in a joined blob.
  const beforeOpenings = [current.firstMes ?? '', ...current.alternateGreetings];
  const afterOpenings = [proposed.firstMes, ...proposed.alternateGreetings];
  for (let index = 0; index < Math.max(beforeOpenings.length, afterOpenings.length); index++) {
    const before = beforeOpenings[index] ?? '';
    const after = afterOpenings[index] ?? '';
    if (before === after) continue;
    const diff = diffText(before, after);
    if (diff.hunks.length === 0) continue;
    changes.push({ label: openingLabel(index), diff });
  }

  // The scene each opening starts in. Reported per field, because the reader asked for a
  // time and a paragraph of diff around one word would bury it.
  const beforeStates: GreetingState[] = current.greetingStates ?? [];
  const afterStates: GreetingState[] = proposed.greetingStates ?? [];
  for (let index = 0; index < Math.max(beforeStates.length, afterStates.length); index++) {
    const before = beforeStates[index] ?? {};
    const after = afterStates[index] ?? {};
    const rows = GREETING_STATE_FIELDS.filter((key) => (before[key] ?? '') !== (after[key] ?? '')).map(
      (key) => ({ label: key, before: before[key] ?? '', after: after[key] ?? '' }),
    );
    if (rows.length === 0) continue;
    changes.push({ label: `${openingLabel(index)} · scene`, rows });
  }

  return changes;
}

/** One changed line, with the changed columns highlighted. */
function DiffLineRow({ line }: { line: DiffLine }) {
  const mark = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';

  // An edited line is drawn once, with the changed span marked. Splitting it into
  // before/after halves would double the height of the diff and lose the reading position.
  if (line.span && line.replaced !== undefined) {
    const { span } = line;
    return (
      <div className="diff-line diff-line-edited">
        <span className="diff-gutter">{line.afterLine ?? ''}</span>
        <span className="diff-mark">{mark}</span>
        <span className="diff-text">
          {line.text.slice(0, span.afterStart)}
          <mark className="diff-change">{line.text.slice(span.afterStart, span.afterEnd)}</mark>
          {line.text.slice(span.afterEnd)}
        </span>
      </div>
    );
  }

  return (
    <div className={`diff-line diff-line-${line.kind}`}>
      <span className="diff-gutter">{line.afterLine ?? line.beforeLine ?? ''}</span>
      <span className="diff-mark">{mark}</span>
      <span className="diff-text">{line.text.length > 0 ? line.text : '\u00a0'}</span>
    </div>
  );
}

/** One field's change: a header, then either a diff or a pair of before/after rows. */
function ChangeBlock({ change }: { change: FieldChange }) {
  const diff = change.diff;
  const stat = diff ? summarizeDiff(diff) : '';

  return (
    <div className="consult-field">
      <span className="eyebrow consult-field-label">
        {change.label}
        {stat && <span className="diff-stat">{stat}</span>}
      </span>

      {diff &&
        diff.hunks.map((hunk, hunkIndex) => (
          <div key={hunkIndex} className="diff">
            {hunk.lines.map((line, lineIndex) => (
              <DiffLineRow key={lineIndex} line={line} />
            ))}
          </div>
        ))}

      {change.rows?.map((row) => (
        <div key={row.label} className="diff-pair">
          <span className="diff-pair-label">{row.label}</span>
          <p className="consult-before">{row.before.length > 0 ? row.before : '— empty —'}</p>
          <p className="consult-after">{row.after.length > 0 ? row.after : '— empty —'}</p>
        </div>
      ))}

      {change.before !== undefined && change.after !== undefined && (
        <div className="diff-pair">
          <p className="consult-before">{change.before.length > 0 ? change.before : '— empty —'}</p>
          <p className="consult-after">{change.after.length > 0 ? change.after : '— empty —'}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The card the consultant wants to write.
 *
 * In consult mode the interesting part is the DIFF: a wall of text the user has already read
 * tells them nothing about what changed, and "apply" is a decision about the change. In draft
 * mode there is nothing to compare against, so the fields are listed.
 */
function ProposedCard({
  card,
  current,
  mode,
  busy,
  onApply,
}: {
  card: ParsedCard;
  current: CharacterCardJson | null;
  mode: 'draft' | 'consult';
  busy: boolean;
  onApply: () => void;
}) {
  const permanent = PERMANENT.reduce((sum, field) => sum + estimateTokens(String(card[field] ?? '')), 0);
  const changes = current ? collectChanges(current, card) : [];

  return (
    <div className="panel panel-pad">
      <span className="eyebrow" style={{ display: 'block' }}>
        {mode === 'draft' ? 'Proposed card' : 'Proposed revision'}
      </span>
      <p style={{ margin: '8px 0 12px', fontSize: 'var(--text-sm)' }}>
        <span className="data" style={{ color: 'var(--brass)' }}>
          {permanent}
        </span>{' '}
        permanent tokens — paid on every turn, forever.
      </p>

      {current && changes.length === 0 && (
        <p className="form-hint" style={{ margin: 0 }}>
          Nothing differs from the card in the form.
        </p>
      )}

      {current && changes.map((change) => <ChangeBlock key={change.label} change={change} />)}

      {!current && (
        <>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            <span className="eyebrow consult-field-label">name</span>
            {card.name}
          </p>
          {TEXT_FIELDS.map((field) => {
            const text = String(card[field.key] ?? '');
            if (text.length === 0) return null;
            return (
              <div key={String(field.key)} className="consult-field">
                <span className="eyebrow consult-field-label">{field.label}</span>
                <p style={{ margin: 0, fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap' }}>{text}</p>
              </div>
            );
          })}
          {card.tags.length > 0 && (
            <p className="form-hint" style={{ marginTop: 10 }}>
              tags · {card.tags.join(', ')}
            </p>
          )}
        </>
      )}

      <button
        type="button"
        className="btn primary min-h-10"
        style={{ marginTop: 12 }}
        onClick={onApply}
        disabled={busy}
      >
        {mode === 'draft' ? (busy ? 'Saving…' : 'Save and edit') : 'Apply'}
      </button>
    </div>
  );
}
