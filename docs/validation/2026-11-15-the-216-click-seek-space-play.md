# THE-216: click a beat to move playback there, Space to play and pause (2026-11-15)

Branch `agy/the-213-entry-mix` (on top of 9c4c47b), uncommitted. Real-app numbers are from the desktop test build with real CDP mouse and key events on a small score
(3 tracks, 8 bars), a large one (6 tracks, 200 bars) and a small score with a repeat and a first and second ending (1 track, 6 bars: bars 1 to 4 repeat, bar 4 is the first
ending, bar 5 the second).

## What the app did before this work (develop at 9c4c47b)

A click on a beat moved the edit cursor but not playback (tick 0 while stopped; paused and playing positions ignored it). Space started from the cursor when stopped and
paused when playing, but only from the score or a few places: it skipped buttons, summaries and links, the dock row swallowed every key, a Mute click left focus on `body`
(keys there never reached the app shell), and a checkbox counted as a text field.

## Final behaviour

### Clicking a beat

A plain single left click on a beat in the score also makes that beat the playback position, while stopped, paused or playing. It is navigation: nothing is recorded, the
document is not dirty, and typing is never held up.

- **What does not seek.** A click with Shift, Ctrl, Cmd or Alt, a right click, the second and third press of a double or triple click (its first press, if the two came more than
  a moment apart, has already moved playback), and any click while MIDI capture runs. They only move the cursor.
- **Practice state is kept.** The seek is the new native command `SeekWithin`, which moves the playhead and leaves the played selection, a count-in and the pass counts (loop
  passes and the speed trainer's progress) alone. A running loop or played selection: a click inside seeks within it, a click outside only moves the cursor. During a count-in
  (running or paused) a click only moves the cursor.
- **Native guards.** `SeekWithin` is refused by native, with the transport snapshot unchanged, when a count-in is running or paused, and when the tick is outside the loop or the
  played selection (`tick < start || tick >= end`), so a click that races a status the front end has not seen yet cannot wrap the loop, add a pass, step the trainer, start a
  between-loops count-in, play music outside the passage or end a played selection at once. The front end takes such a refusal quietly: the cursor has moved, there is no error banner.
- **Repeated bars.** The occurrence a click means is chosen at once: among the occurrences inside a running loop or played selection if there are any, else the first when stopped
  or paused and the one nearest the playhead while playing. Play and Space then start from that occurrence (the choice menu still offers the others), also when the same beat is
  clicked again for another occurrence.
- **Bursts.** Clicks within 200 ms send one seek, the last.
- **Not ready.** A click that finds no plan for the current document waits for it for up to 5 s, and is dropped if the cursor moved or the document changed.
- A press that becomes a drag-selection seeks to where the press began.

### Space

Space plays from the cursor when stopped and pauses where it is when playing (Stop returns to the start; Space with focus on Stop still plays or pauses, Enter stops).
Key repeat toggles once. Shift+Space is Space. Ctrl+Space plays from the start of the cursor's bar (while playing it jumps there and goes on). Cmd+Space is accepted the same way as
Ctrl+Space (the code takes either); on macOS the system keeps Ctrl+Space (input source) and Cmd+Space (Spotlight) for itself, so there the key works only where the system lets it
through, and plain Space is the binding to rely on. Alt+Space is not bound.

**Where Space is play and pause:** anywhere the window has focus, including a plain button (Enter presses it; Space no longer does), a slider, a tab (Enter and the arrow keys operate
tabs), a track name, an open playback-options panel, the score, the page itself (focus that fell to `body`), and a control that is busy or unavailable (the guard holds Space back from the
control, so nothing the control or its neighbours do on Space runs, and hands it to the app).

**Where Space keeps its own meaning** (a keyboard user can operate every control): a text field, textarea, select or contenteditable; a checkbox, radio, color or file input and the
checkbox, switch, radio, menu item and option roles (a `<button role="radio">` as in a segmented control); a `<summary>` (a menu or panel heading); a menu, list box or modal dialog that is open.

**A Space that finds playback not ready** (the plan is rebuilding, or the app is busy) plays once it is, says so in the status line, and is cancelled by a second Space, Escape (wherever
focus is, including the menu bar and the dock rows), Ctrl or Cmd+Space, a click on Stop, any change of playback (started, paused or stopped by any control), a cursor change, a document change
or reload, a dialog opening, a focus move into a text field or menu, and after 5 s. A Space refused for another reason (a bar played more than once with no occurrence chosen) says why instead.

**Dock rows** keep their keys to themselves (Escape, Ctrl+A/C/V, Shift+L, brackets do not reach the score) except Space.

## Verification

- `npm run typecheck`, `cargo fmt --all -- --check` and `cargo test --locked --workspace` pass; the full `npm test -- --testTimeout=60000` passes (counts at the end).
- Rust: `seek_within_keeps_the_passage_and_its_passes_and_is_refused_where_it_would_break_them` in `src-tauri/tests/audio_selection_playback.rs` (a loop with at least two completed
  passes: refused before the start, at the end and past it with the snapshot unchanged; accepted inside with phase, playing, loop and passes kept; the same paused; a played selection;
  a running and a paused count-in), `SeekWithin` added to `range_transition_policy` and to the refusal list, and a unit test in `device.rs`. The guards were reproduced first: with them
  removed the test fails at the first outside-the-loop seek.
- Vitest: `NativePlaybackController.test.ts` (seekWithin, quiet refusal, occurrences, loop and range choice), `Transport.test.tsx` (the choice follows a second click on the same beat),
  `useBusyGuard.test.tsx` (a refused Space reaches only the app; a busy region activates no custom `role=button`), `App.test.tsx` "click to seek and Space to play", `TrackPanel.dock.test.tsx`.
- Desktop, real mouse and keys, on the rebuilt app: see the results at the end.

## Files in files another agent is changing

- `src/audio/NativePlaybackController.ts`: `seekToCursor`, `chooseCursorOccurrence`, `cursorSeekChoice` and the field `cursorSeek`, all next to `seekToMeasure`; nothing in the plan debounce.
- `src/App.tsx`: the click-seek block above `selectTrack`; the Space block above `selectionKeys`; one token on the `ScoreView` line (`onSelect={selectByClick}`); `onKeyUp`/`onClickCapture`
  on the shell; the import line. No document-loading code; `engine.ts`, `controller.ts` and `ScoreView.tsx` are untouched.
- `src-tauri/src/audio/device.rs`: the `SeekWithin` variant, its validation, its handler and a unit test.

## Limits

- Guitar Pro's own stop behaviour was not checked here; pause-in-place is the existing transport's behaviour.
- The loop test's pass counter stayed 0 in the real run (no pass completed in the time the clicks took); the trainer run shows a kept count above zero (1 before and after).
- The More playback panel's Play selection and Loop selection buttons are laid out off screen in the test window, so the drivers press them through the DOM; the drag-selection, the
  clicks and the keys are real. Practice settings are set through the app's own panel.
- `BlockStage`, `DockMasterControls` and the master slider still pass `disabled` for busy and were not migrated.
- A drag that goes backwards seeks to its press, not to the start of the selection.
- Test-app runs collided with other agents' apps on port 9223 many times (the app is single instance, so a second launch exits); they were retried until they went through.

## Final results

- `npm run typecheck`, `cargo fmt --all -- --check`, `cargo test --locked --workspace` (CARGO_DONE=0): pass. Full `npm test -- --testTimeout=60000`: 414 files passed, 4 skipped; 7296 tests passed, 8 skipped, 0 failed.
- Desktop, final app build, real mouse and keys, all pass: `parity-click-seek-repeat.mjs` (new; a score with a repeat and endings), `parity-click-seek-space.mjs` (small, large; now also Space on the unavailable
  First bar button that holds focus), `parity-click-seek-backing.mjs` (small, large), `native-audio.mjs`, `loop-through-edit.mjs`, `editor.mjs`, `parity-entry.mjs`, `parity-fret-typing.mjs`
  (small, large), `parity-track-click.mjs` (small, large), `parity-mix-drag.mjs` (small, large).
- Repeat score, measured: a click on a beat in bar 2 while stopped gave tick 4800 and Space played from it (4838); playing in the second pass (tick 15974) a click on the same beat moved playback
  to tick 21657, in the second pass; with a loop on the second pass (ticks 19200 to 26400), a click while stopped chose the occurrence inside the loop, and a click inside it while playing kept the
  loop and the playhead inside it (tick 22598).
- The click-coalescing delay is 200 ms (it was 120 ms): at 120 ms a double click on the 200-bar score could send the first press's seek before the second press arrived.
