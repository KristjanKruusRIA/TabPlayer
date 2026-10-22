# GP8 parity A20: focus and unfocus the selected track (2026-10-22)

GP8's mixer can focus the selected track, so it stands out from the rest, or unfocus it, so you can play along over the others. This slice adds a session-only Focus control to the Mixer. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Mixer → Focus:** a slider from Unfocus 100% through Off to Focus 100%, and a Reset focus button. It is labelled "Not saved".
  - **Focus** lowers every other track, and the backing, by the chosen amount.
  - **Unfocus** lowers the selected track itself.
  - The control is enabled only while playback is ready and free of errors.
  - When the selected track is muted, or silent because another track is soloed, the panel explains that focusing it lowers everything you hear.
- **Selection:** focus belongs to the selected track by its identity, and moves with the selection.
- **What focus does not touch:**
  - It ends when its track is removed, so undoing the removal does not bring it back.
  - It ends when another document loads.
- **Audio (`src/audio/focus.ts`, `NativePlaybackController`):**
  - Focus scales only the gains sent to native audio, through the existing mix update.
  - Pan, mute and solo stay as saved.
  - The saved mix, the project and the undo history are never edited.
  - Exports use the saved mix.
  - Changing focus never prepares playback again. A focus or mix change made while a preparation is running is sent once the preparation finishes, instead of restarting it. This also stops saved mix edits during a preparation from restarting it.
- **Test hook:** desktop-test builds record the settings of each preparation and mix that native audio accepted, so end-to-end tests can check gains. Other builds record nothing.

## Evidence
- **Frontend:**
  - `focus.test.ts`:
    - focus and unfocus gains, including the backing;
    - the saved settings are left untouched;
    - no-op cases and invalid amounts.
  - `NativePlaybackController.test.ts`:
    - session focus sends `setMix` without an edit or a new preparation;
    - focus stays on top of saved mix edits;
    - focus is cleared by zero and by a new document;
    - invalid track and amount are refused;
    - focus and selection changes made during a preparation are sent once it finishes, with a single preparation and the same generation;
    - focus ends with track removal and stays off after undo.
  - `TrackPanel.test.tsx`:
    - the slider sweep, its labels and Reset;
    - focus follows the selection by identity;
    - the control waits for ready, error-free playback;
    - the silent-track note.
  - RED log: `.analysis/parity/focus-red.log`.
  - **Mutation checks:** restarting the preparation on a focus change, or keeping focus after its track is removed, each fail a test.
- **Desktop (Windows desktop-test build):** `tests/desktop/parity-focus.mjs` opens the four-track fixture, selects Bass6, and sweeps focus to 50%, plays, then sweeps to Unfocus 100%. It asserts:
  - the mixes native audio accepted list every track and change only gains, 0.5/1/0.5/0.5 and then 1/0/1/1;
  - selecting Guitar9 moves the focus there, playback continues with the same generation, and there are no errors;
  - Reset sends the saved mix itself;
  - no preparation was added;
  - the project is unchanged;
  - there are no page errors.
- **Review:** an Opus adversarial review found these issues, all fixed with tests:
  - a selection during preparation restarted it;
  - focus revived on undo after its track was removed;
  - focus was resolved by index against a stale score;
  - the control was enabled while playback was not ready;
  - no explanation for silent tracks;
  - weak desktop assertions.

## Limits
- A20 is partial:
  - Focus scales linear gain. GP8's exact focus curve is not known.
  - There is no original-GP8 comparison, and no measurement of per-track output levels. The desktop test checks the gains native audio accepted.
- Focus is per session and is not kept across restarts, as the control's label says.
