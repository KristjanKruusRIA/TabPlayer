use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: u32 = 48_000;

/// A test signal with low and high partials and a slow swell, so every block has something to change. Its partials
/// are off zero and its swell is well up on each whole second, where the tests change settings.
fn input(n: usize) -> [f32; 2] {
    let t = n as f64 / RATE as f64;
    let swell = 0.5 + 0.5 * (std::f64::consts::TAU * 0.7 * t).cos();
    let x = 0.2
        * swell
        * ((std::f64::consts::TAU * 110.0 * t + 1.0).sin()
            + 0.4 * (std::f64::consts::TAU * 1760.0 * t + 0.5).sin());
    [x as f32, (x * 0.8) as f32]
}

/// A tremolo, a chorus and a delay on the first pedalboard.
fn first() -> FxSettings {
    let mut fx = FxSettings::default();
    fx.tremolo.enabled = true;
    fx.tremolo.depth = 0.9;
    fx.chorus.enabled = true;
    fx.delay.enabled = true;
    fx
}

/// A second tremolo at another rate and depth, a second chorus and a reverb.
fn second() -> FxSettings {
    let mut fx = FxSettings::default();
    fx.tremolo.enabled = true;
    fx.tremolo.rate_hz = 7.0;
    fx.tremolo.depth = 0.4;
    fx.tremolo.shape = "square".into();
    fx.chorus.enabled = true;
    fx.chorus.rate_hz = 2.5;
    fx.reverb.enabled = true;
    fx
}

fn with_second(mut fx: FxSettings, board: FxSettings) -> FxSettings {
    fx.second = Some(Box::new(board));
    fx
}

#[test]
fn a_second_pedalboard_is_saved_only_when_used_and_holds_one_level() {
    let plain = serde_json::to_value(first()).unwrap();
    assert!(plain.get("second").is_none());
    let both = with_second(first(), second());
    let json = serde_json::to_value(&both).unwrap();
    assert_eq!(json["second"]["tremolo"]["rateHz"], 7.0);
    assert_eq!(serde_json::from_value::<FxSettings>(json).unwrap(), both);
    both.validate().unwrap();
    // A board inside the second one, or a pedal setting the player refuses, is refused.
    let nested = with_second(first(), with_second(second(), FxSettings::default()));
    assert_eq!(nested.validate().unwrap_err(), "Invalid second pedalboard.");
    let mut wrong = second();
    wrong.tremolo.depth = 2.0;
    assert!(with_second(first(), wrong).validate().is_err());
    assert!(TrackDsp::new(nested, RATE, 4.0).is_err());
}

#[test]
fn the_second_pedalboard_plays_after_the_first_with_its_own_settings() {
    // The same as two tracks' chains in series: duplicated pedals keep their own parameters and state.
    let mut both = TrackDsp::new(with_second(first(), second()), RATE, 4.0).unwrap();
    let mut a = TrackDsp::new(first(), RATE, 4.0).unwrap();
    let mut b = TrackDsp::new(second(), RATE, 4.0).unwrap();
    for n in 0..RATE as usize * 2 {
        let x = input(n);
        assert_eq!(
            both.process(x, 120.0),
            b.process(a.process(x, 120.0), 120.0),
            "frame {n}"
        );
    }
    // Two level stages multiply exactly.
    let mut level = FxSettings::default();
    level.graphic_eq.enabled = true;
    level.graphic_eq.level_db = -6.0;
    let mut doubled = TrackDsp::new(with_second(level.clone(), level), RATE, 4.0).unwrap();
    let mut peak: f64 = 0.0;
    for n in 0..RATE as usize {
        let y = doubled.process(input(n), 120.0)[0] as f64;
        if n > RATE as usize / 2 {
            peak = peak.max((y - input(n)[0] as f64 * 10f64.powf(-12.0 / 20.0)).abs());
        }
    }
    assert!(peak < 1e-6, "{peak}");
}

/// Plays `steps` of settings, a second apart, through both the settings path and the prepared-configuration path,
/// and returns each path's output.
fn play(steps: &[FxSettings]) -> [Vec<[f32; 2]>; 2] {
    let second = RATE as usize;
    let mut direct = TrackDsp::new(steps[0].clone(), RATE, 4.0).unwrap();
    let mut prepared = TrackDsp::new(steps[0].clone(), RATE, 4.0).unwrap();
    let (mut a, mut b) = (Vec::new(), Vec::new());
    for (index, step) in steps.iter().enumerate() {
        if index > 0 {
            direct.set_settings(step.clone()).unwrap();
            let mut next = TrackDsp::new(step.clone(), RATE, 4.0).unwrap();
            next.transition_from(&mut prepared);
            prepared = next;
        }
        for n in index * second..(index + 1) * second {
            a.push(direct.process(input(n), 120.0));
            b.push(prepared.process(input(n), 120.0));
        }
    }
    [a, b]
}

#[test]
fn adding_and_removing_the_second_pedalboard_does_not_click() {
    // A second board of a drive and a level cut, which changes the signal at once, and a room microphone whose
    // reflections must fade in like a block switched on while playing.
    let mut board = FxSettings::default();
    board.microphone.enabled = true;
    board.microphone.placement = "room".into();
    board.drive.enabled = true;
    board.drive.drive = 0.8;
    board.graphic_eq.enabled = true;
    board.graphic_eq.level_db = -9.0;
    let steps = [
        first(),
        with_second(first(), board.clone()),
        first(),
        with_second(first(), board),
    ];
    let alone: Vec<[f32; 2]> = {
        let mut dsp = TrackDsp::new(first(), RATE, 4.0).unwrap();
        (0..RATE as usize * 4)
            .map(|n| dsp.process(input(n), 120.0))
            .collect()
    };
    let mut fadings = Vec::new();
    for (path, output) in play(&steps).iter().enumerate() {
        assert!(output.iter().flatten().all(|v| v.is_finite()));
        let step = |range: std::ops::Range<usize>| {
            range
                .map(|n| (output[n][0] - output[n - 1][0]).abs())
                .fold(0.0f32, f32::max)
        };
        let settled = step(RATE as usize / 2..RATE as usize)
            .max(step(RATE as usize * 3 / 2..RATE as usize * 2));
        for change in 1..4 {
            let at = change * RATE as usize;
            let jump = step(at..at + 960);
            assert!(
                jump <= settled * 1.25,
                "path {path} change {change}: {jump} against {settled}"
            );
        }
        // The board's own part of the output, against the first board alone, fades out on removal rather than
        // dropping: the prepared path's fade is as smooth as the settings path's.
        let removed = RATE as usize * 2;
        fadings.push(
            (removed..removed + 960)
                .map(|n| {
                    ((output[n][0] - alone[n][0]) - (output[n - 1][0] - alone[n - 1][0])).abs()
                })
                .fold(0.0f32, f32::max),
        );
        // Once the second board has faded out, the first plays exactly as it does alone.
        for n in RATE as usize * 2 + 960..RATE as usize * 3 {
            assert_eq!(output[n], alone[n], "path {path} frame {n}");
        }
    }
    assert!(fadings[1] <= fadings[0] * 1.25, "removal fades {fadings:?}");
}

#[test]
fn a_reset_clears_the_second_pedalboard_too() {
    let fx = with_second(FxSettings::default(), second());
    let mut dsp = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
    for n in 0..RATE as usize {
        dsp.process(input(n), 120.0);
    }
    dsp.reset();
    let mut fresh = TrackDsp::new(fx, RATE, 4.0).unwrap();
    for n in 0..RATE as usize / 4 {
        assert_eq!(
            dsp.process(input(n), 120.0),
            fresh.process(input(n), 120.0),
            "frame {n}"
        );
    }
}

#[test]
fn a_second_pedalboard_added_again_starts_afresh() {
    // Long echoes and a reverb, which would replay what the removed board held.
    let mut board = FxSettings::default();
    board.delay.enabled = true;
    board.delay.feedback = 0.8;
    board.delay.mix = 0.6;
    board.reverb.enabled = true;
    board.reverb.mix = 0.6;
    let played = play(&[
        first(),
        with_second(first(), board.clone()),
        first(),
        with_second(first(), board.clone()),
    ]);
    // The same configurations, but with the board never there before the last.
    let fresh = play(&[first(), first(), first(), with_second(first(), board)]);
    for path in 0..2 {
        for n in RATE as usize * 3..RATE as usize * 4 {
            assert_eq!(played[path][n], fresh[path][n], "path {path} frame {n}");
        }
    }
}

#[test]
fn a_room_microphone_duplicated_while_playing_fades_its_reflections_in() {
    // A quiet low sine, whose own step per sample is small, so a reflection arriving at full level shows. It is
    // added away from a zero crossing, where a reflection would arrive from zero.
    let sine = |n: usize| {
        let x = 0.05 * (std::f64::consts::TAU * 220.0 * n as f64 / RATE as f64).sin();
        [x as f32; 2]
    };
    let mut board = FxSettings::default();
    board.microphone.enabled = true;
    board.microphone.placement = "room".into();
    let added = with_second(FxSettings::default(), board);
    let mut direct = TrackDsp::new(FxSettings::default(), RATE, 4.0).unwrap();
    let mut prepared = TrackDsp::new(FxSettings::default(), RATE, 4.0).unwrap();
    let half = RATE as usize / 2;
    let (mut a, mut b) = (Vec::new(), Vec::new());
    for n in 0..half * 2 {
        if n == half + 55 {
            direct.set_settings(added.clone()).unwrap();
            let mut next = TrackDsp::new(added.clone(), RATE, 4.0).unwrap();
            next.transition_from(&mut prepared);
            prepared = next;
        }
        a.push(direct.process(sine(n), 120.0)[0]);
        b.push(prepared.process(sine(n), 120.0)[0]);
    }
    for (path, output) in [a, b].iter().enumerate() {
        let step = |range: std::ops::Range<usize>| {
            range
                .map(|n| (output[n] - output[n - 1]).abs())
                .fold(0.0f32, f32::max)
        };
        let settled = step(half / 2..half).max(step(half * 2 - half / 2..half * 2));
        let jump = step(half..half + 4800);
        assert!(
            jump <= settled * 1.25,
            "path {path}: {jump} against {settled}"
        );
    }
}
