/**
 * Whether a keydown Enter should send, or insert a newline.
 *
 * On a desktop keyboard, Enter sends and Shift+Enter makes a newline — the chat convention.
 * On a phone there is no Shift, so that rule makes Enter send and a newline impossible; the
 * soft keyboard's return key is the only way to break a line, and the Send button is the only
 * way to send. Reported directly: "when I press enter, it sends, but I want to make a new
 * line."
 *
 * The signal is the POINTER, not the viewport width: a narrow desktop window still has a
 * hardware keyboard, and a tablet with a keyboard case is coarse-pointer but has Shift. A
 * coarse pointer means no Shift is reachable, so Enter must not consume the keystroke.
 */
export function enterMakesNewline(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * The composer's keydown rule, shared by the chat and consult boxes so the two cannot drift.
 *
 * Returns true when the event was consumed (the message was sent). The caller supplies `send`
 * and decides what an empty box means.
 */
export function handleComposerEnter(
  event: {
    key: string;
    shiftKey: boolean;
    nativeEvent: { isComposing: boolean };
    preventDefault: () => void;
  },
  send: () => void,
): boolean {
  if (event.key !== 'Enter') return false;
  // Never swallow Enter while an IME candidate window is open: committing a Japanese or
  // Chinese candidate also reports `Enter`, and sending there would submit a half-composed
  // word.
  if (event.nativeEvent.isComposing) return false;
  if (event.shiftKey || enterMakesNewline()) return false;
  event.preventDefault();
  send();
  return true;
}
