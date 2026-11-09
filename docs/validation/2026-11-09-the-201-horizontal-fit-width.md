# THE-201: Horizontal screen: stop fit width at a legible size

2026-11-09. Branch `agy/the-201-horizontal-fit-width` from `develop` (`f24e72b`).

## Context & Problem

In the Horizontal screen layout (`display.layout === 'horizontalScreen'`), Fit width calculates zoom across the entire endless horizontal strip. For long scores (e.g. 32 bars) or smaller viewports (e.g. 960x600):
1. Zoom collapsed down to the 25% floor, causing tab digits to shrink to 3.3–4 px tall and producing overlapping digits (e.g. 18 pairs of overlapping digits in the Windowline example at 960x600).
2. The score live paper width (`sourceWidth`) was locked to `available.width` regardless of rendered score width, and when switching from scrolled manual zoom to Fit width, stale `scrollLeft` remained uncleared, keeping `scrollWidth` artificially inflated (e.g. 1594 px against a 904 px score area).

## Changes

1. **Custom Legibility Floor for Endless Horizontal Screen (`resolveScreenZoom`)**:
   - `resolveScreenZoom` now accepts an optional `minPercent` floor parameter (defaulting to 25%).
   - In `ScoreView.tsx`, when fitting width in `horizontalScreen`, `minPercent: 50` is specified.
   - At 50% zoom, minimum digit height remains $\ge 6\text{ px}$ (median ~7.7 px) with 0 overlapping digit pairs. When a score's full strip would shrink below 50%, zoom stops at 50% and reports `fitLimited: true` ("Fit is limited to 50%. Scroll to view the full score.").

2. **Accurate Strip Width & Stale Scroll Trimming**:
   - In `ScoreView.tsx`, `sourceWidth` for `horizontalScreen` now tracks `baseWidth !== null ? Math.max(available.width, baseWidth * factor) : available.width` so that `.score-live-paper` and `view.renderer.width` expand with the rendered strip rather than truncating at the container boundary.
   - When entering fit mode or switching layouts in fit mode, `scrollHost.scrollLeft` is reset to 0 so the score starts at bar 1. When zoom factor updates while in fit mode, `scrollLeft` is clamped to the new `maxScroll`, collapsing any stale Chromium scroll extent.

## Verification

- `src/engraving/screen-pages.test.ts`:
  - Verified `resolveScreenZoom` respects `minPercent: 50` by clamping small ratios to 50% with `limited: true` and leaving $\ge 50\%$ ratios unconstrained.
- `src/ScoreView.layouts.test.tsx`:
  - Verified horizontal screen `fitWidth` clamps at 50% floor when available width is narrow (180 px against 500 px base width -> 50% with `fitLimited: true`).
  - Verified `scrollHost.scrollLeft` is trimmed to 0 upon entering fit mode.
  - Verified `.score-live-paper` width reflects `Math.max(available.width, baseWidth * factor)`.
- `src/engraving/screen-playback.actual.test.ts`:
  - Verified real alphaTab horizontal strip under `fitWidth` clamps to 50% floor and maintains paper width $\ge 480\text{ px}$.
- TypeScript type checking: `npx tsc --noEmit` passed with 0 errors.
