use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: f64 = 48_000.0;

fn sine(n: usize, hz: f64, amplitude: f64) -> f32 {
    ((std::f64::consts::TAU * hz * n as f64 / RATE).sin() * amplitude) as f32
}

/// Root-mean-square level of each consecutive window of `size` frames on the left channel.
fn window_levels(output: &[[f32; 2]], size: usize) -> Vec<f64> {
    output
        .chunks(size)
        .filter(|chunk| chunk.len() == size)
        .map(|chunk| (chunk.iter().map(|x| (x[0] * x[0]) as f64).sum::<f64>() / size as f64).sqrt())
        .collect()
}

#[test]
fn modulation_blocks_keep_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    for block in ["flanger", "phaser", "tremolo", "vibrato"] {
        assert!(
            defaults.get(block).is_none(),
            "{block} must not be written while at its defaults"
        );
    }
    // A sound saved before these blocks existed still loads, with them off.
    let older: FxSettings = serde_json::from_value(defaults.clone()).unwrap();
    assert!(
        !older.flanger.enabled
            && !older.phaser.enabled
            && !older.tremolo.enabled
            && !older.vibrato.enabled
    );
    let mut fx = FxSettings::default();
    fx.tremolo.enabled = true;
    fx.tremolo.shape = "square".into();
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(
        written["tremolo"],
        serde_json::json!({"enabled":true,"rateHz":5.0,"depth":0.5,"shape":"square"})
    );
    assert_eq!(serde_json::from_value::<FxSettings>(written).unwrap(), fx);
    let mut unknown = serde_json::to_value(&fx).unwrap();
    unknown["tremolo"]["extra"] = serde_json::json!(1);
    assert!(serde_json::from_value::<FxSettings>(unknown).is_err());
}

#[test]
fn modulation_parameters_are_validated() {
    let cases: Vec<(&str, Box<dyn Fn(&mut FxSettings)>)> = vec![
        ("flanger rate", Box::new(|fx| fx.flanger.rate_hz = 6.0)),
        ("flanger depth", Box::new(|fx| fx.flanger.depth_ms = 11.0)),
        (
            "flanger feedback",
            Box::new(|fx| fx.flanger.feedback = 0.95),
        ),
        ("flanger mix", Box::new(|fx| fx.flanger.mix = f64::NAN)),
        ("phaser rate", Box::new(|fx| fx.phaser.rate_hz = 0.0)),
        ("phaser depth", Box::new(|fx| fx.phaser.depth = 1.5)),
        ("phaser feedback", Box::new(|fx| fx.phaser.feedback = -0.1)),
        ("tremolo rate", Box::new(|fx| fx.tremolo.rate_hz = 25.0)),
        ("tremolo depth", Box::new(|fx| fx.tremolo.depth = -0.1)),
        ("vibrato rate", Box::new(|fx| fx.vibrato.rate_hz = 15.0)),
        ("vibrato rate", Box::new(|fx| fx.vibrato.rate_hz = 0.5)),
        (
            "vibrato depth",
            Box::new(|fx| fx.vibrato.depth_cents = 101.0),
        ),
    ];
    for (name, change) in cases {
        let mut fx = FxSettings::default();
        change(&mut fx);
        let error = fx.validate().unwrap_err();
        assert!(error.contains(name), "{name}: {error}");
    }
    let mut fx = FxSettings::default();
    fx.phaser.stages = 3;
    assert!(fx.validate().is_err());
    let mut fx = FxSettings::default();
    fx.tremolo.shape = "triangle".into();
    assert!(fx.validate().is_err());
}

#[test]
fn disabled_modulation_is_an_exact_bypass() {
    let mut fx = FxSettings::default();
    // Changed parameters on disabled blocks do not touch the signal.
    fx.flanger.mix = 1.0;
    fx.phaser.mix = 1.0;
    fx.tremolo.depth = 1.0;
    fx.vibrato.depth_cents = 100.0;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    for n in 0..4800 {
        let x = [sine(n, 440.0, 0.3), sine(n, 220.0, 0.2)];
        assert_eq!(dsp.process(x, 120.0), x);
    }
}

#[test]
fn tremolo_modulates_level_at_its_rate_and_depth() {
    for (shape, low) in [("sine", 0.5), ("square", 0.5)] {
        let mut fx = FxSettings::default();
        fx.tremolo.enabled = true;
        fx.tremolo.rate_hz = 4.0;
        fx.tremolo.depth = 0.5;
        fx.tremolo.shape = shape.into();
        let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
        let output: Vec<_> = (0..48_000).map(|_| dsp.process([0.4; 2], 120.0)).collect();
        let steady = &output[2_400..];
        let max = steady.iter().map(|x| x[0]).fold(f32::MIN, f32::max);
        let min = steady.iter().map(|x| x[0]).fold(f32::MAX, f32::min);
        assert!((max - 0.4).abs() < 0.002, "{shape} peak {max}");
        assert!(
            (min as f64 - 0.4 * low).abs() < 0.004,
            "{shape} trough {min}"
        );
        // Four cycles a second: the level falls through its midpoint every 12,000 frames.
        let middle = 0.4 * (1.0 + low as f32) / 2.0;
        let falls: Vec<usize> = (1..steady.len())
            .filter(|&i| steady[i - 1][0] >= middle && steady[i][0] < middle)
            .collect();
        let gaps: Vec<usize> = falls.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(
            gaps.len() >= 2 && gaps.iter().all(|&g| (g as i64 - 12_000).abs() < 2),
            "{shape} gaps {gaps:?}"
        );
        if shape == "square" {
            // A square wave dwells near its extremes, but its edges are smoothed rather than clicking.
            let near = steady.iter().filter(|x| x[0] > 0.39 || x[0] < 0.21).count() as f64
                / steady.len() as f64;
            assert!(near > 0.7, "square dwell {near}");
            let step = steady
                .windows(2)
                .map(|w| (w[1][0] - w[0][0]).abs())
                .fold(0.0, f32::max);
            assert!(step < 0.01, "square step {step}");
        }
    }
}

/// Instantaneous frequency of the left channel between successive rising zero crossings.
fn crossing_frequencies(output: &[[f32; 2]]) -> Vec<f64> {
    let mut crossings = Vec::new();
    for i in 1..output.len() {
        let (a, b) = (output[i - 1][0] as f64, output[i][0] as f64);
        if a < 0.0 && b >= 0.0 {
            crossings.push(i as f64 - 1.0 + a / (a - b));
        }
    }
    crossings.windows(2).map(|w| RATE / (w[1] - w[0])).collect()
}

#[test]
fn vibrato_swings_pitch_by_its_depth_in_cents() {
    let mut fx = FxSettings::default();
    fx.vibrato.enabled = true;
    fx.vibrato.rate_hz = 2.0;
    fx.vibrato.depth_cents = 50.0;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    // Settle for 4,800 frames, then measure exactly four 2 Hz cycles.
    let output: Vec<_> = (0..100_800)
        .map(|n| dsp.process([sine(n, 440.0, 0.3); 2], 120.0))
        .collect();
    let frequencies = crossing_frequencies(&output[4_800..]);
    let max = frequencies.iter().cloned().fold(f64::MIN, f64::max);
    let min = frequencies.iter().cloned().fold(f64::MAX, f64::min);
    let mean = frequencies.iter().sum::<f64>() / frequencies.len() as f64;
    let up = 440.0 * 2f64.powf(50.0 / 1200.0);
    let down = 440.0 * 2f64.powf(-50.0 / 1200.0);
    assert!((max - up).abs() < 1.5, "highest {max} vs {up}");
    assert!((min - down).abs() < 1.5, "lowest {min} vs {down}");
    assert!((mean - 440.0).abs() < 0.5, "mean {mean}");
    // The level is unchanged: vibrato moves pitch, not volume.
    let levels = window_levels(&output[4_800..], 4_800);
    assert!(
        levels
            .iter()
            .all(|level| (level / (0.3 / std::f64::consts::SQRT_2) - 1.0).abs() < 0.02)
    );
}

#[test]
fn flanger_sweeps_a_short_delay_with_feedback() {
    let mut fx = FxSettings::default();
    fx.flanger.enabled = true;
    fx.flanger.rate_hz = 0.5;
    fx.flanger.depth_ms = 3.0;
    fx.flanger.feedback = 0.5;
    fx.flanger.mix = 0.5;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    // An impulse every 4,800 frames: the echo after each one shows the delay at that moment.
    let output: Vec<_> = (0..96_000)
        .map(|n| dsp.process([if n % 4_800 == 0 { 1.0 } else { 0.0 }; 2], 120.0))
        .collect();
    let mut lags = Vec::new();
    for start in (0..96_000).step_by(4_800) {
        let window = &output[start + 1..start + 400];
        let (lag, peak) = window
            .iter()
            .enumerate()
            .map(|(i, x)| (i + 1, x[0].abs()))
            .fold((0, 0.0), |a, b| if b.1 > a.1 { b } else { a });
        // Mix 0.5 times the (1 - feedback) level scaling leaves a quarter-level echo, spread over two frames.
        assert!(peak > 0.1, "echo after impulse at {start}: {peak}");
        lags.push(lag);
        // The feedback repeats the echo at about twice the delay, at about half the level.
        let second = output[start + 2 * lag - 3..start + 2 * lag + 4]
            .iter()
            .map(|x| x[0].abs())
            .fold(0.0, f32::max);
        assert!(
            second > peak * 0.25 && second < peak * 0.75,
            "second echo {second} vs {peak}"
        );
    }
    let shortest = *lags.iter().min().unwrap() as f64;
    let longest = *lags.iter().max().unwrap() as f64;
    // The delay sweeps between 0.1 ms and 3.1 ms (5 to 149 frames).
    assert!(shortest >= 4.0 && shortest < 30.0, "shortest {shortest}");
    assert!(longest > 120.0 && longest <= 150.0, "longest {longest}");
}

#[test]
fn phaser_sweeps_notches_through_a_steady_tone() {
    let mut fx = FxSettings::default();
    fx.phaser.enabled = true;
    fx.phaser.rate_hz = 0.5;
    fx.phaser.depth = 1.0;
    fx.phaser.feedback = 0.3;
    fx.phaser.stages = 4;
    fx.phaser.mix = 0.5;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let output: Vec<_> = (0..192_000)
        .map(|n| dsp.process([sine(n, 1_000.0, 0.3); 2], 120.0))
        .collect();
    let levels = window_levels(&output[9_600..], 480);
    let max = levels.iter().cloned().fold(f64::MIN, f64::max);
    let min = levels.iter().cloned().fold(f64::MAX, f64::min);
    assert!(
        min < max * 0.3,
        "a notch passes through 1 kHz: {min} vs {max}"
    );
    assert!(
        max < 0.3,
        "the sweep does not boost beyond the input: {max}"
    );
    // The two channels sweep in quadrature for width.
    let difference: f64 = output[9_600..]
        .iter()
        .map(|x| (x[0] - x[1]).abs() as f64)
        .sum();
    assert!(difference > 100.0);
}

#[test]
fn live_vibrato_edits_bend_pitch_smoothly_instead_of_scrubbing() {
    let mut fx = FxSettings::default();
    fx.vibrato.enabled = true;
    fx.vibrato.rate_hz = 5.0;
    fx.vibrato.depth_cents = 100.0;
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let mut output = Vec::new();
    for n in 0..96_000 {
        // Each typed value is a separate edit: 5 Hz becomes 1 Hz mid-cycle, then depth drops to 0.
        if n == 24_100 {
            fx.vibrato.rate_hz = 1.0;
            dsp.set_settings(fx.clone()).unwrap();
        }
        if n == 60_000 {
            fx.vibrato.depth_cents = 0.0;
            dsp.set_settings(fx.clone()).unwrap();
        }
        output.push(dsp.process([sine(n, 440.0, 0.3); 2], 120.0));
    }
    // Pitch stays within the 100-cent depth plus the slew limit's half semitone: no backwards playback.
    for frequency in crossing_frequencies(&output[2_400..]) {
        assert!((400.0..485.0).contains(&frequency), "pitch {frequency}");
    }
}

#[test]
fn phaser_stage_changes_and_high_feedback_stay_smooth_and_level() {
    let mut fx = FxSettings::default();
    fx.phaser.enabled = true;
    fx.phaser.stages = 8;
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let mut output = Vec::new();
    for n in 0..48_000 {
        if n == 12_000 || n == 24_000 {
            fx.phaser.stages = if n == 12_000 { 4 } else { 8 };
            dsp.set_settings(fx.clone()).unwrap();
        }
        output.push(dsp.process([sine(n, 220.0, 0.5); 2], 120.0));
    }
    let step = |range: std::ops::Range<usize>| {
        range
            .map(|i| (output[i][0] - output[i - 1][0]).abs())
            .fold(0.0, f32::max)
    };
    let steady = step(2_000..11_900);
    assert!(
        step(11_900..12_600) < steady * 1.5 && step(23_900..24_600) < steady * 1.5,
        "steady {steady}"
    );
    // Feedback 0.9 with eight stages and the flanger at ±0.9 do not lift a full-scale tone.
    for hz in [200.0, 1_000.0, 5_000.0] {
        let mut fx = FxSettings::default();
        fx.phaser.enabled = true;
        fx.phaser.stages = 8;
        fx.phaser.feedback = 0.9;
        fx.phaser.depth = 0.0;
        fx.phaser.mix = 1.0;
        let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
        let peak = (0..48_000)
            .map(|n| dsp.process([sine(n, hz, 1.0); 2], 120.0)[0].abs())
            .fold(0.0, f32::max);
        assert!(peak < 1.05, "phaser at {hz} Hz peaks at {peak}");
        for feedback in [0.9, -0.9] {
            let mut fx = FxSettings::default();
            fx.flanger.enabled = true;
            fx.flanger.feedback = feedback;
            fx.flanger.mix = 1.0;
            let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
            let peak = (0..48_000)
                .map(|n| dsp.process([sine(n, hz, 1.0); 2], 120.0)[0].abs())
                .fold(0.0, f32::max);
            assert!(peak < 1.1, "flanger {feedback} at {hz} Hz peaks at {peak}");
        }
    }
}

#[test]
fn feedback_tails_decay_to_exact_silence() {
    let mut fx = FxSettings::default();
    fx.phaser.enabled = true;
    fx.phaser.feedback = 0.9;
    fx.flanger.enabled = true;
    fx.flanger.feedback = 0.9;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    dsp.process([1.0; 2], 120.0);
    let mut last = [1.0; 2];
    for _ in 0..48_000 * 20 {
        last = dsp.process([0.0; 2], 120.0);
    }
    assert_eq!(last, [0.0; 2]);
}

#[test]
fn vibrato_depth_holds_at_other_sample_rates() {
    let mut fx = FxSettings::default();
    fx.vibrato.enabled = true;
    fx.vibrato.rate_hz = 2.0;
    fx.vibrato.depth_cents = 50.0;
    let rate = 44_100.0;
    let mut dsp = TrackDsp::new(fx, 44_100, 4.0).unwrap();
    let output: Vec<_> = (0..92_610)
        .map(|n| {
            dsp.process(
                [((std::f64::consts::TAU * 440.0 * n as f64 / rate).sin() * 0.3) as f32; 2],
                120.0,
            )
        })
        .collect();
    let frequencies: Vec<f64> = crossing_frequencies(&output[4_410..])
        .into_iter()
        .map(|f| f * rate / RATE)
        .collect();
    let max = frequencies.iter().cloned().fold(f64::MIN, f64::max);
    let min = frequencies.iter().cloned().fold(f64::MAX, f64::min);
    assert!(
        (max - 440.0 * 2f64.powf(50.0 / 1200.0)).abs() < 1.5
            && (min - 440.0 * 2f64.powf(-50.0 / 1200.0)).abs() < 1.5,
        "{min}..{max}"
    );
}
