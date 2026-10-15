use serde_json::{Value, json};
use std::sync::Arc;
use tabplayer_lib::{
    audio::{
        backing::BackingMap,
        decode::DecodedAudio,
        plan::{PlaybackPlan, Timeline},
        waveform::{WaveformPeak, reduce_waveform},
    },
    settings::SyncAnchor,
};

fn audio(frames: Vec<[f32; 2]>, sample_rate: u32, channels: u16) -> DecodedAudio {
    DecodedAudio {
        sample_rate,
        channels,
        frames: Arc::new(frames),
    }
}

#[test]
fn real_min_max_keeps_every_impulse_and_stereo_polarity() {
    let audio = audio(
        vec![
            [0.0, 0.0],
            [1.0, -1.0],
            [0.0, 0.0],
            [-0.5, 0.5],
            [0.25, -0.25],
        ],
        1000,
        2,
    );
    let frames_before = audio.frames.clone();
    let waveform = reduce_waveform(&audio, 2).expect("valid PCM must produce real peaks");
    assert_eq!(waveform.sample_rate, 1000);
    assert_eq!(waveform.frame_count, 5);
    assert_eq!(waveform.duration_ms, 5.0);
    assert_eq!(waveform.channels, 2);
    assert_eq!(waveform.bucket_count, 2);
    assert_eq!(
        waveform.peaks,
        vec![
            WaveformPeak {
                min: [0.0, -1.0],
                max: [1.0, 0.0],
            },
            WaveformPeak {
                min: [-0.5, -0.25],
                max: [0.25, 0.5],
            },
        ]
    );
    assert!(Arc::ptr_eq(&audio.frames, &frames_before));
    assert_eq!(Arc::strong_count(&audio.frames), 2);
    assert_eq!(
        *audio.frames,
        vec![
            [0.0, 0.0],
            [1.0, -1.0],
            [0.0, 0.0],
            [-0.5, 0.5],
            [0.25, -0.25],
        ]
    );
}

#[test]
fn bucket_boundaries_cover_every_frame_and_final_remainder() {
    // Eleven frames in four buckets have literal boundaries 0, 2, 5, 8, 11.
    for (frame, expected_bucket) in [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3].into_iter().enumerate() {
        let mut frames = vec![[0.0; 2]; 11];
        frames[frame] = [1.0, -1.0];
        let waveform = reduce_waveform(&audio(frames, 44_100, 2), 4).unwrap();
        let mut expected = vec![
            WaveformPeak {
                min: [0.0; 2],
                max: [0.0; 2],
            };
            4
        ];
        expected[expected_bucket] = WaveformPeak {
            min: [0.0, -1.0],
            max: [1.0, 0.0],
        };
        assert_eq!(waveform.peaks, expected, "impulse at frame {frame}");
        assert_eq!(waveform.bucket_count, 4);
        assert_eq!(waveform.duration_ms, 11_000.0 / 44_100.0);
    }
}

#[test]
fn silent_and_mono_frames_keep_exact_extrema_without_zero_padding() {
    let silence = reduce_waveform(&audio(vec![[0.0; 2]; 7], 48_000, 2), 3).unwrap();
    assert_eq!(
        silence.peaks,
        vec![
            WaveformPeak {
                min: [0.0; 2],
                max: [0.0; 2],
            };
            3
        ]
    );
    let mono = reduce_waveform(
        &audio(vec![[0.25; 2], [0.5; 2], [-0.75; 2], [-0.25; 2]], 1000, 1),
        2,
    )
    .unwrap();
    assert_eq!(mono.channels, 1);
    assert_eq!(
        mono.peaks,
        vec![
            WaveformPeak {
                min: [0.25; 2],
                max: [0.5; 2],
            },
            WaveformPeak {
                min: [-0.75; 2],
                max: [-0.25; 2],
            },
        ]
    );
}

#[test]
fn bucket_edges_are_total_and_invalid_audio_is_rejected() {
    let single = reduce_waveform(&audio(vec![[0.25, -0.5]], 1000, 2), 8192).unwrap();
    assert_eq!(single.bucket_count, 1);
    assert_eq!(single.frame_count, 1);
    assert_eq!(single.duration_ms, 1.0);
    assert_eq!(
        single.peaks,
        vec![WaveformPeak {
            min: [0.25, -0.5],
            max: [0.25, -0.5],
        }]
    );
    let all = reduce_waveform(
        &audio(vec![[0.25, -0.5], [-0.75, 0.125], [0.5, -1.0]], 1000, 2),
        1,
    )
    .unwrap();
    assert_eq!(all.bucket_count, 1);
    assert_eq!(
        all.peaks,
        vec![WaveformPeak {
            min: [-0.75, -1.0],
            max: [0.5, 0.125],
        }]
    );
    let maximum = reduce_waveform(&audio(vec![[0.125; 2]; 8193], 1, 1), 8192).unwrap();
    assert_eq!(maximum.bucket_count, 8192);
    assert_eq!(maximum.peaks.len(), 8192);
    assert_eq!(maximum.frame_count, 8193);
    assert_eq!(maximum.duration_ms, 8_193_000.0);
    assert!(maximum.peaks.iter().all(|peak| *peak
        == WaveformPeak {
            min: [0.125; 2],
            max: [0.125; 2],
        }));
    let finite = reduce_waveform(&audio(vec![[f32::MIN, f32::MAX]], u32::MAX, 2), 1).unwrap();
    assert_eq!(finite.peaks[0].min, [f32::MIN, f32::MAX]);
    assert_eq!(finite.peaks[0].max, [f32::MIN, f32::MAX]);
    assert_eq!(finite.duration_ms, 1000.0 / u32::MAX as f64);

    for buckets in [0, 8193, usize::MAX] {
        assert!(reduce_waveform(&audio(vec![[0.0; 2]], 1000, 2), buckets).is_err());
    }
    assert!(reduce_waveform(&audio(vec![], 1000, 2), 1).is_err());
    assert!(reduce_waveform(&audio(vec![[0.0; 2]], 0, 2), 1).is_err());
    for channels in [0, 3, u16::MAX] {
        assert!(reduce_waveform(&audio(vec![[0.0; 2]], 1000, channels), 1).is_err());
    }
    for sample in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        for channels in [1, 2] {
            for channel in 0..2 {
                let mut frames = vec![[0.0; 2]; 5];
                // Put invalid PCM in the final remainder, after otherwise valid buckets.
                frames[4][channel] = sample;
                assert!(reduce_waveform(&audio(frames, 1000, channels), 2).is_err());
            }
        }
    }
}

fn fixture_plan(fixtures: &Value, name: &str) -> PlaybackPlan {
    let timeline = &fixtures["timelines"][name];
    serde_json::from_value(json!({
        "generation": timeline["generation"],
        "ppq": 960,
        "durationTick": timeline["durationTick"],
        "durationMs": timeline["occurrences"].as_array().unwrap().last().unwrap()["endMs"],
        "tracks": [{"id": "fixture", "program": 0, "percussion": false}],
        "tempos": timeline["tempos"],
        "occurrences": timeline["occurrences"],
        "notes": [],
        "midi": []
    }))
    .unwrap()
}

#[test]
fn backing_map_matches_shared_visual_fixtures() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../tests/backing-timeline-mapping.json")).unwrap();
    let tolerance = fixtures["toleranceMs"].as_f64().unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let plan = fixture_plan(&fixtures, case["timeline"].as_str().unwrap());
        let timeline = Timeline::new(&plan).unwrap();
        let anchors: Vec<SyncAnchor> =
            serde_json::from_value(case["backing"]["anchors"].clone()).unwrap();
        let before = anchors.clone();
        let map = BackingMap::new(
            &anchors,
            case["backing"]["offsetMs"].as_f64().unwrap(),
            &plan,
        )
        .unwrap();
        for sample in case["samples"].as_array().unwrap() {
            let score_seconds = timeline.tick_to_seconds(sample["tick"].as_f64().unwrap());
            let expected_ms = sample["sourceMs"].as_f64().unwrap();
            assert!(
                (map.source_seconds(score_seconds) * 1000.0 - expected_ms).abs() <= tolerance,
                "{} sample {sample}",
                case["name"]
            );
            assert!(
                (map.score_seconds(expected_ms / 1000.0) - score_seconds).abs() * 1000.0
                    <= tolerance,
                "{} inverse sample {sample}",
                case["name"]
            );
        }
        assert_eq!(anchors, before, "{} must preserve anchors", case["name"]);
    }
    for case in fixtures["invalidMaps"].as_array().unwrap() {
        let plan = fixture_plan(&fixtures, case["timeline"].as_str().unwrap());
        let anchors: Vec<SyncAnchor> =
            serde_json::from_value(case["backing"]["anchors"].clone()).unwrap();
        let before = anchors.clone();
        assert!(
            BackingMap::new(
                &anchors,
                case["backing"]["offsetMs"].as_f64().unwrap(),
                &plan,
            )
            .is_err(),
            "{} must reject",
            case["name"]
        );
        assert_eq!(anchors, before);
    }
    for case in fixtures["moves"].as_array().unwrap() {
        let source_ms = case["sourceMs"].as_f64().unwrap();
        let duration_ms = case["durationMs"].as_f64().unwrap();
        // Source-window bounds belong to the TS move operation, not BackingMap.
        if !(0.0..=duration_ms).contains(&source_ms) {
            continue;
        }
        let plan = fixture_plan(&fixtures, case["timeline"].as_str().unwrap());
        let timeline = Timeline::new(&plan).unwrap();
        let anchors: Vec<SyncAnchor> =
            serde_json::from_value(case["backing"]["anchors"].clone()).unwrap();
        let before = anchors.clone();
        let mut candidate = anchors.clone();
        let index = case["index"].as_u64().unwrap() as usize;
        let offset = case["backing"]["offsetMs"].as_f64().unwrap();
        candidate[index].audio_ms = if case["reject"] == true {
            source_ms + offset
        } else {
            // This literal stored coordinate is the independent shared oracle.
            case["expectedAudioMs"].as_f64().unwrap()
        };
        let result = BackingMap::new(&candidate, offset, &plan);
        if case["reject"] == true {
            assert!(result.is_err(), "{} must reject map", case["name"]);
        } else {
            let map = result.unwrap();
            let anchor = &candidate[index];
            let occurrence = plan
                .occurrences
                .iter()
                .find(|row| row.bar == anchor.bar && row.occurrence == anchor.occurrence)
                .unwrap();
            let tick = occurrence.start_tick
                + (occurrence.end_tick - occurrence.start_tick) * anchor.ratio;
            let mapped_ms = map.source_seconds(timeline.tick_to_seconds(tick)) * 1000.0;
            assert!(
                (mapped_ms - source_ms).abs() <= tolerance,
                "{} moved coordinate {mapped_ms}",
                case["name"]
            );
        }
        assert_eq!(anchors, before, "{} must preserve identities", case["name"]);
    }
}
