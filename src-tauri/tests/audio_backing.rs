use std::sync::Arc;
use tabplayer_lib::{
    audio::{
        backing::{BackingMap, BackingVoice},
        decode::DecodedAudio,
        plan::PlaybackPlan,
    },
    settings::SyncAnchor,
};

fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":4000,"tracks":[{"id":"guitar","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":0,"occurrence":1,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":4000}],"notes":[],"midi":[]})).unwrap()
}

#[test]
fn anchor_occurrence_not_display_index() {
    let anchors = vec![
        SyncAnchor {
            bar: 0,
            occurrence: 0,
            ratio: 0.0,
            audio_ms: 100.0,
        },
        SyncAnchor {
            bar: 0,
            occurrence: 1,
            ratio: 0.5,
            audio_ms: 3400.0,
        },
    ];
    let map = BackingMap::new(&anchors, 100.0, &plan()).unwrap();
    assert!((map.source_seconds(3.0) - 3.3).abs() < 1e-8);
    assert!((map.source_seconds(1.5) - 1.65).abs() < 1e-8);
    let reversed =
        BackingMap::new(&[anchors[1].clone(), anchors[0].clone()], 100.0, &plan()).unwrap();
    assert!((reversed.source_seconds(3.0) - 3.3).abs() < 1e-8);
}

#[test]
fn drift_offset_seek_loop_speed_pitch() {
    for rate in [44_100, 48_000] {
        let frames: Vec<_> = (0..rate * 8)
            .map(|n| {
                let x = (std::f64::consts::TAU * 440.0 * n as f64 / rate as f64).sin() as f32 * 0.2;
                [x, x * 0.5]
            })
            .collect();
        let audio = Arc::new(DecodedAudio {
            sample_rate: rate,
            channels: 2,
            frames: Arc::new(frames),
        });
        for speed in [0.25, 1.0, 2.0] {
            let map = BackingMap::new(&[], 0.0, &plan()).unwrap();
            let mut voice = BackingVoice::new(audio.clone(), map, 48_000).unwrap();
            let output: Vec<_> = (0..48_000)
                .map(|n| voice.next_frame(n as f64 / 48_000.0 * speed))
                .collect();
            let crossings = output[4_800..]
                .windows(2)
                .filter(|w| w[0][0] <= 0.0 && w[1][0] > 0.0)
                .count();
            let frequency = crossings as f64 / 0.9;
            assert!(
                (frequency / 440.0 - 1.0).abs() < 0.01,
                "rate {rate}, speed {speed}: {frequency}"
            );
            assert!(output.iter().all(|x| (x[1] - x[0] * 0.5).abs() < 1e-6));
            voice.seek(0.75);
            let first = voice.next_frame(0.75);
            voice.seek(0.75);
            assert_eq!(first, voice.next_frame(0.75));
        }
    }
}

#[test]
fn renderer_backing_10_123_300_preserves_pitch_and_anchor_at_both_rates() {
    use tabplayer_lib::{
        audio::{renderer::Renderer, resources::AudioResources},
        settings::{ChannelMix, DocumentSettings, TrackSound},
    };
    let resources = Arc::new(AudioResources {
        manifest: Default::default(),
        samples: Default::default(),
        sound_font: Arc::new(
            rustysynth::SoundFont::new(&mut std::io::Cursor::new(
                std::fs::read(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
                ))
                .unwrap(),
            ))
            .unwrap(),
        ),
    });
    let mut settings = DocumentSettings::default();
    settings.sounds.insert(
        "guitar".into(),
        TrackSound {
            voice_id: Some("gm".into()),
            ..Default::default()
        },
    );
    let plan = Arc::new(plan());
    for rate in [44_100, 48_000] {
        let tone = Arc::new(DecodedAudio {
            sample_rate: rate,
            channels: 2,
            frames: Arc::new(
                (0..rate * 2)
                    .map(|frame| {
                        let sample = (std::f64::consts::TAU * 440.0 * frame as f64 / rate as f64)
                            .sin() as f32
                            * 0.2;
                        [sample, sample * 0.5]
                    })
                    .collect(),
            ),
        });
        let mut impulse = vec![[0.0; 2]; rate as usize * 2];
        impulse[(rate as f64 * 0.5) as usize] = [1.0, 0.5];
        let impulse = Arc::new(DecodedAudio {
            sample_rate: rate,
            channels: 2,
            frames: Arc::new(impulse),
        });
        for speed in [0.1, 1.23, 3.0] {
            let mut renderer =
                Renderer::new(plan.clone(), resources.clone(), settings.clone(), rate).unwrap();
            renderer
                .install_backing(
                    tone.clone(),
                    BackingMap::new(&[], 0.0, &plan).unwrap(),
                    ChannelMix::default(),
                )
                .unwrap();
            renderer.set_speed(speed).unwrap();
            let mut output = vec![[0.0; 2]; rate as usize / 2];
            let status = renderer.render_into(&mut output);
            assert!((status.tick - 960.0 * speed).abs() < 1e-5);
            let wave = &output[rate as usize / 10..];
            let crossings: Vec<_> = wave
                .windows(2)
                .enumerate()
                .filter(|(_, pair)| pair[0][0] <= 0.0 && pair[1][0] > 0.0)
                .map(|(index, pair)| {
                    index as f64 - pair[0][0] as f64 / (pair[1][0] - pair[0][0]) as f64
                })
                .collect();
            let hz = (crossings.len() - 1) as f64 * rate as f64
                / (crossings.last().unwrap() - crossings[0]);
            assert!((hz - 440.0).abs() < 4.4, "rate={rate}, speed={speed}: {hz}");
            let mut renderer =
                Renderer::new(plan.clone(), resources.clone(), settings.clone(), rate).unwrap();
            renderer
                .install_backing(
                    impulse.clone(),
                    BackingMap::new(&[], 100.0, &plan).unwrap(),
                    ChannelMix::default(),
                )
                .unwrap();
            renderer.set_speed(speed).unwrap();
            let mut output = vec![[0.0; 2]; (rate as f64 / speed).ceil() as usize];
            renderer.render_into(&mut output);
            let peak = output
                .iter()
                .enumerate()
                .max_by(|a, b| a.1[0].abs().total_cmp(&b.1[0].abs()))
                .unwrap();
            let expected = (0.6 * rate as f64 / speed).ceil() as usize;
            assert!(
                peak.0.abs_diff(expected) <= 1,
                "rate={rate} speed={speed}: {} expected {expected}",
                peak.0
            );
            assert!(peak.1[0] > 0.6);
        }
    }
}

#[test]
fn backing_bounds_are_silent_and_clicks_keep_clock() {
    let mut frames = vec![[0.0; 2]; 48_000];
    frames[24_000] = [1.0, 0.5];
    let audio = Arc::new(DecodedAudio {
        sample_rate: 48_000,
        channels: 2,
        frames: Arc::new(frames),
    });
    for speed in [0.25, 1.0, 2.0] {
        let map = BackingMap::new(&[], 100.0, &plan()).unwrap();
        let mut voice = BackingVoice::new(audio.clone(), map, 48_000).unwrap();
        assert_eq!(voice.next_frame(0.0), [0.0; 2]);
        voice.seek(0.0);
        let output: Vec<_> = (0..(48_000.0 / speed) as usize)
            .map(|n| voice.next_frame(n as f64 * speed / 48_000.0))
            .collect();
        let peak = output
            .iter()
            .enumerate()
            .max_by(|a, b| a.1[0].abs().total_cmp(&b.1[0].abs()))
            .unwrap();
        let expected = (0.6 * 48_000.0 / speed) as usize;
        assert!(
            peak.0.abs_diff(expected) <= 512,
            "speed {speed}, click {} expected {expected}",
            peak.0
        );
        voice.seek(3.0);
        assert_eq!(voice.next_frame(3.0), [0.0; 2]);
    }
}

#[test]
fn drift_anchors_and_repeated_seek_keep_transient_alignment() {
    let anchors = [
        SyncAnchor {
            bar: 0,
            occurrence: 0,
            ratio: 0.0,
            audio_ms: 0.0,
        },
        SyncAnchor {
            bar: 0,
            occurrence: 1,
            ratio: 0.0,
            audio_ms: 2200.0,
        },
        SyncAnchor {
            bar: 0,
            occurrence: 1,
            ratio: 1.0,
            audio_ms: 4200.0,
        },
    ];
    let mut frames = vec![[0.0; 2]; 48_000 * 5];
    frames[48_000] = [1.0, 0.4];
    let audio = Arc::new(DecodedAudio {
        sample_rate: 48_000,
        channels: 2,
        frames: Arc::new(frames),
    });
    for speed in [0.25, 1.0, 2.0] {
        let map = BackingMap::new(&anchors, 125.0, &plan()).unwrap();
        assert!((map.score_seconds(1.0) - 1.125 / 1.1).abs() < 1e-9);
        let mut voice = BackingVoice::new(audio.clone(), map, 48_000).unwrap();
        let mut previous = None;
        for _ in 0..2 {
            voice.seek(0.75);
            let output: Vec<_> = (0..(48_000.0 / speed) as usize)
                .map(|n| voice.next_frame(0.75 + n as f64 * speed / 48_000.0))
                .collect();
            let peak = output
                .iter()
                .enumerate()
                .max_by(|a, b| a.1[0].total_cmp(&b.1[0]))
                .unwrap();
            let expected = ((1.125 / 1.1 - 0.75) * 48_000.0 / speed) as usize;
            assert!(peak.0.abs_diff(expected) <= 512);
            if let Some(previous) = previous.take() {
                assert_eq!(output, previous);
            }
            previous = Some(output);
        }
    }
}

#[test]
fn unordered_repeat_anchors_resolve_before_order_validation() {
    use tabplayer_lib::audio::plan::MeasureOccurrence;
    let mut plan = plan();
    plan.duration_tick = 15360.0;
    plan.duration_ms = 8000.0;
    plan.occurrences = (0..4)
        .map(|index| MeasureOccurrence {
            bar: index % 2,
            occurrence: index / 2,
            meter_numerator: 4,
            meter_denominator: 4,
            start_tick: index as f64 * 3840.0,
            end_tick: (index + 1) as f64 * 3840.0,
            start_ms: index as f64 * 2000.0,
            end_ms: (index + 1) as f64 * 2000.0,
            click_ticks: None,
        })
        .collect();
    let anchors = vec![
        SyncAnchor {
            bar: 0,
            occurrence: 0,
            ratio: 0.0,
            audio_ms: 0.0,
        },
        SyncAnchor {
            bar: 0,
            occurrence: 1,
            ratio: 0.0,
            audio_ms: 4000.0,
        },
        SyncAnchor {
            bar: 1,
            occurrence: 0,
            ratio: 0.0,
            audio_ms: 2000.0,
        },
        SyncAnchor {
            bar: 1,
            occurrence: 1,
            ratio: 0.0,
            audio_ms: 6000.0,
        },
    ];
    let map = BackingMap::new(&anchors, 0.0, &plan).unwrap();
    assert!((map.source_seconds(3.0) - 3.0).abs() < 1e-9);
    assert!((map.source_seconds(5.0) - 5.0).abs() < 1e-9);
    let mut duplicate = anchors.clone();
    duplicate.push(anchors[0].clone());
    assert!(BackingMap::new(&duplicate, 0.0, &plan).is_err());
    let mut crossing = anchors;
    crossing[1].audio_ms = 1500.0;
    assert!(BackingMap::new(&crossing, 0.0, &plan).is_err());
}
