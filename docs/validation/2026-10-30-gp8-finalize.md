# GP8 parity W15: finalize and unfinalize a document (2026-10-30)

GP8 can make a score read-only until it is unlocked again. TabPlayer had no document lock. This slice adds one, enforced in the native workspace, that survives save, reopen and restart. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-finalize-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build.

## Behavior
- **Finalize:** the File menu shows **Finalize document** for an unlocked document and **Unfinalize document** for a finalized one. A finalized document shows the banner "Finalized: editing is locked." with an **Unfinalize** button, and its tab shows a lock mark.
- **Refused natively:** `apply_edit`, `undo` and `redo` refuse a finalized document with "This document is finalized. Unfinalize it to make changes." Backing import is refused before a file picker opens.
- **The mixer stays usable:** `setTrackMix` is the one edit accepted while finalized, because the mixer is how a player balances playback.
- **Still available:** transport, practice, selection, zoom, views, tuning audition, scale browsing, export and save. Exports that normally save a layout first send no edit while finalized.
- **Storage:** `Project` gains an optional `lock` field, `{"kind":"finalized"}`, written only when set. Files without it load unlocked, and unlocked files keep their exact bytes. The field travels through saves, recovery checkpoints and the UI snapshot.
- **Unsaved state:** finalizing and unfinalizing mark the document unsaved, and Save writes the lock. Closing an unsaved document reverts to the saved lock, as it does for edits.
- **History:** the lock is not an edit, so it cannot be undone. Finalizing and unfinalizing keep the redo stack.
- **Forks and templates:** a document forked from a finalized one starts unlocked.
- **Fail-closed reads:** an unknown kind is refused, and `null` is refused for `lock` and `savedLock`. Only an absent field means unlocked.

## Evidence
- **Rust:** 795 tests passed, none failed. `src-tauri/tests/document_lock.rs` has 14 tests:
  - round trips through save, recovery checkpoints and the clean-shutdown projection;
  - unchanged bytes for an unlocked file;
  - refused unknown kinds and `null`;
  - refusal of every edit but `setTrackMix`, and of undo, redo and backing staging;
  - dirty tracking, no-op locks, a frozen workspace and forks;
  - a mixer edit while locked behaving exactly as an unlocked one.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 136 of 136 alone at a 60-second timeout; at the default 5 seconds some tests time out under load. The lock tests in `src/document-lock.test.ts`, `src/workspace/DocumentTabs.test.tsx` and `src/editor/CommandPalette.test.tsx` passed 15 of 15. They cover the File menu, the banner, disabled editing surfaces, enabled selection and Copy, export sending no edit, the alert on a refusal, and replay of a mix on an added track around a lock.
- **Desktop:** `tests/desktop/parity-finalize.mjs` passed on a Windows desktop-test build of the final source, with the four-track instrument fixture. The run:
  - made two edits and undid one, so history and redo both existed;
  - finalized the document, which showed the banner, disabled Set note, Undo and Redo, marked it unsaved and left the history alone;
  - unfinalized and finalized again, with redo intact;
  - called native `apply_edit`, `undo_edit` and `redo_edit` directly: each was refused and the record stayed identical;
  - muted a track in the mixer, giving one `setTrackMix` edit that cleared redo;
  - saved, and the file held the lock;
  - restarted on the same session with no prompt: still finalized, and a native edit was refused;
  - reopened the saved file in a fresh session: still finalized, and native undo was refused;
  - unfinalized, wrote a note and saved: the edit was accepted and the file had no `lock` field;
  - restarted: the document opened unlocked with its edits.

  There were no page errors or IPC fallbacks.

## Review
- **First review:** an adversarial Opus review found no way to bypass the native guard. It traced every mutating command, the lock's lifetime through save, crash and discard, the format, concurrency and the UI.
- **Findings and fixes:**
  - **High, fixed:** `"lock": null` loaded as unlocked, and `savedLock: null` was accepted, so a malformed file could fail open.
  - **Medium, fixed:** selection controls, Browse scales and tuning audition were disabled while finalized, against the design.
  - **Low, fixed:** `DocumentWorkspace::stage_fork` did not clear the lock itself.
- **Redo, changed after re-review:** the first fix kept redo across a locked mixer move by inserting the mix edit at the history cursor. The re-review showed that an added track's identity includes its position in the edit list, so an insert could leave a saved file that cannot open. The insert was reverted: a mixer move while finalized clears redo like any edit.
- **Later rounds:** the re-review also caught this report's desktop driver reading the wrong snapshot field, and one selection button still locked. Both were fixed, and the reviewer approved the final state.

## Limits
- **Redo and the mixer:** moving a fader while finalized clears the redo stack, as any edit does. Edit list positions are persisted identity, so a mix cannot be inserted before a redo tail.
- **Mixer writes history:** mixer moves are edits, so a finalized document can become unsaved through the mixer.
- **Backing level:** backing gain, pan, mute and solo stay locked while finalized.
- **Unknown track ids:** a direct `setTrackMix` with an unknown track id is not refused. This is reachable only through direct IPC and applies to unlocked documents too.
- **No passwords:** W16 and W17 are separate rows. They must add new lock kinds, because Rust ignores extra keys on a kind.
- **GP files:** GP export and round trips do not carry the lock.
- **No per-track or open locks.**
