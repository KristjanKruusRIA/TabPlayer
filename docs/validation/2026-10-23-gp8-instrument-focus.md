# GP8 parity U13: instrument view focus on the selected beat, bar or next beat (2026-10-23)

GP8's instrument view can show the notes of the selected beat, the selected bar or the next beat, as well as what is playing, so a player can study a position while stopped or look ahead while playing. This slice adds those modes to TabPlayer's instrument view. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Show:** the instrument view header has a "Show" list before the view mode. Its choices are:
  - Playing notes (the default, as before);
  - Selected beat;
  - Selected bar;
  - Next beat.
  The fretboard, keyboard or drum kit marks the chosen notes. The list of note names below the view is named after the choice, for example "Notes in the selected bar".
- **Selected beat:** the notes of the beat at the edit target, in its voice and staff.
- **Selected bar:** every note of the edit target's measure on its staff.
- **Repeats and "%" bars:**
  - A repeated passage shows its first performance once.
  - A repeat-bar ("%") measure shows the notes it repeats, at its own playback position. The measure it copies shows its own notes only.
- **Next beat:**
  - **Stopped:** the first onset after the selected beat's first performance. It counts from the beat itself, so a grace note before the selected beat is not shown as the next beat.
  - **Playing or paused:** the first onset after the playback position.
  - **Count-in:** the notes at the playback position, which the count-in leads into.
  - **Loop or range:** inside a loop, it wraps to the loop's first beat at the loop end. A range shows nothing past its end.
  - **Finished:** when playback has finished, it follows the selection again.
- **Updates:**
  - Moving the edit target updates the selected beat, bar and next beat.
  - The selected beat and bar do not change while playing.
  - The selection modes reuse their notes until the playback plan or the selection changes, so playback ticks do not rebuild them.
- **Status text:**
  - before playback is prepared: "Playback is not ready yet";
  - when playback has failed: "Playback is unavailable";
  - otherwise, when nothing applies: "No notes in the selected bar", "No later notes on this staff" and so on.
- **The score is unchanged:** nothing in this view edits the score, its dirty state or its undo history.

## Evidence
- **Unit** (`src/instruments/focus.test.tsx`):
  - the selected beat, the selected bar, and the next beat while stopped, playing and at the end of the score;
  - count-in, loop wrap and range end;
  - first-pass notes of a repeat, "%" bar notes in their own bar without doubling the copied bar, and a grace note before the selected beat;
  - the live view's Show list, its group names and note names, and the not-ready, failed and older-player messages.
- **Controller** (`src/audio/NativePlaybackController.test.ts`): `scheduledNotes` returns the plan's notes and performed beats. It gives the position, loop and count-in only while playing or paused, none after the ended phase or Stop, and nothing after a score change.
- **Desktop:** `tests/desktop/parity-instrument-focus.mjs` on a Windows desktop-test build, with four measures of quarter notes:
  - while stopped:
    - Selected beat shows fret 0, as E2;
    - Selected bar shows frets 0–3, as E2 F2 F#2 G2;
    - Next beat shows fret 1;
  - two and then five arrow-key moves of the edit target change Next beat to frets 3 and 7;
  - Selected bar becomes frets 5–8 and Selected beat fret 6;
  - while playing from the selection, the selected bar and beat stay at frets 5–8 and 6;
  - paused at tick 7872 in measure 3, Next beat shows fret 11, the beat after the pause;
  - after Stop, Next beat is fret 7 again;
  - Playing notes is empty while stopped;
  - the document, its edits and its dirty state are unchanged, and there are no page errors.
- **Existing tests:** `tests/desktop/instruments.mjs` passes again on the same build.
  - It had stopped working before this slice, because its page reload now lands on session recovery. The reload is removed: it closes the Library dialog instead, and now also asserts that no external request was made.
- **Verification:**
  - full `vitest`: 3,427 tests. The load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `App` files pass when run alone;
  - `tsc`.
- **Review:** an adversarial review found eight problems, all fixed:
  - choosing Next beat while stopped on a measure that is never played (after a Fine or a skipped jump) could throw during rendering and close the app. The view no longer asks for playback choices; it reads the plan's performed beats, which cannot throw;
  - Next beat counted from a grace note's lead-in, so it could show the selected beat itself;
  - a "%" measure showed nothing, and the measure it copies drew doubled notes;
  - Next beat ignored the loop and range ends;
  - during count-in it skipped the beat playback was about to start on, and the ended phase kept the playback position;
  - every status tick rebuilt the selected beat and bar notes, and stopped Next beat validated the whole plan on every render;
  - `instruments.mjs` no longer covered startup requests and did not assert its blocked-request list. Startup requests are now named as not covered, and the list is asserted;
  - a failed playback showed an ordinary empty message, and the note list was a generic element with a label. It is now a named group, with an explicit failure message.

  The fixes were checked by the tests above, not by a second review.

## Limits
- U13 is partial:
  - there is no click-to-select on the instrument itself; the selection comes from the score;
  - Selected beat follows the edit target's voice only, not every voice at that position;
  - a tied continuation has no planned note of its own, so selecting it shows nothing;
  - changing the Show choice is not announced to screen readers;
  - `instruments.mjs` does not observe requests made during startup;
  - no original-GP8 comparison.
