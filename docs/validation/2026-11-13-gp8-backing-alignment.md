# GP8 parity P20: backing alignment under loops, seeks, speed and feel (2026-11-13)

THE-57. Measurement only: **no product code changed**. The new test program is `src-tauri/tests/audio_backing_alignment.rs`. Nobody has listened to any of this; every claim below is a number from a headless render at 48 kHz through `CallbackTransport` (the real loop, seek, count and practice-tempo path), not a judgement of sound.

**Headline.** Backing transients (isolated clicks and impulses) land on the score's frame, exactly. Sustained backing audio, which is what real recordings are made of, is **not** sample aligned at any speed other than 1.0x: it sits a bounded amount early (below 1.0x) or late (above 1.0x), about 7.6 to 15.9 ms at the speeds measured, and it is the same on every loop pass. It was not changed, because changing it changes the sound and nobody has listened. A partial-beat loop with real backing audio is therefore aligned to within that offset, not to the frame.

Method: a score run puts a recorded one-sample guitar attack on each chosen tick; a second, identical run (same loop, speed and buffer sizes) renders only the backing, with an isolated impulse or a 40 ms Hann-windowed 1 kHz burst on the same ticks. The runs are kept apart so the two never sum. Alignment is the backing event's output frame minus the score event's. The plan is 120 BPM then 60 BPM, so every tick is a whole frame (25 or 50 score frames).

## (c) Partial-beat loop alignment

Code: a loop is two f64 ticks (`PracticeLoop`, `device.rs:101`; `SetLoop`, `device.rs:1360-1369`) and nothing requires a beat or bar edge. A wrap is `wrap()` (`device.rs:1450`) then `seek_tick_internal` (`renderer.rs:1668-1700`): `seconds = tick_to_seconds(tick)`, then `backing.seek(seconds)` (`renderer.rs:1857`). The backing is read from the score clock alone (`renderer.rs:1479`, `BackingMap::source_seconds`), so a loop edge inside a beat needs no beat map.

### Transients: exact (asserted equal to 0 frames)

Isolated impulses bypass the stretcher (`backing.rs` transient path, about lines 248 and 317-323), so these results say nothing about real audio. Loops 1440 to 3360 ticks and 3120 to 4560 ticks (both edges inside a beat), speeds 0.5, 1.0, 1.7, 14 to 53 events each:

- Backing impulse versus the score attack: **0 frames for every event, asserted as equal to 0**, across every wrap.
- Loop edges, proved by sample value: the two edges of the loop carry impulses of different heights (0.9 on the start tick, 0.5 on the end tick, 0.7 elsewhere). The start-tick height is heard at output frame 0 and again one pass later (within 1 frame of 48,000 / speed); the end-tick height is **never** heard; four or more middle events sound. A mutation check (loop end moved to 3361) makes the test fail with the end event heard at the pass boundary, so the test can fail.
- Seek into mid-beat (tick 3200, speeds 0.5, 1.0, 1.7), a one-bar count-in between loops (0.5, 1.0) and a 100 ms backing offset: asserted 0 frames.

### Sustained audio: bounded offset that depends on speed, not fixed

Tone bursts go through the grain stretcher. Error in score time (source frames), loop 1500 to 5000 ticks, three passes (at least two whole passes, 8 or more bursts) at every speed:

| Speed | Measured, source frames | In ms | Direction |
| --- | --- | --- | --- |
| 0.1 | 462.8 to 463.0 | 9.6 | early |
| 0.5 | 364.7 to 366.3 | 7.6 | early |
| 1.0 | below 0.001 | 0 | exact |
| 1.7 | 391.7 to 403.8 | 8.4 | late |
| 3.0 | 633.0 to 765.0 | 15.9 | late |

The test asserts, per speed, the sign (early below 1.0x, late above), a window around the measured values (highest accepted = the structural maximum 256 + 256 x |1 - speed| plus a few frames: 490, 390, 440, 775; lowest accepted about 10% under the smallest measured: 415, 325, 350, 560), the exact 0 at 1.0x (below 0.001 frames), and that every pass reproduces the previous one burst for burst to 0.01 source frames (no drift). The windows are close to the measurement; they are a guard against change, not a statement that the offset is acceptable.

Cause (read from `backing.rs:333-390`): each 256-frame grain is read at the source rate, not the score's, and the correlation search (window of plus or minus 256 source frames around the score's position) always prefers the previous grain's natural continuation, so the position settles at the edge of that window rather than at its centre. The offset is fixed in musical time, so in output frames it grows as the speed falls. **Not fixed:** a re-centred search changes the sound of the stretched backing on a path nobody has listened to.

### Feel and focus: not a backing question

- Feel (N14, triplet, dotted and Scottish feels) is written into the plan as the notes' own ticks. Bars, tempos and occurrences are untouched. Test `a_swung_feel_moves_the_score_and_not_the_backing`: moving the score's notes by 160 ticks moves their attacks by exactly 4,000 / speed frames (0.5 and 1.0) and the backing's frames do not change at all.
- Focus (U13, `2026-10-23-gp8-instrument-focus.md`) is a view of the instrument and changes no audio. No test was added.

## Fermata holds

Not implemented. A Guitar Pro 8 probe found no hold in its MIDI export; the question is parked with the owner.

## (a) Fixed mode with backing: still refused; this needs a decision

What fixed mode is: one BPM, 10 to 300, used across every authored tempo change (`PracticeTempo::Fixed`, `practice.rs:9`; the clock advances by ticks, `renderer.rs:1556-1562`).

Where it is refused: `practice.rs:123` (`validate(has_backing)`), `renderer.rs:1903` (`set_practice_tempo`) and `renderer.rs:2216` (`install_processed_backing_shifted`), reached from `device.rs:1071`, `1346` and `2544`; on the page `practice.ts:58` (`fixed_backing`) and `practiceForBacking` (`practice.ts:66-69`, which falls back to relative 100% with a notice); the panel disables the option (`PracticePanel.tsx:33-34`). A muted backing counts. The English, Estonian and German messages exist and are accurate ("unavailable while a backing track is present"). **Left as it is.**

What I found: mechanically it would work, because the backing already follows the score position through the map. The stretcher kept 440 Hz, finite and full level on a pure tone at 0.033, 0.1, 3, 6, 10 and 30 times (scratch measurement, not kept). But the result depends on a rule nobody has chosen, so I did not invent one.

## Open questions for the owner

0. Is a backing that is 8 to 16 ms early at slow practice speeds and late at fast ones acceptable, or should the stretcher be re-centred? Re-centring changes the sound and needs listening before it is chosen.

Fixed mode with backing:

1. Should fixed mode with a backing exist at all? Options: keep the refusal (today); or allow it.
2. If allowed, what does the backing do? (i) Follow the score position, so it is stretched by fixed BPM divided by the authored tempo at each point (simplest; assumes the audio matches the authored tempo map, as relative speed does today). (ii) For a score that follows its audio (reference sync), the tempos come from the audio, so fixed BPM would be compared with the derived tempos. (iii) Mute the backing in fixed mode.
3. What happens when the implied ratio leaves 10% to 300% (fixed 300 BPM over an authored 10 BPM is 30 times)? Refuse the setting, clamp, or mute the backing there.

## Limits

Headless only; no device, no ears. The 0-frame results hold for isolated impulses only. Tone bursts are synthetic and periodic; real music will not saturate the search window the same way and was not measured. Speeds 0.1 and 3.0 are measured on bursts only. The Windows driver `tests/desktop/parity-practice.mjs` was not run. The P20 row in the parity tracker is not updated.
