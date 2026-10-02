import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AppBar } from '../components/AppBar';
import {
  ConsultPanel,
  emptyConsultSession,
  type ConsultSession,
} from '../components/ConsultPanel';
import { apiJson } from '../lib/api';
import type { ParsedCard } from '../lib/cards/types';

/**
 * The forge: one conversation that ends in a card.
 *
 * This screen is a host, not a tool. It was three tabs — Draft, Critique, Token cost — and
 * the three were really one job with three buttons: talk about the character, then write it.
 * The consultant does all three, so the tabs and the tools behind them are gone.
 *
 * The interview IS the screen here, so the panel is laid into the page rather than floated
 * over it: on the editor screens the consultant is an aside you drag out of the way, but
 * here there is nothing else to look at, so it takes the column and fills it.
 */
export default function Forge() {
  const navigate = useNavigate();
  // The interview in progress. Held on the route so a re-render — or navigating back to
  // Forge — does not discard everything the consultant has been told.
  const [session, setSession] = useState<ConsultSession>(emptyConsultSession);

  return (
    <>
      <AppBar title={<span className="bar-title">Forge</span>} />

      <main className="consult-standalone">
        <ConsultPanel
          mode="draft"
          session={session}
          onSession={setSession}
          onDone={async (card: ParsedCard) => {
            // The card is created and the browser lands on the ordinary editor, so anything
            // the interview got wrong is one field edit away rather than a second interview.
            const created = await apiJson<{ id: string }>('/api/characters', {
              method: 'POST',
              body: JSON.stringify({ card }),
            });
            navigate(`/characters/${encodeURIComponent(created.id)}/edit`);
          }}
        />
      </main>
    </>
  );
}
