# GP8 parity A16: digital, tape and analog delays with named divisions (2026-10-23)

GP8 offers several delay types and tempo-synced divisions. TabPlayer had one clean delay with a time in quarter notes chosen from 1/8, 1/4, 1/2, 1, 2 and 4. This slice adds a choice of delay model and named straight, dotted and triplet divisions to each track's Delay block, in the native player and in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Delay model:** a new list in the Sound task's Delay block, with Digital, Tape and Analog. The Feedback and Mix controls work for every model.
  - **Digital** is the original delay, unchanged: each repeat is an exact copy.
  - **Tape** repeats pass through a 4.5 kHz low-pass and an 80 Hz high-pass and round off in a soft clipper. They are read from a delay that wanders with slow wow (0.6 Hz) and fast flutter (7 Hz).
  - **Analog** repeats are darker (2.2 kHz low-pass, 60 Hz high-pass), clip more gently and drift slowly (0.4 Hz).
  - The filters act on every repeat, so each tape or analog repeat is darker than the last. The clipper divides its gain out again, so quiet repeats keep their level.
- **Delay time:** the list now names its divisions and adds triplets and dotted values. The divisions are 1/32, 1/16, 1/8 triplet, 1/8, 1/4 triplet, Dotted 1/8, 1/4, Dotted 1/4, 1/2 and Whole. The time follows the score's tempo as before.
- **Edits:** every change is recorded as an undoable track-sound edit. While playing, a change of model crossfades over 10 ms. Tape or analog returning after a digital stretch starts with clear filters, so it cannot replay a stale state.
- **Saved documents:**
  - delays saved before this slice load as digital with their settings;
  - digital is not written, so their saved form is unchanged;
  - the editor refuses the same models and divisions the native player does.

## Evidence
- **Native** (`src-tauri/tests/audio_delay_models.rs`, 9 tests, 48 kHz):
  - **Format:** the wire format, older documents, unknown fields, unknown models, and the ten divisions against another duration.
  - **Digital unchanged:** the digital delay's output is bit-identical to the committed code before this slice. The fingerprints cover two runs of integer-generated noise bursts, so they rely on no platform maths library:
    - a run through three times and feedbacks as the tempo drifts;
    - a run that switches the delay off, on and off.
  - **Timing:** at 120 bpm, with Dotted 1/8, 1/8 triplet, Dotted 1/4 and 1/4 triplet, the first three repeats land on each multiple of the division. They land within 0.5 ms for digital and 3 ms for tape and analog, whose delays wander.
  - **Repeats** of a 2 ms noise burst at feedback 0.6. The colour share is how much of each repeat's energy a one-pole split puts above 1 kHz, from the first repeat to the fourth:

    | Model | Repeat levels (1st → 4th) | Colour share | Pitch wobble | Peak at feedback 0.9 |
    |---|---|---|---|---|
    | Digital | 0.0451 → 0.0271 → 0.0162 → 0.0097 (×0.6 each) | 0.963, constant | 0 cents | 7.29 |
    | Tape | 0.0198, 0.0075, 0.0037, 0.0019 | 0.877 → 0.637 | 13.9 cents | 0.645 |
    | Analog | 0.0130, 0.0048, 0.0023, 0.0012 | 0.783 → 0.471 | 1.53 cents | 0.793 |

    Each tape and analog repeat is darker and quieter than the digital one, and analog ends darker than tape.
  - **Saturation:** a loud 240 Hz tone whose period divides the delay builds up at feedback 0.9. Tape's peak stays below 0.7× digital's.
  - **Model changes:** switching between models with both `set_settings` and the prepared-configuration path that live edits use steps no more than 1.25× the larger settled step.
  - **No stale state:** after tape filters hold a loud steady input, a switch to digital and back to tape gives exact silence on both paths. This was confirmed to fail with the reset removed from either path.
  - **Silence and bypass:** tape and analog tails decay to exactly zero. The digital tail falls below 1e-20, because the original delay never flushed it. Once switched off, every model passes input through exactly.
- **Editor** (`src/audio/delay-models.test.tsx`, 5 tests):
  - the digital default;
  - older and undefined models read as digital, keeping their settings;
  - the Delay model and Delay time lists with their recorded edits, and a saved triplet shown by name;
  - models and divisions the native player rejects are refused;
  - a saved sound keeps its model and division.
- **Desktop:** `tests/desktop/parity-delay-models.mjs` on a Windows desktop-test build. The export is one plucked steel-guitar sixteenth note at 120 bpm, exported as WAV through the Export dialog with Mix 0.5 and Feedback 0.5. Half the dry export is subtracted, which leaves the repeats alone:

  | Export | Division | First repeat | Tone loss, 1st / 2nd repeat | 2nd / 1st level |
  |---|---|---|---|---|
  | Digital | 1/4 (0.5 s) | 0.500 s | 0.00 / 0.00 dB | 0.500 |
  | Digital | Dotted 1/8 (0.375 s) | 0.376 s | | |
  | Digital | 1/8 triplet (0.167 s) | 0.168 s | | |
  | Tape | 1/4 | 0.502 s | 0.82 / 1.34 dB | 0.477 |
  | Analog | 1/4 | 0.502 s | 1.91 / 3.05 dB | 0.451 |

  Tone is the 5 kHz octave against the 500 Hz octave over the first 100 ms of the note and of each repeat. Onsets are measured on a 2 ms envelope. The tone losses show the ordering: digital stays flat, each repeat is darker than the last, and analog is darker than tape. They are not calibrated filter responses. The wide band-passes and the note's own spectrum dilute them, and tape's low-pass alone is about −3.3 dB at 5 kHz.
  - The final edit recorded `{enabled:true, model:'analog', quarterNotes:1, feedback:0.5, mix:0.5}`.
  - Playback ran live; Undo restored Tape; there were no page errors.
  - The drive, reverb, modulation, export, sound-library and sound-preview desktop tests still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice;
  - the full `vitest` suite: the load-sensitive `corpus`, `tuning-ui` and `WorkspaceApp` files pass when run alone;
  - `tsc`.

## Review
- **First adversarial review:** approved, with no high or medium findings. Low findings fixed:
  - tape and analog filters stood still during a digital stretch, so a return to tape began from their old state. A change from digital now clears them, on both edit paths;
  - the digital fingerprint input used `sin`, which can differ in the last bit between platforms. It now uses integer-generated noise;
  - the editor test did not show that a saved triplet displays by name.
- **Second review:** approved. Its notes are recorded under Limits: zeroing during a change, a tape delay switched off and on, and how to read the desktop tone losses.

## Limits
- **Mild tape colour:** tape's single-pole 4.5 kHz low-pass darkens each repeat gently. Analog is darker.
- **Generic models:** these are TabPlayer's own algorithms, not models of GP8's delays, and there is no listening comparison with GP8.
- **Edits mid-change:** an edit made within 10 ms of a model change restarts the crossfade from its target, as other blocks do. Returning to tape or analog during a change away from it clears their filters while they still sound, which briefly dips the coloured part of the echo.
- **Off and on again:** a tape or analog delay switched off and on keeps its filter state and its old echoes, as the digital delay always has. The fade-in hides it.
- **Long delays at slow tempos:** a delay held at its 16-second cap wobbles on one side only.
- **Older builds:** a sound saved with tape, analog or a new division cannot be opened by builds from before this slice.
