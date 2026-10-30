# Driven tones: amps, pedals and cabinets rebuilt

Date: 2026-10-24. Status: design, implemented on the slice branch. Only a listener can sign this off: the A/B renders are the acceptance that counts, and the measurements below only say the design landed where it aimed.

## Brief

The user's verdict: the clean tones are good, but compared with GP8 the drive is unusable. Reading `dsp.rs` confirmed why. Each amp was one bias-shifted `tanh` with up to 600 times gain, so all the gain clipped at once with nothing thinning the low strings first, and a low chord turned to mud. The closed cabinet was a high-pass at 90 Hz and two 4.2 kHz low-passes: no presence, and only 24 dB an octave at the top. Oversampling was linear interpolation, so a high note at high gain folded back at -41 dB. A sample voice reaches the chain at single-note levels near 0.03 RMS with attacks 20 dB above that, and the pedals and amps were calibrated for neither.

This slice replaces the driven half of the chain. It adds no dependency, no captured data and no impulse response: everything is synthesized from how the circuits and speakers behave. Reference material on this machine (installed amp plug-ins, a commercial cabinet IR pack) was used only to check broad features, and none of it enters the repo or the app.

## Behaviour

### Amps (`src-tauri/src/audio/tone.rs`)

- Models `crunch` and `lead` improve in place; no clean factory sound uses them. New: `metal` and `bassDrive`. `clean` and `bass` stay on the original path, bit for bit.
- A driven amp is three to five triode-like stages, each: coupling high-pass, cathode low shelf, gain, asymmetric soft curve, low-pass. The gain pot sits on stage 2 with an audio taper that gives most of its rise early, so a low setting already saturates a sample's sustained level, as an amp does a pickup's.
- The low strings are thinned before the clipping and given back after it, by a fixed voicing that sits where a tone stack does, so restored lows cannot intermodulate.
- Aliasing is limited by slowing the edges that reach each clipper, through the middle stages' lower low-passes. A filter after a clipper cannot help, since what it folded back is already in the band.
- A power stage with supply sag follows the voicing, then a 6 Hz DC blocker.
- `bassDrive` carries the lows around the clipping, inverted, because a low-pass and the stages' high-passes meet near opposite phase and would otherwise cancel.
- Everything nonlinear runs through polyphase allpass halfbands, four times at the usual rates, two times below 128 kHz and not at all above.

### Pedals

The model names stay and the circuits change.

- **Overdrive:** clips only what lies above 720 Hz and adds that to the untouched input.
- **Distortion:** a band-limited op-amp stage ahead of the diodes, which took a 2.6 kHz note's aliases from -37 dB to -73 dB or better.
- **Fuzz:** two rounded stages, the first offset by the playing level after its coupling, so the offset survives; a small scoop after.

### Cabinets

- `closed` improves in place, because only driven sounds use it. New: `combo` and `bassStack`. `open` and `bass` keep their filters, bit for bit.
- A coarse magnitude curve with seeded cone ripple becomes a minimum-phase FIR through the real cepstrum, about 10.7 ms long, behind two box high-pass sections and a resonance peak.
- The design runs once per rate behind a shared lock, off the audio thread. One input history serves every model, so moving between models crossfades two readings of one past.

### Changing a sound while it plays

- Settings resolve into plain `Copy` shapes off the audio thread, and each shape is level-calibrated by running a 220 Hz sine through it. `process` allocates nothing and takes no lock.
- A ramp between two circuits crossfades two running chains, because a circuit part way between two has no known level: a coefficient ramp from overdrive to fuzz swelled tenfold.
- Mixed ramps crossfade the original path and the driven one.
- A mix that arrives during a crossfade waits in one slot and installs between blocks when the crossfade ends, because taking over mid-fade drops the sound the fade is leaving. A newer arrival replaces the waiting one, and every displaced mix retires off the audio thread.
- A seek clears both the running chains and the ones fading out.

### Cost

Sample voices reach the chain as exact mono unless panned, so while both channels hold the same state one channel runs and is copied. A panned track pays the full stereo cost until both channels hold identical bits again, which is when its tail has died or at a seek.

A silent track plays its tail to the end, then returns zero without running the amp, pedal or cabinet. This is bit-exact: zero input on all-zero state stays zero. A filter drops its state only when both halves have vanished, because zeroing one half of a near-double pole rings it up again, and an unused part of a circuit holds no state.

Disabled pedals skip the calibration run.

### Factory sounds

`driven-bass` is new. `blues-crunch`, `classic-rock`, `rock-lead`, `metal-rhythm`, `fuzz-lead`, `phaser-crunch` and `octave-lead` are retuned, with amp gain setting each one's level near the clean sounds' -22 LU.

## Decisions

- Keep every model name. A saved document's `crunch`, `lead` or `closed` loads and sounds better; the new names are validated in Rust, `src/document-settings.ts` and `SoundPanel`.
- Tightening lives in the cabinet's box filters rather than after the amp, because the sum is the same and the amp stays one calibrated block. So the `closed` curve is steeper below 80 Hz than a real close-miked speaker, whose rolloff the IR pack put near -11 dB at 47 Hz.
- Overdrive and distortion stay symmetric. Only the fuzz is lopsided.
- No gates were added to `rock-lead` or `fuzz-lead`: their tails measure -52 dB and -60 dB, which are their echoes, not sample noise.
- The level target stays the app's -22 LU rather than the plug-ins' louder output, so switching sounds does not jump.

## Acceptance

- `src-tauri/tests/audio_clean_sounds.rs` pins all 12 clean sounds against a golden at both rates. They also compare byte-identical against the pre-change build through the real voices.
- `src-tauri/tests/audio_tone.rs` pins cabinet shape at both rates, low-chord intermodulation and high-note aliases against a replica of the single-stage path, level across gain and rate, model validation, smooth changes between every model by both edit paths, determinism, reset, a track panned mid-play, and zero heap operations through processing, install, crossfade and reset.
- The same file holds pedal and cabinet shape, level, aliases and smooth changes at 96 and 192 kHz. Smooth changes also cover a second swap inside the ramp and a swap to the same model mid-fade, with 0.002 over the settled step everywhere and 0.035 for distortion to fuzz only.
- A silent track and a track centred again are compared bit for bit with the shortcuts off, tail included.
- One existing test changed: `the_default_order_sounds_exactly_as_before` in `audio_effect_order.rs` pins a bit-exact fingerprint with a drive pedal running, so it was retaken for the new pedal circuits. Every other existing test passes as it stood.
- A/B renders of six sounds in `output/tone-ab/`: `-old`, `-new`, and `-new-ir` with the cabinet swapped for a reference IR, local only.

## Limits

- Only listening can judge this. The figures are a broad guide, not a match to any product.
- A heavy track costs two to three times what it did, and a panned one about twice a centred one.
- A full mix can still overrun. There is no overload guard, and xruns are still ignored. Release `tone_ab mix-bench`, `metal-rhythm`, chain only without voices, in percent of one core:

| Tracks | Centred | Panned | Panned, duplicate boards | A quarter sounding | All silent |
|---|---:|---:|---:|---:|---:|
| 8 | 29 | 53 | 110 | 10 | 3 |
| 16 | 61 | 107 | 212 | 20 | 6 |

- A muted track with sounding notes runs in full, because skipping it would change what is heard on unmute.
- A track centred again keeps its stereo cost while it keeps sounding. Merging channels that are only nearly equal would not be bit-exact.
- A silent track still pays for the rest of the board, about 0.4% of one core, because its LFO phases must keep advancing.
- A swap between sounds far apart in gain steps more than the settled wave: metal 1.0 to crunch 0 steps 0.011 against 0.003. A chained swap of those two is held to the same changes played apart, plus the usual 0.002.
- Changing a pedal from distortion to fuzz in front of a saturated amp can give one sharper edge during the 10 ms ramp. It is an edge in the wave, not a jump, and `audio_tone.rs` bounds it.
- Parking lives in the renderer. Calling `transition_from` directly during a ramp still clicks.
- At 192 kHz the cabinet FIR is capped at 1024 taps, or 5.3 ms. It stays within 1.5 dB of the 48 kHz curve.
- The cabinets are fixed: no microphone or position choice.
