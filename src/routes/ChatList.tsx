import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import type { ChatSummary } from '../lib/apiTypes';
import { useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { Avatar } from '../components/Avatar';

export default function ChatList() {
  const { data, error, loading } = useAsync(() => apiJson<ChatSummary[]>('/api/chats'), []);

  return (
    <>
      <AppBar title={<span className="bar-title">Tessera</span>} />

      <div className="sheet">
        <div className="sheet-head">
          <div>
            <h1 className="title">Chats</h1>
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

        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}

        {data && data.length === 0 && (
          <div className="empty">
            No scenes yet.
            <br />
            <Link to="/characters/new" className="md-link">
              Import a character card
            </Link>{' '}
            or{' '}
            <Link to="/forge" className="md-link">
              write one from a premise
            </Link>
            .
          </div>
        )}

        <div>
          {data?.map((chat) => (
            <Link key={chat.id} to={`/chat/${chat.id}`} className="row">
              <Avatar src={chat.character_avatar} name={chat.character_name ?? '?'} />
              <div className="row-main">
                <div className="row-title">{chat.character_name ?? chat.title ?? 'Untitled'}</div>
                <div className="row-sub">{chat.preview ?? 'No messages yet'}</div>
              </div>
              <time className="data">{new Date(chat.updated_at).toLocaleDateString()}</time>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
