import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiJson } from '../lib/api';
import { alwaysOnLore, parseLorebook } from '../lib/cards/lorebook';
import type { CharacterCardJson } from '../lib/cards/types';
import { loadTokenCounter } from '../lib/tokenizerClient';
import { messageOf, useAsync } from '../lib/hooks';
import { GreetingsEditor } from '../components/GreetingsEditor';
import { Avatar } from '../components/Avatar';

interface CharacterDetail {
  id: string;
  name: string;
  avatar: string | null;
  sourceFormat: string;
  tokens: number | null;
  createdAt: number;
  /** Null when the stored JSON will not parse — the form is not offered then. */
  card: CharacterCardJson | null;
  cardJson: string;
}

/** The card's string-valued fields, which is what the form edits as text. */
type TextField =
  | 'name'
  | 'nickname'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'firstMes'
  | 'mesExample'
  | 'systemPrompt'
  | 'postHistoryInstructions'
  | 'creatorNotes';

/**
 * Which fields cost what.
 *
 * This is the readout that matters: the permanent four are re-sent in the prompt head
 * on every turn forever, and `systemPrompt`, `mesExample` and `postHistoryInstructions`
 * are re-sent every turn too — `assemble()` emits `mesExample` in the head and
 * `postHistoryInstructions` in the tail. Only `firstMes` is truly one-time, because it
 * becomes the chat's opening message rather than prompt text.
 *
 * Reporting cost is not a claim about length: no controlled test holds a character
 * constant while varying token count, so no optimal size is asserted here.
 */
const FIELDS: Array<{ key: TextField; label: string; rows: number; cost: string }> = [
  {
    key: 'name',
    label: 'name',
    rows: 1,
    cost: 'the card’s title — what the library lists',
  },
  {
    key: 'nickname',
    label: 'shown name',
    rows: 1,
    cost: 'what the transcript calls them · falls back to name',
  },
  { key: 'description', label: 'description', rows: 4, cost: 'every turn' },
  { key: 'personality', label: 'personality', rows: 3, cost: 'every turn' },
  { key: 'scenario', label: 'scenario', rows: 3, cost: 'every turn' },
  {
    key: 'systemPrompt',
    label: 'system_prompt',
    rows: 3,
    cost: 'every turn — replaces the global system prompt',
  },
  {
    key: 'mesExample',
    label: 'mes_example',
    rows: 5,
    cost: 'every turn — in the prompt head',
  },
  {
    key: 'postHistoryInstructions',
    label: 'post_history_instructions',
    rows: 3,
    cost: 'every turn — in the prompt tail',
  },
  { key: 'firstMes', label: 'first_mes', rows: 4, cost: 'one-time — the opening message' },
  { key: 'creatorNotes', label: 'creator_notes', rows: 3, cost: 'never sent' },
];

const PERMANENT: TextField[] = ['name', 'description', 'personality', 'scenario'];

export default function CharacterEdit() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<CharacterDetail>(`/api/characters/${encodeURIComponent(id)}`),
    [id],
  );

  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [tagsText, setTagsText] = useState('');
  const [greetings, setGreetings] = useState<string[]>([]);
  const [bookText, setBookText] = useState('');
  const [avatar, setAvatar] = useState<{ contentType: string; dataBase64: string } | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [count, setCount] = useState<((text: string) => number) | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // The 2.3 MB vocabulary loads only on the character screens.
  useEffect(() => {
    let alive = true;
    void loadTokenCounter().then((fn) => {
      if (alive) setCount(() => fn);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Seed the form from the loaded card. Keyed on the fetched object, not on each
  // keystroke: typing does not change `data`, so an edit in progress is never clobbered,
  // and a reload after saving re-seeds from what the server actually stored.
  useEffect(() => {
    if (!data) return;
    setEdits({});
    setTagsText(data.card?.tags.join(', ') ?? '');
    setGreetings(data.card?.alternateGreetings ?? []);
    setBookText(data.card?.characterBook ? JSON.stringify(data.card.characterBook, null, 2) : '');
    setAvatar(null);
    setAvatarPreview(null);
    setRemoveAvatar(false);
  }, [data]);

  const tokensOf = count ?? (() => 0);
  // Until the exact vocabulary has loaded, show a dash rather than a number that is
  // about to change: a figure the user has already read and acted on is worse than a
  // placeholder that plainly means "not yet".
  const ready = count !== null;
  const card = data?.card ?? null;

  function value(key: keyof CharacterCardJson): string {
    if (edits[key] !== undefined) return edits[key];
    const raw = card?.[key];
    return typeof raw === 'string' ? raw : '';
  }

  const permanent = PERMANENT.reduce((sum, key) => sum + tokensOf(value(key)), 0);

  // The card's always-on world info is emitted into the prompt head, so it is paid on
  // every turn as well — a cost this readout would otherwise hide.
  const parsedBook = parseBook(bookText);
  const loreTokens = parsedBook.error
    ? 0
    : alwaysOnLore(parseLorebook(parsedBook.value)).reduce(
        (sum, entry) => sum + tokensOf(entry.content),
        0,
      );

  const perTurn =
    permanent +
    tokensOf(value('systemPrompt')) +
    tokensOf(value('mesExample')) +
    tokensOf(value('postHistoryInstructions')) +
    loreTokens;

  async function save() {
    if (!card) return;
    const name = value('name').trim();
    if (name.length === 0) {
      setFailure('name must not be empty');
      return;
    }
    if (parsedBook.error) {
      setFailure(parsedBook.error);
      return;
    }

    setBusy(true);
    setFailure(null);
    setStatus(null);
    try {
      const next: CharacterCardJson = { ...card, name };
      for (const field of FIELDS) {
        const edited = edits[field.key];
        // `name` is already applied, trimmed; a blank name is rejected above.
        if (field.key !== 'name' && edited !== undefined) next[field.key] = edited;
      }
      next.tags = splitTags(tagsText);
      next.alternateGreetings = greetings.map((entry) => entry.trim()).filter(Boolean);
      next.characterBook = parsedBook.value;

      await apiJson(`/api/characters/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ id, card: next, ...(avatar ? { avatar } : {}) }),
      });

      // Sent after the card write so a rejected avatar cannot leave the card saved and
      // the picture half-changed. Removing is a separate call for the same reason.
      if (removeAvatar && data?.avatar) {
        await apiJson(`/api/characters/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' });
      }

      setStatus('Saved. The next turn uses this.');
      reload();
    } catch (cause) {
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function fork() {
    if (!card) return;
    const name = window.prompt('Name for the copy', `${value('name')} (copy)`);
    if (name === null) return;

    setBusy(true);
    setFailure(null);
    setStatus(null);
    try {
      const created = await apiJson<{ id: string }>(`/api/characters/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        body: JSON.stringify({ id, name }),
      });
      navigate(`/characters/${created.id}/edit`);
    } catch (cause) {
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function pickAvatar(file: File) {
    setFailure(null);
    if (file.size > 1_500_000) {
      setFailure('Image is larger than 1.5 MB. D1 caps a row at 2 MB, so a bigger avatar cannot be stored.');
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const contentType = file.type || 'image/png';
    setAvatar({ contentType, dataBase64: btoa(binary) });
    setAvatarPreview(`data:${contentType};base64,${btoa(binary)}`);
    setRemoveAvatar(false);
  }

  // The stored avatar lives behind the same bearer auth as everything else, so it has to
  // be fetched rather than pointed at — see Avatar. A locally-chosen image is still a
  // data URL at this point and needs no fetch.
  const storedAvatar = removeAvatar ? null : (data?.avatar ?? null);

  return (
    <main className="mx-auto max-w-2xl space-y-5 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-[var(--font-lg)] font-semibold">{data?.name ?? 'Character'}</h1>
        <Link to="/characters" className="app-link">
          ← Characters
        </Link>
      </header>

      {loading && <p className="text-sm text-[var(--ink-dim)]">Loading…</p>}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {data && !card && (
        <section className="card space-y-2 p-3">
          <p className="text-sm text-[var(--danger)]">
            This character&rsquo;s stored card is not valid JSON, so the editor cannot show it as
            fields. Nothing has been overwritten — the raw text is below. Re-import the card to
            repair it.
          </p>
          <pre className="md-pre overflow-x-auto text-[var(--font-xs)] whitespace-pre-wrap">
            {data.cardJson}
          </pre>
        </section>
      )}

      {data && card && (
        <>
          <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
            source format <span className="font-mono">{data.sourceFormat}</span> · added{' '}
            {new Date(data.createdAt).toLocaleDateString()}
          </p>

          <section className="card flex items-center gap-3 p-3">
            <Avatar
              src={avatarPreview ?? storedAvatar}
              name={value('name') || '?'}
              className="chip"
              style={{ width: 64, height: 64, fontSize: 'var(--text-lg)' }}
            />
            <div className="flex min-w-0 flex-1 flex-wrap gap-2">
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                {data.avatar ? 'Replace image' : 'Upload image'}
              </button>
              {(data.avatar || avatar) && !removeAvatar && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAvatar(null);
                    setAvatarPreview(null);
                    setRemoveAvatar(true);
                  }}
                >
                  Remove
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void pickAvatar(file);
                }}
              />
              {removeAvatar && (
                <span className="self-center text-[var(--font-xs)] text-[var(--ink-dim)]">
                  removed on save
                </span>
              )}
            </div>
          </section>

          <section className="card space-y-1 p-3 text-[var(--font-sm)]">
            <p>
              <span className="font-mono text-[var(--accent)]">{ready ? permanent : '—'}</span>{' '}
              permanent tokens — paid on every turn, forever.
            </p>
            <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
              {ready ? perTurn : '—'} tokens per turn in total, including system_prompt,
              mes_example, post_history_instructions
              {ready && loreTokens > 0 && ` and ${loreTokens} of always-on character book`}.
            </p>
            <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
              first_mes {ready ? tokensOf(value('firstMes')) : '—'} — one-time cost, it becomes the
              opening message. mes_example and post_history_instructions are <em>not</em> one-time:
              they are re-sent on every request.
            </p>
            {!ready && (
              <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                Counting tokens — the exact vocabulary is a 2.3 MB download and loads only on this
                screen.
              </p>
            )}
          </section>

          {FIELDS.map((field) => (
            <label key={String(field.key)} className="block space-y-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[var(--font-sm)] font-medium">{field.label}</span>
                <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                  {field.cost} ·{' '}
                  <span className="font-mono">
                    {ready ? `${tokensOf(value(field.key))} tok` : '—'}
                  </span>
                </span>
              </span>
              {field.rows === 1 ? (
                <input
                  className="field"
                  value={value(field.key)}
                  onChange={(event) => setEdits({ ...edits, [String(field.key)]: event.target.value })}
                />
              ) : (
                <textarea
                  className="field"
                  rows={field.rows}
                  value={value(field.key)}
                  onChange={(event) => setEdits({ ...edits, [String(field.key)]: event.target.value })}
                />
              )}
            </label>
          ))}

          <label className="block space-y-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[var(--font-sm)] font-medium">tags</span>
              <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                never sent · comma separated
              </span>
            </span>
            <input
              className="field"
              value={tagsText}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder="cartographer, tavern"
            />
          </label>

          <GreetingsEditor
            greetings={greetings}
            onChange={setGreetings}
            countTokens={(text) => tokensOf(text)}
          />

          <label className="block space-y-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[var(--font-sm)] font-medium">character_book</span>
              <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                JSON · always-on entries cost every turn
              </span>
            </span>
            <textarea
              className="field font-mono text-[var(--font-xs)]"
              rows={6}
              value={bookText}
              onChange={(event) => setBookText(event.target.value)}
              placeholder="{} — empty means no world info"
            />
            {parsedBook.error ? (
              <span className="text-[var(--font-xs)] text-[var(--danger)]">{parsedBook.error}</span>
            ) : (
              <span className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                {parsedBook.value === null
                  ? 'none'
                  : `${parseLorebook(parsedBook.value).length} entries`}
              </span>
            )}
          </label>

          {failure && <p className="text-sm text-[var(--danger)]">{failure}</p>}
          {status && <p className="text-sm text-[var(--ink-dim)]">{status}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn" onClick={() => void fork()} disabled={busy}>
              Fork
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** An untyped object field edited as text: parsed on every render so the error shows live. */
function parseBook(text: string): { value: unknown; error: string | null } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { value: null, error: null };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, error: 'character_book must be a JSON object, or empty for none.' };
    }
    return { value, error: null };
  } catch (cause) {
    return { value: null, error: `character_book is not valid JSON: ${messageOf(cause)}` };
  }
}
