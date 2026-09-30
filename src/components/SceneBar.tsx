import type { WorldState } from '../lib/state/schema';

/**
 * Where and when the scene stands, always on screen.
 *
 * The reader was having to open a sheet to find out what the narrator currently believes
 * about the time, the place and the weather — which is the one thing you want to check
 * *while* reading, because it is what tells you whether the writing has drifted. This is
 * a persistent strip under the titlebar rather than something you go and look at.
 *
 * It reads the same document the prompt is built from, so what it shows and what the
 * model is told cannot disagree. Empty fields are omitted rather than shown blank: a
 * fresh scene genuinely has no state yet, and a row of dashes would read as a broken
 * feature instead of a scene that has not established itself.
 *
 * Clicking anywhere on it opens the full state sheet, which is also where it is edited.
 */
export function SceneBar({ state, onOpen }: { state: WorldState | undefined; onOpen: () => void }) {
  const time = state?.time?.trim() ?? '';
  const location = state?.location?.trim() ?? '';
  const weather = state?.weather?.trim() ?? '';
  const present = (state?.present ?? []).filter((name) => name.trim().length > 0);
  const away = Object.entries(state?.away ?? {}).filter(([who]) => who.trim().length > 0);

  const empty = !time && !location && !weather && present.length === 0 && away.length === 0;

  return (
    <button
      type="button"
      className={`scene-bar${empty ? ' is-empty' : ''}`}
      onClick={onOpen}
      title="Where the scene stands. Written automatically after each turn; click to read or correct it."
    >
      <ClockGlyph />
      {empty ? (
        <span className="scene-bar-empty">
          No scene recorded yet — the narrator fills this in after the first completed turn
        </span>
      ) : (
        <>
          {time && <Chip label="Time" value={time} />}
          {location && <Chip label="Place" value={location} />}
          {weather && <Chip label="Weather" value={weather} />}
          {present.length > 0 && <Chip label="Present" value={present.join(', ')} />}
          {away.length > 0 && (
            <Chip
              label="Elsewhere"
              value={away.map(([who, where]) => `${who} at ${where}`).join('; ')}
            />
          )}
        </>
      )}
    </button>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="scene-chip-item">
      <span className="scene-chip-label">{label}</span>
      <span className="scene-chip-value">{value}</span>
    </span>
  );
}

function ClockGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}
