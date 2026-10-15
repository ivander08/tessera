import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * A DOM for React to render into.
 *
 * Registered at module scope because `react-dom/client` reads `document` when it is first
 * imported, so the globals must exist before the imports below are evaluated.
 */
const window = new Window({ url: 'http://localhost/' });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.navigator = window.navigator;
globals.HTMLElement = window.HTMLElement;
globals.HTMLInputElement = window.HTMLInputElement;
globals.Event = window.Event;
globals.Node = window.Node;
// Without this React warns and does not flush updates synchronously inside `act`.
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const { act, createElement } = await import('react');
const { KnobEditor } = await import('./KnobEditor');

/**
 * Mounts `KnobEditor` and returns a reader that types one character at a time.
 *
 * A controlled number field is only correct if the text the reader typed survives the
 * round trip: keystroke -> `onChange` -> number -> back into the field. This drives that
 * loop explicitly, reading the field's value back out of the DOM after every keystroke and
 * using THAT as the base for the next one — which is what a browser does, and the reason
 * the bug was invisible to any test that called `onChange` with the whole string at once.
 *
 * The keystroke is delivered by invoking the `onChange` React gave the input rather than by
 * dispatching a native `input` event: happy-dom does not route native input events into
 * React's change plugin, so a dispatched event never reaches the handler. The readback
 * below is still React's own output, so the round trip under test is the real one.
 */
function mountKnobEditor() {
  let value = '{}';
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  // happy-dom's element type is structurally incompatible with react-dom's `Container`,
  // which is declared against the real DOM lib. The runtime contract — a node React can
  // render into — is what actually matters here.
  const mount = container as unknown as Parameters<typeof createRoot>[0];
  const root = createRoot(mount);

  function render() {
    act(() => {
      root.render(
        createElement(KnobEditor, {
          provider: 'kenari',
          model: 'deepseek-v4-1-flash',
          models: [],
          value,
          onChange: (next: string) => {
            value = next;
            render();
          },
        }),
      );
    });
  }
  render();

  const field = container.querySelector('input') as unknown as HTMLInputElement;

  /**
   * The props React last gave the input.
   *
   * Read fresh on every interaction: a re-render replaces them, and holding the first
   * object would drive a stale handler.
   */
  function currentProps() {
    const propsKey = Object.keys(field).find((key) => key.startsWith('__reactProps'))!;
    return (field as unknown as Record<string, unknown>)[propsKey] as {
      onChange: (event: { target: { value: string } }) => void;
      onBlur: () => void;
    };
  }

  /** Types `text` one character at a time, as a reader would. */
  function type(text: string) {
    for (const character of text) {
      act(() => {
        currentProps().onChange({ target: { value: field.value + character } });
      });
    }
  }

  function blur() {
    act(() => {
      currentProps().onBlur();
    });
  }

  return {
    field,
    type,
    blur,
    /** Replaces the prop the parent owns, as loading a preset does. */
    setValue(next: string) {
      value = next;
      render();
    },
    get displayed() {
      return field.value;
    },
    get stored() {
      return JSON.parse(value) as Record<string, number>;
    },
  };
}

describe('KnobEditor number entry', () => {
  test('a decimal typed one keystroke at a time is not truncated to a whole number', () => {
    const editor = mountKnobEditor();

    editor.type('0.9');

    // The reported symptom: only digits survived, so the field read `9`.
    expect(editor.displayed).toBe('0.9');
    expect(editor.stored.temperature).toBe(0.9);
  });

  test('the trailing dot survives long enough to type the digit after it', () => {
    const editor = mountKnobEditor();

    editor.type('0.');

    // `0.` is not yet a number. Rewriting the field from the parsed value erased the dot
    // before the next keystroke arrived, which is what made decimals unenterable.
    expect(editor.displayed).toBe('0.');

    editor.type('5');
    expect(editor.displayed).toBe('0.5');
    expect(editor.stored.temperature).toBe(0.5);
  });

  test('negative and leading-dot decimals are accepted', () => {
    const editor = mountKnobEditor();

    editor.type('-1.25');
    expect(editor.displayed).toBe('-1.25');
    expect(editor.stored.temperature).toBe(-1.25);
  });

  test('leaving the field discards a draft that never became a number', () => {
    const editor = mountKnobEditor();

    editor.type('0.9');
    editor.type('abc');
    expect(editor.displayed).toBe('0.9abc');

    // The committed value is 0.9; showing `0.9abc` forever would leave the control and the
    // stored setting disagreeing about what the reader chose.
    editor.blur();
    expect(editor.displayed).toBe('0.9');
    expect(editor.stored.temperature).toBe(0.9);
  });

  test('a value arriving from outside — a preset load — still fills an untouched field', () => {
    const editor = mountKnobEditor();

    // The draft cache must not shadow the prop: a knob the reader never typed into has no
    // draft, so it renders whatever the parent now holds.
    editor.setValue(JSON.stringify({ temperature: 1.15 }));

    expect(editor.displayed).toBe('1.15');
  });
});
