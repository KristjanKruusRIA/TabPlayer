# THE-217: the metal rhythm sound is fizzy and lacks body

Date: 2026-11-15. Branch `agy/the-217-metal-amp`, on top of the palm-mute fix (THE-214). These are measurements. Nobody has listened to the result yet; the owner's ears decide whether it is better, and nothing should be merged before then.

The owner's words: the palm mutes are right now, "the amp doesn't sound very good still", then "fizzy and lacking body". CLAUDE.md says `tone.rs` is not retuned unless the owner asks; this complaint is that request for the metal rhythm sound. No constant of the amp or the cabinet was retuned. `tone.rs` gained one optional setting whose default changes nothing (below).

"The reference" is the owner's Guitar Pro export of the left rhythm guitar of one of their songs (the right guitar is exported hard right; the two are independent performances, correlation 0.09). "Ours" is the track played through the metal rhythm sound with the sampled black guitar, rendered at 48 kHz. Windows are `min(gap to the next onset, 250 ms)` from the written onset (the reference aligned by onset search, +91 ms), notes at MIDI 47 or below with a gap of at least 110 ms: 229 open notes and 200 palm mutes. All band figures are shares or levels of the spectrum of those windows, power-averaged over the notes. The reference is a normalised export, so absolute levels are not comparable with ours; shapes (levels relative to the window's total) are.

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

`src-tauri/src/audio/tone.rs`, `dsp.rs`: one new optional amp setting, `lowEndOct` (octaves, 0 to 2, default 0, 0 is not saved): the corners of the low cut ahead of each stage (the coupling high-pass and the shelf) move down by that many octaves. The default multiplies every corner by exactly 1, so the amp, its calibration and every sound that does not set it are bit for bit what they were. It is a slider in the amp panel ("Low end (octaves)", with `en`, `de`, `et` strings), and typed in `edit-types.ts`, `document-settings.ts`. Nothing on the audio thread changed in cost: the corners are resolved off the thread with the rest of the shape.

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

No saved project changes by itself. A factory sound is applied by copying its effect settings into the track's sound; the project holds those values, not the sound's name. A project that copied the old metal rhythm keeps the old parameters and renders bit for bit as before (checked: the old settings through the new build give byte-identical audio to the old build). To hear the new sound the owner picks "Metal rhythm" again on the track (or dials in the values above). A project that uses the metal amp with other settings is unchanged too.

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

`src-tauri/tests/audio_metal_rhythm.rs` (9 tests), on synthetic notes only (partials falling as 1/h, plucked decay; G1 for the low tuning and A2 for standard), at 44.1, 48 and 96 kHz:

- body: more than 90% of the energy under 250 Hz after, under 60% before, and 250 Hz to 1 kHz at least 6 dB down;
- fizz and top: the 1-6 kHz band at least 10 dB under what it was and under -20 dB of the note's energy, sustained and damped, above 6 kHz under -45 dB;
- a damped note within -5 to +2 dB of a sustained one, and a chug struck 12 dB harder no flatter than before (1.7 dB louder: unchanged, see the gap below);
- a hard chord of input peak 1.6 stays under 0.8, well under the limiter's 0.9;
- stable and alike across rates (shares within 1.5 dB), all finite, silent two seconds after the note;
- no heap use while it plays;
- `lowEndOct` 0 is the amp as it was (shape equality for every model, drive and rate), the key is not saved at 0, an old sound loads, out-of-range and NaN are refused, the setting does nothing on the clean path;
- more of a 41 Hz fundamental reaches the stages with each octave (at least +3 dB for the first);
- every other factory sound (19), a metal amp with the closed cabinet at the old settings and the default chain give the same output bits as the build before: an FNV-1a hash of one second of a decaying low E at 44.1 and 48 kHz, captured on that build (strict on Windows only, because the renderer's `sin`, `exp` and `powf` come from the platform's maths library; elsewhere the test checks they are finite, as `audio_palm_mute_identity.rs` does).

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
