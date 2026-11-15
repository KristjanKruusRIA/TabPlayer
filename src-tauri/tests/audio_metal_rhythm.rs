//! The amp's `lowEndOct` setting (THE-217) and that nothing that existed before it changed: every other factory sound, the metal
//! rhythm sound as first released, a driven metal amp and the default chain sound bit for bit as they did on the build before the
//! setting, and the setting only moves the metal preamp. The final Metal rhythm sound is tested in `audio_metal_rhythm_sound.rs`.
//! No recorded audio and no private material: the notes are sums of harmonics with a plucked decay.
use std::f64::consts::TAU;
use tabplayer_lib::audio::{
    dsp::{FxSettings, TrackDsp},
    tone,
};

fn catalog() -> Vec<serde_json::Value> {
    serde_json::from_str(include_str!("../../tests/factory-sounds.json")).unwrap()
}
fn factory(id: &str) -> FxSettings {
    let entry = catalog().into_iter().find(|e| e["id"] == id).unwrap();
    serde_json::from_value(entry["effects"].clone()).unwrap()
}
/// The metal rhythm sound as first released, before THE-217, which a project that copied its settings still holds: a gate, an
/// overdrive pedal and the metal amp into the closed cabinet, every other block off and at its defaults.
fn metal_rhythm_before() -> FxSettings {
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

/// A plucked low note: its first `harmonics` partials fall as 1/h and ring out with `decay` per second, which is the
/// shape of a guitar string tuned low once it reaches an amp.
fn note(
    f0: f64,
    rate: u32,
    seconds: f64,
    peak: f64,
    decay: f64,
    harmonics: usize,
    from: usize,
) -> Vec<f32> {
    (0..(seconds * rate as f64) as usize)
        .map(|n| {
            let t = n as f64 / rate as f64;
            let mut v = 0.0;
            for h in from..=harmonics {
                v += (TAU * f0 * h as f64 * t).sin() / h as f64;
            }
            (v * peak * (-decay * t).exp()) as f32
        })
        .collect()
}
fn run(fx: &FxSettings, rate: u32, input: &[f32]) -> Vec<f32> {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 1.0).unwrap();
    input
        .iter()
        .map(|&x| dsp.process([x; 2], 120.0)[0])
        .collect()
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
/// Energy (not dB) in each of `edges` windows `[lo, hi)` Hz of `signal`, and its total, over the whole signal.
fn bands(signal: &[f32], rate: u32, edges: &[(f64, f64)]) -> (Vec<f64>, f64) {
    let n = 1 << 16;
    let mut re = vec![0.0; n];
    let mut im = vec![0.0; n];
    let len = signal.len().min(n);
    for i in 0..len {
        let w = 0.5 - 0.5 * (TAU * i as f64 / len as f64).cos();
        re[i] = signal[i] as f64 * w;
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
fn db(ratio: f64) -> f64 {
    10.0 * ratio.max(1e-30).log10()
}

fn sustained(f0: f64, rate: u32, peak: f64) -> Vec<f32> {
    note(f0, rate, 1.0, peak, 4.0, 24, 1)
}
const RATES: [u32; 3] = [44_100, 48_000, 96_000];

#[test]
fn a_zero_low_end_is_the_amp_as_it_was_and_the_setting_loads_and_saves_unchanged() {
    for rate in [44_100.0, 48_000.0, 96_000.0, 192_000.0] {
        for model in ["crunch", "lead", "metal", "bassDrive", "clean", "bass"] {
            for drive in [0.0, 0.2, 0.55, 1.0] {
                assert_eq!(
                    tone::amp_shape(model, drive, rate),
                    tone::amp_shape_voiced(model, drive, tone::Voicing::default(), rate),
                    "{model} {drive} {rate}"
                );
            }
        }
    }
    // A saved sound without the key loads with zero and saves without it, so older files are unchanged.
    let old = metal_rhythm_before();
    let json = serde_json::to_value(&old).unwrap();
    assert!(json["amp"].get("lowEndOct").is_none(), "{}", json["amp"]);
    assert_eq!(
        serde_json::from_value::<FxSettings>(json)
            .unwrap()
            .amp
            .low_end_oct,
        0.0
    );
    // The new sound writes it, and reads it back.
    let new = serde_json::to_value(factory("metal-rhythm")).unwrap();
    assert_eq!(new["amp"]["lowEndOct"], 0.5);
    // Out of range is refused.
    for bad in [-0.1, 1.1, f64::NAN] {
        let mut fx = factory("metal-rhythm");
        fx.amp.low_end_oct = bad;
        assert!(fx.validate().is_err(), "{bad}");
    }
    // Where the amp is not driven the setting does nothing.
    let mut clean = FxSettings::default();
    clean.amp.enabled = true;
    let before = run(&clean, 48_000, &sustained(110.0, 48_000, 0.08));
    clean.amp.low_end_oct = 1.0;
    assert_eq!(before, run(&clean, 48_000, &sustained(110.0, 48_000, 0.08)));
}

#[test]
fn a_lower_cut_lets_a_low_fundamental_into_the_stages() {
    // The amp alone, no cabinet and no tone stack: a 41 Hz note at a playing level.
    let rate = 48_000;
    let level = |oct: f64| {
        let mut fx = FxSettings::default();
        fx.amp.enabled = true;
        fx.amp.model = "metal".into();
        fx.amp.drive = 0.2;
        fx.amp.low_end_oct = oct;
        let input: Vec<f32> = (0..rate as usize)
            .map(|n| (TAU * 41.2 * n as f64 / rate as f64).sin() as f32 * 0.03)
            .collect();
        let out = run(&fx, rate, &input);
        let (b, _) = bands(&out[rate as usize / 4..], rate, &[(30.0, 55.0)]);
        db(b[0])
    };
    assert!(
        level(1.0) > level(0.0) + 3.0,
        "41 Hz: {:.1} dB against {:.1} dB",
        level(1.0),
        level(0.0)
    );
    assert!(
        level(1.0) > level(0.5) && level(0.5) > level(0.0),
        "{:.1}, {:.1}, {:.1}",
        level(0.0),
        level(0.5),
        level(1.0)
    );
}

/// What every other factory sound, a driven metal amp with its closed cabinet, the metal rhythm sound as it stood before
/// THE-217 (what a project that copied its settings still holds) and the default chain produced for one second of a decaying
/// low E with eight partials, bit for bit, on the build before THE-217 (`bad9042`: its `tone.rs` and `dsp.rs` were run in a
/// scratch copy of this test, and the values below match what they gave): an FNV-1a hash of every output frame's bits at 44.1
/// and 48 kHz. This is the Windows check, taken on the Windows build of the machine that wrote it; the renderer's `sin`, `exp`
/// and `powf` come from the platform's maths library, so elsewhere the test only checks that every sound is finite. If CI's
/// Windows image rounds differently and a hash here fails with no change in behaviour, the portable test is the authority:
/// `legacy_equivalence` in `tone.rs` compares the amp's circuits with a verbatim copy of the old arithmetic on any platform.
/// Retake these values only from a build that predates a change the test is meant to catch.
const BEFORE: [(&str, u64, u64); 22] = [
    ("jazz-clean", 0xa4736f85702d79df, 0x93cce3dbc9dc6ba3),
    ("funk-clean", 0xf87a86ff813f99f1, 0x2a52b7c71e37c2c1),
    ("chorus-clean", 0x2292a6f20e8e6b82, 0x3a0bc97ad1167409),
    ("country-chime", 0xd5e60b2b3ebdb9b2, 0x4a4054415f5ba665),
    ("surf-tremolo", 0x4fe7ab98c8f2e795, 0x9aee74ed3132b182),
    ("blues-crunch", 0x2ec652eeaf727981, 0xf59edadec2c8aa39),
    ("classic-rock", 0xde785a7a9af86881, 0x9c94189fa6771cab),
    ("phaser-crunch", 0x96689ffaf6412dab, 0x9bf61e4500c4863e),
    ("rock-lead", 0x57558719b05ec08b, 0x92e72dd659548f1b),
    ("fuzz-lead", 0x55399c2f4c389927, 0x402a54711de71797),
    ("octave-lead", 0xb6dbb874f13a9433, 0x696ddb2cca9afe33),
    ("ambient-swell", 0x1fd7099aa8aa1b5c, 0xc82714186fea5a0c),
    ("shimmer", 0xc48defeb3d78e927, 0x5597b5e6dbf01b19),
    ("acoustic-room", 0x65ee4cc77a5ef0db, 0x113627a633703fe7),
    ("acoustic-close", 0x18d09ba98359b15a, 0x9511673362aeff00),
    ("finger-bass", 0xcff06f1da13ffcf1, 0x0061bd5e0d6ae9c9),
    ("slap-bass", 0xf7060852861d2151, 0x0b9d07eccee05ba7),
    ("driven-bass", 0x098e71df40691ad1, 0xe8bb161f62a713eb),
    ("octave-bass", 0xfeddd796391b8869, 0x4e27da00901e44bf),
    ("metal-amp-cab", 0x1f25efa791c47dd7, 0x81e5a26441fdaf5d),
    (
        "metal-rhythm-before",
        0xf13728a1ef948023,
        0xe44a5c6ee5d750bf,
    ),
    ("default", 0x1b8a40c4c49f0719, 0x89f1fe27920be4a7),
];
fn probe(rate: u32) -> Vec<f32> {
    (0..rate as usize)
        .map(|n| {
            let t = n as f64 / rate as f64;
            let mut v = 0.0;
            for h in 1..=8 {
                v += (TAU * 82.4 * h as f64 * t).sin() / h as f64;
            }
            (v * 0.12 * (-3.0 * t).exp()) as f32
        })
        .collect()
}
fn fingerprint(fx: &FxSettings, rate: u32) -> (u64, bool) {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 1.0).unwrap();
    let (mut hash, mut finite) = (0xcbf29ce484222325u64, true);
    for x in probe(rate) {
        for v in dsp.process([x; 2], 120.0) {
            finite &= v.is_finite();
            hash = (hash ^ v.to_bits() as u64).wrapping_mul(0x100000001b3);
        }
    }
    (hash, finite)
}
#[test]
fn every_other_factory_sound_and_the_default_chain_sound_exactly_as_before() {
    let catalog = catalog();
    let mut metal_amp = FxSettings::default();
    metal_amp.amp.enabled = true;
    metal_amp.amp.model = "metal".into();
    metal_amp.amp.drive = 0.8;
    metal_amp.cabinet.enabled = true;
    metal_amp.cabinet.model = "closed".into();
    for (id, at_44, at_48) in BEFORE {
        let fx = match id {
            "default" => FxSettings::default(),
            "metal-amp-cab" => metal_amp.clone(),
            "metal-rhythm-before" => metal_rhythm_before(),
            _ => serde_json::from_value(
                catalog
                    .iter()
                    .find(|e| e["id"] == id)
                    .unwrap_or_else(|| panic!("{id}"))["effects"]
                    .clone(),
            )
            .unwrap(),
        };
        for (rate, expected) in [(44_100, at_44), (48_000, at_48)] {
            let (hash, finite) = fingerprint(&fx, rate);
            assert!(finite, "{id} at {rate}");
            if cfg!(windows) {
                assert_eq!(hash, expected, "{id} at {rate}: {hash:#018x}");
            }
        }
    }
    // The factory sounds the table holds are every one but the metal rhythm.
    assert_eq!(catalog.len() - 1 + 3, BEFORE.len());
}

/// 60-250 Hz energy (dB) of the amp alone, no cabinet and no tone stack, on a low note with a second partial and an attack,
/// at the given `lowEndOct`, for `model`.
fn low_band(model: &str, drive: f64, oct: f64, rate: u32, level: f32) -> f64 {
    let mut fx = FxSettings::default();
    fx.amp.enabled = true;
    fx.amp.model = model.into();
    fx.amp.drive = drive;
    fx.amp.low_end_oct = oct;
    let input: Vec<f32> = (0..rate as usize)
        .map(|n| {
            let t = n as f64 / rate as f64;
            level
                * ((TAU * 49.0 * t).sin() * 0.04
                    + (TAU * 98.0 * t).sin() * 0.02
                    + (TAU * 147.0 * t).sin() * 0.01) as f32
                * (-2.0 * t).exp() as f32
        })
        .collect();
    let out = run(&fx, rate, &input);
    let (b, _) = bands(&out[rate as usize / 10..], rate, &[(60.0, 250.0)]);
    db(b[0])
}

#[test]
fn raising_low_end_never_thins_the_lows_of_the_amp_that_shows_it() {
    // The metal preamp is the one amp whose panel shows the setting (0 to 1 octave). Its low band does not fall as the setting
    // rises (to within 0.25 dB where a fully driven amp has nothing left to give), at any drive and at three playing levels.
    for rate in RATES {
        for drive in [0.0, 0.2, 0.55, 0.8, 1.0] {
            for level in [0.25, 1.0, 2.0] {
                let levels: Vec<f64> = [0.0, 0.25, 0.5, 0.75, 1.0]
                    .iter()
                    .map(|&o| low_band("metal", drive, o, rate, level))
                    .collect();
                for pair in levels.windows(2) {
                    assert!(
                        pair[1] >= pair[0] - 0.25,
                        "metal drive {drive} level {level} at {rate}: 60-250 Hz {levels:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn the_other_amps_ignore_the_setting() {
    // Crunch and lead thin the lows of a held note when it is raised past an octave, the bass drive's path around its stages is
    // tuned against its cuts (on a riff it did not cancel: +2.4 dB over two octaves, so this is a choice), and clean and bass
    // have no stages: a stored value changes nothing there.
    for rate in RATES {
        for model in ["crunch", "lead", "bassDrive", "clean", "bass"] {
            for drive in [0.2, 0.55] {
                let base = low_band(model, drive, 0.0, rate, 1.0);
                for oct in [0.5, 1.0] {
                    assert_eq!(
                        base,
                        low_band(model, drive, oct, rate, 1.0),
                        "{model} {drive} {oct} {rate}"
                    );
                }
            }
        }
    }
}
