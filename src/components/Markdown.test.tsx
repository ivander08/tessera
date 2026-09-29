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
    // them unreadable.
    const html = render('Location: here\nTime: now');
    expect(html).toContain('Location: here');
    expect(html).toContain('Time: now');
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
