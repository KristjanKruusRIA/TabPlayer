# GP8 parity A13: wah models (2026-10-24)

GP8 offers several wah pedals. TabPlayer's Wah block had one generic model, a band-pass swept from 350 Hz to 2.2 kHz. This slice adds a choice of four wah models, each with its own sweep and peak. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Wah model:** the Wah block in the Sound task has a Wah model list next to Wah mode. Choosing a model is one undoable track-sound edit. The pedal position, mode, resonance, sensitivity and mix work the same with every model.

  | Model | Heel | Toe | Peak |
  |---|---|---|---|
  | Classic | 350 Hz | 2.2 kHz | as before |
  | Vintage (vocal) | 450 Hz | 1.6 kHz | narrower, more vocal |
  | Wide range | 250 Hz | 3.5 kHz | broader |
  | Bass | 120 Hz | 1 kHz | as the classic, for bass |

  Every model passes the frequency the pedal points at at unity, so changing model keeps the level of the note under the pedal.
- **Playback:** the classic model plays exactly as the wah did before models. Changing model while playing moves the peak to the new model's frequency over 10 ms, in octaves, without a click.
- **Second pedalboard:** a duplicated wah keeps its model and has its own Wah model list.
- **Saved documents and sounds:**
  - a classic wah is written exactly as before, without a model;
  - a wah saved before models loads as the classic, on either pedalboard;
  - the editor and the native player refuse an unknown model;
  - saved sounds in My sounds keep the model.

## Evidence
- **Native** (`src-tauri/tests/audio_wah_models.rs`, 5 tests):
  - **Format:** a classic wah has no `model` field, and a wah saved before models loads as the classic. Each model round-trips and is written by name. An unknown model is refused with "Unknown wah model." by validation and by the player, also on a second pedalboard.
  - **Classic unchanged:** a manual and an auto wah, over a swept tone with pedal, mix and resonance edits, give bit-identical output to the wah before models. The fingerprints were recorded from the earlier code, and the reviewer confirmed them against it.
  - **Sweeps:** for every model, the loudest frequency at the heel, the middle and the toe is within a semitone of the table, and it passes at 0.9 to 1.06. An octave above the centre, the vintage model passes under 0.8 of what the classic does. The wide model passes over twice what the classic does at 3.5 kHz at the toe, and the bass model over twice what it does at 120 Hz at the heel.
  - **Auto mode:** with every model, a soft note leaves the filter at the heel, and a loud one opens it toward the toe.
  - **No clicks:** a 700 Hz tone plays at the toe, at full resonance, while the model changes from classic to bass, wide, vintage and back. This is tested on both `set_settings` and the prepared-configuration path. The largest kink, the change in slope between frames, is no more than 1.25× the settled one around each change. If the centre jumps instead of sweeping, the test fails at 1.6×; if the damping jumps, it fails at 6.5×. Settled on the bass model, the tone is over 1.5× louder than on the classic, so the change is heard.
  - **Existing wah:** the six earlier wah tests pass unchanged.
- **Editor** (`src/audio/wah-models.test.tsx`, 3 tests):
  - the default is the classic. A wah saved without a model reads as the classic on either pedalboard, and an unknown model is refused on either. This was confirmed to fail when the model is not filled in;
  - the Wah model list offers Classic, Vintage (vocal), Wide range and Bass, and records one edit that changes only the model. A duplicated wah keeps its model, and its own list changes only the duplicate;
  - a saved sound keeps its model.
- **Desktop:** `tests/desktop/parity-wah-models.mjs` on a Windows desktop-test build, with sustained A2 and B2 on a steel-string guitar and the pedal at the toe, exported as WAV through the Export dialog. Brightness is the RMS of the first difference over the RMS of the signal; treble uses the second difference, which weighs the top of the sweep more:

  | Model | Brightness | Treble |
  |---|---|---|
  | Classic | 0.214 | 0.069 |
  | Bass | 0.131 | 0.020 |
  | Wide range | 0.181 | 0.088 |
  | Vintage (vocal) | 0.176 | 0.045 |

  - the classic export matches the earlier wah test's toe export exactly (0.214);
  - each model change was recorded as one sound edit with the pedal and switch unchanged;
  - changing the model while playing gave no errors, and Undo restored the previous model;
  - the earlier wah, wah gesture, second-pedalboard and factory-sound desktop tests still pass.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 745 tests;
  - the full `vitest` suite: the load-sensitive files pass when run alone;
  - `tsc`;
  - `rustfmt` on the changed native files.

## Review
- **Adversarial review** of the audio thread: approved.
  - It compiled the earlier and the new DSP side by side and confirmed both fingerprints.
  - The click test fails both broken builds, at 39.8× and 37.1×, against 1.12× for the real code.
  - It found no instability for any model, resonance or mode at 8 to 192 kHz with noise, square waves and impulses, with the model flipping every 50 ms.
  - It found no allocation, locking or panics on the audio thread, and the editor and native rules agree.
  - **Low, left as a limit:** a second change within the 10 ms crossfade starts from the first change's target rather than what was playing. A second model change 5 ms after the first kinks at 28.7× the settled level. Resonance and mix changes already do this, at 422× and 215×.
  - **Low, covered by the review's probes:** the native tests run at 48 kHz only and do not change model twice within a crossfade.

## Limits
- **Automation:** the pedal position still cannot be automated over the score.
- **Models are approximations:** the four models are sweeps and peak widths chosen to resemble common pedal types. They are not measured from GP8's pedals or from hardware, and there is no original-GP8 audio comparison.
- **Changes within 10 ms:** a second model change within the 10 ms crossfade of the first starts from the first change's target. It can kink audibly, as resonance and mix changes already can.
- **Auto mode:** the auto wah follows the playing level with fixed attack and release times.
- **Older builds:** a sound with a wah model other than the classic cannot be opened by builds from before this slice.
