//! The final Metal rhythm factory sound (THE-217): the chain the owner picked by ear (clips "5d"), which stands the EQ with a bass cut and
//! a mid hump ahead of an overdrive pedal at minimum drive, drives the metal amp with a lowered low cut, plays through one of the
//! closed four-by-twelve responses the app bundles, and shapes the top with the graphic EQ. These tests pin that it is exactly the
//! chosen preset, and what it must not do: clip, leave the factory sounds' level window, allocate while playing or while it is chosen
//! during playback, misbehave at any rate, lose the steep top, or lose its bite.
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

const RATES: [u32; 4] = [44_100, 48_000, 96_000, 192_000];

/// The bundled cabinet responses are resolved from the app's resource folder; the tests point the library at the repository's copy.
fn library() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/cabinet-irs");
        // A folder under the build's own test scratch space that nothing creates: the bundled responses are all this library serves.
        let directory = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("metal-rhythm-library");
        cabinet_ir::install(directory, Some(bundled));
    });
}
/// The Metal rhythm sound as the editor's catalog holds it.
fn factory() -> FxSettings {
    let catalog: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/factory-sounds.json")).unwrap();
    let entry = catalog
        .into_iter()
        .find(|e| e["id"] == "metal-rhythm")
        .unwrap();
    serde_json::from_value(entry["effects"].clone()).unwrap()
}
/// The preset as rendered for the owner's clips (not a factory sound: a test fixture).
fn preset() -> FxSettings {
    serde_json::from_str(include_str!("fixtures/metal_rhythm_preset.json")).unwrap()
}
/// The sound as first released: a gate, an overdrive pedal and the metal amp into the closed cabinet.
fn released() -> FxSettings {
    let mut fx = FxSettings::default();
    fx.gate.enabled = true;
    fx.gate.threshold_db = -50.0;
    fx.gate.release_ms = 60.0;
    fx.drive.enabled = true;
    fx.drive.model = "overdrive".into();
    fx.drive.drive = 0.2;
    fx.drive.tone = 0.6;
    fx.amp.enabled = true;
    fx.amp.model = "metal".into();
    fx.amp.drive = 0.55;
    fx.amp.gain_db = -2.0;
    fx.cabinet.enabled = true;
    fx.cabinet.model = "closed".into();
    fx
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
fn factory_tone() -> Vec<f32> {
    let rate = 48_000;
    (0..rate as usize * 2)
        .map(|n| {
            let t = n as f64 / rate as f64;
            (0.25 * (-1.5 * t).exp() * ((TAU * 110.0 * t).sin() + 0.5 * (TAU * 220.0 * t).sin()))
                as f32
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
fn the_factory_sound_is_the_chosen_preset_and_renders_the_same_bits() {
    library();
    let (sound, chosen) = (factory(), preset());
    assert_eq!(
        sound, chosen,
        "the catalog's Metal rhythm is the preset the owner picked"
    );
    sound.validate().unwrap();
    // Written and read again, the same sound; the bundled response is named only by its identity and a neutral label.
    let json = serde_json::to_value(&sound).unwrap();
    assert_eq!(
        serde_json::from_value::<FxSettings>(json.clone()).unwrap(),
        sound
    );
    assert_eq!(
        json["cabinet"]["ir"]["name"],
        "bundled closed four-by-twelve"
    );
    assert!(
        cabinet_ir::resolve(json["cabinet"]["ir"]["id"].as_str().unwrap(), 48_000).is_some(),
        "the bundled response is in the library"
    );
    // The boost stands ahead of the pedal and amp, in the sound's own order.
    let order: Vec<&str> = json["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let at = |name: &str| order.iter().position(|b| *b == name).unwrap();
    assert!(
        at("eq") < at("drive")
            && at("drive") < at("amp")
            && at("amp") < at("cabinet")
            && at("cabinet") < at("graphicEq")
    );
    // What each plays, frame by frame, for a second of a low riff through the real chain, compared as bits, at two rates.
    for rate in [44_100, 48_000] {
        let input = note(49.0, rate, 1.0, 0.12, 3.0, 12);
        let (a, b) = (run(&sound, rate, &input), run(&chosen, rate, &input));
        assert!(
            a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()),
            "{rate}: the render differs from the preset's"
        );
        assert!(peak(&a) > 0.01, "{rate}: and it sounds");
    }
}

#[test]
fn it_sits_inside_the_factory_sounds_level_window_and_the_jump_from_the_released_one_is_known() {
    // The tone `audio_factory_sounds` levels the factory sounds on, whose middle level is about 0.067: within 6 dB of it.
    let tone = factory_tone();
    let level = |fx: &FxSettings| rms(&run(fx, 48_000, &tone));
    let (now, was) = (level(&factory()), level(&released()));
    let from_middle = db(now * now / (0.067 * 0.067));
    let jump = db(now * now / (was * was));
    println!(
        "Metal rhythm {from_middle:+.1} dB from the middle factory sound; {jump:+.1} dB from the released one"
    );
    assert!((1.5..=5.0).contains(&from_middle), "{from_middle:.1} dB");
    assert!(jump.abs() < 3.0, "picking it again jumps {jump:.1} dB");
}

#[test]
fn a_hard_chord_stays_under_the_master_limiter_at_every_rate() {
    for rate in RATES {
        let mut chord = note(49.0, rate, 0.5, 0.35, 3.0, 12);
        for (c, v) in chord.iter_mut().zip(note(73.4, rate, 0.5, 0.35, 3.0, 12)) {
            *c += v;
        }
        for (c, v) in chord.iter_mut().zip(note(98.0, rate, 0.5, 0.3, 3.0, 12)) {
            *c += v;
        }
        let out = run(&factory(), rate, &chord);
        assert!(out.iter().all(|v| v.is_finite()), "{rate}");
        assert!(
            peak(&out) < 0.8,
            "{rate}: peak {:.3} approaches the limiter at 0.9",
            peak(&out)
        );
    }
}

#[test]
fn it_is_stable_at_every_rate_and_dies_away() {
    for rate in RATES {
        let mut input = note(49.0, rate, 1.0, 0.08, 4.0, 24);
        input.extend(std::iter::repeat_n(0.0, rate as usize * 2));
        let out = run(&factory(), rate, &input);
        assert!(out.iter().all(|v| v.is_finite() && v.abs() < 1.0), "{rate}");
        let tail = peak(&out[out.len() - rate as usize / 10..]);
        assert!(tail < 1e-4, "{rate}: {tail} two seconds after the note");
    }
}

#[test]
fn it_keeps_a_steep_top_and_an_upper_mid_that_stands_over_the_low_mids() {
    let rate = 48_000;
    let out = run(&factory(), rate, &note(110.0, rate, 1.0, 0.08, 4.0, 24));
    let (b, total) = bands(
        &out[rate as usize / 10..],
        rate,
        &[(200.0, 500.0), (800.0, 3_000.0), (6_000.0, 24_000.0)],
    );
    let (low_mid, upper_mid, top) = (db(b[0] / total), db(b[1] / total), db(b[2] / total));
    println!(
        "200-500 Hz {low_mid:.1}, 0.8-3 kHz {upper_mid:.1}, above 6 kHz {top:.1} dB of the note"
    );
    // Nothing worth hearing above 6 kHz: the closed cabinet is steep, and no stage after it lifts the top.
    assert!(top < -35.0, "above 6 kHz at {top:.1} dB");
    // The bite: the upper mids are as strong as the low mids of an A2 note.
    assert!(
        upper_mid > low_mid - 2.0,
        "0.8-3 kHz {upper_mid:.1} dB against 200-500 Hz {low_mid:.1} dB"
    );
}

#[test]
fn a_missing_cabinet_response_plays_the_closed_cabinet_instead() {
    // The same sound on a machine whose library lacks the response: it names an identity nothing holds.
    let mut fx = factory();
    fx.cabinet.ir.as_mut().unwrap().id = "0".repeat(32);
    let rate = 48_000;
    let out = run(&fx, rate, &note(49.0, rate, 1.0, 0.08, 4.0, 24));
    assert!(out.iter().all(|v| v.is_finite()) && peak(&out) > 0.01 && peak(&out) < 0.8);
}

#[test]
fn it_allocates_nothing_while_it_plays() {
    let rate = 48_000;
    let input = note(49.0, rate, 1.0, 0.08, 4.0, 24);
    let mut chain = dsp(&factory(), rate);
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
        "the chain used the heap while playing"
    );
}

#[test]
fn choosing_it_while_another_sound_plays_allocates_nothing_on_the_audio_thread() {
    // The new sound, with its cabinet response, is built and its response loaded off the audio thread (as the renderer's mix
    // preparation does); the audio thread then only takes over from the running chain and plays. Counting starts at the take-over.
    for rate in RATES {
        for from in [released(), FxSettings::default()] {
            let mut running = dsp(&from, rate);
            let mut next = dsp(&factory(), rate);
            let input = note(49.0, rate, 1.0, 0.08, 4.0, 24);
            for &x in &input[..rate as usize / 10] {
                running.process([x; 2], 120.0);
            }
            HEAP_OPERATIONS.with(|n| n.set(0));
            COUNT_HEAP.with(|flag| flag.set(true));
            next.transition_from(&mut running);
            let mut sum = 0.0f32;
            for &x in &input[rate as usize / 10..] {
                sum += next.process([x; 2], 120.0)[0];
            }
            COUNT_HEAP.with(|flag| flag.set(false));
            assert!(sum.is_finite());
            assert_eq!(
                HEAP_OPERATIONS.with(Cell::get),
                0,
                "{rate}: choosing the sound used the heap on the audio thread"
            );
        }
    }
}
