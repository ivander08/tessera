import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiJson, streamChat, type TurnMode } from '../lib/api';
import type { ChatDetail, MessageRow } from '../lib/apiTypes';
import { computeHitRate } from '../lib/cache';
import { messageOf, useAsync } from '../lib/hooks';
import { CacheMeter } from '../components/CacheMeter';
import { Message, type MessageView } from '../components/Message';
import { MessageActions } from '../components/MessageActions';

interface History {
  chat: ChatDetail;
  messages: MessageRow[];
}

interface Pending {
  mode: TurnMode;
  text: string;
  /** The message being replaced, for regenerate/continue. Null for a fresh turn. */
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
  const abortRef = useRef<AbortController | null>(null);

  // Only the active row per position is shown. The alternatives are already in the
  // payload, so swiping is instant and costs no request.
  const messages = useMemo(() => data?.messages ?? [], [data]);
  const hitRate = useMemo(() => computeHitRate(messages), [messages]);

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
              setPending((current) => (current ? { ...current, text: current.text + frame.text } : current));
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

  function send(event?: React.FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft('');
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

  if (loading) return <Shell>Loading…</Shell>;
  if (error) return <Shell>{error}</Shell>;
  if (!data) return null;

  const characterName = data.chat.title ?? 'Character';
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col">
      <header className="app-bar">
        <Link to="/" className="app-link">
          ← Chats
        </Link>
        <div className="ml-auto flex items-center gap-4">
          <Link to={`/chat/${id}/memory`} className="app-link">
            Memory
          </Link>
          <Link to={`/chat/${id}/state`} className="app-link">
            State
          </Link>
          <CacheMeter hitRate={hitRate} />
        </div>
      </header>

      <div className="flex-1 px-4 pb-4">
        {messages.map((message) => {
          const isPendingTarget = pending?.targetId === message.id;
          const streaming = isPendingTarget && pending?.mode !== 'regenerate';

          return (
            <Message
              key={message.id}
              message={message as MessageView}
              name={message.role === 'user' ? 'You' : characterName}
              layout="flat"
              streaming={streaming}
              busy={busy}
              editing={editingId === message.id}
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
                    onCopy={() => navigator.clipboard.writeText(message.content)}
                    onEdit={() => setEditingId(message.id)}
                    onDelete={() => void remove(message.id)}
                    onRegenerate={
                      message.id === lastAssistant?.id && message.role === 'assistant'
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

        {/* The in-flight reply. Rendered as a real message so the layout does not jump
            when it lands, and so the streaming caret has somewhere to live. */}
        {pending && pending.text.length > 0 && (
          <Message
            message={{
              id: 'pending',
              role: pending.mode === 'impersonate' ? 'user' : 'assistant',
              content: pending.text,
            }}
            name={pending.mode === 'impersonate' ? 'You' : characterName}
            layout="flat"
            streaming
          />
        )}
        <div ref={bottomRef} />
      </div>

      {sendError && (
        <p className="border-t border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-4 py-2 text-sm text-[var(--danger)]">
          {sendError}
        </p>
      )}

      <form onSubmit={send} className="composer">
        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            const node = event.currentTarget;
            node.style.height = 'auto';
            node.style.height = `${Math.min(node.scrollHeight, window.innerHeight * 0.4)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={busy ? 'Streaming…' : 'Write a message'}
          disabled={busy}
          aria-label="Message"
        />

        <button
          type="button"
          className="btn"
          onClick={() => void run('impersonate', '', null)}
          disabled={busy}
          title="Write my next line for me"
        >
          Impersonate
        </button>

        {lastAssistant && (
          <button
            type="button"
            className="btn"
            onClick={() => void run('continue', '', lastAssistant.id)}
            disabled={busy}
            title="Continue the last reply"
          >
            Continue
          </button>
        )}

        {busy ? (
          <button type="button" className="btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={draft.trim().length === 0}>
            Send
          </button>
        )}
      </form>
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl p-4">
      <p className="text-sm text-[var(--ink-dim)]">{children}</p>
    </main>
  );
}
