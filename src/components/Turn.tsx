import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Markdown } from './Markdown';
import { Avatar } from './Avatar';
import { MessageActions } from './MessageActions';
import { SPEAKER_LINE, splitSpeakers } from '../lib/transcript/speakers';
import type { WorldState } from '../lib/state/schema';

/**
 * One turn in the transcript.
 *
 * The speaker's name sits in small caps above the prose rather than in a bubble, and the
 * prose is set in the serif — this is a manuscript, not a chat log, and the type is what
 * says so. Colour distinguishes the voices: brass for the character, verdigris for the
 * reader, and a palette slot for each member of a cast. That is the only place saturated
 * colour appears, which is what makes it read as information rather than decoration.
 *
 * A group reply is one turn containing several speakers. It is split into segments so each
 * gets its own name and colour, rather than being shown as one block of prose with names
 * buried in it — which is what makes a three-way scene readable at all.
 */
export interface TurnView {
  id: string;
  /** Per-chat row order. Used to find a turn the reader jumped to from search. */
  seq?: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  swipes?: string[];
  swipeIndex?: number;
  prompt_tokens?: number | null;
  cached_tokens?: number | null;
  cost_usd?: number | null;
  /** Who wrote this row; null or absent means the chat's own character. */
  speaker?: string | null;
  /** The world state as of this turn, when one was recorded. */
  state?: WorldState | null;
}

/** A speaker's name and voice colour, from the chat's cast. */
export interface CastVoice {
  name: string;
  /** A `--voice-N` token name, or null to fall back to the theme's own speaker colour. */
  color: string | null;
}

export interface TurnProps {
  message: TurnView;
  /** What to call this speaker. The character's shown name, or the persona's. */
  name: string;
  avatar?: string | null;
  streaming?: boolean;
  /** Request sent, no text back yet: the speaker is composing. */
  thinking?: boolean;
  /** Set a drop cap on the first paragraph. Only the opening turn of a scene gets one. */
  dropCap?: boolean;
  /** Open the speaker's portrait full size when it is clicked. */
  zoomAvatar?: boolean;
  /**
   * The chat's cast, when it has more than one member. Absent means a single-speaker
   * scene, which renders exactly as it did before casts existed.
   */
  cast?: CastVoice[];
  /** The state as of the PREVIOUS turn, so an unchanged scene renders nothing. */
  previousState?: WorldState | null;
  /** The reply hit the provider's output cap and stops mid-sentence. */
  truncated?: boolean;
  /** Appends another turn continuing this one. Omitted when the turn cannot be continued. */
  onContinue?: () => void;
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

  streaming = false,
  thinking = false,
  dropCap = false,
  zoomAvatar = false,
  cast,
  previousState,
  truncated = false,
  onContinue,
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

  // Splitting happens only when the cast actually has more than one member. A
  // single-character scene takes the original path untouched, which is what keeps every
  // existing scene pixel-identical — and a reply that happens to contain a `Name:` line
  // is not retroactively reinterpreted.
  const segments = !isUser && cast && cast.length > 1 ? splitSpeakers(message.content) : null;
  const multi = segments !== null && segments.some((segment) => segment.speaker !== null);

  // A row's own speaker overrides the chat's character when it is set. Null is the
  // ordinary case — every row in a single-character scene — so the fallback is the name
  // the caller passed.
  const rowName = message.speaker ?? name;
  const head = multi ? segments![0].speaker ?? rowName : rowName;

  return (
    <article
      className={`turn ${isUser ? 'turn-user' : 'turn-assistant'}`}
      data-message-id={message.id}
      data-seq={message.seq}
      data-streaming={streaming || undefined}
      data-thinking={thinking || undefined}
    >
      <Avatar src={avatar} name={head} className="turn-avatar" zoomable={zoomAvatar} />

      <div className="turn-body">
        {editing ? (
          <>
            <div className="turn-head">
              <span className="turn-speaker">{rowName}</span>
              {actions}
            </div>
            <TurnEditor
              initial={message.content}
              onCancel={() => onEditCancel?.()}
              onSave={(content) => onEditSave?.(content)}
            />
          </>
        ) : thinking ? (
          <>
            <div className="turn-head">
              <span className="turn-speaker">{rowName}</span>
              {actions}
            </div>
            {/* Before the first token there is nothing to read, so the wait itself is
                drawn. The ellipsis is styled in the speaker's own colour, which is what
                ties it to the character rather than to a generic spinner. */}
            <div className="prose">
              <span className="thinking" aria-label={`${rowName} is writing`}>
                <i />
                <i />
                <i />
              </span>
            </div>
          </>
        ) : multi ? (
          segments!.map((segment, index) => {
            // A speaker with nothing to say yet renders their name alone rather than
            // being dropped: the next reply may continue them, and a name that vanishes
            // reads as a bug rather than as a beat.
            const text = segment.speaker
              ? segment.text.replace(SPEAKER_LINE, '').trimStart()
              : segment.text;
            const voice = voiceOf(segment.speaker, cast!, name);
            return (
              <div className="turn-segment" key={`${index}-${segment.speaker ?? 'narration'}`}>
                <div className="turn-head">
                  <span
                    className="turn-speaker"
                    style={voice.color ? { color: `var(${voice.color})` } : undefined}
                  >
                    {voice.name}
                  </span>
                  {/* The tools ride on the FIRST segment, so they stay on the turn's own
                      header line rather than appearing again beside every speaker. */}
                  {index === 0 ? actions : null}
                </div>
                {text.length > 0 && (
                  <div className={`prose${index === 0 ? cap : ''}`}>
                    <Markdown content={text} />
                    {streaming && index === segments!.length - 1 && (
                      <span className="caret" aria-hidden="true" />
                    )}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <>
            <div className="turn-head">
              <span className="turn-speaker">{rowName}</span>
              {actions}
            </div>
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
          </>
        )}

        {children}
        {truncated && (
          <p className="turn-truncated">
            Stopped at the output limit.{' '}
            {onContinue && (
              <button type="button" className="app-link" onClick={onContinue}>
                Continue
              </button>
            )}
          </p>
        )}
        <TurnState message={message} previous={previousState} />
        <TurnMeta message={message} />
      </div>
    </article>
  );
}

/**
 * Where and when this turn happened.
 *
 * The scene bar shows the state as it is NOW; this shows what it was at THIS turn, which
 * is the only way to answer "where was I when that happened" — the live document has been
 * overwritten many times since.
 *
 * Rendered only when it DIFFERS from the previous turn's state, and only for the fields a
 * reader uses to orient. A line repeating the same time and place under every reply would
 * be noise; a line that appears when the scene moves is information. Nothing is shown for
 * a turn whose state did not change, which is most of them.
 */
function TurnState({
  message,
  previous,
}: {
  message: TurnView;
  previous?: WorldState | null;
}) {
  const state = message.state;
  if (!state) return null;

  // Only the fields that move. Inventory and notes change constantly and would make this
  // line appear on almost every turn, which is the noise it exists to avoid.
  const parts = [state.location, state.time, state.weather]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part && part.length > 0);
  if (parts.length === 0) return null;

  const before = [previous?.location, previous?.time, previous?.weather]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part && part.length > 0);

  // Unchanged since the previous turn: nothing to say.
  if (before.join(' · ') === parts.join(' · ')) return null;

  return (
    <p className="turn-state" title="The scene as it stood at this turn">
      {parts.join(' · ')}
    </p>
  );
}

/**
 * The name and colour for one segment.
 *
 * A segment with no speaker is narration, which belongs to the character the scene is
 * written from — so it keeps their name rather than being labelled "narration", which
 * would be a label the reader never asked for.
 */
function voiceOf(
  speaker: string | null,
  cast: CastVoice[],
  fallback: string,
): { name: string; color: string | null } {
  if (speaker === null) return { name: fallback, color: null };

  const match = cast.find((member) => member.name.trim().toLowerCase() === speaker.trim().toLowerCase());
  return match ? { name: match.name, color: match.color } : { name: speaker, color: null };
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
