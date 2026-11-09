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
2. **Keyboard shortcuts** (the issue asks for Loop, Slower and Faster shortcuts but names no keys, so the keys follow the review brief):
   - Loop: `Shift+L`. When loop is active it clears the loop. When inactive it loops the selected passage if one is selected and Loop selection is available, otherwise it falls back to the whole-bar Loop.
   - Slower: `[`. Faster: `]`. Both match the physical key (`event.code` `BracketLeft`/`BracketRight`) when `event.key` is `[`, `]` or a letter, and never once the event is already `defaultPrevented` (note entry takes it first). Estonian: the bracket keys type `ü` and `õ`, so both shortcuts work. German: the `[` position types `ü`, so Slower works; the `]` position types `+`, a note-entry key (shorter beat), so Faster does not fire there and the AltGr bracket (Ctrl+Alt) is excluded. Faster has no working plain key on a German layout; its button and the palette entry remain.
   - Ignored with Ctrl, Cmd or Alt held, on key repeat, inside text fields and while any dialog is open. They are not note-entry keys (`scoreEntryKey` takes only A-G letters, and no bracket).
   - They click the transport buttons through `data-action`, so `busyGuard` and unavailable states are respected, and they only call `player.*`, so they record no document edit.
   - Command palette entries (Loop, Slower, Faster; Loop also matches "clear") show the keys. The help topic Keyboard shortcuts has one line in en, et and de.
   - `aria-keyshortcuts` sits on one control per shortcut: Loop (`Shift+L`), Slower (`[`) and Faster (`]`). The Loop selection button carries none.
3. **Closing More playback**:
   - Running `onLoopSelection` inside `More playback` automatically collapses `<details className="transport-more">` (`moreRef.current.open = false`).

## Changes

1. `src/Transport.tsx`: `data-action` and `aria-keyshortcuts` on Loop, Slower and Faster; the Loop selection button in the loop row; `moreRef` closes More playback after Loop selection.
2. `src/App.tsx`: `selectionKeys` maps Shift+L, `[` and `]` to the transport buttons; palette commands `loop`, `slower`, `faster`.
3. `src/editor/command-palette.ts`, `src/help/help-topics.ts`, `src/i18n/{en,et,de}.ts`: palette entries and help line.
4. Tests: `Transport*.test.tsx`, `App.test.tsx` (the `functionalButton` helper is back to throwing on duplicate matches; the More playback Loop selection button is asserted again with its arguments), `command-palette.test.ts`, `help/help.test.tsx`.

## Verification

- `npx tsc --noEmit`, `Transport*.test.tsx`, the full `src/App.test.tsx`, `src/i18n`, `src/help` and the palette tests: see the commit message for the final counts.
- Mutation checks (each guard removed, the new test failed, then restored): the loop-active branch, the unavailable-button fallback, `event.code` matching of the brackets, the Alt/Ctrl guard and the single `aria-keyshortcuts` carrier.

## Limits

- No desktop run was done. Nothing here was tried in the real app, in WebView2, with a physical German or Estonian keyboard, or with audio playing; all evidence is jsdom tests with a mocked player.
- Whether WebView2 delivers `[` and `]` untouched to the page is assumed, not observed.
