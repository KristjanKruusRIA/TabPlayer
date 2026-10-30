//! The driven tones' measurable properties: the cabinets' shape, a low chord's intermodulation and a high note's aliases
//! against the single-stage path they replaced, level, real-time safety and click-free changes.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    f64::consts::TAU,
};
use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

#[allow(dead_code)]
#[path = "../examples/tone_ab/measure.rs"]
mod measure;

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

const RATES: [u32; 2] = [44_100, 48_000];

fn amp(model: &str, drive: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.amp.enabled = true;
    fx.amp.model = model.into();
    fx.amp.drive = drive;
    fx
}
fn pedal(mut fx: FxSettings, model: &str, drive: f64) -> FxSettings {
    fx.drive.enabled = true;
    fx.drive.model = model.into();
    fx.drive.drive = drive;
    fx
}
fn cabinet(mut fx: FxSettings, model: &str) -> FxSettings {
    fx.cabinet.enabled = true;
    fx.cabinet.model = model.into();
    fx
}
fn chain(fx: &FxSettings, rate: u32) -> impl FnMut(f32) -> f32 {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 1.0).unwrap();
    move |x| dsp.process([x; 2], 120.0)[0]
}
fn sine(hz: f64, rate: u32, peak: f64) -> impl Fn(usize) -> f32 {
    move |n| ((TAU * hz * n as f64 / rate as f64).sin() * peak) as f32
}
/// A steady output's level, over the half second after a quarter second of settling.
fn level(mut chain: impl FnMut(f32) -> f32, hz: f64, rate: u32, peak: f64) -> f64 {
    let tone = sine(hz, rate, peak);
    let (skip, frames) = (rate as usize / 4, rate as usize / 2);
    let mut sum = 0.0;
    for n in 0..skip + frames {
        let y = chain(tone(n)) as f64;
        if n >= skip {
            sum += y * y;
        }
    }
    (sum / frames as f64).sqrt()
}
fn db(value: f64) -> f64 {
    20.0 * value.max(1e-12).log10()
}
/// A cabinet's gain at `hz` in dB against its gain at 1 kHz, the amp and everything else off.
fn response(model: &str, rate: u32, hz: f64) -> f64 {
    let fx = cabinet(FxSettings::default(), model);
    let at = |hz: f64| db(level(chain(&fx, rate), hz, rate, 0.1) / 0.1 * std::f64::consts::SQRT_2);
    at(hz) - at(1_000.0)
}

/// The original amp and closed cabinet, as they stood before the driven chain: one bias-shifted tanh, oversampled four
/// times by linear interpolation, and three biquads. The two sounds it served are measured against it.
struct SingleStage {
    pre: f64,
    post: f64,
    bias: f64,
    previous: f64,
    anti: [f64; 3],
    dc: f64,
    cabinet: [([f64; 3], [f64; 2], [f64; 2]); 3],
}
impl SingleStage {
    fn new(model: &str, drive: f64) -> Self {
        let (pre, post, bias) = if model == "lead" {
            let pre = 1.0 + 600.0 * drive.powf(1.1);
            (pre, 0.11 / (0.11 * pre).tanh(), 0.04 * drive)
        } else {
            let pre = 1.0 + 220.0 * drive.powf(1.2);
            (pre, 0.10 / (0.10 * pre).tanh(), 0.08 * drive)
        };
        let design = |hz: f64, high: bool| {
            let w = TAU * hz / 48_000.0;
            let (c, alpha) = (w.cos(), w.sin() / std::f64::consts::SQRT_2);
            let b = if high {
                [(1.0 + c) / 2.0, -1.0 - c, (1.0 + c) / 2.0]
            } else {
                [(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0]
            };
            let a0 = 1.0 + alpha;
            (
                b.map(|v| v / a0),
                [-2.0 * c / a0, (1.0 - alpha) / a0],
                [0.0; 2],
            )
        };
        Self {
            pre,
            post,
            bias,
            previous: 0.0,
            anti: [0.0; 3],
            dc: 0.0,
            cabinet: [
                design(90.0, true),
                design(4_200.0, false),
                design(4_200.0, false),
            ],
        }
    }
    fn run(&mut self, x: f32) -> f32 {
        let v = x as f64;
        let zero = self.bias.tanh();
        let filter = 1.0 - (-TAU * 0.22 / 4.0).exp();
        let mut sum = 0.0;
        for step in 1..=4 {
            let input = self.previous + (v - self.previous) * step as f64 / 4.0;
            let mut sample = ((input * self.pre + self.bias).tanh() - zero) * self.post;
            for state in &mut self.anti {
                *state += filter * (sample - *state);
                sample = *state;
            }
            sum += sample;
        }
        self.previous = v;
        let clipped = sum / 4.0;
        self.dc += 0.0005 * (clipped - self.dc);
        let mut y = clipped - self.dc;
        for (b, a, z) in &mut self.cabinet {
            let out = b[0] * y + z[0];
            z[0] = b[1] * y - a[0] * out + z[1];
            z[1] = b[2] * y - a[1] * out;
            y = out;
        }
        y as f32
    }
}

#[test]
fn the_guitar_cabinets_are_tight_below_and_fall_steeply_above() {
    for rate in RATES {
        for model in ["closed", "combo"] {
            let at = |hz: f64| response(model, rate, hz);
            // Tight: the low strings' fundamentals survive, and what lies below the guitar does not.
            assert!(at(45.0) < -18.0, "{model} at 45 Hz: {}", at(45.0));
            assert!(at(60.0) < -8.0, "{model} at 60 Hz: {}", at(60.0));
            assert!(at(82.0) > -7.0, "{model} at 82 Hz: {}", at(82.0));
            // The close microphone's low-mid body, and the presence rise between 2 and 4 kHz.
            assert!(at(220.0) > 1.0, "{model} at 220 Hz: {}", at(220.0));
            let presence = [2_400.0, 2_800.0, 3_200.0, 3_600.0]
                .map(at)
                .into_iter()
                .fold(f64::MIN, f64::max);
            assert!(
                (0.5..7.0).contains(&presence),
                "{model} presence {presence}"
            );
            // The cone gives out quickly, faster than the 24 dB an octave of the filters it replaced.
            let fall = (at(5_000.0) - at(8_000.0)) / (8.0f64 / 5.0).log2();
            assert!(fall > 28.0, "{model} falls {fall} dB an octave");
            assert!(at(8_000.0) < -16.0, "{model} at 8 kHz: {}", at(8_000.0));
            assert!(at(12_000.0) < -28.0, "{model} at 12 kHz: {}", at(12_000.0));
        }
    }
}

#[test]
fn the_bass_stack_keeps_its_lows_and_ends_early() {
    for rate in RATES {
        let at = |hz: f64| response("bassStack", rate, hz);
        assert!(
            at(41.0) > at(150.0) - 10.0,
            "low E: {} {}",
            at(41.0),
            at(150.0)
        );
        assert!(
            at(30.0) < at(70.0) - 4.0,
            "below the bass: {} {}",
            at(30.0),
            at(70.0)
        );
        assert!(at(6_000.0) < -24.0, "at 6 kHz: {}", at(6_000.0));
    }
}

#[test]
fn the_cabinets_sound_alike_at_both_rates() {
    for model in ["closed", "combo", "bassStack"] {
        for hz in [60.0, 110.0, 440.0, 2_500.0, 5_000.0] {
            let difference = response(model, 44_100, hz) - response(model, 48_000, hz);
            assert!(
                difference.abs() < 1.5,
                "{model} at {hz} Hz differs by {difference}"
            );
        }
    }
}

#[test]
fn a_low_chord_intermodulates_less_than_through_a_single_stage() {
    for (model, compared) in [("crunch", "crunch"), ("lead", "lead"), ("metal", "lead")] {
        for peak in [0.08, 0.25] {
            let fx = cabinet(amp(model, 0.8), "closed");
            let new = measure::intermod_db(chain(&fx, 48_000), 48_000.0, peak);
            let mut single = SingleStage::new(compared, 0.8);
            let old = measure::intermod_db(|x| single.run(x), 48_000.0, peak);
            println!("{model} {peak}: {new:.1} dB, old {old:.1}");
            assert!(
                new < old - 2.0,
                "{model} at {peak}: {new} dB against {old} dB"
            );
        }
    }
}

#[test]
fn a_high_note_at_high_gain_keeps_its_aliases_down() {
    let (mut single, hz) = (SingleStage::new("lead", 0.9), 2_637.02);
    let old = measure::alias_db(|x| single.run(x), 48_000.0, hz, 0.1);
    for rate in RATES {
        for hz in [1_318.51, 2_637.02] {
            for fx in [
                cabinet(amp("metal", 0.9), "closed"),
                cabinet(amp("lead", 0.9), "closed"),
                cabinet(pedal(amp("metal", 0.8), "overdrive", 0.5), "closed"),
                cabinet(pedal(amp("crunch", 0.3), "fuzz", 0.8), "closed"),
                cabinet(pedal(FxSettings::default(), "distortion", 0.9), "closed"),
            ] {
                let new = measure::alias_db(chain(&fx, rate), rate as f64, hz, 0.1);
                println!(
                    "{} {} {rate} {hz}: {new:.1} dB, old {old:.1}",
                    fx.amp.model, fx.drive.model
                );
                assert!(
                    new < -55.0,
                    "{} {} at {rate}: {new} dB",
                    fx.amp.model,
                    fx.drive.model
                );
                assert!(new < old - 12.0, "{} against {old} dB", new);
            }
        }
    }
}

#[test]
fn high_gain_holds_its_level_and_is_mostly_odd() {
    let fx = cabinet(amp("metal", 0.8), "closed");
    let levels: Vec<f64> = [0.002, 0.008, 0.03, 0.1, 0.25, 0.5]
        .map(|peak| db(level(chain(&fx, 48_000), 220.0, 48_000, peak)))
        .to_vec();
    let (low, high) = levels
        .iter()
        .fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
    assert!(
        high - low < 2.0,
        "the level moves {} dB: {levels:?}",
        high - low
    );
    let mut run = chain(&fx, 48_000);
    let tone = sine(220.0, 48_000, 0.1);
    let output: Vec<f64> = (0..96_000).map(|n| run(tone(n)) as f64).collect();
    let tail = &output[48_000..];
    let line = |hz: f64| {
        let (mut re, mut im) = (0.0, 0.0);
        for (n, y) in tail.iter().enumerate() {
            let w = 0.5 - 0.5 * (TAU * n as f64 / tail.len() as f64).cos();
            let phase = TAU * hz * n as f64 / 48_000.0;
            re += y * w * phase.cos();
            im += y * w * phase.sin();
        }
        (re * re + im * im).sqrt()
    };
    let first = line(220.0);
    let (second, third) = (db(line(440.0) / first), db(line(660.0) / first));
    assert!((-20.0..-12.0).contains(&third), "third harmonic {third} dB");
    assert!(
        second < third - 10.0,
        "second harmonic {second} dB against {third} dB"
    );
}

#[test]
fn the_driven_amps_leave_at_one_level_at_any_gain_and_rate() {
    for model in ["crunch", "lead", "metal", "bassDrive"] {
        for drive in [0.2, 0.5, 0.8, 1.0] {
            for rate in [44_100, 48_000, 96_000, 192_000] {
                let out = db(level(chain(&amp(model, drive), rate), 220.0, rate, 0.1));
                assert!(
                    (out - db(0.078)).abs() < 0.7,
                    "{model} {drive} at {rate}: {out} dB"
                );
            }
        }
    }
}

#[test]
fn every_model_name_stays_valid_and_an_unknown_one_is_refused() {
    let mut fx = amp("clean", 0.5);
    for model in ["clean", "crunch", "lead", "metal", "bass", "bassDrive"] {
        fx.amp.model = model.into();
        TrackDsp::new(fx.clone(), 48_000, 1.0).unwrap();
    }
    fx.amp.model = "nope".into();
    assert!(TrackDsp::new(fx, 48_000, 1.0).is_err());
    let mut fx = cabinet(FxSettings::default(), "open");
    for model in ["open", "closed", "combo", "bass", "bassStack"] {
        fx.cabinet.model = model.into();
        TrackDsp::new(fx.clone(), 48_000, 1.0).unwrap();
    }
    fx.cabinet.model = "nope".into();
    assert!(TrackDsp::new(fx, 48_000, 1.0).is_err());
}

/// The largest step and peak of the left output over a settled stretch, while a model changes, and over the stretch
/// settled after it, for one edit path.
fn change(first: &FxSettings, next: &FxSettings, rate: u32, path: &str) -> [[f64; 2]; 3] {
    let tone = sine(110.0, rate, 0.15);
    let unit = rate as usize / 4;
    let mut dsp = TrackDsp::new(first.clone(), rate, 1.0).unwrap();
    let (mut last, mut most, mut n) = (0.0f64, [[0.0f64; 2]; 3], 0);
    for (window, frames) in [
        (usize::MAX, unit),
        (0, unit),
        (1, unit),
        (usize::MAX, unit),
        (2, unit),
    ] {
        if window == 1 {
            if path == "set_settings" {
                dsp.set_settings(next.clone()).unwrap();
            } else {
                let mut new = TrackDsp::new(next.clone(), rate, 1.0).unwrap();
                new.transition_from(&mut dsp);
                dsp = new;
            }
        }
        for _ in 0..frames {
            let y = dsp.process([tone(n); 2], 120.0)[0] as f64;
            assert!(y.is_finite());
            n += 1;
            if window != usize::MAX {
                most[window][0] = most[window][0].max((y - last).abs());
                most[window][1] = most[window][1].max(y.abs());
            }
            last = y;
        }
    }
    most
}
/// `allowance` is how far an edge may pass the settled sounds' edges during the change. A jump is the height of the wave,
/// near 0.2 here, where the settled edges are near 0.01.
fn assert_smooth(first: &FxSettings, next: &FxSettings, what: &str, allowance: f64) {
    for rate in RATES {
        for path in ["set_settings", "transition_from"] {
            let [before, during, after] = change(first, next, rate, path);
            let step = before[0].max(after[0]);
            let peak = before[1].max(after[1]);
            assert!(
                during[0] <= step * 1.5 + allowance,
                "{what} by {path} at {rate}: step {} against {step}",
                during[0]
            );
            assert!(
                during[1] <= peak * 1.5 + 0.01,
                "{what} by {path} at {rate}: peak {} against {peak}",
                during[1]
            );
        }
    }
}

#[test]
fn changing_amp_model_is_smooth() {
    let models = ["clean", "crunch", "lead", "metal", "bass", "bassDrive"];
    for a in models {
        for b in models {
            if a != b {
                assert_smooth(
                    &amp(a, 0.7),
                    &amp(b, 0.7),
                    &format!("amp {a} to {b}"),
                    0.002,
                );
            }
        }
        // An amp switched on or off fades, whichever path its model takes.
        assert_smooth(
            &FxSettings::default(),
            &amp(a, 0.7),
            &format!("amp {a} on"),
            0.002,
        );
        assert_smooth(
            &amp(a, 0.7),
            &FxSettings::default(),
            &format!("amp {a} off"),
            0.002,
        );
    }
}

#[test]
fn changing_cabinet_model_is_smooth() {
    let models = ["open", "closed", "combo", "bass", "bassStack"];
    let driven = amp("lead", 0.7);
    for a in models {
        for b in models {
            if a != b {
                let (from, to) = (cabinet(driven.clone(), a), cabinet(driven.clone(), b));
                assert_smooth(&from, &to, &format!("cabinet {a} to {b}"), 0.002);
            }
        }
        let on = cabinet(driven.clone(), a);
        assert_smooth(&driven, &on, &format!("cabinet {a} on"), 0.002);
        assert_smooth(&on, &driven, &format!("cabinet {a} off"), 0.002);
    }
}

#[test]
fn changing_pedal_model_is_smooth() {
    let models = ["overdrive", "distortion", "fuzz"];
    let base = amp("crunch", 0.4);
    for a in models {
        for b in models {
            if a != b {
                let (from, to) = (pedal(base.clone(), a, 0.7), pedal(base.clone(), b, 0.7));
                // A wave part way between two pedals is not centred as either is, so for a period its steep part can cross the
                // saturated amp behind them where the amp's gain is highest: a sharper edge, not a jump.
                assert_smooth(&from, &to, &format!("pedal {a} to {b}"), 0.05);
            }
        }
        let on = pedal(base.clone(), a, 0.7);
        assert_smooth(&base, &on, &format!("pedal {a} on"), 0.05);
        assert_smooth(&on, &base, &format!("pedal {a} off"), 0.05);
    }
}

/// A riff-like signal, so every part of the chain does some work: a low note, a chord, and silence between.
fn riff(n: usize, rate: u32) -> f32 {
    let t = n as f64 / rate as f64;
    let beat = t.fract();
    let swell = 0.4 * (-5.0 * beat).exp();
    let note =
        (TAU * 82.41 * t).sin() + 0.7 * (TAU * 123.47 * t).sin() + 0.4 * (TAU * 164.81 * t).sin();
    (swell * note) as f32
}

#[test]
fn rendering_repeats_exactly_and_a_reset_forgets_the_past() {
    let first = cabinet(pedal(amp("metal", 0.8), "fuzz", 0.5), "closed");
    let next = cabinet(pedal(amp("bassDrive", 0.6), "distortion", 0.5), "bassStack");
    for rate in RATES {
        let render = || {
            let mut old = TrackDsp::new(first.clone(), rate, 1.0).unwrap();
            let mut new = TrackDsp::new(next.clone(), rate, 1.0).unwrap();
            let mut output = Vec::new();
            for n in 0..rate as usize {
                output.push(old.process([riff(n, rate); 2], 120.0)[0].to_bits());
            }
            new.transition_from(&mut old);
            for n in 0..rate as usize {
                output.push(new.process([riff(n, rate); 2], 120.0)[1].to_bits());
            }
            output
        };
        assert!(render() == render(), "two renders differ at {rate}");

        let mut played = TrackDsp::new(first.clone(), rate, 1.0).unwrap();
        for n in 0..rate as usize {
            played.process([riff(n, rate), riff(n + 99, rate)], 120.0);
        }
        played.reset();
        let mut fresh = TrackDsp::new(first.clone(), rate, 1.0).unwrap();
        for n in 0..rate as usize / 2 {
            let (a, b) = (
                played.process([riff(n, rate); 2], 120.0),
                fresh.process([riff(n, rate); 2], 120.0),
            );
            assert_eq!(
                a[0].to_bits(),
                b[0].to_bits(),
                "frame {n} after a reset at {rate}"
            );
        }
    }
}

#[test]
fn a_track_panned_while_it_plays_runs_on_exactly() {
    // A centred voice runs one channel and copies it. Panning splits the channels, which must not disturb the one that
    // carries on, and must leave the other starting from the same state.
    for fx in [
        cabinet(pedal(amp("metal", 0.8), "fuzz", 0.5), "closed"),
        cabinet(amp("crunch", 0.6), "combo"),
    ] {
        for rate in RATES {
            let (split_at, frames) = (rate as usize / 2, rate as usize);
            let mut mono = TrackDsp::new(fx.clone(), rate, 1.0).unwrap();
            let mut panned = TrackDsp::new(fx.clone(), rate, 1.0).unwrap();
            for n in 0..frames {
                let x = riff(n, rate);
                let centred = mono.process([x; 2], 120.0);
                assert_eq!(centred[0].to_bits(), centred[1].to_bits(), "frame {n}");
                let right = if n < split_at { x } else { x * 0.7 };
                let wide = panned.process([x, right], 120.0);
                assert_eq!(
                    centred[0].to_bits(),
                    wide[0].to_bits(),
                    "left channel at frame {n}"
                );
                if n < split_at {
                    assert_eq!(wide[0].to_bits(), wide[1].to_bits(), "frame {n}");
                }
            }
        }
    }
}

#[test]
fn the_driven_chain_stays_off_the_heap() {
    let boards = [
        cabinet(amp("clean", 0.3), "open"),
        cabinet(amp("crunch", 0.6), "closed"),
        cabinet(pedal(amp("metal", 0.8), "fuzz", 0.7), "closed"),
        cabinet(pedal(amp("bassDrive", 0.6), "overdrive", 0.5), "bassStack"),
        cabinet(pedal(amp("lead", 0.7), "distortion", 0.7), "combo"),
        cabinet(amp("bass", 0.4), "bass"),
        pedal(FxSettings::default(), "fuzz", 0.7),
        FxSettings::default(),
        cabinet(amp("metal", 0.8), "combo"),
    ];
    for rate in RATES {
        let mut prepared: Vec<TrackDsp> = boards
            .iter()
            .map(|fx| TrackDsp::new(fx.clone(), rate, 1.0).unwrap())
            .collect();
        let mut sum = 0.0f32;
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|f| f.set(true));
        for index in 0..prepared.len() {
            if index > 0 {
                let (done, rest) = prepared.split_at_mut(index);
                rest[0].transition_from(&mut done[index - 1]);
            }
            // Past the crossfade, and past a track starting to pan, which splits the channels.
            for n in 0..rate as usize / 5 {
                let x = riff(n, rate);
                let right = if n < rate as usize / 10 { x } else { x * 0.7 };
                sum += prepared[index].process([x, right], 120.0)[0];
            }
            prepared[index].reset();
        }
        COUNT_HEAP.with(|f| f.set(false));
        let operations = HEAP_OPERATIONS.with(Cell::get);
        std::hint::black_box(sum);
        assert_eq!(
            operations, 0,
            "the driven chain allocated or freed heap memory"
        );
    }
}
