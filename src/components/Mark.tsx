/**
 * The mark: one lit tile among its neighbours.
 *
 * A tessera is a single tile in a mosaic, and that is the whole idea behind the name — a
 * turn is one tile, the story is the picture. The mark shows the tile lit and the tiles
 * around it dimmed, so it reads as part of something larger rather than a lone square.
 *
 * ## Legibility, not decoration
 *
 * The first version drew all EIGHT neighbours at 22% opacity and made the lit tile 20/64
 * of the box. Rendered at 18px in a titlebar that is a smudge: the four edge tiles are
 * 2px wide, the corners 5px, and the whole thing reads as noise around a dot.
 *
 * The geometry below is chosen so every element survives at 18px:
 *
 *  - FOUR neighbours, not eight. The edge tiles are the first thing to go — they are the
 *    smallest and they sit closest to the lit tile, which is where the eye is.
 *  - The lit tile is 28/64 (was 20/64), so it is a solid ~8px block at 18px rather than a
 *    speck. It is the one element that carries meaning, so it gets the size.
 *  - Neighbours at 38% (was 22%), which is the threshold where they read as tiles instead
 *    of a grey haze behind the brass.
 *
 * ## Why this is a component and not the file in `public/`
 *
 * `favicon.svg` and `app-icon.svg` are files because a browser tab and an installer need
 * a file. In the UI the mark sits in a titlebar next to text that changes colour with the
 * theme, and a fixed-fill SVG cannot: the tile is brass on one theme and different brass
 * on the other. So the geometry lives here once and the colour comes from CSS.
 *
 * The neighbours are drawn in `currentColor`, which means the mark tints itself from
 * whatever it is placed in with no theme plumbing. The shapes match `public/favicon.svg`.
 */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className="mark"
    >
      {/* The four neighbours. `currentColor` rather than a fixed grey so the mark works on
          the dark ground and the light one; the surrounding tiles are meant to recede
          either way. */}
      <g fill="currentColor" opacity="0.38">
        <rect x="2" y="2" width="14" height="14" rx="2.5" />
        <rect x="48" y="2" width="14" height="14" rx="2.5" />
        <rect x="2" y="48" width="14" height="14" rx="2.5" />
        <rect x="48" y="48" width="14" height="14" rx="2.5" />
      </g>

      {/* The lit tile, in brass. This is the one element that carries the brand colour, so
          it uses the theme's brass variable directly. */}
      <rect x="18" y="18" width="28" height="28" rx="5.5" fill="var(--brass)" />

      {/* A seam, so the tile reads as cut stone rather than a flat square. Drawn in
          `currentColor` at low opacity so it darkens whatever it sits on. */}
      <rect
        x="21.5"
        y="21.5"
        width="21"
        height="21"
        rx="3.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.4"
        strokeWidth="1.7"
      />
    </svg>
  );
}

/**
 * The mark and the wordmark together, for the places the app introduces itself.
 *
 * The gap and the alignment are set here rather than at each call site so the two always
 * line up; the name is prose type, so its cap height sits slightly below the mark's.
 */
export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Mark size={size} />
      <span className="bar-title">Tessera</span>
    </span>
  );
}
