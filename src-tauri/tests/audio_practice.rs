use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};
use tabplayer_lib::audio::practice::{
    ClickSound, ClickVoice, CountInClock, CountInSnapshot, PracticeSettings, PracticeTempo,
    progressive_ratio,
};

thread_local! {
    static COUNT_HEAP: Cell<bool> = const { Cell::new(false) };
    static HEAP_OPERATIONS: Cell<usize> = const { Cell::new(0) };
}
struct CountAllocator;
unsafe impl GlobalAlloc for CountAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.dealloc(pointer, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: CountAllocator = CountAllocator;

#[test]
fn shared_settings_fixture_matches_native_serde_and_semantics() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/practice-protocol.json")).unwrap();
    for group in ["valid", "invalid"] {
        for case in fixture[group].as_array().unwrap() {
            let accepted = serde_json::from_value::<PracticeSettings>(case["settings"].clone())
                .ok()
                .is_some_and(|settings| {
                    settings
                        .validate(case["hasBacking"].as_bool().unwrap())
                        .is_ok()
                });
            assert_eq!(accepted, group == "valid", "{}", case["name"]);
        }
    }
}

#[test]
fn validates_semantic_bounds_and_backing_atomically() {
    let original = PracticeSettings::default();
    assert!(original.validate(false).is_ok());
    for tempo in [
        PracticeTempo::Relative { ratio: 0.1 },
        PracticeTempo::Relative { ratio: 3.0 },
        PracticeTempo::Fixed { bpm: 10.0 },
        PracticeTempo::Fixed { bpm: 300.0 },
        PracticeTempo::Progressive {
            start: 0.1,
            end: 3.0,
            step: 2.9,
            repetitions: 100,
        },
        PracticeTempo::Progressive {
            start: 1.0,
            end: 1.0,
            step: 0.2,
            repetitions: 1,
        },
    ] {
        let settings = PracticeSettings { tempo, ..original };
        assert!(settings.validate(false).is_ok(), "{tempo:?}");
    }
    for tempo in [
        PracticeTempo::Relative { ratio: 0.099 },
        PracticeTempo::Relative { ratio: 3.001 },
        PracticeTempo::Fixed { bpm: 9.9 },
        PracticeTempo::Fixed { bpm: 300.1 },
        PracticeTempo::Progressive {
            start: 0.099,
            end: 1.0,
            step: 0.2,
            repetitions: 1,
        },
        PracticeTempo::Progressive {
            start: 0.5,
            end: 3.001,
            step: 0.2,
            repetitions: 1,
        },
        PracticeTempo::Progressive {
            start: 1.0,
            end: 0.5,
            step: 0.2,
            repetitions: 1,
        },
        PracticeTempo::Progressive {
            start: 0.5,
            end: 1.0,
            step: 0.0,
            repetitions: 1,
        },
        PracticeTempo::Progressive {
            start: 0.5,
            end: 1.0,
            step: 2.901,
            repetitions: 1,
        },
        PracticeTempo::Progressive {
            start: 0.5,
            end: 1.0,
            step: 0.2,
            repetitions: 0,
        },
        PracticeTempo::Progressive {
            start: 0.5,
            end: 1.0,
            step: 0.2,
            repetitions: 101,
        },
    ] {
        let settings = PracticeSettings { tempo, ..original };
        assert!(settings.validate(false).is_err(), "{tempo:?}");
    }
    for volume in [-0.001, 1.001] {
        let mut settings = original;
        settings.metronome.volume = volume;
        assert!(settings.validate(false).is_err());
    }
    let mut settings = original;
    settings.count_in.bars = 17;
    assert!(settings.validate(false).is_err());
    settings = original;
    settings.count_in.bars = 16;
    settings.metronome.volume = 0.0;
    assert!(settings.validate(true).is_ok());
    settings.tempo = PracticeTempo::Fixed { bpm: 100.5 };
    assert_eq!(
        settings.validate(true),
        Err("Fixed tempo is unavailable while a backing track is present.")
    );
    assert_eq!(original, PracticeSettings::default());
}

#[test]
fn rejects_nonfinite_settings() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for tempo in [
            PracticeTempo::Relative { ratio: value },
            PracticeTempo::Fixed { bpm: value },
            PracticeTempo::Progressive {
                start: value,
                end: 1.0,
                step: 0.2,
                repetitions: 1,
            },
            PracticeTempo::Progressive {
                start: 0.5,
                end: value,
                step: 0.2,
                repetitions: 1,
            },
            PracticeTempo::Progressive {
                start: 0.5,
                end: 1.0,
                step: value,
                repetitions: 1,
            },
        ] {
            assert!(
                PracticeSettings {
                    tempo,
                    ..PracticeSettings::default()
                }
                .validate(false)
                .is_err()
            );
        }
        let mut settings = PracticeSettings::default();
        settings.metronome.volume = value;
        assert!(settings.validate(false).is_err());
    }
}

#[test]
fn trainer_repeats_per_speed_and_clamps() {
    let tempo = PracticeTempo::Progressive {
        start: 0.5,
        end: 1.0,
        step: 0.2,
        repetitions: 2,
    };
    for (passes, expected) in [0.5, 0.5, 0.7, 0.7, 0.9, 0.9, 1.0, 1.0, 1.0]
        .into_iter()
        .enumerate()
    {
        assert!((progressive_ratio(&tempo, passes as u64) - expected).abs() < 1e-12);
    }
    assert_eq!(progressive_ratio(&tempo, u64::MAX), 1.0);
    let equal = PracticeTempo::Progressive {
        start: 0.7,
        end: 0.7,
        step: 2.9,
        repetitions: 100,
    };
    assert_eq!(progressive_ratio(&equal, 0), 0.7);
    assert_eq!(progressive_ratio(&equal, u64::MAX), 0.7);
}

fn count_samples(mut clock: CountInClock) -> (u64, Vec<(u64, u32, bool)>) {
    let mut frames = 0;
    let mut pulses = Vec::new();
    loop {
        let value = clock.next_frame();
        if value.finished {
            assert_eq!(value.remaining, 0);
            assert!(value.pulse.is_none());
            let end = clock.snapshot();
            assert!(clock.next_frame().finished);
            assert_eq!(
                clock.snapshot(),
                end,
                "finished calls consume no score slot"
            );
            return (frames, pulses);
        }
        if let Some(pulse) = value.pulse {
            pulses.push((frames, pulse.beat, pulse.accent));
        }
        frames += 1;
    }
}

#[test]
fn count_uses_exact_absolute_frame_boundaries() {
    assert_eq!(
        count_samples(CountInClock::new(1, 3, 8, 120.0, 48_000).unwrap()),
        (
            36_000,
            vec![(0, 0, true), (12_000, 1, false), (24_000, 2, false)]
        )
    );
    let (frames, pulses) = count_samples(CountInClock::new(2, 4, 4, 120.0, 48_000).unwrap());
    assert_eq!(frames, 192_000);
    assert_eq!(
        pulses,
        vec![
            (0, 0, true),
            (24_000, 1, false),
            (48_000, 2, false),
            (72_000, 3, false),
            (96_000, 0, true),
            (120_000, 1, false),
            (144_000, 2, false),
            (168_000, 3, false),
        ]
    );
    assert_eq!(
        count_samples(CountInClock::new(1, 5, 128, 120.0, 48_000).unwrap()).0,
        3_750
    );
    assert_eq!(
        count_samples(CountInClock::new(1, 33, 256, 120.0, 48_000).unwrap()).0,
        12_375
    );
    assert_eq!(
        count_samples(CountInClock::new(0, 4, 4, 120.0, 48_000).unwrap()),
        (0, vec![])
    );
}

#[test]
fn remaining_includes_the_current_pulse_and_final_sample() {
    let mut clock = CountInClock::new(1, 3, 8, 120.0, 48_000).unwrap();
    for frame in 0..36_000 {
        let sample = clock.next_frame();
        assert!(!sample.finished);
        assert_eq!(sample.remaining, 3 - frame / 12_000);
        if let Some(pulse) = sample.pulse {
            assert_eq!(pulse.beats_per_bar, 3);
        }
    }
    assert_eq!(clock.remaining_wall_seconds(), 0.0);
    assert!(clock.next_frame().finished);
}

#[test]
fn count_rounding_uses_cumulative_positions_instead_of_rounded_intervals() {
    let (frames, pulses) = count_samples(CountInClock::new(2, 7, 8, 100.5, 44_100).unwrap());
    assert_eq!(pulses.len(), 14);
    for (index, (frame, beat, accent)) in pulses.into_iter().enumerate() {
        let expected = (index as f64 * 60.0 / 100.5 * 4.0 / 8.0 * 44_100.0).round() as u64;
        assert_eq!(frame, expected);
        assert_eq!(beat, index as u32 % 7);
        assert_eq!(accent, index % 7 == 0);
    }
    assert_eq!(
        frames,
        (14.0_f64 * 60.0 / 100.5 * 4.0 / 8.0 * 44_100.0).round() as u64
    );
}

#[test]
fn count_pause_and_rate_restore_preserve_duration_without_replaying_a_pulse() {
    let mut original = CountInClock::new(2, 3, 8, 100.5, 48_000).unwrap();
    for _ in 0..17_321 {
        original.next_frame();
    }
    let paused = original.snapshot();
    let remaining = original.remaining_wall_seconds();
    assert_eq!(original.snapshot(), paused);
    let restored = CountInClock::from_snapshot(paused, 44_100).unwrap();
    assert!((restored.remaining_wall_seconds() - remaining).abs() <= 1.0 / 44_100.0);
    assert_eq!(restored.snapshot().emitted_pulses, paused.emitted_pulses);
    let (frames, pulses) = count_samples(restored);
    assert!((frames as f64 / 44_100.0 - remaining).abs() <= 1.0 / 44_100.0);
    assert_eq!(pulses.len(), 4);
    assert!(pulses[0].0 > 0);
    assert_eq!(pulses[0].1, 2);

    let mut on_pulse = CountInClock::new(1, 3, 8, 120.0, 48_000).unwrap();
    on_pulse.next_frame();
    let mut changed_rate = CountInClock::from_snapshot(on_pulse.snapshot(), 44_100).unwrap();
    assert!(
        changed_rate.next_frame().pulse.is_none(),
        "rate restoration must not replay pulse zero"
    );
}

#[test]
fn rate_restore_retains_the_actual_rounded_total_across_repeated_changes() {
    let mut initial = CountInClock::new(1, 17, 8, 121.3, 8_000).unwrap();
    assert_eq!(initial.snapshot().total_frames, 33_636);
    for elapsed in [0, 1, 2_019, 16_817, 33_635, 33_636] {
        while initial.snapshot().elapsed_frames < elapsed {
            initial.next_frame();
        }
        let mut clock = initial;
        let emitted = clock.snapshot().emitted_pulses;
        for rate in [192_000, 44_100, 8_000, 48_000, 192_000, 44_100] {
            let before = clock.snapshot();
            let remaining = clock.remaining_wall_seconds();
            clock = CountInClock::from_snapshot(before, rate).unwrap();
            let after = clock.snapshot();
            assert_eq!(after.rate, rate);
            assert_eq!(after.emitted_pulses, emitted);
            assert!(
                (clock.remaining_wall_seconds() - remaining).abs() <= 1.0 / f64::from(rate) + 1e-12
            );
            assert!(
                (after.elapsed_frames as f64 / f64::from(rate)
                    - before.elapsed_frames as f64 / f64::from(before.rate))
                .abs()
                    <= 0.5 / f64::from(rate) + 1e-12
            );
            let same_rate = CountInClock::from_snapshot(after, rate).unwrap();
            assert_eq!(same_rate.snapshot(), after);
            assert_eq!(
                same_rate.remaining_wall_seconds(),
                clock.remaining_wall_seconds()
            );
        }
        let (_, pulses) = count_samples(clock);
        assert_eq!(pulses.len(), (17 - emitted) as usize);
        for (index, (_, beat, _)) in pulses.iter().enumerate() {
            assert_eq!(
                *beat,
                emitted + index as u32,
                "restored pulse is never replayed"
            );
        }
    }
}

#[test]
fn disabled_count_does_not_limit_a_saved_positive_tempo() {
    assert!(
        CountInClock::new(0, 4, 256, 1e100, 48_000)
            .unwrap()
            .next_frame()
            .finished
    );
    assert!(
        CountInClock::new(0, 4, 4, f64::MIN_POSITIVE, 48_000)
            .unwrap()
            .next_frame()
            .finished
    );
}

#[test]
fn invalid_count_math_is_rejected_without_altering_a_clock() {
    let mut clock = CountInClock::new(1, 4, 4, 120.0, 48_000).unwrap();
    clock.next_frame();
    let before = clock.snapshot();
    for (bars, numerator, denominator, bpm, rate) in [
        (1, 4, 4, 120.0, 0),
        (1, 0, 4, 120.0, 48_000),
        (1, 4, 3, 120.0, 48_000),
        (17, 4, 4, 120.0, 48_000),
        (16, u32::MAX, 4, 120.0, 48_000),
        (1, 4, 4, 0.0, 48_000),
        (1, 4, 4, -1.0, 48_000),
        (1, 4, 4, f64::NAN, 48_000),
        (1, 4, 4, f64::INFINITY, 48_000),
        (1, 4, 4, f64::MIN_POSITIVE, u32::MAX),
        (1, 4, 4, 1e-12, u32::MAX),
        (1, 4, 256, 1e8, 48_000),
    ] {
        assert!(CountInClock::new(bars, numerator, denominator, bpm, rate).is_err());
    }
    assert!(CountInClock::from_snapshot(before, 0).is_err());
    assert!(CountInClock::from_snapshot(CountInSnapshot { rate: 0, ..before }, 44_100).is_err());
    assert!(
        CountInClock::from_snapshot(
            CountInSnapshot {
                elapsed_frames: u64::MAX,
                ..before
            },
            44_100
        )
        .is_err()
    );
    assert!(
        CountInClock::from_snapshot(
            CountInSnapshot {
                emitted_pulses: 5,
                ..before
            },
            44_100
        )
        .is_err()
    );
    assert!(
        CountInClock::from_snapshot(
            CountInSnapshot {
                total_frames: 4,
                ..before
            },
            44_100
        )
        .is_err()
    );
    assert_eq!(clock.snapshot(), before);
}

fn click_pcm(volume: f64, accent: bool) -> Vec<f32> {
    let mut click = ClickVoice::new(48_000);
    click.trigger(accent, ClickSound::Beep);
    (0..2_500).map(|_| click.frame(volume)).collect()
}

fn frequency(samples: &[f32]) -> f64 {
    let crossings: Vec<_> = samples
        .windows(2)
        .enumerate()
        .filter(|(_, samples)| samples[0] < 0.0 && samples[1] >= 0.0)
        .map(|(index, samples)| index as f64 - samples[0] as f64 / (samples[1] - samples[0]) as f64)
        .collect();
    (crossings.len() - 1) as f64 * 48_000.0 / (crossings.last().unwrap() - crossings[0])
}

#[test]
fn click_volume_and_visual_silence() {
    assert!(click_pcm(0.0, true).iter().all(|sample| *sample == 0.0));
    let quiet = click_pcm(0.2, true);
    let loud = click_pcm(0.4, true);
    let energy = |samples: &[f32]| {
        samples
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum::<f64>()
    };
    assert!((energy(&loud) / energy(&quiet) - 4.0).abs() < 4e-5);
    assert!((frequency(&loud[..2_400]) - 2_400.0).abs() < 1.0);
    assert!((frequency(&click_pcm(0.4, false)[..2_400]) - 1_800.0).abs() < 1.0);
    assert!(loud[2_400..].iter().all(|sample| *sample == 0.0));
}

#[test]
fn click_retrigger_replaces_age_and_retains_existing_shape() {
    let mut click = ClickVoice::new(48_000);
    assert_eq!(click.frame(0.4), 0.0);
    click.trigger(true, ClickSound::Beep);
    for index in 0..137 {
        let age = index as f64 / 48_000.0;
        let expected =
            ((std::f64::consts::TAU * 2_400.0 * age).sin() * (-age * 100.0).exp() * 0.1) as f32;
        assert!((click.frame(0.4) - expected).abs() < 1e-8);
    }
    click.trigger(false, ClickSound::Beep);
    let mut fresh = ClickVoice::new(48_000);
    fresh.trigger(false, ClickSound::Beep);
    for _ in 0..2_500 {
        assert_eq!(click.frame(0.4), fresh.frame(0.4));
    }
}

#[test]
fn count_click_and_snapshot_restoration_are_allocation_free() {
    let mut clock = CountInClock::new(2, 5, 8, 100.5, 48_000).unwrap();
    let mut click = ClickVoice::new(48_000);
    clock.next_frame();
    click.frame(0.4);
    HEAP_OPERATIONS.with(|count| count.set(0));
    COUNT_HEAP.with(|flag| flag.set(true));
    let mut sum: f32 = 0.0;
    for _ in 0..4 {
        clock = CountInClock::from_snapshot(clock.snapshot(), 44_100).unwrap();
        for _ in 0..10_003 {
            let frame = clock.next_frame();
            if let Some(pulse) = frame.pulse {
                click.trigger(pulse.accent, ClickSound::Beep);
            }
            sum += click.frame(0.4);
        }
    }
    COUNT_HEAP.with(|flag| flag.set(false));
    assert!(sum.is_finite());
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
}

fn sound_pcm(sound: ClickSound, accent: bool) -> Vec<f32> {
    let mut click = ClickVoice::new(48_000);
    click.trigger(accent, sound);
    (0..10_000).map(|_| click.frame(1.0)).collect()
}

#[test]
fn each_click_sound_is_distinct_bounded_and_ends() {
    let sounds = [
        ClickSound::Beep,
        ClickSound::Woodblock,
        ClickSound::Cowbell,
        ClickSound::Stick,
    ];
    let rendered: Vec<_> = sounds
        .iter()
        .map(|sound| sound_pcm(*sound, false))
        .collect();
    for (index, samples) in rendered.iter().enumerate() {
        let peak = samples.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
        // No sound peaks above the original beep's ceiling, so a change of sound never jumps the peak level.
        assert!(
            peak > 0.05 && peak <= 0.25 + 1e-6,
            "{:?} peak {peak}",
            sounds[index]
        );
        let last = samples.iter().rposition(|s| *s != 0.0).unwrap();
        assert!(last < 8_000, "{:?} rings to {last}", sounds[index]);
        assert!(samples[last + 1..].iter().all(|s| *s == 0.0));
        for other in &rendered[index + 1..] {
            assert_ne!(samples, other);
        }
    }
}

#[test]
fn the_beep_is_unchanged_and_accents_raise_the_tonal_sounds() {
    let mut old = ClickVoice::new(48_000);
    old.trigger(true, ClickSound::default());
    for index in 0..2_400 {
        let age = index as f64 / 48_000.0;
        let expected =
            ((std::f64::consts::TAU * 2_400.0 * age).sin() * (-age * 100.0).exp() * 0.25) as f32;
        assert_eq!(old.frame(1.0), expected);
    }
    for (sound, normal, accented) in [
        (ClickSound::Woodblock, 1_000.0, 1_300.0),
        (ClickSound::Cowbell, 540.0, 680.0),
    ] {
        let low = sound_pcm(sound, false);
        let high = sound_pcm(sound, true);
        let first_crossings = |samples: &[f32]| {
            samples[..1_200]
                .windows(2)
                .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
                .count() as f64
        };
        let ratio = first_crossings(&high) / first_crossings(&low);
        // The clipped cowbell's second partial adds crossings, so only its direction is checked.
        if sound == ClickSound::Cowbell {
            assert!(ratio > 1.1, "{sound:?} ratio {ratio}");
        } else {
            assert!(
                (ratio - accented / normal).abs() < 0.05,
                "{sound:?} ratio {ratio}"
            );
        }
    }
    let energy = |samples: &[f32]| samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
    assert!(
        energy(&sound_pcm(ClickSound::Stick, true)) > energy(&sound_pcm(ClickSound::Stick, false))
    );
}

#[test]
fn every_click_sound_renders_without_allocating() {
    let mut click = ClickVoice::new(48_000);
    click.frame(0.4);
    HEAP_OPERATIONS.with(|count| count.set(0));
    COUNT_HEAP.with(|flag| flag.set(true));
    let mut sum: f32 = 0.0;
    for sound in [
        ClickSound::Beep,
        ClickSound::Woodblock,
        ClickSound::Cowbell,
        ClickSound::Stick,
    ] {
        click.trigger(true, sound);
        for _ in 0..9_000 {
            sum += click.frame(0.4);
        }
    }
    COUNT_HEAP.with(|flag| flag.set(false));
    assert!(sum.is_finite());
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
}

#[test]
fn practice_settings_without_a_sound_keep_the_beep_and_reject_unknown_sounds() {
    let old: PracticeSettings = serde_json::from_str(
        r#"{"tempo":{"kind":"relative","ratio":1},"metronome":{"enabled":true,"volume":0.4,"visual":false},"countIn":{"bars":0,"betweenLoops":false}}"#,
    )
    .unwrap();
    assert_eq!(old.metronome.sound, ClickSound::Beep);
    let chosen: PracticeSettings = serde_json::from_str(
        r#"{"tempo":{"kind":"relative","ratio":1},"metronome":{"enabled":true,"volume":0.4,"visual":false,"sound":"cowbell"},"countIn":{"bars":0,"betweenLoops":false}}"#,
    )
    .unwrap();
    assert_eq!(chosen.metronome.sound, ClickSound::Cowbell);
    assert_eq!(
        serde_json::to_value(chosen).unwrap()["metronome"]["sound"],
        "cowbell"
    );
    assert!(
        serde_json::from_str::<PracticeSettings>(
            r#"{"tempo":{"kind":"relative","ratio":1},"metronome":{"enabled":true,"volume":0.4,"visual":false,"sound":"gong"},"countIn":{"bars":0,"betweenLoops":false}}"#,
        )
        .is_err()
    );
    for sound in [
        ClickSound::Beep,
        ClickSound::Woodblock,
        ClickSound::Cowbell,
        ClickSound::Stick,
    ] {
        assert_eq!(ClickSound::from_code(sound.code()), sound);
    }
}
