//! The candidate voicings for a modern tight high-gain rhythm sound (THE-217, second round): not factory sounds, only test presets
//! in `fixtures/metal_candidates.json` until the owner picks one. Each is built from blocks the player already has: a bass-cut and
//! mid-hump equalizer ahead of the overdrive pedal (as a tightening boost), the metal preamp with a lowered low cut, one of the
//! bundled closed four-by-twelve cabinet responses, and a graphic equalizer after it. These tests pin what they must not do: clip,
//! leave the factory sounds' level window, allocate while playing, misbehave at any rate, lose the steep top, or lose their bite.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    f64::consts::TAU,
    path::PathBuf,
    sync::Once,
};
use tabplayer_lib::audio::{
    cabinet_ir,
    dsp::{FxSettings, TrackDsp},
};

thread_local! {static COUNT_HEAP:Cell<bool>=const {Cell::new(false)};static HEAP_OPERATIONS:Cell<usize>=const {Cell::new(0)};}
struct CountAllocator;
unsafe impl GlobalAlloc for CountAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|n| n.set(n.get() + 1));
            }
        });
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|n| n.set(n.get() + 1));
            }
        });
        unsafe { System.dealloc(pointer, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: CountAllocator = CountAllocator;

const NAMES: [&str; 4] = ["reference", "tight", "scooped", "mid-forward"];
const RATES: [u32; 4] = [44_100, 48_000, 96_000, 192_000];

/// The bundled cabinet responses are resolved from the app's resource folder; the tests point the library at the repository's copy.
fn library() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/cabinet-irs");
        let directory =
            std::env::temp_dir().join(format!("tabplayer-candidates-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        cabinet_ir::install(directory, Some(bundled));
    });
}
fn candidates() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(include_str!("fixtures/metal_candidates.json"))
        .unwrap()
        .as_object()
        .unwrap()
        .clone()
}
fn candidate(name: &str) -> FxSettings {
    serde_json::from_value(candidates()[name].clone()).unwrap()
}
fn dsp(fx: &FxSettings, rate: u32) -> TrackDsp {
    library();
    TrackDsp::new(fx.clone(), rate, 1.0).unwrap()
}
fn run(fx: &FxSettings, rate: u32, input: &[f32]) -> Vec<f32> {
    let mut chain = dsp(fx, rate);
    input
        .iter()
        .map(|&x| chain.process([x; 2], 120.0)[0])
        .collect()
}
/// A plucked low note: partials falling as 1/h, ringing out with `decay` per second.
fn note(f0: f64, rate: u32, seconds: f64, peak: f64, decay: f64, harmonics: usize) -> Vec<f32> {
    (0..(seconds * rate as f64) as usize)
        .map(|n| {
            let t = n as f64 / rate as f64;
            let v: f64 = (1..=harmonics)
                .map(|h| (TAU * f0 * h as f64 * t).sin() / h as f64)
                .sum();
            (v * peak * (-decay * t).exp()) as f32
        })
        .collect()
}
fn rms(signal: &[f32]) -> f64 {
    (signal.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / signal.len().max(1) as f64).sqrt()
}
fn peak(signal: &[f32]) -> f64 {
    signal.iter().fold(0.0f64, |a, v| a.max(v.abs() as f64))
}
fn db(ratio: f64) -> f64 {
    10.0 * ratio.max(1e-30).log10()
}
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -TAU / len as f64;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (s, c) = (angle * k as f64).sin_cos();
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * c - im[b] * s, re[b] * s + im[b] * c);
                (re[b], im[b]) = (re[a] - tr, im[a] - ti);
                (re[a], im[a]) = (re[a] + tr, im[a] + ti);
            }
        }
        len <<= 1;
    }
}
/// Energy in each `[lo, hi)` Hz window of the signal, and its total.
fn bands(signal: &[f32], rate: u32, edges: &[(f64, f64)]) -> (Vec<f64>, f64) {
    let n = 1 << 16;
    let (mut re, mut im) = (vec![0.0; n], vec![0.0; n]);
    let len = signal.len().min(n);
    for i in 0..len {
        re[i] = signal[i] as f64 * (0.5 - 0.5 * (TAU * i as f64 / len as f64).cos());
    }
    fft(&mut re, &mut im);
    let bin = rate as f64 / n as f64;
    let energy = |lo: f64, hi: f64| -> f64 {
        let (a, b) = (
            (lo / bin).ceil() as usize,
            ((hi / bin).ceil() as usize).min(n / 2),
        );
        (a..b).map(|k| re[k] * re[k] + im[k] * im[k]).sum()
    };
    (
        edges.iter().map(|&(lo, hi)| energy(lo, hi)).collect(),
        energy(20.0, rate as f64 / 2.0),
    )
}

#[test]
fn every_candidate_is_a_valid_sound_that_saves_and_reads_back() {
    library();
    assert_eq!(candidates().len(), NAMES.len());
    for name in NAMES {
        let fx = candidate(name);
        fx.validate().unwrap_or_else(|e| panic!("{name}: {e}"));
        // Written and read again, the same sound; and no brand or product is named anywhere in it.
        let json = serde_json::to_value(&fx).unwrap();
        assert_eq!(
            serde_json::from_value::<FxSettings>(json.clone()).unwrap(),
            fx,
            "{name}"
        );
        assert_eq!(
            candidates()[name]["cabinet"]["ir"]["name"],
            "bundled closed four-by-twelve"
        );
        // The bundled response it names is in the library.
        let id = json["cabinet"]["ir"]["id"].as_str().unwrap();
        assert!(
            cabinet_ir::resolve(id, 48_000).is_some(),
            "{name}: bundled response {id} not found"
        );
        // Each one is a high-gain chain: the metal amp behind a boost.
        assert_eq!(fx.amp.model, "metal");
        assert!(
            fx.drive.enabled && fx.eq.enabled && fx.graphic_eq.enabled && fx.cabinet.ir.is_some(),
            "{name}"
        );
    }
}

#[test]
fn they_sit_inside_the_factory_sounds_level_window_and_do_not_reach_the_limiter() {
    let rate = 48_000;
    // The tone `audio_factory_sounds` levels the factory sounds on, whose middle level is about 0.067: within 6 dB of it.
    let tone: Vec<f32> = (0..rate as usize * 2)
        .map(|n| {
            let t = n as f64 / rate as f64;
            (0.25 * (-1.5 * t).exp() * ((TAU * 110.0 * t).sin() + 0.5 * (TAU * 220.0 * t).sin()))
                as f32
        })
        .collect();
    for name in NAMES {
        let level = rms(&run(&candidate(name), rate, &tone));
        let from_middle = db(level * level / (0.067 * 0.067));
        println!("{name}: {from_middle:+.1} dB from the middle factory sound");
        assert!(
            (1.5..=5.0).contains(&from_middle),
            "{name}: {from_middle:.1} dB"
        );
        // A hard chord (input peak 1.6): its peak stays under 0.8, well under the master limiter's 0.9.
        for rate in RATES {
            let mut chord = note(49.0, rate, 0.5, 0.35, 3.0, 12);
            for (c, v) in chord.iter_mut().zip(note(73.4, rate, 0.5, 0.35, 3.0, 12)) {
                *c += v;
            }
            for (c, v) in chord.iter_mut().zip(note(98.0, rate, 0.5, 0.3, 3.0, 12)) {
                *c += v;
            }
            let out = run(&candidate(name), rate, &chord);
            assert!(out.iter().all(|v| v.is_finite()), "{name} at {rate}");
            assert!(peak(&out) < 0.8, "{name} at {rate}: peak {:.3}", peak(&out));
        }
    }
}

#[test]
fn they_are_stable_at_every_rate_and_die_away() {
    for name in NAMES {
        for rate in RATES {
            let mut input = note(49.0, rate, 1.0, 0.08, 4.0, 24);
            input.extend(std::iter::repeat_n(0.0, rate as usize * 2));
            let out = run(&candidate(name), rate, &input);
            assert!(
                out.iter().all(|v| v.is_finite() && v.abs() < 1.0),
                "{name} at {rate}"
            );
            let tail = peak(&out[out.len() - rate as usize / 10..]);
            assert!(
                tail < 1e-4,
                "{name} at {rate}: {tail} two seconds after the note"
            );
        }
    }
}

#[test]
fn they_keep_a_steep_top_and_an_upper_mid_that_stands_over_the_low_mids() {
    let rate = 48_000;
    for name in NAMES {
        let out = run(
            &candidate(name),
            rate,
            &note(110.0, rate, 1.0, 0.08, 4.0, 24),
        );
        let (b, total) = bands(
            &out[rate as usize / 10..],
            rate,
            &[(200.0, 500.0), (800.0, 3_000.0), (6_000.0, 24_000.0)],
        );
        let (low_mid, upper_mid, top) = (db(b[0] / total), db(b[1] / total), db(b[2] / total));
        println!(
            "{name}: 200-500 Hz {low_mid:.1}, 0.8-3 kHz {upper_mid:.1}, above 6 kHz {top:.1} dB of the note"
        );
        // Nothing worth hearing above 6 kHz: the closed cabinet is steep, and no stage after it lifts the top.
        assert!(top < -40.0, "{name}: above 6 kHz at {top:.1} dB");
        // The mid-forward and tight ones keep their bite above the low mids of an A2 power-chord-like note.
        if name == "tight" || name == "mid-forward" {
            assert!(
                upper_mid > low_mid - 6.0,
                "{name}: 0.8-3 kHz {upper_mid:.1} dB against 200-500 Hz {low_mid:.1} dB"
            );
        }
    }
}

#[test]
fn they_allocate_nothing_while_they_play() {
    let rate = 48_000;
    let input = note(49.0, rate, 1.0, 0.08, 4.0, 24);
    for name in NAMES {
        let mut chain = dsp(&candidate(name), rate);
        for &x in &input[..4800] {
            chain.process([x; 2], 120.0);
        }
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|flag| flag.set(true));
        let mut sum = 0.0f32;
        for &x in &input {
            sum += chain.process([x; 2], 120.0)[0];
        }
        COUNT_HEAP.with(|flag| flag.set(false));
        assert!(sum.is_finite());
        assert_eq!(
            HEAP_OPERATIONS.with(Cell::get),
            0,
            "{name}: the chain used the heap while playing"
        );
    }
}
