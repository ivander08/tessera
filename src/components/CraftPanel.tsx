import { useState } from 'react';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import {
  CRAFT_TOGGLES,
  POV_OPTIONS,
  REGISTER_OPTIONS,
  type Craft,
} from '../lib/scene/setup';

/**
 * How the scene is written, reachable from inside the chat.
 *
 * The content policy sits first, above the person and the register, because it is the one
 * a reader arriving from an imported preset is most likely to change — their preset already
 * carries its own content instructions, and Tessera's would then be a second voice saying
 * the same thing.
 *
 * The panel renders the server's ECHOED setup rather than its own optimistic state, because
 * `parseSceneSetup` is the authority on what was accepted: an unknown enum member falls back
 * rather than being stored, and showing the reader their own value would hide that.
 */
export function CraftPanel({ chatId }: { chatId: string }) {
  const { data, error, loading, reload } = useAsync(
    () =>
      apiJson<{ setup: { craft: Craft } }>(`/api/chats/${encodeURIComponent(chatId)}/scene`),
    [chatId],
  );

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const craft = data?.setup.craft;

  async function patch(change: Partial<Craft>) {
    if (!craft) return;
    setBusy(true);
    setFailure(null);
    try {
      await apiJson(`/api/chats/${encodeURIComponent(chatId)}/scene`, {
        method: 'PATCH',
        body: JSON.stringify({ craft: { ...craft, ...change } }),
      });
      reload();
    } catch (cause) {
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {loading && <p className="sheet-sub">Loading…</p>}
      {error && <div className="note danger">{error}</div>}
      {failure && <div className="note danger">{failure}</div>}

      {craft && (
        <>
          <p className="form-hint" style={{ marginTop: 0 }}>
            Changing anything here applies from the next turn, and costs one cache miss.
          </p>

          {CRAFT_TOGGLES.map((toggle) => (
            <label key={toggle.key} className="form-row">
              <span className="form-label">
                <span>{toggle.label}</span>
                <span className="form-hint">{toggle.description}</span>
              </span>
              <input
                type="checkbox"
                checked={craft[toggle.key]}
                disabled={busy}
                onChange={(event) => void patch({ [toggle.key]: event.target.checked })}
              />
            </label>
          ))}

          <label className="form-row">
            <span className="form-label">
              <span>Narrative person</span>
              <span className="form-hint">
                {POV_OPTIONS.find((option) => option.value === craft.pov)?.description}
              </span>
            </span>
            <select
              className="field"
              value={craft.pov}
              disabled={busy}
              onChange={(event) => void patch({ pov: event.target.value as Craft['pov'] })}
            >
              {POV_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="form-row">
            <span className="form-label">
              <span>Prose register</span>
              <span className="form-hint">
                {REGISTER_OPTIONS.find((option) => option.value === craft.register)?.description}
              </span>
            </span>
            <select
              className="field"
              value={craft.register}
              disabled={busy}
              onChange={(event) =>
                void patch({ register: event.target.value as Craft['register'] })
              }
            >
              {REGISTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
