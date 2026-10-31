# W15: finalize and unfinalize a document

Date: 2026-10-24. Status: design. Row W15 ("Finalize/unfinalize a document") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's File > Lock/Unlock > Finalize makes a score read-only until it is unlocked again. TabPlayer has no document lock. This slice adds one: a finalized document refuses every change to its music and layout, natively, and stays finalized across save, reopen and restart until the user unfinalizes it. W16 and W17 (password locks) are out of scope, but the stored shape leaves room for them.

GP8's page does not say what stays allowed while a score is finalized. These choices are TabPlayer's own:
- playback, practice, selection, zoom, views and the mixer stay usable;
- export and printing stay available but cannot change the document.

## Storage

- **Field:** `Project` gains an optional `lock` field, `{"kind":"finalized"}`, stored only when set. It uses `serde(default, skip_serializing_if = "Option::is_none")`, so files without it load unlocked and unlocked files keep their exact bytes.
  - The kind is an enum with one value now. W16 and W17 must add new lock kinds, not extra fields on `finalized`: Rust ignores extra keys on a unit variant, so a new field would be dropped silently by older code.
  - Unknown kinds are refused when a file is read.
  - Only an absent `lock` field means unlocked. A `null` (or any non-lock value) is refused when a file or checkpoint is read, for both `lock` and the checkpoint's `savedLock`, so a damaged file cannot open editable and then drop the lock on save.
- **Where it travels:** the field goes everywhere the project goes:
  - `.tabplayer` saves;
  - `ProjectCheckpoint` recovery;
  - `saved_checkpoint`;
  - `stored_project`;
  - the snapshot sent to the UI, as `ProjectView.lock` and `ProjectSnapshot.lock`, mirrored in TypeScript (`src/project.ts`, `validateProject` in `src/engine.ts`).
- **Saved state:**
  - `ProjectSession` records the lock as last saved, next to `saved` edits.
  - A document is dirty when its edits or its lock differ from the saved ones. Finalizing therefore marks the document unsaved, and Save writes the lock.
  - A clean shutdown reduces an unsaved document to its saved checkpoint, which includes the saved lock, as it already does for edits.
- **Forks and templates:** a document forked from a finalized one, or made from it as a template, starts unlocked.
- **GP export:** GP files have no such field, so a GP export or round trip does not carry the lock. This is documented as a limit.

## Native commands and enforcement

- **New command:** `document_set_lock(documentId, lock: {kind:"finalized"} | null)`, registered in both handler lists.
  - It goes through the workspace's mutation checks, so it is refused while the workspace is frozen or busy, like other document changes.
  - It bumps the document's revision and checkpoint revision, and calls `session.changed()`.
  - Setting the lock a document already has is a no-op that returns the current snapshot without bumping anything.
- **Enforcement:** `DocumentWorkspace::apply_edit`, `undo` and `redo` refuse a locked document with "This document is finalized. Unfinalize it to make changes." The only exception is that `apply_edit` still accepts `setTrackMix`. The mixer is how a player balances playback, and GP8 keeps playback usable. A mixer move made while finalized is an ordinary edit for history: it clears the redo stack, as any edit does. This is a recorded limit. Edit-list positions are persisted identity (an added track is keyed by the position of its `addTrack` edit), so a locked mix edit cannot be inserted before the redo tail without shifting those positions and breaking replay.
  - Backing level and the backing channel mix are `setBacking` edits, so they stay locked while finalized. This is a recorded limit.
  - Backing import (`stage_asset` and `stage_backing`) is refused before any file picker opens.
  - Saving, Save As, exporting and closing stay allowed. The check stays separate from `check_mutation`, which `save_to_path` shares.
- **No history entry:** the lock itself is not part of the edit history. Finalizing cannot be undone. Unfinalize is the way back. Finalizing and unfinalizing keep the redo stack; a mixer move while finalized clears it (see Enforcement).

## UI

- **File menu:**
  - **Finalize document** is shown for an unlocked document;
  - **Unfinalize document** is shown for a finalized one.
  - Both are added to the desktop drivers' `fileCommands` list.
- **Banner:** a finalized document shows a status banner above the score: "Finalized: editing is locked." It has an **Unfinalize** button. The document tab shows a lock mark with an accessible name.
- **Editing locked:** an `editLocked` flag, read from the snapshot and kept separate from `controlsBusy`, disables the edit controls below. Selection stays enabled: Measure, Beat, Staff, Voice, String, Select bar/track/all, Clear selection and scope, Copy music, Browse scales and tuning audition. It disables:
  - the editing panels, palette edit actions and keyboard note entry;
  - clipboard cut and paste;
  - Undo and Redo;
  - the instrument view's entry mode;
  - track, structure, sound, engraving, page and harmony edits, and backing import.

  Transport, practice, selection, the mixer, export and save stay enabled.
- **Export:** exports that normally save a page or print layout first (`runExport`) do not send that edit while the document is finalized. They export with the current layout, and their layout controls are disabled.
- **A refused edit:** if an edit is refused anyway, for example one already in flight when the lock lands, it shows the usual alert and changes nothing.

## Acceptance

- **Rust tests:**
  - the lock round-trips through save and open, recovery checkpoints and the clean-shutdown projection;
  - a saved unlocked file's bytes are unchanged;
  - an unknown kind is refused;
  - every edit is refused while locked except `setTrackMix`, and undo and redo are refused;
  - backing staging is refused;
  - dirty tracking follows the lock;
  - a no-op lock bumps nothing;
  - a frozen workspace refuses the toggle;
  - forks start unlocked.
- **Frontend tests:**
  - the File menu shows the right command;
  - the banner and the Unfinalize button appear;
  - each editing surface is disabled, while transport, mixer and export stay enabled;
  - an export while finalized sends no layout edit;
  - a refusal shows the alert.
- **Desktop:** on a Windows desktop-test build:
  - finalize a document and save it. The editing controls are disabled, and a direct native `apply_edit` and `undo_edit` are refused with the history unchanged;
  - a mixer change still works;
  - close and restart on the same session: the document is still finalized;
  - reopen the saved file in a fresh session: it is still finalized;
  - unfinalize, make an edit and save: it is accepted, and after a restart the document opens unlocked.

## Scope

No passwords (W16, W17), no lock on opening, no per-track locks, and no GP-format lock.
