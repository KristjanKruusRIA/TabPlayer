# THE-194: keep the loop through an edit

Date: 2026-11-08. Branch `fix/the-194-loop-through-edit`, based on `develop` at e738d5c. Evidence for the bug: friction 11 in `2026-11-08-the-54-practise-walk.md`.

## Cause

Any score change calls `NativePlaybackController.beforeScoreChange`, which bumps the generation, drops the plan, sends `invalidate` to native playback and sets `loop: null`. `loadDocument` then prepares a new plan; native starts it with no loop. Nothing remembered the loop, so an edit, an undo or a redo ended it. The Rust side only holds ticks (`loop_range`) and is reset by `Invalidate`; no Rust change was needed.

## Rule

- The controller remembers the running loop by bars, read back from the loop that native acknowledges, not from what the UI asked for. Each end is `{bar, occurrence, ratio}`: which bar, which pass of it (a repeat plays a bar more than once), and how far into that pass (0 is its start, 1 its end). This is the same shape as a backing sync anchor.
- Bars, not ticks: the UI sets loops by bars, and an edit inside a bar moves ticks (a longer note, a changed meter) without changing what the player means. A "Loop selection" that begins or ends inside a bar keeps its fraction of the bar.
- After the new plan is ready the controller sends the same `setLoop` command a person would, with ticks resolved on the new plan. Native playback still owns timing; the UI does nothing new.
- Bars that moved are followed. The editor controller now tells the player where bars went for `insertMeasures`, `removeMeasures`, `appendMeasure` and `removeMeasure`, and for the undo and redo of those (`src/editor/edit-bar-map.ts`). Inserting bars before a loop moves it; inserting inside it grows it; removing bars before it moves it back.
- Closest range, only when unambiguous: if an end bar was removed, the loop is trimmed to the nearest bar of it that remains, provided that bar plays once. If the exact pass of a repeated bar is gone, the bar's only pass is used when it has exactly one.
- Otherwise the loop is cleared and the transport message line says so ("The loop was removed because your edit changed the bars it covered.", en/et/de). Cases: every bar of the loop removed; a trimmed or missing pass that cannot be told from another; a change in the number of bars that the editor could not trace (for example a paste that adds bars), because bar numbers may then have moved.
- Not kept: a loop the player cleared; a loop across a document switch; a loop across the resume-from-sleep refresh (that path is specified to come back stopped with no loop). An edit while a loop is armed still stops playback, as before; after the edit the player is stopped at the loop start with the loop armed, and Play resumes inside it.

## Tests

- Vitest, written first and failing before the fix: `src/audio/kept-loop.test.ts` (20), `src/editor/edit-bar-map.test.ts` (3), `src/audio/NativePlaybackController.kept-loop.test.ts` (10, native stub that forgets the loop on prepare as native does), a controller test for the bar map passed on edit, undo and redo in `src/controller.test.ts`, and the notice in `src/Transport.test.tsx`.
- Ran `src/App.test.tsx`, `src/Transport*`, `src/TrackPanel*`, `src/mixer`, `src/tuning-ui.test.tsx`, `src/audio` and `src/i18n`: 83 files, 1360 tests passed, 1 skipped. `npm run typecheck` passes. No Rust changed, so the Rust tests were not run.

## Desktop check

`tests/desktop/loop-through-edit.mjs`, real test app, CDP port 9223 (free before, app closed after), blank four-bar score:

1. Loop bars 2 to 3 (ticks 3840 to 11520). Set a note. Native generation went 3 to 5 and `audio_status` still reports the same loop; the Loop button reads "Clear loop" and is pressed, and the message line is empty.
2. Undo: generation 7, loop unchanged.
3. Play: native position stays inside bars 2 to 3.
4. Clear the loop, edit again: the loop stays cleared.

Control: with the restore step disabled in a rebuilt app, the same driver fails at step 1 with `loop: null` after the edit, which is friction 11.

## Limits

- Sound was not judged. The check reads native status and the Loop button; it does not capture audio.
- Only a note edit, its undo and clearing were driven in the real app. Bar insertion and removal, repeats, "Loop selection" with partial bars and the cleared-with-message path are covered by unit tests with a stubbed native bridge, not by the real app.
- The message wording in et and de is mine and has not been read by a native speaker.
- The edit still stops playback; resuming playback automatically after an edit is not part of this change.
