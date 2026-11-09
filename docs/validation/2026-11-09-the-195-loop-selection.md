# THE-195: Loop the selected passage in one gesture, with shortcuts

2026-11-09. Branch `agy/the-195-loop-selection` from `develop` (`f24e72b`).

## Context & Problem

Looping the exact selected passage previously required opening More playback, opening Selected playback, and clicking "Loop selection" inside the nested disclosure panel. Additionally:
- Running "Loop selection" from More playback left the panel open across the top of the score.
- Transport actions (Loop, Slower, Faster) lacked keyboard shortcuts, requiring the player to leave the score with the mouse while practicing.
- Clarification was required on how exact-passage looping relates to the whole-bar Loop button.

## Design Decisions

1. **Relation between exact-passage looping and the whole-bar Loop button**:
   - The primary Loop button and bar fields (`Loop start`, `Loop end`) manage bar-level looping and indicate active loop status (`aria-pressed="true"`, "Clear loop").
   - When a passage is selected (`selection && passageChoices.length > 0`), a context-sensitive "Loop selection" button appears in the toolbar loop row next to the Loop button.
   - Clicking "Loop selection" arms native playback with the exact ticks of the passage (`player.loopSelection(selection, choice)`).
   - Once armed, the primary Loop button transitions to active ("Clear loop", `aria-pressed="true"`), and the position display shows the loop chip with fractional boundaries. Clicking "Clear loop" (or pressing the shortcut while loop is active) disarms the loop.
2. **Keyboard shortcuts**:
   - Loop: `F9` (standard Guitar Pro shortcut) and `Ctrl+L` / `Cmd+L`.
     - When loop is active: toggles loop off by clicking the primary Loop button ("Clear loop").
     - When loop is inactive: clicks "Loop selection" if a passage is selected, otherwise toggles whole-bar loop.
   - Slower: `F7` (steps playback speed down through presets).
   - Faster: `F8` (steps playback speed up through presets).
   - Shortcuts route through the transport button elements using `data-action` attributes, naturally respecting `busyGuard`, disabled state, and text entry boundaries (ignored while typing in input/textarea/select/contentEditable elements).
3. **Closing More playback**:
   - Running `onLoopSelection` inside `More playback` automatically collapses `<details className="transport-more">` (`moreRef.current.open = false`).

## Changes

1. `src/Transport.tsx`:
   - Added `data-action="loop"` and `aria-keyshortcuts="F9"` to the whole-bar Loop button.
   - Added context-sensitive "Loop selection" button in the loop row when `selection && passageChoices.length > 0` with `data-action="loop-selection"` and `aria-keyshortcuts="F9"`.
   - Added `data-action="slower"` (`aria-keyshortcuts="F7"`) and `data-action="faster"` (`aria-keyshortcuts="F8"`) to the speed step buttons.
   - Added `moreRef` on `<details className="transport-more">` and auto-closed it on `onLoopSelection`.
2. `src/App.tsx`:
   - In `selectionKeys`, mapped `F9` / `Ctrl+L`, `F7`, and `F8` to find and click the respective transport buttons when outside text fields and modal dialogs.
3. `src/Transport.test.tsx` & `src/Transport.workstation.test.tsx`:
   - Added unit tests for loop row "Loop selection" appearance, invocation, shortcuts/attributes, and closing More playback.
   - Disambiguated `Loop selection` button queries in existing tests when both buttons are mounted.
4. `src/App.test.tsx`:
   - Added integration test verifying `F7`, `F8`, `F9`, and `Ctrl+L` dispatch slower, faster, loop, clear loop, and selection loop, and that they are ignored inside text fields.

## Verification

- `src/Transport.test.tsx` (35 tests): Passed.
- `src/Transport.workstation.test.tsx` (11 tests): Passed.
- `src/Transport.performance.test.tsx` (4 tests): Passed.
- `src/App.test.tsx` (targeted shortcut & explicit transport actions): Passed.
- TypeScript: `npx tsc --noEmit` passed with 0 errors.
