import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiJson } from '../lib/api';
import { alwaysOnLore, parseLorebook } from '../lib/cards/lorebook';
import { CARD_FIELD_ROWS } from '../lib/cards/fields';
import type { CharacterCardJson, GreetingState } from '../lib/cards/types';
import { loadTokenCounter } from '../lib/tokenizerClient';
import { messageOf, useAsync } from '../lib/hooks';
import { useToast } from '../components/Toast';
import { GreetingsEditor, GreetingStateFields } from '../components/GreetingsEditor';
import { Avatar } from '../components/Avatar';
import { NamePrompt } from '../components/NamePrompt';
import { AppBar, BackLink, CrumbSep } from '../components/AppBar';

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
    rows: CARD_FIELD_ROWS.name,
    cost: 'the card’s title — what the library lists',
  },
  {
    key: 'nickname',
    label: 'shown name',
    rows: CARD_FIELD_ROWS.nickname,
    cost: 'what the transcript calls them · falls back to name',
  },
  { key: 'description', label: 'description', rows: CARD_FIELD_ROWS.description, cost: 'every turn' },
  { key: 'personality', label: 'personality', rows: CARD_FIELD_ROWS.personality, cost: 'every turn' },
  { key: 'scenario', label: 'scenario', rows: CARD_FIELD_ROWS.scenario, cost: 'every turn' },
  {
    key: 'systemPrompt',
    label: 'system_prompt',
    rows: CARD_FIELD_ROWS.systemPrompt,
    cost: 'every turn — replaces the global system prompt',
  },
  {
    key: 'mesExample',
    label: 'mes_example',
    rows: CARD_FIELD_ROWS.mesExample,
    cost: 'every turn — in the prompt head',
  },
  {
    key: 'postHistoryInstructions',
    label: 'post_history_instructions',
    rows: CARD_FIELD_ROWS.postHistoryInstructions,
    cost: 'every turn — in the prompt tail',
  },
  {
    key: 'firstMes',
    label: 'first_mes',
    rows: CARD_FIELD_ROWS.firstMes,
    cost: 'one-time — the opening message',
  },
  { key: 'creatorNotes', label: 'creator_notes', rows: CARD_FIELD_ROWS.creatorNotes, cost: 'never sent' },
];

const PERMANENT: TextField[] = ['name', 'description', 'personality', 'scenario'];

/**
 * The form's sections, in the order a card is written rather than the order the JSON
 * happens to list its keys: who they are, what they are, how the model is told, how the
 * scene opens, what the world knows, and the card's own paperwork.
 */
const GROUPS: Array<{ title: string; fields: TextField[] }> = [
  { title: 'Identity', fields: ['name', 'nickname'] },
  { title: 'Definition', fields: ['description', 'personality', 'scenario'] },
  { title: 'Prompt', fields: ['systemPrompt', 'mesExample', 'postHistoryInstructions'] },
  { title: 'Greetings', fields: ['firstMes'] },
  { title: 'Book', fields: [] },
  { title: 'Meta', fields: ['creatorNotes'] },
];

const byKey: Partial<Record<TextField, (typeof FIELDS)[number]>> = Object.fromEntries(
  FIELDS.map((field) => [field.key, field]),
);

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
  const [greetingStates, setGreetingStates] = useState<GreetingState[]>([]);
  const [bookText, setBookText] = useState('');
  const [avatar, setAvatar] = useState<{ contentType: string; dataBase64: string } | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [count, setCount] = useState<((text: string) => number) | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the fork name sheet is open. The suggested name is read from the form when
  // the sheet renders, so nothing has to be captured when it opens.
  const [forkOpen, setForkOpen] = useState(false);
  // Validation failures (an empty name, an oversized avatar, a broken lorebook) stay
  // inline, because they point at the field that caused them. Save failures go to a toast.
  const [failure, setFailure] = useState<string | null>(null);
  const toast = useToast();

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
    setGreetingStates(data.card?.greetingStates ?? []);
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
    try {
      const next: CharacterCardJson = { ...card, name };
      for (const field of FIELDS) {
        const edited = edits[field.key];
        // `name` is already applied, trimmed; a blank name is rejected above.
        if (field.key !== 'name' && edited !== undefined) next[field.key] = edited;
      }
      next.tags = splitTags(tagsText);

      // Paired BEFORE the empty filter, so dropping a blank alternate drops its scene with
      // it instead of shifting every later scene onto the wrong opening. This is the
      // second off-by-one trap in this file.
      const alternates = greetings
        .map((content, index) => ({ content: content.trim(), state: greetingStates[index + 1] ?? {} }))
        .filter((entry) => entry.content.length > 0);

      next.alternateGreetings = alternates.map((entry) => entry.content);
      // Index 0 is `first_mes`; trimmed, and an all-blank entry stays `{}` so indices hold.
      next.greetingStates = [greetingStates[0] ?? {}, ...alternates.map((entry) => entry.state)].map(
        (entry) => {
          const out: GreetingState = {};
          for (const field of ['time', 'location', 'weather'] as const) {
            const value = entry[field]?.trim();
            if (value) out[field] = value;
          }
          return out;
        },
      );
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

      toast.success('Character saved.');
      reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  async function fork(name: string) {
    if (!card) return;

    setBusy(true);
    setFailure(null);
    try {
      const created = await apiJson<{ id: string }>(`/api/characters/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        body: JSON.stringify({ id, name }),
      });
      toast.success(`Forked as "${name}".`);
      navigate(`/characters/${created.id}/edit`);
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
      setForkOpen(false);
    }
  }

  async function pickAvatar(file: File) {
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
    <>
      <AppBar
        lead={<BackLink to="/characters" label="Characters" />}
        title={
          <>
            <CrumbSep />
            <span className="bar-title">{value('name') || data?.name || 'Character'}</span>
          </>
        }
      />

      <main className="sheet">
        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}

        {data && !card && (
          <>
            <div className="sheet-head">
              <div>
                <h1 className="title">{data.name}</h1>
                <p className="sheet-sub">
                  source format <span className="data">{data.sourceFormat}</span> · added{' '}
                  {new Date(data.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
            <div className="note danger">
              This character&rsquo;s stored card is not valid JSON, so the editor cannot show it as
              fields. Nothing has been overwritten — the raw text is below. Re-import the card to
              repair it.
            </div>
            <pre className="md-pre" style={{ marginTop: 14, whiteSpace: 'pre-wrap' }}>
              {data.cardJson}
            </pre>
            <div style={{ marginTop: 16 }}>
              <Link to="/characters/new" className="btn primary">
                Import the card again
              </Link>
            </div>
          </>
        )}

        {data && card && (
          <>
            <div className="sheet-head">
              <div>
                <h1 className="title">{value('name') || data.name}</h1>
                <p className="sheet-sub">
                  source format <span className="data">{data.sourceFormat}</span> · added{' '}
                  {new Date(data.createdAt).toLocaleDateString()}
                </p>
              </div>
              {/* No actions here. The row at the foot of the form is the single place this
                  sheet commits — it carries Save, Fork and the way back, so a Save in the
                  header was the same button twice with a scroll between them. The
                  invalid-card branch above has always been header-only. */}
            </div>

            <div className="panel panel-pad" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {/* Zoomable, like every other portrait in the app. It is also the only way to
                  see a newly-picked image at full size before committing it: the buttons
                  beside it replace and remove, and neither one shows you what you chose. */}
              <Avatar
                src={avatarPreview ?? storedAvatar}
                name={value('name') || '?'}
                className="chip"
                style={{ width: 64, height: 64, fontSize: 'var(--text-lg)' }}
                zoomable
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="eyebrow">Portrait</div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 8,
                  }}
                >
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
                  {removeAvatar && <span className="form-hint">removed on save</span>}
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
                </div>
              </div>
            </div>

            <section className="section">
              <span className="eyebrow">What this costs</span>
              <div className="panel panel-pad">
                <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
                  <span
                    className="data"
                    style={{ fontSize: 'var(--text-lg)', color: 'var(--brass)' }}
                  >
                    {ready ? permanent : '—'}
                  </span>{' '}
                  permanent tokens — paid on every turn, forever.
                </p>
                <p className="form-hint" style={{ marginTop: 6 }}>
                  {ready ? perTurn : '—'} tokens per turn in total, including system_prompt,
                  mes_example, post_history_instructions
                  {ready && loreTokens > 0 && ` and ${loreTokens} of always-on character book`}.
                </p>
                <p className="form-hint" style={{ marginTop: 6 }}>
                  first_mes {ready ? tokensOf(value('firstMes')) : '—'} — one-time cost, it becomes
                  the opening message. mes_example and post_history_instructions are <em>not</em>{' '}
                  one-time: they are re-sent on every request.
                </p>
                {!ready && (
                  <p className="form-hint" style={{ marginTop: 6 }}>
                    Counting tokens — the exact vocabulary is a 2.3 MB download and loads only on
                    this screen.
                  </p>
                )}
              </div>
            </section>

            {GROUPS.map((group) => (
              <section key={group.title} className="section">
                <span className="eyebrow">{group.title}</span>

                {group.fields.map((key) => {
                  const field = byKey[key];
                  if (!field) return null;
                  return (
                    <label key={String(key)} className="form-row">
                      <span className="form-label">
                        <span>{field.label}</span>
                        <span className="data">{ready ? `${tokensOf(value(key))} tok` : '—'}</span>
                      </span>
                      <span className="form-hint" style={{ display: 'block', marginBottom: 5 }}>
                        {field.cost}
                      </span>
                      {field.rows === 1 ? (
                        <input
                          className="field"
                          value={value(key)}
                          onChange={(event) => setEdits({ ...edits, [String(key)]: event.target.value })}
                        />
                      ) : (
                        <textarea
                          className="field"
                          rows={field.rows}
                          value={value(key)}
                          onChange={(event) => setEdits({ ...edits, [String(key)]: event.target.value })}
                        />
                      )}
                    </label>
                  );
                })}

                {group.title === 'Greetings' && (
                  <>
                    <GreetingStateFields
                      value={greetingStates[0] ?? {}}
                      onChange={(patch) =>
                        setGreetingStates([
                          { ...greetingStates[0], ...patch },
                          ...greetingStates.slice(1),
                        ])
                      }
                      idPrefix="first"
                    />
                    <GreetingsEditor
                      greetings={greetings}
                      onChange={setGreetings}
                      states={greetingStates.slice(1)}
                      onStatesChange={(next) => setGreetingStates([greetingStates[0] ?? {}, ...next])}
                      countTokens={(text) => tokensOf(text)}
                    />
                  </>
                )}

                {group.title === 'Book' && (
                  <label className="form-row">
                    <span className="form-label">
                      <span>character_book</span>
                      <span className="data">
                        {parsedBook.value === null
                          ? '—'
                          : `${parseLorebook(parsedBook.value).length} entries`}
                      </span>
                    </span>
                    <span className="form-hint" style={{ display: 'block', marginBottom: 5 }}>
                      JSON · always-on entries cost every turn
                    </span>
                    <textarea
                      className="field"
                      style={{ fontFamily: 'var(--font-data)', fontSize: 'var(--text-xs)' }}
                      rows={6}
                      value={bookText}
                      onChange={(event) => setBookText(event.target.value)}
                      placeholder="{} — empty means no world info"
                    />
                    {parsedBook.error ? (
                      <span
                        className="form-hint"
                        style={{ display: 'block', marginTop: 5, color: 'var(--danger)' }}
                      >
                        {parsedBook.error}
                      </span>
                    ) : (
                      <span className="form-hint" style={{ display: 'block', marginTop: 5 }}>
                        {parsedBook.value === null
                          ? 'none — the prompt carries no world info from this card'
                          : `${parseLorebook(parsedBook.value).length} entries`}
                      </span>
                    )}
                  </label>
                )}

                {group.title === 'Meta' && (
                  <label className="form-row">
                    <span className="form-label">
                      <span>tags</span>
                    </span>
                    <span className="form-hint" style={{ display: 'block', marginBottom: 5 }}>
                      never sent · comma separated
                    </span>
                    <input
                      className="field"
                      value={tagsText}
                      onChange={(event) => setTagsText(event.target.value)}
                      placeholder="cartographer, tavern"
                    />
                  </label>
                )}
              </section>
            ))}

            {failure && <div className="note danger" style={{ marginTop: 20 }}>{failure}</div>}

            {/* Sticky, like the chat composer. This sheet is 2,600px tall and committing it
                used to mean scrolling to the very bottom — which is why the header grew a
                second Save button that then had to be removed for being the same button
                twice. Pinning the one row keeps it reachable from anywhere in the form
                without duplicating it. */}
            <div className="sheet-commit">
              <button
                type="button"
                className="btn primary"
                onClick={() => void save()}
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" className="btn" onClick={() => setForkOpen(true)} disabled={busy}>
                Fork
              </button>
              <Link to="/characters" className="btn quiet">
                Back to the library
              </Link>
            </div>

            {forkOpen && (
              <NamePrompt
                title="Fork this character"
                label="Name for the copy"
                initial={`${value('name')} (copy)`}
                busy={busy}
                onSubmit={(name) => void fork(name)}
                onCancel={() => setForkOpen(false)}
              />
            )}
          </>
        )}
      </main>
    </>
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
