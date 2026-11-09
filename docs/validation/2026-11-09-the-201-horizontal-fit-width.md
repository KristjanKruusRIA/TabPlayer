# THE-201: Horizontal screen: stop fit width at a legible size

2026-11-09. Branch `agy/the-201-horizontal-fit-width` from `develop` (`f24e72b`), reworked after review.

Result: **partial.** The floor, the paper width and the scroll reset are covered by unit and jsdom tests. No desktop run was made (see Limits).

## Problem

In Horizontal screen, Fit width uses the width of the whole strip, so a long score reaches the 25% floor. THE-56 measured tab digits of 4 px (3.3 px minimum) on a 32-bar score and 18 overlapping digit pairs on the Windowline example at 960 by 600. It also saw a scroll width of 1594 px against a 904 px area after fit.

## Changes

1. **Floor from the digit size.** `tabDigitFloorPercent(tabScale)` in `src/engraving/typography.ts` is the one place for the constant (`MIN_TAB_DIGIT_PX = 7.5`) and its derivation: `ceil(100 * 7.5 / (tabFontPx * 12/14))`, kept within 25 to 100. `tabFontPx` is the renderer's `tablatureFont` size (14 px by default) times the Tab numbers scale, the same value `configureTypography` applies. The 12/14 is the smallest drawn digit (12 px at 100%) over the 14 px font, from THE-56. Results: 63% by default (smallest digit 7.56 px), 84% at tab scale 0.75, 50% at 1.5. A larger tab font gives a lower floor.
2. `ScoreView` passes that floor to `resolveScreenZoom` (`minPercent`) for Horizontal screen only; every other layout keeps 25. `resolveScreenZoom` keeps `minPercent` and no longer has the unused `maxPercent`.
3. In Horizontal screen the live paper and renderer width follow `max(available width, base width * zoom)`.
4. Entering fit width in Horizontal screen (from manual zoom, or from another layout) sets `scrollLeft` to 0. Other layouts keep their scroll offset. The earlier clamp branch is removed: browsers already clamp `scrollLeft`.

## Why a floor and not fitting the height

The issue allowed either. Fitting the height would size the strip to the score area, which is only 194 to 301 px high at 960 by 600 (THE-56, finding 3), so the zoom would be small whatever the score length and the digits would be unreadable in exactly the window where the problem shows. A digit-size floor guarantees legibility at any window size and any score length, and the strip scrolls sideways, which is what this layout is for. The cost: a long score no longer fits in view, and the status shows "Fit is limited to N%".

## Verification (unit and jsdom)

- `typography.test.ts`: the floor keeps the smallest digit at least 7.5 px and one percent lower would not; larger tab scale lowers it; bounds 25 and 100.
- `screen-pages.test.ts`: `minPercent` clamps, leaves larger ratios alone, and the default stays 25.
- `ScoreView.layouts.test.tsx`: fit width stops at 63% and the paper is `500 * 0.63` wide; a tab scale of 1.5 gives a lower floor; with `scrollWidth` mocked to 2000 and `scrollLeft` at 300, entering fit in Horizontal screen gives 0 and a vertical page keeps 300.
- `screen-playback.actual.test.ts` (real alphaTab, headless): zoom is exactly the floor and the paper width is exactly `max(480, natural * 0.63)`.
- Each guard was mutated and its test failed: the floor value, the tab scale input, the scroll reset, the layout guard, the manual-to-fit condition, both bounds of the helper, the derivation ratio, the `minPercent` default and use, and the paper width.

## Limits

- No desktop run was made. `tests/desktop/display-modes.mjs` was not run for this change.
- Not measured: the digit height and the overlap count at the floor. The old claims (a minimum of 6 px, a median of 7.7 px, no overlapping digits) are withdrawn. The 63% rests on the THE-56 minimum of 12 px at 100%; at 63% that gives about 7.6 px, and overlap at that zoom is untested.
- The stale scroll width (1594 px against 904 px) is not shown fixed in a real WebView. Only the reset on entering fit is tested, in jsdom with a mocked `scrollWidth`.
- The 12/14 ratio is a single measurement on one machine and one font; a different tab font family could change it.
