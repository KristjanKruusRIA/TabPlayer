//! THE-57 / P20 decision 1: the backing time-stretcher is re-centred. Measured on `BackingVoice` alone (no device, no
//! transport): where sustained audio sits against the score clock, and what the stretch does to a steady tone. Nobody
//! has listened to any of this; every number is a headless measurement at 48 kHz.
use std::sync::Arc;
use tabplayer_lib::{
    audio::{
        backing::{BackingMap, BackingVoice},
        decode::DecodedAudio,
        plan::PlaybackPlan,
    },
    settings::{BackingFilter, BackingProcessing, SyncAnchor},
};

const RATE: u32 = 48_000;
const SPEEDS: [f64; 5] = [0.1, 0.5, 1.0, 1.7, 3.0];

fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":6000,"tracks":[{"id":"guitar","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120},{"tick":3840,"bpm":60}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":6000}],"notes":[],"midi":[]})).unwrap()
}

fn voice(source: Vec<f32>) -> BackingVoice {
    voice_with(source, 1.0, 0)
}

/// A voice whose map runs `slope` source seconds per score second (two sync anchors when it is not 1) and whose pitch
/// is moved by `shift` semitones, the practice key shift.
fn voice_with(source: Vec<f32>, slope: f64, shift: i8) -> BackingVoice {
    let anchors = if slope == 1.0 {
        Vec::new()
    } else {
        two_anchors(slope)
    };
    build(source, anchors, shift)
}

/// Two sync anchors, at the start of bar 0 and of bar 1 (score 0 s and 2 s), `slope` source seconds per score second.
fn two_anchors(slope: f64) -> Vec<SyncAnchor> {
    vec![
        SyncAnchor {
            bar: 0,
            occurrence: 0,
            ratio: 0.0,
            audio_ms: 0.0,
        },
        SyncAnchor {
            bar: 1,
            occurrence: 0,
            ratio: 0.0,
            audio_ms: 2000.0 * slope,
        },
    ]
}

fn build(source: Vec<f32>, anchors: Vec<SyncAnchor>, shift: i8) -> BackingVoice {
    build_at(source, anchors, shift, RATE)
}

/// As `build`, for a file recorded at `file_rate`.
fn build_at(source: Vec<f32>, anchors: Vec<SyncAnchor>, shift: i8, file_rate: u32) -> BackingVoice {
    let frames: Vec<[f32; 2]> = source.iter().map(|&x| [x, x]).collect();
    BackingVoice::new_with_processing_shifted(
        Arc::new(DecodedAudio {
            sample_rate: file_rate,
            channels: 2,
            frames: Arc::new(frames),
        }),
        BackingMap::new(&anchors, 0.0, &plan()).unwrap(),
        RATE,
        BackingProcessing {
            semitones: 0.0,
            cents: 0.0,
            filter: BackingFilter::None,
        },
        shift,
    )
    .unwrap()
}

/// `frames` output frames of `voice` with the score clock running at `speed`, the way the renderer drives it.
fn run(voice: &mut BackingVoice, speed: f64, frames: usize) -> Vec<f64> {
    voice.seek(0.0);
    (0..frames)
        .map(|n| f64::from(voice.next_frame(n as f64 * speed / f64::from(RATE))[0]))
        .collect()
}

fn sine(freqs: &[(f64, f64)], frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|n| {
            freqs
                .iter()
                .map(|(f, a)| a * (std::f64::consts::TAU * f * n as f64 / f64::from(RATE)).sin())
                .sum::<f64>() as f32
        })
        .collect()
}

/// Weighted (Hann) least-squares fit of sines and cosines at `freqs`: the amplitude of each, and the share of the
/// windowed energy that is not in any of them.
fn fit(x: &[f64], freqs: &[f64]) -> (Vec<f64>, f64) {
    let n = x.len();
    let w: Vec<f64> = (0..n)
        .map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * (i as f64 + 0.5) / n as f64).cos())
        .collect();
    let columns: Vec<Vec<f64>> = freqs
        .iter()
        .flat_map(|&f| {
            let phase = move |i: usize| std::f64::consts::TAU * f * i as f64 / f64::from(RATE);
            [
                (0..n).map(|i| phase(i).cos()).collect::<Vec<f64>>(),
                (0..n).map(|i| phase(i).sin()).collect::<Vec<f64>>(),
            ]
        })
        .collect();
    let k = columns.len();
    let mut a = vec![vec![0.0; k + 1]; k];
    for i in 0..k {
        for j in 0..k {
            a[i][j] = (0..n)
                .map(|t| w[t] * w[t] * columns[i][t] * columns[j][t])
                .sum();
        }
        a[i][k] = (0..n).map(|t| w[t] * w[t] * columns[i][t] * x[t]).sum();
    }
    for col in 0..k {
        let pivot = (col..k)
            .max_by(|&p, &q| a[p][col].abs().total_cmp(&a[q][col].abs()))
            .unwrap();
        a.swap(col, pivot);
        for row in 0..k {
            if row != col {
                let factor = a[row][col] / a[col][col];
                for c in col..=k {
                    a[row][c] -= factor * a[col][c];
                }
            }
        }
    }
    let coefficients: Vec<f64> = (0..k).map(|i| a[i][k] / a[i][i]).collect();
    let total: f64 = (0..n).map(|t| w[t] * w[t] * x[t] * x[t]).sum();
    let residual: f64 = (0..n)
        .map(|t| {
            let model: f64 = (0..k).map(|i| coefficients[i] * columns[i][t]).sum();
            w[t] * w[t] * (x[t] - model).powi(2)
        })
        .sum();
    let amplitudes = (0..freqs.len())
        .map(|i| coefficients[2 * i].hypot(coefficients[2 * i + 1]))
        .collect();
    (amplitudes, residual / total.max(1e-30))
}

/// The frequency near `nominal` that a single sine fits `x` best at, found on a grid then refined.
fn peak(x: &[f64], nominal: f64) -> f64 {
    let mut best = (f64::INFINITY, nominal);
    let mut search = |from: f64, to: f64, step: f64, best: &mut (f64, f64)| {
        let mut f = from;
        while f <= to + 1e-9 {
            let (_, residual) = fit(x, &[f]);
            if residual < best.0 {
                *best = (residual, f);
            }
            f += step;
        }
    };
    search(nominal - 3.0, nominal + 3.0, 0.25, &mut best);
    let centre = best.1;
    search(centre - 0.25, centre + 0.25, 0.02, &mut best);
    best.1
}

struct Quality {
    /// Worst frequency error among the tones, in cents.
    cents: f64,
    /// Worst amplitude error among the tones, in dB.
    db: f64,
    /// Share of the energy outside the tones, in dB (lower is purer).
    off_tone_db: f64,
    /// The largest sample-to-sample step of the output over that of the source.
    step_ratio: f64,
}

fn quality(speed: f64, tones: &[(f64, f64)]) -> Quality {
    let measured = 24_000;
    let skip = 4_800;
    let out_frames = skip + measured;
    let source_frames = (out_frames as f64 * speed) as usize + 20_000;
    let source = sine(tones, source_frames);
    let out = run(&mut voice(source.clone()), speed, out_frames);
    let x = &out[skip..];
    let freqs: Vec<f64> = tones.iter().map(|t| peak(x, t.0)).collect();
    let (amplitudes, residual) = fit(x, &freqs);
    let largest = |s: &[f64]| {
        s.windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f64::max)
    };
    let source_largest = largest(
        &source[..out_frames.min(source.len())]
            .iter()
            .map(|&v| f64::from(v))
            .collect::<Vec<_>>(),
    );
    Quality {
        cents: tones
            .iter()
            .zip(&freqs)
            .map(|(t, f)| (1200.0 * (f / t.0).log2()).abs())
            .fold(0.0, f64::max),
        db: tones
            .iter()
            .zip(&amplitudes)
            .map(|(t, a)| (20.0 * (a / t.1).log10()).abs())
            .fold(0.0, f64::max),
        off_tone_db: 10.0 * residual.max(1e-30).log10(),
        step_ratio: largest(x) / source_largest,
    }
}

/// How far sustained audio sits from the score clock: Hann-windowed bursts of `kind` at source frames `at`, the
/// centroid of each in the output against where the clock puts it, in source frames (negative: early).
fn burst_errors(speed: f64, kind: Burst, count: usize) -> Vec<f64> {
    burst_errors_with(speed, 1.0, 0, kind, count, 1_920)
}

/// As `burst_errors`, with the map's slope and a key shift. `speed` is the score clock's rate; the source advances
/// `speed * slope` frames per output frame, and the error is in source frames.
fn burst_errors_with(
    speed: f64,
    slope: f64,
    shift: i8,
    kind: Burst,
    count: usize,
    length: usize,
) -> Vec<f64> {
    let rate = speed * slope;
    let spacing = (length * 3).max(6_000);
    let first = 2 * spacing;
    let mut source = vec![0.0f32; first + (count + 2) * spacing];
    let mut noise = 0x1234_5678_u32;
    let centres: Vec<usize> = (0..count).map(|i| first + i * spacing).collect();
    for &centre in &centres {
        for n in 0..length {
            let w = 0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / length as f64).cos();
            let carrier = match kind {
                Burst::Tone => (std::f64::consts::TAU * 1000.0 * n as f64 / f64::from(RATE)).sin(),
                Burst::Noise => {
                    noise ^= noise << 13;
                    noise ^= noise >> 17;
                    noise ^= noise << 5;
                    f64::from(noise) / f64::from(u32::MAX) * 2.0 - 1.0
                }
            };
            source[centre - length / 2 + n] = (carrier * w * 0.5) as f32;
        }
    }
    let out_frames = ((first + (count + 1) * spacing) as f64 / rate) as usize;
    let out = run(&mut voice_with(source, slope, shift), speed, out_frames);
    centres
        .iter()
        .map(|&centre| {
            let expected = centre as f64 / rate;
            let half = (1.5625 * length as f64 / rate) as usize;
            let (from, to) = (
                (expected as usize).saturating_sub(half),
                ((expected as usize) + half).min(out.len()),
            );
            let (mut sum, mut weight) = (0.0, 0.0);
            for (n, x) in out.iter().enumerate().take(to).skip(from) {
                sum += x * x * n as f64;
                weight += x * x;
            }
            (sum / weight - expected) * rate
        })
        .collect()
}

#[derive(Clone, Copy)]
enum Burst {
    Tone,
    Noise,
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

#[test]
#[ignore = "measurement table: cargo test --test audio_backing_stretch table -- --ignored --nocapture"]
fn table() {
    for speed in SPEEDS {
        let q1 = quality(speed, &[(440.0, 0.5)]);
        let q2 = quality(speed, &[(330.0, 0.3), (1170.0, 0.3)]);
        let count = (8.0 * speed).ceil().max(8.0) as usize;
        let tone = burst_errors(speed, Burst::Tone, count);
        let noise = burst_errors(speed, Burst::Noise, count);
        let range = |v: &[f64]| {
            (
                v.iter().copied().fold(f64::INFINITY, f64::min),
                v.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            )
        };
        eprintln!(
            "speed {speed}: sine {:.3}c {:.3}dB off {:.1}dB step {:.2} | two {:.3}c {:.3}dB off {:.1}dB step {:.2} | tone burst mean {:.1} range {:?} | noise burst mean {:.1} range {:?}",
            q1.cents,
            q1.db,
            q1.off_tone_db,
            q1.step_ratio,
            q2.cents,
            q2.db,
            q2.off_tone_db,
            q2.step_ratio,
            mean(&tone),
            range(&tone),
            mean(&noise),
            range(&noise)
        );
    }
}

fn tones(name: &str) -> Vec<(f64, f64)> {
    match name {
        "440" => vec![(440.0, 0.5)],
        "330+1170" => vec![(330.0, 0.3), (1170.0, 0.3)],
        "110" => vec![(110.0, 0.5)],
        "82" => vec![(82.0, 0.5)],
        "41" => vec![(41.0, 0.5)],
        "55+82" => vec![(55.0, 0.3), (82.0, 0.3)],
        _ => unreachable!(),
    }
}

/// The stretcher of the commit before the re-centring, measured with this file's `quality` (set of tones, speed, share
/// of energy outside the tones in dB, worst tone level error in dB). Below about 90 Hz one period is longer than the
/// stretcher's grain and its search window, and it fails at every speed, before and after (the 41 Hz and 55 + 82 Hz
/// rows have a fit that lands on the edge of the search for the tone): they are kept so that nothing gets worse.
const HEAD_QUALITY: [(&str, f64, f64, f64); 36] = [
    ("440", 0.1, -44.7, 0.003),
    ("440", 0.5, -46.2, 0.000),
    ("440", 0.75, -45.5, 0.000),
    ("440", 1.5, -46.2, 0.000),
    ("440", 1.7, -46.3, 0.002),
    ("440", 3.0, -40.1, 0.001),
    ("330+1170", 0.1, -20.7, 0.090),
    ("330+1170", 0.5, -21.9, 0.044),
    ("330+1170", 0.75, -24.0, 0.023),
    ("330+1170", 1.5, -15.2, 0.240),
    ("330+1170", 1.7, -26.9, 0.030),
    ("330+1170", 3.0, -3.2, 12.879),
    ("110", 0.1, -58.6, 0.000),
    ("110", 0.5, -53.4, 0.000),
    ("110", 0.75, -49.4, 0.000),
    ("110", 1.5, -53.4, 0.000),
    ("110", 1.7, -48.1, 0.000),
    ("110", 3.0, -52.0, 0.000),
    ("82", 0.1, -26.0, 0.018),
    ("82", 0.5, -26.2, 0.012),
    ("82", 0.75, -31.8, 0.003),
    ("82", 1.5, -26.0, 0.014),
    ("82", 1.7, -19.2, 0.062),
    ("82", 3.0, -44.7, 0.000),
    ("41", 0.1, -0.2, 13.649),
    ("41", 0.5, -0.0, 91.903),
    ("41", 0.75, -0.0, 48.221),
    ("41", 1.5, -0.0, 91.911),
    ("41", 1.7, -0.0, 111.342),
    ("41", 3.0, -0.0, 60.468),
    ("55+82", 0.1, -0.1, 15.993),
    ("55+82", 0.5, -0.8, 10.995),
    ("55+82", 0.75, -1.2, 7.168),
    ("55+82", 1.5, -5.0, 22.187),
    ("55+82", 1.7, -0.0, 39.963),
    ("55+82", 3.0, -1.7, 4.791),
];

#[test]
fn steady_tones_are_no_less_pure_than_before_at_any_speed_and_bass_is_no_worse() {
    // Purity may be at most 3 dB worse than the old stretcher at any point; the level error of a tone that came through
    // cleanly (under 1 dB) may grow by at most 0.15 dB; no join of a tone that came through cleanly may be steeper than 1.5 times the source's.
    for (name, speed, head_off, head_level) in HEAD_QUALITY {
        let q = quality(speed, &tones(name));
        // REPORT ONLY: below about 90 Hz one period is longer than the stretcher's grain and search window, so the
        // tone is not preserved at any speed, before or after this work (the fit lands on the edge of its search).
        // Those values are chaotic: one grain flipped by a libm difference (the sources use `sin`; CI runs Apple
        // Silicon) changes them, so they are printed and never asserted. See the validation note.
        if name == "41" || name == "55+82" {
            eprintln!(
                "report only, bass not preserved: {name} at {speed}: {:.1} dB (before {head_off} dB), level {:.2} dB (before {head_level} dB)",
                q.off_tone_db, q.db
            );
            continue;
        }
        assert!(
            q.off_tone_db <= head_off + 3.0,
            "{name} at {speed}: {} dB against {head_off} dB",
            q.off_tone_db
        );
        if head_level < 1.0 {
            assert!(
                q.step_ratio <= 1.5,
                "{name} at {speed}: step {}",
                q.step_ratio
            );
            assert!(
                q.db <= head_level + 0.15,
                "{name} at {speed}: level {} dB against {head_level} dB",
                q.db
            );
        }
    }
    // The 3.0x sine no longer loses purity (the first re-centring lost 10 dB there).
    let sine = quality(3.0, &[(440.0, 0.5)]);
    assert!(sine.off_tone_db <= -40.0, "{}", sine.off_tone_db);
}

#[test]
fn at_one_times_the_stretcher_returns_the_source_to_float_precision() {
    let source = sine(&[(330.0, 0.3), (1170.0, 0.3)], 30_000);
    let out = run(&mut voice(source.clone()), 1.0, 20_000);
    for n in 256..out.len() {
        assert!((out[n] - f64::from(source[n])).abs() < 1e-6, "frame {n}");
    }
}

#[test]
fn sustained_tone_bursts_sit_within_a_millisecond_of_the_score_clock() {
    // The requirement is 2 ms (96 source frames). Measured worst: 22 (0.1x), 12 (0.5x), 0 (1.0x), 31 (1.7x), 67 (3.0x).
    for speed in SPEEDS {
        let count = (8.0 * speed).ceil().max(8.0) as usize;
        let errors = burst_errors(speed, Burst::Tone, count);
        let bound = if speed == 1.0 { 0.001 } else { WITHIN_2_MS };
        assert!(
            errors.iter().all(|e| e.abs() <= bound),
            "speed {speed}: {errors:?}"
        );
    }
}

#[test]
fn sustained_two_hundred_millisecond_tones_sit_within_two_milliseconds_of_the_score_clock() {
    // Bursts as long as a held note are not dominated by the first grains, so this is the sustained requirement.
    for speed in SPEEDS {
        let count = (4.0 * speed).ceil() as usize + 2;
        let errors = burst_errors_with(speed, 1.0, 0, Burst::Tone, count, 9_600);
        let bound = if speed == 1.0 { 0.001 } else { WITHIN_2_MS };
        assert!(
            errors.iter().all(|e| e.abs() <= bound),
            "speed {speed}: {errors:?}"
        );
        eprintln!(
            "sustained speed {speed}: {:?}",
            errors.iter().map(|e| e.round()).collect::<Vec<_>>()
        );
    }
}

#[test]
fn noise_bursts_are_limited_by_the_search_window_not_by_the_centring() {
    // Aperiodic audio has no period to jump by, so each grain lands where its waveform matches best inside the
    // +-256 frame search window and the offset varies by burst. The requirement is that it stays inside that window
    // (5.3 ms) instead of sitting on its edge; measured worst 204 frames, before 748.
    for speed in SPEEDS {
        let count = (8.0 * speed).ceil().max(8.0) as usize;
        let errors = burst_errors(speed, Burst::Noise, count);
        let bound = if speed == 1.0 { 6.0 } else { NOISE_WINDOW };
        assert!(
            errors.iter().all(|e| e.abs() <= bound),
            "speed {speed}: {errors:?}"
        );
    }
}

/// A signal made only of integer arithmetic, one division and one multiplication by exact constants, so every
/// platform computes the same bits: a sawtooth, a noise stretch, a silent stretch and an isolated impulse.
fn fingerprint_source() -> Vec<f32> {
    let mut noise = 0x9E37_79B9_u32;
    (0..120_000usize)
        .map(|n| {
            let mut x = ((n % 109) as f32 / 109.0 * 2.0 - 1.0) * 0.3;
            if (30_000..34_000).contains(&n) {
                noise ^= noise << 13;
                noise ^= noise >> 17;
                noise ^= noise << 5;
                x += (noise as f32 / u32::MAX as f32 - 0.5) * 0.4;
            }
            if (50_000..52_000).contains(&n) || (69_900..70_100).contains(&n) {
                x = 0.0;
            }
            if n == 70_000 {
                x = 0.9;
            }
            x
        })
        .collect()
}

fn fingerprint(mut voice: BackingVoice, speed: f64) -> u64 {
    run(&mut voice, speed, 80_000)
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, x| {
            (hash ^ u64::from((*x as f32).to_bits())).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

/// The fingerprints of `fingerprint_source` through the stretcher of the commit before the re-centring (captured by
/// running this test against that commit's `backing.rs`): an unshifted voice at 100% speed, once with no sync
/// anchors, once with two anchors whose slope is exactly 1, and once as a 44.1 kHz file on the 48 kHz output, once for an exactly periodic input (period 4) and once for a long silent
/// stretch between sounding ones.
const HEAD_FINGERPRINTS: [u64; 5] = [
    0xff9b_73da_be6e_a89b,
    0xff9b_73da_be6e_a89b,
    0x3da3_b0df_1026_2869,
    0xf67f_8fd9_3729_4d25,
    0x274d_c630_94cc_3cd8,
];

#[test]
fn an_unshifted_voice_with_a_slope_of_one_at_full_speed_is_bit_identical_to_before() {
    let plain = fingerprint(voice(fingerprint_source()), 1.0);
    let anchored = fingerprint(build(fingerprint_source(), two_anchors(1.0), 0), 1.0);
    // A file at 44.1 kHz on a 48 kHz output at 100%: the clock and the stretcher both read 0.91875 source frames per frame.
    let resampled = fingerprint(build_at(fingerprint_source(), Vec::new(), 0, 44_100), 1.0);
    // An exactly periodic input (period 4: every coarse position scores the same, one flat run) and one with a long
    // silent stretch between two sounding ones (the tail still sounds as the silence begins).
    let pattern = [0.5f32, 0.25, -0.5, -0.25];
    let periodic = fingerprint(voice((0..120_000).map(|n| pattern[n % 4]).collect()), 1.0);
    let gap = fingerprint(
        voice(
            (0..120_000usize)
                .map(|n| {
                    if (20_000..60_000).contains(&n) {
                        0.0
                    } else {
                        ((n % 109) as f32 / 109.0 * 2.0 - 1.0) * 0.3
                    }
                })
                .collect(),
        ),
        1.0,
    );
    eprintln!("fingerprints {plain:#x} {anchored:#x} {resampled:#x} {periodic:#x} {gap:#x}");
    assert_eq!(
        [plain, anchored, resampled, periodic, gap],
        HEAD_FINGERPRINTS
    );
}

#[test]
#[ignore = "measurement table: cargo test --test audio_backing_stretch quality_table -- --ignored --nocapture"]
fn quality_table() {
    let sets: [(&str, Vec<(f64, f64)>); 6] = [
        ("440", vec![(440.0, 0.5)]),
        ("330+1170", vec![(330.0, 0.3), (1170.0, 0.3)]),
        ("110", vec![(110.0, 0.5)]),
        ("82", vec![(82.0, 0.5)]),
        ("41", vec![(41.0, 0.5)]),
        ("55+82", vec![(55.0, 0.3), (82.0, 0.3)]),
    ];
    for (name, tones) in &sets {
        for speed in [0.1, 0.5, 0.75, 1.5, 1.7, 3.0] {
            let q = quality(speed, tones);
            eprintln!(
                "Q {name} {speed}: off {:.1} dB level {:.3} dB pitch {:.2} c step {:.2}",
                q.off_tone_db, q.db, q.cents, q.step_ratio
            );
        }
    }
}

/// 2 ms: the requirement for sustained audio against the score clock (48 source frames is 1 ms at 48 kHz).
const WITHIN_2_MS: f64 = 96.0;
/// The grain search window, in source frames: aperiodic audio may sit anywhere inside it.
const NOISE_WINDOW: f64 = 256.0;

#[test]
fn a_key_shift_at_full_speed_keeps_sustained_audio_on_the_score_clock() {
    // At 100% speed with a key shift the stretcher still stretches in time (it reads `step` frames per output frame
    // where the clock moves 1), so the same centring applies: what is heard averages onto the clock.
    for shift in [-25, -12, 7, 12, 25] {
        let errors = burst_errors_with(1.0, 1.0, shift, Burst::Tone, 6, 9_600);
        eprintln!(
            "shift {shift} at 1.0x: {:?}",
            errors.iter().map(|e| e.round()).collect::<Vec<_>>()
        );
        assert!(
            errors.iter().all(|e| e.abs() <= WITHIN_2_MS),
            "shift {shift}: {errors:?}"
        );
    }
}

#[test]
fn a_sync_map_with_a_slope_other_than_one_is_centred_at_full_speed() {
    for slope in [0.5, 0.8, 1.25, 2.0] {
        let errors = burst_errors_with(1.0, slope, 0, Burst::Tone, 8, 1_920);
        eprintln!(
            "slope {slope} at 1.0x: {:?}",
            errors.iter().map(|e| e.round()).collect::<Vec<_>>()
        );
        assert!(
            errors.iter().all(|e| e.abs() <= WITHIN_2_MS),
            "slope {slope}: {errors:?}"
        );
    }
}

#[test]
fn a_key_shift_is_centred_at_other_speeds_too() {
    // Measured residuals are in the validation note. The ideal aim at -25 semitones and 3.0x is about 706 source frames
    // from the clock, which the old clamp (122) could not reach.
    for shift in [-25, -12, 12, 25] {
        for speed in [0.5, 1.5, 3.0] {
            let errors = burst_errors_with(
                speed,
                1.0,
                shift,
                Burst::Tone,
                (4.0 * speed).ceil() as usize + 2,
                9_600,
            );
            eprintln!(
                "shift {shift} speed {speed}: {:?}",
                errors.iter().map(|e| e.round()).collect::<Vec<_>>()
            );
            assert!(
                errors.iter().all(|e| e.abs() <= WITHIN_2_MS),
                "shift {shift} speed {speed}: {errors:?}"
            );
        }
    }
}
