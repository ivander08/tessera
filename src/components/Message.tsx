import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Markdown } from './Markdown';

/**
 * One message in the transcript.
 *
 * Layout follows chub rather than a chat app: avatar, name, prose, full width. Bubbles
 * waste the horizontal space a phone does not have and read as SMS rather than as a
 * story, but they are available as a theme option for anyone who prefers them.
 *
 * Two behaviours that matter more than they look:
 *
 *  - **Tap-to-edit on the prose.** Editing through a modal on a phone means the keyboard
 *    covers the text you are editing. Swapping the paragraph for a textarea in place
 *    keeps the message where it was on screen.
 *  - **Escape cancels, Cmd/Ctrl+Enter saves.** Enter alone inserts a newline, because a
 *    roleplay message is paragraphs, not a chat line.
 */
export interface MessageView {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Alternative ids at this position, in order. Length 1 when never regenerated. */
  swipes?: string[];
  swipeIndex?: number;
  prompt_tokens?: number | null;
  cached_tokens?: number | null;
  cost_usd?: number | null;
  created_at?: number;
}

export interface MessageProps {
  message: MessageView;
  name: string;
  avatarUrl?: string | null;
  layout?: 'flat' | 'bubble';
  streaming?: boolean;
  busy?: boolean;
  editing?: boolean;
  onEditStart?: () => void;
  onEditCancel?: () => void;
  onEditSave?: (content: string) => void;
  actions?: ReactNode;
  children?: ReactNode;
}

export function Message({
  message,
  name,
  avatarUrl,
  layout = 'flat',
  streaming = false,
  editing = false,
  onEditStart,
  onEditCancel,
  onEditSave,
  actions,
  children,
}: MessageProps) {
  const bubble = layout === 'bubble';

  return (
    <article
      className={`msg msg-${message.role} ${bubble ? 'msg-bubbled' : ''}`}
      data-message-id={message.id}
      data-streaming={streaming || undefined}
    >
      <div className="msg-avatar" aria-hidden="true">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{(name[0] ?? '?').toUpperCase()}</span>}
      </div>

      <div className="msg-body">
        <header className="msg-head">
          <span className="msg-name">{name}</span>
          {actions}
        </header>

        {editing ? (
          <MessageEditor
            initial={message.content}
            onCancel={() => onEditCancel?.()}
            onSave={(content) => onEditSave?.(content)}
          />
        ) : (
          <div
            className="msg-content"
            onDoubleClick={onEditStart}
            // A single tap starts editing on touch, where there is no double-click.
            onClick={(event) => {
              if (event.detail === 1 && isTouch()) onEditStart?.();
            }}
          >
            <Markdown content={message.content} />
            {streaming && <span className="msg-caret" aria-hidden="true" />}
          </div>
        )}

        {children}
        <MessageMeta message={message} />
      </div>
    </article>
  );
}

/** `matchMedia` is the only reliable signal; user-agent sniffing misfires on hybrids. */
function isTouch(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
}

function MessageEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    // Put the caret at the end rather than selecting everything: a stray keystroke
    // replacing the whole message is the worst possible default.
    node.setSelectionRange(node.value.length, node.value.length);
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, []);

  return (
    <div className="msg-edit">
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          const node = event.currentTarget;
          node.style.height = 'auto';
          node.style.height = `${node.scrollHeight}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (value.trim().length > 0) onSave(value.trim());
          }
        }}
        rows={3}
        aria-label="Edit message"
      />
      <div className="msg-edit-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={value.trim().length === 0}
          onClick={() => onSave(value.trim())}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * Token accounting, shown only when the provider reported it.
 *
 * Deliberately quiet: it is diagnostic, and a transcript that leads with numbers reads
 * like a billing screen. The cache figure is the one number worth surfacing, because it
 * is the whole point of the app.
 */
function MessageMeta({ message }: { message: MessageView }) {
  const { prompt_tokens: prompt, cached_tokens: cached, cost_usd: cost } = message;
  if (prompt == null || cached == null) return null;

  const percent = prompt > 0 ? Math.round((cached / prompt) * 100) : 0;
  const tone = percent >= 80 ? 'good' : percent >= 40 ? 'warn' : 'bad';

  return (
    <div className="msg-meta">
      <span className={`msg-cache ${tone}`} title={`${cached} of ${prompt} prompt tokens served from cache`}>
        {percent}% cached
      </span>
      {cost != null && <span className="msg-cost">${cost.toFixed(4)}</span>}
    </div>
  );
}
