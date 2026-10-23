# GP8 parity A10 and A11: flanger, phaser, tremolo and vibrato (2026-10-23)

GP8's effect pedals include a flanger, a phaser, a tremolo and a vibrato. This slice adds all four as native effect blocks on every track's sound, editable in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Blocks:** the Sound task lists the new blocks in their processing order: Gate, Compressor, Amp, Cabinet, EQ, **Vibrato**, **Phaser**, **Flanger**, Chorus, **Tremolo**, Delay, Reverb. Each block can be turned on and off, and each control change is one recorded, undoable sound edit.
- **Vibrato:**
  - Rate is 1–14 Hz, and depth is 0–100 cents.
  - It is a swept delay, so the pitch swings by the set number of cents either way at the set rate. The sample rate does not change the depth.
- **Phaser:**
  - Rate is 0.05–5 Hz, depth 0–1, feedback 0–0.9 and mix 0–1, with 2, 4, 6 or 8 stages.
  - All-pass stages sweep notches between 200 Hz and 6.4 kHz. The left and right channels sweep a quarter cycle apart.
- **Flanger:**
  - Rate is 0.05–5 Hz, depth 0–10 ms, feedback −0.9 to 0.9 and mix 0–1.
  - It is a delay that sweeps from 0.1 ms to 0.1 ms plus the depth, with feedback.
- **Tremolo:**
  - Rate is 0.1–20 Hz and depth 0–1.
  - The shape is Sine or Square. The square has smoothed edges, so it does not click.
- **Level:**
  - High phaser or flanger feedback does not raise the output level: the wet signal is scaled by (1 − feedback).
  - Feedback tails decay to exact silence.
- **Live changes:**
  - Switching a block on or off, and changing a value, ramps over 10 ms as the existing blocks do.
  - Vibrato and flanger depth changes glide at most half a semitone of pitch bend, so the audio never scrubs.
  - Changing the phaser's stage count crossfades between stages, so it does not click.
- **Compatibility:**
  - Sounds saved before these blocks load with them switched off at their defaults.
  - A block left at its defaults is not written, so older documents keep the same saved form.
  - Sound edits that are replayed, copied to a duplicated track or sent from the panel are filled in the same way.
  - Invalid stage counts, shapes and ranges are rejected natively and in the editor.
- **Output:** the same blocks apply to live playback, WAV and stem export, and practice-speed renders.

## Evidence
- **Native** (`src-tauri/tests/audio_modulation.rs`, 11 tests):
  - wire names, defaults, and loading an older document;
  - every range, stage-count and shape check;
  - exact bypass while the blocks are off.
  - **Tremolo:** the level falls at the set period of 12,000 frames at 4 Hz, to the set depth; the square shape dwells and steps.
  - **Vibrato:**
    - a 440 Hz tone reaches the expected cent limits within 1.5 Hz, and its mean pitch and level are unchanged;
    - the same holds at 44.1 kHz.
  - **Flanger:** impulse echoes sweep from 5 to 149 frames, with a second echo at about half level.
  - **Phaser:** a notch sweeps a steady tone below 0.3 of its peak level, and the channels differ.
  - **Review regressions:**
    - live vibrato rate and depth changes keep the pitch within 400–485 Hz;
    - changing the phaser's stages (8 → 4 → 8) causes no step beyond the steady signal;
    - at full feedback the phaser peaks below 1.05 and the flanger below 1.1, at 200 Hz, 1 kHz and 5 kHz;
    - the feedback tails reach exact zero.
- **Editor** (`src/audio/modulation-effects.test.tsx`): the panel order, controls and selects. It also covers recorded edits, completing older sounds, and rejecting invalid stages or shapes.
- **Desktop:** `tests/desktop/parity-modulation-effects.mjs` on a Windows desktop-test build exported WAV files through the real Export dialog.
  - **Tremolo:** 4 Hz level modulation is 0.83 against 0.011 for the dry render.
  - **Other blocks:** the RMS difference from the dry render is 1.37 for vibrato, 0.67 for the phaser and 0.59 for the flanger.
  - **Edits and playback:**
    - the panel recorded at least 12 sound edits;
    - live Play produced native output with no error;
    - Undo turned the flanger off again;
    - there were no page errors.
  - `exports.mjs` still passes on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice. That includes `protocol` and `audio_dsp`;
  - the full `vitest` suite: 3,435 tests, with the load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files passing when run alone;
  - `tsc`.
- **Review:** an adversarial review reported six issues, all fixed and covered by the regression tests above:
  - live vibrato and flanger depth or rate changes jumped the delay and scrubbed the audio;
  - changing the phaser's stage count clicked;
  - feedback tails left denormal values running;
  - high feedback boosted the level up to tenfold;
  - a 0.1 Hz vibrato needed a long delay, which added latency;
  - replayed and duplicated sounds were not completed with the new blocks.

  The fixes were checked by the tests above, not by a second review.

## Limits
- A10 and A11 are partial:
  - **models:** each effect is one generic model, not GP8's specific pedal models or presets;
  - **missing controls:** there is no tempo sync for rates, and no automation of effect parameters over time;
  - **vibrato latency:** the vibrato adds an average delay of up to about 9 ms while it is on;
  - **chorus:** live depth changes on the existing chorus still jump, because it was not changed here;
  - **older builds:** a block that was edited but left off is written to the saved document. An older TabPlayer build rejects that document's sound;
  - **not run:** `native-audio.mjs` was not run, because it reloads into session recovery and fails before this slice;
  - **no reference:** there is no comparison with original GP8 audio.
