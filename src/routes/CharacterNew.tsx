import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CardParseError, parseCardFile } from '../lib/cards/import';
import type { ParsedCard } from '../lib/cards/types';
import { loadTokenCounter } from '../lib/tokenizerClient';
import { apiJson } from '../lib/api';
import { messageOf } from '../lib/hooks';
import { AppBar, BackLink } from '../components/AppBar';

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

/** The editable string fields, grouped the way the edit screen groups them. */
const GROUPS: Array<{ title: string; hint: string; fields: Array<keyof ParsedCard> }> = [
  {
    title: 'Identity',
    hint: 'the card’s title, and what the transcript calls them',
    fields: ['name', 'nickname'],
  },
  {
    title: 'Definition',
    hint: 'sent every turn, in the cached prompt head — this is where a card’s character lives',
    fields: ['description', 'personality', 'scenario'],
  },
  {
    title: 'Prompt',
    hint: 'mes_example sits in the prompt head, post_history_instructions in the tail — both every turn',
    fields: ['systemPrompt', 'mesExample', 'postHistoryInstructions'],
  },
  {
    title: 'Greetings',
    hint: 'first_mes is one-time — it becomes the opening message',
    fields: ['firstMes'],
  },
  { title: 'Meta', hint: 'never sent', fields: ['creatorNotes'] },
];

/**
 * How tall each prose field is, in rows.
 *
 * `description` is where most cards keep the whole character, so it gets a page rather
 * than a slot — the field a reader spends real time in should not be the one they scroll
 * inside of. `first_mes` is the second: it is the scene's opening, and it is written and
 * rewritten the way prose is. The short fields stay short so the screen is scannable.
 */
const FIELD_ROWS: Partial<Record<keyof ParsedCard, number>> = {
  name: 1,
  nickname: 1,
  description: 22,
  personality: 6,
  scenario: 5,
  systemPrompt: 5,
  mesExample: 12,
  postHistoryInstructions: 4,
  firstMes: 16,
  creatorNotes: 3,
};

/** What each field is for. The two that are genuinely confusable get a real sentence. */
const FIELD_HINTS: Partial<Record<keyof ParsedCard, string>> = {
  description:
    'The character as written: who they are, how they speak, what they want. Most cards keep everything here.',
  personality:
    'A short trait list — “Precise. Dry. Impatient.” Cards that put the full character in the description often leave this empty; it is kept because imported cards use it.',
  scenario: 'The situation the scene opens in. Where and when, in the card’s own words.',
  firstMes: 'The first thing they say. This becomes the opening message of a new chat.',
  mesExample: 'Example dialogue showing how they sound. Re-sent every turn.',
  systemPrompt: 'Overrides your global system prompt for this character.',
  postHistoryInstructions: 'Sent after the history, every turn — the card’s final word on how to play it.',
};

/**
 * A card written from nothing rather than parsed from a file.
 *
 * Every field is present and empty, which is what the editor and `POST /api/characters`
 * both expect: `createCharacter` reads the whole mapped card, and a field left off would
 * be stored as `undefined` and read back as a missing key. `sourceFormat` is `ccv2`
 * because that is what the app writes when it exports — a card authored here is not a
 * conversion of anything.
 *
 * `raw` and `avatarHint` are null rather than an empty object or string: they mean "this
 * card had a source file and it is this", and this one did not.
 */
function blankCard(): ParsedCard {
  return {
    name: '',
    description: '',
    personality: '',
    scenario: '',
    firstMes: '',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    creatorNotes: '',
    tags: [],
    characterBook: null,
    sourceFormat: 'ccv2',
    avatarHint: null,
    raw: null,
  };
}

export default function CharacterNew() {
  const [params, setParams] = useSearchParams();

  // `?blank=1` opens the screen as a blank card to write rather than a file to import.
  // Whether the card was authored here is a fact about the card itself — an imported one
  // always carries the parsed source in `raw`, a blank one has nothing to carry — so the
  // mode is derived from that rather than tracked in a second state that could drift.
  const [card, setCard] = useState<ParsedCard | null>(() =>
    params.get('blank') === '1' ? blankCard() : null,
  );
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

  /**
   * Keeps the URL honest about which mode the screen is in. Without it, picking a file
   * from blank mode would leave `?blank=1` behind, and a reload would throw the parsed
   * card away and open an empty one.
   */
  function clearBlankParam() {
    if (params.has('blank')) setParams({}, { replace: true });
  }

  async function load(file: File) {
    clearBlankParam();
    setError(null);
    setAvatar(null);
    try {
      const parsed = await parseCardFile(file);
      setCard(parsed);
      // Dispatch on the bytes, not `file.type`. The browser infers the type from the
      // extension, so a card named `.card` or `.json` that is really a PNG reports the
      // wrong mime and would silently lose its avatar — while `parseCardFile` reads the
      // same file correctly by magic bytes. Two answers for one file is the bug.
      setAvatar(await extractAvatar(await file.arrayBuffer(), parsed.avatarHint));
    } catch (cause) {
      setCard(null);
      setError(cause instanceof CardParseError ? cause.message : messageOf(cause));
    }
  }

  /**
   * Drop the card and go back to the file importer. The query is cleared with it so a
   * reload lands where the screen actually is rather than resurrecting the blank card
   * that was just abandoned.
   */
  function startFromFile() {
    setCard(null);
    setAvatar(null);
    setError(null);
    clearBlankParam();
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
      setError(`Could not save the card: ${messageOf(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!card) {
    return (
      <>
        <AppBar
          lead={<BackLink to="/characters" label="Characters" />}
          title={<span className="bar-title">Import a card</span>}
        />
        <main className="sheet">
          <div className="sheet-head">
            <div>
              <h1 className="title">Import a card</h1>
              <p className="sheet-sub">
                The card keeps everything it arrived with: every field is parsed, shown and
                editable before it is stored.
              </p>
            </div>
          </div>

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
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                inputRef.current?.click();
              }
            }}
            className="empty"
            style={{
              cursor: 'pointer',
              borderStyle: 'dashed',
              borderColor: dragging ? 'var(--brass)' : 'var(--line-strong)',
              background: dragging
                ? 'color-mix(in srgb, var(--brass) 7%, transparent)'
                : 'transparent',
              padding: '48px 20px',
              transition: 'border-color 120ms ease, background-color 120ms ease',
            }}
          >
            <span
              className="eyebrow"
              style={{ display: 'block', color: dragging ? 'var(--brass)' : undefined }}
            >
              Drop a card here
            </span>
            <span
              style={{ display: 'block', marginTop: 10, fontSize: 'var(--text-sm)' }}
            >
              PNG, JSON or CharX. The portrait inside a PNG card comes with it.
            </span>
            <span
              className="form-hint"
              style={{ display: 'block', marginTop: 6 }}
            >
              or tap to choose a file
            </span>
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

          {error && (
            <div className="note danger" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
        </main>
      </>
    );
  }

  const tokensOf = count ?? (() => 0);
  const ready = count !== null;
  const permanent = PERMANENT.reduce((sum, field) => sum + tokensOf(card[field]), 0);

  function value(field: keyof ParsedCard): string {
    const raw = card?.[field];
    return typeof raw === 'string' ? raw : '';
  }

  function set(field: keyof ParsedCard, text: string) {
    setCard((current) => (current ? { ...current, [field]: text } : current));
  }

  // An imported card always carries the object it was parsed from; a card written here
  // has no source to carry, so `raw` is null. That is the whole difference between the
  // two modes, and reading it off the card means there is no second flag to fall out of
  // step with what is on screen.
  const authored = card.raw === null;

  return (
    <>
      <AppBar
        lead={<BackLink to="/characters" label="Characters" />}
        title={
          <span className="bar-title">
            {value('name') || (authored ? 'New character' : 'Import a card')}
          </span>
        }
      />

      <main className="sheet">
        <div className="sheet-head" style={{ flexWrap: 'wrap', rowGap: 12 }}>
          <div>
            <h1 className="title">
              {value('name') || (authored ? 'New character' : 'Untitled card')}
            </h1>
            <p className="sheet-sub">
              {authored ? (
                <>
                  written here · source format <span className="data">{card.sourceFormat}</span>
                </>
              ) : (
                <>
                  source format <span className="data">{card.sourceFormat}</span> · avatar{' '}
                  {avatar ? 'extracted from the card' : 'none'}
                </>
              )}
            </p>
          </div>
          <div className="row-actions" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="btn quiet" onClick={startFromFile}>
              {authored ? 'Start from a file instead' : 'Choose another file'}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || card.name.trim().length === 0}
              className="btn primary"
            >
              {saving ? 'Saving…' : 'Save character'}
            </button>
          </div>
        </div>

        <div className="panel panel-pad">
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            <span className="data" style={{ fontSize: 'var(--text-lg)', color: 'var(--brass)' }}>
              {ready ? permanent : '—'}
            </span>{' '}
            permanent tokens — paid on every turn, forever.
          </p>
          <p className="form-hint" style={{ marginTop: 6 }}>
            first_mes {ready ? tokensOf(card.firstMes) : '—'} — one-time cost, it becomes the
            opening message.
          </p>
          <p className="form-hint" style={{ marginTop: 6 }}>
            mes_example {ready ? tokensOf(card.mesExample) : '—'} — paid on <em>every</em> turn; it
            sits in the prompt head. post_history_instructions{' '}
            {ready ? tokensOf(card.postHistoryInstructions) : '—'} — every turn, in the tail.
          </p>
          {!ready && (
            <p className="form-hint" style={{ marginTop: 6 }}>
              Counting tokens — the exact vocabulary is a 2.3 MB download and loads only on this
              screen.
            </p>
          )}
        </div>

        {GROUPS.map((group) => (
          <section key={group.title} className="section">
            <span className="eyebrow">{group.title}</span>

            {group.fields.map((field) => (
              <Field
                key={String(field)}
                label={String(field)}
                hint={FIELD_HINTS[field] ?? group.hint}
                tokens={ready ? tokensOf(value(field)) : null}
              >
                <textarea
                  value={value(field)}
                  onChange={(event) => set(field, event.target.value)}
                  rows={FIELD_ROWS[field] ?? 4}
                  className="field"
                />
              </Field>
            ))}

            {group.title === 'Meta' && (
              <>
                {/* Editable here rather than only on the edit screen. A card that arrives
                    with the wrong tags or an opening you want to drop should not have to be
                    saved first and corrected second — that is two steps for one decision,
                    and the intermediate save is a card you did not want. */}
                <div className="form-row">
                  <span className="form-label">
                    <span>tags</span>
                    <span className="data">
                      {card.tags.length > 0 ? `${card.tags.length}` : '—'} · never sent
                    </span>
                  </span>
                  <input
                    className="field"
                    value={card.tags.join(', ')}
                    onChange={(event) =>
                      setCard((current) =>
                        current
                          ? {
                              ...current,
                              tags: event.target.value
                                .split(',')
                                .map((tag) => tag.trim())
                                .filter(Boolean),
                            }
                          : current,
                      )
                    }
                    placeholder="comma, separated, tags"
                  />
                </div>

                <div className="form-row">
                  <span className="form-label">
                    <span>alternate greetings</span>
                    <span className="data">{card.alternateGreetings.length} · never sent</span>
                  </span>
                  <textarea
                    className="field"
                    rows={8}
                    value={card.alternateGreetings.join('\n\n')}
                    onChange={(event) =>
                      setCard((current) =>
                        current
                          ? {
                              ...current,
                              alternateGreetings: event.target.value
                                .split(/\n{2,}/)
                                .map((entry) => entry.trim())
                                .filter(Boolean),
                            }
                          : current,
                      )
                    }
                    placeholder="one per paragraph — blank line between"
                  />
                  <p className="form-hint" style={{ marginTop: 6 }}>
                    Each is a separate opening, offered when a new chat starts. Separate them
                    with a blank line.
                  </p>
                </div>

                <div className="form-row">
                  <span className="form-label">
                    <span>character_book</span>
                    <span className="data">{card.characterBook ? 'present' : '—'}</span>
                  </span>
                  <span className="form-hint" style={{ display: 'block' }}>
                    {card.characterBook
                      ? 'stored with the card; always-on entries cost every turn'
                      : authored
                        ? 'no world info — the edit screen is where it is added'
                        : 'this card carries no world info'}
                  </span>
                </div>
              </>
            )}
          </section>
        ))}

        {error && (
          <div className="note danger" style={{ marginTop: 20 }}>
            {error}
          </div>
        )}

        <div className="row-actions" style={{ marginTop: 22 }}>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || card.name.trim().length === 0}
            className="btn primary"
          >
            {saving ? 'Saving…' : 'Save character'}
          </button>
          <Link to="/characters" className="btn quiet">
            Back to the library
          </Link>
        </div>
      </main>
    </>
  );
}

function Field({
  label,
  hint,
  tokens,
  children,
}: {
  label: string;
  hint: string;
  tokens: number | null;
  children: ReactNode;
}) {
  return (
    <label className="form-row">
      <span className="form-label">
        <span>{label}</span>
        <span className="data">{tokens === null ? '—' : `${tokens} tok`}</span>
      </span>
      <span className="form-hint" style={{ display: 'block', marginBottom: 5 }}>
        {hint}
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
async function extractAvatar(
  buffer: ArrayBuffer,
  hint: string | null,
): Promise<{ contentType: string; dataBase64: string } | null> {
  const bytes = new Uint8Array(buffer);

  // Only ship the image when it is comfortably under D1's 2 MB row limit. A large card
  // keeps its data in the card itself; the avatar is a nicety, not worth failing the
  // import over.
  if (bytes.length > 1_500_000) return null;

  // A card's own `avatar` field is a URL, not bytes, and is usually remote. Storing the
  // URL means the app fetches from a third party on every render, so it is only used
  // when it is a data URL we can decode inline.
  if (hint && hint.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(hint);
    if (match) return { contentType: match[1], dataBase64: match[2] };
  }

  // Otherwise use the PNG we were handed, which for a card file is the portrait.
  if (!isPng(bytes)) return null;

  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { contentType: 'image/png', dataBase64: btoa(binary) };
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}
