# UI dialogs rejection remediation (2026-10-30)

This document records the resolution of findings from the independent review rejecting commit `b12c1fd` on branch `feat/ui-dialogs`.

## Behavior
- **Reverted out-of-scope restyles:** Restored original workspace styles in `src/workspace/recovery.css` and `.keyboard-help` in `src/styles.css`. Restored ScoreView paper overlay colours (`#fffdf8`, `#465363`, `#161c24` dashed outline) in `src/harmony/ScaleDiagramView.tsx` and removed the fret calculation no-op at line 42.
- **Backdrop dismiss opt-in:** Added `dismissOnBackdrop?: boolean` (default false) to `src/ui/Dialog.tsx`. Export, Harmony, Chord, Saved tunings, Scale, and Library modals do not dismiss on backdrop clicks, protecting in-progress drafts and exports.
- **Modal focus management and inert background:** `Dialog.tsx` traps Tab and handles Escape at document level, recovers focus to the dialog when focus falls to `<body>` (e.g., after clicking an action disabled by `busy`), and marks all siblings outside the dialog with `inert`. Focus restore uses `{ preventScroll: true }`.
- **Tokens and primary styling:** Defined `--tp-danger`, `--tp-focus`, `--tp-r-sm`, `--tp-r-md`, `--tp-r-lg`, and `--tp-shadow-float` in `src/ui/ui.css` from existing tokens. Active palette row outline (`--tp-focus`) and invalid input borders (`--tp-danger`) are restored. Added CSS rules for `.tp-button`, `.tp-button.primary`, `.tp-field`, and `.tp-field-label` so primary dialog actions render with prominent contrast.
- **Dialog widths:** Restored Saved tunings dialog to 760px by removing `chord-dialog` class collision. Restored Harmony chord dialog to 900px by removing `styles.css:19` override and removing `chord-dialog` from `HarmonyChordDialog.tsx`. Removed conflicting `.tp-dialog.export-dialog` override in `src/styles.css` so `export-dialog.css` sets 620px width.
- **Segmented same-value guard:** Added a same-value check in `go()` (`Segmented.tsx:18`) to ensure pressing Home or End on the already selected option does not trigger `onChange`, preserving generated chord shapes in Harmony Name mode.
- **Command palette focus & top anchoring:** Moved `onMouseDown` handler to `Dialog` panel so clicking palette title or padding keeps focus on the input. Anchored palette near top (12vh / 72px at 600px height) via `.command-palette-backdrop`.
- **PageLayoutPanel focus fallback & test cleanup:** Added focus fallback to details `<summary>` when `busy` disables controls. Removed tautological height expectation in `PageLayoutPanel.test.tsx:30`.
- **Scale tag & desktop tests:** Replaced 11-option `Segmented` with `<select>` in `ScaleToolPanel.tsx`. Updated 10 desktop test scripts that interacted with controls converted to radio groups to click the corresponding radio options, and fixed the Library dialog selector in `parity-file-library.mjs`.
- **LOW cleanup:** Fixed header close button label to read "Cancel" while an export is busy and disabled it during Library leases. Moved ASCII and MIDI import footers outside the scrolling body via `actions` prop on `Dialog` with form submission support. Replaced global query selector in `InitialBusyFocus` with a direct ref. Removed unused `choose` ref in `MidiImportDialog.tsx`.

## Evidence
- **TypeScript:** `npx tsc --noEmit -p .` completed cleanly with zero diagnostics.
- **Component & Unit Tests:** All failing-first unit tests were confirmed failing before implementation and passing after:
  - `src/ui/Controls.test.tsx` (13/13 passed)
  - `src/export/ExportDialog.test.tsx` (28/28 passed)
  - `src/library/LibraryDialog.test.tsx` (12/12 passed)
  - `src/workspace/AsciiTabImportDialog.test.tsx` (9/9 passed)
  - `src/workspace/MidiImportDialog.test.tsx` (10/10 passed)
  - `src/harmony/HarmonyChordDialog.test.tsx` (22/22 passed)
  - `src/tuning/SavedTuningsDialog.test.tsx` (15/15 passed)
  - `src/editor/CommandPalette.test.tsx` (6/6 passed)
  - `src/engraving/PageLayoutPanel.test.tsx` (31/31 passed)
  - `src/harmony/ScaleToolPanel.test.tsx` (5/5 passed)
  - `src/harmony/ScaleDiagramEditor.test.tsx` (12/12 passed)
- **App Integration:** `npx vitest run src/App.test.tsx --testTimeout=60000` passed.

## Review
All 9 numbered review findings and all LOW items have been addressed at their source with focused commits:
1. `6aca69b`: Revert out-of-scope restyles of recovery, keyboard help, and ScoreView overlay
2. `2e43af8`: Make backdrop dismiss opt-in and restore modal keyboard and focus trapping
3. `127e5b9`: Define missing tokens and primary button and field styling
4. `828fe6b`: Restore dialog widths and remove conflicting overrides
5. `00f485d`: Guard Segmented go against firing onChange for current value
6. `6fc2d07`: Keep input focus on panel click and anchor near top
7. `2c09183`: Add focus fallback when busy in PageLayoutPanel and fix test tautology
8. `54a72e7`: Update radio interactions and library dialog selector

## Limits
- **Segmented merge boundary:** Only the minimal same-value guard was applied to `Segmented.tsx` to prevent merge conflicts with ongoing work on the rig branch.
- **Desktop test runner:** The desktop tests in `tests/desktop/` are Playwright-over-Tauri test scripts executed against native desktop builds with an active display server. Their selector contracts have been updated to match the DOM changes, while verification in this headless CI/worktree environment relies on Vitest component and App suites.
- **Backdrop dismissal:** Modals with `dismissOnBackdrop: false` deliberately ignore clicks outside their panels; users must explicitly use Escape or dialog action buttons to close them.
