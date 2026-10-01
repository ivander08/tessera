import { useState } from 'react';
import type { PromptEntry, PromptOrderEntry } from '../lib/presets/types';
import { resolveOrder } from '../lib/presets/resolvePrompts';

/**
 * The preset's own prompt list, as a tick list.
 *
 * This is the SillyTavern Prompt Manager, and it is the half of a preset that does the
 * work: a preset's behaviour lives in these entries, and the sampler values it ships are
 * the smaller part. Before this existed, an imported preset's prompt list was parsed,
 * stored, counted in the list view and never emitted — so a preset that ships 46 prompts
 * changed eight numbers and nothing else.
 *
 * ## What the reader sees
 *
 * Entries come from the preset's own `prompt_order`, which is what ST's Prompt Manager
 * renders and therefore what the author ticked. `prompts[].enabled` is a stale duplicate
 * that disagrees with it, so it is never shown as the state of a row.
 *
 * Rows are ordered as the preset ordered them, because that order IS the emission order
 * — reordering here would change what the model reads. That is why there is no
 * drag-to-reorder: it is the one control whose absence is deliberate.
 *
 * Markers (`chatHistory`, `charDescription`, …) are shown but are not editable text.
 * They name a position where Tessera substitutes something it built from the card, so
 * the row says what it will render rather than pretending to own the content.
 */
export function PromptListEditor({
  entries,
  order,
  onChange,
}: {
  entries: PromptEntry[];
  order: PromptOrderEntry[];
  onChange: (next: PromptOrderEntry[]) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = resolveOrder(entries, order);
  const byIdentifier = new Map(entries.map((entry) => [entry.identifier, entry]));
  const enabledCount = rows.filter((row) => row.enabled).length;

  function toggle(identifier: string) {
    // The stored order is rewritten wholesale from the resolved rows, so a toggle on a
    // row that came from `prompts[].enabled` (rather than from `prompt_order`) is
    // recorded explicitly instead of being silently re-derived the same way next read.
    onChange(
      rows.map((row) => ({
        identifier: row.prompt.identifier,
        enabled: row.prompt.identifier === identifier ? !row.enabled : row.enabled,
      })),
    );
  }

  function setAll(enabled: boolean) {
    onChange(rows.map((row) => ({ identifier: row.prompt.identifier, enabled })));
  }

  return (
    <div className="form-row">
      <div className="form-label">
        <span>Prompts</span>
        <span className="form-hint">
          {rows.length === 0
            ? 'this preset carries no prompt list'
            : `${enabledCount} of ${rows.length} on — emitted in this order`}
        </span>
      </div>

      {rows.length > 0 && (
        <>
          <div className="row-actions" style={{ gap: 6, marginBottom: 8 }}>
            <button type="button" className="btn quiet" onClick={() => setAll(true)}>
              All on
            </button>
            <button type="button" className="btn quiet" onClick={() => setAll(false)}>
              All off
            </button>
          </div>

          <div className="panel panel-pad" style={{ display: 'grid', gap: 2 }}>
            {rows.map((row) => {
              const entry = byIdentifier.get(row.prompt.identifier);
              const isMarker = entry?.marker === true;
              const depth = entry?.injectionPosition === 0 ? entry.injectionDepth ?? 0 : null;
              const label = entry?.name || row.prompt.identifier;
              const open = expanded === row.prompt.identifier;

              return (
                <div key={row.prompt.identifier}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={() => toggle(row.prompt.identifier)}
                      aria-label={`Enable ${label}`}
                    />
                    <button
                      type="button"
                      className="btn quiet"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'left',
                        color: row.enabled ? 'var(--ink)' : 'var(--ink-faint)',
                      }}
                      onClick={() =>
                        setExpanded(open ? null : row.prompt.identifier)
                      }
                      aria-expanded={open}
                    >
                      <span
                        style={{
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {label}
                      </span>
                    </button>
                    <span className="form-hint" style={{ flexShrink: 0 }}>
                      {isMarker
                        ? 'position'
                        : depth !== null
                          ? `depth ${depth}`
                          : entry?.role && entry.role !== 'system'
                            ? entry.role
                            : `${(entry?.content ?? '').length} ch`}
                    </span>
                  </div>

                  {open && (
                    <div style={{ padding: '6px 0 10px 26px' }}>
                      {isMarker ? (
                        <p className="form-hint" style={{ margin: 0 }}>
                          A position, not text. Tessera fills this slot from the card — here it
                          renders the character&rsquo;s own description, personality or scenario.
                        </p>
                      ) : (
                        <textarea
                          className="field"
                          readOnly
                          rows={Math.min(14, Math.max(3, Math.ceil((entry?.content?.length ?? 0) / 90)))}
                          value={entry?.content ?? ''}
                        />
                      )}
                      {depth !== null && (
                        <p className="form-hint" style={{ marginTop: 4 }}>
                          Injected {depth} message{depth === 1 ? '' : 's'} from the end of the
                          conversation, every turn — not part of the static head.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="form-hint" style={{ marginTop: 6 }}>
            The order is the preset&rsquo;s own and is what the model reads, so it is not
            reorderable here. With nothing on, Tessera falls back to its standard prompt.
          </p>
        </>
      )}
    </div>
  );
}
