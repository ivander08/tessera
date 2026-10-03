import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

const render = (content: string) => renderToStaticMarkup(<Markdown content={content} />);

/**
 * Roleplay prose uses `*action*` where a document would use italics, so these assert the
 * visible result rather than the markup: an asterisk pair must disappear and the text
 * between must be emphasised. Rendering raw text was the actual bug — every action beat
 * showed its asterisks.
 */
describe('Markdown', () => {
  test('renders a single-asterisk action as emphasis', () => {
    const html = render('*She shrugs.* "Fine."');
    expect(html).toContain('<em');
    expect(html).toContain('She shrugs.');
    // The asterisks themselves must be gone — that is the whole point.
    expect(html).not.toContain('*');
  });

  test('renders double asterisks as strong', () => {
    const html = render('**Stop** that.');
    expect(html).toContain('<strong');
    expect(html).not.toContain('**');
  });

  test('keeps straight quotes as written', () => {
    // Dialogue punctuation is the author's, not the renderer's. Smart quotes here would
    // silently rewrite imported cards.
    expect(render('"Hello," she said.')).toContain('&quot;Hello,&quot;');
  });

  test('collapses a details block and keeps its summary visible', () => {
    const html = render(
      'Prose.\n\n<details>\n<summary>Date: Sunday, May 11, 2025</summary>\nLocation: kost bedroom\n</details>',
    );
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('Date: Sunday, May 11, 2025');
    expect(html).toContain('Location: kost bedroom');
  });

  test('defaults the summary when a details block has none', () => {
    const html = render('<details>\njust a body\n</details>');
    expect(html).toContain('Details');
  });

  test('preserves line breaks inside a paragraph', () => {
    // State blocks are one field per line; collapsing them into a single run would make
    // them unreadable. Asserted as one contiguous string, because `toContain` on each
    // line separately would pass even if the newline between them were dropped.
    const html = render('Location: here\nTime: now');
    // `renderToStaticMarkup` writes the void element as `<br/>`; the assertion is about
    // the break existing between the two lines at all.
    expect(html).toContain('Location: here<br/>Time: now');
  });

  test('keeps a line break in a paragraph that also holds dialogue', () => {
    // The speech-marking path flattens the paragraph and slices it by offset; a `br`
    // token is text-bearing there, so without the explicit `<br>` it rendered as a bare
    // newline the browser collapsed back into a space.
    const html = render('"Huh?"\n*Sits down.*\nI wait.');
    expect(html.match(/<br/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<span class="md-speech">&quot;Huh?&quot;</span>');
  });
});

describe('Markdown safety', () => {
  test('shows a script tag as text rather than executing it', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  test('strips a javascript: link but keeps its label', () => {
    const html = render('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
    expect(html).toContain('click');
  });

  test('does not load a remote image', () => {
    const html = render('![a tracker](https://evil.example/p.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('a tracker');
  });

  test('allows an ordinary https link', () => {
    const html = render('[docs](https://example.com/x)');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  test('shows unknown inline html literally instead of interpreting it', () => {
    const html = render('a <b>bold</b> word');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

/**
 * Quoted speech is marked so the theme's `quote` colour has something to apply to.
 *
 * The case that matters is a quotation CONTAINING an inline style: markdown splits the
 * paragraph at `*my*`, so the opening and closing quote land in different tokens. A
 * per-token scan cannot see the pair, which is why `"Hi."` was coloured and a long
 * quotation with italics in it was not — the inconsistency this pins.
 */
describe('Markdown speech', () => {
  /**
   * The speech spans as they appear in the DOM, in order.
   *
   * Asserted against the rendered HTML rather than by rewriting it into a string: a
   * quotation containing an emphasis run is emitted as `span + em + span`, and any
   * text-rewriting helper has to re-implement the parser to describe that. Reading the
   * actual structure keeps the assertion about the output, not about the helper.
   */
  const spans = (content: string): string[] =>
    [...render(content).matchAll(/<span class="md-speech">([\s\S]*?)<\/span>/g)].map((m) =>
      m[1]
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&'),
    );

  /** The whole rendered paragraph as plain text, for the loss checks. */
  const text = (content: string): string =>
    render(content)
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&');

  test('marks a short quotation', () => {
    expect(spans('She says, "Hi." Then nothing.')).toEqual(['"Hi."']);
    expect(text('She says, "Hi." Then nothing.')).toBe('She says, "Hi." Then nothing.');
  });

  test('marks a quotation that spans an emphasis run', () => {
    // The regression: the pair crosses a token boundary. Both halves are marked, and the
    // emphasised word between them is left to the `<em>` that owns it.
    expect(spans('He said "nothing but *my* time" and left.')).toEqual([
      '"nothing but ',
      ' time"',
    ]);
    expect(text('He said "nothing but *my* time" and left.')).toBe(
      'He said "nothing but my time" and left.',
    );
  });

  test('marks a quotation that spans a strong run', () => {
    expect(spans('He said "this is **very** important" and left.')).toEqual([
      '"this is ',
      ' important"',
    ]);
  });

  test('keeps the emphasis inside a quotation', () => {
    // Splitting for the colour must not flatten the styling it split around.
    const html = render('He said "nothing but *my* time" and left.');
    expect(html).toContain('<em');
    expect(html).toContain('my');
  });

  test('marks both quotations when one line holds two', () => {
    expect(spans('"One." She pauses. "Two."')).toEqual(['"One."', '"Two."']);
  });

  test('leaves an apostrophe alone', () => {
    // A single quote is far more often an apostrophe than a quotation in this prose.
    expect(spans("Don't do that, it's fine.")).toEqual([]);
  });

  test('leaves a single-quoted aside inside dialogue alone', () => {
    expect(spans('"He said \'no\' to me." She shrugged.')).toEqual(['"He said \'no\' to me."']);
  });

  test('marks nothing in narration', () => {
    expect(spans('Just narration with no dialogue at all.')).toEqual([]);
  });

  test('does not mark an unclosed quotation', () => {
    // Half a quotation is not a quotation, and marking the rest of the paragraph would
    // repaint prose that is not dialogue.
    expect(spans('She starts "and never finishes.')).toEqual([]);
  });

  test('preserves the text exactly', () => {
    // The visible words must survive the marking unchanged.
    const input = 'A "quoted bit here" and then some narration.';
    expect(text(input)).toBe(input);
  });
});

describe('Markdown structure', () => {
  test('renders a heading as a paragraph so it does not fight the page hierarchy', () => {
    const html = render('# Title');
    expect(html).not.toContain('<h1');
    expect(html).toContain('md-heading');
  });

  test('renders blockquote, list, hr and code', () => {
    expect(render('> quoted')).toContain('<blockquote');
    expect(render('- item')).toContain('<ul');
    expect(render('1. item')).toContain('<ol');
    expect(render('---')).toContain('<hr');
    expect(render('use `x` here')).toContain('<code');
  });

  test('handles an empty message without throwing', () => {
    expect(render('')).toBe('');
  });
});
