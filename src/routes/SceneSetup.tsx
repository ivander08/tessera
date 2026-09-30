import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import {
  DEFAULT_SCENE_SETUP,
  STATE_MODE_OPTIONS,
  TIME_PACE_OPTIONS,
  type SceneSetup,
} from '../lib/scene/setup';
import { AppBar, BackLink } from '../components/AppBar';
import { Avatar } from '../components/Avatar';
import { OpeningPicker } from '../components/OpeningPicker';
import type { CharacterCardJson } from '../lib/cards/types';

interface CharacterDetail {
  id: string;
  name: string;
  avatar: string | null;
  card: CharacterCardJson | null;
}

/** The steps, in order. The wizard is short enough that the whole list is the navigation. */
const STEPS = ['Opening', 'Time', 'World state'] as const;

/**
 * Starting a scene.
 *
 * Three questions, asked every time, with a Skip that accepts every default. The point is
 * not to collect preferences — it is that the two things which decide how a scene behaves
 * (how fast time moves, and whether anything is tracked at all) are decided ONCE, before
 * the first turn, rather than being discovered from wrong behaviour twenty turns in.
 *
 * Nothing is remembered between chats. The defaults are the answer for most scenes, and a
 * remembered choice would silently apply a setting chosen for a different story — a
 * mistake that is invisible until the clock has drifted.
 */
export default function SceneSetup() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, loading } = useAsync(
    () => apiJson<CharacterDetail>(`/api/characters/${encodeURIComponent(id)}`),
    [id],
  );

  const [step, setStep] = useState(0);
  const [opening, setOpening] = useState(0);
  const [setup, setSetup] = useState<SceneSetup>({ ...DEFAULT_SCENE_SETUP });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setFailure(null);
    try {
      // Order matters: the chat has to exist before a setup row can reference it.
      const chat = await apiJson<{ id: string }>('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ characterId: id, greetingIndex: opening }),
      });
      await apiJson(`/api/chats/${encodeURIComponent(chat.id)}/scene`, {
        method: 'PATCH',
        body: JSON.stringify(setup),
      });
      navigate(`/chat/${chat.id}`);
    } catch (cause) {
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const shown = data?.card?.nickname || data?.name || 'Character';
  const last = step === STEPS.length - 1;

  return (
    <>
      <AppBar
        lead={<BackLink to="/characters" label="Characters" />}
        title={<span className="bar-title">Start a scene</span>}
      />

      <main className="sheet">
        <div className="sheet-head">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {data && <Avatar src={data.avatar} name={shown} />}
            <div>
              <h1 className="title">{shown}</h1>
              <p className="sheet-sub" style={{ margin: 0 }}>
                Step {step + 1} of {STEPS.length} · {STEPS[step]}
              </p>
            </div>
          </div>
        </div>

        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}
        {failure && <div className="note danger">{failure}</div>}

        {data && (
          <>
            {step === 0 && (
              <section className="section">
                <span className="eyebrow">Which opening</span>
                <p className="form-hint" style={{ marginBottom: 10 }}>
                  Which scene this starts from. Chosen now because it is baked into the first
                  message — changing it later means deleting that message.
                </p>
                <OpeningPicker characterId={id} selected={opening} onSelect={setOpening} />
              </section>
            )}

            {step === 1 && (
              <section className="section">
                <span className="eyebrow">How time moves</span>
                <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                  {TIME_PACE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`pick-row${setup.timePace === option.value ? ' is-active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="timePace"
                        checked={setup.timePace === option.value}
                        onChange={() => setSetup({ ...setup, timePace: option.value })}
                      />
                      <span>
                        <span style={{ color: 'var(--ink)' }}>{option.label}</span>
                        <span className="form-hint" style={{ display: 'block' }}>
                          {option.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            {last && (
              <section className="section">
                <span className="eyebrow">World state</span>
                <p className="form-hint" style={{ marginBottom: 10 }}>
                  What the narrator keeps track of — time, place, weather, who is present, what
                  everyone is wearing. It is written after each completed turn and never shown
                  in the prose.
                </p>
                <div style={{ display: 'grid', gap: 8 }}>
                  {STATE_MODE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`pick-row${setup.stateMode === option.value ? ' is-active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="stateMode"
                        checked={setup.stateMode === option.value}
                        onChange={() => setSetup({ ...setup, stateMode: option.value })}
                      />
                      <span>
                        <span style={{ color: 'var(--ink)' }}>{option.label}</span>
                        <span className="form-hint" style={{ display: 'block' }}>
                          {option.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                <label
                  className="pick-row"
                  style={{ marginTop: 10, opacity: setup.stateMode === 'off' ? 0.5 : 1 }}
                >
                  <input
                    type="checkbox"
                    checked={setup.generateOpeningState && setup.stateMode !== 'off'}
                    disabled={setup.stateMode === 'off'}
                    onChange={(event) =>
                      setSetup({ ...setup, generateOpeningState: event.target.checked })
                    }
                  />
                  <span>
                    <span style={{ color: 'var(--ink)' }}>
                      Set the opening time, place and outfits from the greeting
                    </span>
                    <span className="form-hint" style={{ display: 'block' }}>
                      One call when the scene opens, so the first turn already knows where it is.
                      Nothing is invented that the greeting does not say.
                    </span>
                  </span>
                </label>
              </section>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 24, flexWrap: 'wrap' }}>
              {step > 0 && (
                <button type="button" className="btn quiet" onClick={() => setStep(step - 1)} disabled={busy}>
                  Back
                </button>
              )}
              {!last ? (
                <button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
                  Next
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={() => void start()} disabled={busy}>
                  {busy ? 'Starting…' : 'Start scene'}
                </button>
              )}
              {/* Skip accepts every default, which is what most scenes want. It is a peer
                  of the primary action rather than hidden, because "just start it" is a
                  real answer and making it hard to find is how a wizard becomes a toll. */}
              <button
                type="button"
                className="btn quiet"
                onClick={() => void start()}
                disabled={busy}
                title="Start with the defaults: time moves when the writing says so, state tracked automatically."
              >
                Skip
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
}
