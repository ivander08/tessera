import { useEffect, useRef, useState } from 'react';
import { AppBar } from '../components/AppBar';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import { parseFf5 } from '../lib/presets/ff5';
import { PresetParseError, parsePresetFile } from '../lib/presets/importSt';
import type { NormalizedPreset } from '../lib/presets/types';
import { PresetEditor, type PresetDetail, type PresetSummary } from '../components/PresetEditor';

/** What `/api/presets` returns for a fresh import. */
interface ImportResult {
  id: string;
  name: string;
  kind: string;
  knobs: Record<string, number | string | string[]>;
  dropped: string[];
  regexCount: number;
  promptCount: number;
  needsRegexPack: boolean;
}

/**
 * Preset management.
 *
 * A preset is a file the user got from somewhere else — SillyTavern's preset manager, a
 * community chat-completion preset, the Freaky Frankenstein archive — so this screen has
 * two jobs beyond listing: get the file in without a round trip for an obvious mistake,
 * and report what the import refused to carry. A preset can also be started blank — the
 * file is the usual way in, not the only one.
 *
 * That second job is the honest-knobs rule and it is why the import result is shown
 * rather than dismissed. A preset that declares `tfs_z` has a knob the provider will
 * silently ignore; ST logs a warning nobody reads, so the setting appears to be in force
 * and is not. The refusal list is the only place that becomes visible.
 */
export default function Presets() {
  const { data, error, loading, reload } = useAsync(
    () => apiJson<PresetSummary[]>('/api/presets'),
    [],
  );

  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [ff5, setFf5] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<PresetDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // The editor sits below the import zone, so on a phone it opens off-screen. Without
  // this the user taps Edit or New preset and the screen appears not to have changed.
  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [editing]);

  async function importFile(file: File) {
    setStatus(null);
    setResult(null);
    setImporting(true);

    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setStatus(`${file.name} is not JSON.`);
      setImporting(false);
      return;
    }

    // Parsed here first so a malformed file costs nothing and says why. The Worker parses
    // it again on the way in — this is a fast rejection, not the authority.
    let parsed: NormalizedPreset;
    try {
      parsed = ff5
        ? parseFf5({ ...(raw as Record<string, unknown>), name: file.name })
        : parsePresetFile({ name: file.name, json: raw });
    } catch (cause) {
      setStatus(
        cause instanceof PresetParseError ? cause.message : `Could not read ${file.name}: ${messageOf(cause)}`,
      );
      setImporting(false);
      return;
    }

    try {
      const imported = await apiJson<ImportResult>('/api/presets', {
        method: 'POST',
        // The file itself, not the normalized preset: the Worker re-runs the importer so
        // the regex scripts and prompt entries land in their own columns.
        body: JSON.stringify({ name: parsed.name, json: raw, kind: ff5 ? 'ff5' : parsed.kind }),
      });
      setResult(imported);
      reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setImporting(false);
    }
  }

  async function openEditor(id: string) {
    setStatus(null);
    try {
      setEditing(await apiJson<PresetDetail>(`/api/presets/${encodeURIComponent(id)}`));
    } catch (cause) {
      setStatus(messageOf(cause));
    }
  }

  /**
   * A preset with nothing in it, created through the import endpoint.
   *
   * The importer is the only door in, so the body is the smallest file it will accept:
   * an empty object is rejected as belonging to neither namespace, and an empty `prompts`
   * list is what makes this a chat-completion preset with no knobs, no prompts and no
   * regexes. The editor then supplies the defaults on the first save.
   */
  async function createBlank() {
    setStatus(null);
    setResult(null);
    setCreating(true);
    try {
      const created = await apiJson<ImportResult>('/api/presets', {
        method: 'POST',
        body: JSON.stringify({ name: 'New preset', json: { prompts: [] } }),
      });
      reload();
      await openEditor(created.id);
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setCreating(false);
    }
  }

  async function duplicate(id: string) {
    setStatus(null);
    setBusy(true);
    try {
      const copy = await apiJson<PresetDetail>('/api/presets/duplicate', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      setStatus(`Copied to "${copy.name}".`);
      reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(preset: PresetSummary) {
    // Confirmed by name, not by a generic "are you sure": the rows are similar and a
    // mis-tap here is unrecoverable.
    if (!window.confirm(`Delete "${preset.name}"? Chats using it fall back to the global settings.`)) {
      return;
    }
    setStatus(null);
    setBusy(true);
    try {
      await apiJson(`/api/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
      if (editing?.id === preset.id) setEditing(null);
      reload();
    } catch (cause) {
      setStatus(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppBar title={<span className="bar-title">Presets</span>} />

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
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void importFile(file);
          }}
          className={`empty flex flex-col items-center gap-3 ${
            dragging ? 'border-[var(--brass)]' : ''
          }`}
        >
          <p className="sheet-sub" style={{ marginTop: 0 }}>
            Drop a SillyTavern preset here
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              className="btn min-h-10"
              onClick={() => fileInput.current?.click()}
              disabled={importing || creating}
            >
              {importing ? 'Importing…' : 'Choose a file'}
            </button>
            {/* A preset can be written from scratch, so a file is the common way in
                rather than the only one. Import is the one door into the table, so a
                blank preset goes through it like any other. */}
            <button
              type="button"
              className="btn primary min-h-10"
              onClick={() => void createBlank()}
              disabled={creating || importing}
            >
              {creating ? 'Creating…' : 'New preset'}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so re-picking the same file after a failure still fires.
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </div>

        {/* The hint is a separate line rather than running on from the label: inline, the
            two read as one sentence and the explanation looks like the checkbox's name. */}
        <div>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={ff5}
              onChange={(event) => setFf5(event.target.checked)}
              className="h-5 w-5 shrink-0 accent-[var(--brass)]"
            />
            <span className="text-[var(--text-sm)] text-[var(--ink)]">
              This file is an FF5 bundle
            </span>
          </label>
          {/* Indented to the label text, so the two read as one control. */}
          <p className="form-hint" style={{ margin: '7px 0 0 32px' }}>
            FF5 files are ordinary chat-completion presets with a regex pack attached. Tick
            this to keep the prompts and the regexes together.
          </p>
        </div>
      </section>

      {status && <div className="note danger">{status}</div>}

      {result && <ImportReport result={result} onDismiss={() => setResult(null)} />}

      {editing && (
        <div ref={editorRef} style={{ scrollMarginTop: 14 }}>
          <PresetEditor
            // Keyed by id so opening a second preset remounts rather than reusing the
            // first one's draft state — the fields below hold local copies of the values.
            key={editing.id}
            preset={editing}
            onSaved={() => {
              setEditing(null);
              setStatus('Saved. Chats using this preset pick it up next turn.');
              reload();
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

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
                {/* Wrapped rather than ellipsised: the line carries five facts and the
                    last one is the one that tells you what is inside the preset. */}
                <p className="row-sub" style={{ marginTop: 7, whiteSpace: 'normal' }}>
                  <span className={`tag ${preset.kind === 'textgen' ? 'brass' : preset.kind === 'chat' ? 'verdigris' : ''}`}>
                    {preset.kind}
                  </span>{' '}
                  {preset.knob_count} knob{preset.knob_count === 1 ? '' : 's'}
                  {preset.has_regex === 1 && ' · regex scripts'}
                  {preset.has_prompts === 1 && ' · prompts'}
                  {preset.has_config === 1 && ' · config'}
                </p>
                <p className="form-hint" style={{ marginTop: 7 }}>
                  imported {new Date(preset.created_at).toLocaleDateString()}
                  {preset.updated_at > preset.created_at &&
                    ` · edited ${new Date(preset.updated_at).toLocaleDateString()}`}
                </p>
              </div>
              {/* Below the metadata on a phone, beside it on a wider screen: three
                  buttons plus the name do not fit across 390px, and squeezing them
                  truncates the one thing the row exists to show. The rule keeps the
                  stacked buttons from reading as a fourth line of metadata. */}
              <div className="row-actions border-t border-[var(--line)] pt-3 sm:border-t-0 sm:pt-0" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" className="btn" onClick={() => void openEditor(preset.id)}>
                  Edit
                </button>
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
                  onClick={() => void remove(preset)}
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
    </>
  );
}

/**
 * What the import did and did not carry.
 *
 * Deliberately not a toast: the refusal list is the reason this screen exists, and a
 * notice that disappears after four seconds is a notice the user will miss. It stays
 * until dismissed or replaced by the next import.
 */
function ImportReport({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
  const knobs = Object.keys(result.knobs).length;

  return (
    <section className="panel panel-pad space-y-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[var(--text-sm)]">
          Imported <span className="font-medium">{result.name}</span> as {result.kind} — {knobs}{' '}
          knob{knobs === 1 ? '' : 's'}
          {result.regexCount > 0 && `, ${result.regexCount} regex script${result.regexCount === 1 ? '' : 's'}`}
          {result.promptCount > 0 && `, ${result.promptCount} prompt entr${result.promptCount === 1 ? 'y' : 'ies'}`}.
        </p>
        <button type="button" className="btn min-h-10 shrink-0" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      {result.needsRegexPack && (
        <p className="text-[var(--text-sm)] text-[var(--warn)]">
          This preset ships prompts but no regex scripts. It needs its regex pack to run as
          designed — without it the markup those prompts produce is never cleaned up, and
          stays in the prompt on every later turn.
        </p>
      )}

      {result.dropped.length > 0 && (
        <div className="space-y-1">
          <p className="text-[var(--text-sm)] text-[var(--warn)]">
            {result.dropped.length} setting{result.dropped.length === 1 ? '' : 's'} could not be
            carried over:
          </p>
          <ul className="space-y-0.5 font-mono text-[var(--text-xs)] text-[var(--ink-dim)]">
            {result.dropped.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
