import { useRef, useState } from 'react';
import { Link } from 'react-router';
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
 * and report what the import refused to carry.
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
  const [ff5, setFf5] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<PresetDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
    <main className="mx-auto max-w-2xl space-y-5 p-4 pb-24">
      <header className="flex items-center justify-between">
        <h1 className="text-[var(--font-lg)] font-semibold">Presets</h1>
        <nav className="flex gap-3">
          <Link to="/settings" className="app-link">
            Settings
          </Link>
          <Link to="/" className="app-link">
            ← Chats
          </Link>
        </nav>
      </header>

      <section className="space-y-2">
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
          className={`card flex flex-col items-center gap-2 p-5 text-center ${
            dragging ? 'border-[var(--accent)]' : ''
          }`}
        >
          <p className="text-[var(--font-sm)] text-[var(--ink-dim)]">
            Drop a SillyTavern preset here, or
          </p>
          <button
            type="button"
            className="btn primary min-h-10"
            onClick={() => fileInput.current?.click()}
            disabled={importing}
          >
            {importing ? 'Importing…' : 'Choose a file'}
          </button>
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

        <label className="flex min-h-10 items-center gap-3">
          <input
            type="checkbox"
            checked={ff5}
            onChange={(event) => setFf5(event.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-[var(--font-sm)]">
            This is a Freaky Frankenstein archive
          </span>
        </label>
        <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
          An FF5 file is byte-for-byte a chat-completion preset, so nothing in it says so.
          Ticking this keeps its prompts and its regex pack together.
        </p>
      </section>

      {status && <p className="text-[var(--font-sm)] text-[var(--danger)]">{status}</p>}

      {result && <ImportReport result={result} onDismiss={() => setResult(null)} />}

      {editing && (
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
      )}

      {loading && <p className="text-[var(--font-sm)] text-[var(--ink-dim)]">Loading…</p>}
      {error && <p className="text-[var(--font-sm)] text-[var(--danger)]">{error}</p>}

      {data && data.length === 0 && (
        <p className="text-[var(--font-sm)] text-[var(--ink-dim)]">
          Nothing imported yet. A preset overrides the sampler, prompt and stop-string
          settings for the chats that use it.
        </p>
      )}

      <ul className="divide-y divide-[var(--line)]">
        {data?.map((preset) => (
          <li key={preset.id} className="space-y-2 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{preset.name}</p>
                <p className="text-[var(--font-xs)] text-[var(--ink-dim)]">
                  <span className="rounded border border-[var(--line)] px-1.5 py-0.5">
                    {preset.kind}
                  </span>{' '}
                  {preset.knob_count} knob{preset.knob_count === 1 ? '' : 's'}
                  {preset.has_regex === 1 && ' · regex scripts'}
                  {preset.has_prompts === 1 && ' · prompts'}
                  {preset.has_config === 1 && ' · config'}
                </p>
                <p className="text-[var(--font-xs)] text-[var(--ink-faint)]">
                  imported {new Date(preset.created_at).toLocaleDateString()}
                  {preset.updated_at > preset.created_at &&
                    ` · edited ${new Date(preset.updated_at).toLocaleDateString()}`}
                </p>
              </div>
              {/* Below the metadata on a phone, beside it on a wider screen: three
                  buttons plus the name do not fit across 390px, and squeezing them
                  truncates the one thing the row exists to show. */}
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <button
                  type="button"
                  className="btn min-h-10"
                  onClick={() => void openEditor(preset.id)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn min-h-10"
                  onClick={() => void duplicate(preset.id)}
                  disabled={busy}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="btn min-h-10"
                  onClick={() => void remove(preset)}
                  disabled={busy}
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
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
    <section className="card space-y-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[var(--font-sm)]">
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
        <p className="text-[var(--font-sm)] text-[var(--warn)]">
          This preset ships prompts but no regex scripts. It needs its regex pack to run as
          designed — without it the markup those prompts produce is never cleaned up, and
          stays in the prompt on every later turn.
        </p>
      )}

      {result.dropped.length > 0 && (
        <div className="space-y-1">
          <p className="text-[var(--font-sm)] text-[var(--warn)]">
            {result.dropped.length} setting{result.dropped.length === 1 ? '' : 's'} could not be
            carried over:
          </p>
          <ul className="space-y-0.5 font-mono text-[var(--font-xs)] text-[var(--ink-dim)]">
            {result.dropped.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
