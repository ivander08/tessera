import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { apiJson, streamChat, type TurnMode } from '../lib/api';
import type { ChatCharacter, ChatDetail, ChatPersona, MessageRow } from '../lib/apiTypes';
import type { WorldState } from '../lib/state/schema';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar, BackLink, MenuAction, MenuLabel, MenuSep } from '../components/AppBar';
import { PresetMenu } from '../components/PresetMenu';
import { PersonaMenu } from '../components/PersonaMenu';
import { Turn, type TurnView } from '../components/Turn';
import { MessageActions } from '../components/MessageActions';
import { Modal } from '../components/Modal';
import { SceneBar } from '../components/SceneBar';
import { AppearancePanel } from '../components/AppearancePanel';
import StatePanel from './State';
import MemoryPanel from './Memory';

function MemoryGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.6H4z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.6H20z" />
    </svg>
  );
}

interface History {
  chat: ChatDetail;
  character: ChatCharacter | null;
  persona: ChatPersona | null;
  messages: MessageRow[];
}

interface Pending {
  mode: TurnMode;
  text: string;
  targetId: string | null;
  /** The user's own text, shown immediately for `send` rather than after the round trip. */
  sent?: string;
  /**
   * The stream is over but the refetch has not landed.
   *
   * Clearing the overlay the instant the last frame arrives puts the OLD text back on
   * screen until `reload()` resolves — a regenerate visibly reverts for a moment before
   * the new reply appears. While settling, the overlay stays and keeps showing what was
   * just written.
   */
  settling?: boolean;
}

export default function Chat() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<History>(`/api/chats/${encodeURIComponent(id)}/messages`),
    [id],
  );

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Which side panel is open over the chat, if any. These used to be separate routes,
  // which meant leaving the scene to read the state it is in.
  const [panel, setPanel] = useState<'state' | 'memory' | 'appearance' | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Whether the reader is at the live end of the transcript. Only then does new text
  // pull the view down; someone who scrolled back to reread a paragraph must not be
  // yanked forward by every token.
  const pinnedToBottom = useRef(true);

  const messages = useMemo(() => data?.messages ?? [], [data]);

  // What the transcript shows. Regenerating an early reply cuts everything after it
  // immediately, rather than waiting for the server to answer: the turns after that
  // position belong to the version being replaced, so they are already gone the moment
  // the reader asks for a new one. The server persists exactly the same outcome, so the
  // reload that follows agrees with what was on screen the whole time.
  const visible = useMemo(() => {
    const targetId = pending?.targetId;
    if (!targetId) return messages;
    const at = messages.findIndex((message) => message.id === targetId);
    return at === -1 ? messages : messages.slice(0, at + 1);
  }, [messages, pending?.targetId]);

  // The overlay comes down when the refetched transcript actually CONTAINS what the
  // overlay is showing — matched on content rather than on the message count, because a
  // regenerate replaces a row without changing the count and a send adds two at once.
  const overlayStored = useMemo(() => {
    if (!pending) return false;
    if (pending.sent && !messages.some((m) => m.role === 'user' && m.content === pending.sent)) {
      return false;
    }
    if (pending.text.length === 0) return true;
    return messages.some((m) => m.content === pending.text);
  }, [pending, messages]);

  useEffect(() => {
    if (pending?.settling && overlayStored) setPending(null);
  }, [pending?.settling, overlayStored]);

  // While settling, the stored copy and the overlay can both be true for one frame
  // before the effect above runs — which would render the reply twice. The overlay is
  // the thing that yields.
  const overlay = pending && !(pending.settling && overlayStored) ? pending : null;

  // The scene chip in the bar. Fetched separately from the transcript so a slow state
  // read never delays the conversation, and reloaded with it so a corrected value shows
  // up as soon as the turn lands.
  const state = useAsync(
    () => apiJson<{ state: WorldState }>(`/api/state/${encodeURIComponent(id)}`),
    [id],
  );
  const stateReload = useRef(state.reload);
  stateReload.current = state.reload;

  const characterName = data?.character?.shownName ?? data?.chat.title ?? 'Character';
  const userName = data?.persona?.name ?? 'You';

  // Follow the stream. `pending.text` is a dependency rather than `pending` because the
  // object identity changes on every delta and the layout has already been committed by
  // the time this runs, so the caret stays in view as the reply grows.
  //
  // A redo streams into the slot it replaces, which is usually above the fold — pulling
  // the view down to the end of the page on every token would drag the reader away from
  // the text they are watching. Only turns that append get followed.
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    if (pending?.targetId) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, pending?.text, pending?.targetId]);

  useEffect(() => {
    function onScroll() {
      const distance =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      pinnedToBottom.current = distance < 140;
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const run = useCallback(
    async (mode: TurnMode, content: string, targetId: string | null, sent?: string) => {
      setBusy(true);
      setSendError(null);
      // The reader just acted, so follow the result even if they had scrolled away.
      pinnedToBottom.current = true;
      // `sent` rides on the same state the stream writes into, so the reader's own line
      // is on screen from the first frame instead of after the model finishes.
      setPending({ mode, text: '', targetId, sent });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat(
          id,
          content,
          (frame) => {
            if (frame.type === 'delta') {
              setPending((current) =>
                current ? { ...current, text: current.text + frame.text } : current,
              );
            } else if (frame.type === 'error') {
              setSendError(frame.message);
            }
          },
          { mode, signal: controller.signal, targetId },
        );
      } catch (cause) {
        // An abort is the user pressing stop, not a failure.
        if (!controller.signal.aborted) setSendError(messageOf(cause));
      } finally {
        abortRef.current = null;
        setBusy(false);
        // Held, not cleared: the refetch below replaces the transcript with the stored
        // version, and clearing first would flash the pre-turn text back on screen.
        setPending((current) => (current ? { ...current, settling: true } : current));
        reload();
        // The state engine runs after a completed turn, so the scene bar is stale the
        // moment the reply lands. Held in a ref because the callback identity changes
        // every render and putting it in the deps would rebuild `run` continuously.
        stateReload.current();
        // A refetch that returns the same transcript never trips the settle check, so the
        // overlay would stay up forever. The timeout is the guarantee that it comes down.
        window.setTimeout(() => setPending((current) => (current?.settling ? null : current)), 6000);
      }
    },
    [id, reload],
  );

  function send() {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    void run('send', content, null, content);
  }

  async function swipe(messageId: string, direction: 'prev' | 'next') {
    try {
      await apiJson('/api/message/swipe', {
        method: 'POST',
        body: JSON.stringify({ chatId: id, id: messageId, direction }),
      });
      reload();
    } catch (cause) {
      setSendError(messageOf(cause));
    }
  }

  async function saveEdit(messageId: string, content: string) {
    setEditingId(null);
    try {
      await apiJson('/api/message/edit', {
        method: 'POST',
        body: JSON.stringify({ chatId: id, id: messageId, content }),
      });
      reload();
    } catch (cause) {
      setSendError(messageOf(cause));
    }
  }

  async function remove(messageId: string) {
    try {
      await apiJson('/api/message/delete', {
        method: 'POST',
        body: JSON.stringify({ chatId: id, id: messageId }),
      });
      reload();
    } catch (cause) {
      setSendError(messageOf(cause));
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(null);
    setBusy(false);
  }

  // Only the FIRST load gets a placeholder. `reload()` also sets `loading`, and swapping
  // the transcript for "Loading…" after every turn is what made sending feel like the
  // page was reloading and jumping to the top.
  if (loading && !data) {
    return (
      <>
        <AppBar lead={<BackLink to="/" label="All chats" />} title={<span className="bar-title">…</span>} />
        <div className="sheet">
          <p className="sheet-sub">Loading…</p>
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <AppBar lead={<BackLink to="/" label="All chats" />} title={<span className="bar-title">Chat</span>} />
        <div className="sheet">
          <div className="note danger">{error ?? 'Chat not found.'}</div>
        </div>
      </>
    );
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');


  return (
    <>
      <AppBar
        title={<span className="bar-title">{characterName}</span>}
        trailing={
          <button
            type="button"
            className="icon-btn"
            onClick={() => setPanel('memory')}
            title="Memory"
            aria-label="Memory"
          >
            <MemoryGlyph />
          </button>
        }
        scoped={
          <>
            <MenuLabel>This chat</MenuLabel>
            <PersonaMenu chatId={id} current={data.persona?.id ?? null} onChanged={reload} />
            <MenuSep />
            <PresetMenu chatId={id} onChanged={reload} />
            <MenuSep />
            <MenuAction label="World state" onClick={() => setPanel('state')} />
            <MenuAction label="Memory" onClick={() => setPanel('memory')} />
            <MenuAction label="Appearance" onClick={() => setPanel('appearance')} />
            {lastAssistant?.cached_tokens != null && lastAssistant.prompt_tokens != null && (
              <>
                <MenuSep />
                {/* Moved off the transcript: a percentage pinned under every reply reads
                    as a billing screen. It still matters, so it lives one tap away. */}
                <MenuAction
                  label={`Last turn ${Math.round(
                    (lastAssistant.cached_tokens / Math.max(1, lastAssistant.prompt_tokens)) * 100,
                  )}% cached`}
                  hint={lastAssistant.cost_usd != null ? `$${lastAssistant.cost_usd.toFixed(4)}` : undefined}
                  onClick={() => {}}
                />
              </>
            )}
          </>
        }
      />

      {/* The scene, always visible. This is the one fact about a roleplay scene you want
          while reading rather than by opening something — it is what tells you the
          narrator has drifted. Replaces the chip that only said "Set the scene". */}
      <SceneBar state={state.data?.state} onOpen={() => setPanel('state')} />

      <div className="transcript">
        {visible.map((message, index) => {
          const isUser = message.role === 'user';
          // The turn being redone. Its reply replaces this slot rather than appending,
          // so regenerating an early message shows the new version where the reader is
          // looking instead of at the bottom of a scene they then have to scroll up from.
          const isTarget = overlay?.targetId === message.id;
          return (
            <Fragment key={message.id}>
              {/* The turn being redone. Its OLD text is replaced by the new one in the same
                  slot rather than left on screen with the reply appended below it — a redo
                  is a replacement, and leaving the previous version visible makes it look
                  like a new message arriving at the end of the scene. */}
              {isTarget && !isUser ? (
                overlay.text.length === 0 ? (
                  <Turn
                    message={{ ...(message as TurnView), content: '' }}
                    name={characterName}
                    avatar={data.character?.avatar}
                    dropCap={index === 0}
                    thinking
                  />
                ) : (
                  <Turn
                    message={{ ...(message as TurnView), content: overlay.text }}
                    name={characterName}
                    avatar={data.character?.avatar}
                    dropCap={index === 0}
                    streaming
                  />
                )
              ) : (
                <Turn
                  message={message as TurnView}
                  name={isUser ? userName : characterName}
                  avatar={isUser ? null : data.character?.avatar}
                  // In the transcript you are already reading one character, so the
                  // portrait has nothing else to do — enlarging it is the only useful
                  // action, and it is also how you check an import carried an avatar.
                  zoomAvatar
                  // The first thing in the scene opens with a drop cap; everything else is
                  // body text.
                  dropCap={index === 0}
                  editing={editingId === message.id}
                  busy={busy}
                  onEditStart={() => setEditingId(message.id)}
                  onEditCancel={() => setEditingId(null)}
                  onEditSave={(content) => void saveEdit(message.id, content)}
                  actions={
                    editingId === message.id ? null : (
                      <MessageActions
                        canSwipeLeft={(message.swipeIndex ?? 0) > 0}
                        canSwipeRight={(message.swipeIndex ?? 0) < (message.swipes?.length ?? 1) - 1}
                        swipeIndex={message.swipeIndex ?? 0}
                        swipeCount={message.swipes?.length ?? 1}
                        onSwipe={(direction) => void swipe(message.id, direction)}
                        onCopy={() => message.content}
                        onEdit={() => setEditingId(message.id)}
                        onDelete={() => void remove(message.id)}
                        onRegenerate={
                          // Offered on every reply, not only the newest. Regenerating an
                          // earlier one is a branch: the new version takes that position
                          // and the turns after it step out of the transcript until you
                          // swipe back, which is what makes rewriting a scene's direction
                          // possible without losing the scene you had.
                          !isUser ? () => void run('regenerate', '', message.id) : undefined
                        }
                        busy={busy}
                      />
                    )
                  }
                />
              )}
            </Fragment>
          );
        })}

        {/* The reader's own line, before the server has answered. */}
        {overlay?.sent && (
          <Turn
            message={{ id: 'pending-user', role: 'user', content: overlay.sent }}
            name={userName}
            avatar={null}
          />
        )}

        {/* A new turn streams at the end, because that is where it belongs. A redo
            streams in the slot above, so this only covers the modes with no target. */}
        {overlay && !overlay.targetId && overlay.mode !== 'impersonate' && overlay.text.length === 0 && (
          <Turn
            message={{ id: 'pending-thinking', role: 'assistant', content: '' }}
            name={characterName}
            avatar={data.character?.avatar}
            thinking
          />
        )}
        {overlay && !overlay.targetId && overlay.text.length > 0 && (
          <Turn
            message={{
              id: 'pending',
              role: overlay.mode === 'impersonate' ? 'user' : 'assistant',
              content: overlay.text,
            }}
            name={overlay.mode === 'impersonate' ? userName : characterName}
            avatar={overlay.mode === 'impersonate' ? null : data.character?.avatar}
            streaming
          />
        )}
        <div ref={bottomRef} />
      </div>

      {panel && (
        <Modal
          title={panel === 'state' ? 'World state' : panel === 'memory' ? 'Memory' : 'Appearance'}
          subtitle={
            panel === 'state'
              ? 'What the narrator believes right now. Written automatically after each completed turn.'
              : panel === 'memory'
                ? 'What this chat carries forward. Written automatically as the scene runs.'
                : 'Type, colour and layout. Applies as you change it, on every device.'
          }
          onClose={() => setPanel(null)}
        >
          {panel === 'state' && <StatePanel embedded />}
          {panel === 'memory' && <MemoryPanel embedded />}
          {panel === 'appearance' && <AppearancePanel onClose={() => setPanel(null)} />}
        </Modal>
      )}

      {sendError && (
        <div className="composer" style={{ borderTop: 0, paddingBottom: 0 }}>
          <div className="composer-inner">
            <div className="note danger" style={{ flex: 1 }}>
              {sendError}
            </div>
          </div>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="composer-inner">
          {/* The two secondary actions sit to the LEFT of the field, as icon buttons, so
              they read as modifiers of what you are about to write rather than as peers
              of Send — and so the field gets every pixel they do not need. */}
          <div className="composer-actions">
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              title="Write my next line for me"
              aria-label="Impersonate"
              onClick={() => void run('impersonate', '', null)}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="3.2" />
                <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={busy || !lastAssistant}
              title="Continue the last reply"
              aria-label="Continue"
              onClick={() => lastAssistant && void run('continue', '', lastAssistant.id)}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12h13" />
                <path d="M12 7l5 5-5 5" />
              </svg>
            </button>
          </div>

          <textarea
            ref={inputRef}
            className="composer-input"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              const node = event.currentTarget;
              node.style.height = 'auto';
              node.style.height = `${Math.min(node.scrollHeight, window.innerHeight * 0.42)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={busy ? 'Streaming…' : `Write as ${userName}`}
            disabled={busy}
            aria-label="Message"
          />

          {busy ? (
            <button type="button" className="btn" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={draft.trim().length === 0}>
              Send
            </button>
          )}
        </div>
      </form>
    </>
  );
}
