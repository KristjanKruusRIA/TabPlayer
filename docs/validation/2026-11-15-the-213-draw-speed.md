# THE-213: drawing a note edit without drawing the whole score

Date: 2026-11-15. Branch `agy/the-213-draw-speed`, cut from `develop` (0b8622d). The previous slice (`2026-11-14-the-213-edit-speed.md`) made the edit itself cheap
(native call about 25 ms, edits in place, undo and redo in place, playback prepared after typing stops) and left the draw: on the owner's largest score a typed
note took more than 300 ms to appear, because alphaTab laid out, painted and inserted every system of the score for every edit.

## Result in one table

Real app (`scripts/build-desktop-test.ps1` build of this branch, WebView2, 1440 x 900 window at 150 % scaling, CDP on 9223), typed digit on a note, Windows 11, one machine with
other agents' apps and test runs on it. "Before" and "now" are the same build: the old behaviour is switched back on with `globalThis.__tabplayerDrawFlags = {lazy:false,
deferrals:6, completeDeferrals:6, ahead:0, paintOnCursor:false}` (development hooks only; see "What changed"). **The two are measured alternately in one session**
(`ab2.mjs`: 16 edits each, then 4 bursts of 8 each, so both see the same machine load), once with the key held 15 ms (what the drivers send) and once with it held 100 ms (a person
holds a key 80 to 120 ms; see "The deferral and the key hold" for why that matters). Key to the first change of the score's drawing, medians (p90, worst of 16):

| owner's largest score (141 bars, 6 tracks), Parchment | before | now |
|---|---|---|
| **key held 100 ms: key to the typed note drawn** | 167 ms (p90 190, worst 419) | **95 ms** (p90 107, worst 116) |
| key held 15 ms: key to the typed note drawn | 261 ms (p90 273, worst 480) | **93 ms** (p90 101, worst 114) |
| burst of 8 digit+Enter pairs 120 ms apart, key held 100 ms: edits applied / longest wait of a key | 8 of 8 / 79 ms | 8 of 8 / 75 ms |
| burst, key held 15 ms: edits applied / longest wait of a key | 8 of 8 / 173 ms | 8 of 8 / 51 ms |
| burst, key held 15 ms: last change of the drawing after the last key (now: includes the background painting after the burst) | 572 ms | 174 ms |

Earlier, separate runs of the same two builds (not alternated, the machine busy with other work, key held 15 ms): 327 ms (p90 449, worst 623) before, 88 ms (p90 111, worst 201) now;
generated 6 x 200 score 278 ms before, 93 ms now; a burst settled 1096 ms (owner) and 797 ms (generated) after the last key before, 74 ms and 23 ms now. **Those "before" numbers are
larger than the table's because the machine was busier and the key was held 15 ms; the table's are the ones to quote.** A key typed 35 ms after the digit waited 60 ms before and 53 ms now
(p90 142 and 65); the cursor move is 12 and 10 ms; the native edit call 12 to 15 ms in both; Play is ready again after 1.2 to 1.8 s in both (the plan is not part of this change).

On the **final build** (after the last commit) `ab2.mjs`, the same alternated design but with the machine busy (the native call took 15 to 20 ms instead of 12, other agents' apps were running), owner's largest: key held 100 ms, first change
193 ms (p90 277, worst 731) before against **118 ms** (p90 167, worst 168) now; key held 15 ms 316 ms (p90 381, worst 525) against **111 ms** (p90 123, worst 146); the longest wait of a key in the
bursts 208 ms against 115 ms (100 ms hold) and 211 ms against 96 ms (15 ms hold); all bursts applied 8 of 8. So the final build keeps the gain under load, and it is the number to quote when the machine
is busy: about 110 to 120 ms with a worst of 170 ms, against 190 to 320 ms and a worst of 525 to 731 ms.

The hard requirement (a typed note on screen and the next key accepted, median under 200 ms on the owner's largest score in the real app) is **met**: 93 to 95 ms to the note with the
machine calm, 112 to 181 ms in runs with it busy, and 53 to 74 ms for a key typed meanwhile to be taken up. The aim of about 100 ms is met at the median on a calm machine and
missed at the tail (worst of 16: 116 ms calm, 201 to 260 ms busy).

Two caveats that matter for reading the numbers.

* "Editor free" (the busy flag) went **up** (87 to 107 ms), and that is not a loss: the busy flag used to drop before the draw (the draw then ran for 200 to 300 ms and a key typed in
  the meantime waited for it on the main thread); now the draw is over by 90 ms and the flag drops after it.
* The previous slice measured 675 ms on this score and 200 to 250 ms on the generated one (a ratio of about 3). **That ratio was not reproduced**: here the same edit costs 167 to 363 ms
  and 262 to 331 ms (about 1.1 to 1.3). The earlier run was made while other work loaded the machine; I did not find the rest of the difference.
  The conclusions below are about this run's phases, not about that number.

## The deferral and the key hold

The draw used to wait, up to six times 16 ms, while `navigator.scheduling.isInputPending` reported a key or click waiting (`DRAW_DEFERRALS_MAX`). The first version of this note said the key-up
of the key just typed held every draw back "about 100 ms for nothing". That explanation was **too strong and is corrected here**; this is what was measured.

* **What made `isInputPending` return true** (`ipending.mjs`: the app's own call wrapped to log its result, next to the page's keyboard events; digits typed with the key held 15, 60, 100
  and 150 ms, three each, on the generated score and on the owner's largest, deferrals switched back to 6 so that the check runs). Held 15 ms: true in **6 of 6**, 57 to 177 ms after the
  key-down, while the key-up event reached the page 73 to 196 ms after the key-down (the driver's 15 ms hold arrives as 75 ms because the key-up queues behind the main thread's work
  on the key-down; that the pending event is the key-up is inferred from the timing, `isInputPending` does not say which event). Held 60 and 100 ms: true in **0 of 12**. Held 150 ms:
  true once in 6, at the key-down itself (0 ms). The longest run of consecutive true answers was **1**: six in a row (the whole allowance) never happened.
* So a deferral only happens for a key released before the draw is due. What it costs then is a 16 ms timer, a re-render of the score view and the draw running behind whatever the edit
  queued meanwhile (the plan's 60 ms task). **Alternated in one session, lazy layout, deferrals 6 against 0**: key held 15 ms: first change 187 ms (p90 205) against 85 ms (p90 97);
  key held 100 ms: **84 ms against 87 ms**, no difference. With the old whole-score draw the same effect is 261 ms (key held 15 ms) against 167 ms (100 ms). The drivers' 15 ms key press
  therefore overstated what a person waited before.
* **Layouts that still draw the whole score** (horizontal strip, vertical page), owner's largest, deferral for them 6 against 0, alternated, 16 edits and 4 bursts of 8 each; first
  change, median (p90, worst), and the longest wait of a key in the bursts:

| | held 15 ms, 6 | held 15 ms, 0 | held 100 ms, 6 | held 100 ms, 0 |
|---|---|---|---|---|
| horizontal strip, first change | 291 (312, 386) | **184** (194, 199) | 181 (200, 390) | 188 (200, 204) |
| horizontal strip, burst: median / worst key wait | 184 / 218 | 164 / 185 | 96 / 96 | 72 / 75 |
| vertical page, first change | 382 (415, 499) | **282** (300, 318) | 275 (304, 557) | 277 (299, 304) |
| vertical page, burst: median / worst key wait | 252 / 323 | 274 / 296 | 64 / 64 | 65 / 77 |

  All bursts applied 8 of 8 edits. **6 was never better** (equal with a realistic key hold, 100 ms slower with a short one), and a key waiting behind a whole-score draw does not wait less with it.
  So the default is now 0 for these layouts too (`completeDeferrals`, kept as a flag so that a driver can put 6 back; `ScoreView.layouts.test.tsx` checks both values). The earlier statement that
  "none of this branch's code runs for the page layouts" was false (the shared deferral count changed for them); it is now 0 for them by measurement.

## Playback: a system is painted before the cursor highlights it and scrolls to it

alphaTab moves the playback cursor inside an animation-frame callback (`_cursorUpdateBeat` calls `beginInvoke`): `_internalCursorUpdateBeat` places the bar cursor (`placeBarCursor`), highlights the sounding
beats inside the bar's piece (`highlightElements` looks in the piece for the group class), then calls our scroll handler, which sets `scrollTop`. A scroll made inside an animation-frame callback
fires its `scroll` event in the next frame, and alphaTab's visibility callback comes after the frame as well, so with lazy painting a system that was not painted yet was shown blank for one
frame with the cursor over it, and its beats were not highlighted (alphaTab does not highlight again after painting). The probe below sees it with the fix switched off (`paintOnCursor:false`): a blank frame
at a line change on the generated score.

What changed (`screen-playback.ts`, `ScoreView.tsx`):
* `placeBarCursor`, the first thing alphaTab calls, now calls `ensurePainted(bar)` (supplied by the score view): the piece that holds the bar **and every piece within one viewport of it** are painted at once when
  empty. The scroll that follows reveals what lies between the old view and the cursor (found by the probe: a first version that painted only the cursor's piece left the pieces in between blank for one frame
  at a seek, in three runs on two owner scores); the next line is therefore already painted when the cursor gets there.
* New nodes carry no highlight class: after a piece is painted again (scroll, resize, the background painting) the adapter puts the sounding beats' highlight on again (`rehighlight`, from the groups alphaTab
  highlighted last).
* alphaTab empties a piece that left the view one frame late; a piece that is back in view by then would be shown empty (one blank frame, seen once by the probe at scroll position 808 on the largest score).
  A mutation observer on the pieces (it runs before the next frame is drawn) paints it again.
* Systems that the score area gains by changing size (a taller area, a closed dock) are painted when it changes.

**The probe** (`tests/desktop/playback-draw.mjs`, `draw-probes.mjs`, committed): every presented frame is sampled (a task posted from the animation-frame callback runs after the frame): for every piece in
view whether it has a drawing, and the number of highlighted beats while the bar cursor is in the score area. It plays through at least three line changes (counted by the bar cursor's position), a **click-seek**
while playing (on the number farthest from the cursor), a **seek back to the start** from a scrolled-away view, and a **loop across a line break** until it has wrapped twice, on a generated score and on each of the
owner's five scores. On the owner's scores the same steps are also run on the complete render as a control. **Final build: 0 blank frames and 0 frames without a highlighted beat in all six scores**, each with 3 line
changes, the seeks and 2 loop wraps (11 runs counting the controls, all with 0 and 0). The sampler sees the main thread's state after each frame; see "Scrolling" for what it cannot see.

The probe's own mistakes, so that they are not repeated: its first runs reported frames without a highlight on scores with bars of rests (nothing to highlight) and after the driver scrolled the view away while
playing (alphaTab empties the system, and its highlight, when it is out of view). It now expects a highlight only while the bar cursor is in the score area, and when a frame is bad it records a snapshot of the page
(the pieces in view, which are empty, the scroll position): the snapshots are what showed the seek and the late-emptying cases above.

## Why the owner's scores drew slower than the generated one (verified unless it says inferred)

Both open in the Parchment layout with the Selected track view, so one track is drawn, not six (verified: 50 and 70 system pieces in the page, `.at-surface`).

* **More DOM per bar.** The owner's scores show standard notation and tablature for each guitar track ("Score and tab"); the generated score is tablature only. The
  largest of the owner's scores draws 19,070 nodes in 50 systems (4,086 `text`, 10,239 `rect`, 3,899 `g`); the generated one 9,168 nodes in 70 systems (1,876 `text`,
  4,668 `rect`). 2.1 times the nodes in fewer systems, and the dense ones carry palm-mute bands (1,902 palm-muted notes in the largest), let-ring (252), tuplets (147) and beams, which I take to be the extra `text` and `rect` (inferred, not counted by kind).
* **What a draw cost scales with the nodes**, not with the file size (verified, one edit, CPU profile symbolized with the source map of the same bundle, and a Chromium trace):

| main thread, one typed digit | owner's largest | generated | ratio |
|---|---|---|---|
| alphaTab `renderScore`, all of it | 139 ms | 84 ms | 1.7 |
| of which layout proper (bars, systems, bounds) | 17 ms | 10 ms | 1.7 |
| of which painting to SVG text and building bounds | 15 ms | 12 ms | 1.3 |
| of which inserting the SVG (`innerHTML` of every piece) | 42 ms | 21 ms | 2.0 |
| of which MIDI generation and load (`loadMidiForScore`) | 11 ms | 17 ms | 0.6 |
| forced layout: the first read of the DOM after the insertion (`getOffset` in our overlay pass) | 61 ms | 28 ms | 2.2 |
| browser: parse HTML, style, layout (trace) | 32 + 36 + 24 ms | 16 + 20 + 12 ms | 1.9 |
| browser: pre-paint, paint, layerize (trace, after the task) | 47 ms | 32 ms | 1.5 |
| key to the first commit after the draw (trace, one edit, tracing slows it) | 233 ms | 163 ms | 1.4 |

  The costs that depend on the DOM (insertion, forced layout, parse, style, layout, paint) are 1.7 to 2.2 times; the ones that depend on the model (layout proper, MIDI) are
  not. The model is not bigger: the generated score has 9,600 beats in 6 tracks, the owner's largest 7,042 beats in 6 tracks.
* **Not the cause** (measured and read): our overlays (cursor, selection, loop, errors, diagrams, bar handles) cost 0 to 2 ms per draw (`refreshOverlays`, profile); the overlay
  pass reads the canvas offset once per pass and reuses it (`passOffset`), and the profile shows one forced layout per draw, at that read. The 48 to 61 ms "forced layout" is the browser laying out the
  freshly inserted 19,000 nodes at the first read; it is not caused by the read, only moved by it: without the read the same layout is paid at the next frame.
* Inferred, not measured: glyph and font cost (the node counts account for the ratio; text width tables are cached by alphaTab per font).

## What changed, and what each change did

All in the app's own code; no dependency, nothing under `node_modules`, no edit type or project format, nothing on the audio callback, `tone.rs` untouched.

1. **Only the systems in view are painted and inserted** (`src/ScoreView.tsx`, `src/engraving/lazy-paint.ts`). alphaTab lays the whole score out and paints it in pieces,
   one per system; with `core.enableLazyLoading` it paints a piece only when its browser says it is on screen (one frame after the layout) and clears it again when it
   leaves. The draw now turns lazy loading on for the Parchment and vertical-screen layouts and, in the same turn as the layout (in `postRenderFinished`), paints the
   pieces that touch the score area (`visibleIndexes`, from alphaTab's public `partialLayoutFinished` geometry and `renderer.renderResult(id)`), so no frame
   shows a piece blank or old. The page layouts (which compose every piece themselves, `chunks`), the horizontal strip (see the check) and the exports (own renderers with lazy loading
   off) keep the complete render. The natural width of the screen layouts is now taken from the layout events, not the painted ones.
   Owner's largest, alternated runs: 363 and 302 ms to 201 and 189 ms (the deferral unchanged).
2. **The draw does not wait for "pending input"** (`drawFlags.deferrals` and `completeDeferrals`, both 0; was `DRAW_DEFERRALS_MAX=6` of 16 ms for every layout). See "The deferral and the key hold":
   the saving is the whole of a short key press's wait (187 to 85 ms with a 15 ms hold) and nothing with a 100 ms hold; for the layouts that still draw the whole score 6 was never better.
3. **Scale diagrams are listed without a position per beat** (`src/harmony/scale-diagram.ts`). The score view lists the score's scale diagrams after every edit and
   made an address object for each of the tens of thousands of beats to find the few that have one. Same result, objects only for the ones that do: 11 ms to 1 ms per
   edit (profile, owner's largest). Below the noise of the table.
4. **Draw flags, the draw check and the draw counts** (`src/engraving/draw-flags.ts`, `src/engraving/draw-check.ts`): `drawFlags` (`lazy`, `deferrals`, `completeDeferrals`, `ahead`, `paintOnCursor`), the
   check and the counts are reachable as `globalThis.__tabplayerDrawFlags`, `__tabplayerCheckDraw` and `__tabplayerDrawStatsLog` only in development, in tests and in the desktop test build
   (`developerHooks`, a build-time constant). **A release build has none of them**: built without `VITE_DESKTOP_TEST` and searched for the strings, the bundle holds none of "differs from its
   complete render", `__tabplayerCheckDraw`, `__tabplayerDrawFlags` or `__tabplayerDrawStats` (2437.5 kB against 2441.4 kB with them).
5. **A system that scrolls into view is painted before the frame** (`ScoreView.tsx`, a `scroll` listener on the score area; see "Scrolling").
6. **The playback cursor has its system painted first** (`screen-playback.ts`, `ScoreView.tsx`; see "Playback"), the highlight is put back after a repaint, and an emptied piece in view is painted again
   before the next frame.
7. **A viewport of systems above and below the view is painted in the background** (`drawFlags.ahead`, see "Scrolling"; pieces far from the view are emptied again so that a long scroll does not
   end with the whole score painted).

Not touched: `src/controller.ts`, `src/engine.ts`, the in-place edit path, the checkpoint and verification machinery, the undo journal, save and export gating, and the
`renderedBeats` / `renderedNotes` / `followProjection` mapping.

## Candidates that were examined and not taken, and why

* **alphaTab's partial re-render** (`RenderHints.firstChangedMasterBar`, public in 1.8.4). Read in `alphaTab.core.mjs`: `VerticalLayoutBase.doUpdateForBars` honours it
  only when lazy loading is on and only in the vertical layouts (the horizontal layout and the base class return false); it re-lays out **from the first changed system to
  the end of the score**, not that one system, so an edit near the start saves nothing and one near the end saves the layout of the systems before it. The layout proper is
  17 ms on the owner's largest score (18 ms in the final profile), so the gain is at most that; the cost it was meant to remove was the DOM, which lazy painting
  removes. It also leaves `_allMasterBarRenderers` stale (used by `resize`), keeps the old systems' paint closures, and needs the lowest changed master bar across ties,
  slides and effect marks, which the edit log does not give directly. Not worth its fragility for at most 17 ms.
* **Worker rendering** (`useWorkers`; the svg engine supports it, `RenderEngineFactory(true, ...)`): the score would have to be sent to the worker as JSON on every edit; `scoreToJson` alone is 52 ms inclusive on
  the owner's largest score (profile; the plan already pays it once per burst), more than the whole draw is now.
* **Skipping alphaTab's MIDI generation** (`loadMidiForScore`, 11 to 17 ms per edit, run because every edit is a new score object): it is not thrown away. It builds the
  tick lookup the playback cursor and the external-media player use, so the cursor would stop following. It could be deferred until playback starts (patch the instance's
  `loadMidiForScore`, run it in a timer and before `api.play()`); not done: 11 to 17 ms of 88, for a risk to the cursor.
* **Skip re-inserting systems whose SVG is unchanged** (compare the new string with the one shown, keep the DOM): exact and would make a draw cost the changed systems
  only when many are in view (a tall window, zoomed out). Needs two alphaTab-internal fields of the facade's pieces (`renderedResultId`, `resultState`). Not needed at
  the measured 88 ms; the next step if a larger window makes the visible systems the cost again.
* **Optimistic drawing of the typed number** (two-stage draw): not needed, so not built; the final result is never shown after an older one because there is only one
  draw per state.

## The equivalence check

`src/engraving/draw-check.ts`: paints every piece of the live view, renders the same score again in a renderer of its own (`rendering.ScoreRenderer`, same settings,
lazy loading off, nothing carried over from earlier renders), and compares, piece by piece, the geometry (x, y, width, height, first and last bar: the line breaks),
the SVG (normalized by the DOM), and every bounds box alphaTab hands out for hit-testing and the playback cursor (systems, master bars, bars, beats, note heads). It returns a
signature of what is drawn so a driver can see that an edit changed it.

* `tests/desktop/draw-equivalence.mjs` (run by `edit-speed.mjs` on the generated score, and on each of the owner's scores when `TP_OWNER_SCORES` names a folder that exists;
  skipped and said so otherwise). Series, each step followed by the check and required to change the drawing: a typed digit, a two-digit fret, a shorter duration, undo,
  redo, five beats deleted, five inserted, a measure appended, a measure removed, another track shown, a digit on it and its undo, fast wheel scrolling over the whole score with every presented frame sampled (no
  system in view without a drawing), and back, then the layouts (vertical screen, horizontal strip, vertical page: eight beats deleted, undo, eight inserted, which move the line breaks) and
  Parchment again. After every step it also reads the app's own draw counts (no piece in view empty; no more pieces painted than are in view plus the margin) before the check below paints
  every piece. The check reads the live view only after painting all pieces (`readLive`), so it sees the fully painted state; the counts and the sampler are what see the states in between.
* Result: all steps equal on the generated score (25 steps, line breaks moved in 5 of them) and on each of the owner's five scores (25 steps each; line breaks moved
  in 5 to 7 of them).
* **What it found.** In the horizontal strip layout a complete render and a lazily painted one differed in the **bounds of a two-digit fret's note head** (8.17 against 16.34
  px wide): that layout builds its bounds again after each piece is painted, so painting changes them. A click on the right half of such a note would have selected the beat
  and not the note. The horizontal strip therefore **stays a complete render** (`display.layout !== 'horizontalScreen'` in the lazy condition; test in
  `ScoreView.layouts.test.tsx`), and still pays the whole draw. The vertical layouts build their bounds before painting and were equal in every step.
* Unit tests: `draw-check.test.ts` (the real API in jsdom: equal after a draw and after the same score again; a note changed behind the renderer's back is reported),
  `lazy-paint.test.ts` (which pieces are in view, both axes, margin), `ScoreView.layouts.test.tsx` (lazy in Parchment and vertical screen only, the page layouts and the
  strip complete).

## Hit-testing and overlays

Bounds are built at layout, not at painting, in the vertical layouts, and the check above compares every bounds box with a complete render's after each step of the series (the horizontal strip, where this is not
so, stays a complete render). Selection, the cursor and the playback cursor are placed from the bounds, not from the painted DOM. Real clicks are exercised by `edit-speed` (a click on a beat inserted in place,
on a note typed in place), `parity-track-click`, `parity-click-seek-space`, `parity-click-seek-repeat`, `parity-click-seek-backing` and the editor drivers (see the run below), and by the click-seek and
seek-to-start steps of the playback probe.

What the first version of this note said about the playback highlight ("highlighted once its system is painted, the scroll that follows the cursor paints it") was **not true**: the scroll that follows the cursor
is made in the same frame and its `scroll` event comes one frame later, so the first beat of a new system stayed unhighlighted for its whole length. It is fixed (see "Playback"); the claim is replaced by the probe.

## Scrolling

With alphaTab's own lazy loading a system that scrolls into view is painted when its browser reports it, one frame after it appeared. Measured on the owner's largest score (wheel
scrolling 300 px every 33 ms for 2 s, a frame counted when a system in view had no drawing): the complete render 0 blank frames of 558; the lazy render with alphaTab's own
timing 41 of 553. The score area therefore also listens for `scroll` (it fires before the frame is drawn) and paints, synchronously, the in-view systems that have nothing in them. Result: 0 blank frames
of 514. This probe is now committed (`tests/desktop/draw-equivalence.mjs`, fast wheel scrolling over the whole score on the generated score and on each of the owner's scores, asserted 0).

**What that does not show.** The number was taken on the main thread. Wheel scrolling is done by the compositor, which can present a new scroll position before the page's `scroll` event runs when the main
thread is busy, so a person can still see a blank system that the sampler cannot. To cover it, systems within one viewport above and below the view are painted in the background after a draw and after
a scroll (`drawFlags.ahead`, one piece per task, only while no key or click is waiting, nearest first, starting 400 ms after the last draw or scroll). alphaTab clears a piece it has not seen in view only after
it has been in view and left, so these stay; the ones more than two margins away are emptied again once there is nothing left to paint. **Its cost per edit** (alternated with the margin off, owner's largest,
key held 100 ms). With the background painting starting 150 ms after the last draw (build before the last commit): first change 83 ms (p90 95) without, 91 ms (p90 163, worst 164) with, and the longest
wait of a key in a burst 72 ms without, 110 ms with: a few ms at the median and a worse tail. It now starts 400 ms after the last draw or scroll; on the final build (machine busy): first change **146 ms
(p90 171, worst 237) without, 149 ms (p90 158, worst 194) with**, longest key wait in a burst 165 ms without, 123 ms with, so no cost shows any more. What it buys I could not measure (the compositor case
is not observable from the page); the scroll painter alone gave 0 blank frames in the sampler. It is a flag (`drawFlags.ahead`, 0 switches it off).

**The draw counts, not timing** (`recordDrawStats`, development hooks): at the end of each draw and each scroll the app counts the pieces in view that are empty and the pieces painted. `draw-equivalence.mjs`
asserts after every step that no piece in view was ever empty and that no more pieces were painted than are in view plus the margin (one viewport right after a draw, two after a scroll or the background
painting), without waiting for alphaTab. This replaces the check that waited 500 ms and a quiet period (when alphaTab would have painted anyway).

## alphaTab's placeholders when lazy loading is switched off

Read in `alphaTab.core.mjs` (`BrowserUiFacade`): when a draw has fewer pieces than the one before and lazy loading is off, the surplus placeholders are removed without `unobserve` (the call is guarded by
`enableLazyLoading`), and `destroy` empties the container but never disconnects its `IntersectionObserver`. The id lookups are cleared at every render (`preRender`), so they do not grow. Through public API
nothing bounds it. Measured (`leak.mjs`): 24 changes of layout between Parchment (50 pieces) and the vertical page on the owner's largest score, heap after a forced collection 49.8 MB after 6 warm-up changes and
50.8 MB after 24 more (+1.0 MB), the page's DOM 50 pieces and 7,186 nodes at the end, not growing: Chromium does not keep observed elements alive, so the surplus is collected. Recorded, not worked around.

## Verification run

Every command ran in this worktree by explicit path, on the tree merged with `develop` (13922ef, the palm-mute audio merge, Rust only). The final build is the last `scripts/build-desktop-test.ps1`.
Port 9223 and the app identifier are shared with other agents' apps: **a launch that collides with another worktree's test app exits at once** (the second instance hands over), which shows as "Cannot find a process"
or "the page has been closed" in a driver. Such a start was run again (the table says "attempt n"); a driver that ran and failed was not.

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test -- --testTimeout=60000` | first run on this tree: 14 failed, all timeouts at 30 or 60 s (`App.test.tsx` 9, `pdf.test.ts`, `clipboard-paste`, `measures`, `saved-tunings`, `gp-fermata-hold`), while other agents' own suites and test apps were running on the machine; run again on the final tree: Node resource tests pass, Vitest **424 files passed, 5 skipped; 7386 passed, 8 skipped, 0 failed**, exit 0 (`plan.performance.test.ts.snap` restored with `git checkout --`) |
| Vitest added or changed | `lazy-paint.test.ts`, `draw-check.test.ts`, `screen-playback.test.ts` (the system is painted before the highlight; the highlight is put back), `ScoreView.layouts.test.tsx` (lazy in Parchment and vertical screen only, the cursor paints the systems around its system, a system emptied late is painted again, the deferral flags for each layout), the four mocks of the alphaTab renderer in `ScoreView*.test.tsx` |
| `node tests/desktop/edit-speed.mjs` (with `TP_OWNER_SCORES`) | exit 0 (attempt 1) on the final build, with the app's draw counts asserted at each of the 25 steps of the series on the generated score and on each of the owner's five scores (no piece in view ever empty; no more pieces painted than are in view plus the margin): all equal, line breaks moved in 5 to 7 steps per score. Numbers, machine busy (other agents' suites running): key to first change 145 ms (budget 250), key to editor free 163 ms (worst 305, budget 450), native call 22 ms, undo 139 ms, cursor move 18 ms, **two-digit join drawn once, 694 ms (budget 800: the tight one)**, idle 0.3 %, heap growth over 240 edits -38.6 MB, real clicks on an inserted beat and a typed note, 3 edits compared with a rebuild (no mismatch). Failures on the way, all mine: the driver counted the background painting as draws (editor free 706 ms), and asserted the pieces-painted bound on a count taken before the background painting had emptied the pieces left behind; both fixed in the driver (draws are now the app's own draw counts). |
| `node tests/desktop/playback-draw.mjs` (new; with the owner's scores) | exit 0 on the final build: generated score and the five owner scores, each with 3 line changes, a click-seek, a seek to the start and 2 loop wraps: **0 blank frames and 0 frames without a highlighted beat** in all of them; the same steps on the complete render as a control also 0 and 0. With `paintOnCursor:false` and no background painting it sees 1 blank frame (generated score), which is how I know it can see the fault. (Two earlier runs of the build before the cursor painted its neighbourhood failed on a single blank frame each on owner scores 1 and 4, which led to that fix.) |
| `editor`, `parity-entry`, `parity-fret-typing` | exit 0 (first attempts hit launch collisions; passed at attempts 1, 2 and 5 of the rerun) |
| `parity-track-click`, `parity-click-seek-repeat`, `parity-click-seek-backing`, `loop-through-edit`, `parity-clipboard`, `exports`, `parity-document-tabs` | exit 0 each (first attempt) |
| `parity-click-seek-space`, `native-audio`, `parity-engraving` | first attempt hit a launch collision; exit 0 on the rerun (attempt 1) |
| `display-modes --only=resize` (the section that holds all the flagged checks; the full driver takes about 25 minutes) | **387 checks, 18 flagged, errors 0, with the draw flags set to develop's behaviour** (`lazy:false`, deferrals 6, no background painting, no cursor painting; `flags-wrapper.mjs`) **and 387 checks, 18 flagged, errors 0 as shipped; the 18 are the same checks**, all "tab digits stay at least 6px tall" at fit page in the three page layouts (3.7 to 6.5 px digits at 30 to 43 % zoom), the finding the 2026-11-08 note lists. exit 1 by design (flagged findings). |
| Rust | not touched by this branch (the merge brought `develop`'s palm-mute changes, which were built into the app but not otherwise re-verified here) |

The edit-speed budget that is tightest is **`joinMs` (800 ms): a two-digit fret typed quickly, second key to drawn**. It measured 323 to 467 ms when the machine was calm and 755 to 856 ms when other agents were running their suites
(it failed once, at 856); the others have a factor of 2 or more (`firstVisibleMedianMs` 250 against 88 to 181, `editFreeMedianMs` 450 against 114 to 199).

Measurement scripts (not in the repository, they read the owner's scores): CPU profiles with the Chromium profiler over CDP symbolized with the source map of an identical build, Chromium traces
(`browser.startTracing`), the interleaved A/B, the `isInputPending` log, the leak and the display-modes flag wrapper, kept in the session's scratch folder.


## What remains slow, and the next step

1. **The rest of the 88 ms is not the score drawing.** Of a typed digit's 111 ms to the first commit (trace, one edit, tracing on): 15 to 20 ms in the key handler, the app's
   own React render around the edit about 25 ms (`App`, panels, memos that walk the score), the draw task 75 ms of which alphaTab 35 (layout 18, MIDI 11, painting and inserting
   the systems in view 6), and the browser's style, layout and paint of the visible systems about 30. Next steps by size: the React re-render of the whole app per edit (the busy
   flag flips twice); alphaTab's MIDI generation per edit (deferral above); then the layout proper (hint above).
2. **The plan.** After the draw, `scoreToJson` of the whole score runs as one main-thread task of 50 to 60 ms (it has to be, it is a single JSON conversion) and a key that
   arrives then waits for it: I take that to be the 53 ms of the next-key row (inferred from the trace, where a 60 ms timer task follows the draw), and it is now the longest task of the edit path. Converting only the edited track, or moving the conversion
   off the main thread, is the next step for "next key accepted". Play is ready again 1.2 to 1.8 s after the edit on this loaded machine.
3. **Large windows and zoomed-out views** show more systems, and the draw then costs those. The skip-unchanged-SVG idea above removes that cost.
4. **The horizontal strip** is still a complete render (see the check).
5. **Scrolling**: the systems in view are painted by our own scroll listener (above); alphaTab still clears the ones that leave, so scrolling back repaints them (a few ms each).

## Limits

* One Windows machine under load from other agents, hidden-launched test app at 1440 x 900, dpr 1.5; medians of 16 edits, p90 and worst given; run-to-run differences of tens of
  percent are normal here (the "before" of the first row measured 262 to 363 ms in different runs). macOS and Linux were not measured.
* The owner's scores are private and read from a folder outside the repository; nothing from them (titles, track names, content) is in the repository, this note or the logs; only counts.
* The equivalence check compares alphaTab's output to alphaTab's output (same engine, a fresh renderer); it proves the incremental path adds no difference, not that alphaTab is right.
  It is run over a series of edits, not exhaustively. The code reaches alphaTab through public API (`partialLayoutFinished`, `renderResult`, `enableLazyLoading`,
  `uiFacade.getOffset`); the check, the driver and the scroll painter also read the facade's placeholder `div`s (the children of the canvas element, one per piece in layout order), which are
  internal: if alphaTab changes them, the check reports that it cannot compare and the scroll painter paints nothing (alphaTab's own lazy painting then applies, with its
  one-frame lag).
* The blank-frame counts (scroll and playback) are the main thread's state after each frame, from a sampler in the page; the compositor can present a scroll position before the page's `scroll` event runs, which the
  sampler cannot see (the background painting of a viewport around the view is there for that case, and its benefit is not measured).
* Equivalence is checked on the generated score and the owner's five; the playback probe on the same six, at one tempo each, with one click-seek, one seek to the start and one loop each.
* Lazy loading is alphaTab's default and is how it is used elsewhere; the scrolling measure above was made at 2 s of fast wheel scrolling on this machine, not on a slower one.
