# THE-217: the metal rhythm sound is fizzy and lacks body

Date: 2026-11-15. Branch `agy/the-217-metal-amp`, on top of the palm-mute fix (THE-214). These are measurements. (Superseded: the owner has since listened and chosen a different voicing; the sound this branch ends with is the one in the "Decision" section at the end, and the first-round voicing described below was dropped.)

The owner's words: the palm mutes are right now, "the amp doesn't sound very good still", then "fizzy and lacking body". CLAUDE.md says `tone.rs` is not retuned unless the owner asks; this complaint is that request for the metal rhythm sound. No constant of the amp or the cabinet was retuned. `tone.rs` gained one optional setting whose default changes nothing (below).

"The reference" is the owner's Guitar Pro export of the left rhythm guitar of one of their songs (the right guitar is exported hard right; the two exports are the same notes with different timing and tone, not independent performances: see the second round). "Ours" is the track played through the metal rhythm sound with the sampled black guitar, rendered at 48 kHz. Windows are `min(gap to the next onset, 250 ms)` from the written onset (the reference aligned by onset search, +91 ms), notes at MIDI 47 or below with a gap of at least 110 ms: 229 open notes and 200 palm mutes. All band figures are shares or levels of the spectrum of those windows, power-averaged over the notes. The reference is a normalised export, so absolute levels are not comparable with ours; shapes (levels relative to the window's total) are.

## Phase 1: where the fizz comes from and where the body goes

### What the reference is

| | open notes | palm mutes |
|---|---|---|
| energy 20-80 Hz / 80-250 / 250-1k / 1-4k / above 4k (shares of the window) | 1.9% / 68% / 17% / 7% / 3.7% (per-note median) | 13.8% / 85% / 0.5% / 0.1% / 0.0% |
| spectral centroid | 521 Hz | 117 Hz |
| crest factor (peak over RMS of the window, median) | 10.2 dB | 8.1 dB |
| 80-250 Hz level 0-100 ms after the pick, then 150-250 ms and 300-500 ms (7 open notes) | 0, +0.5, +0.3 dB (flat: the body is there at once and stays) | falls 2.9 dB by 150-250 ms, 5.3 dB by 300-500 ms |
| palm mute minus open note, window RMS | +9.9 dB | |
| L/R | exported hard left and hard right, independent performances | |
| fizz bands, level relative to the window total: 4-6 kHz / 6-8 kHz / 8-12 kHz | -16.9 / -20.5 / -34.5 dB | -35.9 / -40.5 / -55.2 dB |

The reference's amp is not dark at the top (6-8 kHz sits only 20 dB under the total), and its inharmonic share is high (noise-to-harmonic +12 dB on open notes), so it is not a pure, smooth tone. What it has is a lot of low end and a spectrum that falls smoothly from the low end to the top.

### What ours was (before)

Level-matched third-octave comparison with the reference, open notes, in dB (positive: ours has more): 50-125 Hz -7 to -11, 160-250 Hz -2 to +1.5, 315-3150 Hz +3 to +11 (largest +11 at 3.15 kHz), 4-5 kHz +1 to +3, 6.3-10 kHz -9 to -15. Palm mutes: 63-125 Hz -4 to -13, 160 Hz and up +3.5, rising to +23 to +27 dB at 0.8-3.2 kHz. Deviation from the reference over 63 Hz to 5 kHz, root mean square and worst band: 6.7 and 11.3 dB (open), 17.8 and 26.8 dB (palm mutes).

Fizz and body numbers, level relative to the window total:

| open notes | 20-80 | 80-250 | 250-500 | 500-1k | 1-4k | 4-6k | 6-8k | 8-12k |
|---|---|---|---|---|---|---|---|---|
| reference | -16.2 | -1.2 | -9.2 | -18.1 | -12.3 | -16.9 | -20.5 | -34.5 |
| ours before | -26.4 | -5.1 | -5.4 | -10.5 | -5.5 | -16.8 | -32.0 | -48.2 |
| ours after | -15.8 | -0.9 | -10.0 | -18.8 | -12.7 | -24.0 | -40.8 | -59.1 |

| palm mutes | 20-80 | 80-250 | 250-500 | 500-1k | 1-4k | 4-6k | 6-8k | 8-12k |
|---|---|---|---|---|---|---|---|---|
| reference | -8.2 | -0.7 | -22.6 | -34.3 | -29.9 | -35.9 | -40.5 | -55.2 |
| ours before | -24.2 | -2.1 | -8.9 | -11.9 | -7.7 | -19.8 | -35.4 | -52.5 |
| ours after | -12.3 | -0.3 | -19.3 | -27.1 | -23.6 | -38.7 | -57.5 | -77.6 |

So the fizz is not energy above 4 kHz (ours matched the reference at 4-6 kHz and was already under it above 6 kHz). It is the 500 Hz to 4 kHz band, 7 dB hot on open notes and 22 dB hot on palm mutes against the low end, and the harsh, dense character of a low note clipped hard. The body is a shortage of 20-250 Hz (4 to 10 dB) that arrives late: with the sample's recorded lead-in allowed for, ours rose 3.2 dB between the first 100 ms and 150-250 ms and 5.4 dB by 300-500 ms (the low end bloomed after the attack), where the reference's is flat.

### Stage by stage through the chain (open notes, shares of the window; palm mutes below)

| stage | under 80 | 80-250 | 250-1k | 1-4k | above 4k | centroid |
|---|---|---|---|---|---|---|
| reference | 1.9% | 68% | 17% | 7.4% | 3.7% | 521 Hz |
| sampled guitar, dry (no effects) | 2.9% | 47% | 47% | 2.5% | 0.0% | 296 Hz |
| + overdrive pedal | 0.8% | 24% | 68% | 8.0% | 0.0% | 443 Hz |
| + metal amp (no cabinet) | 1.1% | 15% | 39% | 32% | 13% | 1604 Hz |
| amp + cabinet (no pedal) | 0.1% | 49% | 34% | 15% | 2.1% | 633 Hz |
| the whole sound | 0.1% | 27% | 42% | 28% | 3.8% | 1008 Hz |

Palm mutes: dry 23.8% / 69% / 7% / 0.3% / 0.0%, centroid 123 Hz; the whole sound 0.1% / 56% / 25% / 17% / 1.9%, centroid 630 Hz.

Absolute levels (dB re full scale) of 80-250 Hz, 1-4 kHz and 4-6 kHz of the open notes through the stages: dry -24.2, -37.2, -59.9; after the pedal -26.8, -32.2, -62.0; after the amp -35.0, -32.1, -39.5. The amp takes 8 dB off the body and adds 22 dB at 4-6 kHz, with the total level 6 dB lower: it is a limiter that gives the same output level for any input, and what it adds is distortion products.

Measured on the circuit with sine waves (`tone::amp_shape("metal", 0.55)`, 48 kHz): gain 28 to 32 dB at a 0.003 peak, -7 to -14 dB at 0.3, flat from 63 Hz to 8 kHz, with an output peak of 0.12 to 0.13 for any loud input. The low end is not removed at high level (40 Hz -8.7 dB against 100 Hz -7.4 dB at 0.3) but at small level, where the stages' coupling high-passes (60, 160, 120, 90, 60 Hz, and a 250 Hz shelf of -6 dB ahead of the first clipper) take 15 to 25 dB off 40-60 Hz. The closed cabinet is 12 dB down at 63 Hz, 21 dB at 50 Hz, 29 dB at 40 Hz against 126 Hz, with an 8 dB bump near 2.5 kHz and a fall of 25 dB between 4.8 and 8 kHz.

### Causes

1. Fizz: gain into a hard clip, not aliasing and not the pick. Aliasing: the nonlinearity is oversampled four times; swept and fixed sines at 0.33 to 3.7 kHz gave non-harmonic lines 63 to 70 dB under the harmonic total (worst single line -66 dB), which no one hears under the harmonics. The pitched-down samples carry almost nothing up there (dry open notes: 4-6 kHz at -60 dB, 6-8 kHz at -71 dB absolute), but five cascaded clipping stages with 60 dB of gain lift quiet content by up to 39 dB (dry palm mute 4-6 kHz -80 dB, after the amp -41 dB, while its low end gained nothing), and the harmonics of a note that low are only 40 to 120 Hz apart, so the clipped result is a dense buzz. Lowering the amp drive from 0.4 to 0.1 took a palm mute's 1-4 kHz band from -21.0 to -26.0 dB and its 4-6 kHz band from -33.8 to -43.0 dB under the total, with open notes nearly unchanged: it is gain. The voicing after the clipping (a high shelf of +8 dB at 1.9 kHz) and the cabinet bump near 2.5 kHz add to it. The cabinet is not too gentle: it falls 25 dB over an octave above 4.8 kHz.
2. Body: parameters of the tone chain and one structural limit. (a) The preamp's low cuts are set for a guitar in standard tuning: the fundamental and second partial of a note an octave below E2 are what they remove, so the clipper sees only the upper partials and the result is harmonics without a foundation. This is the amp model's structure (the cuts were fixed constants), fixed below by a setting. (b) The overdrive pedal in front of the amp is a mid-boost (it clips above 720 Hz and adds the rest): it took a further 2.6 to 3.6 dB off 80-250 Hz. (c) The tone stack was flat, so nothing lifted the low end after the clipping. (d) The closed cabinet's two high-pass sections at 90 Hz remove 20-80 Hz, but with the stack's bass shelf in front of it the result is within 1 dB of the reference's 20-80 Hz share for open notes.
3. The samples are the E2 recording pitched down by up to 14 semitones. Their formants move down with the pitch and no cabinet-like filter restores them; the dry open notes have a 250 Hz to 1 kHz share of 47% against the reference's 17%. This is a limit of the sample set, not of the chain, and it stays.
4. The mix: master effects are off in ours (no master settings) and the reference is one track's export, so neither adds to the comparison; the master limiter's ceiling is 0.9 and none of the sounds here come near it (open peak -15 dB, palm mute window peak -15 dB).

## Phase 2: what was changed

`src-tauri/src/audio/tone.rs`, `dsp.rs`: one new optional amp setting, `lowEndOct` (octaves, 0 to 1, default 0, 0 is not saved; only the metal preamp takes it, see the follow-up below): the corners of the low cut ahead of each stage (the coupling high-pass and the shelf) move down by that many octaves. The default multiplies every corner by exactly 1, so the amp, its calibration and every sound that does not set it are bit for bit what they were. It is a control in the amp panel, shown only for the metal amp ("Low tune (oct)" in English, with a tooltip and `de` and `et` strings), and typed in `edit-types.ts`, `document-settings.ts`. Nothing on the audio thread changed in cost: the corners are resolved off the thread with the rest of the shape.

I tried and dropped a second setting, a path around the clipping stages that adds the note's low end clean. It raised the body and the level but left palm mute against open note where it was (it adds as much to an open note's fundamental), and costs a filter per sample; it is not in the code.

Factory sound `metal-rhythm` (`src/audio/factory-sounds.ts`, `tests/factory-sounds.json`), parameters before to after:

| parameter | before | after |
|---|---|---|
| overdrive pedal | on, drive 0.2, tone 0.6 | off |
| amp drive | 0.55 | 0.2 |
| amp gain | -2 dB | -4.5 dB |
| amp bass / mid / treble / presence | 0 / 0 / 0 / 0 dB | +8 / -3 / -4 / +3 dB |
| amp low end (new) | 0 | 1 octave |
| gate (-50 dB, 60 ms), closed cabinet | unchanged | unchanged |

Gain: -4.5 dB keeps the sound inside the factory-level test (every factory sound within 6 dB of the middle one on its test tone, here +4.8 dB); at gain 0 the sound measured +9 dB over the middle one and the test failed. On the owner's riff the open notes are now as loud as before (-25.8 dB against -26.1 dB). The reference is 8 dB louder in its own normalisation; matching it would break the factory sounds' common level, and the clips are level-matched instead.

Not touched: the sampled guitar voice, the palm-mute constants of THE-214, the cabinets, every other amp model and sound.

### Do saved projects change?

No saved project changes by itself. A factory sound is applied by copying its effect settings into the track's sound; the project holds those values, not the sound's name. A project that copied the old metal rhythm keeps the old parameters and renders bit for bit as before (checked: the old settings through the new build give byte-identical audio to the old build). To hear the new sound the owner picks "Metal rhythm" again on the track (or dials in the values above). A project that uses the metal amp with other settings is unchanged too. A project saved with `lowEndOct` set will not open in an older build, because the amp's settings refuse unknown keys (`deny_unknown_fields`), as when `presenceDb` was added; the key is only written for a non-zero value.

## Measurements after

Owner's score, one rhythm guitar, as above. dev = deviation from the reference's third-octave shape after matching the total level, 63 Hz to 5 kHz, root mean square / worst band.

| | reference | before | after |
|---|---|---|---|
| open note level, dB re full scale (window RMS) | -17.4 (normalised export) | -26.1 | -25.8 |
| palm mute level | -7.5 | -24.9 | -22.3 |
| palm mute minus open note | +9.9 | +1.2 | +3.6 |
| dev, open / palm mute | | 6.7 / 11.3 and 17.8 / 26.8 | 2.8 / 6.5 and 5.4 / 9.9 |
| open: 20-80 / 80-250 / 250-1k / 1-4k / above 4k shares | 0.6 / 74.8 / 15.7 / 5.4 / 3.5% | 0.1 / 26.8 / 41.6 / 27.8 / 3.8% | 0.8 / 78.3 / 14.9 / 5.3 / 0.7% |
| palm mute: same bands | 1.7 / 97.3 / 0.9 / 0.1 / 0.0% | 0.1 / 56.2 / 25.2 / 16.7 / 1.9% | 1.3 / 95.9 / 2.3 / 0.4 / 0.0% |
| per-note energy 20-80 Hz, palm mute / open (median) | 13.8% / 1.9% | 0.2% / 0.1% | 3.9% / 1.5% |
| centroid open / palm mute (per-note) | 521 / 117 Hz | 1056 / 599 Hz | 368 / 131 Hz |
| crest, open / palm mute | 10.2 / 8.1 dB | 9.4 / 9.2 dB | 8.0 / 7.3 dB |
| open note decay, level 100 ms after the peak (per-note) | -4.5 dB | -2.0 dB | -4.6 dB |
| 80-250 Hz after the pick: 150-250 ms, 300-500 ms, against the first 100 ms | +0.5, +0.3 dB | +3.2, +5.4 dB | +0.6, +0.2 dB |
| time of the peak of the envelope, open / palm mute | 80 / 120 ms | 90 / 182 ms | 95 / 95 ms |
| aliasing, non-harmonic lines under the harmonic total | | -63 to -70 dB | unchanged (the stages are the same) |

Targets against what was reached:

- Third-octave shape of open notes within 3 dB of the reference from 60 Hz to 5 kHz after level-matching: reached from 63 Hz to 1.25 kHz and at 2.5 kHz; outside 3 dB at 400 Hz (-3.6), 1.6 kHz (-4.7), 2 kHz (-3.5), 3.15 kHz (+4.0), 4 kHz (-4.5) and 5 kHz (-6.5). Missed there, by at most 3.5 dB below 4 kHz and 6.5 dB at 5 kHz.
- Content above 6 kHz at or under the reference: far under (17 to 25 dB), on purpose, since the owner's complaint is fizz. This may sound dull at the top; the 4-6 kHz band is 7 dB under the reference's (-24.0 against -16.9 dB of the total). A presence of +6 dB instead of +3 closes about 2 dB of that and costs fizz; I did not take it.
- Energy below 80 Hz clearly present: open notes 1.5% against 1.9% (reference), palm mutes 3.9% against 13.8%. Present, not matched.
- Palm mutes clearly louder than open notes (+9.9 dB): not reached, +3.6 dB (from +1.2). Palm mutes much darker: reached (centroid 131 Hz against 117 Hz; 1-4 kHz 0.4% against 0.1%).
- Overall loudness: the factory level convention is kept, see the gain above.

### Standard tuning (an E2 riff, 8 open and 22 palm-muted notes; no reference exists for it)

Level relative to the total, dB. The old sound, the classic rock sound (the app's own sound for a standard-tuned guitar) and the new one:

| open notes | 20-80 | 80-250 | 250-500 | 500-1k | 1-4k | 4-6k |
|---|---|---|---|---|---|---|
| metal rhythm before | -31.6 | -7.1 | -8.7 | -9.2 | -2.9 | -14.5 |
| classic rock | -32.4 | -2.2 | -8.7 | -10.9 | -7.5 | -21.5 |
| metal rhythm after (clip 3b, shipped) | -21.6 | -0.9 | -14.0 | -18.7 | -9.4 | -21.0 |
| 3a, tighter | -22.7 | -1.6 | -10.9 | -14.9 | -7.6 | -19.6 |

The new sound in standard tuning is bass-forward: 80-250 Hz carries 80% of the energy against 60% for classic rock, with 250-500 Hz 5 dB under it. A power chord will sound heavy at the bottom and scooped above; I cannot say whether that is boomy or tight without listening. The old sound was thin there (80-250 Hz at -7 dB). The two tunings trade off in one number, `lowEndOct`: at 1 octave the drop-tuned riff is closest to the reference; at 0.5 (and bass +6, mid -1) the standard-tuned one is nearer classic rock and the drop-tuned riff keeps its open notes (dev 3.0 / 5.5) but loses accuracy on palm mutes (dev 8.2 / 14.6 instead of 5.4 / 9.9).

### Cost

One track, the owner's 3-minute score, release build, whole render including loading samples, median of three: 14.9 s before, 13.3 s after (the pedal is off; the new setting costs nothing). Five tracks of the same score all on this sound (181 s of audio): 43 to 49 s before, 40.5 to 43.7 s after, about 24 to 27% of real time before and 22 to 24% after. The ignored `selected_real_100bar_fourtrack_resource_budget` passes. There are no new filters or state, so the bound on the audio thread is what it was; stable at 44.1, 48 and 96 kHz (tests).

## Tests

`src-tauri/tests/audio_metal_rhythm.rs` (5 tests, after the later rounds; the first round had 9, four of which measured the first-round voicing and were removed with it, see the decision at the end), on synthetic notes only (partials falling as 1/h, plucked decay):

- `lowEndOct` 0 loads and saves unchanged (the key is not saved at 0, an old sound loads) and the setting is checked (out of range and NaN are refused); that the amp's circuits are the old ones at zero is `legacy_equivalence` in `tone.rs`, against a copy of the old arithmetic;
- more of a 41 Hz fundamental reaches the stages with each half octave;
- every other factory sound (19), a metal amp with the closed cabinet at the old settings, the Metal rhythm sound as first released and the default chain give the same output bits as the build before: an FNV-1a hash of one second of a decaying low E with eight partials at 44.1 and 48 kHz, strict on Windows (see the comment in the test), finite elsewhere;
- the metal amp's 60-250 Hz band does not fall as the setting rises from 0 to 1 octave, at five drives, three playing levels and three rates;
- the other amps ignore a stored value.

The final sound's own tests are in `audio_metal_rhythm_sound.rs` (8 tests, listed in the decision section).

The thresholds were set after measuring, not before. Also checked outside the repository: every factory sound rendered through the owner's riff, old build against new, byte-identical (including the old metal rhythm settings). `factory-sounds.test.tsx` regenerates `tests/factory-sounds.json`; `audio_factory_sounds` pins the level window (metal rhythm now +4.8 dB over the middle one on its test tone). The existing fingerprint tests pass unchanged.

## Limits and what was not matched

- Measurements only until the owner listens. One reference song, one performer's recording; the second owner score and the standard-tuned riff have no reference and were only rendered.
- The samples are the E2 recording pitched down by up to 14 semitones: their tone is not what a guitar tuned that low gives, and the chain cannot restore it.
- Palm mutes are +3.6 dB over open notes, not +9.9. The amp compresses 12 dB of playing to 1.7 dB of output, unchanged by this work; a clean low path did not help and was dropped. A voice-level push does not either (THE-214). Closing this needs a level-following amp stage, which is a new design, not a retune.
- The palm mute's own ring ends by about 300 ms (THE-214's constants, not touched); the reference's falls 5 dB over 300 to 500 ms.
- Energy below 80 Hz on palm mutes is 3.9%, the reference's 13.8%: the closed cabinet's 90 Hz high-passes. A cabinet with a lower box cut would need a new model and was not added.
- The top is dark on purpose (see above), and the reference's 6-12 kHz is 17 to 25 dB higher in relation to the body.
- Both guitars of a double-tracked part play the same recordings through the same chain, so they are far more alike (nearly mono) than the reference's two (correlation 0.09).
- The new setting has no preset other than this sound; its slider is in the amp panel without a custom control.
- Clips for the ears are outside the repository and level-matched to the reference by RMS over each clip, at 44.1 kHz; nothing in them, the harness or the owner's scores is in the repository.

## Follow-up after review (same branch)

### 1. Desktop drivers, in the real app

Test app built with `scripts/build-desktop-test.ps1` from the committed code. `parity-factory-sounds` passes: the exported chord through Metal rhythm has 1-8 kHz at -10.9 dB of its 40 Hz-8 kHz power against -25.4 dB for Warm jazz clean, a margin of +14.5 dB where the assertion asks for more than 10 dB (4.5 dB to spare); the two levels are -28.0 and -24.8 dB, 3.2 dB apart where it allows 6. The assertion protects that a distorted sound is audibly denser and brighter than a clean one; the new sound still is, so it was not changed. `parity-amp-tone`, `parity-drive-effect`, `parity-cabinet-ir`, `parity-master-effects`, `parity-effect-order` and `native-audio` all pass.

### 2 and 3. Evidence that saved projects are unchanged, and portable identity

- `BEFORE` in `audio_metal_rhythm.rs` now has a row for the old Metal rhythm settings (`metal_rhythm_before()`): `0xf13728a1ef948023` at 44.1 kHz and `0xe44a5c6ee5d750bf` at 48 kHz. They were taken on the code before this change: `tone.rs` and `dsp.rs` of `bad9042` were put in the working tree, a scratch test hashed the old settings (from their JSON, not from the helper), and the two files were put back. The new code gives the same bits.
- `legacy_equivalence` in `tone.rs` (a `#[cfg(test)]` module) holds a verbatim copy of the previous stage resolution and `amp_shape`, and compares it with the new code at `lowEndOct` 0 for every amp model, seven drives and 44.1, 48, 96 and 192 kHz, by equality of the circuit and by the bits of what each plays, on every platform. It was shown to fail: a 1e-6 change in a stage's corner trips it. The Windows hashes stay as a second check; their comment says that if CI's Windows image rounds differently the portable test is the authority.

### 4. The setting on the other amps

On a held synthetic note (49 Hz with two partials, amp alone), the 60-250 Hz band of the crunch and lead amps rises to about half an octave and then falls (crunch at drive 0.55: 58.8, 59.2 then 58.8, 58.4, 57.9 dB at 0, 0.5, 1, 1.5, 2 octaves; the metal amp peaks at 1 to 1.5 octaves and falls at 2). On a real riff through the same amps the band rose (crunch +1.0 dB, metal +2.1 dB over two octaves). So the setting is now limited to 0 to 1 octave and to the metal preamp: crunch, lead, bass drive, clean and bass ignore a stored value, and the panel does not show it there. For the bass drive the cancellation I suspected did not occur on the riff (its band rose 2.4 dB over two octaves); it is inert as a choice, not a necessity. Tests: the metal amp's low band does not fall (to within 0.25 dB, where a fully driven amp has nothing left to give) as the setting rises from 0 to 1, at five drives, three playing levels and three rates; the other amps' output is bit-identical for any value.

### 5. Panel and labels

The knob is hidden where it does nothing (`visibleParameters`), and the amp knob row takes its column count and label size from the number of knobs shown (`--amp-knobs`, `data-knobs`). The label says what it does: "Low tune (oct)" with the tooltip "Extends the amp's low end for a guitar tuned low: moves the preamp's low cut down by this many octaves", and the same sentence in `de` and `et` (labels "Tiefe Stimmung (Okt)" and "Madal häälestus (okt)"). The rig's knob labels are English in every language (they were before); the inspector's are localized.

Layout, measured in the real test app (the Sound view, Amp block, metal amp, 7 knobs; the crunch amp with 6 knobs as the baseline): at window sizes 1440 by 900 and 1100 by 800 the seven knobs sit in one row, each label on one line ("LOW TUNE", readout "1.00 oct"), with nothing overlapping or outside the amp face. In the first version "Low tuning" wrapped to two lines and ran into the readouts, so the label was shortened and the label size now follows the number of knobs. At 960 by 700 and below the amp face is small (about 170 px, held down by the window's height) and its knob row overlaps and runs outside the face with 6 knobs exactly as with 7: that is how the row already behaved and it is not made worse. The rig's knob labels are English in every language, so this layout does not depend on the language; the inspector's labels are localized and flow in a list, and the German and Estonian ones were not rendered in the real app at narrow widths.

### 6. Labels in the mixer and in Line-In

- Mixer: a track is named by matching its effects with the factory sounds, and failing that by the preset it started from with "(edited)". Metal rhythm is built on the Lead preset, so its old settings, which no longer match any factory sound, read "Lead (edited)". That naming is the same for every sound edited away from its factory sound and does not name a different one, but here it is misleading, so the mixer now also knows the previous definition of a retuned sound (`earlierFactorySound`) and names those settings "Metal rhythm (earlier version)"; edited from there it is "Lead (edited)" as before.
- Line-In: the stored choice `factory:metal-rhythm` is followed by name. `LineInPanel` plays the choice's current definition and uses the stored sound only when the choice no longer exists, so Line-In picks up the retuned Metal rhythm by itself; the stored old copy is not what is played (a test pins it). This is how Line-In has always followed a factory choice.

### 7. Level

On the `audio_factory_sounds` level tone (a plucked A2 and A3, two seconds) the old Metal rhythm measured 0.0933 RMS (+2.9 dB over the middle sound) and the new one 0.1163 (+4.8 dB), so re-picking the sound is 1.9 dB louder on that tone, under the 3 dB that would call for a remark; a test pins it to within 6 dB. On the owner's riff it is the same loudness as before.

### 8. Other items

The comment in `voices.rs` now says the metal rhythm sound was retuned after the THE-214 measurements. The stability test runs at 192 kHz too: there the stages are not oversampled and the cabinet response is cut to 1024 taps, and the band shares move by up to 3 dB (the 1-6 kHz band -20.4 against -23.3 dB at 44.1 kHz); the old sound moves by about as much, so the new sound is held to no more than the old one moved plus 1 dB. That is the chain's rate dependence, not this change's.

### 9. Preparing the owner's choice

(a) Replace Metal rhythm with a voicing. 3b, the shipped one, is the current state. For 3a (tighter) change `metal-rhythm` in `src/audio/factory-sounds.ts` to `amp:{model:'metal',drive:.2,gainDb:-2.5,bassDb:6,midDb:-1,trebleDb:-4,presenceDb:3,lowEndOct:.5}` with the rest as it is, then `UPDATE_FACTORY_SOUNDS=1 npx vitest run src/audio/factory-sounds.test.tsx` to rewrite `tests/factory-sounds.json`. The gain puts it where the shipped one sits on the factory level tone (`the_tighter_voicing_sits_where_the_shipped_one_does_on_the_factory_level_tone` pins it to within 1 dB). The tests in `audio_metal_rhythm.rs` that read the catalog (body, fizz, chug, chord, stability, level) are written against the shipped values and would be re-run and, where a threshold was set from the shipped sound, re-measured; the mixer's earlier-version name and the old-settings row stay as they are.

(b) Keep the old Metal rhythm and add a sound for low tunings. In `src/audio/factory-sounds.ts` the current definition goes back to the old one (the old patch is in `earlierDefinitions`, to be moved) and a new entry is added with a new id (for example `metal-rhythm-low`), a name, a description, the category 'Lead and high gain', preset `lead` and the shipped effects. Factory names and descriptions are English plain strings, not in `src/i18n`, so there is nothing to translate in `en`, `et` or `de` unless the owner wants that added. Then: regenerate `tests/factory-sounds.json` (`UPDATE_FACTORY_SOUNDS=1`); `factory-sounds.test.tsx` already checks that ids and names are unique and that no two sounds are one chain; `audio_factory_sounds.rs` takes its middle level from every sound, so the count changes and its window is re-checked (the new sound sits at +4.8 dB over the middle one now); `tests/desktop/parity-factory-sounds.mjs` applies sounds by id and could be extended to apply the new one (its 1-8 kHz assertion is against Metal rhythm and stays); the mixer's earlier-version name is then not needed and `earlierDefinitions` goes; the golden table in `audio_metal_rhythm.rs` keeps its old-settings row (which becomes the current Metal rhythm) and the metal rhythm tests are pointed at the new id by repointing `factory("metal-rhythm")`. No help text names Metal rhythm.

Clips: `standard-tuned-riff/4-old-chords.wav`, `4a-tighter-chords.wav` and `4b-fuller-chords.wav` (in the clips folder) are a standard-tuned riff of power chords and chugs (E5, G5, A5, D5, three notes where open), level-matched to the old sound. On them the share of the energy at 80-250 Hz for open chords is -8.8 dB (old), -3.5 dB (3a) and -2.3 dB (3b); 250-500 Hz -7.4, -6.8 and -8.3 dB; 1-4 kHz -2.8, -5.8 and -7.1 dB. The bass-forward, scooped character is not specific to single notes, and chords keep 250-500 Hz within 1 dB of what the old sound had.

## Second round: a modern tight high-gain sound

The owner heard 3a, 3b and the chord riff and rejected the direction (too old-school, warm and heavy-metal rather than a modern, tight, saturated metalcore-style rhythm sound), and says the Guitar Pro export is "closer but not perfect". So the reference is a guide, not the target: where it and the described character (saturated but tight and percussive; fast palm-mute attack with a controlled thump rather than a bloom; aggressive upper-mid bite with an edge around 2-4 kHz; lean low mids around 200-500 Hz; a closed four-by-twelve with a presence peak at 2.5-4 kHz and a steep fall above 5-6 kHz; a boost in front as a tightener) disagree, the candidates follow the description, and the departures are listed below. Nothing was listened to by me. The factory sound `metal-rhythm` is untouched this round: its definition stays the one of the previous round (the "3b" voicing, with the old definition kept as the mixer's "earlier version"), and the candidates were test presets only (a fixture of the four, since reduced to the chosen one: see the decision at the end) plus renders outside the repository.

### 1. The reference against the description

Measured on the owner's score (left rhythm guitar export, all 84 sustained power chords at MIDI 47 or below with a gap of at least 300 ms, and the 200 palm mutes; sixth-octave spectra from 60 Hz to 10 kHz, power-averaged over the windows and level-matched, i.e. relative to each window's total; the first 30 ms measured from the pick, found by onset search in each note). Features: crest factor (peak over RMS of the window); level spread (10th to 90th percentile of the notes' RMS, in dB: how much louder one note is than another); first-30 ms centroid and the level 10-30 ms after the pick against 100-250 ms (a sharp attack is positive); time for the 150 Hz low band to fall 20 dB after the pick (low-end tightness); the low-mid dip (200-500 Hz against the mean of 100-150 Hz and 0.8-3 kHz; negative is lean); the slope of the spectrum from 5 to 10 kHz in dB per octave.

| | what the description says | what the reference measures | agrees? |
|---|---|---|---|
| upper-mid bite and an edge at 2-4 kHz | clear peak, 0.8-3 kHz strong | 0.8-3 kHz at -24.0, 2-4 kHz at -23.5, 4-6 kHz at -23.1 dB of the total: a flat plateau, with small bumps at 2.2 kHz (+4 dB over its neighbours) and 4.3 kHz, and a notch at 3 kHz (-32 dB). No sharp presence edge | no: broader and softer than described |
| lean low mids | dip at 200-500 Hz | 200-500 Hz at -16.6 dB, 7 dB above the upper mids; dip against its neighbours +0.6 dB (open), -2.0 dB (palm mute): none | no: warm, bass-led tilt |
| steep top | falls hard above 5-6 kHz | -21.9 dB per octave, 6-10 kHz only 4 dB under 4-6 kHz | partly: the old sound fell -36.5 dB per octave and was darker than the reference |
| tight low end after a palm mute | thump stops | the 150 Hz band takes 445 ms to fall 20 dB (the old sound 170 ms, 3b 175 ms); after the pick it builds for 4.3 dB before it falls (early/late -4.3 dB) | no: the reference thump rings 2.5 times longer and blooms |
| fast, sharp attack | spike at the pick | first 30 ms centroid 928 Hz (chords), 318 Hz (mutes); early/late -1.0 dB (chords): no spike | no |
| saturated but percussive | high saturation, dynamics kept | crest 10.9 dB (chords), 8.2 dB (mutes); level spread 8.2 dB across the chords, against 1.2 dB through the old sound and 2.2 dB through 3b; spectral flatness -2.4 dB, as ours | the saturation matches, the dynamics do not: ours were flattened to one level |
| stereo | two tight rhythm guitars | the two exports are the same notes with different timing and tone: magnitude-squared coherence 0.7-0.8 above 400 Hz (0.3-0.5 below 200 Hz), peak cross-correlation -0.25 at an offset of about 72 ms, zero-lag correlation 0.16. This corrects the earlier note that called them independent performances | a loose double, not a tight pair |

So the reference export is itself warmer and looser than the described sound: bass-heavy, a flat rather than peaked mid plateau, no low-mid scoop, a longer thump with a slow start, and far less compression than ours. The owner's words and the export pull in different directions on the low mids, the presence edge, the thump length and the attack; on the top (a steep roll-off needs a closed cabinet) and the saturation they agree. The previous round followed the export on the sustained spectrum and so produced the warm sound the owner rejected.

Where the candidates depart from the reference, and why: lean low mids (dip -2 to -4 dB against +0.6), more upper-mid bite (0.8-3 kHz at -23 to -16 dB against -24), a steeper top (6-10 kHz 13 to 18 dB under the reference's), a tighter thump (palm-mute 150 Hz band falls in 160-185 ms against 445 ms) and a sharper attack (early/late +0.8 to +1.3 dB against -1.0). All of it follows the description. 5a follows the reference for the shape of the chords and departs only where a closed cabinet cannot follow it.

### 2. What there is to build it from

- Amps (`tone.rs`, `amp_shape`): crunch, three stages (interstage coupling corners 30, 90 and 70 Hz, a 160 Hz cathode shelf), lead, four stages (30, 120, 90 and 60 Hz, 200 Hz shelf), metal, five stages (60, 160, 120, 90 and 60 Hz, a 250 Hz shelf, stage low-passes of 16, 9, 6.5, 7 and 12 kHz) and bass drive, three stages with an inverted 170 Hz path around them. The gain pot sits on the second stage with an audio taper; each stage is a rounded asymmetric clipper; the fixed voicing after the preamp is a low shelf, a mid peak and a high shelf (metal: +10 dB at 170 Hz, -1 dB at 520 Hz, +8 dB above 1.9 kHz), followed by a power stage with sag (gain 0.3, limits 1.0 and 1.05, sag 0.15). The user tone stack (bass shelf 100 Hz, mid peak 650 Hz, treble shelf 2.5 kHz, presence peak 4.5 kHz, each plus or minus 12 dB) sits after the whole amp, ahead of the cabinet, and is linear. There is no power-amp resonance and presence pair beyond that tone stack and the cabinet's 115 Hz box resonance. Everything nonlinear is oversampled four times below a 64 kHz sample rate, two times up to 128 kHz and not at all above.
- Drive pedals: the overdrive clips only what lies above 720 Hz and adds that to the untouched input, so it is a mid-presence boost, not a bass-cut tightener (its clean path is full range); the distortion has a 420 Hz pre-clip bass cut; the fuzz is lopsided. None has a "bass cut before the amp around 700 Hz hump" as one control.
- Equalizers: the EQ block (low shelf at 180 Hz, a mid peak at 200-5000 Hz, high shelf at 4 kHz, each plus or minus 24 dB) and the graphic EQ (ten octave-spaced peaking bands, 31.5 Hz to 16 kHz, plus or minus 12 dB). The pedalboard order can be changed per sound (`order`), so the EQ block can stand ahead of the drive pedal and amp: that is the bass cut and mid hump of a boost. The factory sound definition (`factory-sounds.ts`) cannot carry an `order` or a cabinet response yet.
- Cabinets: built-in closed (a synthetic four-by-twelve: +3.5 dB body at 200 Hz, a presence rise of only +2 dB at 2.6-3.3 kHz, a fall of 25 dB over the octave above 4.8 kHz, two box high-passes at 90 Hz), combo, bass stack, and the simple open and bass filters. Bundled cabinet responses under `src-tauri/resources/cabinet-irs`: 58 CC0 captures (the licence is in the folder), among them guitar closed four-by-twelve and two-by-twelve responses with dynamic and ribbon microphones at several positions and large-diaphragm condenser ones, open-back combo responses, and bass cabinets. A sound can name one by its identity (`cabinet.ir`); a machine without it plays the built-in cabinet instead. The candidates use one of the four-by-twelve responses with a dynamic microphone, named in the fixtures only as "bundled closed four-by-twelve".
- Gate (threshold and release), the `lowEndOct` setting (metal amp only, 0-1 octave: lowers the stages' low cuts).

Reachable with parameters alone (what the candidates use): a tightening boost (EQ bass cut and mid hump ahead of the overdrive pedal at minimum drive and raised level), more gain into the metal amp, the low cut moved down for the low tuning, a lean low-mid and upper-mid shape from the tone stack and the graphic EQ, and a cabinet response with real upper-mid structure. Not reachable, and not built (no model element was added, so the legacy-equivalence and golden tests are unchanged and pass as they stood): (a) a level-following saturation: the amp's output is almost level-independent, so the level spread across notes is 1.7-4.6 dB against the reference's 8 dB; a stage that keeps dynamics under high gain is a new design; (b) a one-knob boost with a built-in bass cut (the EQ block does it, at the cost of an extra block and a changed order); (c) a power-amp resonance and presence pair (the tone stack and the graphic EQ stand in); (d) the factory sound format carrying `order` and a cabinet response, which is plumbing in `factory-sounds.ts` and `edit-types.ts` if the owner picks a candidate. If one is picked, (d) is the only change it needs in the repository besides the sound itself.

### 3. The candidates

Four, on a line from "as close to the reference as the chain gets" to "the description whatever the reference says". All use the same structure (EQ bass cut and mid hump ahead of an overdrive pedal at minimum drive and raised level, the metal amp with a lowered low cut, the bundled closed four-by-twelve response, a graphic EQ after it with the 31.5 Hz band cut 12 dB and the 8 and 16 kHz bands held to +3 dB or lower), and differ in the tone shaping. Their graphic EQ was fitted by least squares on the analytic band responses against a target spectrum (the reference's own for 5a; the reference's with an explicit delta for the others), then verified by rendering; the tone stack and amp settings were chosen by hand.

| | character | boost (EQ low / mid, pedal level) | amp: drive, low end, bass / mid / presence | graphic EQ 63 / 125 / 250 / 500 / 1k / 2k / 4k Hz |
|---|---|---|---|---|
| 5a reference | the reference's shape on the chords, tight structure: bass-led, plateau 1-4 kHz, no hard edge | -8 dB, +5 dB at 800 Hz, +3 dB | 0.5, 0.5 oct, +4 / -2 / +3 dB | +6 / +6 / +1.6 / -4.4 / -1.3 / -2.6 / -12 |
| 5b tight | the described character: bite around 2-3 kHz, lean low mids, steep top | -8 dB, +5 dB at 800 Hz, +3 dB | 0.5, 0.5 oct, +4 / -2 / +3 dB | +6 / +6 / 0 / -6.7 / 0 / +2.2 / -5.4 |
| 5c scooped | 5b with more depth and a deeper scoop (300-800 Hz down, thump up) | -6 dB, +3 dB at 700 Hz, +3 dB | 0.6, 0.75 oct, +9 / -9 / +4 dB | +6 / +5.8 / -0.1 / -8.2 / -0.5 / +1.3 / -4.7 |
| 5d mid-forward | most note definition: a stronger mid hump, more 0.8-3 kHz, less low end | -10 dB, +9 dB at 1 kHz, +3 dB | 0.45, 0.5 oct, +2 / 0 / +4 dB | +6 / +6 / +0.9 / -5.2 / +0.2 / +2.3 / -8.1 |

The amp gain is set so each sits +3.5 dB over the middle factory sound on the level tone (inside the plus or minus 6 dB window, about as loud as the old sound's +2.9 dB and the previous round's +4.8 dB).

### 4. Feature tables (the owner's octave-low riff)

Open power chords (n = 84):

| sound | crest | level spread | first-30 ms centroid | early/late | thump fall 20 dB | 100-150 | 200-500 | 0.8-3k | 2-4k | 4-6k | 6-10k | low-mid dip | slope above 5k | rms deviation from reference |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| reference | 10.9 | 8.2 | 928 Hz | -1.0 | 700 ms | -10.5 | -16.6 | -24.0 | -23.5 | -23.1 | -27.3 | +0.6 | -21.9 | |
| old metal rhythm | 9.7 | 1.2 | 915 Hz | +0.2 | 700 ms | -15.6 | -13.8 | -16.6 | -14.7 | -22.4 | -36.9 | +2.3 | -36.5 | 7.8 dB |
| 3b (rejected) | 8.4 | 2.2 | 324 Hz | -0.5 | 700 ms | -8.3 | -18.1 | -25.6 | -23.6 | -31.5 | -47.8 | -1.2 | -41.6 | 9.2 dB |
| 5a reference | 9.4 | 3.3 | 406 Hz | +0.8 | 700 ms | -10.3 | -14.6 | -23.2 | -23.1 | -27.3 | -41.7 | +2.2 | -21.0 | 5.4 dB |
| 5b tight | 10.6 | 2.7 | 863 Hz | +0.8 | 625 ms | -10.5 | -16.3 | -18.4 | -16.8 | -21.7 | -40.0 | -1.9 | -26.3 | 6.0 dB |
| 5c scooped | 10.3 | 4.6 | 640 Hz | +1.3 | 610 ms | -8.3 | -19.7 | -22.9 | -19.6 | -22.6 | -41.4 | -4.1 | -27.1 | 6.9 dB |
| 5d mid-forward | 10.6 | 1.7 | 964 Hz | +0.9 | 700 ms | -12.5 | -16.0 | -15.9 | -15.5 | -21.0 | -38.2 | -1.8 | -25.8 | 6.9 dB |

Palm mutes (n = 200):

| sound | crest | level spread | first-30 ms centroid | early/late | thump fall 20 dB | 100-150 | 200-500 | 0.8-3k | 2-4k | 4-6k | 6-10k | low-mid dip | slope above 5k | rms deviation from reference |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| reference | 8.2 | 1.7 | 318 Hz | -4.3 | 445 ms | -7.0 | -25.1 | -39.1 | -39.0 | -39.1 | -44.1 | -2.0 | -23.6 | |
| old metal rhythm | 9.3 | 0.9 | 600 Hz | -1.2 | 170 ms | -12.6 | -14.2 | -18.6 | -16.9 | -24.9 | -39.9 | +1.4 | -37.9 | 15.6 dB |
| 3b (rejected) | 7.4 | 1.7 | 216 Hz | -2.0 | 175 ms | -6.6 | -23.0 | -33.7 | -32.3 | -42.1 | -59.0 | -2.8 | -43.0 | 8.1 dB |
| 5a reference | 9.4 | 2.8 | 298 Hz | -2.4 | 180 ms | -9.1 | -16.2 | -26.9 | -27.1 | -31.8 | -46.5 | +1.8 | -21.9 | 9.8 dB |
| 5b tight | 9.9 | 2.6 | 521 Hz | -2.5 | 160 ms | -9.0 | -17.5 | -22.0 | -20.6 | -25.9 | -44.5 | -2.1 | -27.2 | 12.0 dB |
| 5c scooped | 8.9 | 3.1 | 412 Hz | -2.5 | 185 ms | -7.2 | -21.7 | -28.0 | -24.8 | -28.0 | -47.1 | -4.1 | -27.9 | 7.8 dB |
| 5d mid-forward | 10.5 | 1.7 | 674 Hz | -1.3 | 185 ms | -11.2 | -15.8 | -17.9 | -17.7 | -23.6 | -41.1 | -1.3 | -26.3 | 15.1 dB |

Reading them. Fizz, the first failure mode: the palm mutes' 0.8-3 kHz band was -18.6 dB of the total in the old sound against -39.1 dB in the reference; 5c (-28.0) and 5a (-26.9) are well under it, 5b (-22.0) in between, and 5d (-17.9) is as high as the old sound, so 5d risks the old fizz on chugs. Vintage looseness, the second: 5b, 5c and 5d have a negative low-mid dip (5a follows the reference's bass-led tilt and has +2.2 dB) and a palm-mute thump that falls 20 dB in 160-185 ms where 3b's did in 175 ms and the reference's in 445 ms; the sound is tight by that measure and the early/late of the chords is positive (a snap) where the reference and 3b are negative. The level spread across notes is 1.7-4.6 dB against 8.2 dB for the reference: the amp still flattens the dynamics, 5c least. The 6-10 kHz band is 11 to 15 dB under the reference's in every candidate: the described steep top, and this may sound dull next to the export.

On a standard-tuned riff (palm-muted power chords and open power chords, 8 open and 18 muted windows; no reference exists), level relative to the total:

| sound | open: 100-150 / 200-500 / 0.8-3k / 4-6k | dip | slope | muted: 100-150 / 200-500 / 0.8-3k | crest open / muted |
|---|---|---|---|---|---|
| old metal rhythm | -22.1 / -15.6 / -13.8 / -19.2 | +2.4 | -36.6 | -17.5 / -13.0 / -15.8 | 10.3 / 9.9 |
| classic rock sound | -19.3 / -12.7 / -17.0 / -24.1 | +5.4 | -37.1 | -13.9 / -12.7 / -23.0 | 8.9 / 8.7 |
| 5a reference | -13.2 / -13.9 / -17.9 / -21.9 | +1.6 | -20.9 | -10.3 / -13.1 / -23.3 | 12.1 / 9.7 |
| 5b tight | -15.0 / -17.2 / -14.3 / -17.9 | -2.6 | -26.3 | -10.5 / -14.8 / -18.2 | 11.2 / 10.2 |
| 5c scooped | -12.5 / -18.5 / -16.2 / -16.5 | -4.2 | -27.1 | -8.9 / -18.0 / -21.8 | 12.0 / 10.8 |
| 5d mid-forward | -15.9 / -18.4 / -13.4 / -18.6 | -3.7 | -25.5 | -11.5 / -15.0 / -15.9 | 10.5 / 10.4 |

None of them is boomy or woolly in standard tuning: the 100-150 Hz band stays 9-16 dB under the total, the low mids are leaner than the old sound and the classic rock one, and the bite is where it is on the low tuning. The `lowEndOct` of 0.5 to 0.75 octaves, chosen for the octave-low guitar, does not make E2 muddy.

Checks, all four candidates (at the time a test file of the four, replaced by `audio_metal_rhythm_sound.rs` for the chosen one; with the bundled response installed): +2.2 to +3.3 dB over the middle factory sound on the level tone (a plucked A2 and A3; the window is plus or minus 6 dB); a hard chord with an input peak of 1.6 peaks under 0.8 at 44.1, 48, 96 and 192 kHz, under the master limiter's 0.9; finite, bounded and silent two seconds after a note at all four rates; nothing above 6 kHz worth hearing (under -40 dB of a note's energy); no heap operation while playing, including the response's convolution; fixtures validate, save and read back unchanged, name the bundled response only by its identity and the neutral label "bundled closed four-by-twelve". CPU, one track through the owner's 3-minute score, release build, whole render including loading samples, best of two: 14.6 s for the old sound, 17.3 s (5a), 17.3 s (5b), 16.9 s (5c), 16.8 s (5d): about 9.4% of real time against 8.0%, so roughly 17% more per track, from the convolution and the two equalizers; bounded and allocation-free. The ignored `selected_real_100bar_fourtrack_resource_budget` test passes. No TypeScript changed in that round.

### 5. Clips

`clips-v2` (outside the repository), in the four folders `rhythm-guitar-one`, `rhythm-guitars-both`, `second-score` and `standard-tuned-riff`: `1-reference.wav` (where one exists), `2-old-metal-rhythm.wav`, `5a-reference.wav`, `5b-tight.wav`, `5c-scooped.wav`, `5d-mid-forward.wav`, and a `README.txt` with the one-line descriptions; level-matched to the reference by RMS (to the old sound where there is none), 44.1 kHz. The standard-tuned clip is the new riff of power chords and chugs, not the earlier single-note one.

### Limits of this round

Measurements and my reading of a description, not listening. The target spectra for 5b, 5c and 5d are explicit guesses at the described character (stated deltas on the reference's), so the owner's pick says how far to go, not whether the numbers are right. The reference is one export of one song. The level spread is still 1.7-4.6 dB against the reference's 8 dB: a level-following saturation would be a model addition, not built. 5a is the closest to the reference of the four on the chords (5.4 dB rms) but not the closest on palm mutes (9.8 dB); no candidate matches the reference's longer, blooming thump, on purpose. Candidates that use a bundled cabinet response need it in the library; the app bundles it. `lowEndOct` stays restricted to the metal amp.

## Decision: Metal rhythm is candidate 5d

The owner listened and picked 5d (mid-forward). `develop` (`221f6d6`) was merged into the branch first (no conflicts). Everything above this section describes how the candidates were reached; this section is what the branch now holds.

### What changed

- **The factory sound.** `metal-rhythm` in `src/audio/factory-sounds.ts` and `tests/factory-sounds.json` is the 5d chain exactly as rendered in the clips: a gate (-50 dB, 60 ms); the EQ block ahead of the pedal (low shelf -10 dB, mid +9 dB at 1 kHz); the overdrive pedal at drive 0.1, tone 0.8, level +3 dB; the metal amp at drive 0.45, gain -4.2 dB, `lowEndOct` 0.5, bass +2 dB, presence +4 dB; the closed cabinet with one of the bundled closed four-by-twelve responses; and the graphic EQ (-12, +6, +6, +0.92, -5.17, +0.21, +2.3, -8.08, +3, -12 dB from 31.5 Hz to 16 kHz). The description reads "Tight, modern high gain: a bass-cut boost ahead of the amp, a closed four-by-twelve, and plenty of upper-mid bite." The name and category are unchanged.
- **A factory sound can carry a pedalboard order and a bundled cabinet response.** The smallest change that does it: the factory definition gained an optional `order`, which is copied into the sound's existing `order` field (it was already in `FxSettings`, the Rust settings, the validation and the saved format); the cabinet response needed nothing, because a factory patch already carried any field of a block (`cabinet.ir`) and the engine already plays a named response and falls back to the cabinet model where the library lacks it. No edit type, project schema or Rust setting was added or changed, so old `.tabplayer` projects and edit logs replay unchanged. The factory catalog (`tests/factory-sounds.json`) now holds `order` for this sound, and `audio_factory_sounds.rs` compares it and the nested response by value.
- **Projects that already use Metal rhythm are unchanged.** A factory sound is applied by copying its settings into the track's sound, so a project holds the settings it was saved with and renders exactly as before until the owner chooses the sound again. The released definition (gate, overdrive pedal at 0.2/0.6, metal amp at drive 0.55 and gain -2 dB, closed cabinet) stays in `earlierDefinitions`, which the mixer uses to name those tracks "Metal rhythm (earlier version)". It renders bit for bit as it did on the build before THE-217: the golden table in `audio_metal_rhythm.rs` holds its hashes (taken on `bad9042`), and the settings are now built explicitly in that test and still match them. Line-In follows its factory choice by name, so a Line-In set to Metal rhythm now plays the new sound.
- **The rejected 3b voicing is gone**, and with it the 3a "tighter voicing" test and the tests that measured the 3b body and fizz against the released sound (they asserted properties of that voicing and are not true of this one). The candidates 5a, 5b and 5c are gone from the test presets; only 5d remains, as `src-tauri/tests/fixtures/metal_rhythm_preset.json`, because the bit-identity test needs it. The measurements of all four stay in this note.
- **`lowEndOct` stays**, because 5d uses it (0.5 octave), restricted to the metal amp and 0-1 octave as before. It has not been released, so no merged project holds it and nothing needed to be kept for replay beyond that.
- **No new UI text**: the sound's name and description are English strings in the factory definition like every other factory sound, and the amp's low-end control already has its `en`, `et` and `de` labels and tooltip.
- **Names**: the cabinet response is named in the sound only by its identity and the label "bundled closed four-by-twelve"; no brand or product name appears in any committed file I wrote, and no path, song or track name.

### Tests for the final sound (`audio_metal_rhythm_sound.rs`)

- The catalog's Metal rhythm equals the preset the owner picked as a value, and renders the same bits through the real chain at 44.1 and 48 kHz with the bundled response installed. Outside the test, the catalog sound's render of the owner's whole three-minute track at 44.1 kHz is byte-identical to the file rendered for the clip (`cmp`).
- It validates, writes and reads back unchanged, names the bundled response only by identity and the neutral label, finds that response in the library, and stands the EQ before the pedal, the pedal before the amp, the amp before the cabinet and the graphic EQ after it.
- Level window: +3.3 dB over the middle factory sound on the level tone (window +/-6 dB, test band +1.5 to +5), and +0.4 dB over the released sound, so choosing it again is not a jump (a test pins it under 3 dB). `audio_factory_sounds` also passes; it runs without the response installed, so it plays the cabinet model there.
- A hard chord (input peak 1.6) peaks under 0.8 at 44.1, 48, 96 and 192 kHz; finite, bounded and silent two seconds after a note at all four rates; nothing above 6 kHz worth hearing (under -35 dB of a note); bite: 0.8-3 kHz within 2 dB of the 200-500 Hz band of an A2 note.
- No heap operation while it plays; and none on the audio thread when it is chosen during playback: the new chain is built and its response loaded off the audio thread (`PreparedMix::prepare`, as for any sound), and the take-over and the playing after it are counted at all four rates, from the released sound and from an empty chain.
- A machine whose library lacks the response plays the closed cabinet model instead (finite, not clipping).
- The ignored `selected_real_100bar_fourtrack_resource_budget` test was run and passes.
- Desktop driver `parity-factory-sounds`, in the rebuilt test app: passes. The exported chord through Metal rhythm has 1-8 kHz at -6.6 dB of its 40 Hz-8 kHz power against -25.4 dB for Warm jazz clean (a margin of +18.8 dB where the assertion asks for more than 10), and the levels are -29.3 and -24.8 dB, 4.5 dB apart where 6 is allowed. The driver compares what the native player records with the catalog: it records no tone fields at zero, so the catalog's Metal rhythm leaves out the amp's mid and treble (both 0 dB) instead of naming them.
- Full runs on the merged branch: `cargo fmt --check`, `npm run typecheck`, `npm test -- --testTimeout=60000` (7368 tests) and `cargo test --locked --workspace --no-fail-fast` (95 test binaries) pass, except that under load one `tuner` lib test failed in the full cargo run (it passes alone together with the rest of its module; it is code merged from `develop` and not touched here). The `plan.performance` snapshot was restored after the npm run.

### A risk to recheck in the installed build

5d's palm mutes measured 0.8-3 kHz at -17.9 dB of the total, about the level of the released sound (-18.6 dB), which the owner called fizzy; the reference's is -39.1 dB and 5c's -28.0 dB. The owner chose 5d by ear and it was not retuned. Whether the chugs sound fizzy in the installed app (with the bundled response, which the clips also used) is the thing to listen for first; the knobs that would calm it without changing the character are the graphic EQ's 2 kHz band and the amp's presence.

### Further limits

- A project, a saved sound or a Line-In preference that holds `lowEndOct` is refused by a build that does not have the setting (the amp's settings refuse unknown keys), as when `presenceDb` was added. The key is only written for a non-zero value, and the new Metal rhythm sets it, so a project that uses the new sound will not open in an older build.
- Line-In follows a factory choice by name (an existing design), so a Line-In that was set to Metal rhythm plays the new sound from its next start, without the owner choosing it again.
- The CPU cost of Line-In through this sound, which now includes the cabinet response's convolution, at small device buffers was not measured; only the offline render and the four-track budget test were.

### Saved sounds are recognised whatever the order of a block's fields

The mixer names a track's sound by comparing the text form of its settings with each factory sound's. That text depended on the order of the fields inside each block, which the editor and the native player do not share (the editor lists the amp's fields as drive, gain, low end, bass, presence; the player writes bass, presence, low end), and after a save and reopen the sounds come from the edit log the player wrote, so a track holding the new Metal rhythm would have been named "Lead (edited)". The comparison now sorts the keys of every object before comparing (the pedalboard's `order` list keeps its order, since it says where each block stands). A test reproduces it first (the amp's fields in the player's order, and every factory sound and earlier version with the keys of every block reversed) and passes now; another ties the earlier version of Metal rhythm to the row the release held (`tests/fixtures/released-metal-rhythm.json`, copied from the factory catalog on `develop` before the retuning), so it cannot drift. The desktop driver `parity-factory-sounds` now also checks that applying Metal rhythm records its pedalboard order and that undo restores the previous sound's.
