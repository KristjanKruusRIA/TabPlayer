use std::sync::Arc;
use tabplayer_lib::{
    audio::{
        backing::{BackingMap, BackingVoice},
        decode::DecodedAudio,
        plan::PlaybackPlan,
    },
    settings::{BackingFilter, BackingProcessing},
};
fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":23040,"durationMs":12000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":23040,"startMs":0,"endMs":12000}],"notes":[],"midi":[]})).unwrap()
}
fn tone(rate: u32) -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: rate,
        channels: 2,
        frames: Arc::new(
            (0..rate * 12)
                .map(|n| {
                    let s = (std::f64::consts::TAU * 440.0 * n as f64 / rate as f64).sin() as f32
                        * 0.05;
                    [s, -s]
                })
                .collect(),
        ),
    })
}
fn render(
    audio: Arc<DecodedAudio>,
    rate: u32,
    speed: f64,
    semitones: f64,
    cents: f64,
) -> Vec<[f32; 2]> {
    let processing = BackingProcessing {
        semitones,
        cents,
        filter: BackingFilter::None,
    };
    let mut voice = BackingVoice::new_with_processing(
        audio,
        BackingMap::new(&[], 0.0, &plan()).unwrap(),
        rate,
        processing,
    )
    .unwrap();
    (0..rate * 3)
        .map(|n| voice.next_frame(n as f64 / rate as f64 * speed))
        .collect()
}
fn frequency(x: &[[f32; 2]], rate: u32) -> f64 {
    let crossings: Vec<f64> = x
        .windows(2)
        .enumerate()
        .filter_map(|(i, w)| {
            if w[0][0] <= 0.0 && w[1][0] > 0.0 {
                Some(i as f64 - w[0][0] as f64 / (w[1][0] - w[0][0]) as f64)
            } else {
                None
            }
        })
        .collect();
    (crossings.len() - 1) as f64 * rate as f64 / (crossings.last().unwrap() - crossings[0])
}
#[test]
fn literal_pitch_targets_preserve_stereo_at_rates_and_speeds() {
    for source_rate in [44100, 48000] {
        let audio = tone(source_rate);
        for rate in [44100, 48000] {
            for speed in [0.1, 1.23, 3.0] {
                for (semitones, cents, target) in [
                    (12., 0., 880.),
                    (-12., 0., 220.),
                    (1., 0., 466.1637615),
                    (0., 50., 452.8929841),
                    (0., -50., 427.4740541),
                    (12., 100., 932.327523),
                    (-12., -100., 207.6523488),
                ] {
                    let x = render(audio.clone(), rate, speed, semitones, cents);
                    let actual = frequency(&x[rate as usize..], rate);
                    assert!(
                        (actual - target).abs() <= 1.0_f64.max(target * 0.003),
                        "source={source_rate} rate={rate} speed={speed} pitch={semitones}/{cents}: {actual} expected {target}"
                    );
                    assert!(x.iter().all(|x| x[0] == -x[1]));
                    assert_eq!(x.len(), rate as usize * 3);
                }
            }
        }
    }
}
#[test]
fn equivalent_pairs_and_cancellation_are_exact() {
    let audio = tone(48000);
    assert_eq!(
        render(audio.clone(), 48000, 1.23, 1., -50.),
        render(audio.clone(), 48000, 1.23, 0., 50.)
    );
    assert_eq!(
        render(audio.clone(), 48000, 1.23, -1., 100.),
        render(audio, 48000, 1.23, 0., 0.)
    );
}

#[test]
fn voice_filter_changes_pcm_and_resets_at_excluded_eof_and_seek() {
    let rate = 48000;
    let audio = Arc::new(DecodedAudio {
        sample_rate: rate,
        channels: 2,
        frames: Arc::new(
            (0..rate)
                .map(|n| {
                    let s =
                        (std::f64::consts::TAU * 80. * n as f64 / rate as f64).sin() as f32 * 0.05;
                    [s, 0.]
                })
                .collect(),
        ),
    });
    let map = BackingMap::new(&[], 0., &plan()).unwrap();
    let mut neutral = BackingVoice::new(audio.clone(), map.clone(), rate).unwrap();
    let mut filtered = BackingVoice::new_with_processing(
        audio,
        map,
        rate,
        BackingProcessing {
            semitones: 0.,
            cents: 0.,
            filter: BackingFilter::BassEnhance,
        },
    )
    .unwrap();
    let mut dry = 0.;
    let mut wet = 0.;
    for n in 0..rate {
        let t = n as f64 / rate as f64;
        let a = neutral.next_frame(t);
        let b = filtered.next_frame(t);
        assert_eq!(b[1], 0.);
        if n > rate / 2 {
            dry += a[0] as f64 * a[0] as f64;
            wet += b[0] as f64 * b[0] as f64;
        }
    }
    let db = 10. * (wet / dry).log10();
    assert!((4.0..7.0).contains(&db), "voice filter response {db}");
    assert_eq!(filtered.next_frame(1.), [0.; 2]);
    assert_eq!(filtered.next_frame(f64::NAN), [0.; 2]);
    filtered.seek(0.5);
    let a: Vec<_> = (0..1000)
        .map(|n| filtered.next_frame(0.5 + n as f64 / rate as f64))
        .collect();
    filtered.seek(0.5);
    let b: Vec<_> = (0..1000)
        .map(|n| filtered.next_frame(0.5 + n as f64 / rate as f64))
        .collect();
    assert_eq!(a, b);
}
#[test]
fn fractional_bracket_sentinels_never_enter_processed_voice() {
    use tabplayer_lib::settings::BackingSettings;
    for rate in [44100, 48000] {
        let mut p = plan();
        p.duration_tick = 1920.;
        p.duration_ms = 1000.;
        p.playback_end_tick = Some(1920.);
        p.occurrences[0].end_tick = 1920.;
        p.occurrences[0].end_ms = 1000.;
        let entry = rate as usize / 2;
        let exit = entry + rate as usize;
        let settings:BackingSettings=serde_json::from_value(serde_json::json!({"assetId":"a","offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":1000.0*(entry as f64+0.5)/rate as f64,"exitAudioMs":1000.0*(exit as f64+0.5)/rate as f64},"mix":{"gain":1,"pan":0,"mute":false,"solo":false}})).unwrap();
        let mut clean = vec![[0.; 2]; rate as usize * 2];
        for n in entry + 1..=exit {
            let s = (std::f64::consts::TAU * 440. * n as f64 / rate as f64).sin() as f32 * 0.04;
            clean[n] = [s, s];
        }
        clean[entry + 2] = [0.7; 2];
        clean[exit - 1] = [0.7; 2];
        let mut dirty = clean.clone();
        for n in 0..dirty.len() {
            if n <= entry || n > exit {
                dirty[n] = if n % 2 == 0 {
                    [0.95, -0.95]
                } else {
                    [-0.8, 0.8]
                };
            }
        }
        let audio = |frames| {
            Arc::new(DecodedAudio {
                sample_rate: rate,
                channels: 2,
                frames: Arc::new(frames),
            })
        };
        for speed in [0.1, 1.23, 3.] {
            for pitch in [-12., 12.] {
                let proc = BackingProcessing {
                    semitones: pitch,
                    cents: 100.,
                    filter: BackingFilter::HighEnhance,
                };
                let map = BackingMap::from_settings(&settings, &p).unwrap();
                let gate_map = map.clone();
                let mut a = BackingVoice::new_with_processing(
                    audio(clean.clone()),
                    map.clone(),
                    rate,
                    proc.clone(),
                )
                .unwrap();
                let mut b =
                    BackingVoice::new_with_processing(audio(dirty.clone()), map, rate, proc)
                        .unwrap();
                for start in [-1. / rate as f64, 0., 0.99, 1.] {
                    a.seek(start);
                    b.seek(start);
                    for n in 0..4096 {
                        let t = start + n as f64 / rate as f64 * speed;
                        let x = a.next_frame(t);
                        let y = b.next_frame(t);
                        assert_eq!(x, y, "rate={rate} speed={speed} pitch={pitch} t={t}");
                        let mapped = gate_map.source_seconds(t);
                        let bounds = settings.reference_sync.as_ref().unwrap();
                        if mapped < bounds.entry_audio_ms / 1000.
                            || mapped >= bounds.exit_audio_ms / 1000.
                        {
                            assert_eq!(
                                x, [0.; 2],
                                "outside t={t:.20} rate={rate} start={start} speed={speed}"
                            );
                        }
                    }
                }
            }
        }
    }
}
fn resources() -> Arc<tabplayer_lib::audio::resources::AudioResources> {
    Arc::new(
        tabplayer_lib::audio::resources::AudioResources::load_for_requests(
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .unwrap(),
    )
}
#[test]
fn shared_core_mix_stems_score_clock_and_tail_agree() {
    use tabplayer_lib::{
        audio::{plan::PlanMidiEvent, renderer::Renderer},
        settings::{ChannelMix, DocumentSettings},
    };
    let mut p = plan();
    p.midi = vec![
        PlanMidiEvent::NoteOn {
            track_id: "gm".into(),
            tick: 0.,
            channel: 0,
            key: 60,
            velocity: 70,
            kit_element: None,
        },
        PlanMidiEvent::NoteOff {
            track_id: "gm".into(),
            tick: 1920.,
            channel: 0,
            key: 60,
            velocity: 0,
            kit_element: None,
        },
    ];
    let p = Arc::new(p);
    let res = resources();
    for rate in [44100, 48000] {
        for speed in [0.1, 1.23, 3.] {
            let build = |processing: Option<BackingProcessing>| {
                let mut r =
                    Renderer::new(p.clone(), res.clone(), DocumentSettings::default(), rate)
                        .unwrap();
                if let Some(processing) = processing {
                    r.install_processed_backing(
                        tone(44100),
                        BackingMap::new(&[], 0., &p).unwrap(),
                        ChannelMix::default(),
                        processing,
                    )
                    .unwrap();
                }
                r.set_speed(speed).unwrap();
                r
            };
            let processing = BackingProcessing {
                semitones: 12.,
                cents: 100.,
                filter: BackingFilter::MediumAttenuation,
            };
            let mut live = build(Some(processing.clone()));
            let mut stems = build(Some(processing));
            let mut score_only = build(None);
            let len = rate as usize;
            let mut mix = vec![[0.; 2]; len];
            let mut stem_mix = mix.clone();
            let mut score = mix.clone();
            let mut backing = mix.clone();
            let mut score_alone = mix.clone();
            let a = live.render_into(&mut mix);
            let b = stems.render_stems_and_mix_into(&mut [&mut score, &mut backing], &mut stem_mix);
            score_only.render_stems_into(&mut [&mut score_alone]);
            assert_eq!(mix, stem_mix);
            assert_eq!(score, score_alone);
            assert!(score.iter().any(|x| x[0].abs() > 0.001));
            assert_eq!(a.tick, b.tick);
            assert!((a.tick - 1920. * speed).abs() < 1e-6);
            assert_eq!(live.duration_seconds(), 12.);
            let hz = frequency(&backing[rate as usize / 3..], rate);
            assert!((hz - 932.327523).abs() < 932.327523 * 0.003, "{hz}");
            stems.begin_tail();
            stems.render_stems_into(&mut [&mut score[..1000], &mut backing[..1000]]);
            assert!(backing[..1000].iter().all(|x| *x == [0.; 2]));
        }
    }
}
#[test]
fn processed_stereo_patterns_and_old_constructor_are_exact() {
    for rate in [44100, 48000] {
        for pattern in [[1., 1.], [1., -1.], [1., 0.], [0., 1.]] {
            let source = tone(rate);
            let audio = Arc::new(DecodedAudio {
                sample_rate: rate,
                channels: 2,
                frames: Arc::new(
                    source
                        .frames
                        .iter()
                        .map(|x| [x[0] * pattern[0], x[0] * pattern[1]])
                        .collect(),
                ),
            });
            let map = BackingMap::new(&[], 0., &plan()).unwrap();
            let mut old = BackingVoice::new(audio.clone(), map.clone(), rate).unwrap();
            let mut cancel = BackingVoice::new_with_processing(
                audio.clone(),
                map.clone(),
                rate,
                BackingProcessing {
                    semitones: -1.,
                    cents: 100.,
                    filter: BackingFilter::None,
                },
            )
            .unwrap();
            let mut pitched = BackingVoice::new_with_processing(
                audio,
                map,
                rate,
                BackingProcessing {
                    semitones: -12.,
                    cents: -100.,
                    filter: BackingFilter::BassAttenuation,
                },
            )
            .unwrap();
            for n in 0..4096 {
                let t = n as f64 / rate as f64;
                assert_eq!(old.next_frame(t), cancel.next_frame(t));
                let x = pitched.next_frame(t);
                if pattern[0] == 0. {
                    assert_eq!(x[0], 0.);
                } else {
                    assert_eq!(x[1], x[0] * pattern[1]);
                }
            }
        }
    }
}

#[test]
fn exact_exit_impulse_is_excluded_and_entry_transient_survives_processing() {
    use tabplayer_lib::settings::BackingSettings;
    for rate in [44100, 48000] {
        let mut p = plan();
        p.duration_tick = 1920.;
        p.duration_ms = 1000.;
        p.playback_end_tick = Some(1920.);
        p.occurrences[0].end_tick = 1920.;
        p.occurrences[0].end_ms = 1000.;
        let settings:BackingSettings=serde_json::from_value(serde_json::json!({"assetId":"a","offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":1000,"exitAudioMs":2000},"mix":{"gain":1,"pan":0,"mute":false,"solo":false}})).unwrap();
        for mode in [
            BackingFilter::None,
            BackingFilter::BassEnhance,
            BackingFilter::BassAttenuation,
            BackingFilter::MediumEnhance,
            BackingFilter::MediumAttenuation,
            BackingFilter::HighEnhance,
            BackingFilter::HighAttenuation,
        ] {
            let mut frames = vec![[0.; 2]; rate as usize * 3];
            frames[rate as usize] = [0.7, 0.35];
            frames[rate as usize * 2] = [1., 1.];
            let audio = Arc::new(DecodedAudio {
                sample_rate: rate,
                channels: 2,
                frames: Arc::new(frames),
            });
            let map = BackingMap::from_settings(&settings, &p).unwrap();
            let mut voice = BackingVoice::new_with_processing(
                audio,
                map,
                rate,
                BackingProcessing {
                    semitones: 12.,
                    cents: 100.,
                    filter: mode,
                },
            )
            .unwrap();
            voice.seek(0.);
            assert!(voice.next_frame(0.)[0] > 0.3);
            voice.seek(1. - 10. / rate as f64);
            for n in 0..100 {
                let t = 1. - 10. / rate as f64 + n as f64 / rate as f64;
                assert_eq!(voice.next_frame(t), [0.; 2]);
            }
            voice.seek(0.);
            let a = voice.next_frame(0.);
            voice.next_frame(f64::INFINITY);
            voice.seek(0.);
            assert_eq!(a, voice.next_frame(0.));
        }
    }
}
#[test]
fn processed_direct_jump_past_legacy_eof_suppresses_missed_transient() {
    let rate = 48000;
    let mut frames = vec![[0.; 2]; rate as usize];
    frames[24000] = [0.7, 0.35];
    let audio = Arc::new(DecodedAudio {
        sample_rate: rate,
        channels: 2,
        frames: Arc::new(frames),
    });
    let map = BackingMap::new(&[], 0., &plan()).unwrap();
    let mut neutral = BackingVoice::new(audio.clone(), map.clone(), rate).unwrap();
    assert_eq!(
        neutral.next_frame(2.),
        [0.7, 0.35],
        "preserve incumbent neutral direct-jump transient behavior"
    );
    for processing in [
        BackingProcessing {
            semitones: 12.,
            cents: 0.,
            filter: BackingFilter::None,
        },
        BackingProcessing {
            semitones: 0.,
            cents: 0.,
            filter: BackingFilter::BassEnhance,
        },
    ] {
        let mut voice =
            BackingVoice::new_with_processing(audio.clone(), map.clone(), rate, processing)
                .unwrap();
        assert_eq!(voice.next_frame(2.), [0.; 2]);
    }
}
#[test]
fn processed_nonfinite_frame_is_suppressed_without_poisoning_filter() {
    let mut frames = vec![[0.02; 2]; 48000];
    frames[0][0] = f32::NAN;
    let audio = Arc::new(DecodedAudio {
        sample_rate: 48000,
        channels: 2,
        frames: Arc::new(frames),
    });
    let map = BackingMap::new(&[], 0., &plan()).unwrap();
    let mut neutral = BackingVoice::new(audio.clone(), map.clone(), 48000).unwrap();
    assert_eq!(neutral.next_frame(0.), [0., 0.02]);
    let mut voice = BackingVoice::new_with_processing(
        audio,
        map,
        48000,
        BackingProcessing {
            semitones: 0.,
            cents: 0.,
            filter: BackingFilter::BassEnhance,
        },
    )
    .unwrap();
    assert_eq!(voice.next_frame(0.), [0.; 2]);
    let next = voice.next_frame(1. / 48000.);
    assert!(next.iter().all(|v| v.is_finite() && *v > 0.));
}
#[test]
fn processed_reference_ranges_and_loops_keep_excluded_pcm_out_at_rates_and_speeds() {
    use tabplayer_lib::{
        audio::{
            device::{CallbackTransport, PracticeSettings, TransportCommand},
            practice::PracticeTempo,
            renderer::Renderer,
        },
        settings::{BackingSettings, DocumentSettings},
    };
    let res = resources();
    for rate in [44100, 48000] {
        let mut p = plan();
        p.duration_tick = 1920.;
        p.duration_ms = 1000.;
        p.playback_end_tick = Some(1920.);
        p.occurrences[0].end_tick = 1920.;
        p.occurrences[0].end_ms = 1000.;
        let p = Arc::new(p);
        let settings:BackingSettings=serde_json::from_value(serde_json::json!({"assetId":"a","offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":500,"exitAudioMs":1500},"mix":{"gain":1,"pan":0,"mute":false,"solo":false}})).unwrap();
        let entry = rate as usize / 2;
        let exit = entry + rate as usize;
        let mut clean = vec![[0.; 2]; rate as usize * 2];
        for n in entry..exit {
            let s = (std::f64::consts::TAU * 440. * n as f64 / rate as f64).sin() as f32 * 0.04;
            clean[n] = [s, -s];
        }
        let mut dirty = clean.clone();
        for n in 0..dirty.len() {
            if n < entry || n >= exit {
                dirty[n] = [0.9; 2];
            }
        }
        for speed in [0.1, 1.23, 3.] {
            for looping in [false, true] {
                let build = |frames: Vec<[f32; 2]>| {
                    let mut r =
                        Renderer::new(p.clone(), res.clone(), DocumentSettings::default(), rate)
                            .unwrap();
                    r.install_processed_backing(
                        Arc::new(DecodedAudio {
                            sample_rate: rate,
                            channels: 2,
                            frames: Arc::new(frames),
                        }),
                        BackingMap::from_settings(&settings, &p).unwrap(),
                        settings.mix.clone(),
                        BackingProcessing {
                            semitones: 12.,
                            cents: 100.,
                            filter: BackingFilter::HighEnhance,
                        },
                    )
                    .unwrap();
                    let mut t = CallbackTransport::headless(rate);
                    t.install_with_practice(
                        Box::new(r),
                        1,
                        false,
                        PracticeSettings {
                            tempo: PracticeTempo::Relative { ratio: speed },
                            ..Default::default()
                        },
                    );
                    if looping {
                        t.command(TransportCommand::SetLoop {
                            generation: 1,
                            start_tick: 48.,
                            end_tick: 144.,
                        })
                        .unwrap();
                        t.command(TransportCommand::Play { generation: 1 }).unwrap();
                    } else {
                        t.command(TransportCommand::PlayRange {
                            generation: 1,
                            start_tick: 48.,
                            end_tick: Some(144.),
                        })
                        .unwrap();
                    }
                    t
                };
                let mut a = build(clean.clone());
                let mut b = build(dirty.clone());
                let interval = (0.05 * rate as f64 / speed).ceil() as usize;
                let mut x = vec![[0.; 2]; interval * 3 + 128];
                let mut y = x.clone();
                a.render_into(&mut x);
                b.render_into(&mut y);
                assert_eq!(x, y, "rate={rate} speed={speed} loop={looping}");
                assert!(x.iter().any(|x| x[0].abs() > 0.001));
                assert_eq!(a.status().tick, b.status().tick);
                if looping {
                    assert!(a.status().playing);
                    assert!(a.status().practice.completed_passes >= 3);
                } else {
                    assert_eq!(a.status().tick, 144.);
                    assert!(x[interval..].iter().all(|x| *x == [0.; 2]));
                }
            }
        }
    }
}
