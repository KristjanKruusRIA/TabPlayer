use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const BLOCKS: [&str; 5] = ["chorus", "flanger", "phaser", "tremolo", "vibrato"];

/// `block` switched on at a free rate, or synced to `sync` quarter notes per cycle when it is not 0.
fn modulated(block: &str, rate_hz: f64, sync: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    match block {
        "chorus" => {
            fx.chorus.enabled = true;
            fx.chorus.mix = 0.5;
            fx.chorus.rate_hz = rate_hz;
            fx.chorus.sync_quarter_notes = sync;
        }
        "flanger" => {
            fx.flanger.enabled = true;
            fx.flanger.rate_hz = rate_hz;
            fx.flanger.sync_quarter_notes = sync;
        }
        "phaser" => {
            fx.phaser.enabled = true;
            fx.phaser.rate_hz = rate_hz;
            fx.phaser.sync_quarter_notes = sync;
        }
        "tremolo" => {
            fx.tremolo.enabled = true;
            fx.tremolo.depth = 1.0;
            fx.tremolo.rate_hz = rate_hz;
            fx.tremolo.sync_quarter_notes = sync;
        }
        _ => {
            fx.vibrato.enabled = true;
            fx.vibrato.rate_hz = rate_hz;
            fx.vibrato.sync_quarter_notes = sync;
        }
    }
    fx
}

/// Two seconds of integer-generated noise through `fx` at `bpm`.
fn render(fx: &FxSettings, bpm: f64) -> Vec<[f32; 2]> {
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let mut seed = 5u32;
    (0..96_000)
        .map(|_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.4;
            dsp.process([x, 0.5 * x], bpm)
        })
        .collect()
}

#[test]
fn tempo_sync_keeps_older_sounds_and_its_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    for block in BLOCKS {
        let free = serde_json::to_value(modulated(block, 2.0, 0.0)).unwrap();
        assert!(
            free[block].get("syncQuarterNotes").is_none(),
            "{block}: a free rate writes no sync"
        );
        let synced = modulated(block, 2.0, 0.5);
        let written = serde_json::to_value(&synced).unwrap();
        assert_eq!(
            written[block]["syncQuarterNotes"],
            serde_json::json!(0.5),
            "{block}"
        );
        assert_eq!(
            serde_json::from_value::<FxSettings>(written).unwrap(),
            synced
        );
        assert!(synced.validate().is_ok());
        for bad in [0.3, -1.0, f64::NAN, 32.0] {
            let broken = modulated(block, 2.0, bad);
            assert!(
                broken
                    .validate()
                    .unwrap_err()
                    .to_lowercase()
                    .contains("sync"),
                "{block} {bad}"
            );
        }
        // A block saved before tempo sync reads as free.
        let mut older = serde_json::to_value(modulated(block, 2.0, 0.0)).unwrap();
        older[block]
            .as_object_mut()
            .unwrap()
            .remove("syncQuarterNotes");
        let read = serde_json::from_value::<FxSettings>(older).unwrap();
        assert_eq!(read, modulated(block, 2.0, 0.0), "{block}");
    }
    assert!(
        defaults
            .get("chorus")
            .unwrap()
            .get("syncQuarterNotes")
            .is_none()
    );
    for division in [
        0.125,
        0.25,
        1.0 / 3.0,
        0.5,
        2.0 / 3.0,
        0.75,
        1.0,
        1.5,
        2.0,
        4.0,
        8.0,
        16.0,
    ] {
        assert!(
            modulated("tremolo", 2.0, division).validate().is_ok(),
            "{division}"
        );
    }
}

#[test]
fn a_synced_rate_plays_as_the_free_rate_the_tempo_gives() {
    // One quarter note at 120 bpm is 2 Hz; an eighth at 150 bpm is 5 Hz; two whole notes at 120 bpm are 0.25 Hz.
    for block in BLOCKS {
        for (sync, bpm, hz) in [(1.0, 120.0, 2.0), (0.5, 150.0, 5.0), (8.0, 120.0, 0.25)] {
            let (low, high) = match block {
                "chorus" => (0.1, 8.0),
                "flanger" | "phaser" => (0.05, 5.0),
                "tremolo" => (0.1, 20.0),
                _ => (1.0, 14.0),
            };
            if hz < low || hz > high {
                continue;
            }
            assert_eq!(
                render(&modulated(block, 3.0, sync), bpm),
                render(&modulated(block, hz, 0.0), bpm),
                "{block} synced to {sync} at {bpm} bpm"
            );
        }
    }
}

#[test]
fn a_synced_rate_stays_within_the_block_range() {
    // A thirty-second note at 300 bpm would be 40 Hz; the tremolo stops at 20 Hz. Four whole notes at 40 bpm would be
    // 1/24 Hz; the vibrato starts at 1 Hz.
    assert_eq!(
        render(&modulated("tremolo", 3.0, 0.125), 300.0),
        render(&modulated("tremolo", 20.0, 0.0), 300.0)
    );
    // A 1/32 note at 120 bpm would be 16 Hz, above the chorus's 8 Hz and the flanger's and phaser's 5 Hz.
    for (block, high) in [("chorus", 8.0), ("flanger", 5.0), ("phaser", 5.0)] {
        assert_eq!(
            render(&modulated(block, 3.0, 0.125), 120.0),
            render(&modulated(block, high, 0.0), 120.0),
            "{block}"
        );
    }
    assert_eq!(
        render(&modulated("vibrato", 3.0, 16.0), 40.0),
        render(&modulated("vibrato", 1.0, 0.0), 40.0)
    );
    // A tempo the player cannot read plays at 120 bpm.
    assert_eq!(
        render(&modulated("tremolo", 3.0, 1.0), f64::NAN),
        render(&modulated("tremolo", 2.0, 0.0), 120.0)
    );
}

/// The number of tremolo cycles in `seconds` of a steady level at `bpm`, counted as dips: each time the gain falls
/// below 0.1 after rising above 0.9. The tremolo starts at full level and dips halfway through each cycle, so a span
/// of whole cycles holds one dip per cycle.
fn tremolo_cycles(sync: f64, bpm: f64, seconds: f64) -> usize {
    let mut dsp = TrackDsp::new(modulated("tremolo", 5.0, sync), 48_000, 4.0).unwrap();
    let (mut dips, mut high) = (0, true);
    for _ in 0..(48_000.0 * seconds) as usize {
        let gain = dsp.process([0.5; 2], bpm)[0] / 0.5;
        if high && gain < 0.1 {
            dips += 1;
            high = false;
        } else if gain > 0.9 {
            high = true;
        }
    }
    dips
}

#[test]
fn the_tremolo_pulses_with_the_tempo() {
    // A quarter note per cycle: 8 pulses in 4 s at 120 bpm, 6 at 90, and 4 at 60 when practising at half speed. The free
    // rate ignores the tempo.
    assert_eq!(tremolo_cycles(0.0, 60.0, 4.0), 20);
    assert_eq!(tremolo_cycles(1.0, 120.0, 4.0), 8);
    assert_eq!(tremolo_cycles(1.0, 90.0, 4.0), 6);
    assert_eq!(tremolo_cycles(1.0, 60.0, 4.0), 4);
    // A dotted eighth: 120 bpm gives 2.67 Hz, so 10 pulses in 3.75 s.
    assert_eq!(tremolo_cycles(0.75, 120.0, 3.75), 10);
}

#[test]
fn turning_sync_on_while_playing_does_not_click() {
    for block in BLOCKS {
        let settings = [
            modulated(block, 1.3, 0.0),
            modulated(block, 1.3, 0.5),
            modulated(block, 1.3, 2.0),
            modulated(block, 4.0, 0.0),
        ];
        for path in ["set_settings", "transition_from"] {
            let sine = |n: usize| {
                ((std::f64::consts::TAU * 219.7 * n as f64 / 48_000.0).sin() * 0.3) as f32
            };
            let mut dsp = TrackDsp::new(settings[0].clone(), 48_000, 4.0).unwrap();
            let (mut last, mut n, mut segments) = ([0.0f32; 2], 0usize, Vec::new());
            for (index, setting) in settings.iter().enumerate() {
                if index > 0 {
                    if path == "set_settings" {
                        dsp.set_settings(setting.clone()).unwrap();
                    } else {
                        let mut new = TrackDsp::new(setting.clone(), 48_000, 4.0).unwrap();
                        new.transition_from(&mut dsp);
                        dsp = new;
                    }
                }
                let (mut change, mut settled) = (0.0f32, 0.0f32);
                for m in 0..24_000 + 7 * index {
                    let y = dsp.process([sine(n), 0.5 * sine(n)], 120.0);
                    assert!(
                        y.iter().all(|v| v.is_finite()),
                        "{block} {path}: finite output"
                    );
                    let step = (y[0] - last[0]).abs().max((y[1] - last[1]).abs());
                    if m < 960 {
                        change = change.max(step)
                    } else if m > 12_000 {
                        settled = settled.max(step)
                    }
                    last = y;
                    n += 1;
                }
                segments.push((change, settled));
            }
            for index in 1..segments.len() {
                let bound = segments[index - 1].1.max(segments[index].1);
                assert!(
                    segments[index].0 <= bound * 1.25,
                    "{block} {path} change {index}: step {} vs settled {bound}",
                    segments[index].0
                );
            }
        }
    }
}

/// The vibrato's largest pitch bend in cents on a 440 Hz sine, per 100 ms window, from the periods between upward zero
/// crossings, while `settings` and `bpm` give each frame's settings and tempo.
fn bends(
    first: &FxSettings,
    change: impl Fn(usize) -> Option<FxSettings>,
    bpm: impl Fn(usize) -> f64,
    frames: usize,
) -> Vec<f64> {
    let mut dsp = TrackDsp::new(first.clone(), 48_000, 4.0).unwrap();
    let (mut last, mut crossing, mut windows) = (0.0f64, None::<f64>, vec![0.0f64; frames / 4_800]);
    for n in 0..frames {
        if let Some(next) = change(n) {
            dsp.set_settings(next).unwrap();
        }
        let x = ((std::f64::consts::TAU * 440.0 * n as f64 / 48_000.0).sin() * 0.5) as f32;
        let y = dsp.process([x, x], bpm(n))[0] as f64;
        assert!(y.is_finite());
        if last < 0.0 && y >= 0.0 {
            let at = n as f64 - 1.0 + last / (last - y);
            if let Some(previous) = crossing {
                let cents = (1200.0 * (48_000.0 / (at - previous) / 440.0).log2()).abs();
                let window = &mut windows[n / 4_800];
                *window = window.max(cents);
            }
            crossing = Some(at);
        }
        last = y;
    }
    windows
}

fn vibrato(sync: f64, depth_cents: f64) -> FxSettings {
    let mut fx = modulated("vibrato", 5.0, sync);
    fx.vibrato.depth_cents = depth_cents;
    fx
}

#[test]
fn a_synced_vibrato_keeps_its_depth_when_the_rate_jumps() {
    // A quarter note per cycle while the tempo jumps from 60 to 240 bpm, with no edit: the rate goes from 1 to 4 Hz.
    let tempo = bends(
        &vibrato(1.0, 100.0),
        |_| None,
        |n| if n < 96_000 { 60.0 } else { 240.0 },
        192_000,
    );
    // Four whole notes (held at 1 Hz) to a 1/32 note (held at 14 Hz) at 120 bpm, in one edit.
    let edit = bends(
        &vibrato(16.0, 100.0),
        |n| (n == 96_000).then(|| vibrato(0.125, 100.0)),
        |_| 120.0,
        192_000,
    );
    // And back from the 1/32 note to four whole notes.
    let slower = bends(
        &vibrato(0.125, 100.0),
        |n| (n == 96_000).then(|| vibrato(16.0, 100.0)),
        |_| 120.0,
        192_000,
    );
    for (name, windows) in [
        ("tempo jump", tempo),
        ("sync change", edit),
        ("slower sync", slower),
    ] {
        // The first window holds the vibrato's start; the bend before the change sets the depth.
        let steady = windows[2..20].iter().cloned().fold(0.0, f64::max);
        assert!(
            steady > 95.0 && steady < 110.0,
            "{name}: steady bend {steady}"
        );
        let after = windows[20..].iter().cloned().fold(0.0, f64::max);
        // A swing changing while it swings bends pitch a little on its own as the rate glides.
        assert!(
            after < steady * 1.35,
            "{name}: bend {after} after the change against {steady}: {windows:?}"
        );
    }
}

#[test]
fn a_vibrato_switched_on_later_or_reset_starts_cleanly() {
    let (off, on) = (FxSettings::default(), vibrato(16.0, 100.0));
    for path in ["set_settings", "transition_from", "reset"] {
        let mut dsp = TrackDsp::new(off.clone(), 48_000, 4.0).unwrap();
        let mut n = 0usize;
        let mut run = |dsp: &mut TrackDsp, frames: usize| {
            for _ in 0..frames {
                let x = ((std::f64::consts::TAU * 440.0 * n as f64 / 48_000.0).sin() * 0.5) as f32;
                let y = dsp.process([x, x], f64::NAN);
                assert!(y.iter().all(|v| v.is_finite()), "{path}");
                n += 1;
            }
        };
        run(&mut dsp, 4_800);
        match path {
            "set_settings" => dsp.set_settings(on.clone()).unwrap(),
            "transition_from" => {
                let mut new = TrackDsp::new(on.clone(), 48_000, 4.0).unwrap();
                new.transition_from(&mut dsp);
                dsp = new;
            }
            _ => {
                dsp.set_settings(on.clone()).unwrap();
                run(&mut dsp, 4_800);
                dsp.reset();
            }
        }
        run(&mut dsp, 48_000);
        // Settled, it plays as a vibrato that was on from the start.
        let mut fresh = TrackDsp::new(on.clone(), 48_000, 4.0).unwrap();
        let mut probe = |dsp: &mut TrackDsp| -> Vec<[f32; 2]> {
            (0..480)
                .map(|_| dsp.process([0.0, 0.0], f64::NAN))
                .collect()
        };
        let _ = probe(&mut fresh);
        assert!(
            probe(&mut dsp).iter().flatten().all(|v| v.is_finite()),
            "{path}"
        );
    }
}
