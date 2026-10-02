import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { apiFetch, apiJson, streamChat, type TurnMode } from '../lib/api';
import type { MessageRow, Transcript } from '../lib/apiTypes';
import type { WorldState } from '../lib/state/schema';
import { messageOf, useAsync } from '../lib/hooks';
import { AppBar, BackLink, MenuAction, MenuLabel, MenuSep } from '../components/AppBar';
import { PresetMenu } from '../components/PresetMenu';
import { PersonaMenu } from '../components/PersonaMenu';
import { Turn, type CastVoice, type TurnView } from '../components/Turn';
import { MessageActions } from '../components/MessageActions';
import { Modal } from '../components/Modal';
import { ConfirmPrompt } from '../components/ConfirmPrompt';
import { useToast } from '../components/Toast';
import { SceneBar } from '../components/SceneBar';
import { CastPanel } from '../components/CastPanel';
import { CraftPanel } from '../components/CraftPanel';
import { SearchPanel } from '../components/SearchPanel';
import { AppearancePanel } from '../components/AppearancePanel';
import StatePanel from './State';
import MemoryPanel from './Memory';

/** How many earlier turns one tap of "show earlier" loads. */
const WINDOW_STEP = 80;

/**
 * How many pages a search jump will load before giving up.
 *
 * Ten pages is 800 turns. Past that, reading the whole conversation to satisfy one tap is
 * the unbounded behaviour this phase exists to remove — so the panel shows the excerpt
 * instead, which is the honest answer rather than a silent no-op.
 */
const JUMP_PAGE_CAP = 10;

/**
 * Scrolls the window to the true bottom of the document.
 *
 * `scrollIntoView` on a sentinel element is the obvious approach and it is wrong here:
 * `block: 'end'` aligns the SENTINEL with the bottom of the viewport, and the transcript
 * carries bottom padding below it plus the descenders of the last line above it, so the
 * last few pixels of prose stay under the composer. Measuring the document and scrolling
 * to its height lands where the reader means.
 *
 * Called after a frame so the new rows have been laid out — the height read in the same
 * tick as the state update is the height BEFORE the reply was appended, which is why an
 * immediate scroll lands short. A second frame follows the first: the first lands on the
 * height before the browser has laid out what changed size in the same commit, which
 * leaves the last line under the composer.
 */
function scrollToBottom(): void {
  const toBottom = () =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
  requestAnimationFrame(() => {
    toBottom();
    requestAnimationFrame(toBottom);
  });
}

/**
 * What removing a turn costs, in one sentence.
 *
 * `after` is the number of turns written after it, counted from the window the reader is
 * looking at. A version at the position is not a loss — it is already in the database and
 * takes the turn's place — so the sentence only warns about what leaves the scene.
 */
function deleteWarning(after: number, hasVersions: boolean): string {
  const leaving =
    after === 1
      ? 'the turn written after it leaves the scene'
      : `the ${after} turns written after it leave the scene`;
  return hasVersions
    ? `Another version of this reply takes its place, and ${leaving}.`
    : `${leaving[0].toUpperCase()}${leaving.slice(1)}. Nothing brings them back.`;
}

function MemoryGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.6H4z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.6H20z" />
    </svg>
  );
}

interface Pending {
  mode: TurnMode;
  text: string;
  targetId: string | null;
  /** The user's own text, shown immediately for `send` rather than after the round trip. */
  sent?: string;
  /**
   * The stream is over but the refetch has not landed.
   *
   * Clearing the overlay the instant the last frame arrives puts the OLD text back on
   * screen until `reload()` resolves — a regenerate visibly reverts for a moment before
   * the new reply appears. While settling, the overlay stays and keeps showing what was
   * just written.
   */
  settling?: boolean;
}

export default function Chat() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => apiJson<Transcript>(`/api/chats/${encodeURIComponent(id)}/messages`),
    [id],
  );

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The turn the reader asked to remove when turns after it would leave the scene with it.
  // `after` is the count of rows that go, computed from the window — the window ends at the
  // tail of the path, so every row after this one in it is a row that leaves.
  const [confirmDelete, setConfirmDelete] = useState<
    { id: string; after: number; isUser: boolean; hasVersions: boolean } | null
  >(null);
  const toast = useToast();
  // The id of the reply that hit the provider's output cap, so its own turn can say so.
  // Cleared when the next turn starts: the marker belongs to one reply, not to the chat.
  const [truncatedId, setTruncatedId] = useState<string | null>(null);
  // Which side panel is open over the chat, if any. These used to be separate routes,
  // which meant leaving the scene to read the state it is in.
  const [panel, setPanel] = useState<'state' | 'cast' | 'craft' | 'memory' | 'appearance' | 'search' | null>(null);

  // Drives the jump-to-latest control. A ref is enough for the auto-follow logic, but the
  // button has to render, so the same fact is mirrored into state on the scroll handler.
  const [atBottom, setAtBottom] = useState(true);
  // CSS cannot reach inside motion's inline styles, so the library has to be told about
  // the reader's preference separately.
  const reduced = useReducedMotion();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Whether the reader is at the live end of the transcript. Only then does new text
  // pull the view down; someone who scrolled back to reread a paragraph must not be
  // yanked forward by every token.
  const pinnedToBottom = useRef(true);
  // The row to bring back into view once the refetch lands, for the two actions that do not
  // append. Swiping swaps which row is on the path and deleting promotes a version, so the
  // id to hold is the one the server returns, not the one the reader clicked.
  const keepInView = useRef<string | null>(null);

  const messages = useMemo(() => data?.messages ?? [], [data]);

  // Turns fetched from before the first window, oldest-first. The server serves the
  // transcript from the END of the visible path, so these are pages the reader explicitly
  // asked for and they are prepended in front of the newest window.
  const [older, setOlder] = useState<MessageRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Seeded from every transcript the server returns, and `older` is dropped with it.
  // Keyed on `data` because that is what changes on a reload: keeping the pages across a
  // refetch would splice turns the server has since re-windowed — after a turn the newest
  // window has moved forward, so the page boundary no longer meets it, and the reader
  // would see a gap where two turns used to be.
  useEffect(() => {
    if (!data) return;
    setOlder([]);
    setHasMore(data.hasMore);
    setCursor(data.oldestId);
  }, [data]);

  // What the transcript shows. Regenerating an early reply cuts everything after it
  // immediately, rather than waiting for the server to answer: the turns after that
  // position belong to the version being replaced, so they are already gone the moment
  // the reader asks for a new one. The server persists exactly the same outcome, so the
  // reload that follows agrees with what was on screen the whole time.
  //
  // Only `regenerate` cuts. `continue` carries the same target id but writes a new turn
  // AFTER it, so truncating would hide the very paragraph being continued.
  const path = useMemo(() => {
    const all = older.length > 0 ? [...older, ...messages] : messages;
    const targetId = pending?.mode === 'regenerate' ? pending.targetId : null;
    if (!targetId) return all;
    const at = all.findIndex((message) => message.id === targetId);
    return at === -1 ? all : all.slice(0, at + 1);
  }, [messages, older, pending?.mode, pending?.targetId]);

  // Prepending rows above the viewport pushes everything down by their height. The height
  // is not known until they render, so the scroll offset is corrected in a layout effect
  // — after the DOM is updated, before the browser paints — which is what stops the
  // reader being thrown upward when they ask for earlier turns.
  //
  // This is the ONLY correction: `.transcript` turns the browser's own scroll anchoring
  // off in CSS. Both firing together overshoots by exactly one page, because the native
  // one restores the anchored node's position and this one restores the scroll offset.
  const anchorHeight = useRef<number | null>(null);

  useLayoutEffect(() => {
    const height = anchorHeight.current;
    if (height === null) return;
    anchorHeight.current = null;
    const grew = document.documentElement.scrollHeight - height;
    if (grew > 0) window.scrollBy(0, grew);
  }, [older.length]);

  /**
   * Each turn's effective state, inherited forward from the last snapshot.
   *
   * A row only carries a snapshot when something actually changed, so a row without one
   * was in whatever state the most recent snapshot described. Resolving that here rather
   * than on each turn keeps the inheritance in one place and out of the render path.
   */
  const stateAt = useMemo(() => {
    const out = new Map<string, WorldState | null>();
    let current: WorldState | null = null;
    for (const message of path) {
      if (message.state) current = message.state;
      out.set(message.id, current);
    }
    return out;
  }, [path]);

  /**
   * Brings a message into the transcript and scrolls to it.
   *
   * A search hit can be anywhere in the scene and only the newest window is loaded, so
   * this pages backwards until the target seq is inside the loaded range. Capped at ten
   * pages: an unbounded loop would read a whole conversation to satisfy one tap, and past
   * that the excerpt in the panel is the honest answer.
   *
   * Deliberately does NOT set the scroll anchor. The anchor exists to keep the reader
   * where they were; here they have asked to go somewhere else, and correcting the offset
   * would cancel the jump they asked for.
   */
  const jumpTo = useCallback(
    async (seq: number): Promise<boolean> => {
      let loaded = older.length > 0 ? older : messages;
      if (seq < (loaded[0]?.seq ?? Infinity)) {
        let pageCursor = cursor;
        let pages = 0;
        let collected: MessageRow[] = [];

        while (pageCursor !== null && pages < JUMP_PAGE_CAP) {
          const page = await apiJson<Transcript>(
            `/api/chats/${encodeURIComponent(id)}/messages?cursor=${encodeURIComponent(pageCursor)}&limit=${WINDOW_STEP}`,
          );
          collected = [...page.messages, ...collected];
          pageCursor = page.oldestId;
          pages += 1;
          // Stop as soon as the target is covered, or there is nothing older to fetch.
          if (seq >= (collected[0]?.seq ?? Infinity) || !page.hasMore) break;
        }

        if (collected.length === 0) return false;

        loaded = [...collected, ...loaded];
        setOlder((current) => [...collected, ...current]);
        setCursor(pageCursor);
        setHasMore(pageCursor !== null);

        // The rows are not in the DOM until React commits, so the scroll waits for a
        // frame. `requestAnimationFrame` is the smallest honest delay: after paint,
        // before the reader could see a jump.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      // Still out of range after the cap, so the caller shows the excerpt instead.
      if (seq < (loaded[0]?.seq ?? Infinity)) return false;

      const node = document.querySelector(`[data-seq="${seq}"]`);
      if (!node) return false;
      node.scrollIntoView({ block: 'center' });
      node.classList.add('is-found');
      window.setTimeout(() => node.classList.remove('is-found'), 2200);
      return true;
    },
    [cursor, id, messages, older],
  );

  const loadOlder = useCallback(async () => {
    if (loadingOlder || cursor === null) return;
    setLoadingOlder(true);
    // Captured before the fetch resolves and before the rows are in the DOM.
    anchorHeight.current = document.documentElement.scrollHeight;
    try {
      const page = await apiJson<Transcript>(
        `/api/chats/${encodeURIComponent(id)}/messages?cursor=${encodeURIComponent(cursor)}&limit=${WINDOW_STEP}`,
      );
      // Prepending to whatever arrived while the request was in flight, rather than
      // replacing it: a page that resolves late must not drop an earlier page that
      // already landed.
      setOlder((current) => [...page.messages, ...current]);
      setHasMore(page.hasMore);
      setCursor(page.oldestId);
    } catch (cause) {
      // The anchor is abandoned, so the next successful page does not apply a stale
      // height correction.
      anchorHeight.current = null;
      setSendError(messageOf(cause));
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, id, loadingOlder]);

  // The overlay comes down when the refetched transcript actually CONTAINS what the
  // overlay is showing — matched on content rather than on the message count, because a
  // regenerate replaces a row without changing the count and a send adds two at once.
  const overlayStored = useMemo(() => {
    if (!pending) return false;
    if (pending.sent && !messages.some((m) => m.role === 'user' && m.content === pending.sent)) {
      return false;
    }
    if (pending.text.length === 0) return true;
    return messages.some((m) => m.content === pending.text);
  }, [pending, messages]);

  useEffect(() => {
    if (pending?.settling && overlayStored) setPending(null);
  }, [pending?.settling, overlayStored]);

  // While settling, the stored copy and the overlay can both be true for one frame
  // before the effect above runs — which would render the reply twice. The overlay is
  // the thing that yields.
  const overlay = pending && !(pending.settling && overlayStored) ? pending : null;

  /**
   * The message the overlay REPLACES, or null when it appends.
   *
   * Only `regenerate` replaces: it re-rolls one reply, so the new text belongs in that
   * slot rather than after it — leaving the old version on screen would read as a second
   * reply arriving at the end of the scene.
   *
   * `continue` carries the same `targetId` but means the opposite: it writes a NEW turn
   * that FOLLOWS the last reply. Treating its target as a slot to replace blanked the
   * paragraph the reader was continuing — the text vanished the moment they asked for
   * more of it, and only came back when the stream finished and the refetch landed.
   */
  const replaceTarget = overlay?.mode === 'regenerate' ? overlay.targetId : null;

  // The scene chip in the bar. Fetched separately from the transcript so a slow state
  // read never delays the conversation, and reloaded with it so a corrected value shows
  // up as soon as the turn lands.
  const state = useAsync(
    () => apiJson<{ state: WorldState }>(`/api/state/${encodeURIComponent(id)}`),
    [id],
  );
  const stateReload = useRef(state.reload);
  stateReload.current = state.reload;

  // Who is in the scene. Reloaded with the transcript, because a reply can introduce a
  // speaker and the new name has to render on the turn that introduced them.
  const cast = useAsync(
    () => apiJson<{ cast: CastVoice[] }>(`/api/chats/${encodeURIComponent(id)}/cast`),
    [id],
  );
  // Only a cast with more than one member changes how a turn renders, so a
  // single-character scene passes nothing and takes the original path.
  const voices = (cast.data?.cast?.length ?? 0) > 1 ? cast.data!.cast : undefined;
  const castReload = useRef(cast.reload);
  castReload.current = cast.reload;

  const characterName = data?.character?.shownName ?? data?.chat.title ?? 'Character';
  const userName = data?.persona?.name ?? 'You';
  // `{{user}}` in prose resolves to the persona's name. The fallback is `User` rather than
  // the transcript's `You` label because the placeholder appears in possessives —
  // "{{user}}'s face" — where a pronoun reads as a typo. `User` is also the default
  // persona name every other client uses, so a card written elsewhere behaves the same.
  const macroContext = useMemo(
    () => ({ char: characterName, user: data?.persona?.name ?? 'User' }),
    [characterName, data?.persona?.name],
  );

  // Follow the stream. `pending.text` is a dependency rather than `pending` because the
  // object identity changes on every delta and the layout has already been committed by
  // the time this runs, so the caret stays in view as the reply grows.
  //
  // Keyed on `messages.length` — the newest window — and NOT on `path.length`. Loading
  // earlier turns grows the path from the FRONT, and following that would drag a reader
  // who was reading near the bottom all the way down every time they asked for more of
  // the scene. Appending a turn is the only thing that grows the end.
  //
  // A redo streams into the slot it replaces, which is the last row of the truncated
  // path, so following it lands on the new text.
  //
  // Scrolled by measuring the document rather than `scrollIntoView` on the sentinel: the
  // transcript's bottom padding sits below the sentinel, and `block: 'end'` aligns the
  // sentinel to the viewport bottom, leaving that padding — and the last line's
  // descenders — below the fold. Setting `scrollTop` to the full height lands on the real
  // bottom.
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    scrollToBottom();
  }, [messages.length, pending?.text]);

  // A turn ends and the composer is where the reader looks next, so the view is brought
  // to the end even if they had scrolled away while reading back through the scene. The
  // stream above is deliberately conditional; this is the one that must not be, or
  // sending from a scrolled-up position leaves the new reply off screen.
  //
  // Keyed on `busy` rather than on the turn's own completion because `busy` is the single
  // state that brackets the whole operation — request, stream, and the settle that
  // follows it.
  useEffect(() => {
    if (busy) return;
    scrollToBottom();
  }, [busy]);

  // Content that changes size after the scroll — reflowed markdown, the settle swap that
  // replaces the streaming overlay with the stored row — would otherwise land below the
  // fold. Re-pinning while the reader is at the bottom is the same follow rule the stream
  // uses; someone who scrolled back has `pinnedToBottom` false and is left alone.
  //
  // Keyed on `data`, not on nothing: the first render has no transcript to observe — the
  // screen is still the loading placeholder — so an effect that runs once at mount would
  // find no node and never attach. Every reload re-attaches to the same element, which is
  // a disconnect and an observe, not a leak.
  useEffect(() => {
    const node = document.querySelector('.transcript');
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current) scrollToBottom();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [data]);

  // `block: 'nearest'` rather than `'center'`: the row is usually already on screen, and the
  // reader asked for a different version of it, not for a jump. The ref is cleared either
  // way, so a later reload never applies a stale scroll.
  //
  // Bringing the row into view also stops the follow: the reader's attention is on that
  // row, not on the end of the scene, and the `ResizeObserver` above runs before the
  // scroll handler can notice the new offset — without this it would immediately re-pin to
  // the bottom and undo the scroll it just made. A row that is already fully visible
  // changes nothing, which is the common case for a swipe near the bottom.
  useEffect(() => {
    const id = keepInView.current;
    if (!id || !data) return;
    keepInView.current = null;
    const node = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (!node) return;

    const rect = node.getBoundingClientRect();
    const visible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (visible) return;

    node.scrollIntoView({ block: 'nearest' });
    pinnedToBottom.current = false;
    setAtBottom(false);
  }, [data]);

  useEffect(() => {
    function onScroll() {
      const distance =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      pinnedToBottom.current = distance < 140;
      setAtBottom(distance < 140);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Two shortcuts, and only two. A chat screen is a text field with a transcript above it,
  // so most keys belong to whatever has focus — the composer, an open editor, a sheet.
  // Anything that fires while the reader is typing is a bug waiting to be reported.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      // Escape is left to whatever is open: a sheet, an editor, the lightbox.
      if (event.key === 'Escape') return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPanel('search');
        return;
      }

      // `/` opens search, the convention every long document reader already has in their
      // fingers. Only outside a field, or typing a slash would open a panel instead.
      if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        setPanel('search');
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const run = useCallback(
    async (mode: TurnMode, content: string, targetId: string | null, sent?: string) => {
      setBusy(true);
      setSendError(null);
      // A fresh turn supersedes the last reply's marker: it belongs to that reply, and the
      // reader has moved on from it.
      setTruncatedId(null);
      // The reader just acted, so follow the result even if they had scrolled away.
      pinnedToBottom.current = true;
      // `sent` rides on the same state the stream writes into, so the reader's own line
      // is on screen from the first frame instead of after the model finishes.
      setPending({ mode, text: '', targetId, sent });

      const controller = new AbortController();
      abortRef.current = controller;
      // Whether the turn produced nothing to wait for. The settle overlay exists to hold
      // the streamed text on screen until the stored copy arrives; a turn that failed or
      // was stopped has no stored copy coming, so it must not hold one.
      let failed = false;

      try {
        await streamChat(
          id,
          content,
          (frame) => {
            if (frame.type === 'delta') {
              setPending((current) =>
                current ? { ...current, text: current.text + frame.text } : current,
              );
            } else if (frame.type === 'error') {
              failed = true;
              setSendError(frame.message);
            } else if (frame.type === 'done' && frame.truncated) {
              setTruncatedId(frame.messageId);
            }
          },
          { mode, signal: controller.signal, targetId },
        );
      } catch (cause) {
        // An abort is the user pressing stop, not a failure.
        if (!controller.signal.aborted) {
          failed = true;
          setSendError(messageOf(cause));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);

        // A failed or stopped turn has nothing stored to wait for, so the overlay goes now.
        // Stop leaves the scene untouched — the server discards the partial — so there is
        // nothing to refetch and no state to settle. Reloading here was what made the
        // discarded text reappear a moment after Stop was pressed.
        if (controller.signal.aborted || failed) {
          setPending(null);
        } else {
          // Held, not cleared: the refetch below replaces the transcript with the stored
          // version, and clearing first would flash the pre-turn text back on screen.
          setPending((current) => (current ? { ...current, settling: true } : null));
          reload();
          // The state engine runs after a completed turn, so the scene bar is stale the
          // moment the reply lands. Held in a ref because the callback identity changes
          // every render and putting it in the deps would rebuild `run` continuously.
          stateReload.current();
          // Same reason: the reply may have introduced a speaker, so the cast is stale too.
          castReload.current();
          // A refetch that returns the same transcript never trips the settle check, so the
          // overlay would stay up forever. The timeout is the guarantee that it comes down.
          window.setTimeout(
            () => setPending((current) => (current?.settling ? null : current)),
            6000,
          );
        }
      }
    },
    [id, reload],
  );

  function send() {
    const content = draft.trim();

    // An empty send continues the last reply. That is the gesture the reader already
    // makes when they want more of the same voice — the button that used to do it was a
    // second, differently-named way to ask for the same thing, and it behaved
    // confusingly (it appended to the previous message's own group, so the result looked
    // like nothing had happened).
    //
    // Now it writes a NEW assistant turn, so two replies in a row is exactly what you
    // get, which is what "continue" means to a reader.
    //
    // The gate is the END OF THE VISIBLE PATH, not the last assistant row. Those differ
    // exactly when a turn was stopped before its reply arrived: the tail is then the
    // reader's own message, and the old check returned without acting — the button
    // rendered but did nothing. The server treats that case as "answer this message", so
    // the reader can always recover a stopped turn.
    if (!content) {
      if (busy || !tailMessage || (tailMessage.role !== 'assistant' && tailMessage.role !== 'user')) {
        return;
      }
      void run('continue', '', tailMessage.id);
      return;
    }

    if (busy) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    void run('send', content, null, content);
  }

  async function swipe(messageId: string, direction: 'prev' | 'next') {
    try {
      const result = await apiJson<{ id?: string }>('/api/message/swipe', {
        method: 'POST',
        body: JSON.stringify({ chatId: id, id: messageId, direction }),
      });
      // The version that is now on the path, which is not the row the reader clicked:
      // holding the clicked id would scroll to a row that just left the scene.
      keepInView.current = result?.id ?? messageId;
      reload();
    } catch (cause) {
      setSendError(messageOf(cause));
    }
  }

  async function saveEdit(messageId: string, content: string) {
    setEditingId(null);
    try {
      await apiJson('/api/message/edit', {
        method: 'POST',
        body: JSON.stringify({ chatId: id, id: messageId, content }),
      });
      reload();
    } catch (cause) {
      // The composer row is contextual to the turn being edited, so it stays; the toast is
      // added because the row is easy to miss when the edit form has already closed.
      setSendError(messageOf(cause));
      toast.failure(messageOf(cause));
    }
  }

  /**
   * Removes one version of a turn.
   *
   * `holdId` is where to leave the view when the server names no successor — the position
   * emptied, so the turn is gone and the row above it is the one the reader is looking at.
   * The server's own `id` wins when it has one: deleting the active version promotes a
   * survivor, and that is the row now on the path.
   */
  async function remove(messageId: string, holdId: string | null) {
    try {
      const result = await apiJson<{ id?: string }>('/api/message/delete', {
        method: 'POST',
        body: JSON.stringify({ chatId: id, id: messageId }),
      });
      keepInView.current = result?.id ?? holdId;
      reload();
    } catch (cause) {
      setSendError(messageOf(cause));
    }
  }

  /**
   * Downloads the export.
   *
   * A plain `<a href>` cannot work: the endpoint is behind the same bearer auth as
   * everything else, and a browser navigation carries no `Authorization` header — so the
   * Worker would correctly answer 401 and the reader would get a page of JSON error text.
   * The bytes are fetched with the token and handed to a blob URL instead, the same way
   * `Avatar` fetches an authenticated image.
   */
  async function download(format: 'md' | 'json') {
    setSendError(null);
    try {
      const res = await apiFetch(`/api/chats/${encodeURIComponent(id)}/export?format=${format}`);
      if (!res.ok) throw new Error(`Export failed (${res.status}).`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const name =
        res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        `scene.${format}`;

      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on the next tick: revoking synchronously can beat the download in some
      // browsers, and the URL is dead either way once the navigation has started.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (cause) {
      setSendError(messageOf(cause));
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(null);
    setBusy(false);
  }

  // Only the FIRST load gets a placeholder. `reload()` also sets `loading`, and swapping
  // the transcript for "Loading…" after every turn is what made sending feel like the
  // page was reloading and jumping to the top.
  if (loading && !data) {
    return (
      <>
        <AppBar lead={<BackLink to="/" label="All chats" />} title={<span className="bar-title">…</span>} />
        <div className="sheet">
          <p className="sheet-sub">Loading…</p>
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <AppBar lead={<BackLink to="/" label="All chats" />} title={<span className="bar-title">Chat</span>} />
        <div className="sheet">
          <div className="note danger">{error ?? 'Chat not found.'}</div>
        </div>
      </>
    );
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  // What an empty send continues: the end of the visible path, which is the row the next
  // turn would answer. NOT the newest assistant row in the window — after a regenerate or
  // an edit that row can belong to a branch the reader is not looking at, and continuing it
  // would append a paragraph to a version that is off screen.
  const tailMessage = path[path.length - 1];


  return (
    <>
      <AppBar
        title={<span className="bar-title">{characterName}</span>}
        trailing={
          <button
            type="button"
            className="icon-btn"
            onClick={() => setPanel('memory')}
            title="Memory"
            aria-label="Memory"
          >
            <MemoryGlyph />
          </button>
        }
        scoped={
          <>
            <MenuLabel>This chat</MenuLabel>
            <PersonaMenu chatId={id} current={data.persona?.id ?? null} onChanged={reload} />
            <MenuSep />
            <PresetMenu chatId={id} onChanged={reload} />
            <MenuSep />
            <MenuAction label="World state" onClick={() => setPanel('state')} />
            <MenuAction label="Cast" onClick={() => setPanel('cast')} />
            <MenuAction label="How it's written" onClick={() => setPanel('craft')} />
            <MenuAction label="Memory" onClick={() => setPanel('memory')} />
            <MenuAction label="Appearance" onClick={() => setPanel('appearance')} />
            <MenuSep />
            <MenuAction label="Find in this scene" onClick={() => setPanel('search')} />
            <MenuAction label="Export as Markdown" onClick={() => void download('md')} />
            <MenuAction label="Export as JSON" onClick={() => void download('json')} />
            {lastAssistant?.cached_tokens != null && lastAssistant.prompt_tokens != null && (
              <>
                <MenuSep />
                {/* Moved off the transcript: a percentage pinned under every reply reads
                    as a billing screen. It still matters, so it lives one tap away. */}
                <MenuAction
                  label={`Last turn ${Math.round(
                    (lastAssistant.cached_tokens / Math.max(1, lastAssistant.prompt_tokens)) * 100,
                  )}% cached`}
                  hint={lastAssistant.cost_usd != null ? `$${lastAssistant.cost_usd.toFixed(4)}` : undefined}
                  onClick={() => {}}
                />
              </>
            )}
          </>
        }
      />

      {/* The scene, always visible. This is the one fact about a roleplay scene you want
          while reading rather than by opening something — it is what tells you the
          narrator has drifted. Replaces the chip that only said "Set the scene". */}
      <SceneBar state={state.data?.state} onOpen={() => setPanel('state')} />

      <div className="transcript">
        {hasMore && (
          <div className="transcript-earlier">
            <button
              type="button"
              className="btn quiet"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? 'Loading…' : `Show ${WINDOW_STEP} earlier turns`}
            </button>
          </div>
        )}
        {path.map((message, index) => {
          const isUser = message.role === 'user';
          // The turn being redone. Its reply replaces this slot rather than appending,
          // so regenerating an early message shows the new version where the reader is
          // looking instead of at the bottom of a scene they then have to scroll up from.
          const isTarget = replaceTarget === message.id;
          // The cap belongs to the scene's opening, which is the first row of the whole
          // path. Index 0 is the whole path's first row only once nothing older is left
          // to fetch — while `hasMore` is true, index 0 is just the top of the window.
          const isOpening = !hasMore && index === 0;
          return (
            <Fragment key={message.id}>
              {/* The turn being redone. Its OLD text is replaced by the new one in the same
                  slot rather than left on screen with the reply appended below it — a redo
                  is a replacement, and leaving the previous version visible makes it look
                  like a new message arriving at the end of the scene. */}
              {isTarget && overlay && !isUser ? (
                overlay.text.length === 0 ? (
                  <Turn
                    message={{ ...(message as TurnView), content: '' }}
                    name={characterName}
                    avatar={data.character?.avatar}
                    macros={macroContext}
                    dropCap={isOpening}
                    thinking
                  />
                ) : (
                  <Turn
                    message={{ ...(message as TurnView), content: overlay.text }}
                    name={characterName}
                    avatar={data.character?.avatar}
                    macros={macroContext}
                    dropCap={isOpening}
                    streaming
                  />
                )
              ) : (
                <Turn
                  message={message as TurnView}
                  name={isUser ? userName : characterName}
                  avatar={isUser ? data.persona?.avatar : data.character?.avatar}
                  cast={isUser ? undefined : voices}
                  macros={macroContext}
                  sceneState={stateAt.get(message.id)}
                  // The marker belongs to the reply that hit the cap, and Continue asks for
                  // more of that same reply — the same call an empty send makes.
                  truncated={truncatedId === message.id}
                  onContinue={
                    truncatedId === message.id ? () => void run('continue', '', message.id) : undefined
                  }
                  // In the transcript you are already reading one character, so the
                  // portrait has nothing else to do — enlarging it is the only useful
                  // action, and it is also how you check an import carried an avatar.
                  zoomAvatar
                  // The first thing in the scene opens with a drop cap; everything else is
                  // body text.
                  dropCap={isOpening}
                  editing={editingId === message.id}
                  busy={busy}
                  onEditStart={() => setEditingId(message.id)}
                  onEditCancel={() => setEditingId(null)}
                  onEditSave={(content) => void saveEdit(message.id, content)}
                  actions={
                    editingId === message.id ? null : (
                      <MessageActions
                        canSwipeLeft={(message.swipeIndex ?? 0) > 0}
                        canSwipeRight={(message.swipeIndex ?? 0) < (message.swipes?.length ?? 1) - 1}
                        swipeIndex={message.swipeIndex ?? 0}
                        swipeCount={message.swipes?.length ?? 1}
                        onSwipe={(direction) => void swipe(message.id, direction)}
                        onCopy={() => message.content}
                        onEdit={() => setEditingId(message.id)}
                        onDelete={() => {
                          // Rows after this one are exactly the turns that go with it: the
                          // window ends at the tail of the path, so nothing that follows is
                          // missing from it.
                          const after = path.length - 1 - index;
                          if (after === 0) {
                            void remove(message.id, null);
                            return;
                          }
                          setConfirmDelete({
                            id: message.id,
                            after,
                            isUser,
                            hasVersions: (message.swipes?.length ?? 1) > 1,
                          });
                        }}
                        onRegenerate={
                          // Offered on every reply, not only the newest. Regenerating an
                          // earlier one is a branch: the new version takes that position
                          // and the turns after it step out of the transcript until you
                          // swipe back, which is what makes rewriting a scene's direction
                          // possible without losing the scene you had.
                          !isUser ? () => void run('regenerate', '', message.id) : undefined
                        }
                        busy={busy}
                      />
                    )
                  }
                />
              )}
            </Fragment>
          );
        })}

        {/* The reader's own line, before the server has answered. */}
        {overlay?.sent && (
          <Turn
            message={{ id: 'pending-user', role: 'user', content: overlay.sent }}
            name={userName}
            avatar={null}
            macros={macroContext}
          />
        )}

        {/* A new turn streams at the end, because that is where it belongs. A redo
            streams in the slot above, so this covers the modes that append — including
            `continue`, which carries a target id but writes a NEW turn after it. */}
        {overlay && !replaceTarget && overlay.mode !== 'impersonate' && overlay.text.length === 0 && (
          <Turn
            message={{ id: 'pending-thinking', role: 'assistant', content: '' }}
            name={characterName}
            avatar={data.character?.avatar}
            macros={macroContext}
            thinking
          />
        )}
        {overlay && !replaceTarget && overlay.text.length > 0 && (
          <Turn
            message={{
              id: 'pending',
              role: overlay.mode === 'impersonate' ? 'user' : 'assistant',
              content: overlay.text,
            }}
            name={overlay.mode === 'impersonate' ? userName : characterName}
            avatar={overlay.mode === 'impersonate' ? data.persona?.avatar : data.character?.avatar}
            macros={macroContext}
            streaming
          />
        )}

        {/* Only when there is somewhere to go. A permanently visible control would sit on
            top of the last line of prose, which is the one line the reader is reading. */}
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              type="button"
              className="jump-latest"
              onClick={() => {
                pinnedToBottom.current = true;
                setAtBottom(true);
                scrollToBottom();
              }}
              aria-label="Jump to the latest turn"
              // The pill is centred by a transform, which motion owns — so the centring
              // moves into `x` here and out of the CSS rule. Dropping it drifts the pill
              // to the left edge.
              initial={{ opacity: 0, y: 6, x: '-50%' }}
              animate={{ opacity: 1, y: 0, x: '-50%' }}
              exit={{ opacity: 0, y: 6, x: '-50%' }}
              transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 0.68, 0.36, 1] }}
            >
              Latest
            </motion.button>
          )}
        </AnimatePresence>

      </div>

      {panel && (
        <Modal
          title={
            panel === 'state'
              ? 'World state'
              : panel === 'cast'
                ? 'Cast'
                : panel === 'craft'
                  ? "How it's written"
                  : panel === 'memory'
                    ? 'Memory'
                    : panel === 'search'
                      ? 'Find in this scene'
                      : 'Appearance'
          }
          subtitle={
            panel === 'state'
              ? 'What the narrator believes right now. Written automatically after each completed turn.'
              : panel === 'cast'
                ? 'Everyone who has spoken in this scene, and what they are called.'
                : panel === 'craft'
                  ? 'Content policy, prose register, and how the NPCs behave. Per chat, so one scene can be a thriller and another a romance.'
                  : panel === 'memory'
                    ? 'What this chat carries forward. Written automatically as the scene runs.'
                    : panel === 'search'
                      ? 'Every turn in this scene, ranked by how well it matches.'
                      : 'Type, colour and layout. Applies as you change it, on every device.'
          }
          onClose={() => setPanel(null)}
        >
          {panel === 'state' && <StatePanel embedded />}
          {panel === 'cast' && <CastPanel chatId={id} onChanged={castReload.current} />}
          {panel === 'craft' && <CraftPanel chatId={id} />}
          {panel === 'memory' && <MemoryPanel embedded />}
          {panel === 'search' && (
            <SearchPanel
              chatId={id}
              onJump={async (seq) => {
                // The panel closes on a successful jump so the reader lands on the turn
                // rather than on it behind a dialog.
                const reached = await jumpTo(seq);
                if (reached) setPanel(null);
                return reached;
              }}
            />
          )}
          {panel === 'appearance' && <AppearancePanel onClose={() => setPanel(null)} />}
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmPrompt
          title={confirmDelete.isUser ? 'Delete your message' : 'Delete this reply'}
          message={deleteWarning(confirmDelete.after, confirmDelete.hasVersions)}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            void remove(target.id, null);
          }}
        />
      )}

      {sendError && (
        <div className="composer" style={{ borderTop: 0, paddingBottom: 0 }}>
          <div className="composer-inner">
            <div className="note danger" style={{ flex: 1 }}>
              {sendError}
            </div>
          </div>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="composer-inner">
          {/* Impersonate sits to the LEFT of the field, where it reads as a modifier of
              what you are about to write rather than a peer of Send.
              The continue button that used to sit beside it is gone: an empty send does
              the same thing and says so in the placeholder, so the gesture the reader
              already makes is the one that works. */}
          <div className="composer-actions">
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              title="Write my next line for me"
              aria-label="Impersonate"
              onClick={() => void run('impersonate', '', null)}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="3.2" />
                <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
              </svg>
            </button>
          </div>

          <textarea
            ref={inputRef}
            className="composer-input"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              const node = event.currentTarget;
              node.style.height = 'auto';
              node.style.height = `${Math.min(node.scrollHeight, window.innerHeight * 0.42)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={
              busy
                ? 'Streaming…'
                : draft.length === 0 && lastAssistant
                  ? 'Send empty to continue'
                  : `Write as ${userName}`
            }
            disabled={busy}
            aria-label="Message"
          />

          {busy ? (
            <button type="button" className="btn" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={busy}>
              {draft.trim().length === 0 && lastAssistant ? 'Continue' : 'Send'}
            </button>
          )}
        </div>
      </form>
    </>
  );
}
