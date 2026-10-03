import { Fragment, type ReactNode } from 'react';
import { Marked, type Token, type Tokens } from 'marked';

/**
 * Renders a message as React elements, never as HTML.
 *
 * `marked.parse()` returns an HTML string, and the obvious implementation pipes it into
 * `dangerouslySetInnerHTML`. That would make every model reply — and every imported
 * character card — an injection vector into the user's own session, for no benefit:
 * walking the token tree gives the same output with real React elements, so a
 * `<details>` becomes a real component with state rather than a string of markup.
 *
 * Deliberately NOT supported: raw HTML other than `<details>`, images, and links to
 * `javascript:`. A roleplay transcript has no business loading remote resources or
 * executing anything, and a card that tries is more likely to be hostile than useful.
 */

/** Token types that carry no visible output at this level. */
const SILENT = new Set(['space', 'def']);

/**
 * A lexer configured so a single newline inside a paragraph is a real line break.
 *
 * Marked's default is CommonMark, where a soft break collapses to a space — so every
 * line the reader typed in the composer rendered as one paragraph. `breaks: true` is
 * the GFM hard-break behavior the transcript wants.
 *
 * Built as an instance rather than by passing options to `marked.lexer()`: the static
 * entrypoint does NOT merge partial options with the defaults, so `{ breaks: true }`
 * alone silently drops `gfm` — and `breaks` is only honored when `gfm` is on. Verified
 * against marked 18: `marked.lexer(src, { breaks: true })` emits no `br` tokens; a
 * `Marked` configured with `breaks: true` does.
 */
const md = new Marked({ breaks: true });

export function Markdown({ content }: { content: string }): ReactNode {
  const tokens = md.lexer(content);
  return <>{renderBlocks(tokens, 'root')}</>;
}

function renderBlocks(tokens: Token[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const node = renderBlock(tokens[i], `${keyPrefix}-${i}`);
    if (node !== null) out.push(node);
  }
  return out;
}

function renderBlock(token: Token, key: string): ReactNode | null {
  if (SILENT.has(token.type)) return null;

  switch (token.type) {
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {renderInline((token as Tokens.Paragraph).tokens ?? [], key)}
        </p>
      );

    case 'heading': {
      const heading = token as Tokens.Heading;
      // Messages are prose, not documents. A card that emits `# Title` gets a bold line
      // rather than a heading that fights the page hierarchy.
      return (
        <p key={key} className="md-p md-heading">
          {renderInline(heading.tokens, key)}
        </p>
      );
    }

    case 'blockquote':
      return (
        <blockquote key={key} className="md-quote">
          {renderBlocks((token as Tokens.Blockquote).tokens ?? [], key)}
        </blockquote>
      );

    case 'hr':
      return <hr key={key} className="md-hr" />;

    case 'code':
      return (
        <pre key={key} className="md-pre">
          <code>{(token as Tokens.Code).text}</code>
        </pre>
      );

    case 'list': {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        <li key={`${key}-${index}`}>{renderBlocks(item.tokens ?? [], `${key}-${index}`)}</li>
      ));
      return list.ordered ? (
        <ol
          key={key}
          className="md-list"
          /* marked records the number the list started at, and it is not always 1: a model
             that splits one list across two sections (numbers 1-3 under a header, 4-5 under
             the next) writes `4.` on the first item of the second block. Dropping `start`
             renumbered that block from 1, so the reader saw two separate lists both
             beginning at one — the numbering the model wrote was not the numbering shown. */
          start={typeof list.start === 'number' && list.start !== 1 ? list.start : undefined}
        >
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {items}
        </ul>
      );
    }

    case 'table': {
      const table = token as Tokens.Table;
      return (
        <table key={key} className="md-table">
          <thead>
            <tr>
              {table.header.map((cell, index) => (
                <th key={`${key}-h-${index}`}>{renderInline(cell.tokens, `${key}-h-${index}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={`${key}-r-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${key}-r-${rowIndex}-${cellIndex}`}>
                    {renderInline(cell.tokens, `${key}-r-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    case 'html':
      return renderHtmlBlock((token as Tokens.HTML).raw, key);

    default:
      // Unknown block: fall back to its text rather than dropping it, so a construct
      // this renderer has not been taught about still reaches the reader.
      return (
        <p key={key} className="md-p">
          {renderInline((token as { tokens?: Token[] }).tokens ?? [], key)}
        </p>
      );
  }
}

/**
 * Only `<details>` survives. The state block a preset or the state engine emits arrives
 * as raw HTML, and collapsing it is the whole point — it is reference material, not
 * prose. Everything else raw is shown as literal text so nothing is silently lost and
 * nothing is executed.
 */
function renderHtmlBlock(raw: string, key: string): ReactNode {
  const trimmed = raw.trim();
  const match = /^<details(?:\s+open)?>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*([\s\S]*?)\s*<\/details>$/i.exec(
    trimmed,
  );
  if (!match) {
    return (
      <p key={key} className="md-p md-raw">
        {trimmed}
      </p>
    );
  }

  const summary = (match[1] ?? 'Details').trim();
  const body = match[2].trim();

  return (
    <details key={key} className="md-details">
      <summary className="md-summary">{summary}</summary>
      {/* The body is itself markdown in practice — a state block is one line per
          field — so it goes through the same renderer rather than being shown raw. */}
      <div className="md-details-body">{renderBlocks(md.lexer(body), `${key}-body`)}</div>
    </details>
  );
}

/**
 * Quoted speech inside a paragraph, marked so the reader can see it.
 *
 * A roleplay reply is mostly `"Dialogue." She does something.` — the quotes are the only
 * signal that the words are spoken rather than narrated, and in a wall of prose that is
 * the distinction a reader most needs. Marking it is what makes the `quote` colour in the
 * theme mean anything: `blockquote` is a markdown construct that roleplay almost never
 * uses, so without this the setting is a control that changes nothing visible.
 *
 * ## Why this runs on the whole paragraph, not per token
 *
 * Markdown splits a paragraph at every inline construct, so `"...nothing but *my* time..."`
 * arrives as three tokens: text, `em`, text. The opening and closing quote land in
 * DIFFERENT tokens, and a per-token scan cannot see a pair that spans a break — which is
 * why a short `"Hi."` was coloured and a long quotation containing italics was not.
 *
 * So the paragraph's inline tokens are flattened into a list of runs first, the quote
 * ranges are found across the whole flattened text, and each run is then cut at the
 * boundaries. Emphasis and every other inline style are preserved: only the text runs are
 * split, and the styled runs pass through untouched.
 */

/** One inline token's text, or null when it is not a text-bearing run. */
function runText(token: Token): string | null {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text;
      // A text token that itself has children is a container, not a run of characters.
      return text.tokens ? null : text.text;
    }
    case 'escape':
      return (token as Tokens.Escape).text;
    case 'br':
      return '\n';
    case 'br-space':
      return ' ';
    case 'codespan':
      return (token as Tokens.Codespan).text;
    default:
      return null;
  }
}

/**
 * Character ranges covered by a matched pair of quotation marks.
 *
 * Straight and curly marks are both handled, and the opening and closing mark must MATCH
 * — an apostrophe in `don't` must not open a quotation, which is why a lone `'` is not
 * treated as speech at all. `'inefficient iteration.'` inside a longer quotation is the
 * case that matters: single quotes are left alone rather than opened, because a single
 * quote is far more often an apostrophe than a quotation in this prose.
 */
function speechRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /(["“])([^"“”]*)(["”])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    ranges.push({ start: match.index, end: pattern.lastIndex });
  }
  return ranges;
}

function renderInline(tokens: Token[], keyPrefix: string): ReactNode[] {
  // Flatten first, so a quote pair that spans an inline break can be found at all.
  const runs = tokens.map((token) => ({ token, text: runText(token) }));
  const flat = runs.map((run) => run.text ?? '').join('');

  // Nothing quoted anywhere in the paragraph: render the tokens as they came.
  if (!/["“”]/.test(flat)) return renderTokens(tokens, keyPrefix);

  const ranges = speechRanges(flat);
  if (ranges.length === 0) return renderTokens(tokens, keyPrefix);

  const out: ReactNode[] = [];
  let offset = 0;

  for (const run of runs) {
    const text = run.text;

    // A line break is structure, not characters. Left to the slicing below it renders
    // as a bare newline, which the browser collapses back into a space — the exact bug
    // `breaks: true` exists to fix. Keyed on the offset, which is unique per br (each
    // advances the offset by one).
    if (run.token.type === 'br') {
      const brStart = offset;
      offset += 1;
      out.push(<br key={`${keyPrefix}-br${brStart}`} />);
      continue;
    }

    if (text === null) {
      // A styled or non-text run: emitted whole, keeping its own rendering.
      out.push(renderBlockInline(run.token, `${keyPrefix}-r${offset}`));
      continue;
    }

    const start = offset;
    const end = offset + text.length;
    offset = end;

    // The parts of this run that fall inside and outside a quotation.
    let cursor = start;
    for (const range of ranges) {
      if (range.end <= start || range.start >= end) continue;
      const quotedStart = Math.max(range.start, start);
      const quotedEnd = Math.min(range.end, end);
      if (quotedStart > cursor) out.push(text.slice(cursor - start, quotedStart - start));
      out.push(
        <span key={`${keyPrefix}-q${quotedStart}`} className="md-speech">
          {text.slice(quotedStart - start, quotedEnd - start)}
        </span>,
      );
      cursor = quotedEnd;
    }
    if (cursor < end) out.push(text.slice(cursor - start));
  }

  return out;
}

/** One inline token rendered on its own, for the runs that carry their own styling. */
function renderBlockInline(token: Token, key: string): ReactNode {
  const rendered = renderInline([token], key);
  return rendered.length === 1 ? rendered[0] : <Fragment key={key}>{rendered}</Fragment>;
}

/** The plain path: every token rendered in order, with no quote marking. */
function renderTokens(tokens: Token[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const node = renderInlineToken(tokens[i], `${keyPrefix}-i-${i}`);
    if (node !== null) out.push(node);
  }
  return out;
}

/**
 * One inline token, rendered.
 *
 * Text runs return their characters unchanged: quote marking is decided for the whole
 * paragraph in `renderInline`, so a run here must not re-scan for pairs of its own.
 */
function renderInlineToken(token: Token, key: string): ReactNode | null {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens
        ? <Fragment key={key}>{renderInline(text.tokens, key)}</Fragment>
        : text.text;
    }
    case 'escape':
      return (token as Tokens.Escape).text;
    case 'em':
      return (
        <em key={key} className="md-em">
          {renderInline((token as Tokens.Em).tokens ?? [], key)}
        </em>
      );
    case 'strong':
      return (
        <strong key={key} className="md-strong">
          {renderInline((token as Tokens.Strong).tokens ?? [], key)}
        </strong>
      );
    case 'del':
      return (
        <del key={key}>{renderInline((token as Tokens.Del).tokens ?? [], key)}</del>
      );
    case 'codespan':
      return (
        <code key={key} className="md-code">
          {(token as Tokens.Codespan).text}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'link': {
      const link = token as Tokens.Link;
      // `javascript:` and `data:` in a model reply are a hostile payload, not a link.
      const safe = /^(https?:|mailto:)/i.test(link.href);
      return safe ? (
        <a key={key} className="md-link" href={link.href} target="_blank" rel="noreferrer noopener">
          {renderInline(link.tokens, key)}
        </a>
      ) : (
        <span key={key}>{renderInline(link.tokens, key)}</span>
      );
    }
    case 'image':
      // Not rendered: a remote image in a transcript is a tracking pixel with extra
      // steps, and the alt text still tells the reader something was there.
      return (
        <span key={key} className="md-image-alt">
          {(token as Tokens.Image).text}
        </span>
      );
    case 'html':
      // Inline raw HTML is shown literally. Only the block-level `<details>` above gets
      // special treatment.
      return (token as Tokens.HTML).raw;
    case 'br-space':
      return ' ';
    default:
      return (token as { raw?: string }).raw ?? '';
  }
}
