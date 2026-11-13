# THE-196: small windows for practice

2026-11-13. Branch `agy/the-196-small-windows`, from `develop` (`733f91c`), reworked after review.

Result: **partial.** Unit, jsdom and stylesheet-text tests cover all three changes. The desktop test build was looked at on 2026-11-13 at 1280x800, 960x600, 1600x1000 and 1280x720, in English only for the full score and in Estonian and German on the blank document (see Looked at). No desktop driver was run. The layout figures in the sections below were derived from the stylesheet before the window was looked at; the Looked at section has the measured ones.

## Problems (THE-54 walk, frictions 4 and 8, and the split-out fit item)

1. Below full HD the Loop, Click and Speed captions were hidden, leaving icons and bare numbers.
2. At 1280 wide and below the Parchment page was wider than the score area and needed horizontal scrolling until Fit width was pressed.
3. At 960 by 600 the transport, the score display row and the palette left about 210 to 240 px for the score.

## Changes

### 1. Captions (`src/workstation/gp-shell.css`, `src/shell/transport.css`, rule for `.transport-group:is(.transport-loop,.transport-click,.transport-speed)>.transport-caption`)
- The three captions stay visible: 11px, muted, one line, ellipsis. They are out of the flow (`position:absolute`), so they add no width and no height to the transport; a long translation is clipped, not wrapped.
- Placement, from the CSS: the transport box is `min-height:48px`, its groups are 28px (control `min-height`) and centred, so 10px lie above a group. The caption is 12px tall at `top:-12px`, so 2px of it lie in the toolbar's own 2px top padding. The transport is in the first grid row at 960, 1280 and 1600 wide, so nothing sits above it: the caption paints over no other row and is not clipped.
- 11px is the size of the transport's own caption (`.transport-caption` in `transport.css`), which is the smallest label size the transport uses.
- Accessible names and tooltips already existed (group `aria-label`s, field titles, Metronome title, Slower/Faster titles); no new text, so no i18n entries.

### 2. Fit by default (`src/ScoreView.tsx`, `src/engraving/auto-fit.ts`, `src/App.tsx`, `src/workspace/view-defaults.ts`)
- A page layout (not Vertical or Horizontal screen) fits its width when the user chose nothing: no saved view default, no display or zoom of its own on the score, and the page at its zoom is wider than the score area. It uses the THE-201 digit floor.
- The flag is not part of the saved view and is never written. No edit is recorded and the score is not marked dirty.
- Hysteresis: once fitted it stays fitted until the area is `AUTO_FIT_RELEASE_MARGIN_PX` = 24px wider than the page. The area is measured without the vertical scrollbar (about 17px on Windows), and fitting can remove that scrollbar, so without a margin the fit could switch itself off and on. Inside the margin the fit is held at the zoom it replaced and never grows past it. 24 is a scrollbar plus about 7px.
- Choosing any zoom or display ends it. Typing exactly 100 is saved as a manual display, because 100 alone cannot be told apart from never having chosen.
- Ways back to an unfitted 100%: pressing Fit width while it is pressed sets an explicit manual 100% (`aria-pressed` goes false); Enter in the zoom field while a fit is shown commits the shown value even when it equals 100. Both are saved like any display choice.
- Saving a default view (`saveViewDefaults` in `App.tsx`) ends automatic fit in the open score too. A fit showing at that moment is kept as the score's own fit width. "Use current view" saves what is shown, so while fitted it saves fit width.

### 3. Little height (`src/App.tsx`, `src/engraving/TrackDisplayControls.tsx`, `src/shell/small-window.ts`, `gp-shell.css`)
- At an inner height of 610px or less the score display row folds into one "Score display" button. The controls stay the same elements in the same order; Escape and a press outside close it; focus moves to the button when a focused control folds away, and to Display mode when the button unfolds. The button is never `disabled`.
- The page error, the fit-limit status and the "selected track is hidden" status are outside the folded part, so they are visible and announced either way.
- The inspector and the bottom dock start closed unless the user kept a dragged size for that panel or the score's instrument view was left open. Until the user shows or hides a panel it follows the window.
- At 1099px wide or less the button joins the edit and view row, which frees one toolbar row at 960 wide.

## The threshold: 610px
- `minHeight: 600` in `tauri.conf.json` sizes the web view (inner) area; the title bar is outside it. The THE-56 walk read an `outerHeight` of 901 for a configured 900. So `innerHeight` at the minimum window is about 600. This is inferred from that record and Tauri's window sizing; it was not read from the running window in this work.
- The ticket measured 210 to 240px of score at 960 by 600. The dock is 144px for every height under 800, so a 720px window gives about 330 to 360px at 960 wide (and about 40px more at 1280, which has one toolbar row fewer). That is not the problem the ticket describes, and folding there would hide the overview and the display controls on common laptop heights, so 720 stays unfolded. The row height used here (28px control plus padding) is an estimate.
- 610 is 600 plus a few pixels for fractional display scaling. Existing tests and drivers use 620, which stays unfolded.

## Looked at (2026-11-13)

The `desktop-test` build of this branch, driven over CDP with the bundled "Windowline" example, English; the page sizes were emulated viewports (`setViewportSize`), the native window was not resized by hand. Script: `look-196.mjs` and a second one that records element boxes; screenshots are outside the repository.

Seen and fine:
- 1280x800: an untouched score opens fitted (Fit width pressed, "Actual zoom: 87.8%"), with no horizontal scrollbar. The fit state stayed on at widths 1180 to 1340, sampled once per width.
- 960x600: the display row is folded into a "Score display" button, the inspector and dock are closed, and about 365px of score is visible.
- Loop bars, Click and Speed captions sit above their controls, at the same y (27 at 1280 and 960 wide, 29 at 1600), fully inside the page.
- Opened menu at 960x600: every control is there and labelled (Display mode, Displayed tracks, Zoom, Fit width, Fit page, Visible tracks and its track checkboxes), and "Visible tracks" sits on the same row as the others.

Two defects were found and fixed:
1. **The Speed caption was cut off at the top, and its percent sign sat under the number.** The cause predates this branch. The global `label{display:flex;flex-direction:column}` in `src/styles.css` makes the speed field a column, and `.transport-speed-field` in `src/shell/transport.css` set only `display` and `align-items`, so the "%" wrapped below the number and the Speed group was 41px tall against 28px for the others. The captions hang 12px above their group, so the Speed caption sat 6px higher than the others and began above the transport row. Fix: `flex-direction:row` on `.transport-speed-field`; the Speed group is now 28px tall and 121px wide (it was 112), and the caption is level with the others. The tempo readout is separated from "Speed" with a 6px margin (`gp-shell.css`). Estonian and German captions were measured on the blank document: none overflows its box (`scrollWidth` equals `clientWidth` for all three captions at 1280 and 960 wide).
2. **The opened menu ran past the right edge at 960 wide and made the page scroll sideways.** Fix: the popover is `position:fixed` with `max-width:calc(100vw - 16px)`; `TrackDisplayControls` sets its `top` and `left` from the button and shifts it left so its right edge stays inside the window (`src/engraving/TrackDisplayControls.tsx`). Confirmed by looking and by measurement: at 960x600 the popover's right edge is at 952 and the document no longer scrolls sideways.

An earlier version of the fix did nothing because a comment had split a selector in `gp-shell.css` in two; the stylesheet test now fails on a selector that repeats the shell prefix.

Not seen, or a matter of taste for the owner:
- The page-error alert: it could not be provoked in the real app, so its placement is unchecked.
- The fit-limit message ("Fit is limited to 63%") was provoked (Horizontal screen at 960x600) and is in the page, but it is a one-pixel screen-reader-only line, as it was before folding. A sighted person sees only "Actual zoom" in the open menu. Whether the limit should be visible is a design call.
- The folded button gives no sign of an error or a limit.
- The open menu covers the top of the score while it is open.

Still unseen: the full example in Estonian and German (the check used the blank document), a person resizing the real window, other display scales, macOS and Linux.

## Tests
- `src/ScoreView.layouts.test.tsx`: auto-fit cases and the resize sequence fitted, wider inside the margin, narrower, released, not refitted until narrower than the page.
- `src/engraving/auto-fit.test.ts`: the decision function either side of the page width and the margin.
- `src/engraving/TrackDisplayControls.test.tsx`: folding, focus, the three messages while folded, Fit width off, Enter.
- `src/workspace/view-defaults.test.ts`, `src/App.test.tsx`, `src/shell/small-window.css.test.ts`.
- The stylesheet tests pin CSS text and numbers read from it. They do not render anything.

## Drivers
- `tests/desktop/parity-score-layouts.mjs` now opens the display menu before using a display control (`showDisplayControls`) and chooses 100% through the zoom field with Enter. **Not run.**
- `tests/desktop/selection-loop-drawing.mjs:38` clicks Fit width on an untouched score at 1280 wide and expects it to start unpressed. With automatic fit it is already pressed, so the click now returns to 100%. **This driver needs a change before a desktop run.** Not edited here.
- No fixed-pixel or zoom expectation on an untouched score at 1280 wide or narrower was found in `critique-fixes`, `parity-workstation` (records the paper width only), the backing drivers, `parity-recovery` or `display-modes` (which sets a mode and zoom before it measures). Read, not run.

## Limits
- See Looked at for what was and was not seen. The page-error alert, a person resizing the window, other display scales and Estonian and German on a real score are unchecked.
- Whether `innerHeight` at the minimum window is 600 is inferred, not read.
- The page-error alert sits under the button and was not seen; with the menu open it may overlap the popover.
- Remembered panel preference means a kept dragged size; hiding a panel is not remembered between runs.
- Explicit fit and Enter route apply to any shown fit, not only the automatic one.
- Hysteresis was tested with mocked widths in jsdom; scrollbar behaviour in WebView2 was not observed.
