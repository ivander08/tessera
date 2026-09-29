import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CardParseError, parseCardFile } from '../lib/cards/import';
import type { ParsedCard } from '../lib/cards/types';
import { loadTokenCounter } from '../lib/tokenizerClient';
import { apiJson } from '../lib/api';
import { messageOf } from '../lib/hooks';

/**
 * Per-field token counts matter because most of these fields are paid on every single
 * turn forever, while `firstMes` is paid once — it becomes the chat's opening message
 * rather than prompt text. `mesExample` and `postHistoryInstructions` are NOT one-time
 * despite reading that way: `assemble()` emits `mesExample` in the head and
 * `postHistoryInstructions` in the tail, so both are re-sent on every request.
 *
 * Reporting cost is not the same as claiming an optimal length — no controlled test
 * holds a character constant while varying token count, so no such claim is made.
 */
const PERMANENT = ['name', 'description', 'personality', 'scenario'] as const;

export default function CharacterNew() {
  const [card, setCard] = useState<ParsedCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatar, setAvatar] = useState<{ contentType: string; dataBase64: string } | null>(null);
  const [count, setCount] = useState<((text: string) => number) | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  // The 2.3 MB vocabulary loads only on this screen.
  useEffect(() => {
    let alive = true;
    void loadTokenCounter().then((fn) => {
      if (alive) setCount(() => fn);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function load(file: File) {
    setError(null);
    setAvatar(null);
    try {
      const parsed = await parseCardFile(file);
      setCard(parsed);
      if (file.type === 'image/png') setAvatar(await extractPngAvatar(file));
    } catch (cause) {
      setCard(null);
      setError(cause instanceof CardParseError ? cause.message : messageOf(cause));
    }
  }

  async function save() {
    if (!card) return;
    setSaving(true);
    setError(null);
    try {
      const created = await apiJson<{ id: string }>('/api/characters', {
        method: 'POST',
        body: JSON.stringify({ card, avatar }),
      });
      navigate(`/characters?created=${encodeURIComponent(created.id)}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!card) {
    return (
      <Frame>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void load(file);
          }}
          onClick={() => inputRef.current?.click()}
          className={`flex h-56 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center ${
            dragging ? 'border-accent bg-accent/10' : 'border-white/15'
          }`}
        >
          <p className="text-sm">Drop a card here — PNG, JSON, or CharX</p>
          <p className="text-xs text-ink-dim">or click to choose a file</p>
          <input
            ref={inputRef}
            type="file"
            accept=".png,.json,.charx,.zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void load(file);
            }}
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </Frame>
    );
  }

  const tokensOf = count ?? (() => 0);
  const permanent = PERMANENT.reduce((sum, field) => sum + tokensOf(card[field]), 0);

  return (
    <Frame>
      <p className="text-xs text-ink-dim">
        source format <span className="font-mono">{card.sourceFormat}</span>
      </p>

      <div className="rounded border border-white/10 bg-surface-raised p-3 text-sm">
        <p>
          <span className="font-mono text-accent">{permanent}</span> permanent tokens — paid on every
          turn, forever.
        </p>
        <p className="mt-1 text-xs text-ink-dim">
          first_mes {tokensOf(card.firstMes)} — one-time cost, it becomes the opening message.
        </p>
        <p className="mt-1 text-xs text-ink-dim">
          mes_example {tokensOf(card.mesExample)} — paid on <em>every</em> turn; it sits in the
          prompt head. post_history_instructions {tokensOf(card.postHistoryInstructions)} — every
          turn, in the tail.
        </p>
      </div>

      {PERMANENT.map((field) => (
        <Field key={field} label={field} tokens={tokensOf(card[field])}>
          <textarea
            value={card[field]}
            onChange={(event) => setCard({ ...card, [field]: event.target.value })}
            rows={field === 'name' ? 1 : 3}
            className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
      ))}

      {(['firstMes', 'mesExample', 'creatorNotes'] as const).map((field) => (
        <Field key={field} label={field} tokens={tokensOf(card[field])}>
          <textarea
            value={card[field]}
            onChange={(event) => setCard({ ...card, [field]: event.target.value })}
            rows={4}
            className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
      ))}

      <div className="space-y-1 text-xs text-ink-dim">
        <p>tags: {card.tags.length > 0 ? card.tags.join(', ') : '—'}</p>
        <p>alternate greetings: {card.alternateGreetings.length}</p>
        <p>character book: {card.characterBook ? 'present' : '—'}</p>
        <p>avatar: {avatar ? 'extracted from PNG' : 'none'}</p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || card.name.trim().length === 0}
        className="rounded bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save character'}
      </button>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Import a character</h1>
        <Link to="/characters" className="text-sm text-ink-dim hover:text-ink">
          ← Characters
        </Link>
      </header>
      {children}
    </main>
  );
}

function Field({
  label,
  tokens,
  children,
}: {
  label: string;
  tokens: number;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between text-xs text-ink-dim">
        <span>{label}</span>
        <span className="font-mono">{tokens} tok</span>
      </span>
      {children}
    </label>
  );
}

/**
 * The card's own PNG carries the avatar. Sending it as base64 in the create body
 * keeps one round trip, and the Worker stores it in `character_assets` rather than
 * in the `characters` row — a base64 data URL would push a large card past D1's
 * 2 MB per-row limit.
 */
async function extractPngAvatar(
  file: File,
): Promise<{ contentType: string; dataBase64: string } | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Only strip the card chunk when the avatar fits comfortably; otherwise keep the
  // file intact rather than risk an oversized request.
  if (bytes.length > 1_500_000) return null;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { contentType: 'image/png', dataBase64: btoa(binary) };
}
