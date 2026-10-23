# GP8 parity A33: previewing sounds during playback (2026-10-23)

GP8 lets players try other sound presets on a track while the score plays, then keep one or go back. This slice adds that to TabPlayer's Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Preview sound:** a list in the Sound task with two groups:
  - **Factory presets:** Bypass, Clean, Crunch, Lead and Bass. A preset keeps the track's instrument voice.
  - **My sounds:** the user's saved sounds.
- **Previewing:** choosing an entry plays it on the selected track straight away, while playing or stopped.
  - Nothing is recorded in the document or the undo history.
  - Playback is not prepared again and keeps going.
  - The status says “Previewing Name. Keep it or cancel to go back to this track’s sound.”
  - Choosing another entry replaces the preview.
- **Keep previewed sound:** records the previewed sound as one undoable sound edit. The sound that is heard does not change. Undo brings back the previous sound.
- **Cancel preview or Escape:** goes back to the track's saved sound. Focus returns to the list.
- **A preview also ends when:**
  - another track is selected, or the Sound task or the left pane is hidden;
  - the sound is edited in any other way, such as a pedal control, Apply saved sound or Paste; the edit applies to the saved sound and the status says “Preview ended.”;
  - its track is removed, or another document is loaded.
- **Not saved anywhere:** previews never reach exports, stems, the saved project or session recovery. Those all use the document's sounds.
- **Edge cases:**
  - A sound the native player would reject cannot be previewed, and the reason is shown.
  - A preview result that arrives after another choice, a cancel or a track change is dropped.
  - A saved sound deleted while being previewed stays named in the list as “(no longer saved)”.
- **Playback:** the preview goes through the same live settings path as track focus, so it can be combined with focus.
  - Reloads now always use the document most recently requested by the host.
  - So ending a preview straight after Keep, a focus change, or a mix change queued during preparation can no longer send an older document's settings last.

## Evidence
- **Controller** (`src/audio/sound-preview.test.ts`, 5 tests):
  - a preview changes only that track's sound in the settings sent to native, records no edit and does not prepare again;
  - the preview is a copy of the sound passed in;
  - a second preview replaces the first, and ending it sends the saved settings exactly;
  - a preview stays on top of a saved mix edit, and ends with its track or document;
  - unknown tracks and invalid sounds are refused;
  - **races:**
    - after Keep, ending the preview while the edited document's load is still waiting leaves the kept sound playing, and a later focus change still uses the edited document;
    - a mix change queued during preparation no longer overrides a newer document.

    Each race test was confirmed to fail with its fix removed.
- **Panel** (`src/audio/sound-preview-ui.test.tsx`, 9 tests):
  - the list groups, and previewing presets and saved sounds;
  - Cancel and Keep;
  - ending the preview on a track change, on unmounting, on hiding the task and on another edit;
  - edits during a preview are recorded at once and in order;
  - a refused preview shows its error;
  - a late result is dropped (confirmed to fail with the check removed);
  - the controller ending a preview hides Keep and Cancel;
  - Escape and focus;
  - a deleted saved sound stays named;
  - no list without a player that can preview.
- **Desktop:** `tests/desktop/parity-sound-preview.mjs` on a Windows desktop-test build, with the four-track fixture playing:
  - **Lead preview:** previewing Lead on Guitar9 sent native a settings change in which only Guitar9's sound differed, and Lead's amp and delay were on. Playback kept the same generation, and the output peak stayed at 0.80.
  - **Cancel:** sent the saved sounds and mixes back. The project was unchanged, and playback was not prepared again.
  - **Keep:** previewing Crunch and keeping it recorded one `setTrackSound` edit for Guitar9. No extra settings change was sent, since Crunch was already playing.
  - **Undo:** removed the edit and sent the saved sound again.
  - There were no page errors or alerts.
  - `parity-focus.mjs`, `parity-sound-library.mjs` and `exports.mjs` still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice; this slice changes no Rust;
  - the full `vitest` suite: 3,468 tests, with the load-sensitive `App`, `tuning-ui`, `corpus`, `library/content` and `WorkspaceApp` files passing when run alone;
  - `tsc`.

## Review
- **First adversarial review.** Two medium issues, both fixed:
  - a late preview result could show Keep and Cancel on another track, or after Cancel;
  - an edit made during a preview waited for the preview to end, so quick edits could apply out of order.

  Four low issues were also fixed:
  - Keep and Cancel stayed after the player ended the preview;
  - the preview kept playing while the Sound task was hidden;
  - a deleted saved sound left the list blank;
  - focus was lost after Keep or Cancel, and Escape did nothing.

  In testing, the `App` test mocks also crashed the panel, because they had no preview methods. The panel now offers previews only when the player supports them.
- **Second review.** One medium issue, fixed: ending the preview after Keep could reload the document the controller had loaded before the edit, so the old sound played again. Reloads now use the latest requested document. Two low issues were also fixed:
  - a stale choice after the player ended a preview;
  - focus after Keep.
- **Third review:** approved the reload fix. It found the same stale reload, already present before this slice, for a mix change queued during preparation. That is now fixed too.

## Limits
- **Session only:** a preview is not remembered when the app restarts, and cannot be scheduled at a point in the score.
- **One track at a time:** a new preview on another track ends the previous one.
- **No hover preview:** a sound plays once it is chosen in the list, not while hovering over it.
- **Factory presets:** only TabPlayer's five generic presets, not GP8's preset catalog.
- **No GP8 comparison:** there is no comparison with GP8's own preview behavior.
