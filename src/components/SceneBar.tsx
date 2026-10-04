import type { WorldState } from '../lib/state/schema';

/**
 * Where and when the scene stands, always on screen.
 *
 * The reader wanted the current time, place and weather visible without opening
 * anything — that is what tells you the narrator has drifted. The first version tried to
 * show every field at once in a single strip, which truncated the time to
 * "Friday, 27 February 2026, ..." and was too small to read at a glance.
 *
 * So this shows the two facts that orient you — where and when — in a size you can read
 * while scrolling, and opens the full document for everything else. The full document is
 * also where it is edited, so the panel is one tap from the strip either way.
 *
 * Reads the same state the prompt is built from, so what is on screen and what the model
 * is told cannot disagree.
 */
export function SceneBar({ state, onOpen }: { state: WorldState | undefined; onOpen: () => void }) {
  const time = state?.time?.trim() ?? '';
  const location = state?.location?.trim() ?? '';
  const weather = state?.weather?.trim() ?? '';
  const present = (state?.present ?? []).filter((name) => name.trim().length > 0);
  const away = Object.entries(state?.away ?? {}).filter(([who]) => who.trim().length > 0);

  // The reader's own name is not in `present` unless the model put it there, so the cast
  // line is worth a count rather than a list — the names are in the panel.
  const castCount = present.length + away.length;

  // Only characters with something recorded count: an entry with an empty value is
  // dropped at render time, so counting it here would claim a fact the prompt never sees.
  const outfitCount = Object.values(state?.outfits ?? {}).filter(
    (outfit) => outfit.trim().length > 0,
  ).length;

  // An outfit alone is still a recorded scene, so it keeps the strip rather than being
  // hidden behind "no scene recorded yet" while the state holds a fact.
  const empty =
    !time && !location && !weather && present.length === 0 && away.length === 0 && outfitCount === 0;

  return (
    <button
      type="button"
      className={`scene-bar${empty ? ' is-empty' : ''}`}
      onClick={onOpen}
      title="The scene, as the narrator sees it. Written after each turn; click for the full document."
    >
      {empty ? (
        <span className="scene-bar-empty">
          <ClockGlyph />
          <span className="scene-bar-empty-text">
            No scene recorded yet — the narrator fills this in after the first completed turn
          </span>
        </span>
      ) : (
        <>
          <span className="scene-bar-lead">
            <ClockGlyph />
            <span className="scene-bar-place">{location || 'Unknown place'}</span>
            {time && (
              <>
                <span className="scene-bar-dot" aria-hidden="true">
                  ·
                </span>
                <span className="scene-bar-time">{time}</span>
              </>
            )}
          </span>

          <span className="scene-bar-rest">
            {weather && <Rest label="Weather" value={weather} />}
            {castCount > 0 && (
              <Rest
                label={away.length > 0 ? 'Away' : 'Present'}
                value={
                  away.length > 0
                    ? away.map(([who]) => who).join(', ')
                    : `${present.length} ${present.length === 1 ? 'person' : 'people'}`
                }
              />
            )}
            {outfitCount > 0 && <Rest label="Outfits" value={`${outfitCount}`} />}
          </span>

          <ChevronGlyph />
        </>
      )}
    </button>
  );
}

function Rest({ label, value }: { label: string; value: string }) {
  return (
    <span className="scene-rest">
      <span className="scene-rest-label">{label}</span>
      <span className="scene-rest-value">{value}</span>
    </span>
  );
}

function ClockGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
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

function ChevronGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
