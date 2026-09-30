import { useEffect, useState } from 'react';
import { applyTheme, DEFAULT_THEME, resolveMode, type Theme } from '../lib/theme';

/**
 * Theme controls.
 *
 * Writes to the same `settings` table as everything else, so the theme follows the user
 * across devices rather than living in one browser's localStorage. Changes apply
 * immediately — a theme editor that requires a save button to see the result makes every
 * adjustment a guess.
 */
export function ThemeEditor({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (next: Theme) => void;
}) {
  const [preview, setPreview] = useState<Theme>(value);

  useEffect(() => {
    setPreview(value);
  }, [value]);

  function update(patch: Partial<Theme>) {
    const next = { ...preview, ...patch };
    setPreview(next);
    onChange(next);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[var(--text-sm)] font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
          Appearance
        </h2>
        <button
          type="button"
          className="app-link"
          onClick={() => update({ ...DEFAULT_THEME })}
        >
          Reset
        </button>
      </div>

      <Row label="Mode">
        <div className="flex gap-1">
          {(['auto', 'dark', 'light'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn ${preview.mode === mode ? 'primary' : ''}`}
              onClick={() => update({ mode })}
            >
              {mode}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Message layout">
        <div className="flex gap-1">
          {(['flat', 'bubble'] as const).map((messageLayout) => (
            <button
              key={messageLayout}
              type="button"
              className={`btn ${preview.messageLayout === messageLayout ? 'primary' : ''}`}
              onClick={() => update({ messageLayout })}
            >
              {messageLayout}
            </button>
          ))}
        </div>
      </Row>

      <Slider
        label="Font size"
        value={preview.fontScale}
        min={0.8}
        max={1.6}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(fontScale) => update({ fontScale })}
      />

      <Slider
        label="Line height"
        value={preview.lineHeight}
        min={1.2}
        max={2.2}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(lineHeight) => update({ lineHeight })}
      />

      <Slider
        label="Avatar size"
        value={preview.avatarSize}
        min={0}
        max={64}
        step={2}
        format={(v) => (v === 0 ? 'hidden' : `${v}px`)}
        onChange={(avatarSize) => update({ avatarSize })}
      />

      <Slider
        label="Narration contrast"
        value={preview.emphasis}
        min={0}
        max={100}
        step={2}
        format={(v) => (v >= 100 ? 'full' : v <= 0 ? 'plain' : `${v}%`)}
        onChange={(emphasis) => update({ emphasis })}
      />

      <Row label="Character colour">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Character colour"
            value={preview.accent || (resolveMode(preview, true) === 'dark' ? '#C2A36B' : '#7E6224')}
            onChange={(event) => update({ accent: event.target.value })}
            className="color-swatch"
          />
          <input
            className="field font-mono text-[var(--text-xs)]"
            value={preview.accent}
            placeholder="theme default"
            onChange={(event) => update({ accent: event.target.value })}
          />
          {preview.accent && (
            <button type="button" className="btn quiet" onClick={() => update({ accent: '' })}>
              Clear
            </button>
          )}
        </div>
      </Row>

      {/* Prose elements, each independently overridable. These are the colours a reader
          actually points at when they say a reply is hard to read — and they want them
          weighted differently, which one contrast slider cannot express. */}
      <div className="space-y-2">
        <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">Prose colours</span>
        {(
          [
            ['text', 'Body text'],
            ['emphasis', 'Narration (italics)'],
            ['quote', 'Quotes'],
            ['link', 'Links'],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="flex items-center gap-2">
            <input
              type="color"
              aria-label={label}
              value={preview.colors[key] || fallbackSwatch(key, preview)}
              onChange={(event) =>
                update({ colors: { ...preview.colors, [key]: event.target.value } })
              }
              className="color-swatch"
            />
            <span className="flex-1 text-[var(--text-xs)]">{label}</span>
            <input
              className="field font-mono text-[var(--text-xs)]"
              style={{ maxWidth: '11ch' }}
              value={preview.colors[key]}
              placeholder="theme"
              onChange={(event) =>
                update({ colors: { ...preview.colors, [key]: event.target.value } })
              }
            />
            {preview.colors[key] && (
              <button
                type="button"
                className="btn quiet"
                onClick={() => update({ colors: { ...preview.colors, [key]: '' } })}
              >
                Clear
              </button>
            )}
          </div>
        ))}
      </div>

      <Row label="Custom CSS">
        <textarea
          className="field font-mono text-[var(--text-xs)]"
          rows={3}
          value={preview.customCss}
          placeholder=".md-em { letter-spacing: 0.01em; }"
          onChange={(event) => update({ customCss: event.target.value })}
        />
      </Row>

      <p className="text-[var(--text-xs)] text-[var(--ink-faint)]">
        Custom CSS is applied last, so it overrides anything above. Every colour and size is a
        CSS variable on <code className="md-code">:root</code> — for example{' '}
        <code className="md-code">--brass</code>, <code className="md-code">--surface</code>,{' '}
        <code className="md-code">--em</code>.
      </p>
    </section>
  );
}

/**
 * What a colour input shows when the field is empty.
 *
 * `<input type="color">` cannot express "unset" — it always holds a hex — so an unset
 * field is seeded with the colour the theme would use anyway. Without this the swatch
 * reads black and the control looks broken rather than optional.
 */
function fallbackSwatch(key: keyof Theme['colors'], theme: Theme): string {
  const dark = resolveMode(theme, true) === 'dark';
  if (key === 'text') return dark ? '#E9E2D7' : '#221D17';
  if (key === 'emphasis') return dark ? '#C6BEB1' : '#5C5348';
  if (key === 'quote') return dark ? '#9A8F82' : '#6B6157';
  return theme.accent || (dark ? '#C2A36B' : '#7E6224');
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">{label}</span>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[var(--text-xs)] text-[var(--ink-dim)]">{label}</span>
        <span className="font-mono text-[var(--text-xs)] text-[var(--ink-faint)]">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[var(--brass)]"
      />
    </div>
  );
}

/**
 * Applies a theme immediately without waiting for the settings round trip, so dragging a
 * slider shows the result as it moves.
 */
export function useLiveTheme(theme: Theme): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyTheme(theme, media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}
