import { useRef } from 'react';

/**
 * Alternate greetings, as a list of openings rather than one textarea.
 *
 * The textarea this replaces asked the reader to separate openings with blank lines,
 * which is not a format anything else uses and which silently mangles any greeting that
 * contains a blank line of its own — a two-paragraph opening became two openings. A card
 * can carry several; each is a complete alternative opening, and each deserves its own
 * box with its own token cost, because that is the unit you actually edit and delete.
 */
export interface GreetingsEditorProps {
  greetings: string[];
  onChange: (next: string[]) => void;
  countTokens: (text: string) => number;
}

export function GreetingsEditor({ greetings, onChange, countTokens }: GreetingsEditorProps) {
  const focused = useRef<number | null>(null);

  function update(index: number, value: string) {
    onChange(greetings.map((entry, i) => (i === index ? value : entry)));
  }

  function remove(index: number) {
    onChange(greetings.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...greetings, '']);
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
    onChange(next);
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
        </div>
      ))}

      <button type="button" className="btn" onClick={add}>
        Add an opening
      </button>
    </div>
  );
}
