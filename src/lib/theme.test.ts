import { describe, expect, test } from 'bun:test';
import { themeTokens, DEFAULT_THEME, VOICE_SLOTS, type Theme } from './theme';

/**
 * The palette's one invariant.
 *
 * The voice tokens are the only saturated colours that carry information — which speaker
 * is talking — so a colour that does not read as text against the ground is not a
 * cosmetic problem, it is a speaker the reader cannot identify. The action tokens have the
 * same requirement for the opposite reason: a primary button that does not stand out is
 * not a primary button.
 *
 * This is worth a test rather than a comment because the palettes are plain records, and
 * adding a seventh voice or nudging a hex is a one-line edit that nothing else would
 * catch. The threshold is WCAG AA for body text (4.5:1).
 */
const MIN_CONTRAST = 4.5;

/** Relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const body = hex.replace('#', '');
  const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function tokensFor(mode: 'dark' | 'light'): Record<string, string> {
  const theme: Theme = { ...DEFAULT_THEME, mode };
  return themeTokens(theme, mode === 'dark');
}

describe('the voice palette', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`every voice reads as text on the ${mode} ground`, () => {
      const tokens = tokensFor(mode);
      const ground = tokens['--ground'];
      for (let slot = 1; slot <= VOICE_SLOTS; slot += 1) {
        const value = tokens[`--voice-${slot}`];
        expect(value).toBeDefined();
        const ratio = contrast(value, ground);
        // Reported as the failing colour rather than a bare number, so a broken edit names
        // itself.
        expect(`${slot}:${value}=${ratio.toFixed(2)}`).toBe(
          `${slot}:${value}=${Math.max(ratio, MIN_CONTRAST).toFixed(2)}`,
        );
      }
    });

    test(`the action tokens clear contrast in the ${mode} theme`, () => {
      const tokens = tokensFor(mode);
      expect(contrast(tokens['--action'], tokens['--ground'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(tokens['--action-ink'], tokens['--action'])).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  }

  test('the first two voices keep brass and verdigris, so existing scenes are unchanged', () => {
    // Voice 1 IS the character's brass and voice 2 IS the reader's verdigris. A change here
    // repaints every scene that already exists, which is exactly what the palette was
    // designed not to do.
    for (const mode of ['dark', 'light'] as const) {
      const tokens = tokensFor(mode);
      expect(tokens['--voice-1']).toBe(tokens['--brass']);
      expect(tokens['--voice-2']).toBe(tokens['--verdigris']);
    }
  });

  test('the voices are distinct from each other', () => {
    // Two speakers who look the same colour are a puzzle, not a scene.
    for (const mode of ['dark', 'light'] as const) {
      const tokens = tokensFor(mode);
      const values = Array.from({ length: VOICE_SLOTS }, (_, i) => tokens[`--voice-${i + 1}`]);
      expect(new Set(values).size).toBe(VOICE_SLOTS);
    }
  });

  test('no voice is the action colour, so a speaker never looks like a button', () => {
    // The whole point of the phase: brass used to be both a voice and every primary
    // action, which collapses the moment a scene has three speakers.
    for (const mode of ['dark', 'light'] as const) {
      const tokens = tokensFor(mode);
      for (let slot = 1; slot <= VOICE_SLOTS; slot += 1) {
        expect(tokens[`--voice-${slot}`]).not.toBe(tokens['--action']);
      }
    }
  });

  test('the reader keeps the verdigris voice', () => {
    // `--reader` is what `.turn-user .turn-speaker` resolves to. It must stay on verdigris
    // rather than drifting onto a voice slot that a cast member could also be given.
    const tokens = tokensFor('dark');
    expect(tokens['--reader']).toContain('verdigris');
  });
});
