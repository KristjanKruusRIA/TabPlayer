# GP8 parity A10/A11: tempo sync for the modulation effects (2026-10-24)

GP8's modulation pedals can follow the song's tempo. TabPlayer's delay already set its time in note durations, but the chorus, flanger, phaser, tremolo and vibrato only had a free rate in hertz. This slice lets each of those five blocks follow the tempo instead, in the native player and in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Tempo sync:** each of the five blocks has a Tempo sync choice.
  - **Off (free rate):** the default. The block plays at its Rate (Hz) as before.
  - **Note durations:** the delay's ten durations (1/32 to Whole, with dotted and triplet ones), plus 2 and 4 whole notes for slow sweeps.
  - **Rate:** while synced, the block makes one cycle per chosen duration at the tempo playing at that moment, and its Rate field is disabled. A quarter note at 120 bpm is 2 Hz.
- **Tempo changes:** the rate follows tempo changes in the score and the practice speed. Playing at half speed halves the rate.
- **Range:** a synced rate stays within the block's free-rate range: chorus 0.1–8 Hz, flanger and phaser 0.05–5 Hz, tremolo 0.1–20 Hz, vibrato 1–14 Hz. A 1/32 note at 300 bpm would be 40 Hz, so the tremolo plays it at 20 Hz.
- **Unreadable tempo:** a tempo the player cannot read plays as 120 bpm, as the delay does.
- **Vibrato depth:** the vibrato's depth in cents holds at any synced rate.
- **Vibrato rate changes:** the vibrato glides to a new rate, whether from an edit, a tempo change or a sync change, slowly enough that its pitch bend stays near its depth. A change from 1 to 14 Hz takes about a second; a small change still takes the usual 10 ms. Before this slice, a large free-rate change briefly bent pitch many times deeper than set.
- **Edits:** choosing a duration, or Off, is one undoable track-sound edit. While playing, the change glides over 10 ms like the block's other settings.
- **Saved documents and sounds:**
  - a free rate writes no sync, so sounds saved before this slice load, play and save unchanged;
  - saved sounds in My sounds keep their sync;
  - copied pedals keep their sync;
  - the editor refuses the same sync values the native player does. Other blocks do not take a sync.

## Evidence
- **Native** (`src-tauri/tests/audio_tempo_sync.rs`, 7 tests):
  - **Format:** a free rate writes no `syncQuarterNotes` on any of the five blocks; a synced one writes and reads it back; a block without it reads as free. Every one of the 12 durations is valid, and 0.3, −1, NaN and 32 are refused with a tempo sync error.
  - **Synced equals free:** on every block, a synced rate renders bit for bit the same two seconds of noise as the free rate it works out to: a quarter note at 120 bpm against 2 Hz, an eighth at 150 bpm against 5 Hz, and 2 whole notes at 120 bpm against 0.25 Hz where the block allows it.
  - **Range:** a 1/32 note at 120 bpm renders the chorus exactly as a free 8 Hz one, and the flanger and phaser as free 5 Hz ones. A tremolo synced to 1/32 at 300 bpm renders exactly as a free 20 Hz one. A vibrato synced to 4 whole notes at 40 bpm renders exactly as a free 1 Hz one. A NaN tempo renders exactly as 120 bpm.
  - **Pulses:** a tremolo synced to a quarter note gives 8 cycles in 4 s at 120 bpm, 6 at 90 and 4 at 60. Synced to a dotted eighth, it gives 10 cycles in 3.75 s at 120 bpm. A free 5 Hz tremolo gives 20 at 60 bpm.
  - **No clicks:** each block, playing a sine, goes from free to an eighth, to a half note, then to a different free rate, through both `set_settings` and the prepared-configuration path. The largest step in the 20 ms after each change is no more than 1.25× the larger settled step, and every sample is finite.
  - **Vibrato depth through rate changes:** a 100-cent vibrato on a 440 Hz sine bends at most 103.1 cents when steady. The pitch is measured from zero-crossing periods. The largest bend after each change:

    | Change | Largest bend after it |
    |---|---|
    | Quarter-note sync, tempo jumping from 60 to 240 bpm | 114.9 cents |
    | Sync from 4 whole notes (held at 1 Hz) to 1/32 (held at 14 Hz) | 114.9 cents |
    | Sync from 1/32 back to 4 whole notes | 123.1 cents |

    The test allows 1.35× the steady bend. Without the glide, the tempo jump bends 308 cents and the test fails.
  - **Vibrato starts:** a vibrato switched on after the track has played, through `set_settings` or a prepared configuration, or reset while playing, with an unreadable tempo, stays finite.
  - **Mutation check:** with the sync ignored, three of the tests fail.
  - **Existing behaviour:** the modulation, effect-order and DSP tests, including the default chain's fingerprint, pass unchanged.
- **Editor** (`src/audio/tempo-sync.test.tsx`, 5 tests):
  - defaults and older sounds have no sync;
  - every duration and 0 are accepted on the five blocks; 0.3, −1, NaN, 32, a string and null are refused, as is a sync on the delay;
  - each block lists Off and the 12 durations; choosing one records it and disables the Rate field, leaving the block's other settings. Off removes the sync and enables the Rate field again;
  - a saved sound keeps its sync;
  - a copied pedal pastes with its sync, and a free pedal pasted over a synced one is free.

  The tests were confirmed to fail with the Rate field left enabled, and with the library dropping the sync.
- **Desktop:** `tests/desktop/parity-tempo-sync.mjs` on a Windows desktop-test build.
  - **Fixture:** a held organ chord, two bars at 120 bpm and two at 60 bpm, exported as WAV through the Export dialog.
  - **Edits:** the tremolo, at full depth and synced to a quarter note, records `syncQuarterNotes: 1` and disables its Rate field.
  - **Measurement:** the tremolo's rate from its troughs in 20 ms levels:

    | Export | 0.1–3.9 s, 120 bpm | 4.1–11.9 s, 60 bpm |
    |---|---|---|
    | Synced to 1/4 | 2.00 Hz, 8 troughs | 1.00 Hz, 8 troughs |
    | Free, 3 Hz | 2.99 Hz, 11 troughs | 3.00 Hz, 23 troughs |

  - Off records the free 3 Hz tremolo with no sync. Playback ran live, two Undos brought back the quarter-note sync with its Rate field disabled, and there were no page errors.
  - The modulation, graphic EQ, effect-order, sound-library and delay desktop tests still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 725 tests;
  - the full `vitest` suite: the load-sensitive files pass when run alone;
  - `tsc`;
  - `rustfmt` on the changed native files.

## Review
- **First adversarial review:** changes requested, for one Medium and several Low notes.
  - **Medium, fixed:** a vibrato's rate reached a new value at once, while its delay swing slewed to match over a quarter of a second, so the bend went far deeper than set: about 1966 cents for a sync change from 1 to 14 Hz, and 308 cents when the tempo jumped from 60 to 240 bpm with no edit. Large free-rate changes always did this; sync made it easy to trigger, and tempo changes trigger it while playing. The vibrato now glides its rate no faster than its swing can follow, and a new test pins the depth through rate changes.
  - **Low, fixed:**
    - the click test now also requires finite output;
    - the chorus, flanger and phaser range limits are now tested;
    - starting the vibrato after playing, or resetting it, is now tested on every path.
  - **Low, kept as they are:**
    - the disabled Rate field still shows the free rate while synced;
    - a saved sound with a sync this build does not know is listed as unusable rather than played free; it is kept, not lost;
    - before a vibrato first plays, a settings change sets its swing directly rather than sliding to it, which cannot be heard because the block fades in from silence.
  - **Checked and fine:**
    - the NaN start of the vibrato swing stays inside the vibrato on every path tried;
    - free rates render bit for bit as before;
    - the editor and native player accept and refuse the same values, including 1/3 and 2/3;
    - the tempo includes practice speed;
    - `process()` does not allocate;
    - the effect-order fade is untouched.
- **Second review:** approved.
  - The glide was re-measured: a 1 to 14 Hz sync change now bends at most 115 cents against 103 steady.
  - Steady and small free-rate changes take the old path bit for bit.
  - Switching between gliding and settled near the end of a ramp cannot click, and the vibrato's NaN start always moves as a pair.
  - **Low, fixed:** a vibrato switched off and on again through  glided from its old rate while a new configuration started afresh; a switched-off vibrato now starts afresh on both paths.
  - **Low, kept:** lifting the depth from 0 to 100 cents together with a large rate change bends up to 1.33× the steady depth for 100 ms. This comes from the existing depth slew.
- **Second review:** approved.
  - The glide was re-measured: a 1 to 14 Hz sync change now bends at most 115 cents against 103 steady.
  - Steady and small free-rate changes take the old path bit for bit.
  - Switching between gliding and settled near the end of a ramp cannot click, and the vibrato's NaN start always moves as a pair.
  - **Low, fixed:** a vibrato switched off and on again through `set_settings` glided from its old rate while a new configuration started afresh; a switched-off vibrato now starts afresh on both paths.
  - **Low, kept:** lifting the depth from 0 to 100 cents together with a large rate change bends up to 1.33× the steady depth for 100 ms. This comes from the existing depth slew.

## Limits
- **Modulation blocks only:** the wah's auto mode, the octaver and pitch shift have no rate to sync. The delay already follows note durations.
- **No phase lock:** a synced block follows the tempo's speed, not the bar line. Its cycle starts when playback starts or the block is switched on, not on a beat, and it is not re-aligned after seeking.
- **Range limits:** very fast or very slow durations at extreme tempos are held at the block's range, so they no longer follow the tempo there.
- **No listening comparison** with GP8's synced pedals.
- **Older builds:** a sound with a tempo sync cannot be opened by builds from before this slice.
