import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import type { ChatSummary } from '../lib/apiTypes';
import { useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { Avatar } from '../components/Avatar';

/**
 * The shelf.
 *
 * A chat is a scene being written with a character, so the home screen is the shelf of
 * scenes rather than a list of records: the portrait, what it is called, the last thing
 * written, and how long ago. The Worker returns them most-recently-written first, so the
 * time is the column that orients you down the page — which is why it is a relative
 * "3h ago" and not a date. `toLocaleDateString` printed the same string for something
 * written this morning and something written last week.
 *
 * `preview` arrives truncated to 140 characters, which is about two lines here. It is
 * clamped to those two lines rather than ellipsised onto one, because the first line of a
 * last message is rarely the informative one.
 */
export default function ChatList() {
  const { data, error, loading } = useAsync(() => apiJson<ChatSummary[]>('/api/chats'), []);

  return (
    <>
      <AppBar title={<span className="bar-title">Tessera</span>} />

      <main className="shelf">
        <div className="sheet-head">
          <div>
            <h1 className="title">Scenes</h1>
            {data && data.length > 0 && (
              <p className="sheet-sub">
                {data.length} {data.length === 1 ? 'scene' : 'scenes'}
              </p>
            )}
          </div>
          <Link to="/characters" className="btn">
            Characters
          </Link>
        </div>
        <hr className="rule-fade" style={{ marginBottom: 6 }} />

        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}

        {data && data.length === 0 && (
          <div className="empty">
            <span className="eyebrow" style={{ display: 'block' }}>
              No scenes yet
            </span>
            <p style={{ margin: '12px auto 0', maxWidth: '46ch' }}>
              A scene is a chat with a character. Write one yourself, bring in a card you
              already have, or have one forged from a premise.
            </p>
            <div
              className="row-actions"
              style={{ justifyContent: 'center', flexWrap: 'wrap', gap: 8, marginTop: 20 }}
            >
              <Link to="/characters/new?blank=1" className="btn primary">
                New character
              </Link>
              <Link to="/characters/new" className="btn">
                Import a card
              </Link>
            </div>
            <p className="form-hint" style={{ marginTop: 16 }}>
              or{' '}
              <Link to="/forge" className="md-link">
                forge one from a premise
              </Link>
            </p>
          </div>
        )}

        <div>
          {data?.map((chat) => {
            const written = new Date(chat.updated_at);
            return (
              <Link key={chat.id} to={`/chat/${chat.id}`} className="shelf-row">
                <Avatar src={chat.character_avatar} name={chat.character_name ?? '?'} />
                <div className="shelf-main">
                  <div className="shelf-head">
                    <span className="row-title" style={{ minWidth: 0 }}>
                      {chat.character_name ?? chat.title ?? 'Untitled'}
                    </span>
                    <time
                      className="data shelf-time"
                      dateTime={written.toISOString()}
                      title={written.toLocaleString()}
                    >
                      {relativeTime(chat.updated_at)}
                    </time>
                  </div>
                  <p className="shelf-preview">{chat.preview ?? 'No messages yet'}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </>
  );
}

/**
 * How long ago, in the units a reader uses.
 *
 * Floored rather than rounded, so the number is always at least that old: 90 seconds is
 * "1m ago" and 119 minutes is "1h ago". Rounding up would claim time that has not passed
 * yet, which on a list sorted by recency reads as a wrong order.
 */
function relativeTime(then: number): string {
  const elapsed = Date.now() - then;
  if (elapsed < 60_000) return 'just now';

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(days / 365)}y ago`;
}
