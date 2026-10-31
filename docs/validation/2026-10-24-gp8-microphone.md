# GP8 parity A34: sound-bank microphone placement and mono/stereo output (2026-10-24)

GP8 sound banks let a track choose how the instrument's recording is miked and whether it plays in stereo or mono. TabPlayer played every sound as its sample bank delivered it. This slice adds a Microphone block to each track's sound, first in the chain, in the native player and in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Microphone block:** a new block at the head of the Sound task's signal chain, before the gate and the pedals, because it stands for how the instrument was recorded. Like the other blocks it can be switched on and off, copied and pasted, saved in sounds and previewed.
- **Microphone placement:**
  - **Standard** leaves the recording as it is.
  - **Close** adds the proximity effect: a low shelf, +6 dB at 200 Hz, and softer highs (−3 dB above 6 kHz).
  - **Edge** is off the axis: thinner lows (−5 dB at 250 Hz) and more presence (+6 dB around 4.5 kHz).
  - **Room** is at a distance:
    - an 80 Hz high-pass and highs 6 dB softer above 4 kHz;
    - early reflections at 11–24 ms;
    - each channel hears different walls, so a centred sound spreads out between them.
- **Microphone output:** Stereo keeps the channels apart. Mono folds them into one centred source, (L + R) / 2, so mono material is unchanged and the track's pan places the result.
- **Edits:** every change is recorded as an undoable track-sound edit. While playing:
  - a change of placement or output crossfades over 10 ms;
  - a change to or from the room reaches each reflection as a 10 ms crossfade when its delay has passed;
  - a block switched on mid-play fades each reflection in from silence, so no old reflections can return.
- **Saved documents:**
  - an untouched Microphone block is not written, so sounds saved before this slice load and save unchanged;
  - the editor refuses the same placements and outputs the native player does.

## Evidence
- **Native** (`src-tauri/tests/audio_microphone.rs`, 9 tests):
  - **Format:** the untouched block is not written; older sounds load with it off. The test also checks the wire format, unknown fields, and unknown placements and outputs.
  - **Exact pass-through:** a standard stereo microphone and a switched-off one pass noise through bit-exactly.
  - **Mono:** every placement in mono gives two identical channels. A source panned hard left plays from both channels at exactly half level. In stereo, a close microphone keeps the silent right channel silent.
  - **Spectrum** at 48 kHz, change in dB. Close and edge are filters alone and are measured with steady sines. The room's reflections comb a sine, so it is measured with noise in octave-wide bands:

    | Placement | 40 Hz | 125 Hz | 1 kHz | 3.5 kHz | 9 kHz |
    |---|---|---|---|---|---|
    | Close | +6.0 | +5.2 | 0.0 | −0.3 | −2.6 |
    | Edge | −5.0 | −4.7 | +0.6 | +5.2 | +2.4 |
    | Room | −6.9 | −2.4 | −1.9 | −4.3 | −7.1 |
  - **Room width:**
    - an impulse returns reflections between 5 and 30 ms, at different times on each channel;
    - centred noise has a channel correlation of 0.852 through the room, against above 0.999 for the other placements;
    - mono folds it back to above 0.999.
  - **Level:** on noise low-passed at 1.5 kHz, nearer an instrument's spectrum, close is +0.6 dB, edge +2.0 dB and room −2.2 dB.
  - **No clicks:** the largest step in the 30 ms after each change, on either channel, is no more than 1.25× the larger settled step.
    - The changes cover every placement and output, switching off and on, and changes to and from the room.
    - Each runs at 48 kHz with 219.7 Hz and 1 kHz sines, and at 192 kHz with 110 Hz, 219.7 Hz and 1 kHz, through both `set_settings` and the prepared-configuration path that live edits use.
    - It was confirmed to fail without the reflection fade-in, and with the room's line switched in one sample.
  - **No stale reflections:** a room fed noise, switched off and back on, gives exact silence on both paths.
  - **Sample rates:** at 8, 44.1, 96 and 192 kHz every placement stays finite and ends in exact silence. The room's first reflection arrives within 0.5 ms of its 48 kHz time.
- **Editor** (`src/audio/microphone.test.tsx`, 5 tests):
  - the default, which is standard and stereo, switched off;
  - older sounds get that default;
  - the block is listed first, with its Microphone placement and Microphone output lists and their recorded edits;
  - settings the native player rejects are refused;
  - a saved sound keeps its microphone.

  Four existing tests that pin the chain's order now count the Microphone block first.
- **Desktop:** `tests/desktop/parity-microphone.mjs` on a Windows desktop-test build. The export is a sustained E2 and E3 on a steel-string guitar, exported as WAV through the Export dialog. The table shows octave levels against the dry export from 0.1 to 1.5 s (Welch spectra), as the 125 Hz and 5 kHz octaves tilt against 1 kHz, and the channel correlation:

  | Export | Lows (125 Hz) | Highs (5 kHz) | L/R correlation |
  |---|---|---|---|
  | Dry | | | 1.000 |
  | Close | +4.1 dB | −0.9 dB | 1.000 |
  | Edge | −4.7 dB | +5.0 dB | 1.000 |
  | Room | +2.2 dB | −2.9 dB | 0.760 |
  | Room, mono | +2.2 dB | −2.8 dB | 1.000 |

  The room's 1 kHz octave falls more than its 125 Hz one here, because its reflections comb the chord's few partials. That is why its low tilt reads positive. The native noise test shows its low cut.
  - The final edit recorded `{enabled:true, placement:'room', output:'mono'}`.
  - Playback ran live; Undo restored Stereo; there were no page errors.
  - The delay, drive, reverb, modulation, pitch, wah, sound-library, sound-preview and export desktop tests still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice;
  - the full `vitest` suite: the load-sensitive `App`, `corpus`, `library/content`, `tuning-ui`, `WorkspaceApp` and `musicxml-tempo-offsets` files pass when run alone;
  - `tsc`.

## Review
- **First adversarial review:** changes requested.
  - **High, fixed:** changing to the room clicked when each reflection arrived, after the 10 ms crossfade, because its line started empty. The line now keeps the direct sound whenever the block plays. A block switched on mid-play fades each reflection in once its delay has filled.
  - **Medium, fixed:** the click test only looked at the first 10 ms, and the re-enable test fed a steady level that the high-pass removes. Both now see the problem.
  - **Product notes taken:**
    - the room's high-pass moved from 110 to 80 Hz, so bass keeps its fundamental;
    - its reflections are lighter, so it sounds less boxy.

    The mono fold, (L + R) / 2, was judged right.
- **Second review:** changes requested.
  - **High, fixed:** the room's line switched placements in one sample, so a change to the room still clicked at each reflection's delay. It was 5–12× the settled step at 192 kHz. The line now takes the crossfaded direct sound.
  - The click test gained 192 kHz, more frequencies and shifting phases, and was confirmed to fail with the old line.
- **Third review:** approved. Its probe covered 116 changes involving the room, at 8, 48 and 192 kHz, at four frequencies, three phases and on both paths. No change stepped more than 1.2× the settled step at any rate.

## Limits
- **Not separate recordings:** these placements reshape the existing samples with filters and early reflections. They are not banks recorded with other microphones, and there is no listening comparison with GP8.
- **Mono loudness:** a hard-panned or wide sample loses about 3 dB of total power in mono, the usual mono-sum convention. Centred material is unchanged.
- **Room comb:** the room's reflections comb sustained notes; this is part of the sound of a nearby wall.
- **Low end:** close adds up to 6 dB of low end before the drive and the amp, which pushes them harder on bass.
- **Edits mid-change:** an edit made within 10 ms of another restarts the crossfade from its target, as other blocks do.
- **Older builds:** a sound with the Microphone block in use cannot be opened by builds from before this slice.
