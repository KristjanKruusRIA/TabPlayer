use serde_json::{Value, json};
use std::{
    io::Cursor,
    sync::{Arc, OnceLock},
};
use tabplayer_lib::{
    audio::{
        backing::{BackingMap, BackingVoice},
        decode::DecodedAudio,
        device::{CallbackTransport, PracticePhase, TransportCommand},
        plan::{PlanTempo, PlaybackPlan},
        reference_sync::ReferenceSyncMap,
        renderer::Renderer,
        resources::AudioResources,
    },
    export::{
        audio::{AudioExportRender, AudioExportRequest, MeasureRange, RenderSchedule},
        stems::{StemKind, StemTrack},
        wav::AudioFormat,
    },
    settings::{BackingSettings, DocumentSettings},
};

fn resources() -> Arc<AudioResources> {
    static RESOURCES: OnceLock<Arc<AudioResources>> = OnceLock::new();
    RESOURCES
        .get_or_init(|| {
            Arc::new(AudioResources {
                manifest: Default::default(),
                samples: Default::default(),
                sound_font: Arc::new(
                    rustysynth::SoundFont::new(&mut Cursor::new(
                        std::fs::read(concat!(
                            env!("CARGO_MANIFEST_DIR"),
                            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
                        ))
                        .unwrap(),
                    ))
                    .unwrap(),
                ),
            })
        })
        .clone()
}

fn settings(value: &Value) -> BackingSettings {
    let mut value = value.clone();
    value["assetId"] = json!("reference");
    value["mix"] = json!({"gain":1,"pan":0,"mute":false,"solo":false});
    serde_json::from_value(value).unwrap()
}

fn fixture_plan(case: &Value) -> PlaybackPlan {
    let segments = case["expected"]["segments"].as_array().unwrap();
    let seconds = |tick: f64| {
        let mut time = tick.min(segments[0]["startTick"].as_f64().unwrap()) * 60.0
            / (960.0 * segments[0]["bpm"].as_f64().unwrap());
        for segment in segments {
            let start = segment["startTick"].as_f64().unwrap();
            let end = segment["endTick"].as_f64().unwrap();
            time += (tick.min(end) - start).max(0.0) * 60.0
                / (960.0 * segment["bpm"].as_f64().unwrap());
        }
        let last = segments.last().unwrap();
        time + (tick - last["endTick"].as_f64().unwrap()).max(0.0) * 60.0
            / (960.0 * last["bpm"].as_f64().unwrap())
    };
    let locations = case["locations"].as_array().unwrap();
    let end = locations.last().unwrap()["endTick"].as_f64().unwrap();
    let duration = case["durationTick"].as_f64().unwrap_or(end);
    let mut tempos = vec![json!({"tick":0,"bpm":segments[0]["bpm"]})];
    for segment in segments.iter().skip(1) {
        tempos.push(json!({"tick":segment["startTick"],"bpm":segment["bpm"]}));
    }
    let occurrences: Vec<_> = locations
        .iter()
        .map(|location| {
            json!({
                "bar":location["bar"],"occurrence":location["occurrence"],
                "meterNumerator":case["meter"]["numerator"].as_u64().unwrap_or(4),
                "meterDenominator":case["meter"]["denominator"].as_u64().unwrap_or(4),
                "startTick":location["startTick"],"endTick":location["endTick"],
                "startMs":seconds(location["startTick"].as_f64().unwrap())*1000.0,
                "endMs":seconds(location["endTick"].as_f64().unwrap())*1000.0
            })
        })
        .collect();
    serde_json::from_value(json!({"generation":1,"ppq":960,"durationTick":duration,"durationMs":seconds(duration)*1000.0,
        "playbackEndTick":end,"tracks":[{"id":"gm","program":0,"percussion":false}],
        "tempos":tempos,"occurrences":occurrences,"notes":[],"midi":[]})).unwrap()
}

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../tests/reference-sync-timing.json")).unwrap()
}

#[test]
fn literal_reference_routes_accept_independently_authored_effective_clock() {
    let fixture = fixtures();
    let mut count = 0;
    for case in fixture["timingCases"].as_array().unwrap() {
        if case["backing"]["referenceSync"].is_null() {
            continue;
        }
        let plan = fixture_plan(case);
        plan.validate().unwrap();
        let map = ReferenceSyncMap::new(&settings(&case["backing"]), &plan)
            .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
        for sample in case["expected"]["sourceSamples"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let seconds = sample["elapsedMs"].as_f64().unwrap() / 1000.0;
            assert!(
                (map.source_seconds(seconds) * 1000.0 - sample["sourceMs"].as_f64().unwrap()).abs()
                    < 1e-7,
                "{}",
                case["name"]
            );
        }
        count += 1;
    }
    assert!(count >= 10);
}

#[test]
fn active_end_controls_omitted_backing_seek_and_export_wall_tail() {
    let fixture = fixtures();
    let case = fixture["timingCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "initial-grace-pre-roll-and-note-extent-tail")
        .unwrap();
    let plan = Arc::new(fixture_plan(case));
    let mut renderer = Renderer::new(
        plan.clone(),
        resources(),
        DocumentSettings::default(),
        48_000,
    )
    .unwrap();
    assert_eq!(renderer.duration_tick(), 3960.0);
    assert!((renderer.duration_seconds() - 2.0625).abs() < 1e-12);
    renderer.seek_tick(4440.0);
    assert_eq!(renderer.position().tick, 3960.0);
    for (speed, expected) in [(1.0, 123_000), (0.5, 222_000)] {
        let schedule = RenderSchedule::new(&plan, None, 48_000, speed, 0.5, 99.0).unwrap();
        assert_eq!(schedule.total_frames, expected);
        assert_eq!(schedule.segments[0].end_tick, 3960.0);
    }
}

#[test]
fn rejects_forged_tempo_even_when_integrated_pin_times_agree() {
    let fixture = fixtures();
    let case = fixture["timingCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "initial-grace-pre-roll-and-note-extent-tail")
        .unwrap();
    let mut plan = fixture_plan(case);
    // Grace + first half at 240 and second half at a compensating tempo.
    // Keep all pin times intact, so only the per-span BPM proof rejects it.
    plan.tempos = vec![
        PlanTempo {
            tick: 0.0,
            bpm: 120.0,
        },
        PlanTempo {
            tick: 120.0,
            bpm: 240.0,
        },
        PlanTempo {
            tick: 2040.0,
            bpm: 80.0,
        },
        PlanTempo {
            tick: 3960.0,
            bpm: 120.0,
        },
    ];
    plan.validate().unwrap();
    assert!(ReferenceSyncMap::new(&settings(&case["backing"]), &plan).is_err());
}

fn first_case() -> Value {
    fixtures()["timingCases"][0].clone()
}
fn audio(rate: u32, frames: Vec<[f32; 2]>) -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: rate,
        channels: 2,
        frames: Arc::new(frames),
    })
}

#[test]
fn reference_impulses_advance_linearly_at_both_speeds_and_ignore_excluded_pcm() {
    let case = first_case();
    let plan = fixture_plan(&case);
    for rate in [44_100, 48_000] {
        let mut pcm = vec![[0.0; 2]; rate as usize * 8];
        for second in [1, 3, 4, 6] {
            pcm[rate as usize * second] = [0.7, 0.35];
        }
        let mut excluded = pcm.clone();
        excluded[rate as usize - 1] = [1.0; 2];
        excluded[rate as usize * 7] = [1.0; 2];
        for speed in [1.0, 0.5] {
            let mut clean = BackingVoice::new(
                audio(rate, pcm.clone()),
                BackingMap::from_settings(&settings(&case["backing"]), &plan).unwrap(),
                rate,
            )
            .unwrap();
            let mut dirty = BackingVoice::new(
                audio(rate, excluded.clone()),
                BackingMap::from_settings(&settings(&case["backing"]), &plan).unwrap(),
                rate,
            )
            .unwrap();
            let frames = (6.1 * rate as f64 / speed).ceil() as usize;
            let output: Vec<_> = (0..frames)
                .map(|i| {
                    let t = i as f64 * speed / rate as f64;
                    let a = clean.next_frame(t);
                    assert_eq!(
                        a,
                        dirty.next_frame(t),
                        "excluded PCM at rate {rate} speed {speed} frame {i}"
                    );
                    a
                })
                .collect();
            for second in [0.0, 2.0, 3.0, 5.0] {
                let frame = (second * rate as f64 / speed).ceil() as usize;
                assert!(
                    output[frame..=frame + 1].iter().any(|x| x[0] > 0.6),
                    "missing impulse {second} rate {rate} speed {speed}"
                );
            }
            assert!(
                output[(6.0 * rate as f64 / speed).ceil() as usize..]
                    .iter()
                    .all(|x| *x == [0.0; 2])
            );
            clean.seek(3.0);
            let first = clean.next_frame(3.0);
            clean.seek(3.0);
            assert_eq!(first, clean.next_frame(3.0));
        }
    }
}

#[test]
fn reference_sine_preserves_pitch_and_grace_stays_silent() {
    let fixture = fixtures();
    let case = fixture["timingCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "initial-grace-pre-roll-and-note-extent-tail")
        .unwrap();
    let plan = fixture_plan(case);
    let rate = 48_000;
    let pcm = audio(
        rate,
        (0..rate * 6)
            .map(|i| {
                [(std::f64::consts::TAU * 440.0 * i as f64 / rate as f64).sin() as f32 * 0.2; 2]
            })
            .collect(),
    );
    for speed in [1.0, 0.5] {
        let mut voice = BackingVoice::new(
            pcm.clone(),
            BackingMap::from_settings(&settings(&case["backing"]), &plan).unwrap(),
            rate,
        )
        .unwrap();
        let output: Vec<_> = (0..(rate as f64 * 2.2 / speed) as usize)
            .map(|i| voice.next_frame(i as f64 * speed / rate as f64))
            .collect();
        assert!(
            output[..(0.0625 * rate as f64 / speed) as usize]
                .iter()
                .all(|x| *x == [0.0; 2])
        );
        let start = (0.25 * rate as f64 / speed) as usize;
        let n = rate as usize;
        let crossings = output[start..start + n]
            .windows(2)
            .filter(|w| w[0][0] <= 0.0 && w[1][0] > 0.0)
            .count();
        assert!(
            (crossings as f64 - 440.0).abs() <= 2.0,
            "speed {speed}: {crossings}"
        );
        assert!(
            output[(2.0625 * rate as f64 / speed).ceil() as usize..]
                .iter()
                .all(|x| *x == [0.0; 2])
        );
    }
}

#[test]
fn exact_decoded_eof_uses_the_waveform_millisecond_coordinate() {
    for (rate, frames) in [(44_100, 44_112), (48_000, 48_022)] {
        let duration_ms = 1000.0 * frames as f64 / rate as f64;
        let bpm = 240_000.0 / duration_ms;
        let case = json!({"locations":[{"bar":0,"occurrence":0,"startTick":0,"endTick":3840}],"backing":{"offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":0,"exitAudioMs":duration_ms}},"expected":{"segments":[{"startTick":0,"endTick":3840,"bpm":bpm}]}});
        let map = ReferenceSyncMap::new(&settings(&case["backing"]), &fixture_plan(&case)).unwrap();
        assert!(
            map.validate_audio(&audio(rate, vec![[0.0; 2]; frames]))
                .is_ok(),
            "exact {frames}/{rate} EOF"
        );
        assert!(
            map.validate_audio(&audio(rate, vec![[0.0; 2]; frames - 1]))
                .is_err()
        );
    }
}

#[test]
fn actual_decoded_eof_and_collapsed_physical_pin_intervals_reject() {
    let case = first_case();
    let plan = fixture_plan(&case);
    let map = ReferenceSyncMap::new(&settings(&case["backing"]), &plan).unwrap();
    assert!(
        map.validate_audio(&audio(48_000, vec![[0.0; 2]; 336_000]))
            .is_ok()
    );
    assert!(
        map.validate_audio(&audio(48_000, vec![[0.0; 2]; 335_999]))
            .is_err()
    );
    let backing = settings(
        &json!({"offsetMs":-1e20,"anchors":[{"bar":0,"occurrence":0,"ratio":0.25,"audioMs":1},{"bar":0,"occurrence":0,"ratio":0.5,"audioMs":2}],"referenceSync":{"entryAudioMs":-100_000,"exitAudioMs":100_000}}),
    );
    backing.validate().unwrap();
    assert!(ReferenceSyncMap::new(&backing, &plan).is_err());
}

#[test]
fn rejects_shared_invalid_routes_and_underflowed_canonical_rate() {
    for case in fixtures()["invalidCases"].as_array().unwrap() {
        let backing = settings(&case["backing"]);
        if case["operation"] == "validateLegacySettings" {
            assert!(backing.validate().is_err());
            continue;
        }
        if case["sourceDurationMs"].is_number() {
            continue;
        } // decoded EOF is tested against actual frames above
        let locations = case["locations"].as_array().unwrap();
        let end = locations
            .last()
            .map_or(0.0, |o| o["endTick"].as_f64().unwrap());
        let occurrences:Vec<_>=locations.iter().map(|o|json!({"bar":o["bar"],"occurrence":o["occurrence"],"meterNumerator":4,"meterDenominator":4,"startTick":o["startTick"],"endTick":o["endTick"],"startMs":o["startTick"].as_f64().unwrap()/1.92,"endMs":o["endTick"].as_f64().unwrap()/1.92})).collect();
        let plan:PlaybackPlan=serde_json::from_value(json!({"generation":1,"ppq":960,"durationTick":end,"durationMs":end/1.92,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":occurrences,"notes":[],"midi":[]})).unwrap();
        let mut plan = plan;
        plan.playback_end_tick = Some(end);
        assert!(
            ReferenceSyncMap::new(&backing, &plan).is_err(),
            "{}",
            case["name"]
        );
    }
    let backing = settings(
        &json!({"offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":0,"exitAudioMs":1e-304}}),
    );
    let plan:PlaybackPlan=serde_json::from_value(json!({"generation":1,"ppq":960,"durationTick":1,"durationMs":1e-304,"playbackEndTick":1,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":6.25e305}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":1,"startMs":0,"endMs":1e-304}],"notes":[],"midi":[]})).unwrap();
    plan.validate().unwrap();
    assert!(ReferenceSyncMap::new(&backing, &plan).is_err());
}

#[test]
fn omitted_backing_mix_export_obeys_active_wall_duration_and_tail() {
    let case = first_case();
    let plan = Arc::new(fixture_plan(&case));
    for speed in [1.0, 0.5] {
        let renderer = Renderer::new(
            plan.clone(),
            resources(),
            DocumentSettings::default(),
            48_000,
        )
        .unwrap();
        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "gm".into(),
                name: "Score".into(),
                preset: "gm".into(),
                kind: StemKind::Score,
            }],
            range: None,
            format: AudioFormat::wav(48_000, 24),
            speed,
            metronome: false,
            tail_seconds: 0.5,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        };
        let mut export = AudioExportRender::new(renderer, &plan, request).unwrap();
        let mut total = 0;
        loop {
            let n = export.render_mix(&mut [[0.0; 2]; 512]).unwrap();
            if n == 0 {
                break;
            }
            total += n as u64;
        }
        assert_eq!(total, ((6.0 / speed + 0.5) * 48_000.0).round() as u64);
    }
}

#[test]
fn headless_ranges_loops_and_live_duration_use_active_exit() {
    let mut case = first_case();
    case["durationTick"] = json!(8640);
    let plan = Arc::new(fixture_plan(&case));
    let mut renderer = Renderer::new(
        plan.clone(),
        resources(),
        DocumentSettings::default(),
        48_000,
    )
    .unwrap();
    let mut backing = settings(&case["backing"]);
    backing.mix.mute = true;
    renderer
        .install_backing(
            audio(48_000, vec![[0.1; 2]; 48_000 * 60]),
            BackingMap::from_settings(&backing, &plan).unwrap(),
            backing.mix,
        )
        .unwrap();
    assert_eq!(renderer.duration_seconds(), 6.0);
    let mut transport = CallbackTransport::headless(48_000);
    transport.install(Box::new(renderer), 1, false);
    for command in [
        TransportCommand::PlayRange {
            generation: 1,
            start_tick: 0.0,
            end_tick: Some(7681.0),
        },
        TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 7681.0,
        },
    ] {
        assert!(transport.command(command).is_err());
    }
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.render_into(&mut vec![[0.0; 2]; 48_000 * 7]);
    assert_eq!(transport.status().practice.phase, PracticePhase::Ended);
    assert_eq!(transport.status().tick, 7680.0);
}

#[test]
fn effective_whole_and_selected_exports_share_wall_tail_with_or_without_backing() {
    let case = first_case();
    let plan = Arc::new(fixture_plan(&case));
    for rate in [44_100, 48_000] {
        for speed in [1.0, 0.5] {
            for included in [true, false] {
                for range in [None, Some(MeasureRange { first: 1, last: 1 })] {
                    let mut renderer =
                        Renderer::new(plan.clone(), resources(), DocumentSettings::default(), rate)
                            .unwrap();
                    if included {
                        let backing = settings(&case["backing"]);
                        renderer
                            .install_backing(
                                audio(rate, vec![[0.1; 2]; rate as usize * 8]),
                                BackingMap::from_settings(&backing, &plan).unwrap(),
                                backing.mix,
                            )
                            .unwrap();
                    }
                    let request = AudioExportRequest {
                        tracks: vec![StemTrack {
                            id: "gm".into(),
                            name: "Score".into(),
                            preset: "gm".into(),
                            kind: StemKind::Score,
                        }],
                        range,
                        format: AudioFormat::wav(rate, 24),
                        speed,
                        metronome: false,
                        tail_seconds: 0.5,
                        include_backing: included,
                        include_mix: true,
                        normalize_rms_db: None,
                    };
                    let mut export = AudioExportRender::new(renderer, &plan, request).unwrap();
                    let body = if range.is_some() { 4.0 } else { 6.0 };
                    assert_eq!(
                        export.total_frames(),
                        ((body / speed + 0.5) * rate as f64).round() as u64
                    );
                    let mut outputs = vec![vec![[0.0; 2]; 4096]; if included { 3 } else { 2 }];
                    let mut total = 0;
                    loop {
                        let n = export.render_stems(&mut outputs).unwrap();
                        if n == 0 {
                            break;
                        }
                        if total >= ((body / speed) * rate as f64).round() as u64 {
                            assert!(
                                outputs
                                    .iter()
                                    .all(|o| o[..n].iter().all(|x| *x == [0.0; 2]))
                            );
                        }
                        total += n as u64;
                    }
                    assert_eq!(total, export.total_frames());
                }
            }
        }
    }
}

#[test]
fn reference_ranges_and_loops_keep_pcm_source_clock_across_tempo_change() {
    use tabplayer_lib::audio::{device::PracticeSettings, practice::PracticeTempo};

    let case = first_case();
    let plan = Arc::new(fixture_plan(&case));
    for rate in [44_100, 48_000] {
        let mut pcm = vec![[0.0; 2]; rate as usize * 8];
        for second in [2, 3, 4] {
            pcm[rate as usize * second] = [0.7, 0.35];
        }
        for second in [1, 5, 6] {
            pcm[rate as usize * second] = [0.35, 0.7];
        }
        for speed in [1.0, 0.5] {
            for looping in [false, true] {
                let mut renderer =
                    Renderer::new(plan.clone(), resources(), DocumentSettings::default(), rate)
                        .unwrap();
                let backing = settings(&case["backing"]);
                renderer
                    .install_backing(
                        audio(rate, pcm.clone()),
                        BackingMap::from_settings(&backing, &plan).unwrap(),
                        backing.mix,
                    )
                    .unwrap();
                let mut transport = CallbackTransport::headless(rate);
                transport.install_with_practice(
                    Box::new(renderer),
                    1,
                    false,
                    PracticeSettings {
                        tempo: PracticeTempo::Relative { ratio: speed },
                        ..Default::default()
                    },
                );
                // Ticks 1920..5760 span effective seconds 1..4 across the 120->60
                // step, so reference source seconds 2/3/4 play, but 5 is excluded.
                let command = if looping {
                    TransportCommand::SetLoop {
                        generation: 1,
                        start_tick: 1920.0,
                        end_tick: 5760.0,
                    }
                } else {
                    TransportCommand::PlayRange {
                        generation: 1,
                        start_tick: 1920.0,
                        end_tick: Some(5760.0),
                    }
                };
                transport.command(command).unwrap();
                if looping {
                    transport
                        .command(TransportCommand::Play { generation: 1 })
                        .unwrap();
                }
                let interval = (rate as f64 / speed) as usize;
                let mut output = vec![[0.0; 2]; if looping { 6 } else { 3 } * interval + 512];
                let mut offset = 0;
                for size in [127, 511, 1024].into_iter().cycle() {
                    let end = (offset + size).min(output.len());
                    transport.render_into(&mut output[offset..end]);
                    offset = end;
                    if offset == output.len() {
                        break;
                    }
                }
                let attacks: Vec<_> = output
                    .iter()
                    .enumerate()
                    .filter(|(_, sample)| sample[0] > 0.2)
                    .collect();
                assert_eq!(
                    attacks.len(),
                    if looping { 7 } else { 3 },
                    "rate {rate} speed {speed} looping {looping}"
                );
                for (index, (frame, sample)) in attacks.into_iter().enumerate() {
                    assert!(
                        frame.abs_diff(index * interval) <= 1,
                        "attack {index} frame {frame} rate {rate} speed {speed} looping {looping}"
                    );
                    assert!(
                        (sample[0] - 2.0 * sample[1]).abs() < 1e-6,
                        "wrong source impulse at frame {frame} rate {rate} speed {speed} looping {looping}"
                    );
                }
                let status = transport.status();
                if looping {
                    assert!(status.playing);
                    assert_eq!(status.practice.completed_passes, 2);
                    assert!(
                        (status.tick - (1920.0 + 512.0 * speed * 1920.0 / rate as f64)).abs()
                            < 1e-6
                    );
                } else {
                    assert_eq!(status.practice.phase, PracticePhase::Ended);
                    assert_eq!(status.tick, 5760.0);
                    assert!(output[3 * interval..].iter().all(|x| *x == [0.0; 2]));
                }
            }
        }
    }
}
