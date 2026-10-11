import { useState } from 'react';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import {
  CRAFT_ENUMS,
  CRAFT_TOGGLES,
  TIME_PACE_OPTIONS,
  type Craft,
  type SceneSetup,
} from '../lib/scene/setup';
import {
  renderAntiRepetition,
  renderContentPolicy,
  renderCraftBlock,
  renderVocalisation,
} from '../lib/prompt/craftBlock';
import { useToast } from './Toast';

/**
 * Which side of the cache boundary a control sits on.
 *
 * This is not cosmetic. The cached prefix is re-sent at cache price and only re-billed when
 * it changes; the tail is billed at full price every turn. Four of these controls are
 * emitted into the TAIL — `contentPolicy`, `vocalisation`, `antiParrot` and `stagnation`,
 * see `renderContentPolicy`, `renderVocalisation` and `renderAntiRepetition` — so changing
 * them costs nothing, while changing any of the others costs one cache miss.
 *
 * Typed as a complete `Record` over the toggle/enum keys on purpose: a control added later
 * has to be classified deliberately rather than defaulting silently to the wrong side.
 */
type CostSide = 'prefix' | 'tail';

const SIDE: Record<keyof Craft, CostSide> = {
  // Tail: emitted by `renderContentPolicy` / `renderVocalisation` / `renderAntiRepetition`.
  contentPolicy: 'tail',
  vocalisation: 'tail',
  antiParrot: 'tail',
  stagnation: 'tail',

  // Everything else is in `renderCraftBlock`, which is the cached prefix.
  antiSlop: 'prefix',
  interiority: 'prefix',
  earnedKnowledge: 'prefix',
  independentNpcs: 'prefix',
  impulseFirst: 'prefix',
  subtext: 'prefix',
  dialogueState: 'prefix',
  livingWorld: 'prefix',
  sideCharacters: 'prefix',
  nomenclature: 'prefix',
  wordplay: 'prefix',
  dialects: 'prefix',
  bonds: 'prefix',
  threads: 'prefix',
  pov: 'prefix',
  register: 'prefix',
  momentum: 'prefix',
  tense: 'prefix',
  showTell: 'prefix',
  narrativeDistance: 'prefix',
  responseLength: 'prefix',
  density: 'prefix',
  rhythm: 'prefix',
  figurative: 'prefix',
  vocabulary: 'prefix',
  profanity: 'prefix',
  dialogueFrequency: 'prefix',
  dialogueNaturalism: 'prefix',
  dialogueDepth: 'prefix',
  changeResistance: 'prefix',
  traitAdherence: 'prefix',
  consequence: 'prefix',
};

/**
 * Every control, in the order the two option lists already had: toggles first, then the
 * enums. The topic grouping that used to be here is gone — it added five headings and a fold
 * per topic and read worse than the list it replaced.
 */
const ALL_KEYS: string[] = [
  ...CRAFT_TOGGLES.map((toggle) => String(toggle.key)),
  ...CRAFT_ENUMS.map((entry) => String(entry.key)),
];

/** The two option lists keyed by their own key, so a lookup is a field access. */
const TOGGLE_BY_KEY: Record<string, (typeof CRAFT_TOGGLES)[number]> = Object.fromEntries(
  CRAFT_TOGGLES.map((toggle) => [String(toggle.key), toggle]),
);
const ENUM_BY_KEY: Record<string, (typeof CRAFT_ENUMS)[number]> = Object.fromEntries(
  CRAFT_ENUMS.map((entry) => [String(entry.key), entry]),
);

/** Which side of the cache boundary a key sits on. */
function sideOf(key: string): CostSide {
  return SIDE[key as keyof Craft];
}

/**
 * How the scene is written, reachable from inside the chat.
 *
 * The panel renders the server's ECHOED setup rather than its own optimistic state, because
 * `parseSceneSetup` is the authority on what was accepted: an unknown enum member falls back
 * rather than being stored, and showing the reader their own value would hide that.
 *
 * Time pace lives here rather than only in the start-a-scene wizard because it is the
 * setting a reader actually discovers is wrong mid-scene: a scene whose clock has drifted
 * is one they want to correct without starting over. The choice is now only managed vs.
 * reader-owned — the old per-multiplier paces all drove the same broken instruction, and
 * the clock is advanced by `advanceClock` rather than by the model.
 */
export function CraftPanel({ chatId }: { chatId: string }) {
  const { data, error, loading, reload } = useAsync(
    () =>
      apiJson<{ setup: { craft: Craft; timePace: SceneSetup['timePace'] } }>(
        `/api/chats/${encodeURIComponent(chatId)}/scene`,
      ),
    [chatId],
  );

  /**
   * The key in flight, not a single `busy` flag.
   *
   * One `busy` disabled all 36 controls for the round trip of whichever one was touched,
   * which dropped focus to `BODY` and made the panel feel like it had been taken away. The
   * request is per-key, so the disabling is too.
   */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [view, setView] = useState<'settings' | 'prompt'>('settings');
  const toast = useToast();

  const craft = data?.setup.craft;
  const timePace = data?.setup.timePace;

  async function patch(change: Partial<Craft> | { timePace: SceneSetup['timePace'] }) {
    if (!craft) return;
    const key = 'timePace' in change ? 'timePace' : Object.keys(change)[0];
    setPendingKey(key);
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
      setPendingKey(null);
    }
  }

  return (
    <div>
      {loading && <p className="sheet-sub">Loading…</p>}
      {error && <div className="note danger">{error}</div>}

      {craft && (
        <>
          {/* The panel's name promises the prompt and used to deliver 36 controls. Both are
              useful, so both are here and the reader picks. */}
          <div className="tabs" role="group" aria-label="Craft view">
            <button
              type="button"
              className="tab"
              aria-pressed={view === 'settings'}
              onClick={() => setView('settings')}
            >
              Settings
            </button>
            <button
              type="button"
              className="tab"
              aria-pressed={view === 'prompt'}
              onClick={() => setView('prompt')}
            >
              What the model is told
            </button>
          </div>

          {view === 'prompt' ? (
            <CraftPreview craft={craft} />
          ) : (
            <CraftControls
              craft={craft}
              timePace={timePace}
              pendingKey={pendingKey}
              onPatch={patch}
            />
          )}
        </>
      )}
    </div>
  );
}

function CraftControls({
  craft,
  timePace,
  pendingKey,
  onPatch,
}: {
  craft: Craft;
  timePace: SceneSetup['timePace'] | undefined;
  pendingKey: string | null;
  onPatch: (change: Partial<Craft> | { timePace: SceneSetup['timePace'] }) => Promise<void>;
}) {
  const prefixKeys = ALL_KEYS.filter((key) => sideOf(key) === 'prefix');
  const tailKeys = ALL_KEYS.filter((key) => sideOf(key) === 'tail');

  function row(key: string) {
    const toggle = TOGGLE_BY_KEY[key];
    if (toggle) {
      return (
        <label key={key} className="form-row is-toggle" aria-busy={pendingKey === key}>
          <span className="form-label">
            <span>{toggle.label}</span>
            <span className="form-hint">{toggle.description}</span>
          </span>
          <input
            type="checkbox"
            checked={craft[toggle.key]}
            disabled={pendingKey === key}
            onChange={(event) => void onPatch({ [toggle.key]: event.target.checked })}
          />
        </label>
      );
    }
    const entry = ENUM_BY_KEY[key];
    if (!entry) return null;
    return (
      <label key={key} className="form-row" aria-busy={pendingKey === key}>
        <span className="form-label">
          <span>{entry.label}</span>
          <span className="form-hint">
            {entry.options.find((option) => option.value === craft[entry.key])?.description}
          </span>
        </span>
        <select
          className="field"
          value={craft[entry.key] as string}
          disabled={pendingKey === key}
          onChange={(event) =>
            void onPatch({ [entry.key]: event.target.value } as Partial<Craft>)
          }
        >
          {entry.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <>
      {/* Above the switches: it is the one setting here that changes what the scene reads
          like rather than how it is worded, and the one a reader arrives looking for after a
          scene takes all night to get through dinner. */}
      <label className="form-row" aria-busy={pendingKey === 'timePace'}>
        <span className="form-label">
          <span>Time pace</span>
          <span className="form-hint">
            {TIME_PACE_OPTIONS.find((option) => option.value === timePace)?.description}
          </span>
        </span>
        <select
          className="field"
          value={timePace ?? ''}
          disabled={pendingKey === 'timePace'}
          onChange={(event) =>
            void onPatch({ timePace: event.target.value as SceneSetup['timePace'] })
          }
        >
          {TIME_PACE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/* Two headings, because the cost is genuinely different on each side of the cache
          boundary and the old single hint claimed every control cost a cache miss.

          Flat within each side, deliberately. A first attempt grouped them into five topic
          sections with the long tail behind `<details>` folds, which read far worse than the
          list it replaced: five headings with one control visible under each, a fold for the
          rest, and the topic headings rendering as bare inline labels because `.eyebrow` is
          an inline class and only `.section > .eyebrow` is styled. A 36-item list is long,
          but every item is one row and the reader can see what they are choosing between. */}
      <section className="section">
        <span className="eyebrow">Written into the cached prefix</span>
        <p className="form-hint" style={{ marginTop: 0 }}>
          Changing one of these costs one cache miss, once: the prefix is re-billed the first
          time it is sent after a change, then cached again from there.
        </p>
        {prefixKeys.map(row)}
      </section>

      <section className="section">
        <span className="eyebrow">Sent with every turn</span>
        <p className="form-hint" style={{ marginTop: 0 }}>
          These sit in the prompt tail, after the cached prefix. Changing them costs nothing —
          they are billed at full price on every turn either way.
        </p>
        {tailKeys.map(row)}
      </section>
    </>
  );
}

/**
 * The prompt, as the model receives it.
 *
 * Rendered client-side from the same module the Worker uses — `craftBlock.ts` imports only a
 * type from the scene setup, so it is already client-safe and there is no endpoint for this.
 * A second implementation built for display would drift from the one that is actually sent,
 * and the drift would be invisible, which is the failure mode this view exists to prevent.
 */
function CraftPreview({ craft }: { craft: Craft }) {
  const [copied, setCopied] = useState(false);

  const blocks: Array<{ title: string; side: CostSide; text: string }> = [
    { title: 'Craft block', side: 'prefix', text: renderCraftBlock(craft) },
    { title: 'Content policy', side: 'tail', text: renderContentPolicy(craft) },
    { title: 'Vocalisation', side: 'tail', text: renderVocalisation(craft) },
    { title: 'Anti-repetition', side: 'tail', text: renderAntiRepetition(craft) },
  ];

  const all = blocks
    .map((block) => `${block.title} (${block.side})\n${block.text}`)
    .join('\n\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(all);
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch {
      // Clipboard permission can be refused; the text is selectable by hand.
    }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <p className="form-hint" style={{ margin: 0, flex: 1 }}>
          Exactly what is sent for this chat's craft, from the same module the server renders
          with. Blocks marked <strong>tail</strong> sit after the cached prefix.
        </p>
        <button type="button" className="btn quiet" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {blocks.map((block) => (
        <section key={block.title} className="section">
          <span className="eyebrow">
            {block.title} · {block.side}
          </span>
          <div className="panel panel-pad">
            <pre
              className="data"
              style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}
            >
              {block.text.length > 0 ? block.text : '(empty — the block is omitted entirely)'}
            </pre>
          </div>
        </section>
      ))}
    </>
  );
}
