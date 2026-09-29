/**
 * The theme, as data.
 *
 * Every visual constant the UI uses is a token here rather than a Tailwind class, so a
 * theme is a record that can be stored in `settings` and edited at runtime. Hard-coding
 * `text-sm` or `#14110f` into a component makes it unthemeable, which is the thing that
 * makes an app feel like a template rather than a tool.
 *
 * The shape mirrors what chub exposes — font size, line height, avatar size, and the
 * handful of colours that actually carry meaning in a transcript — rather than a
 * general-purpose palette, because those are the knobs that change how reading feels.
 */
export interface Theme {
  /** `auto` follows the OS; the other two force a mode. */
  mode: 'auto' | 'dark' | 'light';
  fontScale: number;
  lineHeight: number;
  /** Avatar edge length in px. 0 hides avatars entirely, which is a real preference. */
  avatarSize: number;
  messageLayout: 'flat' | 'bubble';
  /** User CSS, appended last so it can override anything above it. */
  customCss: string;
}

export const DEFAULT_THEME: Theme = {
  mode: 'auto',
  fontScale: 1,
  lineHeight: 1.6,
  avatarSize: 32,
  messageLayout: 'flat',
  customCss: '',
};

const DARK: Record<string, string> = {
  '--surface': '#14110f',
  '--surface-raised': '#1e1a17',
  '--surface-overlay': '#262019',
  '--ink': '#ece6df',
  '--ink-dim': '#9a9089',
  '--ink-faint': '#6b635c',
  '--accent': '#c8a882',
  '--accent-ink': '#14110f',
  '--line': 'rgba(255, 255, 255, 0.08)',
  '--danger': '#e0705f',
  '--good': '#7fb069',
  '--warn': '#d9a441',
  '--quote': '#b9ada1',
  '--shadow': '0 1px 2px rgba(0, 0, 0, 0.4)',
};

const LIGHT: Record<string, string> = {
  '--surface': '#faf7f2',
  '--surface-raised': '#ffffff',
  '--surface-overlay': '#f2ede4',
  '--ink': '#241f1a',
  '--ink-dim': '#6d6459',
  '--ink-faint': '#a09689',
  '--accent': '#8a6636',
  '--accent-ink': '#ffffff',
  '--line': 'rgba(0, 0, 0, 0.10)',
  '--danger': '#b3402f',
  '--good': '#3f7a2e',
  '--warn': '#9a6b16',
  '--quote': '#4d453b',
  '--shadow': '0 1px 2px rgba(0, 0, 0, 0.08)',
};

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
  const palette = resolveMode(theme, prefersDark) === 'dark' ? DARK : LIGHT;
  const scale = theme.fontScale;

  return {
    ...palette,
    '--font-base': `${(15 * scale).toFixed(2)}px`,
    '--font-sm': `${(13 * scale).toFixed(2)}px`,
    '--font-xs': `${(11 * scale).toFixed(2)}px`,
    '--font-lg': `${(19 * scale).toFixed(2)}px`,
    '--line-height': String(theme.lineHeight),
    '--avatar-size': `${theme.avatarSize}px`,
    '--space': `${(8 * scale).toFixed(2)}px`,
  };
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
export function applyTheme(theme: Theme, prefersDark: boolean, root: HTMLElement = document.documentElement): void {
  const tokens = themeTokens(theme, prefersDark);
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);

  const styleId = 'tessera-theme';
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
      fontScale: clamp(Number(parsed.fontScale ?? 1), 0.8, 1.6),
      lineHeight: clamp(Number(parsed.lineHeight ?? 1.6), 1.2, 2.2),
      avatarSize: clamp(Number(parsed.avatarSize ?? 32), 0, 64),
      messageLayout: parsed.messageLayout === 'bubble' ? 'bubble' : 'flat',
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
