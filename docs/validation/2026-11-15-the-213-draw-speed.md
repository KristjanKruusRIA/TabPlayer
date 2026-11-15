# THE-213: drawing a note edit without drawing the whole score

Date: 2026-11-15. Branch `agy/the-213-draw-speed`, cut from `develop` (0b8622d). The previous slice (`2026-11-14-the-213-edit-speed.md`) made the edit itself cheap
(native call about 25 ms, edits in place, undo and redo in place, playback prepared after typing stops) and left the draw: on the owner's largest score a typed
note took more than 300 ms to appear, because alphaTab laid out, painted and inserted every system of the score for every edit.

## Result in one table

Real app (`scripts/build-desktop-test.ps1` build of this branch, WebView2, 1440 x 900 window at 150 % scaling, CDP on 9223), typed digit on a note, **medians
of 16 edits**, Windows 11, one machine with other agents' apps and test runs on it. "Before" and "now" are the same build: the old behaviour is switched
back on with `globalThis.__tabplayerDrawFlags = {lazy:false, deferrals:6}` (development hooks only; see "What changed"), one run after the other, not on two builds.
These rows are from the build before the scroll listener was added (a calm period of the machine); the final build is re-measured below.

| | owner's largest score (141 bars, 6 tracks) before | now | generated 6 x 200 score before | now |
|---|---|---|---|---|
| key to the typed note first drawn (first change of the score's SVG) | 327 ms (p90 449, worst 623) | **88 ms** (p90 111, worst 201) | 278 ms (p90 344, worst 631) | **93 ms** (p90 112, worst 261) |
| key to the whole score drawn (same event: one draw) | 327 ms | 88 ms | 278 ms | 93 ms |
| key to the native edit answered | 13 ms | 12 ms | 15 ms | 15 ms |
| a key typed 35 ms after the digit: wait before its handler ran (median, p90) | 60 ms (142) | 53 ms (65) | 63 ms (77) | 72 ms (81) |
| key to the busy flag dropping ("editor free") | 87 ms | 107 ms | 81 ms | 109 ms |
| arrow-key cursor move to the status bar | 12 ms | 10 ms | 11 ms | 12 ms |
| burst of 8 digit + Enter pairs 120 ms apart: edits applied | 8 of 8 | 8 of 8 | 8 of 8 | 8 of 8 |
| ... score settled after the last key | 1096 ms | 74 ms | 797 ms | 23 ms |
| ... longest wait of any key of the burst | 222 ms | 91 ms | 171 ms | 64 ms |
| two-digit fret (1, then 2 after 100 ms), second key to drawn: median of 10 joins, two runs | | | 378 and 467 ms | 323 and 425 ms |
| ... first key to the first digit visible | | | 584 and 680 ms (held back for the join) | 107 and 115 ms |
| key to Play enabled again (native playback prepared) | 1464 ms | 1250 ms | 1862 ms | 1757 ms |

The same comparison on the **final build**, edits alternating between the old draw and the new one in one session (20 each, so both see the same machine load), key to first
change of the drawing: owner's largest 320 ms (p90 424, worst 533) to **112 ms** (p90 170, worst 260); generated score 331 ms (p90 420, worst 587) to **118 ms** (p90 178, worst 197).
Two runs of the final build on its own gave 181 ms (owner) and 100 ms (generated), the first while the machine was visibly busy (native call 21 ms instead of 12, Play
ready after 2.2 s instead of 1.2 s); `edit-speed.mjs` on the same build measured 175 ms on the generated score in a busy period and 98 ms in a calmer one. The median stayed
below 200 ms in every run I made after the change, between 88 and 181 ms; before it, 262 to 363 ms in every run.

The hard requirement (a typed note on screen and the next key accepted, median under 200 ms on the owner's largest score in the real app) is **met**: 88 to 112 ms to the
note (181 ms in the one busy run), and 53 ms (p90 65) for a key typed meanwhile to be taken up. The aim of about 100 ms is met at the median when the machine is not busy and
missed at the tail (worst of 16: 201 ms; the p90 is 111 to 170 ms).

Two caveats that matter for reading the table.

* "Editor free" went **up** (87 to 107 ms), and that is not a loss: the busy flag used to drop before the draw (the draw then ran for 200 to 300 ms and a key typed in
  the meantime waited for it on the main thread); now the draw is over by 90 ms and the flag drops after it. What a key typed meanwhile waits is the row above it.
* The previous slice measured 675 ms on this score and 200 to 250 ms on the generated one (a ratio of about 3). **That ratio was not reproduced**: here the same
  edit costs 302 to 363 ms and 262 to 331 ms (about 1.1 to 1.3). The earlier run was made while other work loaded the machine; I did not find the rest of the difference.
  The conclusions below are about this run's phases, not about that number.

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
   shows a piece blank or old; alphaTab paints the rest as they scroll into view. The page layouts (which compose every piece themselves, `chunks`) and the exports (own
   renderers with lazy loading off) keep the complete render. The natural width of the screen layouts is now taken from the layout events, not the painted ones.
   Owner's largest: 363 and 302 ms to 201 and 189 ms (two alternating rounds, deferral unchanged).
2. **The draw no longer gives way to "waiting input"** (`drawFlags.deferrals`, was `DRAW_DEFERRALS_MAX=6` of 16 ms). A draw of the whole score took 200 ms or more and
   could not be interrupted, so it let a waiting key go first, up to six frames. `isInputPending` also counts the **key-up of the key just typed**: every draw waited
   about 100 ms for nothing. Found by measuring (first visible 189 ms against a draw that took 40). With the draw at a few tens of ms the deferral has no use.
   Owner's largest: 201 and 189 ms to 91 and 90 ms. A burst of 8 keys at 120 ms still lands as 8 edits and 8 draws (nothing is dropped, the newest state is the one
   drawn last); key-up waits are gone.
3. **Scale diagrams are listed without a position per beat** (`src/harmony/scale-diagram.ts`). The score view lists the score's scale diagrams after every edit and
   made an address object for each of the tens of thousands of beats to find the few that have one. Same result, objects only for the ones that do: 11 ms to 1 ms per
   edit (profile, owner's largest). Below the noise of the table.
4. **Draw flags and the draw check** (`src/engraving/draw-flags.ts`, `src/engraving/draw-check.ts`): `drawFlags` has `lazy` and `deferrals`, both at the new default in
   every build; in development, in tests and in the desktop test build they are reachable as `globalThis.__tabplayerDrawFlags` so a driver can measure the old
   behaviour on the same build (that is where the table's "before" comes from). `globalThis.__tabplayerCheckDraw()` (same builds only) is the equivalence check below.

5. **A system that scrolls into view is painted before the frame** (`ScoreView.tsx`, a `scroll` listener on the score area; see "Scrolling"): 41 blank frames of 553 to 0 of 514 in a fast-wheel
   scroll on the owner's largest score.

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
  redo, five beats deleted, five inserted, a measure appended, a measure removed, another track shown, a digit on it and its undo, scrolling to the end (every system in view is
  painted, none blank) and back, then the layouts (vertical screen, horizontal strip, vertical page: eight beats deleted, undo, eight inserted, which move the line breaks) and
  Parchment again.
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

Unchanged by construction (bounds are built at layout, and the check above compares all of them to a complete render's), and exercised by the real clicks of `edit-speed`
(a click on a beat inserted in place, on a note typed in place), `parity-track-click`, `parity-click-seek-space`, `parity-click-seek-repeat` and the editor drivers (see the
run below). Selection, the cursor and the playback cursor are placed from the bounds, not from the painted DOM.

One behaviour is alphaTab's, not ours: the playback highlight (`at-highlight`) is applied to painted elements, so a beat in a system that is not painted yet is highlighted
once its system is painted (the scroll that follows the cursor paints it).

## Scrolling

With alphaTab's own lazy loading a system that scrolls into view is painted when its browser reports it, one frame after it appeared. Measured on the owner's largest score (wheel
scrolling 300 px every 33 ms for 2 s, a frame counted when a system in view had no drawing): the complete render 0 blank frames of 558; the lazy render with alphaTab's own
timing 41 of 553 (about one frame each time a system entered, never two in a row). That is not acceptable for a comfortable UI, so the score area also listens for `scroll` (it fires
before the frame is drawn) and paints, synchronously, the in-view systems that have nothing in them (`paintVisible(view, true)`; a piece alphaTab has cleared or not painted yet).
Result: 0 blank frames of 514. A scroll costs a system's paint (a few ms) only when one enters the view.

## Verification run

Every command ran in this worktree by explicit path. The final build is the last `scripts/build-desktop-test.ps1`; the one commit after it adds an import of the tremolo guard to
`draw-check.ts` (a module `ScoreView` already loads), so no rebuild followed it and the bundle behaves the same.

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test -- --testTimeout=60000` | first run: 7373 passed, 1 failed (`tremolo-guard.test.ts`: every module that renders must import the guard, and `draw-check.ts` did not); fixed; second run: Node resource tests 66 passed, 2 skipped, Vitest 424 files passed, 5 skipped, **7374 passed, 8 skipped, 0 failed** |
| new Vitest files | `lazy-paint.test.ts` (5), `draw-check.test.ts` (2); additions to `ScoreView.layouts.test.tsx` (lazy in Parchment and vertical screen, complete in the page layouts and the horizontal strip) and the four mocks of the alphaTab renderer in `ScoreView*.test.tsx` |
| `node tests/desktop/edit-speed.mjs` (with `TP_OWNER_SCORES` set) | exit 0 on the final build and on the build before it (generated score, 16-edit medians as the driver takes them). **One earlier run failed** its join budget (second digit to drawn 856 ms, budget 800) while the machine was busy; the next run measured 336 ms, and the separate join measurement 323 to 425 ms. Numbers: key to first change 98 ms on the build before the last and 175 ms on the final one (busy machine, budget 250), key to editor free 114 and 199 ms, undo 72 and 152 ms, cursor 15 and 21 ms, idle 0.9 and 0.3 %, heap growth over 240 edits negative, real clicks on an inserted beat and a typed note, 3 edits compared with a rebuild (no mismatch), **draw equivalence on the generated score: 25 steps equal, line breaks moved in 5; on each of the owner's five scores: 25 steps equal, line breaks moved in 5 to 7** |
| `editor`, `parity-entry`, `parity-fret-typing`, `parity-track-click`, `parity-click-seek-space`, `parity-click-seek-repeat`, `parity-clipboard`, `loop-through-edit` | exit 0 each, on the final build |
| `parity-engraving`, `exports`, `parity-document-tabs` | exit 0 each, on the final build (`parity-document-tabs` needs `src-tauri/target/debug/examples/capture_loopback.exe`, built here with `cargo build --locked --example capture_loopback`; its audio and visual captures completed) |
| `display-modes` | exit 1 on the final build, as a flagged-findings run: 679 checks, 18 flagged, all of one kind, "tab digits stay at least 6px tall" at fit page in the three **page** layouts (digits of 3.7 to 6.5 px at 30 to 43 % zoom). The page layouts keep the complete render and none of this branch's code runs for them; the 2026-11-08 display-modes note lists the same finding (fit page under 6 px). No flagged check in Parchment, vertical screen or horizontal screen. An earlier run on the build before the scroll listener flagged the same 18 plus "native window size never changed" (1441 to 1440 px), which did not recur. I did not run this driver on a build of `develop`, so "same as before" rests on that note and on the code path, not on a measured A/B |
| Rust | not touched (`git diff 0b8622d -- src-tauri` is empty), so no `cargo fmt` or `cargo test` was needed or run |

Measurement scripts (not in the repository, they read the owner's scores): CPU profiles with the Chromium profiler over CDP symbolized with the source map of an identical build,
Chromium traces (`browser.startTracing`), and the interleaved A/B, kept in the session's scratch folder.


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
* Lazy loading is alphaTab's default and is how it is used elsewhere; the scrolling measure above was made at 2 s of fast wheel scrolling on this machine, not on a slower one.
