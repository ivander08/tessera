import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppBar, BackLink, CrumbSep } from '../components/AppBar';
import { ConfirmPrompt } from '../components/ConfirmPrompt';
import { useToast } from '../components/Toast';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import type { PresetDetail, PresetSummary } from '../components/PresetEditor';

/**
 * Preset management.
 *
 * A preset is a document the user authors: a system prompt, pre- and post-history
 * instructions, an assistant prefill, stop strings, and the sampler values and model it
 * was tuned for. Attach one to a chat from that chat's menu.
 *
 * Importing somebody else's preset file is gone. The normalizer that read SillyTavern's
 * two sampler namespaces, the prompt list it produced and the regex pack that went with
 * it existed only to carry an imported preset's internals, and the techniques worth
 * keeping from that preset family live in Tessera's own craft blocks now — where every
 * chat gets them, with no file to import.
 */
export default function Presets() {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<PresetSummary[]>('/api/presets'),
    [],
  );
  const navigate = useNavigate();

  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // The preset the reader has asked to delete, held until they confirm.
  const [confirming, setConfirming] = useState<PresetSummary | null>(null);

  /**
   * A preset with nothing in it, opened straight in the editor.
   *
   * That is the only reason to make a blank one, so there is no intermediate list row to
   * click through.
   */
  async function createBlank() {
    setCreating(true);
    try {
      const created = await apiJson<{ id: string }>('/api/presets', {
        method: 'POST',
        body: JSON.stringify({ name: 'New preset' }),
      });
      navigate(`/presets/${created.id}`);
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setCreating(false);
    }
  }

  async function duplicate(id: string) {
    setBusy(true);
    try {
      const copy = await apiJson<PresetDetail>('/api/presets/duplicate', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      toast.success(`Copied to "${copy.name}".`);
      reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(preset: PresetSummary) {
    setBusy(true);
    try {
      await apiJson(`/api/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
      toast.success(`Deleted "${preset.name}".`);
      setConfirming(null);
      reload();
    } catch (cause) {
      toast.failure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppBar
        lead={<BackLink to="/" label="Scenes" />}
        title={
          <>
            <CrumbSep />
            <span className="bar-title">Presets</span>
          </>
        }
      />

      <main className="sheet">
      <div className="sheet-head">
        <div>
          <h1 className="title">Presets</h1>
          <p className="sheet-sub" style={{ marginTop: 8 }}>
            A preset is a whole generation configuration — sampler values, prompt structure,
            stop strings, prefill, and the model they were tuned for. Attach one to a chat from
            that chat&rsquo;s menu; every preset is available in every chat.
          </p>
        </div>
      </div>
      <hr className="rule-fade" style={{ marginBottom: 18 }} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn primary min-h-10"
            onClick={() => void createBlank()}
            disabled={creating}
          >
            {creating ? 'Creating…' : 'New preset'}
          </button>
        </div>
      </section>

      {loading && <p className="sheet-sub">Loading…</p>}
      {error && <div className="note danger">{error}</div>}

      {data && data.length === 0 && (
        <p className="sheet-sub">
          No presets yet. A preset overrides the sampler, prompt and stop-string settings
          for the chats that use it.
        </p>
      )}

      <div className="section">
        {data?.map((preset) => (
          <div key={preset.id} className="panel panel-pad" style={{ marginBottom: 12 }}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1">
                <p className="row-title">{preset.name}</p>
                <p className="row-sub" style={{ marginTop: 7, whiteSpace: 'normal' }}>
                  {preset.knob_count} knob{preset.knob_count === 1 ? '' : 's'}
                  {preset.has_config === 1 && ' · config'}
                </p>
                <p className="form-hint" style={{ marginTop: 7 }}>
                  created {new Date(preset.created_at).toLocaleDateString()}
                  {preset.updated_at > preset.created_at &&
                    ` · edited ${new Date(preset.updated_at).toLocaleDateString()}`}
                </p>
              </div>
              {/* Below the metadata on a phone, beside it on a wider screen: three
                  buttons plus the name do not fit across 390px, and squeezing them
                  truncates the one thing the row exists to show. The rule keeps the
                  stacked buttons from reading as a fourth line of metadata. */}
              <div className="row-actions border-t border-[var(--line)] pt-3 sm:border-t-0 sm:pt-0" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Link to={`/presets/${preset.id}`} className="btn">
                  Edit
                </Link>
                <button
                  type="button"
                  className="btn quiet"
                  onClick={() => void duplicate(preset.id)}
                  disabled={busy}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="btn quiet danger"
                  onClick={() => setConfirming(preset)}
                  disabled={busy}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      </main>

      {confirming && (
        <ConfirmPrompt
          title="Delete this preset"
          message={`Delete "${confirming.name}"? Chats using it fall back to the global settings.`}
          confirmLabel="Delete"
          busy={busy}
          danger
          onConfirm={() => void remove(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}
