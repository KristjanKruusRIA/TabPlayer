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
  - The counts first recorded here for Library (12), ASCII (9), MIDI (10), Palette (6) and ScaleDiagramEditor (12) were wrong. The true counts are in the second round below.
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

## Second review round (2026-10-31)

A second review rejected the branch again. After merging `feat/gp8-parity` (conflicts in Segmented, CommandPalette, ExportDialog resolved keeping both sides):

- **Focus recovery (High):** the `focusout` handler in `Dialog.tsx` ran in a microtask, while focus was still on `<body>` mid-move, so it sent focus back to the first control on every Tab and mouse click. It now waits one task and acts only if `activeElement` is `<body>` or gone. The effect no longer depends on `closeDisabled`, so a busy change no longer re-focuses, re-captures the opener or rebuilds the inert set.
- **Busy rule:** a control holding focus is never `disabled` for busy. `busyGuard` (aria-disabled, refusing handlers, `unavailable` for other reasons) now covers the Dialog close button, Segmented options, ASCII and MIDI import, Export, Library, Harmony chord actions and library buttons, ScaleDiagramEditor and PageLayoutPanel Apply. New `busyRegion` does the same for the groups that used `<fieldset disabled>` (Export body, Harmony body, Scale browser, page layout): aria-disabled plus capture handlers that refuse clicks, keys, typing, paste and changes. The focus-relocation effects those groups needed are removed. The focus trap selector keeps aria-disabled controls and now includes `summary`.
- **Backdrop close:** restored on Help, ASCII, MIDI and the palette through `dismissOnBackdrop`; the Dialog refuses it while `closeDisabled` (importing), as before.
- **Palette anchor:** `.tp-dialog-backdrop.command-palette-backdrop` now outranks the shared backdrop.
- **PageLayoutPanel:** `<summary>` lost `tabIndex={-1}`.
- **MIDI import:** the fieldset and selects no longer drop focus; a failed import leaves focus on Import, so the refocus effect is gone.
- **Desktop drivers:** midi-import, harmony (Name mode), scale-diagrams (Default and Mark shape), engraving (exact radio names; "Score" also matched "Score and tab") and master-effects (File type, Sample rate, Bit depth) now use radio groups.
- Export width is already 620 px and ChordDiagramPreview already uses the shared tokens; neither was changed.

### Evidence
- `npx tsc --noEmit -p .` clean.
- Edge (Playwright) on a throwaway harness: Tab cycles through the controls of the seg, midi, export, help, palette and ascii dialogs and mouse clicks keep the clicked field focused; a backdrop click closes help, ascii, midi and palette, not export. The harness was not committed.
- Test counts after this round, all passing: Controls 20, Export 32, Library 20, ASCII 7, MIDI 9, HarmonyChordDialog 22, SavedTunings 15, CommandPalette 8, PageLayoutPanel 31, ScaleToolPanel 5, ScaleDiagramEditor 14, help 4, useBusyGuard 4.
- Full `npx vitest run`: every file passed except tuning-ui, WorkspaceApp and midi-import, which timed out while other agents loaded the machine; those three and App.test.tsx (239 tests, 2 skipped corpus files) pass when run alone with `--testTimeout=60000`.

### Limits
- Desktop drivers were edited to the new roles but not run; they need a desktop build.
- Controls that stay natively `disabled` are those that are never reached with focus for a busy reason (for example the normalize level input and tuplet options).

## Third and fourth review rounds (2026-10-31)

- **Busy gestures (round 3):** `busyRegion` also refuses double click, context menu, aux click, drag start and input; a double-clicked scale mark survives a busy panel. A number field in the scale diagram editor reverts instead of committing on blur while busy. `busySelect` keeps select popups shut (MIDI tuplets, Library scope). The general aria-disabled and is-disabled dimming no longer depends on `.tp-dialog`, so the sidebar page layout dims too. Busy is announced in the scale browser, the Harmony library save and the Export dialog before progress exists. A Harmony dialog opened during library load starts on the panel and moves to the chord name when loading ends, only if focus has not moved.
- **Final round:** the scale browser status sits outside the aria-busy fieldset; a busy region no longer marks itself a drop target (dropEffect none, no preventDefault on dragover); `busySelect` refuses F4 as well as the arrow keys (Alt+Down included); the shared dimming skips `.rig-footswitch`, which has its own look.
- **Recount from one run** (src/ui, harmony, rig, engraving, export, library, help, plus the palette, saved tunings and both import dialogs; 62 files, 1265 tests, 0 failed): Controls 23, useBusyGuard 4, Export 33, Library 20, ASCII 7, MIDI 9, HarmonyChordDialog 24, ScaleToolPanel 6, ScaleDiagramEditor 15, PageLayoutPanel 31, CommandPalette 8, SavedTunings 15, help 4, SoundRig 66. These replace the second-round counts above where they differ.
- App.test.tsx (146) passed in the previous round and was not rerun.
