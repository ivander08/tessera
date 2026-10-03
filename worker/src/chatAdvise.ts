import { badRequest, notFound, readJson } from './http';
import { send } from './prompt';
import { asMessages, phaseOf, type ConsultFrame, type ConsultPhase } from './forge/api';
import { partialField } from './forge/partial';
import { chatConsult, type ChatConsultTurn } from './chatConsult';

/**
 * `POST /api/chats/:id/advise` — `{ messages }` → an SSE stream.
 *
 * The chat consultant's own handler rather than a branch inside `index.ts`, matching how
 * `forge/api.ts` sits beside it. The frames are the CARD consultant's union unchanged: the
 * protocol is "a streamed turn with a progress phase", which is the same problem, so a
 * second union would be two spellings of one thing.
 *
 * The consultant never writes a card, so `phase` only ever reaches `say` or `question` here.
 * That is enforced in the prompt, not by filtering the phase — a filter would hide the
 * model's own mistake rather than prevent it.
 */
export async function chatAdvise(env: Env, req: Request, chatId: string): Promise<Response> {
  const body = await readJson<{ messages?: unknown }>(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('messages required');
  }

  const messages = asMessages(body.messages);
  if (typeof messages === 'string') return badRequest(messages);

  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?')
    .bind(chatId)
    .first<{ id: string }>();
  if (!chat) return notFound('chat not found');

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The `say` field as decoded so far, tracked against what has already been sent. The
      // scanner returns a prefix, so re-emitting an unchanged prefix would repeat text.
      let buffer = '';
      let emitted = '';
      // Sent only when it changes: a frame per delta would be the same fact repeated.
      let phase: ConsultPhase = 'say';

      try {
        const turn = await chatConsult(env, {
          chatId,
          messages,
          onDelta: (fragment) => {
            buffer += fragment;
            const prefix = partialField(buffer, 'say');
            if (prefix !== null && prefix.length > emitted.length) {
              emitted = prefix;
              send<ConsultFrame<ChatConsultTurn>>(controller, { type: 'delta', text: prefix });
            }

            const next = phaseOf(buffer);
            if (next !== phase) {
              phase = next;
              send<ConsultFrame<ChatConsultTurn>>(controller, { type: 'phase', phase });
            }
          },
        });

        send<ConsultFrame<ChatConsultTurn>>(controller, { type: 'turn', turn });
      } catch (error) {
        try {
          send<ConsultFrame<ChatConsultTurn>>(controller, {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
            code: 'chat_consult_failed',
          });
        } catch {
          // controller already closed by the client
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
