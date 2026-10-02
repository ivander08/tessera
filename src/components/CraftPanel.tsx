import { useState } from 'react';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import {
  CRAFT_TOGGLES,
  POV_OPTIONS,
  REGISTER_OPTIONS,
  TIME_PACE_OPTIONS,
  type Craft,
  type SceneSetup,
} from '../lib/scene/setup';
import { useToast } from './Toast';

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
 *
 * Time pace lives here rather than only in the start-a-scene wizard because it is the
 * setting a reader actually discovers is wrong mid-scene: at "minute by minute" a
 * conversation that runs all evening takes forty exchanges to get there. A setting that
 * decides how the scene reads, and can only be changed by starting a new scene, is a
 * setting that will be lived with rather than fixed.
 */
export function CraftPanel({ chatId }: { chatId: string }) {
  const { data, error, loading, reload } = useAsync(
    () =>
      apiJson<{ setup: { craft: Craft; timePace: SceneSetup['timePace'] } }>(
        `/api/chats/${encodeURIComponent(chatId)}/scene`,
      ),
    [chatId],
  );

  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const craft = data?.setup.craft;
  const timePace = data?.setup.timePace;

  async function patch(change: Partial<Craft> | { timePace: SceneSetup['timePace'] }) {
    if (!craft) return;
    setBusy(true);
    try {
      await apiJson(`/api/chats/${encodeURIComponent(chatId)}/scene`, {
        method: 'PATCH',
        body: JSON.stringify(
          'timePace' in change ? { timePace: change.timePace } : { craft: { ...craft, ...change } },
        ),
      });
      // No success toast: the panel re-renders the server's echo, so the control moving is
      // the confirmation. A failure is the thing that needs saying.
      reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {loading && <p className="sheet-sub">Loading…</p>}
      {error && <div className="note danger">{error}</div>}

      {craft && (
        <>
          <p className="form-hint" style={{ marginTop: 0 }}>
            Changing anything here applies from the next turn, and costs one cache miss.
          </p>

          {/* Above the switches: it is the one setting here that changes what the scene
              reads like rather than how it is worded, and the one a reader arrives looking
              for after a scene takes all night to get through dinner. */}
          <label className="form-row">
            <span className="form-label">
              <span>Time pace</span>
              <span className="form-hint">
                {TIME_PACE_OPTIONS.find((option) => option.value === timePace)?.description}
              </span>
            </span>
            <select
              className="field"
              value={timePace ?? ''}
              disabled={busy}
              onChange={(event) =>
                void patch({ timePace: event.target.value as SceneSetup['timePace'] })
              }
            >
              {TIME_PACE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

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
