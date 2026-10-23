# GP8 parity A12: octaver and pitch shift (2026-10-23)

GP8's effect pedals include an octaver and a pitch shifter (whammy). This slice adds both to TabPlayer as native effect blocks on every track's sound, editable in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Blocks:** Octaver and Pitch shift sit between the wah and the amp: Gate, Compressor, Wah, **Octaver**, **Pitch shift**, Amp and the later blocks. Each can be turned on and off, and each control change is one recorded, undoable sound edit.
- **Octaver:**
  - Separate levels (0–1) for **Octave down**, **Two octaves down** and **Direct** (the input).
  - It is polyphonic, so chords move down together.
  - The levels add, so all three at full can be up to three times as loud.
- **Pitch shift:**
  - **Semitones** from −24 to +24, in whole steps, and **Mix** (0–1) between dry and shifted.
  - A fixed setting acts as a whammy pedal held in one position.
- **How it works:**
  - Two read taps sweep a 40 ms delay line half a window apart, each faded in and out.
  - When a tap restarts, it searches up to 25 ms for the point where its waveform best continues the other tap's, so grains join in phase. The search covers one period of a 40 Hz bass low E.
  - The search compares every frame at a 12 kHz equivalent spacing, then refines, so its cost does not grow with the sample rate.
- **Latency:** the shifted sound reaches half its level about 19 ms after a note starts. The shifter has no feedback, so silence empties it to exact zero.
- **Changes and compatibility:**
  - Live changes ramp over 10 ms. Swinging from −12 to +12 mid-note does not click.
  - Sounds saved before these blocks load with them off at their defaults.
  - A block left at its defaults is not written, so older documents keep the same saved form.
  - The native engine and the editor both reject values out of range. The editor now also range-checks the wah's values.
- **Transposition:** the interval applies to whatever is played, so transposing the score moves the shifted sound with it.
- **Output:** the blocks apply to live playback, WAV and stem export, and practice-speed renders.

## Evidence
- **Native** (`src-tauri/tests/audio_pitch.rs`, 8 tests):
  - **Format and validation:**
    - the wire format, and loading an older document;
    - every range check;
    - exact bypass while the blocks are off.
  - **Intervals:**
    - −24, −12, −5, +7, +12 and +24 semitones move a tone to the target semitone;
    - +7 does so from 110, 220, 440 and 880 Hz, as when the score is transposed;
    - at least half the output power sits within half a semitone of the target, the level is 0.7–1.15 of the input, and the target has at least 20 times the power left at the input pitch;
    - the interval holds at 44.1 and 96 kHz;
    - mix 0.5 keeps both the dry and the shifted tone.
  - **Octaver:**
    - an A plus C♯ chord moves down an octave together;
    - two octaves down lands at 110 Hz from 440 Hz;
    - Direct alone is the input;
    - Octave down 0.5 with Direct 1 gives a 2.3:1 amplitude ratio.
  - **Bass:**
    - an 82 Hz octave down, an 82 Hz +12, a 110 Hz −12 and a 41 Hz −5 each keep over 80% of the power at the target, and in practice 93–99%;
    - the target has at least 100 times the power left at the input pitch.
  - **Latency and changes:**
    - +12, −12 and the octaver reach half level 10–30 ms after onset, measured at 19 ms;
    - 0 → +12 and −12 → +12 changes mid-note stay within 1.6× a steady octave tone's largest step;
    - tails reach exact zero.
  - **Mutation check:** with the waveform alignment disabled, the +24 case fails.
  - **CPU:** a temporary release benchmark ran one second of audio on one track:

    | Sample rate | Effect | Share of a core | Worst frame |
    |---|---|---|---|
    | 48 kHz | +24 semitones | 0.8% | 0.14 ms |
    | 48 kHz | Octaver | 0.7% | 0.05 ms |
    | 192 kHz | +24 semitones | 2.1% | 0.05 ms |
    | 192 kHz | Octaver | 2.5% | 0.17 ms |

    The first version, before review, measured 53% and 3.8 ms for +24 semitones at 192 kHz.
- **Editor** (`src/audio/pitch-effects.test.tsx`):
  - the defaults;
  - completing older sounds;
  - the block order;
  - each control's recorded edit;
  - the semitone limits, and that out-of-range input is not sent;
  - out-of-range saved or imported values are rejected.
- **Desktop:** `tests/desktop/parity-pitch-effects.mjs` on a Windows desktop-test build exported WAV files through the real Export dialog.
  - **Pitch shift:** +12 raised the power one octave above the dry render's strongest pitch (494 Hz) from 0.32 to 25.8 times that pitch's power.
  - **Octaver:** Octave down raised the power one octave below from 0.039 to 2.8 times.
  - **Transposed:** after transposing the score up a fourth, the strongest pitch moved to 659 Hz. +12 raised its octave from 0.10 to 3.1 times. The wet-to-dry level was +0.34 dB before and +0.19 dB after.
  - **Edits:**
    - switched off at its defaults, the pitch block was omitted from the saved sound;
    - the final edits held the octaver levels and the pitch setting;
    - live Play produced native output with no error;
    - Undo turned the pitch shift off again;
    - there were no page errors.
  - `parity-wah-effect.mjs`, `parity-modulation-effects.mjs` and `exports.mjs` still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice;
  - the full `vitest` suite: 3,442 tests, with the load-sensitive `tuning-ui`, `corpus` and `WorkspaceApp` files passing when run alone;
  - `tsc`.
- **Review:** an adversarial review found no index-bounds, wrap-detection, NaN or serialization defect. It reported these issues, all fixed:
  - **High:** the waveform search cost grew with the square of the sample rate, up to 3.8 ms in a single frame at 192 kHz, which risked audio underruns. It is now a coarse-to-fine search at constant cost, without a per-frame modulo.
  - the 10 ms search could not match notes below 100 Hz. It now searches 25 ms, and bass notes are tested;
  - transposition independence and latency were not tested;
  - the alignment anchor used the other tap's phase from the previous frame;
  - the editor did not range-check the new values.

  It also noted that the octaver's summed levels can exceed unity. That is kept as intended and listed under Limits. The fixes were checked by the tests above, not by a second review.

## Limits
- A12 is partial:
  - **no whammy sweep:** a whammy's pitch cannot be automated over the score. Semitones is a fixed setting;
  - **sound character:** it is a grain-based shifter, so sustained chords can warble slightly, and there is no formant correction or GP8-specific pedal model;
  - **latency:** about 20 ms, so it is not suited to tight live monitoring;
  - **octaver gain:** the summed levels can exceed unity;
  - **not run:** `native-audio.mjs` was not run, because it reloads into session recovery and fails before this slice;
  - **no reference:** there is no comparison with original GP8 audio.
