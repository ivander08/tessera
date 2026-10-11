# Tessera — apple-design audit

Audit of the entire UI against the **apple-design** skill
(`~/.agents/skills/apple-design`, `emilkowalski/skills`), which encodes Apple's
WWDC *Designing Fluid Interfaces* principles plus the *Principles of Great Design*.

- **Date:** 2026-10-10
- **Method:** source read + live inspection of the running app (Bun server, seeded DB,
  headless Chromium at 1440×900 and 390×844, dark and light themes, reduced-motion on/off).
- **Coverage:** all 14 routes and all panels, including the three called out explicitly —
  **How it's written** (`CraftPanel`), **Memory**, and **World state** (`State`).
- **Every finding cites `file:line`.** Claims marked **[verified]** were reproduced in the
  live browser during this audit; **[read]** is a code-read claim.
- One widely-plausible claim was **refuted** live and is recorded in §7.

---

## 1. Verdict

The **foundations layer is unusually disciplined**: one save primitive, confirmation copy
that states real costs, a complete sheet primitive, empty states that teach, token-driven
theming, and near-complete reduced-motion coverage. This is well above the median for a
personal project.

The failures are **systemic, not scattered**. Four themes account for most of the damage:

1. **No press feedback anywhere.** Nothing in the app acknowledges a press until the
   action completes.
2. **Keyboard focus is invisible on every text field**, and dialogs neither move nor trap focus.
3. **The gesture layer is half-built.** Pointer capture and grab-offset are right; velocity,
   momentum, springs, rubber-banding and release-settle do not exist. The one CSS "settle"
   transition never fires.
4. **Destructive actions are inconsistent and often unguarded** — including two hard deletes
   with no confirmation, on the screens the reader cannot reconstruct.

Counts: **13 high · 24 medium · 20 low.**

---

## 2. What already works (do not "fix" these)

- **One toast primitive** (`Toast.tsx`): success auto-dismisses, failure persists, cap of 3
  leaving through the same exit door, timers reconciled in an effect, loud throw outside the
  provider.
- **Confirmation copy states the actual cost** rather than "Are you sure?" — Characters names
  the chat count, Personas says chats are kept, Presets names the fallback, Chat counts the
  turns that leave. `ConfirmPrompt` puts Cancel first and the destructive action second.
- **`Modal` is a complete sheet**: title, subtitle, X, scrim-as-button, Escape, body-scroll
  lock with restore, and exit-before-unmount so the animation is not cut off.
- **Hover-only affordances are handled**: `.turn:hover .turn-tools, .turn:focus-within
  .turn-tools` plus `@media (hover: none)` — the transcript toolbar is reachable on touch and
  by keyboard. [verified: opacity 0 → 1 on focus]
- **Reduced motion** covers every CSS animation and every `motion.*` duration except the dock
  (§4.3). `found` and `think` keep a static substitute rather than vanishing.
- **The dock's pointer handling is textbook**: `setPointerCapture`, drag state in a ref,
  grab offset respected via deltas, `transition: none` while `is-dragging`. [verified: the
  dock follows the pointer 1:1 with no lag]
- **Empty states teach**: "on a new chat that is correct, not broken"; State's
  "an empty document on a fresh chat is correct… if it stays empty after several turns, the
  cheap model is not configured or is failing".
- **Memory's Recall + rendered prompt block** makes the invisible visible — the reader can
  see exactly what the model was given.
- **Contrast of the semantic palette is genuinely checked**: `--ink-dim` passes AA on all
  three dark grounds (5.84 / 5.46 / 5.04:1) and on light (5.42:1); the six speaker voices
  measure 6.55–7.81:1 dark and 5.14–6.13:1 light. [computed]
- **System font by default** for chrome, deliberate serif for prose, mono for tabular data.
- **Appearance edits apply live** (font scale 15.5px → 24.8px mid-drag). [verified]
- **`KnobEditor` renders *why* a control is disabled** inline with `aria-describedby` — the
  model every other disabled state should follow.

---

## 3. High-severity findings

### H1 — No control anywhere gives press feedback (§1 Response, §10 tap)

**Where:** `src/index.css:175-236` (`.btn`), `:239-261` (`.icon-btn`), `:1079-1099` (`.tool`),
`:484-506` (`.menu-item`), `:1788-1799` (`.plate`), `:2341-2359` (`.tab`), `:575-601` (`.pick-row`)

**Evidence:** `grep ':active' src/index.css` returns exactly two rules in 2877 lines —
`.consult-grab:active span` (`:2466`) and `.consult-dock .consult-pane-head:active` (`:2582`),
and the second only changes `cursor`. Every interactive class defines `:hover` alone.
[verified] A scripted `mouse.down()` on `.btn.primary` and `.tool` changed nothing
(`transform: none`, background unchanged) between rest and pressed.

**Impact:** §1's first rule is "respond on pointer-down". Nothing does. On touch — where
hover never fires — Send, Save, Delete, every menu entry and every shelf card feel dead at
the moment of contact. This is the single most-cited cause of an interface reading as
"not alive".

**Fix:**
```css
.btn:active:not(:disabled),
.icon-btn:active:not(:disabled),
.tool:active:not(:disabled) { transform: scale(0.97); }
/* 100ms ease-out added to the existing transition list, so the highlight
   lands on the press rather than after it (§1's own example). */
```

---

### H2 — Keyboard focus is invisible on every text field (§1, WCAG 1.4.11)

**Where:** `src/index.css:280-284`

**Evidence:** `.field:focus { outline: none; border-color: var(--line-strong); }` —
`--line-strong` is the **resting** border (`:269`), and `outline: none` (specificity 0-2-0)
beats the correct global ring at `:126-132` (`:focus-visible { outline: 2px solid var(--action) }`,
0-1-0). [verified] Focused field: `outline: none`, `border: rgba(233,226,215,0.2)` — identical
to unfocused, with `:focus-visible` matching true. The composer's own field has the same
`outline: none` (`:1547-1553`), and its soft ring composites to **1.20:1** — below the 3:1
non-text minimum.

**Impact:** A keyboard user tabbing through Setup, Settings, Personas, State, Memory or any
panel sees nothing to say where they are. Hover is *more* visible than focus, which is
backwards.

**Fix:** Delete `outline: none` from `.field:focus` and `.composer-input:focus`, or re-add
the ring under `:focus-visible`. If a soft ring is wanted for the composer, use `ink 45%`
(3.77:1).

---

### H3 — Dialogs do not move or trap focus (§16 Agency, WCAG 2.4.3)

**Where:** `src/components/Modal.tsx:42-54,77-100`; `src/components/Lightbox.tsx:26-37`

**Evidence:** `Modal` installs exactly two effects — an Escape listener and a body-scroll
lock. There is no initial focus, no Tab cycle, no `previouslyFocused` restore, and no
`inert`/`aria-hidden` on the background (`grep inert src/` → nothing). [verified] On the
"How it's written" sheet: `document.activeElement` was `BODY`, the dialog contains 38
focusables, and **8 Tabs landed on `BUTTON.tool` in the transcript behind the scrim**. On
the Lightbox: `activeInLightbox: false`, with 9 focusables still reachable outside.

**Impact:** Tab from a modal walks into the transcript behind the scrim — unreachable by
pointer, so the user is stranded. Closing returns focus to `<body>`, so the next Tab restarts
at the top. This affects **every sheet in the app**.

**Fix:** In `Modal`/`Lightbox`: record `document.activeElement` on mount, focus the first
focusable node, trap Tab/Shift+Tab, set `inert` on `#root`, restore focus on cleanup.
`autoFocus` on the close button is the minimum viable version. `NamePrompt` and `SearchPanel`
already do this — copy them.

---

### H4 — "Clear everything" destroys world state and every per-turn snapshot with no confirmation (§16 Responsibility, Agency)

**Where:** `src/routes/State.tsx:421-423` → `:263-277`; server `worker/src/state/api.ts:114-122`

**Evidence:** The button sits directly beside `Save changes` and calls `clearAll()`
immediately. The server does `INSERT INTO state … json = '{}'` **plus**
`UPDATE messages SET state_json = NULL WHERE chat_id = ?`. [verified] Clicking it produced no
dialog (`document.querySelector('[role=dialog]')` → false), a toast "World state cleared.",
and the stored row was gone.

**Impact:** One mis-click permanently destroys the live world document **and** the scene line
under every historical turn — the only record of where the scene was at each turn. It is the
most destructive action in the app and the only destructive one that does not even ask.

**Fix:** Wrap in `ConfirmPrompt` naming both losses, and move the button away from Save:
*"Clear the world state for this chat? Time, place, cast, outfits and threads are removed,
and every turn's scene line with them. Nothing brings them back."*

---

### H5 — Memory deletes are hard deletes: no confirmation, no undo (§16 Agency, Familiarity)

**Where:** `src/routes/Memory.tsx:399` (fact), `:499` (summary) → `:152`, `:186`, `:217-222`;
server `worker/src/memory/api.ts:170`

**Evidence:** `<button className="btn quiet danger" onClick={onDelete}>Delete</button>` wired
straight to `DELETE`, and the server does a real
`DELETE FROM ${kind} WHERE id = ?`. [verified] A live click on Delete removed the row with
**no dialog** and toasted "Fact deleted.". Every sibling screen confirms — Cast, Characters,
Chat, Personas, Presets — so the reader's learned expectation is wrong here specifically.

**Impact:** A mis-tap on a 58×34px button permanently destroys a fact the narrator recalls
into every prompt, or a summary covering twenty messages of history. The only feedback is a
success toast for the destruction.

**Fix:** Route through `ConfirmPrompt`, and/or soft-delete (`status = 'dropped'`) so the
success toast can offer Undo. Add an Undo slot to `ToastApi` (`Toast.tsx:39-45`) — there is
no undo anywhere in the app.

---

### H6 — Deleting the *last* turn skips the confirmation every earlier turn gets (§16 Familiarity, Agency)

**Where:** `src/routes/Chat.tsx:1035-1038` vs `:1178-1183`

**Evidence:** `const after = path.length - 1 - index; if (after === 0) { void remove(message.id, null); return; }`
— the same cross glyph on the same toolbar deletes immediately when the turn is last, and
opens `ConfirmPrompt` otherwise. [read]

**Impact:** The identical-looking control is safe or unsafe depending on position in the
scene — exactly the unpredictability Familiarity exists to prevent — and the destructive case
is the one with no warning, on the turn the reader is most likely to be looking at.

**Fix:** Confirm on every delete; keep the existing cost sentence (`Chat.tsx:74-83`).

---

### H7 — "How it's written" is not the thing it claims to be, and its cost claim is wrong (§16 Purpose, Responsibility)

**Where:** `src/components/CraftPanel.tsx:66-142`; `worker/src/prompt.ts:354-356`

**Evidence:** The surface named "How it's written" shows **36 controls and zero prompt text**
— `renderCraftBlock` / `renderContentPolicy` / `renderVocalisation` / `renderAntiRepetition`
are never imported by any component. [verified] Inside the dialog: no `<pre>`, no code, no
copy button, one heading, 37 `.form-row` elements. Worse, the only cache statement in the
panel is *"Changing anything here applies from the next turn, and costs one cache miss."* —
but `contentPolicy`, `vocalisation` and `antiRepetition` are emitted into the **tail**
(`worker/src/prompt.ts:354-356`), so toggling them costs **no** cache miss. Meanwhile the
panel never tells the reader that the other ~32 controls **do** cost one — the app's headline
architectural claim (`docs/HOW-IT-WORKS.md` §2 documents the exact split).

**Impact:** The reader cannot see what the model is actually told; the panel answers "what
did I set", not "what does it say". And it misstates the cost of the four toggles a
preset-importing reader is most likely to change.

**Fix:** Split into a **prefix (cached)** group and a **tail (per-turn)** group, driven off
the same list `assemble.ts` uses, and add a read-only view that renders the real assembled
blocks (the server already builds them) with a copy button.

---

### H8 — No velocity, no momentum, no spring, no rubber-band: every release is a dead stop (§2, §4, §5, §6, §7)

**Where:** `src/components/ConsultDock.tsx:46,108-141`; `src/index.css:2418-2421`

**Evidence:** `drag.current` is a single position sample with no timestamps and is never
appended to. `endDrag` (`:114-120`) and `onGrabUp` (`:136-141`) only clear the ref and flip
the class. No projection function exists anywhere. No spring exists anywhere
(`grep spring|bounce|stiffness|damping src/` matches only comments). [verified] A scripted
fast flick left the dock at exactly the clamped edge with `right` identical at 60ms and 360ms
after release — motion stops dead. [read] The clamps are hard:
`Math.max(8, Math.min(…, window.innerWidth - width - 8))` (`:109-110`) and
`Math.max(160, Math.min(next, window.innerHeight - 140))` (`:133`).

**Impact:** §5's "seam between drag and animation" is the detail that separates fluid from
fine. Throwing the panel or flicking the phone sheet does nothing. The sheet also has no
detents — it rests at any arbitrary height the finger stopped at.

**Fix:** Keep the last ~5 `{ t, x, y }` samples; on release compute px/s over ~80ms, project
the resting point with Apple's exponential form `(v/1000)·0.998/(1−0.998)`, choose the
nearest target, and hand the raw px/s to a spring (`bounce: 0, duration: 0.4` — damping 1.0 /
response 0.4 for reposition; `0.8 / 0.3` for a sheet). Add detents (35% / 65% / 100%) on the
phone. Replace the hard clamps with progressive `rubberband(overshoot, dimension, 0.55)`.

---

### H9 — The dock's settle transition never fires; the gesture layer is CSS where §3 bans it

**Where:** `src/index.css:2418-2421,2426-2428`; `src/components/ConsultDock.tsx:98,114-120`

**Evidence:** The comment at `:2416-2417` promises "a small overshoot is what reads as a
settle", but the final value is written **during** the drag while `.is-dragging` holds
`transition: none`, and `endDrag` changes no `--dock-*` value at all. A CSS transition needs
a property change to start, and the before-change style has `transition-property: none` — so
nothing fires. [verified] Measured at release: `is-dragging` removed, and the position was
already final. The only path that ever animates the dock is the window-resize clamp.

**Impact:** §3 bans CSS transitions for gesture-driven motion because they cannot be grabbed
and reversed mid-flight. The dock is the only draggable thing in the app, so this is the whole
gesture story.

**Fix:** Spring from the presentation value with the release velocity (H8). Delete the inert
`--dock-*` transition or move it to `transform`.

---

### H10 — The dock re-renders React and forces layout on every pointermove (§11 Frame smoothness)

**Where:** `src/components/ConsultDock.tsx:44-46,105,108-111,175`

**Evidence:** The comment at `:44-45` claims "drag state lives in a ref: a move handler that
re-rendered on every pointer event would put the whole transcript through React sixty times a
second" — but `onPointerMove` does exactly that: `:108` `setOffset({ right: …, bottom: … })`
with a fresh object on every move. Worse, `:105` `ref.current?.getBoundingClientRect()` runs
*before* the write, flushing the previous frame and forcing a synchronous layout per move. And
`:175` re-invokes the render prop with a new `dragHandlers` object each render, so the panel
re-renders with it. [read]

**Impact:** Dragging the consultant with a non-trivial session stutters — the exact failure
the comment says it avoided.

**Fix:** Write live position straight to the DOM in pointermove
(`ref.current.style.setProperty('--dock-right', …)`) and keep React state for the committed
value only; cache the rect at pointerdown; `React.memo` the panel and stabilise `dragHandlers`.

---

### H11 — The whole transcript re-renders and re-lexes on every streamed token (§11)

**Where:** `src/routes/Chat.tsx:571-574,958-1062`; `src/components/Markdown.tsx:37`

**Evidence:** `setPending((current) => ({ ...current, text: current.text + frame.text }))`
fires per delta, re-rendering Chat, which re-runs `path.map` building fresh elements for
**every** turn (fresh `actions` JSX, fresh `onContinue` arrow), so every `<Turn>` re-renders
and Markdown re-lexes each message's full content. Each delta also re-runs the scroll effect
(two rAFs) and the ResizeObserver path. [read]

**Impact:** In a long scene streaming stutters and the page jitters; cost per token grows
linearly with transcript length, so a scene that reads fine at 50 turns is visibly rough at
800.

**Fix:** `React.memo` `Turn` and `Markdown`; hoist `actions`/`onContinue` into stable
handlers; coalesce `pending.text` to one update per animation frame.

---

### H12 — `--ink-faint` fails WCAG AA for body text, and it is used for real reading text (§15, WCAG 1.4.3)

**Where:** `src/index.css:18,156,2316,2082,1876,1400,722,2487,517-518`; `src/lib/theme.ts:109,157`

**Evidence:** [computed] dark `#6B6157` = **3.06:1** on ground, **2.86:1** on surface,
**2.64:1** on raised; light `#9C9186` = **2.76 / 3.08 / 2.51:1**. Used for `.eyebrow` (the
display voice), `.form-hint`, `.row-sub`, `.plate-time`, `.turn-meta`, `.sheet-panel-sub`,
`.consult-working`, and `.menu-label` at `opacity: 0.75` → **2.06:1**.

**Impact:** Every hint, section label, timestamp and progress caption is below the 4.5:1 body
threshold; several are below even 3:1. This is the most pervasive legibility failure in the app.

**Fix:** Dark `--ink-faint: #948679` (5.24:1 on ground, 4.52:1 on raised); light
`--ink-faint: #6B6157` (5.42 / 4.91:1). Delete `opacity: 0.75` on `.menu-label`.

---

### H13 — `prefers-reduced-transparency` and `prefers-contrast` are not implemented at all (§14)

**Where:** `src/index.css:321,690,1493,1612,1956,2035`

**Evidence:** Six `backdrop-filter` sites (`.bar` 12px, `.sheet-scrim` 2px, `.composer` 14px,
`.scene-bar` 12px, `.lightbox-scrim` 6px, `.sheet-commit` 14px). `grep
prefers-reduced-transparency|prefers-contrast|forced-colors src/ index.html` → **nothing**.
[verified] Both media features report false and nothing reacts. §14 names three signals;
one (motion) is implemented.

**Impact:** A reader who asked the OS for less transparency still gets blur behind the
titlebar, scene bar, composer and every scrim; a low-vision reader gets no defined borders.

**Fix:**
```css
@media (prefers-reduced-transparency: reduce) {
  .bar, .scene-bar, .composer, .sheet-commit { background: var(--ground); backdrop-filter: none; }
  .sheet-scrim, .lightbox-scrim { backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  .bar, .scene-bar, .composer, .sheet-commit { background: var(--ground); backdrop-filter: none; border-color: var(--ink-faint); }
  .panel, .plate, .sheet-panel { border-color: var(--line-strong); }
}
```

---

## 4. Medium-severity findings

### 4.1 The measure does not constrain the prose (§15)
`.transcript { max-width: min(calc(var(--measure) + 26rem), 100%) }` (`index.css:861`) with
`--measure: 68ch`; `.prose` (`:1111-1117`) declares font/size/leading/colour but **no
max-width**. 68ch of Georgia at 15.5px ≈ 527px; +26rem = a 943px column, leaving ~897px ≈
**115ch** lines. The comment claims the ceiling is "where a line stops being comfortable".
**Fix:** `.prose { max-width: var(--measure) }`; drop `+ 26rem` to `calc(var(--avatar) + 12px)`.
Also expose `measure` in the Appearance panel — it has no control at all.

### 4.2 The dock's settle overshoot is not reduced-motion gated (§14)
[verified] With `prefers-reduced-motion: reduce`, `.consult-dock` still reports the 220ms
`cubic-bezier(0.22, 1.2, 0.36, 1)` transition. It is the only transform-bearing transition not
neutralised by one of the five reduce blocks. **Fix:** add
`@media (prefers-reduced-motion: reduce) { .consult-dock { transition: none; } }`.

### 4.3 `touch-action: none` on the dock — the *intent* is right, the scope is broad
`.consult-dock { touch-action: none }` (`:2415`) is declared on the container whose comment
says it is for the header. See §7 — this did **not** block the transcript in my test, but the
scope is still wrong and the correct fix is free. **Fix:** move it to `.consult-grab` and
`.consult-pane-head`.

### 4.4 Drag affordances have no keyboard path (§10, §16 Flexibility)
`.consult-grab` is a `div` with `role="separator"` and no `tabIndex`, no `onKeyDown`, and no
`aria-valuenow/min/max/orientation` — which ARIA requires for an operable separator. The
desktop drag is the pane header (pointer-only). Height is fixed at `useState(520)` and only
clamped inside `onGrabMove`. **Impact:** a keyboard/switch user cannot move or resize the
consultant; on a 568px-tall phone the 520px sheet plus the commit row puts the close button
off-screen with no way to shrink it. **Fix:** make it a real separator with arrow-key
handling (±24px, ±8px with Shift), and clamp height on mount.

### 4.5 Memory's inline error is detached from its field and outlives the failure
`actionError` (`Memory.tsx:95`) renders as a `.note.danger` **above** the input
(`:103`/`:514-536`). [read + agent live] Measured 125px above the input, and it persisted
after a later **successful** add. **Fix:** render it inside the form under the input and clear
it on success / on typing.

### 4.6 Memory's superseded rows fail contrast by construction
`Memory.tsx:319` applies `opacity: 0.55` to the whole row. [computed] effective contrast:
buttons/tag → 2.55:1, prose → 2.68:1, provenance → **1.72:1**. **Impact:** the rows the panel
most needs legible — the superseded ones, whose history is the stated point of keeping them —
are the ones that fail, including their Restore control. **Fix:** dim by colour or a
background tint, never `opacity` on a row containing interactive controls.

### 4.7 Memory is a 13,895px wall of equal-weight rows (§16 Simplicity)
[agent live at 390px] FACTS section 7056px, 60 rows at 143px, four identical buttons each; the
only differentiator is an 11.5px `--ink-faint` subject. Arcs/Scenes/Recall all sit below the
fold. **Fix:** group by subject (the data already carries one), collapse groups, add a filter.

### 4.8 World state's Save/Clear row is 2045px below the fold
[agent live] `.sheet-commit` exists in CSS for exactly this ("a sheet that takes three screens
to read should not make the reader scroll all the way down to save") and is used by
CharacterEdit and CharacterNew — but not by State. **Fix:** wrap the row in
`<div className="sheet-commit">`.

### 4.9 Unsaved edits are lost silently on navigation (§16 Agency)
[verified] Typed a marker into a CharacterEdit field, clicked the back crumb, returned — the
field was empty. `grep beforeunload|useBlocker|isDirty src/` → nothing. Same on State. **Fix:**
derive dirty, show it in the commit row ("2 unsaved changes"), and confirm on SPA navigation.

### 4.10 World state silently discards input while reporting success (§16 Responsibility)
`State.tsx:168-175` `if (at < 0) continue;` — a map line without a colon is dropped. [verified
by code + agent live] "Odile: oilskin coat\nTHIS LINE HAS NO COLON" saved as
`{"outfits":{"Odile":"oilskin coat"}}` with toast "World state saved. The next turn will use
it." **Impact:** on the screen whose premise is that a wrong value "shapes the writing until
it is corrected", silent loss is the worst failure mode. **Fix:** collect skipped lines and
surface them inline.

### 4.11 "Conditions" appears twice on World state with opposite affordances (§16 Simplicity)
`State.tsx:63-68` renders an **editable** Conditions textarea; `:382-398` renders a
**read-only** Conditions section whose hint says "Edit them by describing the change in the
chat rather than here." **Fix:** delete one.

### 4.12 `ThreadList` rows collapse to a 24px stub on a phone (§16 Flexibility, §15)
`StateMeters.tsx:148-160` — [agent live at 390px] the thread input measured **w=24px**
(scrollWidth 370–964) beside a 227px select and a 91px Remove. **Fix:** stack the row at
narrow widths.

### 4.13 Bond sliders have no accessible name (§a11y)
`StateMeters.tsx:82-95` — three range inputs with `aria-label: null`, no `id`, no `<label for>`.
**Fix:** `aria-label={`${meter.label} for ${pair}`}`.

### 4.14 Nothing surfaces memory-job status (§16 Feedback-status)
The worker has a full job lifecycle (`worker/src/jobs.ts:27-34`) and failures only
`console.warn` (`worker/src/memory/schedule.ts:168-169`). No endpoint exposes it. **Impact:** a
reader whose summary never appears cannot distinguish "still working" from "the cheap model is
not configured" from "the job failed and was abandoned". State already gives exactly this
diagnostic; Memory gives nothing.

### 4.15 Neither consult stream can be stopped (§3 Interruptibility)
`ConsultPanel.tsx:246` and `ChatConsultPanel.tsx:162` omit the `signal` argument the transport
already accepts (`src/lib/api.ts:125,157`). The chat turn does it properly (`Chat.tsx:559`,
Stop at `:1268-1283`). **Impact:** an interview going the wrong way keeps streaming and billing
with no way to stop it. **Fix:** hold an `AbortController` per pane and render the same Stop.

### 4.16 A failed preset/persona switch leaves the menu lying (§16 Responsibility)
`PresetMenu.tsx:50-53` restores `setCurrent(null)` instead of the previous value, so a failed
switch from A to B leaves the row reading "Global settings" while the server still holds A. The
comment states the exact rule the code breaks. `presets.error` is never read, so the sheet
renders a false "No presets yet." PersonaMenu has the same silent-revert bug.

### 4.17 A menu item that is a button and does nothing
`Chat.tsx:932` `onClick={() => {}}` on a `MenuAction` labelled `Last turn N% cached`. It
renders identically to every other entry and takes the click. **Fix:** render it as
`MenuLabel` (non-interactive) or wire it.

### 4.18 Stacked sheets: one Escape closes both; a confirm opens with focus still behind it
`Modal.tsx:42-45` binds Escape on `document` per instance with no top-of-stack guard, and
`CastPanel.tsx:172-180` renders a second Modal inside the Cast sheet. **Impact:** pressing
Escape to dismiss the inner confirm also closes the outer panel and loses the reader's place;
and a destructive `ConfirmPrompt` opens with focus still on the Delete button, so a second
Enter deletes. **Fix:** a module-level sheet stack where only the topmost handles Escape;
focus the panel/Cancel on open. [My own test opened only the outer Cast sheet, so the
double-close is [read] rather than [verified].]

### 4.19 The last theme edit before closing the Appearance sheet is lost
`AppearancePanel.tsx:62-71` clears the 600ms debounce timer on unmount, so an edit made within
600ms of Done is painted but never written. **Fix:** flush the pending write in cleanup.

### 4.20 `ThemeEditor`'s "Reset" destroys the whole theme, unconfirmed, and does not look like a control
`ThemeEditor.tsx:44-47` replaces the entire theme via `.app-link` — a class the stylesheet's own
comment records as dangling (`index.css:837-841` defines it only under `.turn-truncated`).
**Fix:** give it real button styling and a `ConfirmPrompt`, or keep a one-step snapshot + Undo.

### 4.21 Settings accepts free text for two numeric fields and silently discards a bad value
`Settings.tsx:242-262` → `worker/src/db.ts:217-218` `Number(raw.maxTokens ?? 1024) || 1024`. A
typo is stored, coerced to the default on read, and never reported. **Fix:** validate inline.

### 4.22 A new character is created and the list never says which one
`CharacterNew.tsx:214` navigates to `/characters?created=<id>` and `Characters.tsx` never reads
it. **Fix:** reuse the `is-found` highlight pattern from Chat's search jumps.

### 4.23 The cast picker is not under the row it belongs to
`CastPanel.tsx:139-146` — the comment says the picker "opens inline under the row it applies
to", but the markup renders it after the whole list under a bare "Attach a card" heading.
**Fix:** render it inside the mapped row and name the member.

### 4.24 Reduced-motion/transparency on the sheet materials, and the bar's hard divider (§12)
`.bar`, `.scene-bar` and `.sheet-commit` separate with a full-width 1px hairline while blurred
prose scrolls under them; only `.composer` does it right (gradient `::before`, `:1502-1512`).
**Fix:** apply the composer's fade to the other three.

### 4.25 Translucent-on-translucent stacking collapses legibility (§12)
`index.css:1347` `.md-details { background: surface-raised 70% }` inside a turn band at
`surface 55%` (`:895`) composites to **1.08:1**. **Fix:** make `.md-details` near-opaque.

### 4.26 No `<main>`, no live region for streamed replies, no per-route title (§16 Wayfinding)
`Chat.tsx:945` renders `<div className="transcript">` with no `<main>`; the streaming reply has
no `aria-live`/`role="log"`; `.thinking` puts an `aria-label` on a bare `span` with no role.
**Fix:** add the landmark, `role="log" aria-live="polite"`, and per-route `document.title`.

### 4.27 Typography: px scale ignores the user's text-size setting (§15)
`theme.ts:231-235` emits every step in **px**, so the browser's default font size has no
effect. Two sizes are hard px outside the scale (`.scene-rest-label` 10px, `.tag` 10.5px) and
do not follow even the in-app slider. Leading is a single 1.68 for all sizes, and `.title`
(23px) inherits 1.5. **Fix:** emit rem, convert the literals, tune leading per step.

### 4.28 State/theme values silently rewrite on reload
`parseTheme` clamps `fontScale` to 0.85–1.5 and `lineHeight` to 1.3–2.2 (`theme.ts:310-311`)
while the sliders offer 0.8–1.6 and 1.2–2.2 (`ThemeEditor.tsx:84-95`). A saved 80%/160%/1.2
comes back changed. **Fix:** make the ranges identical.

### 4.29 The scene bar's empty state does not look like a control
`SceneBar.tsx:43-53` renders no chevron in the empty branch (it lives at `:84`), and the
emitted `is-empty` class has no rule in the stylesheet — yet it stays a full-width button with
`cursor: pointer`. **Fix:** render the chevron in both branches.

### 4.30 Press targets are under the 44px bar everywhere on a phone (§10)
[verified at 390px] `.tool` 27×27, `.icon-btn` 34×34, `.toast-close` 22×22, `.btn` min-height
34, `.tab` 31, `.plate-actions .btn.primary` 32, `.consult-grab` height 22, `.scene-bar`
height 38. `.toast-close` at 22px also fails WCAG 2.5.8 (24px minimum). **Fix:** raise
`.btn`/`.icon-btn` to 44px at narrow viewports (keep the visual size via a nested span) and
grow `.tool`'s hit area with a transparent `::before`.

### 4.31 State/theme: `avatarSize: 0` does not hide avatars (§15, §16)
It only sets `--avatar: 0px`, which leaves a 2px bordered dot and a 12px dead grid column
(`index.css:876-880,923-936`). **Fix:** emit a `data-avatars="hidden"` attribute and drop the
column.

### 4.32 Failure toasts are announced politely, and some failures not at all (§16 Feedback-error)
The single live region is `role="status" aria-live="polite"` (`Toast.tsx:147`) and carries
failures too. SearchPanel's failure and shortfall notes are plain divs. **Fix:** `role="alert"`
for failures; keep the button's text and add `aria-busy`.

### 4.33 `--dur-fast/base/slow` are dead; the motion language is not tunable
[verified] `grep 'var(--dur' src/` returns **nothing**; every rule hard-codes its duration.
`--ease` is used twice. The comment at `:53-56` claims the app's feel is "tunable from one
place". **Fix:** consume the tokens or delete them.

### 4.34 Tap targets/typography on the long forms: `ICON_BTN` and three button heights on one row
`Characters.tsx:22` overrides `.icon-btn` to 30px inline while `.plate-actions .btn.primary`
is 32px and `.icon-btn` is 34px (`index.css:1900,239-243`). **Fix:** settle one height.

### 4.35 Tags and badges are borderline-unreadable (§15, WCAG 1.4.11)
[computed] `.tag` 4.11:1 at 10.5px; `.tag.danger` 3.79:1; `.tag.verdigris` 4.23:1;
`.consult-badge` 3.88:1; `.btn.primary.danger:hover` **2.54:1** (the most dangerous button is
least legible while hovered); `.tab[aria-selected]` fill is 1.08:1 against the track.
**Fix:** use `--ink` for `.tag` text, scope `.btn.danger` so it cannot override `.btn.primary`,
give the selected tab a border.

### 4.36 `100vh` instead of `100dvh`, and the 420px breakpoint does not exist (§12, responsive)
`dvh` is used in exactly one place (`:479`); the sheet, lightbox image and standalone pane use
`vh`. `grep 420 src/index.css` finds no `@media (max-width: 420px)` despite
`ConsultDock.tsx:71` relying on it. **Fix:** switch to `dvh`; add the tier or correct the comment.

### 4.37 Dark scrim provides almost no separation (§12 depth)
[computed] `--scrim: rgba(10,8,6,0.62)` composites to #0F0C09 = **1.05:1** against the ground;
the sheet is 1.13:1 against that. The light scrim works (2.54:1). **Fix:** darken to
`rgba(6,5,4,0.72)`.

### 4.38 The swipe gesture the code documents does not exist, and the server's wrap is unreachable
`MessageActions.tsx:4-8` says "swipe ends up invisible on the device it is most wanted on", but
there is no pointer code at all — swiping is two buttons. The server deliberately wraps
(`worker/src/messages.ts:191-194`, "Wrapping means the arrows are never dead ends") while the
UI disables exactly there (`canSwipeLeft={(message.swipeIndex ?? 0) > 0}`). **Fix:** enable the
wrap or delete the server-side wrap; implement a real horizontal drag with ~10px hysteresis if
the gesture is wanted.

### 4.39 `Memory` and `State` standalone routes have no inbound link
Both are reachable only by URL; the menu opens the embedded panels. **Fix:** link them, or
delete the routes.

### 4.40 CraftPanel: 36 ungrouped controls, disabled-all on every toggle, and jargon labels
[agent live] 37 `.form-row`s with one eyebrow; activating one checkbox disabled **all 37** for
the round trip and dropped focus to `BODY`. Labels are coinages ("Anti-slop", "Nomenclature",
"Impulse first") glossed only in 11.5px `--ink-faint` (2.86:1). The checkbox is the unstyled UA
control rendering in the OS accent colour — the only colour in the panel from outside the
theme. **Fix:** group into named sections; disable only the control being changed; keep focus;
`accent-color: var(--action)`; raise the hints to `--ink-dim`.

### 4.41 `Memory`'s edit textarea is unlabelled and focus does not move to it
`Memory.tsx:322-326` — no `aria-label`, no placeholder, no `id`; after clicking Edit,
`document.activeElement` was `BODY`. **Fix:** `autoFocus` + `aria-label`, restore focus on
close.

### 4.42 `State` promises engine writes on a chat where the engine is off
`stateMode` is never referenced in `State.tsx`/`Chat.tsx`/`SceneBar.tsx`, so a chat with
`stateMode: 'off'` still reads "The engine proposes changes after each completed turn".
**Fix:** read `stateMode` and render a note when it is off/manual.

### 4.43 Wrong per-field placeholders in World state
`State.tsx:348` `placeholder={field.map ? 'Name: what they are wearing' : 'one per line'}` is
applied to every map field, so Conditions is taught the clothing grammar and "Present" gets
none. **Fix:** move the placeholder onto the `Field` definition.

### 4.44 `BackLink` produces a doubled accessible name
`AppBar.tsx:199` `title={`Back to ${label}`}` with `Memory.tsx:272`/`State.tsx:441` passing
`label="Back to chat"` → **"Back to Back to chat"**. [verified by code read] **Fix:** pass
`label="chat"`, or stop prefixing when the label already starts with it.

### 4.45 `--ink-faint` crumb over blurred chrome, and the crumb collapses to a 24px icon on phones
`index.css:410-421` uses `--ink-faint` (3.06:1) at 13px/400 over the blurred bar; at ≤480px the
label is `display:none` (`:439-451`), leaving a 24×24 chevron as the only way back. **Fix:** use
`--ink-dim`/`--ink`, and keep a larger target.

### 4.46 State's duplicate error render
`PresetEdit.tsx:41` renders an inline `note danger` **and** `:58-60` repeats the same message as
a `form-hint`. **Fix:** one.

### 4.47 `Settings` shows no busy state on its primary Save
Unlike every other form, `Settings`' Save button never changes label and `saveKey` shows
nothing in flight; `if (loading) return <Frame>Loading…</Frame>` also replaces the whole page
rather than keeping the chrome, alone among the routes.

### 4.48 `OpeningPicker` and the app menu declare ARIA patterns they do not implement
`OpeningPicker.tsx:68-79` declares `role="tablist"`/`role="tab"` with no `aria-controls`, no
`tabpanel`, no arrow-key roving focus. `AppBar.tsx:122` declares `role="menu"` with
`role="menuitem"` children but installs only Escape (`:77-79`) and never moves focus in.
[verified] With the menu open by keyboard, ArrowDown left focus on the menu button. **Fix:**
implement the patterns or drop the roles.

---

## 5. Low-severity findings

| # | Finding | Where |
|---|---|---|
| L1 | `.btn.danger` has styling only on hover, so "Clear everything" looks neutral at rest | `index.css:228-231` |
| L2 | `SceneBar`'s `is-empty` class has no rule | `SceneBar.tsx:43`, `index.css` |
| L3 | Four dead classes: `.rule`, `.bar-link`, `.tag.verdigris`, `.tag.danger` | `index.css:139,394,2161,2166` |
| L4 | `.bar-home` comment block duplicated with contradictory second halves | `index.css:358-373` |
| L5 | `Avatar.tsx` comment claims blob URLs are revoked on unmount; only `invalidateAvatar` (uncalled) revokes | `Avatar.tsx:18,61-65,96-99` |
| L6 | `fact.superseded_by.slice(0,8)` renders an opaque UUID fragment | `Memory.tsx:372` |
| L7 | `CharacterEdit.tsx:300` claims "still one undo away" — no undo exists | `CharacterEdit.tsx:300` |
| L8 | `GreetingsEditor` deletes an opening from a bare `×` with no confirm | `GreetingsEditor.tsx` |
| L9 | `Avatar` collapses network failure, 401 and a corrupt blob into one letter fallback | `Avatar.tsx:105-113` |
| L10 | Copy drift: home is "All chats" in the menu, "Scenes" in breadcrumbs and the h1 | `AppBar.tsx:157`, `Presets.tsx:90`, `ChatList.tsx:35` |
| L11 | Jargon in labels: "cache miss", "knobs", "flat/bubble", `#{seq}`, raw field keys | `CraftPanel.tsx:74`, `PresetMenu.tsx:100`, `ThemeEditor.tsx:60,75`, `SearchPanel.tsx:122` |
| L12 | `CharacterNew` shows `0 tok` per opening while the tokenizer loads; `CharacterEdit` shows `—` | `CharacterNew.tsx` vs `CharacterEdit.tsx:519` |
| L13 | `CharacterEdit` field shows `--ink-faint` hints at 2.86:1 inside a panel | `index.css:2316` |
| L14 | `Modal`/`ConfirmPrompt` busy label is generic "Working…" where the confirm label would read better | `ConfirmPrompt.tsx:45` |
| L15 | `.consult-pane-head` hint is dropped entirely below 620px rather than wrapped | `index.css:2605-2610` |
| L16 | `CraftPanel` has no busy feedback beyond a blanket `disabled` | `CraftPanel.tsx:55-63` |
| L17 | `.menu-label` de-emphasises with `opacity: 0.75` on top of an already-failing colour | `index.css:517-518` |
| L18 | `.tag` height 19px and font 10.5px are hard px, outside the scale entirely | `index.css:2138-2149` |
| L19 | Tracking is size-specific in direction but hard-coded per rule with no optical sizing; `.title` uses `-0.01em` where §15's example uses `-0.02em` | `index.css:169,355` |
| L20 | No `will-change` anywhere, and `overscroll-behavior: contain` only on the menu | repo-wide |

---

## 6. Per-screen wayfinding and feedback

| Screen | Wayfinding | Status | Completion | Warning | Error |
|---|---|---|---|---|---|
| **Setup** | title page, one sentence on the token, footer on where it lives | `Checking…` | navigates away | n/a | inline + specific |
| **Scenes** (`/`) | title + count + Characters | `Loading…` | n/a | n/a | inline |
| **Characters** | AppBar title + count; **no `<h1>`** (inconsistent with Scenes/Presets/Memory) | per-row `disabled` | names the deleted card | names the chat cascade | names the card |
| **CharacterNew** | mode stated in title/subtitle; sticky commit row | `Saving…`, tokenizer note | toast; **`?created=` ignored** | says why a portrait was dropped | inline + toast |
| **CharacterEdit** | breadcrumb + back + sticky commit; repair path for bad JSON | `Saving…`, per-field tok | toast | inline validation | inline + toast; **no dirty guard** |
| **SceneSetup** | best in app: `Step n of 3 · name` + eyebrow + Back/Next/Skip | `Starting…` | toast + navigate | each radio states its consequence | inline |
| **Personas** | title + full explanation; **no `<h1>`** | `disabled` | rename toast warns of the cache miss | names what is kept | split inline/toast |
| **Forge** | own column, own eyebrow, title links home | 3-phase streaming + caret | lands on the editor | "changes apply to the form" | inline; **no Stop** |
| **Presets** | breadcrumb + `<h1>` + definition | `Creating…` | names the copy/deletion | names the fallback | toast |
| **PresetEdit** | breadcrumb + back + Cancel | `Saving…` | toast + navigate | n/a | **shown twice** |
| **Settings** | four eyebrow sections; **no `<h1>`**; loading replaces the chrome | **no busy state on Save** | toast | model warning | toast + warn |
| **Chat** | back, title, SceneBar, scoped menu, Memory icon | excellent streaming/Stop | **none for delete/edit/swipe** | counted delete warning | inline above composer |
| **Memory** | back + `<h1>` + explanation; **no inbound link** | none for jobs | toast per tier | **none — unconfirmed deletes** | detached from the field |
| **State** | back + `<h1>` + why it matters; **no inbound link** | `disabled`, no label change | toast; "Nothing changed." inline | **none — needs one for Clear** | toast + inline |
| **Panels** (all) | Modal gives title/subtitle/X/scrim/Escape | Craft/Search/Cast/State: `disabled` only | toasts; **none in CraftPanel** | "costs one cache miss" | inline; **PresetMenu/PersonaMenu swallow errors** |

---

## 7. Claims checked and refuted

**"`touch-action: none` on `.consult-dock` makes the consultant's transcript unscrollable by
touch."** — **Refuted.** Reported by two independent reads of `index.css:2415`. Live test at
390×844 with CDP touch emulation, the transcript padded to 990px inside a 372px box: a swipe
inside `.consult-transcript` scrolled it **285px**. `touch-action` resolves per-element against
the touched element's own computed value (`auto` here), so the ancestor's `none` did not
block it. The *scoping* is still wrong and the fix is free (move it to `.consult-grab` and
`.consult-pane-head`), but the severity is not "high — cannot scroll the dock at all".

**"The dock's release settle transition fires but is invisible."** — **Refuted in the opposite
direction**: it does not fire at all (H9, verified by measurement).

---

## 8. Suggested order of work

**Wave 1 — cheap, high-impact, no design decisions** (~half a day)
1. Press state on all controls (H1) — one CSS block.
2. Focus ring on `.field`/`.composer-input` (H2) — delete two `outline: none`.
3. `--ink-faint` raised in both themes (H12) — two hex values, fixes hundreds of labels.
4. Reduced-motion on the dock + `prefers-reduced-transparency`/`prefers-contrast` blocks (H13, 4.2).
5. Confirm on "Clear everything" (H4) and on Memory deletes (H5) — `ConfirmPrompt` already exists.
6. Confirm on every turn delete (H6) — delete the `after === 0` branch.
7. Move `touch-action` to the two real drag surfaces (4.3).
8. Delete the dead `--dur-*` tokens or consume them (4.33).

**Wave 2 — the primitive fixes** (1–2 days)
9. Focus management in `Modal`/`Lightbox` (H3) — fixes every sheet at once.
10. `.prose { max-width: var(--measure) }` (4.1).
11. Sheet-stack Escape guard + focus the confirm (4.18).
12. Unsaved-change guard on the character forms and State (4.9).
13. Surface skipped lines and the inline error in State/Memory (4.10, 4.5).
14. Emit the type scale in rem (4.27).

**Wave 3 — the gesture layer** (2–3 days, the real work)
15. Velocity history + momentum projection + spring release on the dock (H8).
16. Move the dock's live position out of React state and cache the rect (H10).
17. `React.memo` Turn/Markdown and coalesce streamed text per frame (H11).
18. Detents and rubber-banding on the phone sheet (H8).

**Wave 4 — the surfaces that need design decisions** (needs your call)
19. **How it's written**: split prefix/tail, add the rendered-prompt view (H7).
20. **Memory**: group by subject, filter, fix superseded contrast, job status (4.6–4.8, 4.14).
21. **State**: dedupe Conditions, sticky commit row, `stateMode` note (4.8, 4.11, 4.42).
22. Abort controllers for both consult streams (4.15).

---

## 9. Audit hygiene

- Read-only against the repo; no file under `src/` or `worker/` was modified.
- The audit ran against a **copy** of the database (`.audit-db/`), not `data/`. The copy was
  missing three migrations (`0014`–`0016`), which were applied to the copy only.
- Scratch data created while testing (one fact, one character edit field) was on the copy.
- Two toggles mutated during the deep screen audit were restored to their server values.
- Teardown: stop the Bun server, delete `.audit-db/`.
