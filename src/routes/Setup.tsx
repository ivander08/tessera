import { useState } from 'react';
import { useNavigate } from 'react-router';
import { apiJson, setToken } from '../lib/api';

/**
 * The entrance.
 *
 * This is the first screen anyone sees, so it is a title page rather than a login form:
 * the app's name set in the serif at a size that means it, one sentence saying what the
 * token is, and the field. The token is not a username and password — it is a single key
 * you generated yourself — so the screen says so instead of implying an account exists.
 */
export default function Setup() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;

    setBusy(true);
    setError(null);
    setToken(token);
    try {
      // Prove the token works before leaving this screen: a token that saves silently
      // and fails on the next request is worse than one that is rejected here.
      await apiJson<{ ok: boolean }>('/api/settings');
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: '24px 16px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ marginBottom: 26 }}>
          <h1
            style={{
              fontFamily: 'var(--font-prose)',
              fontSize: 'clamp(34px, 9vw, 46px)',
              fontWeight: 400,
              letterSpacing: '-0.02em',
              margin: 0,
              lineHeight: 1.1,
            }}
          >
            Tessera
          </h1>
          <p className="sheet-sub" style={{ marginTop: 10 }}>
            A roleplay client that keeps its prompt cache intact, remembers what happened, and
            tracks the world you are writing in.
          </p>
        </div>

        <form onSubmit={submit} className="panel panel-pad">
          <label className="block">
            <span className="form-label">
              <span>Access token</span>
              <span className="form-hint">the value you set as TESSERA_TOKEN</span>
            </span>
            <input
              type="password"
              className="field"
              style={{ fontFamily: 'var(--font-data)' }}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="paste it here"
              autoComplete="off"
              autoFocus
            />
          </label>

          {error && (
            <div className="note danger" style={{ marginTop: 12 }}>
              {error === 'unauthorized'
                ? 'That token does not match the one the Worker expects. Check for a trailing space, then try again.'
                : error}
            </div>
          )}

          <button
            type="submit"
            className="btn primary"
            style={{ width: '100%', marginTop: 14, minHeight: 40 }}
            disabled={busy || value.trim().length === 0}
          >
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>

        <p className="form-hint" style={{ marginTop: 14, lineHeight: 1.6 }}>
          There is no account. The token is checked against the Worker on every request and kept
          in this browser only.
        </p>
      </div>
    </main>
  );
}
