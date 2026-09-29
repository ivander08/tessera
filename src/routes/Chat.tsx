import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiJson, streamChat } from '../lib/api';
import type { ChatDetail, MessageRow } from '../lib/apiTypes';
import { computeHitRate } from '../lib/cache';
import { messageOf, useAsync } from '../lib/hooks';
import { CacheMeter } from '../components/CacheMeter';

interface History {
  chat: ChatDetail;
  messages: MessageRow[];
}

export default function Chat() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<History>(`/api/chats/${encodeURIComponent(id)}/messages`),
    [id],
  );

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [data, pending]);

  const hitRate = useMemo(() => computeHitRate(data?.messages ?? []), [data]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || streaming) return;

    setDraft('');
    setPending('');
    setStreaming(true);
    setSendError(null);

    try {
      await streamChat(id, content, (frame) => {
        if (frame.type === 'delta') setPending((current) => current + frame.text);
        else if (frame.type === 'error') setSendError(frame.message);
      });
    } catch (cause) {
      setSendError(messageOf(cause));
    } finally {
      setStreaming(false);
      setPending('');
      // The server owns the transcript; re-reading it is cheaper than reconciling
      // optimistic state against what actually persisted.
      reload();
    }
  }

  if (loading) return <Shell title="…">Loading…</Shell>;
  if (error) return <Shell title="Chat">{error}</Shell>;
  if (!data) return null;

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col">
      <header className="flex items-center justify-between border-b border-white/10 p-3">
        <Link to="/" className="text-sm text-ink-dim hover:text-ink">
          ← Chats
        </Link>
        <div className="flex items-center gap-4">
          <Link to={`/chat/${id}/memory`} className="text-sm text-ink-dim hover:text-ink">
            Memory
          </Link>
          <CacheMeter hitRate={hitRate} />
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {data.messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        {pending && (
          <Bubble
            message={{
              seq: -1,
              id: 'pending',
              role: 'assistant',
              content: pending,
              content_tokens: null,
              prompt_tokens: null,
              completion_tokens: null,
              cached_tokens: null,
              cost_usd: null,
              created_at: 0,
            }}
          />
        )}
        <div ref={bottomRef} />
      </div>

      {sendError && (
        <p className="border-t border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {sendError}
        </p>
      )}

      <form onSubmit={send} className="flex gap-2 border-t border-white/10 p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(event);
            }
          }}
          rows={2}
          placeholder={streaming ? 'Streaming…' : 'Write a message'}
          disabled={streaming}
          className="flex-1 resize-none rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={streaming || draft.trim().length === 0}
          className="self-end rounded bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </main>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="mb-2 text-lg font-semibold">{title}</h1>
      <p className="text-sm text-ink-dim">{children}</p>
    </main>
  );
}

function Bubble({ message }: { message: MessageRow }) {
  const isUser = message.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-accent/20 text-ink' : 'bg-surface-raised text-ink'
        }`}
      >
        {message.content}
        {message.prompt_tokens != null && message.cached_tokens != null && (
          <span className="mt-1 block text-[11px] text-ink-dim">
            {message.cached_tokens}/{message.prompt_tokens} cached
            {message.cost_usd != null && ` · $${message.cost_usd.toFixed(4)}`}
          </span>
        )}
      </div>
    </div>
  );
}
