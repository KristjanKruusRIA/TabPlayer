# THE-56: desktop acceptance of the screen display modes and fit zoom (D01, D02)

2026-11-08. Branch `verify/the-56-display-modes`, from develop `84bb651`. Windows 11, WebView2, the `desktop-test` build of this branch (`scripts/build-desktop-test.ps1`), driven by `tests/desktop/display-modes.mjs`.

**Result: partial.** The six screen modes, fixed zoom, fit width and fit page work in the real app: fonts load, a click on a drawn tab digit selects that beat, the wheel and the scrollbar scroll, the playback cursor is drawn, moves and stays inside the score area, and each document keeps its own mode and zoom across tab switches, a page reload and an app restart. The run found and fixed two defects (the unrounded "Actual zoom" and page layouts that fell back to a continuous view on a crowded forced-system score). It also found three issues that are not fixed here (see Findings). D01 and D02 stay partial: the evidence is one Windows machine, one native window size, one Library score and one built score, and no side-by-side run against Guitar Pro 8.

## Method

- `tests/desktop/display-modes.mjs` launches the test app, opens the bundled CC0 Library example `example-windowline` (8 bars, 3 tracks) and a second score the driver builds itself with alphaTab (`tests/desktop/display-modes-fixture.mjs`: 32 bars of eighth notes, a six-string guitar with one to two digit frets, systems forced to eight bars each). No private score is used. The fret of every built note is known, so a click can be checked against what it must select.
- Input is real: `page.mouse` clicks, wheel and drags, `page.keyboard` typing. The Display mode list is changed with the arrow keys, Zoom (%) is typed, Fit width, Fit page, Play and Stop are clicked. The only calls that are not input are `workspace_snapshot`, `audio_status` and `workspace_add` (to open the second score, as `parity-document-tabs` does).
- Per mode and zoom policy (fixed 100%, fit width, fit page where the layout is a page layout), at 1440x900:
  - **Fonts**: `document.fonts` is `loaded`, every face is `loaded`, `alphaTab` passes `document.fonts.check`, and tab digits are drawn.
  - **Click**: the tab digit nearest the middle of the score area is clicked (bar numbers are skipped). The app's edit caret must sit under the click, and for the built score the selected measure and beat must hold the fret that was clicked.
  - **Wheel and scrollbar**: wheel down, wheel right and Shift+wheel are tried on the score area; where the layout draws a scrollbar, its thumb is dragged and its track is clicked.
  - **Cursor**: Play from the top (the example) or from bar 8 (the built score, so the cursor crosses a line break), sampled every 0.45 s for 4 to 5 s. The cursor beat or bar element must be drawn and inside the score area in every sample, and must take at least three distinct positions.
  - **Overlap and clipping**: tab digits that cover each other by more than a fifth of the smaller digit are counted; the score must not run past the area's edge without a scrollbar.
- **Per-document restore**: document A is set to Vertical screen at 135%, document B to Grid with Fit page. Both are read back after switching tabs, after `page.reload()`, and after the app is ended abruptly and started again over the same session folder and profile, answering "Recover unsaved work?" with Restore. Before the restart the recovery checkpoint is read from disk and must hold both documents' display preferences.
- **Resize**: `page.setViewportSize` to 1440x900, 1280x800 and 960x600, for both scores, every mode, fit width, fit page (page layouts) and fixed 100%. **The native window was not resized**: the viewport is emulated (`Emulation.setDeviceMetricsOverride`). `outerWidth x outerHeight` was 1440x901 before and after. Menus, the dock and the toolbars reflow under emulation, but real window resizing, a different monitor scale or a different DPI were not run.
- Legibility is measured, not judged by eye alone: the height in screen pixels of the drawn tab digits (median and minimum), the count of overlapping digits, and whether anything is clipped. A digit under 6 px tall is flagged as hard to read. That limit is a working heuristic, not a standard. Screenshots were taken at every combination and looked at for a sample; they are in `E:\claude-tmp\the-56\shots\` and are not committed.
- Totals of the final run: 607 checks in the main run, 9 flagged (all findings below, none a driver fault); the resize run was repeated with fit page added (387 checks, 23 flagged: fit page under 6 px, the two Horizontal screen cases). Raw results are in `E:\claude-tmp\the-56\result-full.json` and `resize-run\result.json`, outside the repository.

## Results by mode

"Wheel: FAIL" in Horizontal screen means a plain vertical wheel does nothing; wheel right and Shift+wheel do scroll (finding 1). "n/a" means nothing to scroll or nothing to check in that cell. Fit page at 1440x900 is about 43% and shows the whole sheet; its digits are small by design.

### Vertical page

| Score | Zoom policy | Actual zoom | Tab digit height, median (min) px | Click selects | Wheel | Scrollbar | Cursor follows | Overlap or clipping |
|---|---|---|---|---|---|---|---|---|
| Windowline (Library) | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit width | 108% | 16.6 (13) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit page | 42.9% | 6.6 (5.2) | pass | n/a | n/a | pass | pass |
| Dense, 8 bars/system | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | not run | pass |
| Dense, 8 bars/system | Fit width | 108% | 16.6 (13) | pass | pass | pass | pass | pass |

### Horizontal page

| Score | Zoom policy | Actual zoom | Tab digit height, median (min) px | Click selects | Wheel | Scrollbar | Cursor follows | Overlap or clipping |
|---|---|---|---|---|---|---|---|---|
| Windowline (Library) | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit width | 108% | 16.6 (13) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit page | 42.9% | 6.6 (5.2) | pass | n/a | n/a | pass | pass |
| Dense, 8 bars/system | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | not run | pass |
| Dense, 8 bars/system | Fit width | 108% | 16.6 (13) | pass | pass | pass | pass | pass |

### Grid

| Score | Zoom policy | Actual zoom | Tab digit height, median (min) px | Click selects | Wheel | Scrollbar | Cursor follows | Overlap or clipping |
|---|---|---|---|---|---|---|---|---|
| Windowline (Library) | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit width | 108% | 16.6 (13) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit page | 42.9% | 6.6 (5.2) | pass | n/a | n/a | pass | pass |
| Dense, 8 bars/system | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | not run | pass |
| Dense, 8 bars/system | Fit width | 108% | 16.6 (13) | pass | pass | pass | pass | pass |

### Parchment

| Score | Zoom policy | Actual zoom | Tab digit height, median (min) px | Click selects | Wheel | Scrollbar | Cursor follows | Overlap or clipping |
|---|---|---|---|---|---|---|---|---|
| Windowline (Library) | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit width | 108% | 17.3 (13.3) | pass | pass | pass | pass | pass |
| Dense, 8 bars/system | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | not run | pass |
| Dense, 8 bars/system | Fit width | 108% | 17.3 (13.3) | pass | pass | pass | pass | pass |

### Vertical screen

| Score | Zoom policy | Actual zoom | Tab digit height, median (min) px | Click selects | Wheel | Scrollbar | Cursor follows | Overlap or clipping |
|---|---|---|---|---|---|---|---|---|
| Windowline (Library) | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | pass | pass |
| Windowline (Library) | Fit width | 100% | 15.3 (12) | pass | pass | pass | pass | pass |
| Dense, 8 bars/system | Fixed 100% | 100% | 15.3 (12) | pass | pass | pass | not run | pass |
| Dense, 8 bars/system | Fit width | 100% | 15.3 (12) | pass | pass | pass | pass | pass |

### Horizontal screen

| Score | Zoom policy | Actual zoom | Tab digit height, median (min) px | Click selects | Wheel | Scrollbar | Cursor follows | Overlap or clipping |
|---|---|---|---|---|---|---|---|---|
| Windowline (Library) | Fixed 100% | 100% | 15.3 (12) | pass | FAIL | pass | pass | pass |
| Windowline (Library) | Fit width | 55.3% | 8.7 (6.7) | pass | FAIL | pass | pass | pass |
| Dense, 8 bars/system | Fixed 100% | 100% | 15.3 (12) | pass | FAIL | pass | not run | pass |
| Dense, 8 bars/system | Fit width | 25% | 4 (3.3) | pass | FAIL | pass | pass | pass |

## Per-document restore

| Step | Document A (Windowline: Vertical screen, 135%) | Document B (dense: Grid, Fit page) |
|---|---|---|
| Switch tabs A, B | mode, zoom 135, both fit buttons unpressed: pass | mode and Fit page pressed: pass |
| `page.reload()` | pass | pass |
| Recovery checkpoint on disk before the restart | holds `verticalScreen` / `manual` | holds `grid` / `fitPage` |
| App ended abruptly, started again, Restore | pass | pass |

"Reopening" here means a reload and crash recovery. The example was never saved as a project, and saving to a `.tabplayer` file and reopening that file was not run; the progress row already states that the preference lives in workspace and recovery data, not in the score file.

## Resize and legibility

Each cell is the actual zoom, then the median (minimum) height of a tab digit in screen pixels.

| Score | Layout | Policy | 1440x900 | 1280x800 | 960x600 |
|---|---|---|---|---|---|
| Windowline | Vertical page | Fit width | 108%; 16.6 (13) px | 87.8%; 13.5 (10.5) px | 68.2%; 10.5 (8.2) px |
| Windowline | Horizontal page | Fit width | 108%; 16.6 (13) px | 87.8%; 13.5 (10.5) px | 68.2%; 10.5 (8.2) px |
| Windowline | Grid | Fit width | 108%; 16.6 (13) px | 87.8%; 13.5 (10.5) px | 68.2%; 10.5 (8.2) px |
| Windowline | Parchment | Fit width | 108%; 17.3 (13.3) px | 87.8%; 14 (10.7) px | 68.2%; 10.7 (8) px |
| Windowline | Vertical screen | Fit width | 100%; 15.3 (12) px | 100%; 15.3 (12) px | 100%; 15.3 (12) px |
| Windowline | Horizontal screen | Fit width | 55.3%; 8.7 (6.7) px | 45.1%; 7.3 (6) px | 35.2%; 6 (4) px; 18 overlaps |
| Dense | Vertical page | Fit width | 108%; 16.6 (13) px | 87.8%; 13.5 (10.5) px | 68.2%; 8.2 (8.2) px |
| Dense | Horizontal page | Fit width | 108%; 16.6 (13) px | 87.8%; 13.5 (10.5) px | 68.2%; 8.2 (8.2) px |
| Dense | Grid | Fit width | 108%; 16.6 (13) px | 87.8%; 13.5 (10.5) px | 68.2%; 8.2 (8.2) px |
| Dense | Parchment | Fit width | 108%; 17.3 (13.3) px | 87.8%; 14 (10.7) px | 68.2%; 10.7 (8) px |
| Dense | Vertical screen | Fit width | 100%; 15.3 (12) px | 100%; 15.3 (12) px | 100%; 15.3 (12) px |
| Dense | Horizontal screen | Fit width | 25%; 4 (3.3) px | 25%; 4 (3.3) px | 25%; 4 (3.3) px |
| Windowline | Vertical page | Fit page | 42.9%; 6.6 (5.2) px | 35.1%; 5.4 (4.2) px | 25%; 3.8 (3) px |
| Windowline | Horizontal page | Fit page | 42.9%; 6.6 (5.2) px | 35.1%; 5.4 (4.2) px | 25%; 3.8 (3) px |
| Windowline | Grid | Fit page | 42.9%; 6.6 (5.2) px | 35.1%; 5.4 (4.2) px | 25%; 3.8 (3) px |
| Dense | Vertical page | Fit page | 42.9%; 6.6 (5.2) px | 35.1%; 5.4 (4.2) px | 25%; 3.8 (3) px |
| Dense | Horizontal page | Fit page | 42.9%; 6.6 (5.2) px | 35.1%; 5.4 (4.2) px | 25%; 3.8 (3) px |
| Dense | Grid | Fit page | 42.9%; 6.6 (5.2) px | 35.1%; 5.4 (4.2) px | 25%; 3.8 (3) px |

Fixed 100% keeps 12 to 15 px digits at every size; what changes is the scroll range (an 810 px wide page in a 729 px wide area at 1280x800, 804 in 561 at 960x600), which is a scrollbar, not clipping. Across both scores, every mode and the three sizes, no digit overlapped and nothing was clipped without a scrollbar, with one exception that is a finding: Horizontal screen fit width on the example at 960x600 (18 overlapping digit pairs at 35.2%). Vertical screen reports 100% for fit width at every width because its bars reflow into the area; its digits never shrink. No toolbar control was cut off at any of the three sizes. The score area itself shrinks to 285 to 301 px high at 960x600 for the example and 194 to 210 px for the dense score.

## Dense forced systems

The built score forces eight bars on a system. Before the fix in this branch, Vertical page, Horizontal page and Grid could not show it: each fell back to a continuous view with the message "Invalid screen bounds geometry. Continuous view is shown at 100%.", Fit page was disabled, and clicks were mapped as in the continuous view. The cause was measured in the app: alphaTab reports a negative real width (about -6 to -8 px at 100%) for some beats when six or more bars are forced on a system, and `paginateScreenScore` rejected any negative width. It reproduced with 8 bars per system of eighths, 8 of quarters and 6 of eighths, and not with 4 bars per system, 2 bars per system or the default layout. With the fix the same files open as two sheets in Vertical page, and a sixteenth-note score at 8 bars per system also opens.

After the fix, at 100% and at fit width the dense score shows no overlapping digits and no clipping in any mode at the three sizes, and its digits are as large as the example's (12 to 17 px). Eighth notes at eight bars per system are crowded but legible. The one dense case that is not legible is Horizontal screen fit width (finding 2). Sixteenth notes at eight bars per system open but were not judged for legibility.

## Findings

1. **Horizontal screen: a plain vertical wheel does not scroll.** Wheel right and Shift+wheel do. A mouse without a horizontal wheel can scroll this layout only with the scrollbar or Shift. Not fixed; whether Guitar Pro 8 maps the vertical wheel is unconfirmed here.
   Suggested issue: "Horizontal screen: scroll sideways with the vertical mouse wheel". Text: in Horizontal screen the wheel (deltaY) leaves `.paper-scroll` at scrollLeft 0, while deltaX and Shift+wheel move it. Map deltaY to scrollLeft when the layout scrolls only horizontally. `display-modes.mjs` already has the check.
2. **Horizontal screen: fit width shrinks long scores to an unreadable size and may leave a stale scroll range.** The example fits at 55.3% (digits 8.7 px median at 1440x900), 45.1% at 1280x800 and 35.2% at 960x600 (digits 6 px median, 4 px minimum, 18 overlapping digit pairs). The 32-bar dense score hits the 25% floor at every size (digits 4 px median, 3.3 px minimum). "Fit is limited to 25%" is shown, so the limit is announced, but the result cannot be read. After fit width the example's scroll width was still 1594 px against a 904 px area although the score visibly ends inside the area (screenshot `example-horizontalScreen-fitWidth-1440x900.png`); not investigated further.
   Suggested issue: "Horizontal screen: stop fit width at a legible size". Text: the fit ratio uses the whole strip width, so long scores reach the 25% floor. Choose a legibility floor for this layout (digits of about 8 px or more, then scroll) and trim the scroll range after a fit.
3. **Small windows leave the score about a third of the height.** At 960x600 the score area is 285 to 301 px high for the example and 194 to 210 px for the dense score; toolbars, tabs, the bottom dock and the status line take the rest. Fit page there lands on the 25% floor with 3 to 4 px digits, so it is only a whole-sheet overview. Not diagnosed which row of chrome grows for the dense score.
   Suggested issue: "960x600: give the score more of the window height". Text: measure what takes the 600 px at the minimum window size and let the dock or a toolbar row collapse.
4. **The score display toolbar is not translated.** "Display mode", "Displayed tracks", "Zoom (%)", "Fit width", "Fit page", "Actual zoom", the six mode names and the fit messages are English literals in `TrackDisplayControls.tsx` with no entry in `src/i18n`. Not run in Estonian or German.
   Suggested issue: "Translate the score display toolbar (et, de)".

## Fixes in this branch

- `e48b6d4` **Rounded zoom.** develop printed the raw ratio ("Actual zoom: 107.9751984126984%" in the build made from it; 87.81646825396825% at 1280x800 as reported). `formatZoomPercent` now rounds to a whole percent or one decimal, and is used in both places the value is shown (the Actual zoom output and "Fit is limited to N%"). Unit tests in `screen-view.test.ts` and `TrackDisplayControls.test.tsx`. Re-run in the app: 87.8%, 108%, 55.3%, 42.9%, 25%. No new UI text, so no `src/i18n` entries.
- `b5a59f1` and `0d1c27d` **Crowded forced systems.** `paginateScreenScore` accepts a negative beat real width and still rejects every other bad rectangle and any non-finite value. The new test fails without the fix. Verified in the app with the files named above.
- **Review fixes** (the commit after the report). Negative beat widths now reach the page layouts, so the consumers were adapted: a beat owns the span from its x to the next beat's x in the same voice (for the last beat, its own end, or the bar's right edge only when its width is negative), because alphaTab's width is negative for some beats and overshoots the next beat for others. The span is used by page-layout hit testing (a click in a crowded beat's column no longer picks its neighbour), by the scale diagram anchor and the single-beat selection marker (which threw and cleared the marker), and by selection and loop bands (`passage-bands.ts`). The negative width is bounded by the bar width and the beat must start inside its bar; `validRect` is unchanged. The tests use a real alphaTab render of eight eighth-note bars per system. These fixes were verified by unit tests only; the desktop driver was not rerun.
- The driver and its fixture, `tests/desktop/display-modes.mjs` and `display-modes-fixture.mjs`.

## Limits

- One machine: Windows 11, WebView2, device pixel ratio 1.0. macOS and Linux were not run. The title and footer text uses Georgia and Arial, which are system fonts and not bundled; on other platforms they may fall back.
- The native window was not resized; the three sizes are emulated viewports. Maximise, snapping and moving between monitors were not run.
- Two scores: the Library example (8 bars, 3 tracks, one sheet in page layouts) and a built score of 32 bars. A page layout with several rows of sheets in Grid, and scores with more than one displayed track, were not driven. Fit page used the paper settings that came with those scores.
- The cursor was sampled by position and visibility every 0.45 s for 4 to 5 s. Timing accuracy against the audio, the cursor at the end of a page, and the cursor through a repeat were not checked. Playback used the real audio engine; sound was not listened to.
- Clicks away from a note head (on a rest, an empty string or between digits) were not driven; that is where a crowded beat's span matters (see the review fixes above).
- A click was checked against the app's edit caret and, for the built score, against the known fret. Range selection by drag, Shift-click and resizing a selection in each mode are covered by `parity-score-layouts.mjs` (not run here; it needs a reviewed build admission) and were not repeated.
- Digit height and overlap are measured on the text the page draws. Collisions of staff lines, rests and symbols were seen only in the screenshots, of which a sample was looked at. The 6 px digit limit is a heuristic.
- No comparison against Guitar Pro 8 was made. The parity rows stay partial.

## Reproduce

```powershell
powershell -File scripts/build-desktop-test.ps1
node tests/desktop/display-modes.mjs      # about 25 minutes; --quick skips cursor and dense scrolling; --only=resize
```

Output goes to `E:/claude-tmp/the-56` (override with `DISPLAY_MODES_OUT`). Only one app may use port 9223.
