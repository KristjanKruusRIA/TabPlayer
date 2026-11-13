# THE-193: drawing the selection and the loop

Date: 2026-11-08. Branch `ux/the-193-draw-selection-loop`, based on `develop`. Closes friction 3 of `2026-11-08-the-54-practise-walk.md`.

## What was wrong

- In the default Parchment layout and the two screen layouts a range selection was drawn as two end handles and nothing between them. alphaTab's own selection element has no background unless its stylesheet is loaded, and this app does not load it. Only the three page layouts shaded the range, in a blue close to the edit target's blue.
- A running loop was drawn nowhere except the two bar number boxes (and, after THE-54, the pressed Loop button).

## What is drawn where

| Where | Selection | Loop |
|-------|-----------|------|
| Score, every layout | An amber wash with a solid 2 px brown edge at each end (`.score-range-block`), from the first selected beat to the last; a beat that opens or closes its bar takes the bar edge, as alphaTab shades it. | A violet frame (`.score-loop-band`): 3 px rules above and below and 3 px end caps, with a faint violet wash, over the bars the loop plays; where it begins or ends inside a bar the edge falls on the beat the playback plan reaches there. |
| Overview | Not drawn (it still shows the edit target cell). | The loop's bars lit on the ruler (violet underline, bold number) and one violet bracket through every track row (`.score-overview-loop`), one per run of bars. |
| Position display | None. | "Loop 4–5" at the top right of the display, a violet strip under the lime progress line at the loop's place along the piece, and a status line read aloud, not changed while an edit rebuilds the plan, and "Loop off" is said only after the loop has stayed gone for half a second (at once when the loop notice says an edit ended it), because the controller reports ready with no loop for a moment before it sends the loop again ("Looping bars 4 to 5", "Looping bar 3", "Loop off"). |

- Bands are one per staff system and per run of neighbouring bars (a bar that starts or ends the passage inside it is not joined to its neighbour, so its edge beat holds), so a passage across a line break is two bands and a loop that skips bars (a repeat) is not drawn over the bars it skips. A repeated bar is drawn once however many times the loop plays it. Where a passage goes on across a line break, that side of the band has no edge or end cap.
- Geometry is `src/engraving/passage-bands.ts`, over alphaTab's own bounds lookup (master bar bounds, beat bounds), and is mapped by the same `mapped()` function as the edit target, error bars and handles: the canvas offset in live layouts, `mapScreenRect` with the system in page layouts, so zoom and page arrangement are followed the same way.
- The bars a loop covers come from `src/audio/loop-passage.ts` (loop ticks and the plan's bar occurrences), shared by the score, the overview and the position display. `useLoopPassage` rebuilds it only when the loop's ticks or the plan's occurrences change (the occurrences array is the plan's own while ready, and empty while the controller prepares a rebuilt plan, so the loop is placed again once the plan arrives). Native status updates hand over a new loop object on every tick, so without this key every tick would redraw.
- Overlays are drawn when the loop, selection, layout, zoom or render changes, never per playback frame. All overlays are `pointer-events:none` and `aria-hidden` (the overview's bracket carries the same text as an image role, like its playhead).
- Colours are tokens on the existing theme variables (`workstation-shell.css`): `--ws-loop` (dark shell), `--ws-loop-on-paper`, `--ws-select-on-paper`, `--ws-select-wash-on-paper`. Neither is blue (edit target) or green (playback cursor); the shapes also differ (wash with side edges against a frame with top and bottom rules), so the two do not depend on hue.
- New text `transport.loop_chip`, `transport.loop_chip_one`, `transport.loop_status`, `transport.loop_status_one`, `transport.loop_status_off`, `transport.loop_position_hint`, `overview.loop_bars`, `overview.loop_bar`, with `en`, `et` and `de`.

## Contrast

Computed from the token values (WCAG relative luminance):

| Pair | Ratio |
|------|-------|
| Loop frame `#5a2db3` on the paper `#fffdf5` | 8.4 : 1 |
| Selection edge `#9a4a00` on the paper | 6.2 : 1 |
| Edit target blue `#245cb2` on the paper (for reference) | 6.4 : 1 |
| Playback cursor green `#81a33c` on the paper (for reference) | 2.9 : 1 |
| Notation ink `#111` on the amber wash at 30 percent | 15.1 : 1 |
| Loop violet `#c4a2ff` on the shell panel `#1e1c19` / raised `#2a2723` / input `#100f0d` | 8.1 / 7.1 / 9.1 : 1 |
| Ruler number (`--ws-text` `#f1ece3`) on the loop-tinted ruler cell (24 percent violet over the raised shell) | 7.7 : 1 |
| Violet underline `#c4a2ff` on that tinted cell (a graphic, so 3 : 1 is the bar) | 4.3 : 1 |

**Limit: the app has one theme.** There is no light shell. The score paper is always light (`color-scheme: light` on the paper), the rest is the dark charcoal shell. So "both themes" was checked as the two surfaces that exist: the overlays on the light paper, and the loop marks on the dark shell. A light shell, if one is added later, needs its own value for `--ws-loop`. Forced colours get `Highlight`/`CanvasText` rules; they were written but not looked at in a forced-colours session.

## Tests

- `src/audio/loop-passage.test.ts`: whole and mid-bar loops, repeats (a bar played twice is one entry), runs, text, the loop's place along the clock.
- `src/engraving/passage-bands.render.test.ts`: real alphaTab rendering of a 12-bar score that wraps. One band per system across a line break, the middle system whole, a loop that skips bars as separate runs, edge beats inside a bar and at a bar's edge, bars the renderer did not place.
- `src/ScoreView.layouts.test.tsx`: selection bands in four layouts, loop bands in four layouts, loop with selection together, equal loop leaves the same elements, the CSS keeps both overlays `pointer-events:none`. The two ScoreView fakes gained `findMasterBarByIndex`.
- `src/workstation/ScoreOverview.test.tsx`: loop marks on the ruler and the bracket's place, a loop that skips bars, no loop, a loop longer than the score.
- `src/Transport.test.tsx`: the position display's chip, strip variables and status text, "Loop off", an equal loop handed over on a clock tick changes nothing.
- `npm run typecheck` and the full `npx vitest run` pass (355 files, 5906 tests; 7 skipped, as before).

## Real app

Driver: `tests/desktop/selection-loop-drawing.mjs` (opens the Windowline example through the test open hook, presses Fit width, selects from the last note of bar 4, the end of the first system, to the first note of bar 5, loops it with Loop selection, then photographs). Built with `scripts/build-desktop-test.ps1`; port 9223 was free before and the app was closed after. Screenshots are in `<scratch>/the-193\` (not committed).

What I saw:

- 1280 by 800 and 960 by 600: the amber selection over the last beat of bar 4 to the end of its system; the violet loop frame over the same stretch; the overview ruler lights bars 4 and 5 and a bracket runs through all three tracks; the display reads "Loop 4–5" with the strip under "0:07 / 0:17". At 960 the chip fits beside the track name without wrapping the tempo.
- Across the line break: scrolled, and on a 1280 by 1300 window, the passage is two bands, the second at the start of the next system, from its first bar edge to the end of the first beat. The loop edge in bar 4 fell halfway through the bar (tick 1920 of 3840), where the selected note starts.
- Every other layout (Vertical page, Horizontal page, Grid, Vertical screen, Horizontal screen, Parchment) drew both: two bands each in the three page layouts and Parchment, one in the two screen layouts (the whole passage lay on one system in this window). Computed pointer-events of all bands and the bracket: `none`.
- Loop frame over selection reads as a brown-violet where both cover the same beats, with the frame still plain. That is the usual case right after Loop selection, because the loop starts out equal to the selection.
- The chip first sat in the display's bottom row and made the tempo wrap at 1280; it now sits at the top right, beside the track name. The screenshots above are of that final placement.

## Limits and not checked

- Playback scrolling was not measured. The overlays are redrawn on loop, selection, layout and render changes only (by test), but no frame timing was taken with a loop running over a long score.
- A loop through a repeat was tested in the pure functions and with fake bounds, not in the real app. Windowline has no repeats.
- Multi-bar rests are not drawn over: bars the renderer folds into one rest have no bounds of their own and are skipped.
- A loop or selection on a track that is not shown draws the same bands (bands are the whole system); only the exact edge beats need the shown track, and fall back to the bar edge without it.
- While an edit rebuilds the plan the loop is briefly off, so the frame, bracket and chip disappear and come back with the restored loop (THE-194).
- The overview shows the loop only, not the selection. The selection is still visible there as the edit target cell.
- The loop strip under the display places the loop by the plan's own clock; with a progressive-tempo practice setting the lime progress and the strip can drift apart.
- Screen reader output (the status line, the overview's bracket text) was not listened to; the text is present and is covered by the tests above.
- Keyboard operation is unchanged: no new control was added.
- The overview's loop bracket is a `role="img"` inside the grid, as its playhead already is. That pattern was there before this change and is left alone.
