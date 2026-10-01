import { useState } from 'react';

/**
 * The meters for the two structured world-state keys.
 *
 * A meter is a number the narrator maintains; editing one by hand is how you correct a
 * reading it got wrong, so this writes the same patch the engine does. Both components are
 * controlled — they take the current value and call `onChange` — and the parent owns the
 * state, because the parent is what builds the patch and knows when a save happened.
 */

type Bonds = Record<string, { bond?: number; sparks?: number; grudge?: number }>;
type Threads = Array<{ text: string; status?: 'open' | 'paid' | 'dropped' }>;

/** The meter fields, in the order they are shown, with the range each is clamped to. */
const METERS: Array<{ field: 'bond' | 'sparks' | 'grudge'; label: string; min: number; max: number }> = [
  { field: 'bond', label: 'bond', min: -20, max: 20 },
  { field: 'sparks', label: 'sparks', min: 0, max: 20 },
  { field: 'grudge', label: 'grudge', min: 0, max: 20 },
];

export function BondMeters(props: { value: Bonds; onChange: (next: Bonds) => void }) {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');

  // Sorted, so the list does not reorder under the reader's cursor as the engine writes.
  const pairs = Object.entries(props.value).sort(([a], [b]) => a.localeCompare(b));

  function setMeter(pair: string, field: 'bond' | 'sparks' | 'grudge', value: number) {
    props.onChange({ ...props.value, [pair]: { ...props.value[pair], [field]: value } });
  }

  function remove(pair: string) {
    const next = { ...props.value };
    delete next[pair];
    props.onChange(next);
  }

  function add() {
    const a = left.trim();
    const b = right.trim();
    if (a.length === 0 || b.length === 0) return;
    // The key is written `A|B`; `validatePatch` sorts it server-side, so the widget does
    // not need to.
    props.onChange({ ...props.value, [`${a}|${b}`]: {} });
    setLeft('');
    setRight('');
  }

  return (
    <div>
      {pairs.length === 0 && (
        <p className="form-hint" style={{ marginTop: 0 }}>
          No relationships tracked. The engine adds one when an exchange changes how two
          characters feel about each other, or add a pair by hand below.
        </p>
      )}

      {pairs.map(([pair, values]) => (
        <div key={pair} className="panel panel-pad" style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1, color: 'var(--ink)' }}>{pair.replace('|', ' ↔ ')}</span>
            <button
              type="button"
              className="btn quiet"
              style={{ color: 'var(--danger)' }}
              onClick={() => remove(pair)}
            >
              Remove
            </button>
          </div>
          {METERS.map((meter) => {
            const value = values[meter.field] ?? 0;
            return (
              <div key={meter.field} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                <span className="form-hint" style={{ minWidth: 60 }}>
                  {meter.label}
                </span>
                <input
                  type="range"
                  min={meter.min}
                  max={meter.max}
                  value={value}
                  onChange={(event) => setMeter(pair, meter.field, Number(event.target.value))}
                  style={{ flex: 1 }}
                />
                <span className="data" style={{ minWidth: 28, textAlign: 'right' }}>
                  {value}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input
          className="field"
          placeholder="Name"
          value={left}
          onChange={(event) => setLeft(event.target.value)}
        />
        <input
          className="field"
          placeholder="Name"
          value={right}
          onChange={(event) => setRight(event.target.value)}
        />
        <button
          type="button"
          className="btn quiet"
          disabled={left.trim().length === 0 || right.trim().length === 0}
          onClick={add}
        >
          Add pair
        </button>
      </div>
    </div>
  );
}

export function ThreadList(props: { value: Threads; onChange: (next: Threads) => void }) {
  function set(index: number, change: Partial<Threads[number]>) {
    props.onChange(props.value.map((thread, at) => (at === index ? { ...thread, ...change } : thread)));
  }

  function remove(index: number) {
    props.onChange(props.value.filter((_, at) => at !== index));
  }

  function add() {
    props.onChange([...props.value, { text: '', status: 'open' }]);
  }

  return (
    <div>
      {props.value.length === 0 && (
        <p className="form-hint" style={{ marginTop: 0 }}>
          No open threads. The engine adds one when an exchange raises something the scene
          has not resolved, or add one by hand below.
        </p>
      )}

      {props.value.map((thread, index) => (
        <div
          key={index}
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}
        >
          <input
            className="field"
            style={{ flex: 1 }}
            placeholder="What the scene raised"
            value={thread.text}
            onChange={(event) => set(index, { text: event.target.value })}
          />
          <select
            className="field"
            value={thread.status ?? 'open'}
            onChange={(event) =>
              set(index, { status: event.target.value as Threads[number]['status'] })
            }
          >
            <option value="open">open</option>
            <option value="paid">paid</option>
            <option value="dropped">dropped</option>
          </select>
          <button
            type="button"
            className="btn quiet"
            style={{ color: 'var(--danger)' }}
            onClick={() => remove(index)}
          >
            Remove
          </button>
        </div>
      ))}

      <button type="button" className="btn quiet" style={{ marginTop: 8 }} onClick={add}>
        Add thread
      </button>
    </div>
  );
}
