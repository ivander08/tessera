/**
 * The theme, as data.
 *
 * Every visual constant the UI uses is a token here rather than a Tailwind class, so a
 * theme is a record that can be stored in `settings` and edited at runtime. Hard-coding
 * `text-sm` or `#14110f` into a component makes it unthemeable, which is the thing that
 * makes an app feel like a template rather than a tool.
 *
 * ## The direction
 *
 * Tessera is a scriptorium: a place where fiction is written and kept. The palette is
 * drawn from that room's materials rather than from a generic dark theme — iron-gall ink,
 * oak-gall brown, parchment, and the two metals on the fittings: brass and its green
 * patina, verdigris.
 *
 * The two metals are not decoration. A transcript has exactly two voices, and colour is
 * the fastest way to tell them apart at a glance — so the character speaks in brass and
 * the reader answers in verdigris. That is real information, which is what earns the
 * only two saturated colours in the whole interface.
 *
 * ## Type
 *
 * Three roles, and the split is the point:
 *
 *   - **Prose is set in a serif.** This app's entire purpose is reading fiction, and the
 *     fiction was being set in a UI sans, which is the single largest reason it read as a
 *     chat log rather than a manuscript.
 *   - **Chrome is set in the system sans.** Controls should look like controls.
 *   - **Numbers are set in a mono**, because token counts and cache rates are tabular
 *     data and should line up.
 *
 * The display face is the system's own serif (Georgia, Iowan, Palatino) rather than a
 * downloaded one: no network request, no privacy leak to a font CDN, and no flash of
 * unstyled text on a phone. The character comes from *treatment* — letterspaced small
 * caps, a real type scale, an 68-character measure — not from a font file.
 */
export interface Theme {
  /** `auto` follows the OS; the other two force a mode. */
  mode: 'auto' | 'dark' | 'light';
  fontScale: number;
  lineHeight: number;
  /** Avatar edge length in px. 0 hides avatars entirely, which is a real preference. */
  avatarSize: number;
  messageLayout: 'flat' | 'bubble';
  /** Widest the prose column is allowed to get, in ch. Long lines are hard to read. */
  measure: number;
  /**
   * How strongly the reader's voice is tinted, 0–100.
   *
   * A colour picker would be the obvious control, but the honest question a reader asks
   * of narration is "is this too loud", not "which hex" — and a slider cannot produce an
   * unreadable combination against either ground. 0 is plain ink, 100 is full verdigris.
   */
  emphasis: number;
  /**
   * Overrides the character's colour, as a hex string, or empty to use the theme's brass.
   *
   * Per-theme rather than a global accent because the right brass for a warm dark ground
   * is wrong on parchment — a single value that looks deliberate in one mode looks muddy
   * in the other.
   */
  accent: string;
  /**
   * Per-element prose colours, each an override or empty to keep the theme's own.
   *
   * A single "contrast" slider cannot answer the actual request, which is "make the
   * italics lighter but leave the quotes alone" — the elements carry different meaning
   * and readers want to weight them differently. These are the four the reader points at
   * in a transcript: body text, narration in italics, quoted speech, and links.
   */
  colors: {
    /** Body prose. Empty keeps `--ink`. */
    text: string;
    /** `*action beats*` — the element the reader most often wants to quieten. */
    emphasis: string;
    /** Blockquotes. */
    quote: string;
    /** Links inside a reply. */
    link: string;
  };
  /** User CSS, appended last so it can override anything above it. */
  customCss: string;
}

export const DEFAULT_THEME: Theme = {
  mode: 'auto',
  fontScale: 1,
  lineHeight: 1.68,
  avatarSize: 34,
  messageLayout: 'flat',
  measure: 68,
  emphasis: 82,
  accent: '',
  colors: { text: '', emphasis: '', quote: '', link: '' },
  customCss: '',
};

/**
 * Dark: a lamp on a desk at night. The ground is a warm near-black, not a neutral grey —
 * a blue-black under candlelight is a lie, and the warmth is what keeps long reading
 * sessions from feeling clinical.
 */
const DARK: Record<string, string> = {
  '--ground': '#16130F',
  '--surface': '#1E1A15',
  '--surface-raised': '#26211A',
  '--ink': '#E9E2D7',
  '--ink-dim': '#9A8F82',
  '--ink-faint': '#6B6157',
  '--line': 'rgba(233, 226, 215, 0.10)',
  '--line-strong': 'rgba(233, 226, 215, 0.20)',
  // Brass: the character's voice, and every primary action.
  '--brass': '#C2A36B',
  '--brass-dim': '#7A6640',
  '--brass-ink': '#1A1610',
  // Verdigris: the reader's voice. Oxidised copper, which is what actually happens to
  // brass fittings in a damp room — the second metal is not invented, it is the first
  // one aged.
  '--verdigris': '#7BA88F',
  '--verdigris-dim': '#44604F',
  // The speaker palette. Six voices is a cast; seven is a crowd, and a reader who cannot
  // tell two speakers apart is reading a puzzle rather than a scene. Every entry is
  // checked to read as text on `--ground` — these are the only saturated colours that
  // carry information, so they have to hold contrast rather than merely look distinct.
  //
  // Voice 1 IS brass, unchanged, so a single-character scene looks exactly as it did.
  // Voice 2 is verdigris, so the reader keeps the colour they have always had.
  '--voice-1': '#C2A36B',
  '--voice-2': '#7BA88F',
  '--voice-3': '#B98BB5',
  '--voice-4': '#7FA3C4',
  '--voice-5': '#C98F6B',
  '--voice-6': '#A3AE72',
  // Primary actions are deliberately NOT a voice. Brass used to be both, which works
  // with one speaker and collapses with three: every speaker would be the same colour as
  // every button. A near-white action on a warm near-black ground is high contrast in
  // both directions and competes with nothing.
  '--action': '#E9E2D7',
  '--action-ink': '#16130F',
  '--danger': '#D9705C',
  '--good': '#86A96B',
  '--warn': '#D2A24C',
  '--shadow': '0 1px 2px rgba(0, 0, 0, 0.45)',
  '--scrim': 'rgba(10, 8, 6, 0.62)',
};

/**
 * Light: the same desk in daylight. Ground is parchment — a warm off-white, deliberately
 * not the cream-and-terracotta pairing that every generated design reaches for. The
 * metals darken to hold contrast against paper.
 */
const LIGHT: Record<string, string> = {
  '--ground': '#F6F2EA',
  '--surface': '#FFFFFF',
  '--surface-raised': '#EDE7DC',
  '--ink': '#221D17',
  '--ink-dim': '#6B6157',
  '--ink-faint': '#9C9186',
  '--line': 'rgba(34, 29, 23, 0.12)',
  '--line-strong': 'rgba(34, 29, 23, 0.26)',
  '--brass': '#7E6224',
  '--brass-dim': '#B9A374',
  '--brass-ink': '#FFFFFF',
  '--verdigris': '#2F6B57',
  '--verdigris-dim': '#9DBFB2',
  // The same six voices, darkened to hold contrast on parchment. A colour that reads on a
  // near-black ground is too light on paper, so these are not the dark set reused.
  '--voice-1': '#7E6224',
  '--voice-2': '#2F6B57',
  '--voice-3': '#7A4A76',
  '--voice-4': '#3A5F82',
  '--voice-5': '#8A5430',
  '--voice-6': '#5E6B2E',
  // Near-black on parchment, which is the same contrast inverted.
  '--action': '#221D17',
  '--action-ink': '#F6F2EA',
  '--danger': '#A83E2C',
  '--good': '#4A7A32',
  '--warn': '#8A6414',
  '--shadow': '0 1px 2px rgba(34, 29, 23, 0.10)',
  '--scrim': 'rgba(34, 29, 23, 0.42)',
};

/**
 * The voice palette, as a list, for the worker's colour assignment.
 *
 * Read from the DARK palette because both sets define the same six slots and the ORDER is
 * the only thing that matters here — the cast stores a slot index, and the CSS resolves
 * it per theme. Defined once so the worker cannot drift from the stylesheet.
 */
export const VOICE_SLOTS = 6;

/** Resolves `auto` against the OS preference. */
export function resolveMode(theme: Theme, prefersDark: boolean): 'dark' | 'light' {
  if (theme.mode === 'auto') return prefersDark ? 'dark' : 'light';
  return theme.mode;
}

/**
 * The token set for a theme, as a flat record of CSS custom properties.
 *
 * Typography is derived from `fontScale` and `lineHeight` rather than being separate
 * fields, so one slider moves the whole scale coherently instead of leaving headings at
 * their old size.
 */
export function themeTokens(theme: Theme, prefersDark: boolean): Record<string, string> {
  const dark = resolveMode(theme, prefersDark) === 'dark';
  const palette = dark ? DARK : LIGHT;
  const scale = theme.fontScale;

  // The reader's voice, tinted by `emphasis`. Mixing toward the metal rather than
  // swapping to it keeps every value readable: at 0 it is plain ink, at 100 it is the
  // theme's verdigris, and nothing in between can land on a colour that fails contrast.
  const emphasis = clamp(theme.emphasis, 0, 100);
  const reader = `color-mix(in srgb, ${dark ? 'var(--verdigris)' : 'var(--verdigris)'} ${emphasis}%, var(--ink))`;

  // The character's colour. A user override wins over the palette's own brass, so a
  // reader who wants a different speaker colour is not forced to write custom CSS for it.
  const accent = hexOr(theme.accent, palette['--brass']);

  // Per-element prose overrides. Each falls back to the theme's own value, so an unset
  // field is not a colour choice — it is the absence of one.
  const prose = theme.colors ?? { text: '', emphasis: '', quote: '', link: '' };

  return {
    ...palette,
    '--brass': accent,
    // The serif stack: Georgia first because it is present and genuinely good on both
    // Windows and macOS, and its old-style figures suit prose.
    '--font-prose': "Georgia, 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', serif",
    '--font-ui': "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    '--font-data': "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace",

    '--text-xs': `${(11.5 * scale).toFixed(2)}px`,
    '--text-sm': `${(13 * scale).toFixed(2)}px`,
    '--text-base': `${(15.5 * scale).toFixed(2)}px`,
    '--text-lg': `${(18 * scale).toFixed(2)}px`,
    '--text-xl': `${(23 * scale).toFixed(2)}px`,

    '--leading': String(theme.lineHeight),
    '--measure': `${theme.measure}ch`,
    '--avatar': `${theme.avatarSize}px`,
    '--gap': `${(8 * scale).toFixed(2)}px`,
    '--radius': '7px',

    // Consumed by `.turn-user .turn-speaker`, which is what ties the reader's name to
    // their voice.
    '--reader': reader,
    // Prose elements. `--em` is mixed from the slider; an explicit colour replaces it
    // outright, because a reader who picks a hex means that hex.
    '--prose': hexOr(prose.text, 'var(--ink)'),
    '--em': hexOr(prose.emphasis, `color-mix(in srgb, var(--ink) ${emphasis}%, var(--ink-dim))`),
    '--quote': hexOr(prose.quote, 'var(--ink-dim)'),
    '--link': hexOr(prose.link, 'var(--brass)'),
  };
}

/** A hex colour from the theme, or the given fallback when it is unset or malformed. */
function hexOr(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) ? trimmed : fallback;
}

/** Serializes tokens into a `:root { … }` block. */
export function themeCss(tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
  return `:root {\n${body}\n}`;
}

/**
 * Applies a theme to the document.
 *
 * A single `<style>` element is replaced rather than appended, so switching themes
 * repeatedly does not accumulate stylesheets — which is invisible until the cascade
 * starts behaving oddly for reasons nobody can find.
 */
export function applyTheme(
  theme: Theme,
  prefersDark: boolean,
  root: HTMLElement = document.documentElement,
): void {
  const tokens = themeTokens(theme, prefersDark);
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);

  // The message layout is a STRUCTURAL choice, not a colour, so it cannot be a custom
  // property: no CSS rule can restyle the grid from a variable. It goes on the root as a
  // data attribute, which the stylesheet keys off — one source of truth, applied at the
  // same moment as the palette and with no prop to thread through every component that
  // renders a turn.
  root.dataset.layout = theme.messageLayout;

  const styleId = 'tessera-custom-css';
  let node = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!node) {
    node = document.createElement('style');
    node.id = styleId;
    document.head.appendChild(node);
  }
  // Custom CSS last, so it wins. This is the escape hatch that makes a fixed token set
  // acceptable: anything not covered is still reachable.
  node.textContent = theme.customCss;
}

/** Reads a stored theme, falling back per-field so an older record stays usable. */
export function parseTheme(raw: string | null | undefined): Theme {
  if (!raw) return DEFAULT_THEME;
  try {
    const parsed = JSON.parse(raw) as Partial<Theme>;
    return {
      mode: parsed.mode === 'dark' || parsed.mode === 'light' ? parsed.mode : 'auto',
      fontScale: clamp(Number(parsed.fontScale ?? 1), 0.85, 1.5),
      lineHeight: clamp(Number(parsed.lineHeight ?? 1.68), 1.3, 2.2),
      avatarSize: clamp(Number(parsed.avatarSize ?? 34), 0, 64),
      messageLayout: parsed.messageLayout === 'bubble' ? 'bubble' : 'flat',
      measure: clamp(Number(parsed.measure ?? 68), 45, 100),
      emphasis: clamp(Number(parsed.emphasis ?? 82), 0, 100),
      accent: typeof parsed.accent === 'string' ? parsed.accent : '',
      colors: parseColors(parsed.colors),
      customCss: typeof parsed.customCss === 'string' ? parsed.customCss : '',
    };
  } catch {
    return DEFAULT_THEME;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads the prose colour overrides, tolerating a record that predates them.
 *
 * Each field falls back to empty — "no override" — rather than to a colour, so an older
 * stored theme keeps the palette it was written against instead of being silently
 * repainted with whatever the defaults happen to be today.
 */
function parseColors(raw: unknown): Theme['colors'] {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (key: string): string =>
    typeof record[key] === 'string' ? (record[key] as string) : '';
  return {
    text: pick('text'),
    emphasis: pick('emphasis'),
    quote: pick('quote'),
    link: pick('link'),
  };
}
