# GP8 parity A07: overdrive, distortion and fuzz drive pedals (2026-10-23)

GP8 offers separate drive pedals besides amp saturation. This slice adds a Drive pedal with three families to each track's effect chain, in the native player and in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Drive pedal:** a new block in the Sound task, between Pitch shift and Amp, and in the same place in the native chain. It is off by default.
- **Controls:**
  - **Drive model:** Overdrive, Distortion or Fuzz.
  - **Drive:** 0 to 1. **Tone:** 0 to 1, a low-pass from 500 Hz to 12 kHz. **Level (dB):** −24 to +12.
- **The three families:**
  - **Overdrive** rounds off gently (`tanh`) with up to 41× gain, so it still responds to playing strength.
  - **Distortion** clips hard past a short cubic knee with up to 401× gain.
  - **Fuzz** clips with up to 2,001× gain, after offsetting its input by a share of the playing level. Its clipping is lopsided, so it adds even harmonics.
- **Level:** a loud note leaves at about the level it arrived, whatever the model and drive setting. Level then scales the output.
- **Sound quality:** the clipping runs four times oversampled, as the amp does, followed by a 10 Hz DC blocker. The fuzz's offset follows the playing level with a 20 ms attack, so a note's start does not thump.
- **Edits:**
  - every change is recorded as an undoable track-sound edit;
  - while playing, a change crossfades over 10 ms, clipping with both the old and new curves when they differ.
- **Saved documents:**
  - documents and sounds saved before this slice load with the pedal off;
  - a pedal left at its defaults is not written;
  - the editor refuses the same values the native player does.

## Evidence
- **Native** (`src-tauri/tests/audio_drive.rs`, 10 tests, on 0.1-peak sines at 48 kHz):
  - **Format:** wire format, older documents, unknown fields refused. Each out-of-range value or unknown model is refused by name.
  - **Bypass:** off is an exact bypass.
  - **Harmonics at drive 0.5:**
    - overdrive and distortion keep even harmonics below 10⁻⁴ of the fundamental's power;
    - fuzz's second harmonic is above 10⁻²;
    - total harmonic distortion rises from overdrive to distortion to fuzz, and with drive in every family.
  - **Level:** within ±3 dB of the input at drive 0, 0.5 and 1.
  - **Compression:** a note 20 dB quieter comes out 10.29 dB quieter with overdrive, 0.31 dB with distortion and 0.03 dB with fuzz.
  - **Tone:** tone 0 lowers harmonics 5 to 9 by more than 10 dB.
  - **Level control:** −6 dB and +12 dB scale the output to within 0.01 and 0.08 of the exact ratios.
  - **Aliasing:** a 3.1 kHz tone at full drive with the tone control open: the folded harmonics 8 to 20 sum to −67.8 dB (overdrive), −54.0 dB (distortion) and −49.3 dB (fuzz) relative to the tone.
  - **Edits:** edits through both `set_settings` and the prepared-configuration path that live edits use (`transition_from`) step no more than 1.25× the larger settled step of either setting. The fuzz's DC offset stays below 5% of the note's level and settles below 1% within 100 ms. Silence decays to exactly zero.

  The prepared-configuration and offset tests were each confirmed to fail with their fix removed.
- **Editor:**
  - `src/audio/drive-effect.test.tsx` (4 tests): defaults; filling the pedal into older sounds; the block's place and its controls being recorded; out-of-range values not sent; the editor's validation matching native.
  - The chain-order assertions in the wah, pitch and modulation tests include Drive.
- **Desktop:** `tests/desktop/parity-drive-effect.mjs` on a Windows desktop-test build, a sustained steel-guitar B3 exported as WAV through the Export dialog, drive 0.8:

  | Export | Sustain | Crest factor |
  |---|---|---|
  | Dry | −18.2 dB | 5.08 |
  | Overdrive | −10.3 dB | 2.87 |
  | Distortion | +0.3 dB | 1.43 |
  | Fuzz | +1.2 dB | 1.56 |

  Sustain is the level of the note's fourth half second against its first. Crest factor is peak over RMS.
  - Level −6 dB lowered the fuzz export by 6.00 dB.
  - The final edit recorded `{enabled:true, model:'fuzz', drive:0.8, tone:0.5, levelDb:-6}`.
  - Playback ran live; Undo restored the level; there were no page errors.
  - `parity-wah-effect.mjs`, `parity-pitch-effects.mjs`, `parity-modulation-effects.mjs`, `exports.mjs`, `parity-sound-library.mjs` and `parity-sound-preview.mjs` still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice;
  - the full `vitest` suite, with the load-sensitive `App`, `tuning-ui`, `corpus`, `library/content` and `WorkspaceApp` files passing when run alone;
  - `tsc`.

## Review
- **First adversarial review:** approved, with two medium findings, both fixed:
  - the live-edit path was not tested; it now is;
  - the fuzz's offset made a low thump at each note's start. The offset now follows the playing level with a 20 ms attack instead of 1 ms, and the DC blocker is a rate-independent 10 Hz.

  Low findings fixed:
  - the audio thread recomputed the curve, gains, tone and level for each sample; settings are now resolved once per change, without allocation;
  - fading the pedal on or off also ran both curves;
  - the aliasing test ran with the tone control darkening the output and checked two folds only;
  - +12 dB was untested.
- **Second review:** approved the fixes. It noted that, with the slower attack, the fuzz's offset settles slightly below the share its level matching assumes. That leaves the fuzz a fraction of a dB off its reference level, within the ±3 dB test.

## Limits
- **Not transparent:** like the amp, the oversampling filters and the tone control at its brightest still cut about 15 dB at 10 kHz, even at drive 0.
- **Generic families:** these are TabPlayer's own clipping curves, not models of specific GP8 pedals, and there is no listening comparison with GP8.
- **Desktop measures:** an exported guitar note shows clipping as sustain and flatter peaks. Its own strong harmonics hide the clipping's harmonic ratios, so the harmonic signatures are measured only on sines.
- **One pedal per track:** there is one Drive pedal in a fixed place in the chain.
- **Labels:** the numeric controls follow the panel's existing naming, so a screen reader announces “drive Drive”.
