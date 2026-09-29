import type { ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

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

export function Markdown({ content }: { content: string }): ReactNode {
  const tokens = marked.lexer(content);
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
        <ol key={key} className="md-list">
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
      <div className="md-details-body">{renderBlocks(marked.lexer(body), `${key}-body`)}</div>
    </details>
  );
}

function renderInline(tokens: Token[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const key = `${keyPrefix}-i-${i}`;

    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text;
        out.push(text.tokens ? renderInline(text.tokens, key) : text.text);
        break;
      }
      case 'escape':
        out.push((token as Tokens.Escape).text);
        break;
      case 'em':
        out.push(
          <em key={key} className="md-em">
            {renderInline((token as Tokens.Em).tokens ?? [], key)}
          </em>,
        );
        break;
      case 'strong':
        out.push(
          <strong key={key} className="md-strong">
            {renderInline((token as Tokens.Strong).tokens ?? [], key)}
          </strong>,
        );
        break;
      case 'del':
        out.push(
          <del key={key}>
            {renderInline((token as Tokens.Del).tokens ?? [], key)}
          </del>,
        );
        break;
      case 'codespan':
        out.push(
          <code key={key} className="md-code">
            {(token as Tokens.Codespan).text}
          </code>,
        );
        break;
      case 'br':
        out.push(<br key={key} />);
        break;
      case 'link': {
        const link = token as Tokens.Link;
        // `javascript:` and `data:` in a model reply are a hostile payload, not a link.
        const safe = /^(https?:|mailto:)/i.test(link.href);
        out.push(
          safe ? (
            <a key={key} className="md-link" href={link.href} target="_blank" rel="noreferrer noopener">
              {renderInline(link.tokens, key)}
            </a>
          ) : (
            <span key={key}>{renderInline(link.tokens, key)}</span>
          ),
        );
        break;
      }
      case 'image':
        // Not rendered: a remote image in a transcript is a tracking pixel with extra
        // steps, and the alt text still tells the reader something was there.
        out.push(
          <span key={key} className="md-image-alt">
            {(token as Tokens.Image).text}
          </span>,
        );
        break;
      case 'html': {
        // Inline raw HTML is shown literally. Only the block-level `<details>` above
        // gets special treatment.
        out.push((token as Tokens.HTML).raw);
        break;
      }
      case 'br-space':
        out.push(' ');
        break;
      default:
        out.push((token as { raw?: string }).raw ?? '');
    }
  }
  return out;
}
