import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import { messageOf } from '../lib/hooks';
import { AppBar } from '../components/AppBar';

/**
 * Search across every scene.
 *
 * The worker already indexes every message for recall and the in-chat search panel reads
 * that same index; this is the third question over it — not "what is relevant to this
 * turn" and not "where in this scene", but "where did this happen at all". A hit is a
 * door, so every row links straight to the turn rather than opening a preview: the chat
 * screen already knows how to page back to a `seq` and scroll to it.
 *
 * The search is debounced rather than submitted. Typing is the whole interface here, and
 * a reader who has to press a button to see results assumes the field is a filter that
 * has not applied yet.
 */
interface SearchHit {
  chatId: string;
  chatTitle: string | null;
  characterName: string | null;
  seq: number;
  messageId: string;
  role: string;
  snippet: string;
}

/** Long enough to finish a word, short enough that the list feels tied to the typing. */
const DEBOUNCE_MS = 250;

export default function Search() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  /** The query `hits` answers. Rendering results under a newer query would be a lie. */
  const [answered, setAnswered] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const trimmed = query.trim();
  const results = answered === trimmed ? hits : null;

  useEffect(() => {
    if (trimmed.length === 0) {
      setHits(null);
      setAnswered(null);
      setLoading(false);
      setFailure(null);
      return;
    }

    // A request per keystroke is both wasteful and racy: the older response can land
    // after the newer one and show results for a query the field no longer contains.
    // Abort on cleanup makes the latest query the only one that may write state.
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);

    const timer = setTimeout(() => {
      void apiJson<{ hits: SearchHit[] }>(
        `/api/search?q=${encodeURIComponent(trimmed)}&limit=30`,
        { signal: controller.signal },
      )
        .then((result) => {
          setHits(result.hits);
          setAnswered(trimmed);
          setFailure(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setFailure(messageOf(cause));
          setHits(null);
          setAnswered(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmed]);

  return (
    <>
      <AppBar title={<span className="bar-title">Search</span>} />

      <main className="sheet">
        <div className="sheet-head">
          <div>
            <h1 className="title">Search</h1>
            <p className="sheet-sub">Every scene, every turn.</p>
          </div>
        </div>

        <input
          type="search"
          className="field"
          aria-label="Search every scene"
          placeholder="Type to search every scene…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div style={{ marginTop: 18 }}>
          {failure && <div className="note danger">{failure}</div>}

          {trimmed.length === 0 && (
            <p className="form-hint">Type a word or a phrase to find the scene it is in.</p>
          )}

          {loading && (
            <p className="form-hint" role="status">
              Searching…
            </p>
          )}

          {!loading && !failure && trimmed.length > 0 && results !== null && results.length === 0 && (
            <div className="empty">
              <span className="eyebrow" style={{ display: 'block' }}>
                No scenes match that
              </span>
              <p style={{ margin: '12px auto 0', maxWidth: '46ch' }}>
                Try a different word, or a shorter one.
              </p>
            </div>
          )}

          {!loading && results !== null && results.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              {results.map((hit) => {
                const title =
                  hit.chatTitle ?? hit.characterName ?? 'Untitled scene';
                const speaker =
                  hit.role === 'user'
                    ? 'You'
                    : hit.role === 'assistant'
                      ? 'Character'
                      : 'System';
                return (
                  <Link
                    key={`${hit.chatId}-${hit.messageId}`}
                    to={`/chat/${hit.chatId}?seq=${hit.seq}`}
                    className="pick-row"
                    style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}
                  >
                    <span style={{ fontWeight: 600 }}>{title}</span>
                    <span
                      className="data"
                      style={{
                        color: 'var(--ink-dim)',
                        fontSize: 'var(--text-sm)',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {speaker} · {hit.snippet}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
