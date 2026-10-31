# GP8 parity D06: bar widths in Design mode

Date: 2026-10-31. Scope: bar widths only. Beat placement is not built (see Limits). Partial: the on-screen drag has not been exercised in the real desktop app.

## Behavior

- **What alphaTab 1.8.4 offers.** `MasterBar.displayScale` and `Bar.displayScale` are relative weights: in the `UseModelLayout` and parchment layouts a system's width, after the fixed clef, key and time-signature overhead, is shared between its bars in proportion to these weights (unset is 1). `displayWidth` is an absolute width used only by the deprecated horizontal layout; the page layout ignores it. The `Automatic` systems layout, which the app uses for the vertical screen layout, ignores `displayScale`. There is no per-beat spacing property in the model.
- **Model.** `engraving.barWidths` is an optional list of `{bar, scale}` (bar 0-based, scale 0.25 to 4). It is left out when empty, so documents and edit logs written before this change are unchanged. Entries run in bar order, each bar once, and a weight of 1 is never stored (the default is the absence of an entry). At most 10,000 entries and bar 0 to 99,999. TypeScript and Rust enforce the same rules; both refuse anything else.
- **Edit.** A width is saved by an ordinary `setEngraving` edit, so it is one undo step and replays with the log. A drag records one edit, at the mouse release. A key press is one edit. A value equal to the current one records nothing; Escape abandons a drag.
- **Control.** `Design: bar widths` panel with a Design mode switch and `Restore default widths` (one edit that clears every width and keeps the other engraving choices). In Design mode each bar's right edge carries a handle (`role="slider"`, 25% to 400% of the default). Drag it, or focus it and press Left or Right (Shift for larger steps), Home or Delete for the default width. Busy or locked documents refuse the change through `busyGuard`; the handle and the button keep focus.
- **Rendering.** The weights are written onto the rendered copy only (`projectEngraving`), for the master bar and every staff's bar. Screen, page layouts and PDF export all read that copy, so PDF output honours the widths. The source score, playback and MIDI never see them.
- **Neighbours.** A bar's width is a share of its system, so widening one bar narrows the others in that system. The drag converts pixels to a weight by ratio; the fixed overhead is not known, so the landing width is an estimate that the next layout corrects.
- **Other panels.** The Engraving form keeps the applied widths when it applies or resets. A saved style cannot hold widths (rejected on both sides) and applying a style keeps the document's widths.
- **Layouts.** Handles show in the continuous and page layouts. In the vertical and horizontal screen layouts they are hidden and the panel says why.
- **Guitar Pro export: not carried.** alphaTab's GPIF writer does not write `displayScale` or `displayWidth`, so a `.gp` export does not hold these widths. Widths read from an imported Guitar Pro file are the starting point and are replaced by an edit for the bars that have one.

## Evidence

Run in this worktree (branch `worktree-agent-af74aa6a48b893cbc`):

- `npx tsc --noEmit -p .`: clean.
- `src/engraving/bar-widths.test.ts` (7): bounds and malformed shapes refused; one edit per width, restoring a bar drops it, same value returns the same object; a rendered copy carries the weights while the source does not change; MIDI bytes of source and rendered copy identical; replay of an old log with no field, undo, redo, save and reopen; refused values in a command and in a saved log; a width for a removed bar is ignored; styles hold no widths.
- `src/engraving/bar-widths.render.test.ts` (1): with the real SVG renderer a bar with weight 3 is wider than at default, and PDF pages differ with and without the width.
- `src/ScoreView.bar-design.test.tsx` (5): handles per bar, hidden outside design mode and in screen layouts; keyboard steps and limits; one edit per drag, none for Escape, an empty drag or a right click; busy refuses without `disabled`.
- `src/engraving/BarWidthsPanel.test.tsx` (4): restore is one edit, keeps other choices, records nothing at defaults, keeps focus while busy.
- Existing `src/engraving`, `src/ScoreView*`, `src/App.test.tsx`, `src/engine.test.ts`: 491 and 53 tests pass.
- `cargo test --locked --no-fail-fast`: all pass except `a_page_search_over_fifty_thousand_rows_stays_fast` (load-sensitive, known). New: `engraving_bar_widths_are_optional_ordered_bounded_and_round_trip_only_when_set` and `engraving_bar_widths_survive_history_undo_redo_save_and_reopen_beside_an_old_log`, plus a saved-style case. `rustfmt --edition 2024 --check` clean on the touched files.
- Full `vitest run` also shows 26 failures in `compatibility`, `gp`, `musicxml`, `midi` and `plan` tests that read Guitar Pro fixtures from `.analysis/compatibility`, which this worktree does not hold; they do not touch engraving and were not changed.

## Review (Pending)

No independent review yet. A fresh-context adversarial read of the validation in `engraving.rs` / `bar-widths.ts`, the handle input handling in `ScoreView.tsx`, and the style-library change is outstanding.

## Limits

- **Beat placement is not built.** alphaTab positions beats from the music's durations; there is no property to move a beat horizontally, so nothing was added. Bar width is the only layout control.
- **Widths follow the bar number, not the bar's contents.** Inserting or removing measures does not move stored widths; widths past the end of the score are ignored.
- **Estimate while dragging.** The guide line shows the pointer, not the exact result.
- **Screen layouts.** Vertical and horizontal screen layouts ignore widths.
- **Not exercised in the desktop app.** Handle placement on physical page layouts (which map through page pagination) and the feel of the drag were not run in a real window; jsdom tests mock the renderer's bounds.
- **No Guitar Pro export of widths** (above). The `.tabplayer` project and PDF carry them.
