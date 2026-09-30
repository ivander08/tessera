import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Markdown } from './Markdown';
import { Avatar } from './Avatar';
import { MessageActions } from './MessageActions';

/**
 * One turn in the transcript.
 *
 * The speaker's name sits in small caps above the prose rather than in a bubble, and the
 * prose is set in the serif — this is a manuscript, not a chat log, and the type is what
 * says so. Colour distinguishes the two voices: brass for the character, verdigris for
 * the reader. That is the only place saturated colour appears, which is what makes it
 * read as information rather than decoration.
 */
export interface TurnView {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  swipes?: string[];
  swipeIndex?: number;
  prompt_tokens?: number | null;
  cached_tokens?: number | null;
  cost_usd?: number | null;
}

export interface TurnProps {
  message: TurnView;
  /** What to call this speaker. The character's shown name, or the persona's. */
  name: string;
  avatar?: string | null;
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

export function Turn({
  message,
  name,
  avatar,
  layout = 'flat',
  streaming = false,
  editing = false,
  onEditStart,
  onEditCancel,
  onEditSave,
  actions,
  children,
}: TurnProps) {
  const isUser = message.role === 'user';

  return (
    <article
      className={`turn ${isUser ? 'turn-user' : 'turn-assistant'} ${layout === 'bubble' ? 'turn-bubbled' : ''}`}
      data-message-id={message.id}
      data-streaming={streaming || undefined}
    >
      <Avatar src={avatar} name={name} className="turn-avatar" />

      <div className="turn-body">
        <div className="turn-head">
          <span className="turn-speaker">{name}</span>
          {actions}
        </div>

        {editing ? (
          <TurnEditor
            initial={message.content}
            onCancel={() => onEditCancel?.()}
            onSave={(content) => onEditSave?.(content)}
          />
        ) : (
          <div
            className="prose"
            onDoubleClick={onEditStart}
            onClick={(event) => {
              // A phone has no double-click, so a single tap starts editing there.
              if (event.detail === 1 && window.matchMedia('(hover: none)').matches) onEditStart?.();
            }}
          >
            <Markdown content={message.content} />
            {streaming && <span className="caret" aria-hidden="true" />}
          </div>
        )}

        {children}
        <TurnMeta message={message} />
      </div>
    </article>
  );
}

function TurnEditor({
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
    // Caret at the end rather than a full selection: a stray keystroke replacing the
    // whole message is the worst possible default.
    node.setSelectionRange(node.value.length, node.value.length);
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, []);

  return (
    <div>
      <textarea
        ref={ref}
        className="field"
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
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
        <button type="button" className="btn quiet" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
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
 * Per-turn accounting, shown only when the provider reported it.
 *
 * Quiet by design: a transcript that leads with numbers reads like a billing screen. The
 * cache figure is the one worth surfacing, because it is the whole point of the app.
 */
function TurnMeta({ message }: { message: TurnView }) {
  const { prompt_tokens: prompt, cached_tokens: cached, cost_usd: cost } = message;
  if (prompt == null || cached == null) return null;

  const percent = prompt > 0 ? Math.round((cached / prompt) * 100) : 0;
  const tone = percent >= 80 ? 'cache-good' : percent >= 40 ? 'cache-warm' : undefined;

  return (
    <div className="turn-meta">
      <span className={tone} title={`${cached} of ${prompt} prompt tokens served from cache`}>
        {percent}% cached
      </span>
      {cost != null && <span>${cost.toFixed(4)}</span>}
    </div>
  );
}

export { MessageActions };
