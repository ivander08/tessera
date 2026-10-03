import { describe, expect, test } from 'bun:test';
import { enterMakesNewline, handleComposerEnter, refocusesAfterSend } from './composer';

/**
 * The reported bug: on a phone, Enter sent the message and a newline was impossible, because
 * a soft keyboard has no Shift. The rule is now pointer-based — a coarse pointer means no
 * Shift is reachable, so Enter must insert a newline and the Send button does the sending.
 */

function keydown(overrides: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
} = {}): {
  event: Parameters<typeof handleComposerEnter>[0];
  defaultPrevented: () => boolean;
} {
  let prevented = false;
  const event = {
    key: overrides.key ?? 'Enter',
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: { isComposing: overrides.isComposing ?? false },
    preventDefault: () => {
      prevented = true;
    },
  };
  return { event, defaultPrevented: () => prevented };
}

function withPointer(coarse: boolean): void {
  globalThis.window = {
    matchMedia: () => ({ matches: coarse }),
  } as unknown as Window & typeof globalThis;
}

describe('handleComposerEnter', () => {
  test('Enter sends on a fine pointer', () => {
    withPointer(false);
    const { event, defaultPrevented } = keydown();
    let sent = 0;
    expect(handleComposerEnter(event, () => sent++)).toBe(true);
    expect(sent).toBe(1);
    // The newline must not also land in the box.
    expect(defaultPrevented()).toBe(true);
  });

  test('Enter makes a newline on a coarse pointer, and sends nothing', () => {
    withPointer(true);
    const { event, defaultPrevented } = keydown();
    let sent = 0;
    expect(handleComposerEnter(event, () => sent++)).toBe(false);
    expect(sent).toBe(0);
    // Not prevented, so the textarea inserts the newline the user asked for.
    expect(defaultPrevented()).toBe(false);
  });

  test('Shift+Enter makes a newline on a fine pointer', () => {
    withPointer(false);
    const { event, defaultPrevented } = keydown({ shiftKey: true });
    let sent = 0;
    expect(handleComposerEnter(event, () => sent++)).toBe(false);
    expect(sent).toBe(0);
    expect(defaultPrevented()).toBe(false);
  });

  test('an IME composition commit never sends', () => {
    // Committing a Japanese or Chinese candidate also reports `Enter`; sending there would
    // submit a half-composed word.
    withPointer(false);
    const { event } = keydown({ isComposing: true });
    let sent = 0;
    expect(handleComposerEnter(event, () => sent++)).toBe(false);
    expect(sent).toBe(0);
  });

  test('a non-Enter key is ignored', () => {
    withPointer(false);
    const { event } = keydown({ key: 'a' });
    let sent = 0;
    expect(handleComposerEnter(event, () => sent++)).toBe(false);
    expect(sent).toBe(0);
  });
});

describe('enterMakesNewline', () => {
  test('follows the pointer, not the viewport width', () => {
    withPointer(true);
    expect(enterMakesNewline()).toBe(true);
    withPointer(false);
    expect(enterMakesNewline()).toBe(false);
  });
});

describe('refocusesAfterSend', () => {
  test('takes focus back on a fine pointer', () => {
    withPointer(false);
    expect(refocusesAfterSend()).toBe(true);
  });

  test('leaves focus alone on a coarse pointer', () => {
    // Re-focusing on a phone raises the soft keyboard again the instant the reader dismissed
    // it by pressing Send, which is the opposite of what they asked for.
    withPointer(true);
    expect(refocusesAfterSend()).toBe(false);
  });
});
