//! THE-212: the audio callback of a stretched backing allocates nothing. The low band's buffers (its cache, frames,
//! spectra and grain) are sized when the voice is built; rendering, seeking, changing the speed under it (mid-hop too,
//! and to and from the neutral speed), jumping the clock and a loop wrap only read and write them. At 44.1, 48 and 96 kHz,
//! with key shifts.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    f64::consts::TAU,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tabplayer_lib::{
    audio::{
        backing::{BackingMap, BackingVoice},
        decode::DecodedAudio,
        plan::PlaybackPlan,
    },
    settings::{BackingFilter, BackingProcessing, SyncAnchor},
};

struct Counting;
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
}
fn counting() -> bool {
    COUNTING.try_with(Cell::get).unwrap_or(false)
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if counting() {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if counting() {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.realloc(pointer, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":6000,"tracks":[{"id":"guitar","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120},{"tick":3840,"bpm":60}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":6000}],"notes":[],"midi":[]})).unwrap()
}

#[test]
fn rendering_seeking_and_changing_speed_allocate_nothing() {
    // The counter works: a vector built while counting is seen.
    ALLOCATIONS.store(0, Ordering::Relaxed);
    COUNTING.with(|c| c.set(true));
    drop(std::hint::black_box(vec![0u8; 64]));
    COUNTING.with(|c| c.set(false));
    assert!(ALLOCATIONS.load(Ordering::Relaxed) > 0);
    // Sources, 4 s long, at the three rates: a sustained 41.2 Hz bass under an octave, a chord tone and noise, with
    // isolated clicks; and kicks and plucked notes from silence, which split the low band into segments.
    for rate in [48_000u32, 44_100, 96_000] {
        for (name, frames) in [("busy", busy(rate)), ("onsets", onsets(rate))] {
            let frames = Arc::new(frames);
            for shift in [0i8, -5, 7, 12] {
                let mut voice = BackingVoice::new_with_processing_shifted(
                    Arc::new(DecodedAudio {
                        sample_rate: rate,
                        channels: 2,
                        frames: frames.clone(),
                    }),
                    BackingMap::new(&[], 0.0, &plan()).unwrap(),
                    rate,
                    BackingProcessing {
                        semitones: 0.0,
                        cents: 0.0,
                        filter: BackingFilter::None,
                    },
                    shift,
                )
                .unwrap();
                let neutral = 2.0_f64.powf(f64::from(shift) / 12.0);
                let mut heard = Vec::with_capacity(rate as usize);
                voice.seek(0.0);
                let mut clock = 0.0f64;
                let frame = |voice: &mut BackingVoice, clock: &mut f64, speed: f64| {
                    *clock += speed / f64::from(rate);
                    voice.next_frame(*clock)
                };
                // A first stretch fills the low band's cache once; counting starts after it.
                for _ in 0..rate / 4 {
                    frame(&mut voice, &mut clock, 0.5);
                }
                ALLOCATIONS.store(0, Ordering::Relaxed);
                COUNTING.with(|c| c.set(true));
                let mut energy = 0.0f64;
                for speed in [0.5, 1.0, 0.75, neutral, 3.0, 0.1, 0.9, 1.0] {
                    for n in 0..16_000u32 {
                        let x = frame(&mut voice, &mut clock, speed);
                        energy += f64::from(x[0] * x[0]);
                        if n % 7_000 == 6_999 {
                            // A loop wrap.
                            clock = 0.5 + f64::from(n % 5) * 0.1;
                            voice.seek(clock);
                        }
                        if n % 3_001 == 3_000 {
                            // A jump of the clock that is not a seek.
                            clock += 0.2;
                        }
                    }
                    if clock > 3.0 {
                        clock = 0.2;
                        voice.seek(clock);
                    }
                }
                // The speed changing every 700 frames, mid-hop of the grains (the practice tempo does it on the audio
                // thread), to and from the neutral speed.
                clock = 0.3;
                voice.seek(clock);
                for round in 0..60 {
                    let speed = if round % 2 == 0 { neutral } else { 0.5 };
                    for _ in 0..700 {
                        let x = frame(&mut voice, &mut clock, speed);
                        energy += f64::from(x[0] * x[0]);
                    }
                }
                // One second of steady half speed, kept to check below that the low band was the vocoder's.
                clock = 1.3;
                voice.seek(clock);
                for _ in 0..rate {
                    heard.push(frame(&mut voice, &mut clock, 0.5 * neutral)[0]);
                }
                COUNTING.with(|c| c.set(false));
                assert!(energy.is_finite() && energy > 0.0);
                assert_eq!(
                    ALLOCATIONS.load(Ordering::Relaxed),
                    0,
                    "{name} at {rate} Hz, key shift {shift}: the callback allocated"
                );
                if name == "busy" {
                    // The sustained bass kept its level at its own pitch: the grains alone give it at half its pitch.
                    let hz = 41.2 * neutral;
                    let level = 20.0 * (tone(&heard[rate as usize / 2..], hz, rate) / 0.3).log10();
                    assert!(
                        level.abs() <= 1.0,
                        "{rate} Hz, key shift {shift}: the 41.2 Hz bass at {level:+.2} dB"
                    );
                }
            }
        }
    }
}

fn voice(
    rate: u32,
    output_rate: u32,
    frames: Vec<[f32; 2]>,
    offset_ms: f64,
    shift: i8,
) -> BackingVoice {
    mapped(
        rate,
        output_rate,
        frames,
        BackingMap::new(&[], offset_ms, &plan()).unwrap(),
        shift,
    )
}

fn mapped(
    rate: u32,
    output_rate: u32,
    frames: Vec<[f32; 2]>,
    map: BackingMap,
    shift: i8,
) -> BackingVoice {
    BackingVoice::new_with_processing_shifted(
        Arc::new(DecodedAudio {
            sample_rate: rate,
            channels: 2,
            frames: Arc::new(frames),
        }),
        map,
        output_rate,
        BackingProcessing {
            semitones: 0.0,
            cents: 0.0,
            filter: BackingFilter::None,
        },
        shift,
    )
    .unwrap()
}

/// A map or a file far outside what the low band is made for neither stalls the callback nor panics: an offset that puts
/// the clock beyond any position a sample index can hold, files at up to 128 times the output rate, and the steepest
/// read the low band still takes (a 384 kHz file at 48 kHz, an octave up) at every practice speed.
#[test]
fn extreme_maps_and_rates_neither_stall_nor_panic() {
    let sine = |rate: u32, seconds: f64| -> Vec<[f32; 2]> {
        (0..(seconds * f64::from(rate)) as usize)
            .map(|n| [(0.4 * (TAU * 55.0 * n as f64 / f64::from(rate)).sin()) as f32; 2])
            .collect()
    };
    for offset_ms in [-1e22, 1e22, -1e9] {
        let mut voice = voice(48_000, 48_000, sine(48_000, 1.0), offset_ms, 0);
        voice.seek(0.0);
        let mut clock = 0.0f64;
        for _ in 0..12_000 {
            clock += 0.5 / 48_000.0;
            assert!(voice.next_frame(clock).iter().all(|v| v.is_finite()));
        }
    }
    for (rate, output, shift) in [
        (6_144_000u32, 48_000u32, 0i8),
        (768_000, 22_050, 12),
        (384_000, 48_000, 12),
    ] {
        let mut voice = voice(rate, output, sine(rate, 0.5), 0.0, shift);
        voice.seek(0.0);
        let mut clock = 0.0f64;
        for speed in [0.1, 0.5, 1.0, 3.0] {
            clock = clock.min(0.2);
            for _ in 0..2_000 {
                clock += speed / f64::from(output);
                assert!(voice.next_frame(clock).iter().all(|v| v.is_finite()));
            }
        }
    }
}

/// Changing the speed while playing, a few times a second and mid-hop, across attacks and across the share of the speed
/// below which V waits for whole windows, never makes the low band leave at once: no step from one output frame to the
/// next is larger than the largest develop's grains make of the same notes (and none reaches 0.008, where the notes'
/// own steps are under 0.02). The level at those hand-overs is `handing_the_low_band_over_and_back_keeps_the_level`.
#[test]
fn speed_changes_near_attacks_never_click() {
    let rate = 48_000u32;
    // Low notes every 0.37 s, each starting over 3 ms and dying away over 0.3 s, and nothing else: every step from one
    // frame to the next in it is under 0.02.
    let frames: Vec<[f32; 2]> = (0..6 * rate as usize)
        .map(|n| {
            let t = n as f64 / f64::from(rate);
            let mut x = 0.0;
            let mut k = 0usize;
            while k as f64 * 0.37 <= t {
                let age = t - k as f64 * 0.37;
                let hz = [41.2, 55.0, 61.7, 49.0][k % 4];
                x += 0.4 * (age / 0.003).min(1.0) * (-age / 0.3).exp() * (TAU * hz * age).sin();
                k += 1;
            }
            [x as f32, (0.7 * x) as f32]
        })
        .collect();
    let largest = frames
        .windows(2)
        .map(|w| (w[1][0] - w[0][0]).abs())
        .fold(0.0f32, f32::max);
    assert!(largest < 0.02, "the source steps by {largest}");
    for shift in [0i8, 7] {
        let neutral = 2.0_f64.powf(f64::from(shift) / 12.0);
        let mut outputs = Vec::new();
        for develop in [false, true] {
            let mut voice = voice(rate, rate, frames.clone(), 0.0, shift);
            if develop {
                voice = voice.without_low_band();
            }
            voice.seek(0.0);
            let mut clock = 0.0f64;
            let mut out = Vec::with_capacity(90 * 1_499);
            for round in 0..90 {
                let speed = [0.5, 0.3, 0.9, 0.35, 1.0, 0.45, 0.2, 0.75][round % 8] * neutral;
                for _ in 0..1_499 {
                    clock += speed / f64::from(rate);
                    out.push(voice.next_frame(clock));
                }
            }
            outputs.push(out);
        }
        let steps = |x: &[[f32; 2]]| -> (f32, usize) {
            x.windows(2)
                .enumerate()
                .map(|(n, w)| {
                    let step = (w[1][0] - w[0][0]).abs().max((w[1][1] - w[0][1]).abs());
                    (step, n + 1)
                })
                .fold((0.0f32, 0usize), |a, b| if b.0 > a.0 { b } else { a })
        };
        let (worst, develop_worst) = (steps(&outputs[0]), steps(&outputs[1]));
        // This branch: 0.0069 unshifted and 0.0072 at +7, the very steps develop's grains make at the same frames.
        assert!(
            worst.0 < 0.008 && worst.0 <= develop_worst.0,
            "key shift {shift}: a step of {} at output frame {} (develop {} at {})",
            worst.0,
            worst.1,
            develop_worst.0,
            develop_worst.1
        );
    }
}

/// A clock that leaps while the vocoder is heard, without a seek (a sync map far steeper than any practice speed, which
/// the anchors allow, or a jump) keeps every grain within the low band's budget: V leaves over one grain from what its
/// last frame carries, making no frame at the new place, and comes back once the attack scan has caught up. At 48 kHz,
/// and for files at 192 and 384 kHz an octave up, where the low-pass is longest. The work is counted, not timed: the most
/// decimated samples of the low-pass computed and the most frames of V made in any one grain. No grain across the leap
/// computes more than the worst grain after a cold seek, plus what a grain reads of the low band itself for its
/// crossfade (twice 36 samples at most), nor makes more than two frames. Before this, the grain where the clock leapt
/// computed everything up to the new place at once: 203 to 1508 samples here (0.36 to 9.7 million multiplies). The
/// output stays finite, steps at most a quarter more than develop's grains do across the leap (this branch: 13% more at
/// most), and the tone keeps its level at its own pitch before the leap and after.
#[test]
fn a_clock_that_leaps_without_a_seek_stays_within_a_grains_budget() {
    // Score 0 to 1 s plays source 0 to 1 s; the next 10 ms of score play a whole second of source (100 times the speed,
    // 50 at half speed: far beyond the 8 times V follows); the score after that plays at two thirds.
    let anchors = [
        (0u32, 0.0, 0.0),
        (0, 0.5, 1000.0),
        (0, 0.505, 2000.0),
        (1, 0.5, 4000.0),
    ]
    .map(|(bar, ratio, audio_ms)| SyncAnchor {
        bar,
        occurrence: 0,
        ratio,
        audio_ms,
    });
    let output = 48_000u32;
    for (rate, shift) in [(48_000u32, 0i8), (192_000, 12), (384_000, 12)] {
        let neutral = 2.0_f64.powf(f64::from(shift) / 12.0);
        let frames: Vec<[f32; 2]> = (0..3 * rate as usize)
            .map(|n| {
                let x = 0.4 * (TAU * 55.0 * n as f64 / f64::from(rate)).sin();
                [x as f32, (0.8 * x) as f32]
            })
            .collect();
        for leap in ["steep map", "jump"] {
            let mut runs = Vec::new();
            for develop in [false, true] {
                let map = if leap == "steep map" {
                    BackingMap::new(&anchors, 0.0, &plan()).unwrap()
                } else {
                    BackingMap::new(&[], 0.0, &plan()).unwrap()
                };
                let mut voice = mapped(rate, output, frames.clone(), map, shift);
                if develop {
                    voice = voice.without_low_band();
                }
                let mut clock = 0.3f64;
                voice.seek(clock);
                let play = |voice: &mut BackingVoice, clock: &mut f64, count: usize| {
                    (0..count)
                        .map(|_| {
                            *clock += 0.5 / f64::from(output);
                            let x = voice.next_frame(*clock);
                            assert!(x.iter().all(|v| v.is_finite()), "{leap} at {rate} Hz");
                            x
                        })
                        .collect::<Vec<_>>()
                };
                // From a seek into audio the low band has not seen (a cold start) to just before the leap.
                let before = play(&mut voice, &mut clock, 65_000);
                let seek = voice.low_band_work();
                if leap == "jump" {
                    clock += 0.5;
                }
                let across = play(&mut voice, &mut clock, 24_000);
                let crossing = voice.low_band_work();
                let after = play(&mut voice, &mut clock, 24_000);
                runs.push((before, across, after, seek, crossing));
            }
            let (before, across, after, seek, crossing) = &runs[0];
            let ((seek_work, seek_frames), (leap_work, leap_frames)) =
                (seek.unwrap(), crossing.unwrap());
            let hz = 55.0 * neutral;
            let level = |x: &[[f32; 2]]| {
                let left: Vec<f32> = x.iter().map(|v| v[0]).collect();
                20.0 * (tone(&left, hz, output) / 0.4).log10()
            };
            let largest = |x: &[[f32; 2]]| {
                x.windows(2)
                    .map(|w| (w[1][0] - w[0][0]).abs().max((w[1][1] - w[0][1]).abs()))
                    .fold(0.0f32, f32::max)
            };
            let (level_before, level_after) =
                (level(&before[before.len() - 24_000..]), level(after));
            let (step, develop_step) = (largest(across), largest(&runs[1].1));
            eprintln!(
                "{leap} at {rate} Hz, key shift {shift}: worst grain after the seek {seek_work} samples, {seek_frames} frames; across the leap {leap_work} samples, {leap_frames} frames; level before {level_before:+.2} dB, after {level_after:+.2} dB; largest step across {step:.5} (develop {develop_step:.5})"
            );
            assert!(
                leap_work <= seek_work + 72 && seek_frames <= 2 && leap_frames <= 2,
                "{leap} at {rate} Hz: {leap_work} samples and {leap_frames} frames in a grain (after a seek {seek_work}, {seek_frames})"
            );
            assert!(
                level_before.abs() <= 0.1 && level_after.abs() <= 0.1,
                "{leap} at {rate} Hz: the tone at {level_before:+.2} dB before, {level_after:+.2} dB after"
            );
            assert!(
                step <= 1.25 * develop_step,
                "{leap} at {rate} Hz: a step of {step} across the leap (develop {develop_step})"
            );
        }
    }
}

/// A damaged or hostile file may hold samples at the very top of what an f32 holds, or ones that are not numbers: sums of
/// them overflow, and a finite one that large would be spread over every frame of V that spans it. The low band hears
/// them clipped, so it carries nothing of them on: the output stays finite, it is out of range for no more output frames
/// than develop's grains make of them (which play them as they are), and around them it keeps its level (no silence after
/// them) and the low tone its level at its own pitch.
#[test]
fn samples_near_the_largest_float_leave_nothing_behind() {
    let rate = 48_000u32;
    let mut frames: Vec<[f32; 2]> = (0..4 * rate as usize)
        .map(|n| {
            let x = 0.4 * (TAU * 55.0 * n as f64 / f64::from(rate)).sin();
            [x as f32, (0.8 * x) as f32]
        })
        .collect();
    // At 1 s one sample of 3e38; at 1.6 s sixteen of plus and minus 3e38, whose sums in the low-pass overflow to infinity
    // and NaN; at 2.2 s sixteen that are not numbers.
    let second = rate as usize;
    frames[second] = [3e38, 3e38];
    for k in 0..16 {
        let v = if k % 4 < 2 { 3e38f32 } else { -3e38 };
        frames[second * 8 / 5 + k] = [v, v];
        frames[second * 11 / 5 + k] = [f32::NAN, f32::NAN];
    }
    for shift in [0i8, 7] {
        let neutral = 2.0_f64.powf(f64::from(shift) / 12.0);
        let mut outputs = Vec::new();
        for develop in [false, true] {
            let mut voice = voice(rate, rate, frames.clone(), 0.0, shift);
            if develop {
                voice = voice.without_low_band();
            }
            voice.seek(0.8);
            let mut clock = 0.8f64;
            let out: Vec<[f32; 2]> = (0..160_000)
                .map(|_| {
                    clock += 0.5 * neutral / f64::from(rate);
                    voice.next_frame(clock)
                })
                .collect();
            assert!(
                out.iter().flatten().all(|v| v.is_finite()),
                "key shift {shift}"
            );
            outputs.push(out);
        }
        let loud = |x: &[[f32; 2]]| {
            x.iter()
                .filter(|v| v[0].abs().max(v[1].abs()) > 1.0)
                .count()
        };
        let (mine_loud, develop_loud) = (loud(&outputs[0]), loud(&outputs[1]));
        // Every 20 ms window in which develop is in range: its level, and the branch's.
        let level = |w: &[[f32; 2]]| {
            10.0 * (w.iter().map(|v| f64::from(v[0]).powi(2)).sum::<f64>() / w.len() as f64)
                .max(1e-12)
                .log10()
        };
        let source_level = 10.0 * (0.4f64 * 0.4 / 2.0).log10();
        let mut worst = (0.0f64, 0usize);
        for (k, (m, d)) in outputs[0]
            .chunks_exact(960)
            .zip(outputs[1].chunks_exact(960))
            .enumerate()
            .skip(10)
        {
            if d.iter().any(|v| v[0].abs().max(v[1].abs()) > 1.0) {
                continue;
            }
            let error = level(m) - source_level;
            if error.abs() > worst.0.abs() {
                worst = (error, k);
            }
        }
        let left: Vec<f32> = outputs[0][outputs[0].len() - 24_000..]
            .iter()
            .map(|v| v[0])
            .collect();
        let tone_level = 20.0 * (tone(&left, 55.0 * neutral, rate) / 0.4).log10();
        // This branch: out of range for as many frames as develop (91 unshifted, 53 at +7), every window within 0.46 dB,
        // the tone at 0.00 dB. Before the clip: 16 985 frames out of range (+710 dB), then silence.
        assert!(
            mine_loud <= develop_loud && worst.0.abs() <= 1.0 && tone_level.abs() <= 0.1,
            "key shift {shift}: out of range for {mine_loud} frames (develop {develop_loud}), a 20 ms window at {:+.2} dB (window {}), the tone at the end {tone_level:+.2} dB",
            worst.0,
            worst.1
        );
    }
}

/// The amplitude of the partial at `hz` in `x`, through a Hann window.
fn tone(x: &[f32], hz: f64, rate: u32) -> f64 {
    let n = x.len() as f64;
    let (mut re, mut im, mut sum) = (0.0, 0.0, 0.0);
    for (i, &v) in x.iter().enumerate() {
        let w = 0.5 - 0.5 * (TAU * i as f64 / n).cos();
        let phase = TAU * hz * i as f64 / f64::from(rate);
        re += w * f64::from(v) * phase.cos();
        im -= w * f64::from(v) * phase.sin();
        sum += w;
    }
    2.0 * re.hypot(im) / sum
}

/// A sustained 41.2 Hz bass with its octave, a chord tone and noise, with isolated clicks, 4 s long.
fn busy(rate: u32) -> Vec<[f32; 2]> {
    let mut noise = 0x9E37_79B9_u32;
    (0..4 * rate as usize)
        .map(|n| {
            let t = n as f64 / f64::from(rate);
            noise ^= noise << 13;
            noise ^= noise >> 17;
            noise ^= noise << 5;
            let mut x = 0.3 * (TAU * 41.2 * t).sin()
                + 0.2 * (TAU * 82.4 * t).sin()
                + 0.1 * (TAU * 330.0 * t).sin()
                + 0.05 * (f64::from(noise) / f64::from(u32::MAX) - 0.5);
            if n % (rate as usize * 5 / 6) == rate as usize * 5 / 12 {
                x += 0.9;
            }
            [x as f32, (0.8 * x) as f32]
        })
        .collect()
}

/// A kick every 0.4 s over silence, and a plucked bass note on every other beat with a quiet tail under the next, 4 s
/// long.
fn onsets(rate: u32) -> Vec<[f32; 2]> {
    (0..4 * rate as usize)
        .map(|n| {
            let t = n as f64 / f64::from(rate);
            let beat = (t / 0.4).floor();
            let age = t - beat * 0.4;
            let kick = 0.8
                * (age / 0.001).min(1.0)
                * (-age / 0.05).exp()
                * (TAU * (45.0 + 75.0 * (-age / 0.02).exp()) * age).sin();
            let note = if beat as i64 % 2 == 1 {
                0.5 * (age / 0.003).min(1.0) * (-age / 0.09).exp() * (TAU * 55.0 * age).sin()
            } else {
                0.0
            };
            let tail = 0.0008 * (-age / 0.5).exp() * (TAU * 98.0 * t).sin();
            let x = (kick + note + tail) as f32;
            [x, 0.9 * x]
        })
        .collect()
}
