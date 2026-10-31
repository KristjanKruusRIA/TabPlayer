# GP8 parity A15: room, hall, plate and spring reverbs (2026-10-23)

GP8 offers several reverb types. TabPlayer had one reverb, with Room, Damping and Mix controls. This slice adds a choice of model to each track's Reverb block, in the native player and in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Reverb model:** a new list in the Sound task's Reverb block, with Room, Hall, Plate and Spring. The Room, Damping and Mix controls work for every model.
  - **Room** is the original reverb, unchanged. It is short and its output is the same on both channels.
  - **Hall** waits 20 ms before its first reflections and rings longest. It is darker: its input loses highs above about 5 kHz, as in a large room's air.
  - **Plate** answers at once with dense reflections and stays brightest.
  - **Spring** has a narrow band (120 Hz to 3.5 kHz) and the chirp of a real spring: every trip along it delays low notes more than high ones.
- **Controls:** for hall, plate and spring, Room sets the decay time:
  - hall: 1.2 to 6 s;
  - plate: 0.8 to 4.4 s;
  - spring: 0.8 to 2.8 s.

  Damping sets how much faster 3 kHz decays than the low end. That holds at any sample rate.
- **Level:** hall, plate and spring are about as loud as the room, and their two channels are decorrelated.
- **Edits:** every change is recorded as an undoable track-sound edit. While playing, a change of model crossfades both models over 10 ms. A model switched back to starts silent, so an old tail cannot come back.
- **Saved documents:**
  - reverbs saved before this slice load as the room with their settings;
  - the room is not written, so their saved form is unchanged;
  - the editor refuses the same models the native player does.

## Evidence
- **Native** (`src-tauri/tests/audio_reverb.rs`, 11 tests, 48 kHz unless stated):
  - **Format:** wire format, older documents, an explicit `"room"`, unknown fields and unknown models.
  - **Room unchanged:** the room's output is bit-identical to the committed code before this slice. Fingerprints cover an impulse, a 0.2 → 0.8 → 0.5 Room ramp, and a fade on and off.
  - **Decay times** (RT60 at Room 0.1 / 0.5 / 0.9). Each rises with Room, and at the same setting a hall rings longest and a room shortest:

    | Model | Room 0.1 | Room 0.5 | Room 0.9 |
    |---|---|---|---|
    | Room | 0.37 s | 0.67 s | 1.67 s |
    | Hall | 1.36 s | 3.04 s | 4.72 s |
    | Plate | 0.94 s | 2.14 s | 3.33 s |
    | Spring | 0.74 s | 1.37 s | 1.99 s |
  - **Colour:** energy in the 6 kHz octave against the 1 kHz octave, from 50 ms to 1.5 s: plate +4.1 dB, hall −0.5 dB, spring −7.0 dB.
  - **Onset:** 20.0 ms for the hall, 0 ms for the plate.
  - **Spring dispersion:** the spring's 300 Hz band trails its 2.4 kHz band by 8.8 ms; the hall's by 0 ms.
  - **Level and stereo:** each model is within ±6 dB of the room on noise, with channel correlation below 0.7.
  - **Model changes:** switching models through both `set_settings` and the prepared-configuration path that live edits use steps no more than 1.25× the larger settled step.
  - **No stale tails:** hall → plate → hall, room → spring → room, and hall → off → hall leave no old tail on either path. This was confirmed to fail with the reset removed.
  - **Silence and bypass:** every model's tail decays to exactly zero, and once switched off the reverb passes input through exactly.
  - **Sample rates:** at 8, 44.1, 96 and 192 kHz each model's output stays finite and decays to zero. Its decay time, overall and in the 2 kHz octave, is within 20% of 48 kHz. This was confirmed to fail with damping set at the Nyquist frequency.
- **Editor** (`src/audio/reverb-models.test.tsx`, 4 tests):
  - the room default;
  - older and undefined models read as the room, keeping their settings;
  - the Reverb model list and its recorded edit;
  - models the native player rejects are refused.
- **Desktop:** `tests/desktop/parity-reverb-models.mjs` on a Windows desktop-test build. The export is one plucked steel-guitar B3 quarter note, exported as WAV through the Export dialog with Mix 0.5:

  | Export | Tail at 0.9–1.4 s | 6 kHz vs 1 kHz | L/R correlation |
  |---|---|---|---|
  | Dry | −65.1 dB | | |
  | Room | −41.8 dB | −14.4 dB | 1.00 |
  | Hall | −10.7 dB | −17.3 dB | −0.16 |
  | Plate | −21.3 dB | −15.5 dB | −0.29 |
  | Spring | −24.8 dB | −18.4 dB | −0.11 |

  The tail is measured against the note's first half second.
  - The final edit recorded `{enabled:true, model:'spring', room:0.5, damping:0.5, mix:0.5}`.
  - Playback ran live; Undo restored Plate; there were no page errors.
  - The drive, wah, modulation, export, sound-library and sound-preview desktop tests still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice (681 tests);
  - the full `vitest` suite: the load-sensitive `corpus`, `tuning-ui` and `WorkspaceApp` files pass when run alone;
  - `tsc`.

## Review
- **First adversarial review:** approved, with four medium findings, all fixed:
  - damping was set at the Nyquist frequency, so colour changed with the sample rate. It is now set at 3 kHz;
  - the spring's decay ignored the delay its allpass chains add to each loop. That delay is now counted;
  - every model carried the spring's chain state, and the spring advanced each filter separately. Only the spring now has a chain, with one shared position;
  - no test ran at another rate.

  Low findings fixed:
  - `completeSound` kept an undefined model;
  - the room fingerprint covered only an impulse;
  - stale tails were tested for one pair of models only;
  - bypass was tested only on a reverb built already off.
- **Second review:** approved. It noted that the spring's upper band decays somewhat faster than its damping setting says, because its chains delay high frequencies less. That is now documented in the code.

## Limits
- **Room stays mono and short:** it is kept exactly as before, so older documents sound the same.
- **Re-enabling:** turning a room reverb off and on again now starts it silent instead of replaying its frozen tail. This applies only to in-place edits; live playback already started fresh.
- **Generic models:** these are TabPlayer's own algorithms, not models of GP8's reverbs, and there is no listening comparison with GP8.
- **Control labels:** Room is a size and decay control for every model, and its label matches the Room model's name.
- **Real-time cost:**
  - a model starting again clears its lines within one audio frame, up to about 0.5 MB for a hall at 192 kHz;
  - an edit made within 10 ms of a model change drops the outgoing model at once, as other blocks do.
- **Older builds:** a sound saved with hall, plate or spring cannot be opened by builds from before this slice.
