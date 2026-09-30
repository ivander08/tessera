import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../lib/api';
import { messageOf } from '../lib/hooks';

/**
 * Search within a scene.
 *
 * The worker already indexes every message for recall, so this exposes the same index
 * rather than building a second one — the difference is the question. Recall asks "what is
 * relevant to this turn" and goes into the prompt; this asks "where did that happen" and
 * answers the reader.
 *
 * A hit outside the loaded window cannot be scrolled to without loading it first, so the
 * panel asks the chat to page back until the target is in range. That is the only honest
 * behaviour: silently doing nothing when a result is tapped is worse than not offering the
 * tap.
 */
export interface SearchHit {
  seq: number;
  id: string;
  role: string;
  speaker: string | null;
  snippet: string;
}

export function SearchPanel({
  chatId,
  onJump,
}: {
  chatId: string;
  /** Loads older turns until `seq` is in the transcript, then scrolls to it. */
  onJump: (seq: number, id: string) => Promise<boolean>;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [jumpFailed, setJumpFailed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function run() {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      return;
    }
    setBusy(true);
    setFailure(null);
    setJumpFailed(null);
    try {
      const result = await apiJson<{ hits: SearchHit[] }>(
        `/api/chats/${encodeURIComponent(chatId)}/search?q=${encodeURIComponent(trimmed)}`,
      );
      setHits(result.hits);
    } catch (cause) {
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function jump(hit: SearchHit) {
    setJumpFailed(null);
    const reached = await onJump(hit.seq, hit.id);
    if (!reached) {
      // The message is real but too far back to page to. Showing it here is honest; doing
      // nothing is not.
      setJumpFailed(
        'That turn is too far back to scroll to. The excerpt above is what it says.',
      );
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          ref={inputRef}
          className="field"
          value={query}
          placeholder="Search this scene"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void run();
            }
          }}
          aria-label="Search this scene"
        />
        <button type="button" className="btn primary" onClick={() => void run()} disabled={busy}>
          {busy ? '…' : 'Search'}
        </button>
      </div>

      {failure && <div className="note danger" style={{ marginTop: 10 }}>{failure}</div>}
      {jumpFailed && <div className="note" style={{ marginTop: 10 }}>{jumpFailed}</div>}

      {hits !== null && hits.length === 0 && !busy && (
        <p className="form-hint" style={{ marginTop: 12 }}>
          {query.trim().length === 0
            ? 'Type something to search for.'
            : 'Nothing in this scene matches that.'}
        </p>
      )}

      {hits !== null && hits.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              className="pick-row"
              onClick={() => void jump(hit)}
              style={{ alignItems: 'flex-start' }}
            >
              <span className="data" style={{ minWidth: 46, color: 'var(--ink-faint)' }}>
                #{hit.seq}
              </span>
              <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                <span className="turn-speaker" style={{ display: 'block', marginBottom: 2 }}>
                  {hit.speaker ?? (hit.role === 'user' ? 'You' : 'Character')}
                </span>
                {/* The snippet is rendered as plain text: it is an excerpt of markdown,
                    and half a paragraph of formatting renders as noise rather than as
                    prose. The match markers are the `«`/`»` the SQL inserts. */}
                <span style={{ color: 'var(--ink-dim)', fontSize: 'var(--text-sm)' }}>
                  {hit.snippet}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
