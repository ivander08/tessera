import { useState } from 'react';
import { useNavigate } from 'react-router';
import { apiJson, setToken } from '../lib/api';

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
      // Prove the token works before leaving this screen: a wrong token that
      // "saves" silently is worse than a rejected one.
      await apiJson<{ ok: boolean }>('/api/settings');
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4 rounded-lg border border-white/10 bg-surface-raised p-6"
      >
        <h1 className="text-xl font-semibold text-ink">Tessera</h1>
        <p className="text-sm text-ink-dim">
          Paste the access token you set with{' '}
          <code className="rounded bg-black/40 px-1">wrangler secret put TESSERA_TOKEN</code>.
        </p>
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="token"
          autoComplete="off"
          className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || value.trim().length === 0}
          className="w-full rounded bg-accent px-3 py-2 font-medium text-black disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Save token'}
        </button>
      </form>
    </main>
  );
}
