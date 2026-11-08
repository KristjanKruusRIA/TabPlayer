# THE-198: replace an untouched Untitled tab

Date: 2026-11-08. Branch `agy/the-198-replace-untitled`, based on `develop` at 6556f78.
Evidence for the issue: friction 6 in `docs/validation/2026-11-08-the-54-practise-walk.md`.

## Behavior

On initial launch, TabPlayer opens with an empty "Untitled" score tab. When opening a score from the Library, File → Open, drag-and-drop, or the command line / OS file association, the new score previously opened in a second tab beside it, leaving a spare empty "Untitled" tab that the player had to close manually.

The replacement rule is now implemented in `WorkspaceController`:
- When a score opens from the Library (`openSource`), File → Open (`openDocument`), a drag-and-drop (`openDrop`), or command-line launch (`library.openLaunched` calling `openDrop`), it replaces an untouched blank document.
- An untouched blank document is identified by:
  - `project.base.kind === 'blank'` (created blank by the app, never opened from a file).
  - `snapshot.path === null` (never saved to disk).
  - `!snapshot.dirty` (no unsaved modifications).
  - `!snapshot.canUndo && !snapshot.canRedo` (no history whatsoever).
  - `project.edits.length === 0 && project.baselineEdits.length === 0` (no edits).
  - `revision === 0` (no past mutations).
  - `!snapshot.protection?.open && snapshot.protection?.edit !== 'locked'` and no project locks or assets.
- It NEVER replaces:
  - An edited blank document (has edits, dirty, or revision > 0).
  - A blank document after undo back to empty (it has history with `canRedo === true` and `revision > 0`, so it is kept).
  - A saved document (`snapshot.path !== null`).
  - A document opened from a file (`project.base.kind === 'file'`).
- Closing the replaced tab records nothing in any document's undo history.
- Recovery and session restore remain unaffected.

## Evidence

1. TypeScript typecheck:
   `npx tsc --noEmit` passed with 0 errors.

2. Vitest test suite:
   `npx vitest run src/workspace --testTimeout=60000`
   All 14 test files passed (220 tests passed in 33.81s):
   - `src/workspace/WorkspaceController.test.ts` (62 tests passed)
   - `src/workspace/WorkspaceApp.test.tsx` (30 tests passed)
   - `src/workspace/session-startup.test.tsx` (31 tests passed)
   - `src/workspace/view-state.test.ts` (32 tests passed)
   - `src/workspace/MidiImportDialog.test.tsx` (9 tests passed)
   - `src/workspace/RecoveryPrompt.test.tsx` (9 tests passed)
   - `src/workspace/bridge.test.ts` (9 tests passed)
   - `src/workspace/AsciiTabImportDialog.test.tsx` (7 tests passed)
   - `src/workspace/session-bridge.test.ts` (6 tests passed)
   - `src/workspace/view-defaults.test.ts` (6 tests passed)
   - `src/workspace/DocumentTabs.test.tsx` (6 tests passed)
   - `src/workspace/author-defaults.test.ts` (5 tests passed)
   - `src/workspace/library-save-integration.test.ts` (4 tests passed)
   - `src/workspace/ViewDefaultsPanel.test.tsx` (4 tests passed)

3. New unit test coverage in `src/workspace/WorkspaceController.test.ts`:
   - `File -> Open replaces an untouched blank document and records no undo history`
   - `Library Open replaces an untouched blank document`
   - `drag and drop replaces an untouched blank document with the first file and adds subsequent files`
   - `command line launch replaces an untouched blank document`
   - `an edited blank document is NEVER replaced when opening a score`
   - `a blank document after undo back to empty is NEVER replaced (it has history, so it is kept)`
   - `a saved document is NEVER replaced when opening a score`
   - `a document opened from a file is NEVER replaced when opening a score`

4. Updated existing tests in `src/workspace/WorkspaceController.test.ts` and `src/workspace/WorkspaceApp.test.tsx` that previously asserted `toHaveLength(before.length + 1)` / `toHaveLength(2)` when opening a password-protected score onto an untouched blank document to assert `toHaveLength(1)` and verify that the untouched initial document is replaced.

5. Recovery and session restore suites (`session-startup.test.tsx`, `RecoveryPrompt.test.tsx`, `session-bridge.test.ts`) were executed and all 46 tests passed without changes.

## Review

- `WorkspaceController.isReplaceable`:
  Strictly validates all properties of a candidate document to confirm it is an untouched blank document created by the app.
- `WorkspaceController.replaceableDocumentId`:
  Prefers replacing the active tab if it is an untouched blank document, falling back to any open untouched blank document in the workspace.
- `WorkspaceController.add(candidate, replaceId)`:
  First stages and admits the incoming document candidate with the native workspace bridge (`addDocument`). Only after native admission succeeds does it close the replaced document via `closeDocuments` and synchronize the workspace snapshot. If candidate admission or build fails, the candidate token is cancelled and the untouched document remains intact.
- Multi-file drop handling:
  When multiple files are dropped in a single batch, the first file replaces the untouched blank document, while subsequent files open as additional tabs alongside it.
- Undo history integrity:
  Closing the replaced tab uses native `closeDocuments`, which destroys the document entry without emitting undo events or recording undo history. The newly active document initializes with clean undo history (`canUndo === false`, `canRedo === false`).

## Limits

- Desktop test drivers were not run (they require port 9223).
- Converted score imports (`importConverted` for ASCII tab and MIDI import) open as new untitled tabs and do not replace untouched tabs, matching their existing contract.
- Explicit "New document" actions (File → New) always create a new document tab and never replace existing tabs.
