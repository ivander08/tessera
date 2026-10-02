import { useRef } from 'react';
import type { GreetingState } from '../lib/cards/types';

/**
 * The opening scene for one greeting: time, location, weather.
 *
 * Its own component because it appears twice — once for `first_mes` and once per alternate
 * — and the two must stay identical. Every field is optional: a greeting that states no
 * clock leaves `time` empty rather than inventing one.
 */
export function GreetingStateFields({
  value,
  onChange,
  idPrefix,
}: {
  value: GreetingState;
  onChange: (patch: GreetingState) => void;
  idPrefix: string;
}) {
  return (
    <div className="form-row" style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
      {(['time', 'location', 'weather'] as const).map((field) => (
        <label key={field} className="form-row" style={{ flex: '1 1 180px', margin: 0 }}>
          <span className="form-hint">{field}</span>
          <input
            className="field"
            data-greeting-state={`${idPrefix}-${field}`}
            value={value[field] ?? ''}
            placeholder={field === 'time' ? 'Friday, 27 February 2026, 05:35 AM' : ''}
            onChange={(event) => onChange({ [field]: event.target.value })}
          />
        </label>
      ))}
    </div>
  );
}

/**
 * Alternate greetings, as a list of openings rather than one textarea.
 *
 * The textarea this replaces asked the reader to separate openings with blank lines,
 * which is not a format anything else uses and which silently mangles any greeting that
 * contains a blank line of its own — a two-paragraph opening became two openings. A card
 * can carry several; each is a complete alternative opening, and each deserves its own
 * box with its own token cost, because that is the unit you actually edit and delete.
 *
 * Each opening also carries the scene it starts in. The two lists are index-aligned, so
 * every mutation here touches both — see `commit`.
 */
export interface GreetingsEditorProps {
  greetings: string[];
  onChange: (next: string[]) => void;
  /** Index-aligned with `greetings` — that is, `greetingStates` minus its `firstMes` entry. */
  states: GreetingState[];
  onStatesChange: (next: GreetingState[]) => void;
  countTokens: (text: string) => number;
}

export function GreetingsEditor({
  greetings,
  onChange,
  states,
  onStatesChange,
  countTokens,
}: GreetingsEditorProps) {
  const focused = useRef<number | null>(null);

  /** Every mutation touches both lists, so the pairing cannot drift. */
  function commit(nextGreetings: string[], nextStates: GreetingState[]) {
    onChange(nextGreetings);
    onStatesChange(nextStates);
  }

  function setState(index: number, patch: GreetingState) {
    onStatesChange(
      greetings.map((_, i) => (i === index ? { ...states[i], ...patch } : (states[i] ?? {}))),
    );
  }

  function update(index: number, value: string) {
    // Indices do not move, so the states need no rewrite — the pairing is already right.
    onChange(greetings.map((entry, i) => (i === index ? value : entry)));
  }

  function remove(index: number) {
    const kept = greetings.map((_, i) => i).filter((i) => i !== index);
    commit(
      kept.map((i) => greetings[i]),
      kept.map((i) => states[i] ?? {}),
    );
  }

  function add() {
    commit([...greetings, ''], [...greetings.map((_, i) => states[i] ?? {}), {}]);
    // Focus the new box on the next frame, once it exists.
    focused.current = greetings.length;
    requestAnimationFrame(() => {
      const node = document.querySelector<HTMLTextAreaElement>(`[data-greeting="${focused.current}"]`);
      node?.focus();
    });
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= greetings.length) return;
    const next = [...greetings];
    const [entry] = next.splice(index, 1);
    next.splice(target, 0, entry);

    const nextStates = greetings.map((_, i) => states[i] ?? {});
    const [moved] = nextStates.splice(index, 1);
    nextStates.splice(target, 0, moved);

    commit(next, nextStates);
  }

  return (
    <div className="form-row">
      <div className="form-label">
        <span>Alternate greetings</span>
        <span className="form-hint">
          {greetings.length === 0
            ? 'each is a separate opening the reader can pick'
            : `${greetings.length} ${greetings.length === 1 ? 'opening' : 'openings'}`}
        </span>
      </div>

      {greetings.map((greeting, index) => (
        <div key={index} className="panel" style={{ marginBottom: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 8px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span className="eyebrow" style={{ flex: 1 }}>
              Opening {index + 1}
            </span>
            <span className="data">{countTokens(greeting)} tok</span>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move opening ${index + 1} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move opening ${index + 1} down`}
              disabled={index === greetings.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove opening ${index + 1}`}
              onClick={() => remove(index)}
            >
              ×
            </button>
          </div>
          <textarea
            data-greeting={index}
            className="field"
            style={{ border: 0, borderRadius: 0, background: 'transparent' }}
            value={greeting}
            rows={Math.min(12, Math.max(3, greeting.split('\n').length + 1))}
            placeholder="*She looks up from the desk.* You are late."
            onChange={(event) => update(index, event.target.value)}
          />
          <div style={{ padding: '0 8px 10px' }}>
            <GreetingStateFields
              value={states[index] ?? {}}
              onChange={(patch) => setState(index, patch)}
              idPrefix={String(index)}
            />
          </div>
        </div>
      ))}

      <button type="button" className="btn" onClick={add}>
        Add an opening
      </button>
    </div>
  );
}
