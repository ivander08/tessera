import { Link, useNavigate, useParams } from 'react-router';
import { apiJson } from '../lib/api';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar } from '../components/AppBar';
import { PresetEditor, type PresetDetail } from '../components/PresetEditor';

/**
 * One preset, on its own screen.
 *
 * The editor is a page rather than a panel inside the list. It is a long form — a name,
 * ten sampler knobs, six prompt fields, numbers, and a model pair — and rendering it
 * inside the list meant opening one scrolled the page to a form wedged between the import
 * box and the preset rows, with the list still visible around it and the reader unsure
 * which of the two things they were looking at.
 *
 * A route also makes the editor linkable and survivable: reloading keeps you in it, and
 * the back button means what it says.
 */
export default function PresetEdit() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, loading } = useAsync(
    () => apiJson<PresetDetail>(`/api/presets/${encodeURIComponent(id)}`),
    [id],
  );

  return (
    <>
      <AppBar
        lead={
          <Link to="/presets" className="bar-link">
            Presets
          </Link>
        }
        title={<span className="bar-title">{data?.name ?? 'Preset'}</span>}
      />

      <main className="sheet">
        {loading && <p className="sheet-sub">Loading…</p>}
        {error && <div className="note danger">{error}</div>}

        {data && (
          <PresetEditor
            key={data.id}
            preset={data}
            onSaved={() => navigate('/presets')}
            onCancel={() => navigate('/presets')}
          />
        )}

        {data && (
          <p className="form-hint" style={{ marginTop: 18 }}>
            Changes apply from the next turn. Chats using this preset pick them up then.
          </p>
        )}

        {error && (
          <p className="form-hint" style={{ marginTop: 14 }}>
            {messageOf(error)}
          </p>
        )}
      </main>
    </>
  );
}
