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
  /** Request sent, no text back yet: the speaker is composing. */
  thinking?: boolean;
  /** Set a drop cap on the first paragraph. Only the opening turn of a scene gets one. */
  dropCap?: boolean;
  /** Open the speaker's portrait full size when it is clicked. */
  zoomAvatar?: boolean;
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
  thinking = false,
  dropCap = false,
  zoomAvatar = false,
  editing = false,
  onEditStart,
  onEditCancel,
  onEditSave,
  actions,
  children,
}: TurnProps) {
  const isUser = message.role === 'user';

  // A drop cap only makes sense on prose that opens with a letter. Cards routinely open
  // with `*action beats*`, em-dashes or quotes, and a floated punctuation mark is just a
  // stray glyph in the margin.
  //
  // The leading markdown is stripped before testing, because `::first-letter` matches the
  // first letter of the RENDERED line — `*Quill looks up.*` renders as "Quill looks up."
  // inside an `<em>`, so the cap lands on the Q. Testing the raw source would refuse
  // every card that opens with an action beat, which is most of them.
  const opening = message.content.trimStart().replace(/^[*_`~\-—–"'(<\s]+/, '');
  const cap = dropCap && /^[\p{L}\p{N}]/u.test(opening) ? ' drop-cap' : '';

  return (
    <article
      className={`turn ${isUser ? 'turn-user' : 'turn-assistant'} ${layout === 'bubble' ? 'turn-bubbled' : ''}`}
      data-message-id={message.id}
      data-streaming={streaming || undefined}
      data-thinking={thinking || undefined}
    >
      <Avatar src={avatar} name={name} className="turn-avatar" zoomable={zoomAvatar} />

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
        ) : thinking ? (
          // Before the first token there is nothing to read, so the wait itself is drawn.
          // The ellipsis is styled in the speaker's own colour, which is what ties it to
          // the character rather than to a generic spinner.
          <div className="prose">
            <span className="thinking" aria-label={`${name} is writing`}>
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : (
          <div
            className={`prose${cap}`}
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
 * Per-turn accounting.
 *
 * The cache figure lives in the chat menu rather than under every reply: a percentage
 * pinned to the end of each turn reads as a billing screen, and it is not something you
 * act on mid-scene. What stays here is the cost, and only when the provider actually
 * reported one — which is also the only case where it is information rather than noise.
 */
function TurnMeta({ message }: { message: TurnView }) {
  const { cost_usd: cost } = message;
  if (cost == null) return null;

  return (
    <div className="turn-meta">
      <span>${cost.toFixed(4)}</span>
    </div>
  );
}

export { MessageActions };
