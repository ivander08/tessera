import { useEffect, useState } from 'react';
import { apiJson } from '../lib/api';
import { Markdown } from './Markdown';

/**
 * Picks which opening a new chat starts from.
 *
 * A card can carry several — the first message plus any number of alternates — and which
 * one you want depends on the scene you feel like playing, not on the card. Choosing at
 * creation is the only moment it can be chosen cheaply: after the chat exists, changing
 * it means deleting the first message.
 */
interface Opening {
  index: number;
  content: string;
}

export function OpeningPicker({
  characterId,
  selected,
  onSelect,
}: {
  characterId: string;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [openings, setOpenings] = useState<Opening[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiJson<Opening[]>(`/api/characters/${encodeURIComponent(characterId)}/openings`)
      .then((list) => {
        if (alive) setOpenings(list);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [characterId]);

  if (error) return <div className="note danger">{error}</div>;
  if (!openings) return <p className="form-hint">Loading openings…</p>;

  if (openings.length === 0) {
    return (
      <div className="note">
        This card has no opening message, so the scene starts empty. You can write the first line
        yourself.
      </div>
    );
  }

  // One opening is not a choice. Showing a picker with a single option is worse than
  // showing nothing, because it implies an alternative exists.
  if (openings.length === 1) {
    return (
      <div className="panel panel-pad prose" style={{ fontSize: 'var(--text-sm)' }}>
        <Markdown content={openings[0].content} />
      </div>
    );
  }

  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Opening">
        {openings.map((opening) => (
          <button
            key={opening.index}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected === opening.index}
            onClick={() => onSelect(opening.index)}
          >
            {opening.index === 0 ? 'Opening' : `Alt ${opening.index}`}
          </button>
        ))}
      </div>

      <div className="panel panel-pad prose" style={{ marginTop: 8, fontSize: 'var(--text-sm)' }}>
        <Markdown content={(openings.find((o) => o.index === selected) ?? openings[0]).content} />
      </div>
    </div>
  );
}
