# GP8 parity A14: track graphic EQ (2026-10-24)

GP8 offers expanded EQ on a track's sound, beyond a few broad bands. TabPlayer had one three-band EQ: a low shelf, a movable mid peak and a high shelf. This slice adds a ten-band Graphic EQ block to each track's sound, in the native player and in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Graphic EQ block:** a new block right after the EQ in the default signal chain. Like the other blocks it can be switched on and off, moved along the chain, copied and pasted, saved in sounds and previewed.
- **Bands:** ten octave bands centred at 31, 63, 125, 250, 500 Hz and 1, 2, 4, 8 and 16 kHz.
  - Each band lifts or cuts its octave by up to 12 dB, in 0.5 dB steps.
  - Each is a one-octave peak (Q √2): an octave away from its centre a band has about a fifth of its effect, two octaves away about a twentieth.
  - Neighbouring bands overlap, so lifting several next to each other lifts their middle by more than any one of them.
  - At a sample rate too low to carry a band's centre, below about 35 kHz for the 16 kHz band, that band stays flat. It is not moved down onto the bands below it.
- **Level:** an output level from −12 to +12 dB.
- **Flatten:** "Flatten graphic EQ" sets every band to 0 dB in one edit, keeping the level and the on/off state.
- **Edits:** every change is one undoable track-sound edit. While playing, band and level changes glide over 10 ms like the other blocks. Switching the block on starts its bands from rest.
- **Saved documents and sounds:**
  - an untouched graphic EQ is not written, so sounds saved before this slice load and save unchanged;
  - a signal-chain order saved before this slice names the 17 older blocks. It stays valid, and the graphic EQ plays right after the EQ in it. Any other block left out of an order is still refused;
  - the editor refuses the same gains, levels and band counts the native player does.

## Evidence
- **Native** (`src-tauri/tests/audio_graphic_eq.rs`, 10 tests):
  - **Format:** the untouched block is not written. The wire format, out-of-range, NaN and infinite gains and levels, and a band list of the wrong length are all checked.
  - **Older orders:** an order of the 17 older blocks is valid, and plays exactly as the same order with the graphic EQ named right after the EQ. Leaving out another block, naming the graphic EQ twice or naming an unknown block is refused.
  - **Bands** at 48 kHz, measured with steady sines, change in dB:

    | One band at +12 dB | At its centre | An octave away | Two octaves away |
    |---|---|---|---|
    | 31 Hz to 1 kHz | +12.00 | +2.5 | +0.5 |
    | 4 kHz | +12.00 | +2.4 below, +2.1 above | +0.5 below, +0.2 above |
    | 16 kHz | +12.00 | +1.0 below | +0.2 below |

    Each band also cuts by 12.0 ± 0.3 dB at its centre. The test requires a centre within 0.3 dB and two octaves away below a fifth of the gain.
  - **Width:** half an octave either side of each band from 31 Hz to 8 kHz, the measured gain matches a one-octave peak at the band's centre within 0.1 dB.
  - **A curve:** set to 6, 6, 3, 0, −3, −6, −3, 0, 3, 6 dB, the response at the band centres is +7.2, +7.7, +4.2, 0.0, −4.1, −7.0, −4.1, −0.2, +3.3 and +6.2 dB. Its lowest point lies between 700 Hz and 1.5 kHz. With every band at +12 dB, 1 kHz rises by 18.3 dB.
  - **Flat and level:** a flat graphic EQ passes noise within 1e-6. The level moves a sine by +6.00 and −12.00 dB, within 0.05 dB.
  - **No clicks:** six changes are made while a sine plays, each tested against the settled steps around it: switching on, lifting and cutting neighbouring bands, the level, every band at once, switching off, and alternating bands. The largest step in the 20 ms after each change is no more than 1.25× the larger settled step. Each runs at 48 and 192 kHz, through both `set_settings` and the prepared-configuration path that live edits use.
  - **Sample rates:** at 8, 22.05, 44.1, 96 and 192 kHz, every band at +12 dB stays finite and dies away after the input stops. At 44.1 and 96 kHz the 16 kHz band lifts its centre by 12.00 dB.
  - **Top bands at low rates:** the 4, 8 and 16 kHz bands are lifted together by 12 dB, and a twelfth-octave sweep covers 8, 16, 22.05, 32 and 44.1 kHz. No frequency rises by more than 15.5 dB; neighbour overlap alone gives 14.6 dB at 44.1 kHz. The test was confirmed to fail, at 36.0 dB at 8 kHz, when bands were moved down instead of left flat.
  - **Switching back on:** a graphic EQ switched off after playing and on again gives exact silence from silence. The test was confirmed to fail without resetting the bands.
- **Editor** (`src/audio/graphic-eq.test.tsx`, 7 tests):
  - the default, flat and switched off, which older sounds receive;
  - the block is listed after the EQ, with a field for each band and the level, each recording its edit and leaving the other bands;
  - out-of-range values are not recorded;
  - Flatten resets every band in one edit;
  - settings and band lists the native player rejects are refused;
  - an older 17-block order places the graphic EQ after the EQ, while other omissions and duplicates are refused;
  - a saved sound keeps its graphic EQ.

  Tests that list the whole chain, and the effect-order tests, now count 18 blocks.
- **Desktop:** `tests/desktop/parity-graphic-eq.mjs` on a Windows desktop-test build. The export is a sustained E2 and E3 on a steel-string guitar, exported as WAV through the Export dialog. The table shows octave levels against the dry export from 0.1 to 1.5 s (Welch spectra):

  | Export | 125 Hz octave | 1 kHz octave | 4 kHz octave | Whole level |
  |---|---|---|---|---|
  | Flat, switched on | 0.00 dB | 0.00 dB | 0.00 dB | 0.00 dB |
  | 1 kHz band +12 dB | +0.2 dB | +9.5 dB | +1.0 dB | +1.8 dB |
  | 125 Hz band −12 dB | −7.0 dB | −0.2 dB | 0.0 dB | −2.0 dB |
  | Level −6 dB | −6.0 dB | −6.0 dB | −6.0 dB | −6.00 dB |

  - The chord's partials near 125 Hz are at 82 and 165 Hz, away from the band's centre, so that octave falls by less than the full 12 dB.
  - The final edit recorded the flat bands with a −6 dB level.
  - Playback ran live; Undo restored the level; there were no page errors.
  - The effect-order, microphone, sound-library and modulation desktop tests still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 715 tests;
  - the full `vitest` suite: the load-sensitive files pass when run alone;
  - `tsc`;
  - `rustfmt` on the changed native files.

## Review
- **First adversarial review:** approved, with one Medium and several Low notes.
  - **Medium, fixed:** at low sample rates, the bands above what the rate carries were moved down onto one frequency, so lifting them piled their boosts up: +36 dB at 8 kHz and +24 dB at 16 kHz. Such bands now stay flat, and the new test pins it.
  - **Low, fixed:**
    - switching the block back on through `set_settings` replayed its old filter state; it now resets them;
    - the level was converted from dB every frame; it is now cached;
    - the tests did not pin the bands' width; they now compare it with a one-octave peak.
  - **Low, kept as they are:**
    - a change of sample rate would keep old coefficients, but the player refuses rate changes, as for the EQ and cabinet;
    - the headroom with many bands lifted;
    - number fields rather than sliders.
  - **Checked and fine:**
    - the native and editor orders agree on every edge case tried, and older orders keep their place;
    - the A17 shortcut for moving switched-off blocks handles the new block;
    - `process()` does not allocate; coefficients are recomputed only while gains change;
    - there were no clicks on either path.
- **Second review:** approved.
  - The cut-off depends only on the rate, so a band cannot cross it while playing.
  - The reset fires only on the first frame of switching on, where the crossfade is still silent, on every path.
  - A note kept for later: switching any block off and back on within 10 ms restarts its crossfade and can click, as the EQ does. That is how every block crossfades, not something this block adds.

## Limits
- **Track only:** this is the track graphic EQ. A master EQ needs a master sound chain, which is A18 and still missing, so A14 stays partial.
- **One model:** fixed octave bands with a fixed one-octave width, rather than GP8's EQ pedal models; there is no listening comparison with GP8.
- **Band overlap:** neighbouring bands add up, as in most graphic EQs, so a curve can overshoot its settings by about 1.5 dB, and many bands lifted together lift more than their setting.
- **Headroom:** ten bands at +12 dB can lift the signal by about 18 dB, 30 dB with the level at +12 dB, with no limiter after it. Later blocks and the player's output stage then see a hotter signal, as they do with the EQ's and amp's gains.
- **Low sample rates:** below about 35 kHz the 16 kHz band, and below about 18 kHz the 8 kHz band, stay flat.
- **Fields, not faders:** the bands are number fields rather than vertical sliders.
- **Older builds:** a sound with the graphic EQ in use cannot be opened by builds from before this slice.
