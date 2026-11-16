# Recorded drum kit balance against General MIDI (2026-11-16)

Date: 2026-11-16. Branch `agy/drum-kit-balance`, cut from `develop` at `e187ac9`. Candidates on `agy/drum-kit-balance-a`, `-b` and `-c`, and later (see the addendum at the end) `-d` to `-h`.

Status: measured, not listened to. Nobody has heard the candidates; the owner chooses by ear. The shipped kit is unchanged on this branch.

## Symptom

The owner, by ear, in the installed app on a real song: a drum track on the recorded kit ("Automatic instrument" source) "plays only cymbals, and everything else quietly, very reverby". With General MIDI drums the same song sounds normal. The same owner approved a short demo of this kit by ear on 2026-11-06 (see `2026-11-06-gp8-recorded-drums.md`). The owner's musical direction is metalcore: fast kicks, a loud snare, many crashes.

## Method

All measurements render through the real `Renderer` (offline, 48 kHz) from the bundled audio, with an ignored test program: `src-tauri/tests/audio_recorded_kit.rs`, tests `recorded_kit_balance`, `recorded_kit_velocity_sweep`, `recorded_kit_levels` and `recorded_kit_clips`. Each runs `cargo test --release --test audio_recorded_kit -- --ignored --nocapture <name>`.

- Two engines play the same notes: the recorded kit (every note carries its kit sound) and General MIDI (the sound bank's Standard kit).
- Single hits are rendered for 16 s, at velocities 40, 70, 100 and 127 for the nine elements the owner named (kick 36, snare 38, rim shot 1, closed hat 42, open hat 46, low tom 45, high tom 48, crash 49, ride 51), and at every velocity from 1 to 127 for the sweep.
- Loudness is K-weighted (ITU-R BS.1770, 48 kHz) mean power over the first 300 ms, written "K level" below; peak is the largest sample. "Early/late" is the energy of the first 50 ms against the next 950 ms: high means dry and punchy, low means ringing. "To -20 dB" and "to -40 dB" are the last time the 10 ms power is within that many dB of its loudest.
- Channel volume (controller 7) is what Guitar Pro's default track volume of 15 sends: alphaTab writes `volume * 8`, 120; the tests use 119, 0.1 dB lower. The earlier tests of this file send none, and that matters (see "Channel state"). Pattern results were also measured at 103, 127 and none.
- Two patterns (both in the test file): `groove`, the demo's two-bar groove at 120 bpm exactly as it was written on 2026-11-06 (240 ticks per step, kick on every fourth step, snare between, a rim shot, hi-hats and an open hi-hat), once at velocity 100 as in the demo and once at 95; and `metal`, 8 bars at 180 bpm: double kick on every sixteenth (127 on the bar's first, 100 on the other beats, 92 between), snare on 2 and 4 (110, 127 on beat 4 of the third and seventh bar) with a ghost note (45 or 55) before each, a crash on every beat (100, 127 on the first of bars 1 and 5), eight sixteenth toms in the fill bars 4 and 8 (95 rising to 123), and a closing kick and crash at 127.
- Velocities follow alphaTab's: a note with no dynamic is `F`, velocity 95; `mf` 79, `mp` 63, `p` 47, `ff` 111, `fff` 127. That 95 is the Guitar Pro default is read from alphaTab's source (`MidiUtils`), not from a song.
- "Stands out" is how far the first 50 ms of a kick, or of a snare stroke of velocity 90 or more, sits above everything else playing then (the whole clip minus that group, which is exact because the renderer adds voices linearly).

## Findings

### a. Nothing regressed since the kit commit

- `git diff a138b4b..HEAD` over `assets/audio`, `scripts/prepare-audio.mjs` and the drum paths of `src-tauri/src/audio/renderer.rs` (`select_drum`, the drum branch of `start_note`, the kit mix in `frame`) is empty. The other changes to `renderer.rs` and `voices.rs` since then are plug-in inserts, golpe knocks, palm-mute cuts and the key shift; none runs for a recorded drum voice.
- The recorded drum voice is a `SampleVoice` playing `Articulation::Picked`. The test `audio::voices::legacy_equivalence` (kept for the palm mute change) renders a verbatim copy of the voice from before that change and the current one and requires identical bits for every articulation but the palm mute and the dead note, Picked among them. It passes on this branch (2 passed).
- So no render-to-render comparison against `a138b4b` was built: the code and the audio that decide a drum voice's sound are the same bytes, and the one shared piece that changed is shown bit-identical for drums.

The demo of 2026-11-06 and a real song therefore differ in what they play, not in how the kit renders: the demo plays every note at velocity 100 and sends no channel volume; a song plays the velocities its file has (95 where no dynamic is written, by alphaTab's rule) and sends a channel volume.

### b. Loudness and velocity response

Kit minus General MIDI, by K level over the first 300 ms, at channel volume 119 (negative: the kit is quieter):

| element | 31 | 40 | 47 | 63 | 70 | 79 | 95 | 100 | 111 | 127 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| kick | -6.9 | -4.1 | -5.2 | -7.2 | -0.9 | -1.7 | -3.0 | -0.1 | -0.8 | -1.7 |
| snare | 1.4 | -0.8 | -3.0 | -5.0 | -5.6 | -4.8 | -5.6 | -4.7 | -4.5 | -3.6 |
| rim shot | 3.7 | 5.1 | 2.6 | 2.4 | 1.8 | -4.3 | -6.8 | -4.5 | -4.9 | -6.2 |
| closed hat | -6.4 | -5.0 | -6.1 | -8.1 | -6.5 | -7.3 | -8.6 | 2.5 | 1.8 | 0.9 |
| open hat | -4.8 | -6.4 | -7.6 | -9.6 | -9.8 | -10.6 | -11.9 | 2.0 | 1.3 | 0.3 |
| low tom | 3.3 | 4.6 | 1.8 | 1.1 | 1.7 | 0.7 | -0.3 | -0.1 | 0.4 | -0.9 |
| high tom | 5.7 | 7.1 | 4.3 | 0.8 | 0.8 | -0.7 | -2.4 | -0.4 | -2.5 | -2.9 |
| crash | 6.0 | 4.3 | 1.8 | -0.3 | -1.1 | -1.9 | 2.6 | 1.8 | -0.1 | -2.4 |
| ride | -6.1 | -7.9 | -2.6 | -4.7 | -5.4 | -6.2 | -2.2 | -3.1 | -4.9 | -7.2 |

At velocity 100, the point the kit was levelled at, the kit is within about 5 dB of General MIDI everywhere. At 95, where Guitar Pro puts a note with no dynamic, the closed and open hi-hat are 8.6 and 11.9 dB down, the snare and rim shot 5.6 and 6.8, the kick 3.0; the crash is 2.6 dB up.

Cause, from the recordings. The kick, closed hi-hat and open hi-hat have four recorded velocity layers, the crash, ride and pedal hi-hat three, and the layers are not level with each other. Mean K level of each recorded layer at full gain (variants averaged), and the engine's own gain on top (24 dB per decade of velocity from the layer's bottom to its top at `velocityGainHigh`, set by the `amp_velcurve_N` of the layer):

| sound | velocities | `velocityGainHigh` | layer K level dB | step from the layer below | gain at the layer's first velocity |
|---|---|---:|---:|---:|---:|
| kick | 1-31 | 31 | -55.0 |  | (starts at 1) |
| kick | 32-63 | 63 | -43.3 | +11.8 | -7.1 |
| kick | 64-95 | 95 | -31.4 | +11.9 | -4.1 |
| kick | 96-127 | 127 | -25.4 | +5.9 | -2.9 |
| closed hat | 1-31 | 31 | -62.9 |  | (starts at 1) |
| closed hat | 32-63 | 63 | -52.3 | +10.5 | -7.1 |
| closed hat | 64-95 | 95 | -45.6 | +6.7 | -4.1 |
| closed hat | 96-127 | 127 | -31.5 | +14.1 | -2.9 |
| open hat | 1-31 | 31 | -50.7 |  | (starts at 1) |
| open hat | 32-63 | 63 | -43.5 | +7.2 | -7.1 |
| open hat | 64-95 | 95 | -38.0 | +5.5 | -4.1 |
| open hat | 96-127 | 127 | -21.6 | +16.3 | -2.9 |
| crash | 1-42 | 42 | -35.5 |  | (starts at 1) |
| crash | 43-85 | 85 | -29.3 | +6.2 | -7.1 |
| crash | 86-127 | 95 | -23.3 | +6.1 | -1.0 |
| ride | 1-42 | 42 | -53.4 |  | (starts at 1) |
| ride | 43-85 | 85 | -40.6 | +12.8 | -7.1 |
| ride | 86-127 | 95 | -35.0 | +5.7 | -1.0 |

- The closed hi-hat's top layer (velocities 96 to 127) is 14.1 dB louder than the layer under it, the open hi-hat's 16.3 dB. The engine's gain restarts at 96 at -2.9 dB (96/127 to the power 1.2), so the K level jumps +11.6 dB (closed) and +14.4 dB (open) between velocities 95 and 96. Levelling "at velocity 100" set the top layer; every note up to 95 sits 8 to 12 dB below it.
- The kick has +7.3 dB between 63 and 64 and +5.0 between 31 and 32; the snare, rim shot and toms, whose many layers (36, 12 and 16) each play flat (`amp_velcurve_1=1`), step by up to 4 dB (snare), 6 (rim shot) and 5 and 8 (toms) at a single layer edge, and are not monotonic: the rim shot's layers at 54 to 74 are as loud as those at 96 to 106.
- The crash and ride top layer is `amp_velcurve_95` in the upstream map, so above 95 their level does not change at all (crash 95 equals 127; General MIDI rises 4.2 dB between 100 and 127). The fourth round robin of that layer has no `amp_velcurve` upstream, so it ramps to 127 instead: by the formula (not measured separately) every fourth stroke of a crash, sizzle crash, ride, flat ride or pedal hi-hat is 2.5 dB softer at velocity 100 and 3.0 dB at 95 than the other three.
- Velocity response against General MIDI (K level re velocity 100, kit / General MIDI):

| element | 40 | 70 | 100 | 127 |
|---|---|---|---|---|
| kick | -19.9 / -15.9 | -7.0 / -6.2 | 0.0 / 0.0 | 2.5 / 4.1 |
| snare | -12.1 / -16.0 | -7.1 / -6.2 | 0.0 / 0.0 | 5.2 / 4.1 |
| rim shot | -6.4 / -16.0 | 0.1 / -6.2 | 0.0 / 0.0 | 2.4 / 4.1 |
| closed hat | -23.5 / -16.0 | -15.2 / -6.2 | 0.0 / 0.0 | 2.5 / 4.1 |
| open hat | -24.3 / -15.9 | -18.0 / -6.2 | 0.0 / 0.0 | 2.5 / 4.2 |
| low tom | -11.2 / -15.9 | -4.4 / -6.2 | 0.0 / 0.0 | 3.4 / 4.2 |
| high tom | -8.4 / -15.9 | -5.0 / -6.2 | 0.0 / 0.0 | 1.7 / 4.2 |
| crash | -13.4 / -15.9 | -9.0 / -6.1 | 0.0 / 0.0 | 0.0 / 4.2 |
| ride | -20.7 / -15.9 | -8.5 / -6.2 | 0.0 / 0.0 | 0.0 / 4.1 |

General MIDI follows 40 dB per decade of velocity everywhere; the kit follows 24 where the layers carry it, and the layers' own steps elsewhere. "Velocity gain applied twice" is not what happens: the snare, rim shot, side stick and toms take no gain at all (they carry their dynamics in many layers), and the layered sounds take one gain on top of their layers, but the layers are too far apart for that gain to join them.

### c. Where the "reverby" comes from

One hit at velocity 100, kit / General MIDI:

| element | peak dBFS | 0-300 ms K dB | early/late dB | to -20 dB s | to -40 dB s |
|---|---|---|---|---|---|
| kick | -21.6 / -17.9 | -34.1 / -34.0 | -3.6 / no tail | 0.28 / 0.04 | 0.81 / 0.04 |
| snare | -23.4 / -19.6 | -41.6 / -36.9 | 7.6 / 14.8 | 0.14 / 0.07 | 0.35 / 0.13 |
| rim shot | -23.2 / -19.6 | -41.4 / -36.9 | 5.7 / 14.8 | 0.17 / 0.07 | 0.53 / 0.13 |
| closed hat | -24.3 / -20.8 | -39.1 / -41.6 | 0.1 / 14.3 | 0.21 / 0.08 | 0.41 / 0.13 |
| open hat | -21.4 / -17.8 | -32.8 / -34.8 | -7.6 / 1.6 | 0.98 / 0.23 | 3.34 / 1.10 |
| low tom | -23.1 / -19.8 | -37.7 / -37.6 | -1.9 / 5.7 | 0.54 / 0.27 | 1.51 / 0.84 |
| high tom | -21.5 / -18.1 | -38.9 / -38.5 | 2.0 / 5.7 | 0.20 / 0.24 | 0.70 / 0.78 |
| crash | -23.6 / -20.1 | -33.1 / -34.9 | -14.4 / -3.3 | 1.99 / 0.74 | 4.70 / 1.68 |
| ride | -21.8 / -18.4 | -42.4 / -39.3 | -1.8 / 2.1 | 1.07 / 0.29 | 6.49 / 1.15 |

- The mid-microphone recordings carry far more late energy than General MIDI's drums: early/late is lower by 7 dB for the snare, 9 for the rim shot and open hi-hat, 14 for the closed hi-hat, 11 for the crash, 4 for the ride and 4 to 8 for the toms, and the kick rings 0.81 s to -40 dB where General MIDI's is over at 0.04 s (20 times). Others last 3 to 6 times as long to -40 dB: crash 4.7 s (1.7 s), ride 6.5 s (1.2 s), open hi-hat 3.3 s (1.1 s), snare 0.35 s (0.13 s), closed hi-hat 0.41 s (0.13 s); the toms last about as long.
- The engine adds nothing to this. Playing each recording from its start without the engine gives the same early/late and tail times as the engine renders from it (early/late, to -20 dB, to -40 dB: kick -3.6, 0.28, 0.81 both ways; snare +7.6, 0.14, 0.35; crash -14.4, 1.99, 4.70). The two small differences, closed hi-hat -1.0 against +0.1 and ride -0.7 against -1.8 early/late, are the 16 kHz low-pass below. No reverb is applied to a recorded voice. The track's sound chain is the one General MIDI goes through too; its reverb, like the master's, is off by default and would colour both engines alike.
- Overlapping tails are limited, not made, by the engine: at most 4 strokes of one sound ring on a track and the oldest is released over 0.5 s (`MAX_RINGING_STROKES`). A double kick every 83 ms against a kick that rings 0.81 s would otherwise stack about ten.
- The engine does put a one-pole low-pass at 16 kHz on every picked voice (the same for guitars): -0.3 dB at 5 kHz, -0.9 at 10 kHz, -1.7 at 16 kHz. It dulls the top of hi-hats and cymbals a little; it is not reverberant.

### d. What the pinned upstream repository carries

Pinned: `sfzinstruments/virtuosity_drums` at `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`, listed from the public repository tree at that commit; its `LICENSE` is the CC0 1.0 Universal text, which is what `assets/audio/licenses/drums.txt` copies. 5358 files.

- The library has six microphone positions for every drum and cymbal: kick microphone (`kickmic`), snare microphone (`snaremic`), overheads (`oh`), mid-distance (`mid`), room (`room`) and a vintage-sounding microphone (`lofi`). Each hit was recorded on all of them at once, so each is a full set of the same performances. Its own full-kit program turns on the kick, snare and overhead microphones and leaves mid, room and vintage off; TabPlayer uses only `mid`.
- Close microphones exist for the kick (inside the kick drum) and the snare. There is no microphone on the toms: `kickmic` and `snaremic` also have tom recordings, which are the toms heard through those two microphones, not close ones.
- Sizes of the sounds TabPlayer uses: kick 3.2 MB (kickmic, 32 files) instead of 8.3 MB (mid); snare, cross stick and rim shot 6.5 MB (snaremic, 64 files) instead of 16.5 MB (mid); toms from snaremic would be 4.2 MB instead of 11.2 MB. In all, 96 files and 9.7 MB (the toms stay mid in candidate C) against 24.8 MB for the mid files they replace. The whole of each position over every articulation is about 102 MB (kickmic), 105 MB (snaremic) and 264 MB (mid).
- The library describes itself as a contemporary jazz kit recorded on a shop's house kit "in the style of a live recording". Levels and microphones can move its balance; they cannot make it a metal kit.

## Pattern results

K level of each group played alone, over the whole clip, with the kit and with General MIDI (dB, same scale; "none" means the group is not in the pattern), at channel volume 119 (the other volumes only move the kit against General MIDI as a whole; see "Channel state"). Columns: the whole clip's K level, its peak (dBFS), the K level of each group alone, and "kick out" and "snare out": how far the first 50 ms of the kick, and of the snare backbeats, stand above everything else playing then (dB).

metal:

| sound | whole | peak | kick | snare | hats | toms | cymbals | kick out | snare out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| General MIDI | -29 | -10.9 | -30.8 | -40.2 | none | -40.7 | -35.6 | 11.8 | -3.7 |
| current | -28.5 | -12.9 | -31.2 | -44.3 | none | -40.1 | -32.8 | 5.8 | -6.6 |

groove at 95:

| sound | whole | peak | kick | snare | hats | toms | cymbals | kick out | snare out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| General MIDI | -36.6 | -15.3 | -40.6 | -43.6 | -40.6 | none | none | 13.7 | 8.4 |
| current | -41.4 | -22.7 | -43.1 | -49.3 | -49.5 | none | none | 12.9 | 7.8 |

groove at 100:

| sound | whole | peak | kick | snare | hats | toms | cymbals | kick out | snare out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| General MIDI | -35.7 | -14.4 | -39.7 | -42.7 | -39.7 | none | none | 13.7 | 8.4 |
| current | -35.2 | -18 | -39.7 | -47.3 | -37.5 | none | none | 6.9 | 2.5 |

In the metal pattern the kit's cymbals are 2.8 dB louder than General MIDI's, its snare 4.1 dB quieter, its kick level with General MIDI's but with a long tail, and the snare backbeats stand out of the rest by -6.6 dB (General MIDI -3.7) and the kick by +5.8 dB (+11.8). In the groove played at 95 the kit is 4.8 dB quieter overall (clip K level -41.4 against -36.6) with the hi-hats 8.9 dB down against General MIDI's; at 100, as in the demo, whole clips are within 0.5 dB.

### Channel state

The tests of 2026-11-06 and the demo send no channel volume. The kit's voices then play at gain 1.0 and General MIDI's synthesizer at its own default, volume 100 of 127 squared (0.62, -4.2 dB). A song sends controller 7 at the start. General MIDI applies it squared, `(volume/127)^2`; a recorded voice applies it linearly, `volume/127`. At 119 General MIDI is 3.0 dB louder than in the demo's state and the kit 0.6 dB quieter, so every kit sound sits 3.6 dB lower against General MIDI than it was levelled: 2.3 dB at 103, 4.2 dB at 127 (the two curves cross at 79). This moves the whole kit against the guitars; it does not change the balance inside the kit. Whole-clip K level of the metal pattern, kit minus General MIDI, by controller 7: none +4.2, 103 +1.7, 119 +0.5, 127 0.0 dB.

### The demo's own balance

In the demo's state (groove at velocity 100, no channel volume) the kit's whole clip is 4.1 dB louder than General MIDI's (-34.6 against -38.7 dB K), which hides that the balance inside it already differed: each group alone against the whole clip, kick -4.5 (General MIDI -4.0), snare -12.1 (-7.0), hi-hats -2.3 (-4.0). The kit's hi-hats lead its snare by 9.8 dB where General MIDI's lead by 3.0, and the snare's first 50 ms stand 2.5 dB over the rest where General MIDI's stand 8.4. So the demo was hi-hat-forward and snare-light by about 7 dB and was still approved by ear; what that approval covered is not recorded.

## Root cause

The kit's levels were set from single hits, by peak, at velocity 100, in the state the tests start in (no channel volume sent), which a song's does not match, and nothing checked them across velocity. In a song three things disagree with that setting:

1. Velocity. A note at Guitar Pro's default dynamic (95) is at the top of the kit's third velocity layer; the demo's 100 is above a layer edge where the closed hi-hat jumps 11.6 dB and the open hi-hat 14.4. At 95 the hi-hats are 9 to 12 dB under General MIDI, the snare and rim shot 6 to 7 dB, the kick 3 dB, and the crash is 2.6 dB over: against General MIDI the cymbals sit 8 to 15 dB above the hi-hats and snare. That is the measurable form of "only cymbals, everything else quietly".
2. Peak is not loudness. At the levelling point (velocity 100; the demo's state, which is the table above plus 3.6 dB) the snare's K level is 1.1 dB under General MIDI's, the crash's 5.4 dB over and the closed hi-hat's 6.1 over: sounds of the same peak, the cymbal 6.5 dB louder than the snare against General MIDI. The demo's own balance (above) shows it.
3. The channel state, which lowers the whole kit by 3.6 dB at the Guitar Pro default.

The "very reverby" is the mid-distance microphone itself: early/late energy 4 to 14 dB lower than General MIDI's and tails to -40 dB 3 to 6 times as long (20 times for the kick), the same in the recording and in what the engine renders. Neither is a bug in the code or the data; both come from how the kit was levelled and which microphone it uses.

What this does not prove: that these numbers are the whole of the owner's impression. They come from synthetic patterns and from alphaTab's default velocities, not from the owner's song.

## Ruled out

- A regression since the kit commit: none (section a).
- Wrong or missing recordings: every one of the 43 kit sounds has a recording at every velocity (the existing test checks it), and in the sweep every kit sound at every velocity played its recording and not General MIDI (the levels differ from General MIDI's at every point).
- Doubled velocity gain: only the layered sounds take a gain, and once.
- Engine reverb or doubled tails: none (section c); the stroke cap only shortens.
- Voice stealing or hi-hat groups cutting other drums: a closed hat cuts only the open and half-open hat on the same track; every other drum is in no group.

## Candidates

Each candidate is a branch with one commit changing only `assets/audio/drums/Programs/tabplayer-kit.sfz` and the pin of that file in `assets/audio/drums-inventory.json` (C adds the close-microphone pins). They stack: B contains A and C contains B. Levels are set by the rule in each file's header, computed from `recorded_kit_levels` by a one-off script, then checked by measuring again; the script is not kept in the repository. The prepare script and all product code are unchanged.

- A, `agy/drum-kit-balance-a`: every drum sound's `volume` set so its K level at velocity 95 and channel volume 119 equals General MIDI's, then the owner's direction: kick +2 dB, snare, rim shot and side stick +3 dB, hi-hats -2 dB, other cymbals -3 dB, toms 0. The 22 percussion sounds (keys 54 and up other than the cymbals 55, 57 and 59) keep their levels. This is the simplest change: 21 numbers. It fixes the default-dynamic balance but not the layer edges: the hi-hats are 9 and 12 dB over General MIDI at 100 and above.
- B, `agy/drum-kit-balance-b`: A, and the kick (35, 36), closed and open hi-hat, crash and ride list their regions in the map with a `volume` for each recorded layer and `amp_velcurve_N` equal to the layer's top velocity, so the top layer of the hi-hats is trimmed 11 to 13 dB and each sound follows one curve, 24 dB per decade of velocity, with no jump. 84 region lines generated from the manifest and the sweep's layer levels (one line each), replacing 6 `#include`s. It also makes every round robin of a cymbal layer agree.
- C, `agy/drum-kit-balance-c`: B, with the kick from `kickmic` and the snare, rim shot and side stick from `snaremic` (5 includes changed, 96 samples of 9.7 MB replace 96 of 24.8 MB; the kit goes from 227.3 MB to 212.2 MB), levels set again by the same rule. The toms and cymbals stay mid-distance. A true blend of close and mid microphones needs the renderer to play two recordings per note, which it does not; that would be a product change and is not made.

Kit minus General MIDI at the default dynamic and around it:

Velocity 79:

| element | current | A-levels | B-layers | C-close-mics |
|---|---:|---:|---:|---:|
| kick | -1.7 | 3.3 | 3.3 | 3.3 |
| snare | -4.8 | 3.7 | 3.7 | 3.8 |
| rim shot | -4.3 | 5.2 | 5.2 | 5.3 |
| closed hat | -7.3 | -0.8 | -0.7 | -0.7 |
| open hat | -10.6 | -0.6 | -0.6 | -0.6 |
| low tom | 0.7 | 1.2 | 1.2 | 1.2 |
| high tom | -0.7 | 1.8 | 1.8 | 1.8 |
| crash | -1.9 | -7.4 | -2.6 | -2.6 |
| ride | -6.2 | -7.2 | -2.5 | -2.5 |

Velocity 95:

| element | current | A-levels | B-layers | C-close-mics |
|---|---:|---:|---:|---:|
| kick | -3.0 | 2.0 | 2.0 | 2.0 |
| snare | -5.6 | 2.9 | 2.9 | 3.1 |
| rim shot | -6.8 | 2.7 | 2.7 | 2.9 |
| closed hat | -8.6 | -2.1 | -2.0 | -2.0 |
| open hat | -11.9 | -1.9 | -1.9 | -1.9 |
| low tom | -0.3 | 0.2 | 0.2 | 0.2 |
| high tom | -2.4 | 0.1 | 0.1 | 0.1 |
| crash | 2.6 | -2.9 | -3.0 | -3.0 |
| ride | -2.2 | -3.2 | -3.0 | -3.0 |

Velocity 100:

| element | current | A-levels | B-layers | C-close-mics |
|---|---:|---:|---:|---:|
| kick | -0.1 | 4.9 | 2.0 | 2.0 |
| snare | -4.7 | 3.8 | 3.8 | 4.0 |
| rim shot | -4.5 | 5.0 | 5.0 | 4.5 |
| closed hat | 2.5 | 9.0 | -2.0 | -2.0 |
| open hat | 2.0 | 12.0 | -1.3 | -1.3 |
| low tom | -0.1 | 0.4 | 0.4 | 0.4 |
| high tom | -0.4 | 2.1 | 2.1 | 2.1 |
| crash | 1.8 | -3.7 | -3.3 | -3.3 |
| ride | -3.1 | -4.1 | -3.4 | -3.4 |

Velocity 127:

| element | current | A-levels | B-layers | C-close-mics |
|---|---:|---:|---:|---:|
| kick | -1.7 | 3.3 | 0.4 | 0.4 |
| snare | -3.6 | 4.9 | 4.9 | 4.7 |
| rim shot | -6.2 | 3.3 | 3.3 | 3.2 |
| closed hat | 0.9 | 7.4 | -3.6 | -3.6 |
| open hat | 0.3 | 10.3 | -3.0 | -3.0 |
| low tom | -0.9 | -0.4 | -0.4 | -0.4 |
| high tom | -2.9 | -0.4 | -0.4 | -0.4 |
| crash | -2.4 | -7.9 | -5.0 | -5.0 |
| ride | -7.2 | -8.2 | -5.0 | -5.0 |

Largest step between neighbouring velocities (from velocity 10 up, to leave out the softest notes):

| element | current | A-levels | B-layers | C-close-mics |
|---|---|---|---|---|
| kick | +7.3 at 63 to 64 | +7.3 at 63 to 64 | +1.1 at 9 to 10 | +1.1 at 9 to 10 |
| snare | +3.9 at 17 to 18 | +3.9 at 17 to 18 | +3.9 at 17 to 18 | +3.8 at 17 to 18 |
| rim shot | +5.8 at 32 to 33 | +5.8 at 32 to 33 | +5.8 at 32 to 33 | +5.3 at 32 to 33 |
| closed hat | +11.6 at 95 to 96 | +11.6 at 95 to 96 | +1.1 at 9 to 10 | +1.1 at 9 to 10 |
| open hat | +14.4 at 95 to 96 | +14.4 at 95 to 96 | +1.1 at 9 to 10 | +1.1 at 9 to 10 |
| low tom | +3.9 at 47 to 48 | +3.9 at 47 to 48 | +3.9 at 47 to 48 | +3.9 at 47 to 48 |
| high tom | +4.2 at 23 to 24 | +4.2 at 23 to 24 | +4.2 at 23 to 24 | +4.2 at 23 to 24 |
| crash | +6.0 at 85 to 86 | +6.0 at 85 to 86 | +1.1 at 9 to 10 | +1.1 at 9 to 10 |
| ride | +6.6 at 42 to 43 | +6.6 at 42 to 43 | +1.2 at 42 to 43 | +1.2 at 42 to 43 |

Patterns at channel volume 119:

metal:

| sound | whole | peak | kick | snare | hats | toms | cymbals | kick out | snare out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| General MIDI | -29 | -10.9 | -30.8 | -40.2 | none | -40.7 | -35.6 | 11.8 | -3.7 |
| current | -28.5 | -12.9 | -31.2 | -44.3 | none | -40.1 | -32.8 | 5.8 | -6.6 |
| A-levels | -25.5 | -6.5 | -26.2 | -35.9 | none | -40.4 | -38.3 | 13.4 | -2.5 |
| B-layers | -26.1 | -7 | -27.1 | -35.8 | none | -40.3 | -37.2 | 12 | -1.1 |
| C-close-mics | -25.9 | -6.1 | -26.9 | -35.9 | none | -40.4 | -37.2 | 13.8 | -1.3 |

groove at 95:

| sound | whole | peak | kick | snare | hats | toms | cymbals | kick out | snare out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| General MIDI | -36.6 | -15.3 | -40.6 | -43.6 | -40.6 | none | none | 13.7 | 8.4 |
| current | -41.4 | -22.7 | -43.1 | -49.3 | -49.5 | none | none | 12.9 | 7.8 |
| A-levels | -35.0 | -15.9 | -38.1 | -40.6 | -41.5 | none | none | 11.2 | 10.6 |
| B-layers | -35.0 | -15.9 | -38.1 | -40.6 | -41.5 | none | none | 11.1 | 10.5 |
| C-close-mics | -35.0 | -13.6 | -38.0 | -40.5 | -41.5 | none | none | 14.1 | 10.8 |

groove at 100:

| sound | whole | peak | kick | snare | hats | toms | cymbals | kick out | snare out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| General MIDI | -35.7 | -14.4 | -39.7 | -42.7 | -39.7 | none | none | 13.7 | 8.4 |
| current | -35.2 | -18 | -39.7 | -47.3 | -37.5 | none | none | 6.9 | 2.5 |
| A-levels | -27.8 | -11.2 | -34.7 | -38.5 | -29.3 | none | none | 5.1 | 4.8 |
| B-layers | -34.2 | -13.4 | -37.6 | -38.5 | -41.5 | none | none | 13.3 | 14.7 |
| C-close-mics | -34.1 | -12.4 | -37.6 | -38.5 | -41.5 | none | none | 17 | 15.3 |

Clip levels (K-weighted dB / peak dBFS):

| clip | groove | groove95 | metal |
|---|---|---|---|
| gm | -35.7 / -14.4 | -36.6 / -15.3 | -29.0 / -10.9 |
| current | -35.2 / -18.0 | -41.4 / -22.7 | -28.5 / -12.9 |
| A-levels | -27.8 / -11.2 | -35.0 / -15.9 | -25.5 / -6.5 |
| B-layers | -34.2 / -13.4 | -35.0 / -15.9 | -26.1 / -7.0 |
| C-close-mics | -34.1 / -12.4 | -35.0 / -13.6 | -25.9 / -6.1 |

Reading of the numbers, not of the sound: A puts the snare and kick forward and the cymbals back at 95 but leaves the hi-hat jump (so the demo at velocity 100 is 8 dB louder than General MIDI and hat-heavy); B removes the jump and keeps the same levels at 95; C keeps B's levels and makes the snare drier (early/late +15.3 against +7.6, tail to -40 dB 0.23 s against 0.35 s; General MIDI +14.8 and 0.13 s) and the kick's early/late +2.5 against -3.6, though its tail to -40 dB is still 0.89 s.

Known weaknesses of the candidates:

- The rim shot's recordings do not get steadily louder with velocity, so any one level is wrong somewhere: levelled at 95, A to C put it 12 dB over General MIDI around velocity 63 and 5 dB over at 100.
- B and C trade General MIDI's wide dynamics for the layers' 24 dB per decade: soft kicks and hi-hats (velocity 31 to 47) come out 3 to 10 dB louder than General MIDI's, accented crashes 3 to 5 dB quieter.
- The levels are set by a 300 ms K level at one velocity; long cymbal tails and kick tails are not in it, which is why the cymbals are put 3 dB back by hand.
- In the metal pattern the candidates are 2.9 to 3.5 dB louder than General MIDI as a whole clip (the clip levels are in the clips' README): the kick and snare are forward by design and the double kick's tails add. Compare by ear with that in mind.

What changes if one is adopted: the pins in `drums-inventory.json` (already in each candidate), the levelling paragraph and the mid-microphone description of `2026-11-06-gp8-recorded-drums.md` and `assets/audio/README.md` (C: 212.2 MB, close microphones), and nothing in the tests: no existing test asserts a level of the bundled kit (`bundled_kit_plays_every_sound` asserts coverage and a peak above -60 dB), `src/audio/kit-sound.test.ts` still finds every `<group> key=` of the map, and `scripts/prepare-audio.test.mjs` does not read the map. Not yet updated, as asked.

## Checks run

- `cargo test --release --locked --test audio_recorded_kit`: 7 passed, 5 ignored (the four measurement tests and the old `bundled_kit_plays_every_sound`, which was not run).
- `cargo test --release --lib legacy_equivalence`: 2 passed.
- `cargo fmt --all -- --check`: clean. `node --test scripts/prepare-audio.test.mjs`: 9 passed (on candidate C's branch; it does not read the map). `npx vitest run src/audio/kit-sound.test.ts`: 3 passed (it reads the map's `<group> key=` lines, 43 on every branch).
- Coverage: with the current, B and C prepared audio, every one of the 43 kit sounds has an attack recording at every velocity from 1 to 127 (a script over `manifest.json`, the same rule as the ignored test; A has the same regions as the current kit).
- `node scripts/prepare-audio.mjs --offline` verified every state's audio against the pins (C after its inventory was recorded once with `--record-inventory`, which also fetched the close-microphone recordings from the pinned revision and left the other sources' inventories unchanged apart from line endings).
- Not run: `npm test` as a whole, the desktop drivers (another session holds the app's port) and the renderer in the app.

## Limits

- Nothing here was listened to. The numbers say where the kit sits against General MIDI by one loudness measure; they do not say what sounds right.
- Synthetic patterns at alphaTab's default velocities, a channel volume of 119, one stereo output, no guitars, no master compressor, equaliser, reverb or limiter: not the owner's song, its velocities, its track volume or its mix.
- The kit is compared with General MIDI, which the owner finds normal; that is a reference, not a target level.
- K level over 300 ms ignores everything after: ring, wash and masking are shown only by the tail and "stands out" figures.
- Single hits use round robin 1; round robins differ by about a decibel in the raw layers.
- The 2026-11-06 demo's "each sound on its own" part and the crash choke were not re-rendered; only its groove was.
- Candidate C's close microphones change the character (drier snare and kick); whether that suits the kit's jazz-kit toms and cymbals was not judged.
- The upstream library is a jazz kit; none of the candidates changes that.

## Reproduce

From a checkout with the prepared audio (`npm run prepare:audio`):

```
cargo test --release --locked --manifest-path src-tauri/Cargo.toml --test audio_recorded_kit -- --ignored --nocapture recorded_kit_balance
```

and `recorded_kit_velocity_sweep` (CSV of every velocity and every recorded layer), `recorded_kit_levels` (every kit sound at velocities 79, 95, 100 and 111), `recorded_kit_clips` (writes the clips; `TABPLAYER_DRUM_CLIPS=<folder>`, `TABPLAYER_DRUM_LABEL=<name>`, `TABPLAYER_DRUM_GM=1` for General MIDI). To hear a candidate, check its branch out, run `node scripts/prepare-audio.mjs` (C downloads 96 close-microphone recordings from the pinned public repository) and render the clips. The clips of this note, with a README, are in `.analysis/drum-kit-clips/` (not tracked).

## Addendum: "all the drums lack kick", "unprocessed, in another room" (2026-11-16, later)

Owner, by ear, after hearing the clips of A, B and C: "All of the drums lack kick." Then, on PC speakers: "it sounds like the drums are completely unprocessed and in another room or something. Maybe the samples are wrong?" It is not known whether General MIDI is included in "all". Candidates D to H and their clips are new; nobody has listened to them.

Measured by the tests added in this commit (`recorded_kit_bands`, `recorded_kit_kick_masking`, `recorded_kit_raw_recordings`, `recorded_kit_distance`, `recorded_kit_fidelity`; commands as under "Reproduce", the raw and distance tests read folders of recordings named by `TABPLAYER_DRUM_RAW` and `TABPLAYER_DRUM_DIST`). Levels below are unweighted mean-square power in dB re full scale, at channel volume 119, both channels averaged. Bands: below 60 Hz, 60 to 120, 120 to 300, 300 to 2 000, 2 000 to 6 000 ("click"), above 6 000, and "above 100 Hz", which is what a small speaker still plays. "Onset" windows are the first 50 ms of each of the metal pattern's kicks, power-averaged over the pattern's 113 kicks; "the rest" is the whole mix minus the kick group (the renderer adds voices linearly, so this is exact). Everything here comes from the engine's render of the bundled audio, apart from the raw-recording tables, which are the recordings played without the engine.

### Are the samples wrong? No

- Map to recording: from the prepared manifest of the last candidate, every key points at the recording it names: 35 and 36 kick (snares off and on), 37, 38 and 1 snare cross stick, centre and rim shot, 41 to 45 the low tom and 47, 48, 50 the high tom, 42, 44, 46 and 2 closed, pedal, open and half-open hi-hat, 49 and 57 crash and sizzle crash, 51 and 53 ride and bell, 55 and 59 the flat ride, 54 and 56 to 84 percussion. No key plays another drum.
- Fetch and pins: `node scripts/prepare-audio.mjs --offline` verified the audio of every state I prepared (current, A to H) against its pins. A mid-microphone and a kick-microphone kick recording from the cache have the same SHA-256 as the same files fetched again from the pinned revision.
- Engine against recording: a single hit at velocity 127 rendered by the engine, fitted by one gain to the recording its region names, leaves a residual 38 to 48 dB under the render for the kick, snare and both toms and 19 to 23 dB under for the closed hi-hat, crash and ride (the 16 kHz low-pass, which removes a little of their top). No shift against the file, no resampling (every recording is 48 kHz and so is the render). The fitted gain is the region's `volume`, the channel volume (-0.6 dB) and a constant -3.0 to -3.8 dB for every element: not a property of any sample (probably the track's pan law; not traced). So the engine plays the recordings it is told to, as they are.
- What is "wrong" is what they are: a library of single-microphone recordings with no processing, from a "contemporary jazz kit" (above), played from a mid-distance microphone that hears each drum 3 to 5 ms later than the close microphones (1 to 1.7 m farther) and carries the room.

### How far each microphone position is (raw recordings, no engine)

One loud hit of each element on each of the library's six positions. "Arrives" is the time the sound reaches 30 dB under its own peak (1 ms is 34 cm of path); "direct/late" the energy of the first 50 ms against the next 1.45 s counted from there (high is dry, low is room); "to -40 dB" the time its 10 ms power takes to fall 40 dB (1.50 means it had not by the end of the 1.5 s read).

Arrives, ms:

| element | kick mic | snare mic | overheads | mid | room | vintage |
|---|---:|---:|---:|---:|---:|---:|
| kick | 4.0 | 3.8 | 5.5 | 7.9 | 10.5 | 6.9 |
| snare | 7.9 | 5.1 | 6.8 | 9.8 | 12.8 | 9.6 |
| low tom | 8.2 | 5.8 | 6.7 | 9.7 | 12.6 | 9.5 |
| high tom | 6.5 | 4.4 | 5.9 | 8.2 | 11.1 | 7.9 |
| closed hi-hat | 5.9 | 3.3 | 4.5 | 7.8 | 10.6 | 7.6 |
| crash | 6.6 | 4.6 | 4.4 | 7.5 | 10.5 | 8.0 |

Direct/late, dB:

| element | kick mic | snare mic | overheads | mid | room | vintage |
|---|---:|---:|---:|---:|---:|---:|
| kick | +3.1 | +3.7 | +3.8 | -2.5 | +1.2 | +3.7 |
| snare | +8.8 | +17.2 | +13.4 | +8.5 | +4.3 | +4.3 |
| low tom | -2.7 | +5.7 | -1.4 | -1.1 | +4.1 | +1.6 |
| high tom | -0.1 | +3.3 | +2.5 | +3.1 | +4.0 | +3.6 |
| closed hi-hat | -1.4 | +3.1 | +3.2 | +0.4 | -0.3 | +1.6 |
| open hi-hat | -9.2 | -9.0 | -5.9 | -6.7 | -6.5 | -7.3 |
| crash | -12.0 | -15.2 | -12.4 | -13.6 | -14.9 | -16.7 |
| ride | -7.8 | +1.1 | 0.0 | -0.4 | -1.9 | -6.5 |

To -40 dB, s:

| element | kick mic | snare mic | overheads | mid | room | vintage |
|---|---:|---:|---:|---:|---:|---:|
| kick | 0.86 | 0.88 | 0.99 | 0.80 | 0.73 | 0.84 |
| snare | 0.87 | 0.21 | 0.27 | 0.35 | 0.43 | 0.44 |
| low tom | 1.50 | 1.32 | 1.50 | 1.50 | 0.89 | 1.28 |
| high tom | 1.19 | 0.84 | 0.52 | 0.70 | 0.85 | 0.65 |
| closed hi-hat | 0.64 | 0.30 | 0.32 | 0.40 | 0.39 | 0.37 |

What this says. The shipped kit takes everything from the mid position, the second farthest from the drums: its snare is 8.7 dB less direct than the snare microphone's, 4.9 dB less than the overheads', and rings to -40 dB 1.7 times as long as the snare microphone's (0.35 s against 0.21); its low tom is 6.8 dB less direct than the snare microphone's and its closed hi-hat 2.8 dB less than the overheads'. That is the measurable form of "in another room". The kick is the exception: its direct/late is -2.5 dB on the mid microphone against +3.1 to +3.8 on the three close ones, but even the kick microphone's kick rings to -40 dB in 0.86 s, and no position makes a kick shorter than 0.73 s (the room is shortest, 0.73 s): that tail is the drum's own, and the recording has no gate. Cymbals and the open hi-hat ring beyond 1.5 s on every position; the overheads are 0.4 to 2.8 dB more direct than mid for the hi-hats, crash and ride and arrive 2 to 3 ms sooner, nothing more.

### The kick, by band, and what K-weighting hid

Kick, velocity 95 (the Guitar Pro default), first 50 ms, unweighted dB (the engine's render of each state; candidate F and H share the vintage-microphone kick, D, G and E the kick microphone's):

| kick | below 60 | 60-120 | 120-300 | 300-2k | 2k-6k | above 6k | above 100 Hz | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| General MIDI | -28.7 | -27.1 | -33.5 | -50.3 | -48.2 | -62.4 | -30.1 | -24.2 |
| current (mid) | -48.2 | -36.1 | -39.4 | -46.2 | -66.0 | -81.0 | -38.3 | -34.0 |
| A, B (mid, louder) | -43.2 | -31.1 | -34.4 | -41.2 | -61.0 | -76.0 | -33.3 | -29.0 |
| C (kick mic) | -44.4 | -26.0 | -36.9 | -54.7 | -77.7 | -96.7 | -35.5 | -25.6 |
| D (C, +6 dB) | -38.4 | -20.0 | -30.9 | -48.7 | -71.7 | -90.7 | -29.5 | -19.6 |
| E (D, 4 semitones down) | -25.4 | -21.1 | -32.1 | -48.9 | -75.2 | -94.6 | -31.1 | -19.5 |
| F (vintage mic) | -59.2 | -36.0 | -33.3 | -32.9 | -41.4 | -56.4 | -29.5 | -28.8 |

Peak and first 10 ms, same hit: General MIDI peak -18.8 dBFS, strongest tone 59 Hz; current -24.7 (strongest 84 Hz); C -19.8 (83 Hz); D -13.8; E -13.8 (66 Hz); F -19.4 (83 Hz). Every recording starts 3 to 13 ms into its file, by position (the table above), General MIDI 1 ms.

- Where the recorded kick's energy is: 60 to 120 Hz, with its strongest tone at 83 to 86 Hz. On the kick microphone, 90% of it is there; below 60 Hz it has next to nothing (16 dB under General MIDI's kick, whose strongest tone is 59 Hz), and its 2 to 6 kHz is 47 dB under its own total in the raw recording (General MIDI's 24 dB; the mid microphone's 28; only the vintage-sounding microphone has a click, 11 dB). A beater click is not in the kick or mid recordings at all.
- What a small speaker keeps: at 95, the share of the kick's energy above 100 Hz is 26% for General MIDI, 37% for the mid-microphone kick (current, A, B), 10% for the kick microphone's (C, D), 7% for E and 85% for F. So C took a kick whose energy sits where small speakers do not play and levelled it to General MIDI's total.
- Against the rest of the metal pattern (the 113 kicks' first 50 ms, above 100 Hz): General MIDI's kick stands 3.5 dB over the rest of the mix and 5.8 dB over the snare; current -0.2 and +8.0; A +2.4 and +4.5; B +0.8 and +3.1; C -2.7 and -2.1; D +3.3 and +3.9; E +3.3 and +4.3; F +3.4 and +5.8; G +3.5 and +3.9; H +3.6 and +5.8. In 2 to 6 kHz, where the crashes sit, the kick is 5.9 dB under the rest in General MIDI, 23.2 under in the current kit, 21.0 under in C, 15.0 under in D, and level with it (+1.1) in F and H.
- What K-weighting hid. K-weighting is a high-pass at about 38 Hz and a shelf above 1.5 kHz, so it counted the kick's 60 to 120 Hz in full; it did not hide that. What it could not show is where the level was: the kit's kick was levelled by one number (the 300 ms K level at velocity 95) to match General MIDI's, whose energy is below 60 Hz, while the recording's is at 60 to 120 and a small speaker plays almost none of either. Levelled equal by K, the recorded kick has 5.4 dB less energy above 100 Hz than General MIDI's in C (-35.5 against -30.1 at velocity 95; the current kit's is 8.2 dB under) and 16 dB less below 60 Hz; and in A to C the snare was set about 3 dB over General MIDI's, so against the snare the kick lost 10 dB above 100 Hz from the current kit to C (+8.0 to -2.1). The method judged "kick out" with the full-range 50 ms level (12 to 14 dB), which a 60 to 120 Hz thump passes.
- For a laptop or PC speaker (little under 100 to 150 Hz), the single hit at 95 keeps, above 100 Hz: General MIDI -30.1 dB, current -38.3 (8.2 under), A and B -33.3 (3.2 under), C -35.5 (5.4 under), D -29.5, E -31.1 and F -29.5 (within 1 dB of General MIDI). So on such a speaker the current kit's kick is 8 dB quieter than General MIDI's and C's 5 dB, though their whole-spectrum levels are within 2 dB or louder. D and E reach General MIDI's level above 100 Hz by putting 90% of their energy where a small speaker adds nothing, which is why they are 6 to 8 dB louder than General MIDI in total (the metal clip's K level -20.7 and -23.2 against -29.0); F and H reach it with 85% of their energy above 100 Hz and are level with General MIDI in total.
- Own-group cut of the kick (`group` and `off_by` on keys 35 and 36 with a 50 ms release, so each kick fades the one before; measured on D's levels, not kept): the kick group's level over the metal pattern fell 2.5 dB and the onsets' level above 100 Hz 0.9 dB; the kick onset against the ring before it moved from +3.6 to +3.9 dB. A cut only removes the overlap; it makes no kick louder or clearer in that measure. Not a candidate.
- Pitch (`pitch_keycenter` 4 above the key with `pitch_keytrack=100`, which the kit map already uses for the toms): the kick plays 4 semitones low, 83 Hz becomes 66 Hz, its energy below 60 Hz at the metal onsets rises 8 dB (to General MIDI's), its level above 100 Hz is unchanged, its peak comes 6 ms later (27 ms against 21) and it lasts 26% longer. That is E.

### Candidates D to H

Each is a branch with one commit changing only `assets/audio/drums/Programs/tabplayer-kit.sfz` and its pin in `assets/audio/drums-inventory.json` (F and H also pin 32 vintage-microphone kick recordings, 4 MB, from the same pinned revision; G pins the overhead and snare-microphone recordings it uses). D is built on C, E, F and G on D, H on G. Opcodes used are those `scripts/prepare-audio.mjs` and the renderer honour (`sample lokey hikey key pitch_keycenter lovel hivel seq_length seq_position volume ampeg_attack ampeg_release loop_* trigger pitch_keytrack rt_decay transpose bend_* group off_by amp_velcurve_N`; `transpose` is refused by the prepare script, there is no equaliser, filter or layering opcode, and one note plays one recording). Nothing but the map and the pins changed.

- D, `agy/drum-kit-balance-d` (0a1e8f9): C with every kick region 6 dB louder. Why 6: it is what puts the kick's level above 100 Hz at the onsets back to General MIDI's presence (+3.3 over the rest, General MIDI +3.5); more would add level where a small speaker cannot play it and use the headroom (the metal clip's peak is already -3.8 dBFS and its K level 8.3 dB over General MIDI's).
- E, `agy/drum-kit-balance-e` (63a32ca): D with the kick 4 semitones lower, for the weight below 60 Hz that General MIDI has and no recording does.
- F, `agy/drum-kit-balance-f` (bc105c4): D with the kick from the vintage-sounding microphone, levelled so each layer's first 50 ms above 100 Hz match D's (13 to 16 dB more gain). The only kick with a click (level with the rest of the mix in 2 to 6 kHz at the onsets); very little below 120 Hz.
- G, `agy/drum-kit-balance-g` (57a3401): D with the toms from the snare microphone and the hi-hats and cymbals (crash, sizzle crash, ride, bell, flat ride, pedal and half-open hi-hat included) from the overhead microphones, each key levelled again to D's K level at velocity 95 (the toms through the snare microphone needed 9.8 to 14 dB more). The percussion stays on the mid microphone. The largest step between neighbouring velocities is D's for every element but the low tom (4.7 dB against 3.9) and the crash (2.4 against 1.1).
- H, `agy/drum-kit-balance-h` (aac383a): G with F's kick: close and dry everywhere, with a click.

Clip levels (K-weighted dB / peak dBFS; no clip reaches -3 dBFS):

| clip | groove | groove95 | metal |
|---|---|---|---|
| D-kick-louder | -30.4 / -10.7 | -31.0 / -11.8 | -20.7 / -3.8 |
| E-kick-deeper | -30.2 / -10.9 | -30.7 / -11.7 | -23.2 / -6.3 |
| F-kick-click | -34.2 / -12.1 | -35.5 / -14.0 | -27.5 / -8.7 |
| G-close-dry | -30.4 / -10.7 | -31.0 / -11.8 | -20.7 / -3.6 |
| H-close-dry-click | -34.3 / -12.2 | -35.4 / -12.1 | -27.6 / -8.9 |

D and G are 8.3 dB over General MIDI and 5.2 over C in the metal clip, E 5.8 and 2.7, which a listener may take for "better"; F and H are level with General MIDI (-29.0). The track volume lowers any of them.

### How far this library goes toward a processed metal kit with microphone and level alone

Not all the way, and the reason is in the data, not the map. By microphone choice and level the kit can be made close (G, H: sounds arriving 3 to 5 ms sooner, a snare 8.7 dB more direct, cymbals and toms drier by 1 to 7 dB), the kick forward (D to H), and the snare and the kick as loud as the owner's direction asks (A to C). It cannot be made:

- gated or tight: every drum rings as recorded (kick 0.7 to 1.0 s to -40 dB on any microphone, snare 0.21 s at best, toms 0.5 to 1.5 s, cymbals and open hi-hat more than 1.5 s); a cut by `group` shortens it only when another note of the group is played, which does not remove the tail of the last hit;
- sub-heavy or clicky together: no kick recording has both (kick microphone: thump, no click; vintage: click, no thump); one note plays one recording, so the two cannot be mixed in the map;
- EQ'd, scooped, compressed or saturated: no opcode for it is read.

What the map can still offer, if the listening shows it is wanted, is the choice D/E (thump) against F/H (click).

### Smallest product changes (estimates, not made)

- Per-sound EQ and a gate or expander per kit element. The renderer already sums recorded drum voices per element before the element mix (`kit_scratch`, one bus per kit element), which is where a filter chain belongs. A small biquad chain per element (high-pass, two peaking bands, a shelf) with a fixed "modern" voicing, plus a threshold-and-release expander on the snare, kick and toms, applied before the element gain: about 250 to 400 lines of renderer code, an optional settings field (old projects and edit logs unchanged: absent means off), tests for the filters and the no-allocation callback, 2 to 3 days; a UI selector (off or a voicing) with `en`, `et` and `de` text another day. EQ alone does not give the recorded kick a click (its 2 to 6 kHz is 47 dB under its total: boosting that much boosts the noise floor); it would tighten the snare (cut 300 to 500 Hz, add 4 to 6 kHz), remove the boxiness of the mid-microphone sounds and add the sub of a pitched or filtered thump.
- Two recordings per note (kick microphone plus vintage, or close plus overheads at a set ratio). `select_drum` returns one selected note; it would return two with a level each, the resource request (`resource_requests`) asks for both, one more voice per stroke counts against the polyphony and the ringing cap, and the kit map needs a way to name the second recording (a new group opcode handled by `prepare-audio.mjs` and a manifest field, so a new schema version and the old projects' audio unchanged). About 2 to 3 days with tests; it is the change that gives a kick both the thump and the click and a snare its top-and-bottom blend.
- Both together are a week; neither is needed to compare D to H.

### Other libraries, as research only

Nothing was downloaded into the repository or changed. Licences were read in each repository's own `LICENSE` file through the public listing; none of the libraries below is marketed as a metal kit, so "suited to metal" means close-miked parts, an unprocessed but dry signal and a big kick.

- Big Rusty Drums: https://github.com/sfzinstruments/karoryfer.big-rusty-drums. `LICENSE` is "Creative Commons Legal Code, CC0 1.0 Universal" (https://creativecommons.org/publicdomain/zero/1.0/legalcode). 4 466 FLAC files, about 706 MB; a 24-inch kick with kick, overhead and snare microphones (damped and undamped), a 14-inch snare with top, bottom and overhead microphones, crashes and chinas with close and overhead microphones. An oversized kit, close-miked, unprocessed.
- Frankensnare: https://github.com/sfzinstruments/karoryfer.frankensnare. `license` file is the same CC0 1.0 Universal text. 3 580 FLAC files, about 358 MB; snare drums only, small to huge, bottom, top and overhead microphones. Suits the snare.
- SM Drums: https://github.com/sfzinstruments/SMDrums. The instrument catalogue (https://sfzinstruments.github.io/drums/sm_drums) lists the licence as "Public Domain"; the repository has no licence file and the authors' own statement was not found, so this is unconfirmed. About 2.3 GB of WAV (the largest).
- Gogodze Phu Vol II: https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii. `LICENSE` present, listed CC0-1.0. 133 MB; kick, snare, three toms and a hi-hat in the manner of a 1973 recording. Not a metal sound; included for its size.
- The Metal Kick Drum free samples: https://github.com/endolith/TMKD-SFZ. The SFZ files are "free to use for whatever purpose" (Unlicense); the licence of the audio itself is not stated in the repository, so it is not on the CC0 list. Seven kicks, three snares and toms, the only metal-specific material found. Would need its licence confirmed with its maker before use.

Adopting one means: a new `sources.json` entry (repository, pinned revision, licence, inventory path, local root, kit map); a new kit map written for it, because the upstream maps of the libraries above use opcodes this prepare script refuses (the existing kit's map lists regions or includes the upstream map files only where they are plain); `--record-inventory` to pin every file (hundreds of MB for the first two: the current kit is 212 MB); the licence text copied to `assets/audio/licenses/`; and the kit's constant id (`virtuosity-kit`) and key list (1 and 2 for the rim shot and half-open hi-hat) either kept, replacing the library in place, or generalised. About 2 days to replace in place for Big Rusty's kick and Frankensnare's snare with the rest left on the current library, more to replace the whole kit and the size budget.

### Limits of this addendum

- Nothing was listened to. Every figure is a measurement of the render or of the recordings; "close", "dry", "click" and "weight" are the names of those numbers, not of a sound. Pitch down, the vintage kick and the overhead cymbals are hypotheses for the ear.
- The kick tables are one hit at velocity 95 and one pattern (113 kicks) rendered at one channel volume with one stereo output; the loud layers differ (the layer tables above show 6 to 12 dB between layers).
- G and H raise the toms by 10 to 14 dB from a recording made through the snare microphone; whether that brings noise or bleed was not examined. The vintage microphone's kick is levelled to 13 to 16 dB more gain for the same reason.
- The recorded `direct/late` for cymbals is a 1.5 s read, so the "-40 dB" times of cymbals and the open hi-hat are lower bounds.
- Small-speaker figures are the energy above 100 Hz, not a speaker's real response; a laptop keeps less (it adds little under 150 Hz).
- The library's licence statement for SM Drums and the audio licence of the Metal Kick Drum samples were not confirmed at the authors' own sites.
