import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { apiJson, streamChat, type TurnMode } from '../lib/api';
import type { ChatCharacter, ChatDetail, ChatPersona, MessageRow } from '../lib/apiTypes';
import { computeHitRate } from '../lib/cache';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar, BackLink, MenuAction, MenuLabel, MenuSep } from '../components/AppBar';
import { PresetMenu } from '../components/PresetMenu';
import { PersonaMenu } from '../components/PersonaMenu';
import { Turn, type TurnView } from '../components/Turn';
import { MessageActions } from '../components/MessageActions';

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
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const messages = useMemo(() => data?.messages ?? [], [data]);
  const hitRate = useMemo(() => computeHitRate(messages), [messages]);

  const characterName = data?.character?.shownName ?? data?.chat.title ?? 'Character';
  const userName = data?.persona?.name ?? 'You';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, pending]);

  const run = useCallback(
    async (mode: TurnMode, content: string, targetId: string | null) => {
      setBusy(true);
      setSendError(null);
      setPending({ mode, text: '', targetId });

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
          { mode, signal: controller.signal },
        );
      } catch (cause) {
        // An abort is the user pressing stop, not a failure.
        if (!controller.signal.aborted) setSendError(messageOf(cause));
      } finally {
        abortRef.current = null;
        setPending(null);
        setBusy(false);
        reload();
      }
    },
    [id, reload],
  );

  function send() {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    void run('send', content, null);
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

  if (loading) {
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
        lead={<BackLink to="/" label="All chats" />}
        title={<span className="bar-title">{characterName}</span>}
        trailing={
          hitRate !== null ? (
            <span className="data" title="Share of the prompt served from the provider's cache">
              {Math.round(hitRate * 100)}%
            </span>
          ) : null
        }
        scoped={
          <>
            <MenuLabel>This chat</MenuLabel>
            <PersonaMenu chatId={id} current={data.persona?.id ?? null} onChanged={reload} />
            <MenuSep />
            <PresetMenu chatId={id} onChanged={reload} />
            <MenuSep />
            <MenuAction label="World state" onClick={() => { window.location.href = `/chat/${id}/state`; }} />
            <MenuAction label="Memory" onClick={() => { window.location.href = `/chat/${id}/memory`; }} />
          </>
        }
      />

      <div className="transcript">
        {messages.map((message) => {
          const isUser = message.role === 'user';
          return (
            <Turn
              key={message.id}
              message={message as TurnView}
              name={isUser ? userName : characterName}
              avatar={isUser ? null : data.character?.avatar}
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
                      message.id === lastAssistant?.id && !isUser
                        ? () => void run('regenerate', '', message.id)
                        : undefined
                    }
                    busy={busy}
                  />
                )
              }
            />
          );
        })}

        {/* The in-flight reply, rendered as a real turn so the layout does not jump when
            it lands and the caret has somewhere to live. */}
        {pending && pending.text.length > 0 && (
          <Turn
            message={{
              id: 'pending',
              role: pending.mode === 'impersonate' ? 'user' : 'assistant',
              content: pending.text,
            }}
            name={pending.mode === 'impersonate' ? userName : characterName}
            avatar={pending.mode === 'impersonate' ? null : data.character?.avatar}
            streaming
          />
        )}
        <div ref={bottomRef} />
      </div>

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
