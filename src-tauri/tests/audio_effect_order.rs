use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: f64 = 48_000.0;
/// The blocks in their default order, from the microphone to the reverb.
const DEFAULT: [&str; 17] = [
    "microphone",
    "gate",
    "compressor",
    "wah",
    "octaver",
    "pitch",
    "drive",
    "amp",
    "cabinet",
    "eq",
    "vibrato",
    "phaser",
    "flanger",
    "chorus",
    "tremolo",
    "delay",
    "reverb",
];

fn order(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

/// The default order with `block` moved to just after `after`.
fn moved(block: &str, after: &str) -> Vec<String> {
    let mut names: Vec<&str> = DEFAULT
        .iter()
        .copied()
        .filter(|name| *name != block)
        .collect();
    let at = names.iter().position(|name| *name == after).unwrap() + 1;
    names.insert(at, block);
    order(&names)
}

fn everything(variant: u32) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.microphone.enabled = true;
    fx.microphone.placement = "room".into();
    fx.gate.enabled = true;
    fx.compressor.enabled = true;
    fx.wah.enabled = true;
    fx.octaver.enabled = true;
    fx.pitch.enabled = true;
    fx.pitch.mix = 0.3;
    fx.drive.enabled = true;
    fx.amp.enabled = true;
    fx.cabinet.enabled = true;
    fx.eq.enabled = true;
    fx.eq.low_db = 3.0;
    fx.vibrato.enabled = true;
    fx.phaser.enabled = true;
    fx.flanger.enabled = true;
    fx.chorus.enabled = true;
    fx.tremolo.enabled = true;
    fx.delay.enabled = true;
    fx.delay.model = "tape".into();
    fx.reverb.enabled = true;
    fx.reverb.model = "hall".into();
    if variant == 1 {
        fx.drive.model = "fuzz".into();
        fx.delay.feedback = 0.6;
        fx.tremolo.enabled = false;
    }
    fx
}

/// A fingerprint of `first` then, after a second, `second`, on integer-generated noise bursts.
fn fingerprint(first: FxSettings, second: FxSettings) -> (u64, u64) {
    let mut dsp = TrackDsp::new(first, 48_000, 4.0).unwrap();
    let (mut energy, mut weighted, mut seed) = (0.0f64, 0.0f64, 3u32);
    for n in 0..96_000usize {
        if n == 48_000 {
            dsp.set_settings(second.clone()).unwrap();
        }
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let x = if n % 12_000 < 3_000 {
            ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.6
        } else {
            0.0
        };
        let y = dsp.process([x, -0.25 * x], 110.0);
        energy += (y[0] * y[0] + y[1] * y[1]) as f64;
        weighted += (y[0] as f64 - 0.5 * y[1] as f64) * ((n % 89) as f64 + 1.0);
    }
    (energy.to_bits(), weighted.to_bits())
}

#[test]
fn the_effect_order_keeps_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert!(
        defaults.get("order").is_none(),
        "the default order is not written"
    );
    assert!(
        serde_json::from_value::<FxSettings>(defaults)
            .unwrap()
            .order
            .is_empty()
    );
    let mut fx = FxSettings::default();
    fx.order = moved("delay", "pitch");
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(written["order"], serde_json::json!(moved("delay", "pitch")));
    assert_eq!(serde_json::from_value::<FxSettings>(written).unwrap(), fx);
    // An order names every block once.
    let mut bad = |names: Vec<String>| {
        fx.order = names;
        fx.validate().unwrap_err()
    };
    assert!(
        bad(order(&DEFAULT[1..]))
            .to_lowercase()
            .contains("effect order")
    );
    let mut twice = order(&DEFAULT);
    twice[1] = "drive".into();
    assert!(bad(twice).to_lowercase().contains("effect order"));
    let mut unknown = order(&DEFAULT);
    unknown[3] = "talkbox".into();
    assert!(bad(unknown).to_lowercase().contains("effect order"));
    fx.order = order(&DEFAULT);
    assert!(fx.validate().is_ok());
}

#[test]
fn the_default_order_sounds_exactly_as_before() {
    // Taken with every block running in the fixed chain, before blocks could be reordered, and retaken when the drive
    // pedals' circuits were replaced: a pedal is the one block here that changed.
    assert_eq!(
        fingerprint(everything(0), everything(1)),
        (4614647981792208811, 4638945785411500981)
    );
    // Naming the default order explicitly changes nothing.
    let explicit = |variant: u32| {
        let mut fx = everything(variant);
        fx.order = order(&DEFAULT);
        fx
    };
    assert_eq!(
        fingerprint(explicit(0), explicit(1)),
        (4614647981792208811, 4638945785411500981)
    );
}

/// The level of each of `count` repeats of a short noise burst through drive and a digital delay, in `order`.
fn repeat_levels(names: Vec<String>, count: usize) -> Vec<f64> {
    let mut fx = FxSettings::default();
    fx.drive.enabled = true;
    fx.drive.model = "distortion".into();
    fx.drive.drive = 0.8;
    fx.delay.enabled = true;
    fx.delay.quarter_notes = 0.5;
    fx.delay.feedback = 0.5;
    fx.delay.mix = 1.0;
    fx.order = names;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let mut seed = 5u32;
    let output: Vec<f64> = (0..(RATE as usize / 4) * (count + 1) + 2_400)
        .map(|n| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = if n < 480 {
                ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.5
            } else {
                0.0
            };
            dsp.process([x; 2], 120.0)[0] as f64
        })
        .collect();
    (1..=count)
        .map(|k| {
            let at = k * RATE as usize / 4;
            let window = &output[at - 600..at + 1_200];
            (window.iter().map(|v| v * v).sum::<f64>() / window.len() as f64).sqrt()
        })
        .collect()
}

#[test]
fn reordering_changes_what_each_block_hears() {
    // Drive before the delay: each repeat is the distorted burst again, falling by the feedback.
    let before = repeat_levels(Vec::new(), 4);
    for k in 1..4 {
        assert!(
            (before[k] / before[k - 1] - 0.5).abs() < 0.02,
            "drive then delay {before:?}"
        );
    }
    // Drive after the delay: the distortion squeezes the falling repeats back up.
    let after = repeat_levels(moved("drive", "delay"), 4);
    for k in 1..4 {
        assert!(after[k] / after[k - 1] > 0.6, "delay then drive {after:?}");
    }
}

#[test]
fn every_order_is_deterministic_and_bounded() {
    // Rotations and a reversal of the chain, each run twice.
    let mut orders: Vec<Vec<String>> = (0..17)
        .map(|r| order(&[&DEFAULT[r..], &DEFAULT[..r]].concat()))
        .collect();
    orders.push(order(&DEFAULT.iter().rev().copied().collect::<Vec<_>>()));
    for names in orders {
        let mut fx = everything(0);
        fx.order = names.clone();
        let run = || {
            let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
            let mut seed = 9u32;
            (0..24_000)
                .map(|n| {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let x = if n < 6_000 {
                        ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.9
                    } else {
                        0.0
                    };
                    dsp.process([x, x], 120.0)
                })
                .collect::<Vec<_>>()
        };
        let first = run();
        assert_eq!(first, run(), "{names:?} is deterministic");
        assert!(
            first.iter().all(|y| y[0].is_finite()
                && y[1].is_finite()
                && y[0].abs() <= 1.0
                && y[1].abs() <= 1.0),
            "{names:?} is bounded"
        );
    }
}

/// The largest sample-to-sample step in the 40 ms after each change and the largest once settled, for settings applied
/// by `next` every 0.5 s while a sine plays.
fn change_steps(
    settings: &[FxSettings],
    mut next: impl FnMut(&mut TrackDsp, &FxSettings) -> TrackDsp,
) -> Vec<(f32, f32)> {
    let sine = |n: usize| ((std::f64::consts::TAU * 219.7 * n as f64 / RATE).sin() * 0.3) as f32;
    let mut dsp = TrackDsp::new(settings[0].clone(), 48_000, 4.0).unwrap();
    let (mut last, mut n, mut segments) = ([0.0f32; 2], 0, Vec::new());
    for (index, setting) in settings.iter().enumerate() {
        if index > 0 {
            dsp = next(&mut dsp, setting);
        }
        let (mut change, mut settled) = (0.0f32, 0.0f32);
        for m in 0..24_000 + 7 * index {
            let y = dsp.process([sine(n), 0.5 * sine(n)], 120.0);
            let step = (y[0] - last[0]).abs().max((y[1] - last[1]).abs());
            if m < 1_920 {
                change = change.max(step)
            } else if m > 12_000 {
                settled = settled.max(step)
            }
            last = y;
            n += 1;
        }
        segments.push((change, settled));
    }
    segments
}

#[test]
fn reordering_while_playing_does_not_click() {
    let with = |names: Vec<String>| {
        let mut fx = FxSettings::default();
        fx.drive.enabled = true;
        fx.tremolo.enabled = true;
        fx.delay.enabled = true;
        fx.delay.mix = 0.4;
        fx.order = names;
        fx
    };
    let settings = [
        with(Vec::new()),
        with(moved("drive", "delay")),
        with(moved("tremolo", "microphone")),
        with(order(&DEFAULT)),
        with(moved("delay", "gate")),
    ];
    for path in ["set_settings", "transition_from"] {
        let segments = change_steps(&settings, |old, setting| {
            if path == "set_settings" {
                let mut dsp = std::mem::replace(
                    old,
                    TrackDsp::new(FxSettings::default(), 48_000, 4.0).unwrap(),
                );
                dsp.set_settings(setting.clone()).unwrap();
                dsp
            } else {
                let mut new = TrackDsp::new(setting.clone(), 48_000, 4.0).unwrap();
                new.transition_from(old);
                new
            }
        });
        for index in 1..segments.len() {
            let bound = segments[index - 1].1.max(segments[index].1);
            assert!(
                segments[index].0 <= bound * 1.25,
                "{path} change {index}: step {} vs settled {bound}",
                segments[index].0
            );
        }
    }
}

#[test]
fn a_reorder_takes_effect_within_twenty_milliseconds() {
    let mut fx = FxSettings::default();
    fx.drive.enabled = true;
    fx.drive.model = "distortion".into();
    fx.drive.drive = 0.8;
    fx.delay.enabled = true;
    fx.delay.quarter_notes = 0.5;
    fx.delay.feedback = 0.5;
    fx.delay.mix = 1.0;
    let mut later = fx.clone();
    later.order = moved("drive", "delay");
    for path in ["set_settings", "transition_from"] {
        let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
        for _ in 0..4_800 {
            dsp.process([0.0; 2], 120.0);
        }
        apply(&mut dsp, &later, path, 48_000);
        for _ in 0..960 {
            dsp.process([0.0; 2], 120.0);
        }
        // After the change, the dsp plays exactly as one built in the new order does.
        let mut fresh = TrackDsp::new(later.clone(), 48_000, 4.0).unwrap();
        for n in 0..9_600 {
            let x = ((std::f64::consts::TAU * 330.0 * n as f64 / RATE).sin() * 0.4) as f32;
            let (a, b) = (dsp.process([x; 2], 120.0), fresh.process([x; 2], 120.0));
            assert_eq!(a, b, "{path} frame {n}");
        }
    }
}

/// Applies `settings` through the given edit path: `set_settings`, or a new configuration taking over by
/// `transition_from` as live edits do.
fn apply(dsp: &mut TrackDsp, settings: &FxSettings, path: &str, rate: u32) {
    if path == "set_settings" {
        dsp.set_settings(settings.clone()).unwrap();
    } else {
        let mut new = TrackDsp::new(settings.clone(), rate, 4.0).unwrap();
        new.transition_from(dsp);
        *dsp = new;
    }
}

#[test]
fn moving_blocks_that_are_off_changes_nothing_heard() {
    let mut fx = FxSettings::default();
    fx.drive.enabled = true;
    fx.delay.enabled = true;
    fx.delay.mix = 0.4;
    // Each move keeps the drive before the delay, so only switched-off blocks change places.
    let orders = [
        moved("gate", "reverb"),
        moved("drive", "cabinet"),
        moved("chorus", "microphone"),
        moved("delay", "reverb"),
    ];
    for path in ["set_settings", "transition_from"] {
        let mut moving = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
        let mut still = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
        let mut n = 0usize;
        for names in &orders {
            let mut next = fx.clone();
            next.order = names.clone();
            apply(&mut moving, &next, path, 48_000);
            apply(&mut still, &fx, path, 48_000);
            for _ in 0..12_000 {
                let x = ((std::f64::consts::TAU * 219.7 * n as f64 / RATE).sin() * 0.4) as f32;
                assert_eq!(
                    moving.process([x, 0.5 * x], 120.0),
                    still.process([x, 0.5 * x], 120.0),
                    "{path} {names:?} frame {n}"
                );
                n += 1;
            }
        }
    }
}

/// Two blocks that pass a steady level unchanged, so the output over a steady input is the reorder's gain.
fn level_chain(names: Vec<String>) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.gate.enabled = true;
    fx.gate.threshold_db = -96.0;
    fx.eq.enabled = true;
    fx.order = names;
    fx
}

/// The reorder's gain on each frame, with `edits` applied at the given frames through `path`.
fn gains(edits: &[(usize, FxSettings)], path: &str, frames: usize) -> Vec<f32> {
    let mut dsp = TrackDsp::new(level_chain(Vec::new()), 48_000, 4.0).unwrap();
    for _ in 0..4_800 {
        dsp.process([0.5; 2], 120.0);
    }
    (0..frames)
        .map(|n| {
            for (at, settings) in edits {
                if *at == n {
                    apply(&mut dsp, settings, path, 48_000);
                }
            }
            dsp.process([0.5; 2], 120.0)[0] / 0.5
        })
        .collect()
}

#[test]
fn a_reorder_fades_out_and_back_in_and_turns_round_mid_fade() {
    let swapped = level_chain(moved("gate", "eq"));
    let back = level_chain(Vec::new());
    let step = 1.0 / 480.0 + 1e-4;
    for path in ["set_settings", "transition_from"] {
        // One reorder: down to silence at 10 ms, back to full by 20 ms, never stepping more than the fade's slope.
        let one = gains(&[(100, swapped.clone())], path, 2_000);
        assert!((one[99] - 1.0).abs() < 1e-3, "{path} {}", one[99]);
        assert!(
            one[580].abs() < 3e-3,
            "{path} silent at the swap: {}",
            one[580]
        );
        assert!(
            one[1_100..].iter().all(|g| (g - 1.0).abs() < 1e-3),
            "{path} back to full"
        );
        assert!(
            one.windows(2).all(|w| (w[1] - w[0]).abs() <= step),
            "{path} smooth"
        );
        // Turning back 3 ms into the fade-out fades straight back in from where it got to.
        let turned = gains(&[(100, swapped.clone()), (244, back.clone())], path, 2_000);
        let lowest = turned.iter().copied().fold(1.0f32, f32::min);
        assert!(lowest > 0.6 && lowest < 0.75, "{path} lowest {lowest}");
        assert!(
            turned[600..].iter().all(|g| (g - 1.0).abs() < 1e-3),
            "{path} back to full"
        );
        assert!(
            turned.windows(2).all(|w| (w[1] - w[0]).abs() <= step),
            "{path} smooth"
        );
        // A third order during the fade-in fades out again from where it got to.
        let third = gains(&[(100, swapped.clone()), (800, back.clone())], path, 3_000);
        assert!(
            third.windows(2).all(|w| (w[1] - w[0]).abs() <= step),
            "{path} smooth"
        );
        assert!(
            third[2_400..].iter().all(|g| (g - 1.0).abs() < 1e-3),
            "{path} back to full"
        );
    }
}

#[test]
fn a_configuration_at_another_rate_takes_over_mid_fade() {
    let mut old = TrackDsp::new(level_chain(Vec::new()), 192_000, 4.0).unwrap();
    old.set_settings(level_chain(moved("gate", "eq"))).unwrap();
    // Halfway down the 1 920-frame fade-out.
    let mut last = 1.0;
    for _ in 0..960 {
        last = old.process([0.5; 2], 120.0)[0] / 0.5;
    }
    let mut new = TrackDsp::new(level_chain(Vec::new()), 8_000, 4.0).unwrap();
    new.transition_from(&mut old);
    let out: Vec<f32> = (0..800).map(|_| new.process([0.5; 2], 120.0)[0]).collect();
    assert!(out.iter().all(|y| y.is_finite() && y.abs() <= 0.5 + 1e-3));
    // It carries on from the same level, here fading back in because the new configuration keeps the playing order.
    assert!(
        (out[0] / 0.5 - last).abs() < 0.03,
        "{last} then {}",
        out[0] / 0.5
    );
    assert!((out[799] / 0.5 - 1.0).abs() < 1e-3);
}
