import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiJson } from '../lib/api';
import { parseJsonCard } from '../lib/cards/import';
import type { ParsedCard } from '../lib/cards/types';
import type { TokenCostReport } from '../lib/forge/tokenCost';
import { messageOf, useAsync } from '../lib/hooks';
import { estimateTokens } from '../lib/tokenEstimate';
import { loadTokenCounter } from '../lib/tokenizerClient';

/** A card the Worker returned alongside the row it came from. */
interface ForgeCard {
  id: string;
  name: string;
  card: ParsedCard;
}

/** What a tool is currently pointed at, whether it was picked or pasted. */
interface Picked {
  name: string;
  card: ParsedCard;
}

type Tool = 'draft' | 'critique' | 'tokens';
type SuggestField = 'tags' | 'alternate_greetings' | 'first_mes';

const TABS: Array<{ id: Tool; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'critique', label: 'Critique' },
  { id: 'tokens', label: 'Token cost' },
];

/** Permanent = the fields `assemble` re-sends in the character block on every turn. */
const PERMANENT: Array<keyof ParsedCard> = ['name', 'description', 'personality', 'scenario'];

/** The prose fields, in card order. `firstMes` sits last because it is the exception. */
const TEXT_FIELDS: Array<{ key: keyof ParsedCard; label: string; rows: number }> = [
  { key: 'description', label: 'description', rows: 5 },
  { key: 'personality', label: 'personality', rows: 4 },
  { key: 'scenario', label: 'scenario', rows: 3 },
  { key: 'systemPrompt', label: 'system_prompt', rows: 3 },
  { key: 'mesExample', label: 'mes_example', rows: 5 },
  { key: 'postHistoryInstructions', label: 'post_history_instructions', rows: 2 },
  { key: 'firstMes', label: 'first_mes', rows: 5 },
  { key: 'creatorNotes', label: 'creator_notes', rows: 2 },
];

/**
 * The forge: draft a card, review one, or price one.
 *
 * Three tools rather than three screens because they are used in sequence — a card is
 * drafted, then read for smuggled instructions, then priced — and moving between them
 * should not lose the card.
 *
 * Two of the three cost nothing. `Token cost` is arithmetic on the Worker and
 * `Critique`'s smuggled-instruction scan is a deterministic regex pass, so both work on
 * a fresh install with no provider key and no cheap model. Only drafting, the model's
 * half of the critique, and the suggestion helpers need a model, and only those are the
 * ones that say so when one is not configured.
 */
export default function Forge() {
  const [tool, setTool] = useState<Tool>('draft');
  const [count, setCount] = useState<((text: string) => number) | null>(null);

  const cards = useAsync(() => apiJson<ForgeCard[]>('/api/forge/cards'), []);

  // The exact vocabulary is 2.3 MB, so it loads only on this screen — the same trade
  // the character editor makes. Until it arrives the readout falls back to the
  // Worker's estimator and says so, rather than showing a confident wrong number.
  useEffect(() => {
    let alive = true;
    void loadTokenCounter().then((fn) => {
      if (alive) setCount(() => fn);
    });
    return () => {
      alive = false;
    };
  }, []);

  const counter = count ?? estimateTokens;

  return (
    <main className="mx-auto max-w-2xl space-y-5 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-[var(--font-lg)] font-semibold">Forge</h1>
        <nav className="flex gap-3">
          <Link to="/characters" className="app-link">
            Characters
          </Link>
          <Link to="/" className="app-link">
            Chats
          </Link>
        </nav>
      </header>

      <nav className="flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`btn min-h-10 ${tool === tab.id ? 'primary' : ''}`}
            onClick={() => setTool(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {tool === 'draft' && <DraftTool counter={counter} exact={count !== null} />}
      {tool !== 'draft' && (
        <>
          {cards.loading && <p className="text-sm text-[var(--ink-dim)]">Loading characters…</p>}
          {cards.error && (
            <p className="text-sm text-[var(--danger)]">
              {cards.error} — pasting a card still works.
            </p>
          )}
          {tool === 'critique' && <CritiqueTool cards={cards.data ?? []} />}
          {tool === 'tokens' && <TokensTool cards={cards.data ?? []} />}
        </>
      )}
    </main>
  );
}

/**
 * Picking a card or pasting one, shared by the two tools that take an existing card.
 *
 * The card is only committed when it is complete: a picker fires on change, and a
 * pasted card fires on a button. That keeps a half-typed JSON paste from becoming a
 * request per keystroke, and keeps the two tools reacting to a card rather than to the
 * text of one.
 */
function CardSource({
  cards,
  onSelect,
}: {
  cards: ForgeCard[];
  onSelect: (picked: Picked | null) => void;
}) {
  const [pickId, setPickId] = useState('');
  const [paste, setPaste] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function pick(id: string) {
    setPickId(id);
    setProblem(null);
    const found = cards.find((entry) => entry.id === id);
    onSelect(found ? { name: found.name, card: found.card } : null);
  }

  function usePasted() {
    setProblem(null);
    const text = paste.trim();
    if (text.length === 0) {
      setProblem('Paste a card JSON first.');
      return;
    }
    try {
      // The same parser the importer uses, so a pasted card is read exactly as a
      // dropped file is — envelope unwrapped, every field mapped.
      const card = parseJsonCard(text, 'ccv2');
      setPickId('paste');
      onSelect({ name: card.name, card });
    } catch (cause) {
      setProblem(messageOf(cause));
    }
  }

  return (
    <div className="space-y-2">
      <select
        className="field min-h-10"
        value={pickId}
        onChange={(event) => pick(event.target.value)}
      >
        <option value="">— pick a character —</option>
        {cards.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
        <option value="paste">Paste a card JSON…</option>
      </select>

      {pickId === 'paste' && (
        <>
          <textarea
            className="field"
            rows={6}
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            placeholder='{"name": "…", "description": "…"}'
          />
          <button type="button" className="btn min-h-10" onClick={usePasted}>
            Use this card
          </button>
        </>
      )}

      {problem && <p className="text-sm text-[var(--danger)]">{problem}</p>}
    </div>
  );
}

function DraftTool({
  counter,
  exact,
}: {
  counter: (text: string) => number;
  exact: boolean;
}) {
  const [brief, setBrief] = useState('');
  const [card, setCard] = useState<ParsedCard | null>(null);
  const [tagsText, setTagsText] = useState('');
  const [greetingsText, setGreetingsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState<SuggestField | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /**
   * Array fields are held as text while editing and parsed on use. Splitting a joined
   * string on every keystroke would delete the comma the moment it is typed, which
   * makes a list impossible to type.
   */
  const edited: ParsedCard | null = card
    ? {
        ...card,
        tags: tagsText
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
        alternateGreetings: greetingsText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      }
    : null;

  async function run() {
    const description = brief.trim();
    if (description.length === 0) return;
    setBusy(true);
    setProblem(null);
    setStatus(null);
    try {
      const drafted = await apiJson<ParsedCard>('/api/forge/draft', {
        method: 'POST',
        body: JSON.stringify({ description }),
      });
      setCard(drafted);
      setTagsText(drafted.tags.join(', '));
      setGreetingsText(drafted.alternateGreetings.join('\n'));
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!edited) return;
    setBusy(true);
    setProblem(null);
    setStatus(null);
    try {
      const created = await apiJson<{ id: string; name: string }>('/api/characters', {
        method: 'POST',
        body: JSON.stringify({ card: edited }),
      });
      setStatus(`Saved "${created.name}". It is in the character list.`);
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function suggest(field: SuggestField) {
    if (!edited) return;
    setSuggesting(field);
    setProblem(null);
    setStatus(null);
    try {
      const { suggestions } = await apiJson<{ suggestions: string[] }>('/api/forge/suggest', {
        method: 'POST',
        body: JSON.stringify({ card: edited, field }),
      });

      if (suggestions.length === 0) {
        setStatus('The model had nothing to add.');
        return;
      }

      if (field === 'tags') {
        const merged = [...edited.tags];
        for (const tag of suggestions) if (!merged.includes(tag)) merged.push(tag);
        setTagsText(merged.join(', '));
        setStatus(`Added ${merged.length - edited.tags.length} tags.`);
      } else if (field === 'alternate_greetings') {
        setGreetingsText([...edited.alternateGreetings, ...suggestions].join('\n'));
        setStatus(`Added ${suggestions.length} alternate greetings.`);
      } else {
        // A suggestion is a proposal, so the drafted opening is moved rather than
        // discarded — losing it to one click would be a silent edit.
        setGreetingsText([edited.firstMes, ...edited.alternateGreetings].filter(Boolean).join('\n'));
        setCard((previous) => (previous ? { ...previous, firstMes: suggestions[0] } : previous));
        setStatus('New opening set; the previous one was kept as an alternate greeting.');
      }
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setSuggesting(null);
    }
  }

  const permanent = edited
    ? PERMANENT.reduce((sum, field) => sum + counter(String(edited[field] ?? '')), 0)
    : 0;

  return (
    <section className="space-y-4">
      <label className="block space-y-1">
        <span className="text-[var(--font-sm)] font-medium">One-line premise</span>
        <textarea
          className="field"
          rows={2}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="A retired cartographer who refuses to admit the maps are wrong."
        />
      </label>

      <button
        type="button"
        className="btn primary min-h-10"
        onClick={() => void run()}
        disabled={busy || brief.trim().length === 0}
      >
        {busy ? 'Drafting…' : 'Draft a card'}
      </button>

      {problem && <p className="text-sm text-[var(--danger)]">{problem}</p>}
      {status && <p className="text-sm text-[var(--ink-dim)]">{status}</p>}

      {edited && (
        <>
          <div className="card space-y-1 p-3 text-[var(--font-sm)]">
            <p>
              <span className="font-mono text-[var(--accent)]">{permanent}</span> permanent tokens
              — paid on every turn, forever.
            </p>
            <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
              first_mes {counter(edited.firstMes)} — the only true one-time cost: it becomes the
              chat's opening message rather than prompt text.
            </p>
            <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
              mes_example {counter(edited.mesExample)} and post_history_instructions{' '}
              {counter(edited.postHistoryInstructions)} are <em>not</em> one-time despite reading
              that way — <code className="md-code">assemble()</code> emits mesExample in the prompt
              head and post_history_instructions in the tail, so both are re-sent every turn.
            </p>
            <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
              counted with{' '}
              {exact
                ? 'the exact o200k_base vocabulary'
                : "the Worker's estimator — the exact vocabulary is still loading"}
            </p>
          </div>

          <label className="block space-y-1">
            <span className="flex items-baseline justify-between text-[var(--font-sm)]">
              <span className="font-medium">name</span>
              <span className="font-mono text-[var(--font-xs)] text-[var(--ink-faint)]">
                {counter(edited.name)} tok
              </span>
            </span>
            <input
              className="field min-h-10"
              value={edited.name}
              onChange={(event) =>
                setCard((previous) =>
                  previous ? { ...previous, name: event.target.value } : previous,
                )
              }
            />
          </label>

          {TEXT_FIELDS.map((field) => (
            <div key={String(field.key)} className="space-y-1">
              <label className="block space-y-1">
                <span className="flex items-baseline justify-between text-[var(--font-sm)]">
                  <span className="font-medium">{field.label}</span>
                  <span className="font-mono text-[var(--font-xs)] text-[var(--ink-faint)]">
                    {counter(String(edited[field.key] ?? ''))} tok
                  </span>
                </span>
                <textarea
                  className="field"
                  rows={field.rows}
                  value={String(edited[field.key] ?? '')}
                  onChange={(event) =>
                    setCard((previous) =>
                      previous ? { ...previous, [field.key]: event.target.value } : previous,
                    )
                  }
                />
              </label>
              {field.key === 'mesExample' && (
                <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                  re-sent every turn — it lives in the cached prompt head
                </p>
              )}
              {field.key === 'postHistoryInstructions' && (
                <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                  re-sent every turn — it lives in the prompt tail
                </p>
              )}
              {field.key === 'firstMes' && (
                <button
                  type="button"
                  className="btn min-h-10"
                  onClick={() => void suggest('first_mes')}
                  disabled={suggesting !== null}
                >
                  {suggesting === 'first_mes' ? 'Asking…' : 'Suggest an opening'}
                </button>
              )}
            </div>
          ))}

          <div className="space-y-1">
            <label className="block space-y-1">
              <span className="flex items-baseline justify-between text-[var(--font-sm)]">
                <span className="font-medium">tags</span>
                <span className="font-mono text-[var(--font-xs)] text-[var(--ink-faint)]">
                  {edited.tags.reduce((sum, tag) => sum + counter(tag), 0)} tok · never sent
                </span>
              </span>
              <input
                className="field min-h-10"
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
                placeholder="comma, separated, tags"
              />
            </label>
            <button
              type="button"
              className="btn min-h-10"
              onClick={() => void suggest('tags')}
              disabled={suggesting !== null}
            >
              {suggesting === 'tags' ? 'Asking…' : 'Suggest tags'}
            </button>
          </div>

          <div className="space-y-1">
            <label className="block space-y-1">
              <span className="flex items-baseline justify-between text-[var(--font-sm)]">
                <span className="font-medium">alternate_greetings</span>
                <span className="font-mono text-[var(--font-xs)] text-[var(--ink-faint)]">
                  {edited.alternateGreetings.reduce((sum, line) => sum + counter(line), 0)} tok ·
                  never sent
                </span>
              </span>
              <textarea
                className="field"
                rows={5}
                value={greetingsText}
                onChange={(event) => setGreetingsText(event.target.value)}
                placeholder="one per line"
              />
            </label>
            <button
              type="button"
              className="btn min-h-10"
              onClick={() => void suggest('alternate_greetings')}
              disabled={suggesting !== null}
            >
              {suggesting === 'alternate_greetings' ? 'Asking…' : 'Suggest greetings'}
            </button>
          </div>

          <button
            type="button"
            className="btn primary min-h-10"
            onClick={() => void save()}
            disabled={busy || edited.name.trim().length === 0}
          >
            {busy ? 'Saving…' : 'Save character'}
          </button>
        </>
      )}
    </section>
  );
}

function CritiqueTool({ cards }: { cards: ForgeCard[] }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [local, setLocal] = useState<string[] | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [result, setResult] = useState<{ critique: string; smuggledInstructions: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * The deterministic scan runs the moment a card is chosen: it needs no model, costs
   * nothing, and is the headline finding. The model's own list only ever adds to it, so
   * there is no reason to wait for a paid call to see it.
   */
  useEffect(() => {
    setResult(null);
    setLocal(null);
    setProblem(null);
    if (!picked) return;

    let alive = true;
    setLocalBusy(true);
    apiJson<{ smuggledInstructions: string[] }>('/api/forge/smuggle', {
      method: 'POST',
      body: JSON.stringify({ card: picked.card }),
    })
      .then((payload) => {
        if (alive) setLocal(payload.smuggledInstructions);
      })
      .catch((cause: unknown) => {
        if (alive) setProblem(messageOf(cause));
      })
      .finally(() => {
        if (alive) setLocalBusy(false);
      });

    return () => {
      alive = false;
    };
  }, [picked]);

  async function run() {
    if (!picked) return;
    setBusy(true);
    setProblem(null);
    try {
      setResult(
        await apiJson<{ critique: string; smuggledInstructions: string[] }>('/api/forge/critique', {
          method: 'POST',
          body: JSON.stringify({ card: picked.card }),
        }),
      );
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const smuggled = result ? result.smuggledInstructions : (local ?? []);

  return (
    <section className="space-y-4">
      <CardSource cards={cards} onSelect={setPicked} />

      {picked && (
        <button type="button" className="btn primary min-h-10" onClick={() => void run()} disabled={busy}>
          {busy ? 'Reviewing…' : `Critique "${picked.name}"`}
        </button>
      )}

      {problem && <p className="text-sm text-[var(--danger)]">{problem}</p>}

      {picked && (
        <section className="card space-y-2 border-[var(--danger)] p-3">
          <h2 className="text-[var(--font-sm)] font-semibold">
            Instructions smuggled into description or personality
            {localBusy ? '' : ` — ${smuggled.length}`}
          </h2>
          <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
            Behavioural directives belong in <code className="md-code">system_prompt</code> or{' '}
            <code className="md-code">post_history_instructions</code>. In a description they are
            paid on every turn and read as characterisation, which is why they are the loudest
            complaint about published cards. This scan is a local regex pass — no model, no cost,
            same answer every time.
          </p>

          {localBusy && <p className="text-sm text-[var(--ink-dim)]">Scanning…</p>}

          {!localBusy && smuggled.length === 0 && (
            <p className="text-sm text-[var(--good)]">
              None found. The description and personality read as description.
            </p>
          )}

          {smuggled.length > 0 && (
            <ul className="space-y-1">
              {smuggled.map((item) => (
                <li
                  key={item}
                  className="border-l-2 border-[var(--danger)] pl-2 text-[var(--font-sm)]"
                >
                  “{item}”
                </li>
              ))}
            </ul>
          )}

          {result && (
            <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
              {local?.length ?? 0} found by the local scan; {result.smuggledInstructions.length} in
              total after the model's pass.
            </p>
          )}
        </section>
      )}

      {result && (
        <section className="space-y-2">
          <h2 className="text-[var(--font-sm)] font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
            Critique
          </h2>
          <p className="card p-3 text-[var(--font-sm)] whitespace-pre-wrap">{result.critique}</p>
        </section>
      )}

      {!picked && (
        <p className="text-sm text-[var(--ink-dim)]">Pick or paste a card to review it.</p>
      )}
    </section>
  );
}

function TokensTool({ cards }: { cards: ForgeCard[] }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [report, setReport] = useState<TokenCostReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Runs on selection rather than on a button: the endpoint is arithmetic on the
   * Worker with no model behind it, so there is nothing to spend and nothing to confirm.
   */
  useEffect(() => {
    setReport(null);
    setProblem(null);
    if (!picked) return;

    let alive = true;
    setBusy(true);
    apiJson<TokenCostReport>('/api/forge/tokens', {
      method: 'POST',
      body: JSON.stringify({ card: picked.card }),
    })
      .then((payload) => {
        if (alive) setReport(payload);
      })
      .catch((cause: unknown) => {
        if (alive) setProblem(messageOf(cause));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });

    return () => {
      alive = false;
    };
  }, [picked]);

  return (
    <section className="space-y-4">
      <CardSource cards={cards} onSelect={setPicked} />

      <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
        This reports <strong>cost</strong>, not quality. No controlled test holds a character
        constant while varying token count, so no optimal length is claimed — only what a field
        costs, and mechanical observations about the text (a phrase repeated three times, one
        paragraph longer than the rest combined). Needs no model and no provider key.
      </p>

      {busy && <p className="text-sm text-[var(--ink-dim)]">Counting…</p>}
      {problem && <p className="text-sm text-[var(--danger)]">{problem}</p>}

      {report && (
        <>
          <div className="card space-y-1 p-3 text-[var(--font-sm)]">
            <p>
              <span className="font-mono text-[var(--accent)]">{report.permanentPerTurn}</span>{' '}
              permanent tokens per turn ·{' '}
              <span className="font-mono">{report.oneTime}</span> one-time
            </p>
            <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
              {report.totalOverTurns} tokens over 500 turns. Counted on the Worker with its
              estimator, not the browser's exact vocabulary — expect a few percent between them.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[var(--font-sm)]">
              <thead>
                <tr className="text-left text-[var(--font-xs)] uppercase tracking-wide text-[var(--ink-faint)]">
                  <th className="py-1 pr-2 font-medium">Field</th>
                  <th className="py-1 pr-2 text-right font-medium">Tok</th>
                  <th className="py-1 pr-2 text-right font-medium">Per turn</th>
                  <th className="py-1 text-right font-medium">500×</th>
                </tr>
              </thead>
              <tbody>
                {report.fields.map((field) => (
                  <Fragment key={field.field}>
                    <tr className="border-t border-[var(--line)]">
                      <td className="py-1.5 pr-2 font-mono break-all">{field.field}</td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                        {field.tokens}
                      </td>
                      <td className="py-1.5 pr-2 text-right text-[var(--ink-dim)]">
                        {field.perTurn ? 'yes' : 'once'}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums">
                        {field.costOverTurns}
                      </td>
                    </tr>
                    {field.trimSuggestions.length > 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="pb-1.5 text-[var(--font-xs)] text-[var(--ink-dim)]"
                        >
                          {field.trimSuggestions.map((suggestion) => (
                            <span key={suggestion} className="block">
                              · {suggestion}
                            </span>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <section className="space-y-1">
            <h2 className="text-[var(--font-sm)] font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
              Notes
            </h2>
            <ul className="space-y-1">
              {report.notes.map((note) => (
                <li key={note} className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                  {note}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {!picked && <p className="text-sm text-[var(--ink-dim)]">Pick or paste a card to price it.</p>}
    </section>
  );
}
