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
 * scenes rather than a list of records. Each one is a plate: the portrait carries the
 * character — it is the thing a reader recognises before they read a word — with the
 * name, the last thing written, and how long ago.
 *
 * The portrait is large because the images are the only colour on the screen and the
 * fastest way to find the scene you meant. Clicking it opens the full-size picture
 * instead of the scene, which is the only reason a reader ever wants to look closer.
 *
 * `preview` arrives truncated to 140 characters, which is about two lines here. It is
 * clamped rather than ellipsised onto one, because the first line of a last message is
 * rarely the informative one.
 */
export default function ChatList() {
  const { data, error, loading } = useAsync(() => apiJson<ChatSummary[]>('/api/chats'), []);

  return (
    <>
      <AppBar title={<span className="bar-title">Tessera</span>} titleHref={null} />

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
        <hr className="rule-fade" style={{ marginBottom: 14 }} />

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

        <div className="plates">
          {data?.map((chat) => {
            const name = chat.character_name ?? chat.title ?? 'Untitled';
            const written = new Date(chat.updated_at);
            return (
              <article key={chat.id} className="plate">
                {/* The whole plate is the door. On the shelf you are choosing a scene, so
                    the portrait is part of that choice rather than a separate control —
                    which is also why it does not zoom here. */}
                <Link to={`/chat/${chat.id}`} className="plate-portrait">
                  <Avatar src={chat.character_avatar} name={name} />
                </Link>
                <Link to={`/chat/${chat.id}`} className="plate-body">
                  <div className="plate-head">
                    <span className="plate-name">{name}</span>
                    <time
                      className="data plate-time"
                      dateTime={written.toISOString()}
                      title={written.toLocaleString()}
                    >
                      {relativeTime(chat.updated_at)}
                    </time>
                  </div>
                  <p className="plate-preview">{chat.preview ?? 'No messages yet'}</p>
                </Link>
              </article>
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
