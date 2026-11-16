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
    settings::{BackingFilter, BackingProcessing},
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
