import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { streamChatConsult, type ConsultPhase } from '../lib/api';
import { messageOf } from '../lib/hooks';
import { handleComposerEnter } from '../lib/composer';
import { Markdown } from './Markdown';

/** One turn of the conversation, as the client holds it. Mirrors `ChatConsultMessage`. */
export interface ChatConsultMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The parsed reply. Mirrors `ChatConsultTurn` in `worker/src/chatConsult.ts`. */
export interface ChatConsultTurn {
  say: string;
  question: {
    text: string;
    options: string[];
    recommended: number;
  } | null;
}

/**
 * The part of the chat consultant's state that outlives the dock.
 *
 * Owned by the chat screen so closing the dock and reopening it continues the conversation
 * instead of starting a new one — which is what closing a panel should mean. The transient
 * parts deliberately do NOT live here: a stream in flight when the dock closes is abandoned,
 * and a failure belongs to the turn that produced it.
 */
export interface ChatConsultSession {
  messages: ChatConsultMessage[];
  /** The suggestions from the last reply, if it offered any. */
  question: ChatConsultTurn['question'];
  /** A half-typed question, kept so closing mid-sentence does not lose it. */
  answer: string;
}

/** A session with nothing in it, for a fresh chat. */
export function emptyChatConsultSession(): ChatConsultSession {
  return { messages: [], question: null, answer: '' };
}

/**
 * The consultant, as a floating dock over the chat.
 *
 * Modelled on `ConsultPanel` — the same classes, the same streaming and transcript handling,
 * so the two behave identically — but it is deliberately NOT a variant of it. `ConsultPanel`
 * is built around `mode: 'draft' | 'consult'`, a character prop, and a whole diff/apply tail;
 * none of that exists here, and extracting a shared core would mean parameterising every
 * one of those seams.
 *
 * The one thing it adds is `onUse`: a suggestion — the advice itself, or one of the
 * numbered options — can be dropped into the chat composer, left there to be edited, and
 * sent by the reader when they are ready. The dock stays open, so a second suggestion can
 * replace the first.
 */
export function ChatConsultPanel({
  chatId,
  session,
  onSession,
  onUse,
  onClose,
  dragHandlers,
}: {
  chatId: string;
  session: ChatConsultSession;
  onSession: (session: ChatConsultSession) => void;
  /** Puts text in the chat composer. Never sends it. */
  onUse: (text: string) => void;
  onClose: () => void;
  /**
   * Drag handlers for the header, supplied by `ConsultDock`. The header is the grab bar, so
   * the handlers belong here rather than on a second header rendered by the dock — one
   * header, one place it can drift.
   */
  dragHandlers?: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
}) {
  const { messages, question, answer } = session;
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Which part of the reply is being written. Only `say` and `question` are reachable here:
   * this consultant answers about the scene and never edits anything, and the prompt says so.
   * The type is the wire's own union rather than a narrowed copy of it.
   */
  const [phase, setPhase] = useState<ConsultPhase>('say');
  const [failure, setFailure] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  /**
   * Writes the durable part back to the parent.
   *
   * Every call takes the whole session rather than a patch: the parent's copy is the only
   * copy, and a partial write would let a field set by one handler be clobbered by a stale
   * read in another. `pending` is not here — a stream in flight when the dock closes is
   * abandoned, and re-showing half a sentence on reopen would present it as a finished reply.
   */
  const setSession = onSession;
  // The latest session, read by `patch`. The streaming callbacks below outlive the render
  // that started them, so reading the fields straight from the closure re-wrote a cleared
  // composer with the text that had just been sent.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const patch = (next: Partial<ChatConsultSession>) => {
    const merged = { ...sessionRef.current, ...next };
    sessionRef.current = merged;
    setSession(merged);
  };

  /**
   * Pins the transcript to its foot.
   *
   * `scrollTop` is assigned rather than `scrollIntoView`-ed on a sentinel: the sentinel
   * scroll is animated and can land short when the content above it is still settling, which
   * leaves the newest line above the fold. The assignment is instant and exact. Two frames
   * are needed when the content just changed — the first fires before the new layout is
   * measurable, the second after it. Harmless when the first already landed.
   */
  function scrollToBottom() {
    const box = transcriptRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    requestAnimationFrame(() => {
      box.scrollTop = box.scrollHeight;
    });
  }

  // The text is the progress indicator, so it must stay in view without the reader scrolling
  // after it. `failure` is in the list for the same reason: a failure below the fold reads
  // as "nothing happened".
  useEffect(() => {
    scrollToBottom();
  }, [pending, messages.length, failure, busy]);

  async function send(content: string) {
    const text = content.trim();
    if (busy || text.length === 0) return;

    // The reader's turn is appended BEFORE the request so the transcript shows what was
    // asked while the answer streams, rather than after it.
    const next = [...messages, { role: 'user' as const, content: text }];
    patch({ messages: next, answer: '', question: null });
    setPending('');
    setFailure(null);
    setPhase('say');
    setBusy(true);

    let streamed = '';
    // Whether a terminal frame arrived. Read in `finally` instead of the `pending` state,
    // which this closure captures stale — checking it there re-showed the streamed text after
    // the turn frame had already committed the same words to the transcript.
    let settled = false;

    try {
      await streamChatConsult<ChatConsultTurn>(chatId, { messages: next }, (frame) => {
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
        const parsed = frame.turn;
        settled = true;
        patch({
          messages: [...next, { role: 'assistant', content: parsed.say }],
          question: parsed.question ?? null,
        });
        setPending('');
      });
    } catch (cause) {
      settled = true;
      setFailure(messageOf(cause));
    } finally {
      // A stream that ended without a terminal frame still showed the reader something; the
      // partial text stays on screen rather than vanishing, which is what makes the failure
      // readable.
      if (!settled && streamed.length > 0) setPending(streamed);
      setBusy(false);
    }
  }

  return (
    <section className="consult-pane">
      <header className="consult-pane-head" {...dragHandlers}>
        <span className="eyebrow">Ask about this scene</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
        </span>
      </header>

      <div className="consult-transcript" ref={transcriptRef}>
        {/* Nothing has been asked yet. One line saying what this is for, and no other chrome:
            the composer below is the only thing there is to do. */}
        {messages.length === 0 && !busy && (
          <p className="form-hint" style={{ margin: 0 }}>
            Ask what to do next, or how to raise the stakes.
          </p>
        )}

        {messages.map((message, index) =>
          message.role === 'user' ? (
            <p key={index} className="consult-asked">
              {message.content}
            </p>
          ) : (
            <div key={index} className="consult-answer">
              <div className="prose">
                <Markdown content={message.content} />
              </div>
              {/* The advice, usable as written. It is a whole reply rather than a line, so it
                  lands in the composer to be edited down before it is sent. */}
              <button
                type="button"
                className="btn quiet consult-use"
                onClick={() => onUse(message.content)}
              >
                Use this
              </button>
            </div>
          ),
        )}

        {pending.length > 0 && (
          <div className="prose">
            <Markdown content={pending} />
            <span className="caret" aria-hidden="true" />
          </div>
        )}

        {/* The prose is done and the question is still being written. Without this the dock
            looks finished the moment `say` stops streaming. */}
        {busy && pending.length > 0 && phase !== 'say' && (
          <p className="consult-working" role="status">
            <span className="thinking" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Writing the question…
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

        {question && !busy && (
          <div className="panel panel-pad">
            {question.text.length > 0 && (
              <p className="consult-question">
                <span className="consult-question-label">{question.text}</span>
              </p>
            )}
            <div className="consult-options">
              {question.options.map((option, index) => {
                const recommended = index === question.recommended;
                return (
                  <div key={index} className="consult-suggestion">
                    <span className="consult-suggestion-text">{option}</span>
                    {/* The suggestion itself is text, not a button: pressing it does not
                        answer the question, it puts the words in the composer. Answering is
                        what the composer below is for. */}
                    <span className="consult-suggestion-actions">
                      {recommended && <span className="consult-badge">best</span>}
                      <button
                        type="button"
                        className="btn quiet consult-use"
                        onClick={() => onUse(option)}
                      >
                        Use
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {failure && <div className="note danger">{failure}</div>}

        <div ref={bottomRef} />
      </div>

      <div className="consult-compose">
        {/* A textarea, not an `input`: a question about the scene is routinely several lines,
            and an `input` cannot hold a newline at all. `rows={1}` keeps the one-line look
            until the text wraps. */}
        <textarea
          className="field"
          rows={1}
          value={answer}
          onChange={(event) => patch({ answer: event.target.value })}
          onKeyDown={(event) => {
            // Enter sends on a keyboard; on a phone it makes a newline and the Send button
            // sends, because a soft keyboard has no Shift. See `handleComposerEnter`.
            handleComposerEnter(event, () => void send(answer));
          }}
          placeholder="Ask about this scene…"
        />
        <button
          type="button"
          className="btn primary"
          onClick={() => void send(answer)}
          disabled={busy || answer.trim().length === 0}
        >
          Ask
        </button>
      </div>
    </section>
  );
}
