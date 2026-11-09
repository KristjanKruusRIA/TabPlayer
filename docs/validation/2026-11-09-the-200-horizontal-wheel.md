# Validation Report: THE-200 Horizontal screen: scroll sideways with the vertical mouse wheel

**Ticket:** THE-200  
**Worktree:** `the-200`  
**Branch:** `agy/the-200-horizontal-wheel`  
**Base:** `develop` (`f24e72b`)

---

## 1. Scope and Objective
In horizontal screen layout (`display.layout === 'horizontalScreen'`), vertical mouse wheel inputs previously did nothing because `.paper-scroll` only overflows horizontally. Users without dedicated horizontal tilt wheels or trackpads had to click and drag the horizontal scrollbar.

## 2. Implementation
- In `src/ScoreView.tsx`, added a non-passive `wheel` event listener on `scrollHost` (`.paper-scroll`) active when `display.layout === 'horizontalScreen'`.
- The wheel is left native (not prevented) when: Ctrl, Meta, Alt or Shift is held; the wheel is horizontal-dominant; the content overflows vertically; there is no horizontal overflow or the score is already at the edge in that direction; or the target is a `textarea`, `select`, `[data-wheel-native]` or a vertically scrollable child. Line and page deltas are scaled (16 px per line, one client width per page).
- When vertical wheel delta (`event.deltaY !== 0`) dominates (`Math.abs(event.deltaY) >= Math.abs(event.deltaX)`) and Shift is not held (which platforms natively map to horizontal scroll):
  - Calls `event.preventDefault()` to prevent default page scrolling.
  - Updates `host.scrollLeft += event.deltaY`.
- The listener automatically unbinds when switching away from horizontal screen layout or unmounting.

## 3. Verification
- Added two new unit tests in `src/ScoreView.layouts.test.tsx`:
  - `scrolls sideways with the vertical mouse wheel in horizontal screen layout`: verifies vertical wheel (`deltaY: 120`) increments `scrollHost.scrollLeft` by 120 and calls `preventDefault()`.
  - `does not intercept the vertical mouse wheel in other layouts`: verifies vertical wheel in `verticalPage` does not modify `scrollLeft` or prevent default.
- Test runs:
  - `npx vitest run src/ScoreView.layouts.test.tsx` passes (87/87 tests).
  - `npx tsc --noEmit` passes with 0 errors.

## 4. Limits
- Checked only in jsdom with mocked scroll sizes. No real-app run, no desktop driver (`tests/desktop/display-modes.mjs`), no WebView2 and no trackpad or pinch run.
- Real wheel feel, smooth-scroll interaction, and pinch delivery as `ctrlKey` wheel events are unverified.
