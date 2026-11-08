use std::sync::Arc;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};
use tabplayer_lib::audio::{
    decode::DecodedAudio,
    plan::{Articulation, PitchPoint},
    voices::{SampleVoice, VoiceParameters},
};
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

fn tone() -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: 48_000,
        channels: 2,
        frames: Arc::new(
            (0..96_000)
                .map(|n| {
                    let x =
                        (std::f64::consts::TAU * 220.0 * n as f64 / 48_000.0).sin() as f32 * 0.5;
                    [x, x]
                })
                .collect(),
        ),
    })
}
fn parameters(articulation: Articulation) -> VoiceParameters {
    VoiceParameters {
        root_key: 57,
        key: 57,
        velocity: 100,
        articulation,
        attack_seconds: 0.0,
        release_seconds: 0.1,
        gain_db: 0.0,
        loop_start: None,
        loop_end: None,
        pitch_keytrack: 100.0,
        velocity_gain_high: 127,
    }
}
fn energy(data: &[[f32; 2]]) -> f64 {
    data.iter().map(|x| (x[0] * x[0]) as f64).sum::<f64>() / data.len() as f64
}
fn frequency(data: &[[f32; 2]]) -> f64 {
    let crossings: Vec<_> = data
        .windows(2)
        .enumerate()
        .filter(|(_, x)| x[0][0] < 0.0 && x[1][0] >= 0.0)
        .map(|(i, x)| i as f64 - x[0][0] as f64 / (x[1][0] - x[0][0]) as f64)
        .collect();
    (crossings.len() - 1) as f64 * 48_000.0 / (crossings.last().unwrap() - crossings[0])
}

#[test]
fn recorded_attack_velocity_round_robin() {
    use tabplayer_lib::audio::{
        resources::{Instrument, Region},
        voices::select_region,
    };
    let instrument = Instrument {
        id: "green-guitar".into(),
        regions: vec![
            Region {
                sample_id: "quiet".into(),
                root_key: 57,
                key_low: 40,
                key_high: 90,
                velocity_low: 0,
                velocity_high: 60,
                articulation: "picked".into(),
                trigger: "attack".into(),
                variant: 1,
                sequence_length: 1,
                ..Default::default()
            },
            Region {
                sample_id: "loud-a".into(),
                root_key: 57,
                key_low: 40,
                key_high: 90,
                velocity_low: 61,
                velocity_high: 127,
                articulation: "picked".into(),
                trigger: "attack".into(),
                variant: 1,
                sequence_length: 2,
                ..Default::default()
            },
            Region {
                sample_id: "loud-b".into(),
                root_key: 57,
                key_low: 40,
                key_high: 90,
                velocity_low: 61,
                velocity_high: 127,
                articulation: "picked".into(),
                trigger: "attack".into(),
                variant: 2,
                sequence_length: 2,
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    assert_eq!(
        select_region(&instrument, 57, 30, Articulation::Picked, 0, "attack")
            .unwrap()
            .sample_id,
        "quiet"
    );
    assert_eq!(
        select_region(&instrument, 57, 100, Articulation::Picked, 0, "attack")
            .unwrap()
            .sample_id,
        "loud-a"
    );
    assert_eq!(
        select_region(&instrument, 57, 100, Articulation::Picked, 1, "attack")
            .unwrap()
            .sample_id,
        "loud-b"
    );
    let mut loud = SampleVoice::new(tone(), parameters(Articulation::Picked), 48_000).unwrap();
    let mut quiet_parameters = parameters(Articulation::Picked);
    quiet_parameters.velocity = 30;
    let mut quiet = SampleVoice::new(tone(), quiet_parameters, 48_000).unwrap();
    let loud: Vec<_> = (0..4800).map(|_| loud.next_frame(0.0)).collect();
    let quiet: Vec<_> = (0..4800).map(|_| quiet.next_frame(0.0)).collect();
    assert!(energy(&quiet) < energy(&loud) * 0.15);
    assert!((frequency(&loud) / 220.0 - 1.0).abs() < 0.03);
}

#[test]
fn mute_dead_ghost_staccato_envelopes() {
    for articulation in [
        Articulation::Muted,
        Articulation::Dead,
        Articulation::Ghost,
        Articulation::Staccato,
    ] {
        let mut voice = SampleVoice::new(tone(), parameters(articulation), 48_000).unwrap();
        let rendered: Vec<_> = (0..48_000).map(|_| voice.next_frame(0.0)).collect();
        assert!(
            energy(&rendered[40_000..]) < energy(&rendered[480..4800]) * 0.08,
            "{articulation:?}"
        );
    }
}

#[test]
fn tie_hammer_slide_harmonic_and_poly_bend() {
    let mut left = SampleVoice::new(tone(), parameters(Articulation::Picked), 48_000).unwrap();
    let mut right = SampleVoice::new(tone(), parameters(Articulation::Picked), 48_000).unwrap();
    let a: Vec<_> = (0..24_000).map(|_| left.next_frame(0.0)).collect();
    let b: Vec<_> = (0..24_000).map(|_| right.next_frame(12.0)).collect();
    assert!((frequency(&a) - 220.0).abs() < 4.0);
    assert!((frequency(&b) - 440.0).abs() < 4.0);
    let position = left.source_position();
    left.transition(69, Articulation::Legato);
    assert_eq!(left.source_position(), position);
    let legato: Vec<_> = (0..24_000).map(|_| left.next_frame(0.0)).collect();
    assert!((frequency(&legato) - 440.0).abs() < 8.0);
    let curve = [
        PitchPoint {
            tick: 0.0,
            semitones: 0.0,
        },
        PitchPoint {
            tick: 960.0,
            semitones: 2.0,
        },
    ];
    assert!((tabplayer_lib::audio::voices::pitch_at(&curve, 240.0) - 0.5).abs() < 1e-9);
}

#[test]
fn release_is_smooth_and_stops_voice() {
    let mut voice = SampleVoice::new(tone(), parameters(Articulation::Picked), 48_000).unwrap();
    for _ in 0..1000 {
        voice.next_frame(0.0);
    }
    voice.release();
    let output: Vec<_> = (0..24_000).map(|_| voice.next_frame(0.0)).collect();
    assert!(energy(&output[20_000..]) < 1e-7);
    assert!(!voice.is_active());
}

fn renderer_fixture(
    percussion: bool,
) -> (
    Arc<tabplayer_lib::audio::plan::PlaybackPlan>,
    Arc<tabplayer_lib::audio::resources::AudioResources>,
    tabplayer_lib::settings::DocumentSettings,
) {
    use std::{collections::HashMap, io::Cursor};
    use tabplayer_lib::audio::resources::{AudioResources, Instrument, InstrumentManifest, Region};
    let mut font = Cursor::new(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
        ))
        .unwrap(),
    );
    let resources = AudioResources {
        manifest: InstrumentManifest {
            schema_version: 1,
            instruments: vec![Instrument {
                id: "green-guitar".into(),
                regions: vec![Region {
                    sample_id: "tone".into(),
                    root_key: 57,
                    key_low: 0,
                    key_high: 127,
                    velocity_low: 0,
                    velocity_high: 127,
                    articulation: "picked".into(),
                    variant: 1,
                    sequence_length: 1,
                    trigger: "attack".into(),
                    pitch_keytrack: 100.0,
                    velocity_gain_high: 127,
                    release_seconds: 0.1,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        },
        samples: HashMap::from([("tone".into(), tone())]),
        sound_font: Arc::new(rustysynth::SoundFont::new(&mut font).unwrap()),
    };
    let tracks = serde_json::json!([{"id":"a","program":if percussion {0}else{24},"percussion":percussion},{"id":"b","program":24,"percussion":false}]);
    let mut notes = vec![];
    for index in 0..2 {
        notes.push(serde_json::json!({"id":format!("n{index}"),"trackId":if index==0{"a"}else{"b"},"source":{"target":{"track":index,"staff":0,"bar":0,"voice":0,"beat":0},"string":index+1},"occurrence":0,"startTick":0,"endTick":1920,"key":57,"velocity":100,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}));
    }
    let midi = if percussion {
        serde_json::json!([{"type":"noteOn","trackId":"a","tick":0,"channel":9,"key":38,"velocity":100},{"type":"noteOff","trackId":"a","tick":1920,"channel":9,"key":38,"velocity":0}])
    } else {
        serde_json::json!([])
    };
    let plan=serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":tracks,"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":notes,"midi":midi})).unwrap();
    (
        Arc::new(plan),
        Arc::new(resources),
        tabplayer_lib::settings::DocumentSettings::default(),
    )
}

#[test]
fn stem_sum_matches_pre_limiter_and_speed_keeps_sample_pitch() {
    use tabplayer_lib::audio::renderer::Renderer;
    for rate in [44_100, 48_000] {
        let (plan, resources, settings) = renderer_fixture(false);
        let mut renderer = Renderer::new(plan, resources, settings, rate).unwrap();
        renderer.set_speed(0.25).unwrap();
        let mut a = vec![[0.0; 2]; rate as usize / 2];
        let mut b = a.clone();
        let mut mix = a.clone();
        let status = renderer.render_stems_and_mix_into(&mut [&mut a, &mut b], &mut mix);
        assert_eq!(status.frames, mix.len());
        assert!((status.tick - 240.0).abs() < 1e-5);
        assert!(
            mix.iter()
                .enumerate()
                .all(|(n, x)| (x[0] - a[n][0] - b[n][0]).abs() < 1e-6)
        );
        let crossings = mix
            .windows(2)
            .filter(|x| x[0][0] < 0.0 && x[1][0] >= 0.0)
            .count();
        assert!((crossings as f64 * 2.0 - 220.0).abs() < 4.0);
        renderer.seek_tick(0.0);
        let mut repeat = vec![[0.0; 2]; mix.len()];
        renderer.render_into(&mut repeat);
        assert_eq!(mix, repeat);
    }
}

#[test]
fn relative_10_123_300_keeps_attack_clock_and_pitch() {
    use tabplayer_lib::{
        audio::{plan::PlanMidiEvent, renderer::Renderer},
        settings::TrackSound,
    };
    let (source, resources, settings) = renderer_fixture(false);
    let mut plan = (*source).clone();
    plan.tracks.truncate(1);
    plan.notes.truncate(1);
    plan.notes[0].key = 69;
    plan.notes[0].end_tick = 240.0;
    for index in 1..4 {
        let mut note = plan.notes[0].clone();
        note.id = format!("quarter{index}");
        note.start_tick = index as f64 * 960.0;
        note.end_tick += note.start_tick;
        note.pitch[0].tick = note.start_tick;
        plan.notes.push(note);
    }
    plan.midi = plan
        .notes
        .iter()
        .flat_map(|note| {
            [
                PlanMidiEvent::NoteOn {
                    track_id: "a".into(),
                    tick: note.start_tick,
                    channel: 0,
                    key: note.key,
                    velocity: note.velocity,
                    kit_element: None,
                },
                PlanMidiEvent::NoteOff {
                    track_id: "a".into(),
                    tick: note.end_tick,
                    channel: 0,
                    key: note.key,
                    velocity: 0,
                    kit_element: None,
                },
                // Isolate each SoundFont attack from its sampled release tail.
                PlanMidiEvent::Controller {
                    track_id: "a".into(),
                    tick: note.end_tick,
                    channel: 0,
                    controller: 120,
                    value: 0,
                },
            ]
        })
        .collect();
    for rate in [44_100, 48_000] {
        for speed in [0.1, 1.23, 3.0] {
            for recorded in [true, false] {
                let mut settings = settings.clone();
                if !recorded {
                    settings.sounds.insert(
                        "a".into(),
                        TrackSound {
                            voice_id: Some("gm".into()),
                            ..Default::default()
                        },
                    );
                }
                let mut renderer =
                    Renderer::new(Arc::new(plan.clone()), resources.clone(), settings, rate)
                        .unwrap();
                renderer.set_speed(speed).unwrap();
                let spacing = 0.5 * rate as f64 / speed;
                let mut output =
                    vec![[0.0; 2]; (spacing * 3.0 + rate as f64 * 0.08).ceil() as usize];
                renderer.render_into(&mut output);
                // Find PCM attacks independently in each expected quarter window.
                // Rustysynth's minimum block is eight frames; recorded attacks use
                // the sample clock directly and retain the tighter two-frame bound.
                let attacks: Vec<_> = (0..4)
                    .map(|quarter| {
                        let start = (quarter as f64 * spacing).floor() as usize;
                        start
                            + output[start..start + rate as usize / 25]
                                .iter()
                                .position(|sample| sample[0].abs() > 0.001)
                                .unwrap_or_else(|| panic!("No attack: rate={rate} speed={speed} recorded={recorded} quarter={quarter}"))
                    })
                    .collect();
                for pair in attacks.windows(2) {
                    assert!(
                        (pair[1] as f64 - pair[0] as f64 - spacing).abs()
                            <= if recorded { 2.0 } else { 8.0 },
                        "rate={rate} speed={speed} recorded={recorded}: {attacks:?}"
                    );
                }
                let start = attacks[0] + rate as usize / 100;
                let end = start + rate as usize / 40;
                let measured = if recorded {
                    frequency(&output[start..end]) * rate as f64 / 48_000.0
                } else {
                    // The SoundFont guitar's attack has strong upper partials, so
                    // estimate its fundamental from waveform recurrence instead
                    // of counting every harmonic's zero crossing.
                    let wave = &output[start..end];
                    let recurrence = |lag: usize| {
                        let mut cross = 0.0;
                        let mut left = 0.0;
                        let mut right = 0.0;
                        for pair in wave.iter().zip(wave.iter().skip(lag)) {
                            let a = pair.0[0] as f64;
                            let b = pair.1[0] as f64;
                            cross += a * b;
                            left += a * a;
                            right += b * b;
                        }
                        cross / (left * right).sqrt()
                    };
                    let lag = (rate as usize / 600..rate as usize / 300)
                        .max_by(|&a, &b| recurrence(a).total_cmp(&recurrence(b)))
                        .unwrap();
                    let (before, peak, after) =
                        (recurrence(lag - 1), recurrence(lag), recurrence(lag + 1));
                    let fractional = 0.5 * (before - after) / (before - 2.0 * peak + after);
                    rate as f64 / (lag as f64 + fractional)
                };
                assert!(
                    (measured - 440.0).abs() < if recorded { 2.0 } else { 12.0 },
                    "rate={rate} speed={speed} recorded={recorded}: {measured}"
                );
            }
        }
    }
}

fn changing_tempo_practice_plan() -> Arc<tabplayer_lib::audio::plan::PlaybackPlan> {
    Arc::new(serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":7680,"durationMs":6000,
        "tracks":[{"id":"a","program":24,"percussion":false}],
        "tempos":[{"tick":0,"bpm":120},{"tick":3840,"bpm":60}],
        "occurrences":[
            {"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},
            {"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":6000}
        ],"notes":[],"midi":[]
    })).unwrap())
}

#[test]
fn fixed_90_ignores_source_120_then_60() {
    use tabplayer_lib::audio::{practice::RenderTempo, renderer::Renderer};
    let (source, mut resources, settings) = renderer_fixture(false);
    let mut plan = (*changing_tempo_practice_plan()).clone();
    for index in 0..8 {
        let mut note = source.notes[0].clone();
        note.id = format!("fixed-quarter-{index}");
        note.source.target.bar = index / 4;
        note.source.target.beat = index % 4;
        note.start_tick = index as f64 * 960.0;
        note.end_tick = note.start_tick + 240.0;
        note.pitch[0].tick = note.start_tick;
        plan.notes.push(note);
    }
    let bank = Arc::get_mut(&mut resources).unwrap();
    let audio = Arc::get_mut(bank.samples.get_mut("tone").unwrap()).unwrap();
    let frames = Arc::get_mut(&mut audio.frames).unwrap();
    frames.fill([0.0; 2]);
    frames[0] = [1.0; 2];
    let plan = Arc::new(plan);
    let original = serde_json::to_vec(&*plan).unwrap();
    let mut renderer = Renderer::new(plan.clone(), resources, settings, 48_000).unwrap();
    renderer
        .set_practice_tempo(RenderTempo::Fixed { bpm: 90.0 })
        .unwrap();
    renderer.set_metronome(true);
    let mut score = vec![[0.0; 2]; 256_000];
    let mut click = score.clone();
    let status = renderer.render_stems_into(&mut [&mut score, &mut click]);
    let onsets = click_onsets(&click, 48_000);
    assert_eq!(onsets.len(), 8, "{onsets:?}");
    for (beat, onset) in onsets.into_iter().enumerate() {
        assert!(onset.abs_diff(beat * 32_000 + 1) <= 2);
    }
    let attacks: Vec<_> = score
        .iter()
        .enumerate()
        .filter(|(_, sample)| sample[0] > 0.3)
        .map(|(frame, _)| frame)
        .collect();
    assert_eq!(attacks.len(), 8, "{attacks:?}");
    for (beat, frame) in attacks.into_iter().enumerate() {
        assert!(frame.abs_diff(beat * 32_000) <= 1);
    }
    assert!((status.tick - 7680.0).abs() < 0.031);
    assert!((status.seconds - 6.0).abs() < 1.0 / 48_000.0);
    assert!(status.ended);
    assert_eq!(serde_json::to_vec(&*plan).unwrap(), original);
}

#[test]
fn fixed_output_budget_crosses_tempo_step_and_rejects_backing_atomically() {
    use tabplayer_lib::{
        audio::{backing::BackingMap, practice::RenderTempo, renderer::Renderer},
        settings::ChannelMix,
    };
    let (_, resources, settings) = renderer_fixture(false);
    let plan = changing_tempo_practice_plan();
    let mut renderer =
        Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
    renderer.seek_tick(2880.0);
    renderer
        .set_practice_tempo(RenderTempo::Fixed { bpm: 90.0 })
        .unwrap();
    assert_eq!(renderer.output_frames_until(2880.000000001), 1);
    assert_eq!(renderer.output_frames_until(4800.0), 64_000);
    renderer.render_into(&mut vec![[0.0; 2]; 32_000]);
    assert_eq!(renderer.output_frames_until(4800.0), 32_000);
    renderer.render_into(&mut vec![[0.0; 2]; 31_999]);
    assert_eq!(renderer.output_frames_until(4800.0), 1);
    renderer.render_into(&mut [[0.0; 2]; 1]);
    assert_eq!(renderer.output_frames_until(4800.0), 0);
    assert_eq!(renderer.authored_bpm_at(2880.0), 120.0);
    assert_eq!(renderer.authored_bpm_at(4800.0), 60.0);
    assert_eq!(renderer.meter_at(4800.0), (4, 4));
    assert!(!renderer.has_backing());
    let mut backed = Renderer::new(plan.clone(), resources, settings, 48_000).unwrap();
    backed.set_speed(1.23).unwrap();
    backed.seek_tick(2880.0);
    backed
        .install_backing(
            tone(),
            BackingMap::new(&[], 0.0, &plan).unwrap(),
            ChannelMix {
                mute: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(backed.has_backing());
    let before = backed.position();
    let budget = backed.output_frames_until(4800.0);
    assert_eq!(
        backed
            .set_practice_tempo(RenderTempo::Fixed { bpm: 90.0 })
            .unwrap_err(),
        "Fixed tempo is unavailable while a backing track is present."
    );
    assert_eq!(backed.position().tick, before.tick);
    assert_eq!(backed.output_frames_until(4800.0), budget);
    assert!(
        renderer
            .install_backing(
                tone(),
                BackingMap::new(&[], 0.0, &plan).unwrap(),
                ChannelMix::default()
            )
            .is_err()
    );
    assert!(!renderer.has_backing());
}

#[test]
fn irregular_relative_buffers_do_not_add_an_endpoint_frame() {
    use tabplayer_lib::audio::renderer::Renderer;
    let (_, resources, settings) = renderer_fixture(false);
    let plan = changing_tempo_practice_plan();
    for rate in [44_100, 48_000] {
        for ratio in [0.1, 0.5, 0.7, 1.23, 3.0] {
            let mut renderer =
                Renderer::new(plan.clone(), resources.clone(), settings.clone(), rate).unwrap();
            renderer.set_speed(ratio).unwrap();
            let expected = (2.0 * rate as f64 / ratio - 1e-7).ceil() as usize;
            let mut frames = 0;
            let mut block = [[0.0; 2]; 511];
            while frames < expected {
                let remaining = renderer.output_frames_until(3840.0);
                assert_eq!(
                    remaining,
                    expected - frames,
                    "rate={rate} ratio={ratio} atframe={frames}"
                );
                let count = remaining.min(if frames % 2 == 0 { 127 } else { 511 });
                renderer.render_into(&mut block[..count]);
                frames += count;
            }
            assert_eq!(
                renderer.output_frames_until(3840.0),
                0,
                "rate={rate} ratio={ratio}"
            );
            // Reapplying accepted settings must not change the clock origin.
            renderer.set_speed(ratio).unwrap();
            assert_eq!(renderer.output_frames_until(3840.0), 0);
            renderer.seek_tick(0.0);
            assert_eq!(renderer.output_frames_until(3840.0), expected);
        }
    }
}

#[test]
fn visual_only_pulses_and_gain_preserve_stems() {
    use tabplayer_lib::audio::{
        practice::{MetronomeSettings, PulsePosition},
        renderer::Renderer,
    };
    let (_, resources, settings) = renderer_fixture(false);
    let plan = changing_tempo_practice_plan();
    let mut energies = Vec::new();
    for volume in [0.0, 0.2, 0.4] {
        let mut renderer =
            Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
        renderer.set_metronome_settings(MetronomeSettings {
            enabled: true,
            volume,
            visual: true,
            sound: Default::default(),
        });
        assert_eq!(renderer.stem_count(), 2);
        let mut score = vec![[0.0; 2]; 72_000];
        let mut click = score.clone();
        let mut mix = score.clone();
        let status = renderer.render_stems_and_mix_into(&mut [&mut score, &mut click], &mut mix);
        assert_eq!(status.pulse_count, 3);
        assert_eq!(
            status.last_pulse,
            Some(PulsePosition {
                beat: 2,
                beats_per_bar: 4,
                accent: false
            })
        );
        assert!(score.iter().flatten().all(|sample| *sample == 0.0));
        assert_eq!(mix, click);
        energies.push(energy(&click));
        let status = renderer.render_into(&mut []);
        assert_eq!(status.pulse_count, 0);
        assert_eq!(status.last_pulse, None);
        assert_eq!(renderer.position().pulse_count, 0);
    }
    assert_eq!(energies[0], 0.0);
    assert!((energies[2] / energies[1] - 4.0).abs() < 1e-5);
    let mut renderer = Renderer::new(plan, resources, settings, 48_000).unwrap();
    renderer.set_metronome_settings(MetronomeSettings {
        enabled: false,
        volume: 0.4,
        visual: true,
        sound: Default::default(),
    });
    assert_eq!(renderer.stem_count(), 1);
    let mut output = vec![[0.0; 2]; 72_000];
    let status = renderer.render_into(&mut output);
    assert_eq!(status.pulse_count, 3);
    assert_eq!(status.last_pulse.unwrap().beat, 2);
    assert!(output.iter().flatten().all(|sample| *sample == 0.0));
}

#[test]
fn the_chosen_click_sound_reaches_the_metronome_stem_with_the_same_pulses() {
    use tabplayer_lib::audio::{
        practice::{ClickSound, ClickVoice, MetronomeSettings},
        renderer::Renderer,
    };
    let (_, resources, settings) = renderer_fixture(false);
    let plan = changing_tempo_practice_plan();
    let mut clicks = Vec::new();
    for sound in [
        ClickSound::Beep,
        ClickSound::Woodblock,
        ClickSound::Cowbell,
        ClickSound::Stick,
    ] {
        let mut renderer =
            Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
        renderer.set_metronome_settings(MetronomeSettings {
            enabled: true,
            volume: 0.4,
            visual: true,
            sound,
        });
        let mut score = vec![[0.0; 2]; 72_000];
        let mut click = score.clone();
        let mut mix = score.clone();
        let status = renderer.render_stems_and_mix_into(&mut [&mut score, &mut click], &mut mix);
        assert_eq!(status.pulse_count, 3, "{sound:?}");
        // The first click starts on the first frame and is the voice's own accented shape.
        let mut voice = ClickVoice::new(48_000);
        voice.trigger(true, sound);
        for frame in &click[..200] {
            assert_eq!(frame[0], voice.frame(0.4), "{sound:?}");
        }
        clicks.push(click);
    }
    for (index, click) in clicks.iter().enumerate() {
        for other in &clicks[index + 1..] {
            assert_ne!(click, other);
        }
    }
}

#[test]
fn gm_and_percussion_fallback() {
    use tabplayer_lib::audio::renderer::Renderer;
    let (plan, resources, settings) = renderer_fixture(true);
    let mut renderer = Renderer::new(plan, resources, settings, 48_000).unwrap();
    let mut drum = vec![[0.0; 2]; 4800];
    let mut guitar = drum.clone();
    renderer.render_stems_into(&mut [&mut drum, &mut guitar]);
    assert!(energy(&drum) > 1e-7);
    assert!(energy(&guitar) > 1e-4);
    assert!(drum.iter().flatten().all(|x| x.is_finite()));
}

#[test]
fn independent_polyphonic_pitch_curves_and_legato_attack() {
    use tabplayer_lib::{
        audio::{plan::PitchPoint, renderer::Renderer},
        settings::ChannelMix,
    };
    let (plan, resources, mut settings) = renderer_fixture(false);
    let mut plan = (*plan).clone();
    plan.notes[0].pitch = vec![
        PitchPoint {
            tick: 0.0,
            semitones: 0.0,
        },
        PitchPoint {
            tick: 960.0,
            semitones: 12.0,
        },
    ];
    settings.mixes.insert(
        "a".into(),
        ChannelMix {
            pan: -1.0,
            ..Default::default()
        },
    );
    settings.mixes.insert(
        "b".into(),
        ChannelMix {
            pan: 1.0,
            ..Default::default()
        },
    );
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 48_000];
    renderer.render_into(&mut output);
    let right: Vec<_> = output[32_000..40_000]
        .iter()
        .map(|x| [x[1], x[1]])
        .collect();
    assert!((frequency(&output[32_000..40_000]) - 440.0).abs() < 1.0);
    assert!((frequency(&right) - 220.0).abs() < 1.0);
    let (plan, mut resources, settings) = renderer_fixture(false);
    let mut plan = (*plan).clone();
    plan.notes.truncate(1);
    plan.notes[0].end_tick = 777.0;
    let mut next = plan.notes[0].clone();
    next.id = "hammer".into();
    next.start_tick = 777.0;
    next.end_tick = 1920.0;
    next.key = 59;
    next.articulation = Articulation::Legato;
    next.legato_from = Some("n0".into());
    next.pitch = vec![PitchPoint {
        tick: 777.0,
        semitones: 0.0,
    }];
    plan.notes.push(next);
    let audio = Arc::get_mut(&mut resources)
        .unwrap()
        .samples
        .get_mut("tone")
        .unwrap();
    Arc::get_mut(&mut Arc::get_mut(audio).unwrap().frames).unwrap()[0] = [1.0; 2];
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 48_000];
    renderer.render_into(&mut output);
    let onset = (777.0 / 1920.0 * 48_000.0) as usize;
    assert!(output[0][0] > 0.35);
    assert!(output[onset..onset + 32].iter().all(|x| x[0].abs() < 0.35));
}

#[test]
fn render_seek_and_prepared_mix_install_do_not_touch_heap() {
    use tabplayer_lib::{
        audio::{
            dsp::FxSettings,
            renderer::{PreparedMix, Renderer},
        },
        settings::TrackSound,
    };
    let (plan, resources, mut settings) = renderer_fixture(true);
    let mut effects = FxSettings::preset("lead").unwrap();
    effects.gate.enabled = true;
    effects.compressor.enabled = true;
    effects.eq.enabled = true;
    effects.chorus.enabled = true;
    settings.sounds.insert(
        "b".into(),
        TrackSound {
            voice_id: None,
            preset_id: "lead".into(),
            effects,
            ..Default::default()
        },
    );
    let mix = PreparedMix::prepare(&settings, &plan, 48_000).unwrap();
    let waiting = PreparedMix::prepare(&settings, &plan, 48_000).unwrap();
    let mut renderer = Renderer::new(plan, resources, settings, 48_000).unwrap();
    renderer.set_metronome_settings(tabplayer_lib::audio::practice::MetronomeSettings {
        enabled: true,
        volume: 0.4,
        visual: true,
        sound: Default::default(),
    });
    let mut block = [[0.0; 2]; 512];
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    for _ in 0..100 {
        renderer.render_into(&mut block);
    }
    renderer.seek_tick(960.0);
    renderer
        .set_practice_tempo(tabplayer_lib::audio::practice::RenderTempo::Fixed { bpm: 90.0 })
        .unwrap();
    let _ = renderer.output_frames_until(2880.0);
    let retired = renderer.replace_mix(mix);
    // A mix that arrives during the crossfade waits for it, and takes over with no heap work either.
    let parked = renderer.replace_mix(waiting);
    renderer.render_into(&mut block);
    let settled = renderer.settle_mix();
    renderer.render_into(&mut block);
    COUNT_HEAP.with(|f| f.set(false));
    let operations = HEAP_OPERATIONS.with(Cell::get);
    assert!(retired.is_some() && parked.is_none() && settled.is_some());
    drop((retired, parked, settled));
    assert_eq!(
        operations, 0,
        "audio callback allocated or freed heap memory"
    );
}

#[test]
fn render_seek_and_kit_mix_install_do_not_touch_heap() {
    use tabplayer_lib::{
        audio::{
            plan::PlanMidiEvent,
            renderer::{PreparedMix, Renderer},
        },
        settings::{ChannelMix, DrumElementMix, DrumKitMix, KitElement},
    };
    let kit = |gain: f32, mute: bool| {
        let (_, _, mut settings) = renderer_fixture(true);
        settings.mixes.insert(
            "a".into(),
            ChannelMix {
                drum_kit: Some(DrumKitMix {
                    snare: Some(DrumElementMix {
                        gain,
                        pan: -0.3,
                        mute,
                        solo: false,
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        settings
    };
    let (source, resources, _) = renderer_fixture(true);
    // A drum track whose notes cross a kit change: a kit element named by the plan, a held one, and a seek into them.
    let mut plan = (*source).clone();
    plan.midi = vec![
        PlanMidiEvent::NoteOn {
            track_id: "a".into(),
            tick: 0.,
            channel: 9,
            key: 38,
            velocity: 100,
            kit_element: None,
        },
        PlanMidiEvent::NoteOn {
            track_id: "a".into(),
            tick: 480.,
            channel: 9,
            key: 37,
            velocity: 100,
            kit_element: Some(KitElement::Other),
        },
        PlanMidiEvent::NoteOff {
            track_id: "a".into(),
            tick: 1920.,
            channel: 9,
            key: 37,
            velocity: 0,
            kit_element: Some(KitElement::Other),
        },
        PlanMidiEvent::NoteOff {
            track_id: "a".into(),
            tick: 1920.,
            channel: 9,
            key: 38,
            velocity: 0,
            kit_element: None,
        },
    ];
    let plan = Arc::new(plan);
    let first = PreparedMix::prepare(&kit(0.5, false), &plan, 48_000).unwrap();
    let second = PreparedMix::prepare(&kit(1.0, true), &plan, 48_000).unwrap();
    let neutral = PreparedMix::prepare(
        &tabplayer_lib::settings::DocumentSettings::default(),
        &plan,
        48_000,
    )
    .unwrap();
    let mut renderer = Renderer::new(plan, resources, kit(0.8, false), 48_000).unwrap();
    let mut block = [[0.0; 2]; 512];
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    for _ in 0..20 {
        renderer.render_into(&mut block);
    }
    // Seeking into held notes strikes them again, each on its own element; mixes arrive and leave a kit while they ring.
    renderer.seek_tick(960.0);
    let retired = renderer.replace_mix(first);
    renderer.render_into(&mut block);
    let parked = renderer.replace_mix(second);
    renderer.render_into(&mut block);
    let settled = renderer.settle_mix();
    renderer.render_into(&mut block);
    let removed = renderer.replace_mix(neutral);
    renderer.render_into(&mut block);
    renderer.seek_tick(0.0);
    renderer.render_into(&mut block);
    renderer.begin_tail();
    renderer.render_into(&mut block);
    COUNT_HEAP.with(|f| f.set(false));
    let operations = HEAP_OPERATIONS.with(Cell::get);
    assert!(
        block.iter().any(|frame| *frame != [0.0; 2]),
        "the blocks under test hold sound"
    );
    drop((retired, parked, settled, removed));
    assert_eq!(
        operations, 0,
        "audio callback allocated or freed heap memory"
    );
}

#[test]
fn backing_gain_and_solo_resolve_with_score_channels() {
    use tabplayer_lib::{
        audio::{backing::BackingMap, renderer::Renderer},
        settings::ChannelMix,
    };
    let (plan, resources, settings) = renderer_fixture(false);
    let map = BackingMap::new(&[], 0.0, &plan).unwrap();
    let mut renderer = Renderer::new(plan, resources, settings, 48_000).unwrap();
    renderer
        .install_backing(
            tone(),
            map,
            ChannelMix {
                gain: 0.5,
                solo: true,
                ..Default::default()
            },
        )
        .unwrap();
    let mut a = vec![[0.0; 2]; 4800];
    let mut b = a.clone();
    let mut backing = a.clone();
    renderer.render_stems_into(&mut [&mut a, &mut b, &mut backing]);
    assert_eq!(energy(&a), 0.0);
    assert_eq!(energy(&b), 0.0);
    assert!((energy(&backing) - 0.015625).abs() < 0.001);
}

#[test]
fn rest_only_recorded_track_keeps_bank_identity() {
    use tabplayer_lib::audio::voices::resource_requests;
    let (plan, _, settings) = renderer_fixture(false);
    let mut plan = (*plan).clone();
    plan.notes.clear();
    let requests = resource_requests(&plan, &settings);
    assert!(requests.iter().any(|r| r.instrument_id == "green-guitar"));
}

#[test]
fn deleted_solo_channel_does_not_silence_surviving_music() {
    use tabplayer_lib::{audio::renderer::Renderer, settings::ChannelMix};
    let (plan, resources, mut settings) = renderer_fixture(false);
    settings.mixes.insert(
        "removed-track".into(),
        ChannelMix {
            solo: true,
            ..Default::default()
        },
    );
    let mut renderer = Renderer::new(plan, resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 4800];
    renderer.render_into(&mut output);
    assert!(energy(&output) > 1e-4);
}

#[test]
fn equal_key_different_strings_keep_two_pitch_trajectories() {
    use tabplayer_lib::audio::renderer::Renderer;
    let (plan, resources, settings) = renderer_fixture(false);
    let mut plan = (*plan).clone();
    plan.tracks.truncate(1);
    plan.notes[1].track_id = "a".into();
    plan.notes[1].source.target.track = 0;
    plan.notes[0].pitch.push(PitchPoint {
        tick: 960.0,
        semitones: 12.0,
    });
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 48_000];
    renderer.render_into(&mut output);
    let amplitude = |hz: f64| {
        let mut sin = 0.0;
        let mut cos = 0.0;
        for (n, x) in output[32_000..44_000].iter().enumerate() {
            let angle = std::f64::consts::TAU * hz * n as f64 / 48_000.0;
            sin += x[0] as f64 * angle.sin();
            cos += x[0] as f64 * angle.cos();
        }
        2.0 * (sin * sin + cos * cos).sqrt() / 12000.0
    };
    assert!(amplitude(220.0) > 0.15);
    assert!(amplitude(440.0) > 0.15);
}

#[test]
fn recorded_release_triggers_after_short_attack_sample_finishes() {
    use tabplayer_lib::audio::{renderer::Renderer, resources::Region};
    let (plan, mut resources, settings) = renderer_fixture(false);
    let resources_mut = Arc::get_mut(&mut resources).unwrap();
    let audio = resources_mut.samples.get_mut("tone").unwrap();
    Arc::get_mut(&mut Arc::get_mut(audio).unwrap().frames)
        .unwrap()
        .truncate(2400);
    let mut release = vec![[0.0; 2]; 1000];
    release[0] = [0.8; 2];
    resources_mut.samples.insert(
        "release".into(),
        Arc::new(DecodedAudio {
            sample_rate: 48_000,
            channels: 2,
            frames: Arc::new(release),
        }),
    );
    resources_mut.manifest.instruments[0].regions.push(Region {
        sample_id: "release".into(),
        root_key: 57,
        key_low: 0,
        key_high: 127,
        velocity_low: 0,
        velocity_high: 127,
        articulation: "release".into(),
        variant: 1,
        sequence_length: 1,
        trigger: "release".into(),
        pitch_keytrack: 100.0,
        velocity_gain_high: 127,
        ..Default::default()
    });
    let mut renderer = Renderer::new(plan, resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 49_000];
    renderer.render_into(&mut output);
    assert!(output[47_999][0].abs() < 1e-6);
    assert!(output[48_000..48_100].iter().any(|x| x[0].abs() > 0.2));
}

#[test]
fn fallback_legato_skips_picked_transient_when_origin_finished() {
    use tabplayer_lib::audio::renderer::Renderer;
    let (plan, mut resources, settings) = renderer_fixture(false);
    let mut plan = (*plan).clone();
    plan.notes.truncate(1);
    plan.notes[0].end_tick = 960.0;
    let mut next = plan.notes[0].clone();
    next.id = "slur".into();
    next.start_tick = 960.0;
    next.end_tick = 1920.0;
    next.articulation = Articulation::Legato;
    next.legato_from = Some("n0".into());
    next.pitch = vec![PitchPoint {
        tick: 960.0,
        semitones: 0.0,
    }];
    plan.notes.push(next);
    let audio = Arc::get_mut(&mut resources)
        .unwrap()
        .samples
        .get_mut("tone")
        .unwrap();
    let frames = Arc::get_mut(&mut Arc::get_mut(audio).unwrap().frames).unwrap();
    frames.truncate(2400);
    frames[0] = [1.0; 2];
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 25_000];
    renderer.render_into(&mut output);
    let peak = output[24_000..24_400]
        .iter()
        .map(|x| x[0].abs())
        .fold(0.0, f32::max);
    assert!(peak < 0.26 && peak > 0.03, "fallback legato peak={peak}");
}

#[test]
fn metronome_accents_actual_measure_grid_and_seek_waits_for_beat() {
    use tabplayer_lib::audio::{plan::MeasureOccurrence, renderer::Renderer};
    let (plan, resources, settings) = renderer_fixture(false);
    let mut plan = (*plan).clone();
    plan.notes.clear();
    plan.duration_tick = 5760.0;
    plan.duration_ms = 3000.0;
    plan.occurrences = (0..2)
        .map(|bar| MeasureOccurrence {
            bar,
            occurrence: 0,
            meter_numerator: 3,
            meter_denominator: 4,
            start_tick: bar as f64 * 2880.0,
            end_tick: (bar + 1) as f64 * 2880.0,
            start_ms: bar as f64 * 1500.0,
            end_ms: (bar + 1) as f64 * 1500.0,
            click_ticks: None,
        })
        .collect();
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, 48_000).unwrap();
    renderer.set_metronome(true);
    let mut output = vec![[0.0; 2]; 96_000];
    renderer.render_into(&mut output);
    assert!((frequency(&output[72_480..73_920]) - 2400.0).abs() < 2.0);
    renderer.seek_tick(777.0);
    let mut output = vec![[0.0; 2]; 10_000];
    renderer.render_into(&mut output);
    let first = output.iter().position(|x| x[0].abs() > 1e-5).unwrap();
    assert!(
        first.abs_diff(4576) <= 2,
        "metronome after seek first click frame={first}"
    );
}

fn meter_plan(mixed: bool) -> Arc<tabplayer_lib::audio::plan::PlaybackPlan> {
    let occurrences = if mixed {
        serde_json::json!([
            {"bar":0,"occurrence":0,"meterNumerator":3,"meterDenominator":8,"startTick":0,"endTick":720,"startMs":0,"endMs":375,"clickTicks":[0,480]},
            {"bar":1,"occurrence":0,"meterNumerator":3,"meterDenominator":8,"startTick":720,"endTick":2160,"startMs":375,"endMs":1125,"clickTicks":[720,1200,1680]},
            {"bar":2,"occurrence":0,"meterNumerator":6,"meterDenominator":8,"startTick":2160,"endTick":5040,"startMs":1125,"endMs":3125,"clickTicks":[2160,2640,3120,3600,4080,4560]},
            {"bar":1,"occurrence":1,"meterNumerator":3,"meterDenominator":8,"startTick":5040,"endTick":6480,"startMs":3125,"endMs":4125,"clickTicks":[5040,5520,6000]},
            {"bar":3,"occurrence":0,"meterNumerator":2,"meterDenominator":4,"startTick":6480,"endTick":8400,"startMs":4125,"endMs":5125,"clickTicks":[6480,7440]}
        ])
    } else {
        serde_json::json!([
            {"bar":0,"occurrence":0,"meterNumerator":3,"meterDenominator":8,"startTick":0,"endTick":1440,"startMs":0,"endMs":750,"clickTicks":[0,480,960]},
            {"bar":0,"occurrence":1,"meterNumerator":3,"meterDenominator":8,"startTick":1440,"endTick":2880,"startMs":750,"endMs":1500,"clickTicks":[1440,1920,2400]}
        ])
    };
    Arc::new(
        serde_json::from_value(serde_json::json!({
            "generation":1,"ppq":960,
            "durationTick":if mixed {8400}else{2880},
            "durationMs":if mixed {5125}else{1500},
            "tracks":[{"id":"a","program":24,"percussion":false}],
            "tempos":if mixed {serde_json::json!([{"tick":0,"bpm":120},{"tick":2160,"bpm":90},{"tick":6480,"bpm":120}])}else{serde_json::json!([{"tick":0,"bpm":120}])},
            "occurrences":occurrences,"notes":[],"midi":[]
        }))
        .unwrap(),
    )
}

fn click_onsets(output: &[[f32; 2]], rate: u32) -> Vec<usize> {
    let mut onsets = Vec::new();
    let mut last_active = None;
    for (frame, sample) in output.iter().enumerate() {
        if sample[0].abs() > 0.001 {
            if last_active.is_none_or(|last| frame - last > rate as usize / 100) {
                onsets.push(frame);
            }
            last_active = Some(frame);
        }
    }
    onsets
}

fn assert_click_times(output: &[[f32; 2]], rate: u32, seconds: &[f64], speed: f64) {
    let actual = click_onsets(output, rate);
    assert_eq!(actual.len(), seconds.len(), "click onsets: {actual:?}");
    for (&frame, &seconds) in actual.iter().zip(seconds) {
        let expected = (seconds * rate as f64 / speed).round() as usize + 1;
        assert!(
            frame.abs_diff(expected) <= 2,
            "click frame {frame}, expected {expected} at speed {speed}"
        );
    }
}

#[test]
fn metronome_three_eighths_clicks_are_even_at_each_speed_and_seek() {
    use tabplayer_lib::audio::renderer::Renderer;
    let (_, resources, settings) = renderer_fixture(false);
    let plan = meter_plan(false);
    for speed in [0.5, 1.0, 2.0] {
        let mut renderer =
            Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
        renderer.set_speed(speed).unwrap();
        renderer.set_metronome(true);
        let mut output = vec![[0.0; 2]; (1.5 * 48_000.0 / speed) as usize];
        renderer.render_into(&mut output);
        assert_click_times(&output, 48_000, &[0.0, 0.25, 0.5, 0.75, 1.0, 1.25], speed);
        let onsets = click_onsets(&output, 48_000);
        for (pulse, &onset) in onsets.iter().enumerate() {
            let expected = if pulse % 3 == 0 { 2400.0 } else { 1800.0 };
            assert!((frequency(&output[onset + 240..onset + 1200]) - expected).abs() < 2.0);
        }
        renderer.seek_tick(777.0);
        let mut after_seek = vec![[0.0; 2]; (0.22 * 48_000.0 / speed) as usize];
        renderer.render_into(&mut after_seek);
        assert_click_times(&after_seek, 48_000, &[183.0 / 1920.0], speed);
        renderer.seek_tick(1440.0);
        let mut after_seek = vec![[0.0; 2]; 2000];
        renderer.render_into(&mut after_seek);
        assert_click_times(&after_seek, 48_000, &[0.0], speed);
        assert!((frequency(&after_seek[240..1200]) - 2400.0).abs() < 2.0);
    }
}

#[test]
fn metronome_pickup_mixed_meter_and_repeated_meter_follow_played_bounds() {
    use tabplayer_lib::audio::renderer::Renderer;
    let (_, resources, settings) = renderer_fixture(false);
    let plan = meter_plan(true);
    let clicks = [
        0.0,
        0.25,
        0.375,
        0.625,
        0.875,
        1.125,
        1.125 + 1.0 / 3.0,
        1.125 + 2.0 / 3.0,
        2.125,
        2.125 + 1.0 / 3.0,
        2.125 + 2.0 / 3.0,
        3.125,
        3.125 + 1.0 / 3.0,
        3.125 + 2.0 / 3.0,
        4.125,
        4.625,
    ];
    for speed in [0.5, 2.0] {
        let mut renderer =
            Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
        renderer.set_speed(speed).unwrap();
        renderer.set_metronome(true);
        let mut output = vec![[0.0; 2]; (5.125 * 48_000.0 / speed) as usize];
        renderer.render_into(&mut output);
        assert_click_times(&output, 48_000, &clicks, speed);
        let onsets = click_onsets(&output, 48_000);
        for (pulse, &onset) in onsets.iter().enumerate() {
            let expected = if [0, 2, 5, 11, 14].contains(&pulse) {
                2400.0
            } else {
                1800.0
            };
            assert!((frequency(&output[onset + 240..onset + 1200]) - expected).abs() < 2.0);
        }
    }
}

#[test]
fn metronome_offline_export_keeps_eighth_pulses_across_disjoint_repeat_ranges() {
    use std::sync::atomic::AtomicBool;
    use tabplayer_lib::{
        audio::renderer::Renderer,
        export::{
            audio::{AudioExportRender, AudioExportRequest, MeasureRange},
            stems::{StemKind, StemTrack},
            wav::{AudioFormat, write_wav},
        },
    };
    let (_, resources, settings) = renderer_fixture(false);
    let plan = meter_plan(true);
    for rate in [44_100, 48_000] {
        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "a".into(),
                name: "Guitar".into(),
                preset: "gm".into(),
                kind: StemKind::Score,
            }],
            range: Some(MeasureRange { first: 1, last: 1 }),
            format: AudioFormat::wav(rate, 24),
            speed: 2.0,
            metronome: true,
            metronome_sound: Default::default(),
            tail_seconds: 0.03,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        };
        let renderer =
            Renderer::new(plan.clone(), resources.clone(), settings.clone(), rate).unwrap();
        let mut export = AudioExportRender::new(renderer, &plan, request.clone()).unwrap();
        let expected_frames = (0.375 * rate as f64).round() as u64
            + (0.5 * rate as f64).round() as u64
            + (0.03 * rate as f64).round() as u64;
        assert_eq!(export.total_frames(), expected_frames);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("meter.wav");
        write_wav(
            &path,
            request.format,
            |block| export.render_mix(block),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let mut wav = hound::WavReader::open(path).unwrap();
        assert_eq!(wav.duration() as u64, expected_frames);
        let pcm: Vec<_> = wav
            .samples::<i32>()
            .map(|v| v.unwrap() as f32 / 8_388_608.0)
            .collect();
        let stereo: Vec<_> = pcm.chunks_exact(2).map(|x| [x[0], x[1]]).collect();
        assert_click_times(
            &stereo,
            rate,
            &[
                0.0,
                0.125,
                0.25,
                0.375,
                0.375 + 1.0 / 6.0,
                0.375 + 1.0 / 3.0,
            ],
            1.0,
        );
        assert!(energy(&stereo[stereo.len() - (0.02 * rate as f64) as usize..]) < 1e-9);
    }
}

#[test]
fn renderer_rejects_invalid_persisted_sound_before_install() {
    use tabplayer_lib::{
        audio::{dsp::FxSettings, renderer::Renderer},
        settings::TrackSound,
    };
    let (plan, resources, mut settings) = renderer_fixture(false);
    settings.sounds.insert(
        "a".into(),
        TrackSound {
            voice_id: None,
            preset_id: "missing-preset".into(),
            effects: FxSettings::default(),
            ..Default::default()
        },
    );
    assert!(Renderer::new(plan, resources, settings, 48_000).is_err());
}

#[test]
fn automatic_program_changes_prepare_recorded_and_gm_attacks_and_seek() {
    use tabplayer_lib::{
        audio::{renderer::Renderer, voices::resource_requests},
        settings::TrackSound,
    };
    let (_, mut resources, mut settings) = renderer_fixture(false);
    let bank = Arc::get_mut(&mut resources).unwrap();
    let mut bass = bank.manifest.instruments[0].clone();
    bass.id = "babyblue-bass".into();
    bass.regions[0].sample_id = "bass".into();
    bank.manifest.instruments.push(bass);
    let mut audio = (*tone()).clone();
    audio.frames = Arc::new(
        (0..96_000)
            .map(|n| {
                let x = (std::f64::consts::TAU * 110.0 * n as f64 / 48_000.0).sin() as f32 * 0.5;
                [x; 2]
            })
            .collect(),
    );
    bank.samples.insert("bass".into(), Arc::new(audio));
    let notes: Vec<_> = [(0, 240, 57, 25), (1920, 2880, 69, 0), (3840, 4800, 57, 33)]
        .into_iter()
        .enumerate()
        .map(|(i, (start, end, key, program))| serde_json::json!({
            "id":format!("n{i}"),"trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":i},"string":1},
            "occurrence":0,"channel":2,"program":program,"startTick":start,"endTick":end,"key":key,"velocity":100,
            "articulation":"picked","legatoFrom":null,"pitch":[{"tick":start,"semitones":0}]
        }))
        .collect();
    let mut midi = Vec::new();
    for (start, end, key, program) in [(0, 240, 57, 25), (1920, 2880, 69, 0), (3840, 4800, 57, 33)]
    {
        midi.extend([
            serde_json::json!({"type":"program","trackId":"a","tick":start,"channel":2,"program":program}),
            serde_json::json!({"type":"noteOn","trackId":"a","tick":start,"channel":2,"key":key,"velocity":100}),
            serde_json::json!({"type":"noteOff","trackId":"a","tick":end,"channel":2,"key":key,"velocity":0}),
        ]);
    }
    let plan: Arc<tabplayer_lib::audio::plan::PlaybackPlan> = Arc::new(serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":5760,"durationMs":3000,
        "tracks":[{"id":"a","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":6,"meterDenominator":4,"startTick":0,"endTick":5760,"startMs":0,"endMs":3000}],
        "notes":notes,"midi":midi
    })).unwrap());
    let requests = resource_requests(&plan, &settings);
    assert!(requests.iter().any(|r| r.instrument_id == "green-guitar"));
    assert!(requests.iter().any(|r| r.instrument_id == "babyblue-bass"));
    let mut automatic =
        Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 144_000];
    automatic.render_into(&mut output);
    assert!((frequency(&output[2400..4800]) - 220.0).abs() < 1.0);
    assert!((frequency(&output[98_400..100_800]) - 110.0).abs() < 1.0);
    settings.sounds.insert(
        "a".into(),
        TrackSound {
            voice_id: Some("gm".into()),
            preset_id: "gm".into(),
            effects: Default::default(),
            ..Default::default()
        },
    );
    let mut gm = Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
    gm.seek_tick(1920.0);
    let mut piano = vec![[0.0; 2]; 2400];
    gm.render_into(&mut piano);
    assert!(energy(&piano) > 1e-5);
    let difference: f64 = piano
        .iter()
        .zip(&output[48_000..50_400])
        .map(|(a, b)| ((a[0] - b[0]) as f64).powi(2))
        .sum::<f64>()
        / piano.len() as f64;
    assert!(
        difference < 1e-10,
        "automatic piano differs from GM reference: {difference}"
    );
    automatic.seek_tick(1920.0);
    let mut seek = vec![[0.0; 2]; piano.len()];
    automatic.render_into(&mut seek);
    assert_eq!(seek, piano);
    automatic.seek_tick(3840.0);
    automatic.render_into(&mut seek);
    assert!((frequency(&seek[480..]) - 110.0).abs() < 1.0);
    settings.sounds.get_mut("a").unwrap().voice_id = Some("green-guitar".into());
    assert!(
        resource_requests(&plan, &settings)
            .iter()
            .all(|r| r.instrument_id == "green-guitar")
    );
    let mut fixed = Renderer::new(plan, resources, settings, 48_000).unwrap();
    fixed.seek_tick(3840.0);
    fixed.render_into(&mut seek);
    assert!((frequency(&seek[480..]) - 220.0).abs() < 1.0);
}

#[test]
fn simultaneous_same_channel_attacks_keep_their_exact_programs() {
    use tabplayer_lib::{audio::renderer::Renderer, settings::TrackSound};
    let (plan, resources, settings) = renderer_fixture(false);
    let mut plan = (*plan).clone();
    plan.tracks.truncate(1);
    plan.notes.truncate(1);
    plan.notes[0].channel = Some(2);
    plan.notes[0].program = Some(25);
    let mut piano = plan.notes[0].clone();
    piano.id = "piano".into();
    piano.program = Some(0);
    piano.source.target.beat = 1;
    plan.notes.push(piano);
    // Captured attack programs remain authoritative when channel programs precede both attacks.
    plan.midi = serde_json::from_value(serde_json::json!([
        {"type":"program","trackId":"a","tick":0,"channel":2,"program":25},
        {"type":"program","trackId":"a","tick":0,"channel":2,"program":0},
        {"type":"noteOn","trackId":"a","tick":0,"channel":2,"key":57,"velocity":100},
        {"type":"noteOn","trackId":"a","tick":0,"channel":2,"key":57,"velocity":100},
        {"type":"noteOff","trackId":"a","tick":1920,"channel":2,"key":57,"velocity":0},
        {"type":"noteOff","trackId":"a","tick":1920,"channel":2,"key":57,"velocity":0}
    ]))
    .unwrap();
    for force_gm in [false, true] {
        let mut settings = settings.clone();
        if force_gm {
            settings.sounds.insert(
                "a".into(),
                TrackSound {
                    voice_id: Some("gm".into()),
                    preset_id: "gm".into(),
                    effects: Default::default(),
                    ..Default::default()
                },
            );
        }
        let mut both = Renderer::new(
            Arc::new(plan.clone()),
            resources.clone(),
            settings.clone(),
            48000,
        )
        .unwrap();
        let mut references:Vec<_>=(0..2).map(|index| {
            let mut single=plan.clone();
            single.notes=vec![plan.notes[index].clone()];
            single.midi=serde_json::from_value(serde_json::json!([
                {"type":"program","trackId":"a","tick":0,"channel":2,"program":single.notes[0].program.unwrap()},
                {"type":"noteOn","trackId":"a","tick":0,"channel":2,"key":57,"velocity":100},
                {"type":"noteOff","trackId":"a","tick":1920,"channel":2,"key":57,"velocity":0}
            ])).unwrap();
            Renderer::new(Arc::new(single),resources.clone(),settings.clone(),48000).unwrap()
        }).collect();
        for seek in [0.0, 240.0] {
            both.seek_tick(seek);
            let mut mixed = vec![[0.0; 2]; 4800];
            both.render_into(&mut mixed);
            let mut sum = vec![[0.0; 2]; 4800];
            for reference in &mut references {
                reference.seek_tick(seek);
                let mut output = vec![[0.0; 2]; 4800];
                reference.render_into(&mut output);
                for (sum, part) in sum.iter_mut().zip(output) {
                    for c in 0..2 {
                        sum[c] += part[c];
                    }
                }
            }
            assert!(
                mixed
                    .iter()
                    .zip(sum)
                    .all(|(a, b)| (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6),
                "simultaneous programs changed at seek {seek}, forceGM={force_gm}"
            );
        }
    }
}

#[test]
fn recorded_midi_volume_expression_pan_and_sustain_apply_with_app_mix() {
    use tabplayer_lib::audio::renderer::Renderer;
    let (plan, resources, mut settings) = renderer_fixture(false);
    settings.mixes.entry("a".into()).or_default().gain = 0.5;
    let mut base = (*plan).clone();
    base.tracks.truncate(1);
    base.notes.truncate(1);
    base.notes[0].end_tick = 2880.0;
    let controller = |tick, number, value| {
        serde_json::from_value(serde_json::json!({
        "type":"controller","trackId":"a","tick":tick,"channel":0,"controller":number,"value":value
    })).unwrap()
    };
    for number in [7, 11] {
        let mut plan = base.clone();
        plan.midi = vec![controller(960, number, 0)];
        let mut renderer =
            Renderer::new(Arc::new(plan), resources.clone(), settings.clone(), 48_000).unwrap();
        let mut output = vec![[0.0; 2]; 48_000];
        renderer.render_into(&mut output);
        assert!(energy(&output[2400..12000]) > 0.001);
        assert!(energy(&output[28800..]) < 1e-9, "CC{number} was ignored");
    }
    let mut other_channel = base.clone();
    other_channel.notes[0].channel = Some(2);
    other_channel.midi=vec![controller(0,7,0),serde_json::from_value(serde_json::json!({"type":"controller","trackId":"a","tick":960,"channel":2,"controller":7,"value":0})).unwrap()];
    let mut renderer = Renderer::new(
        Arc::new(other_channel),
        resources.clone(),
        settings.clone(),
        48000,
    )
    .unwrap();
    let mut output = vec![[0.0; 2]; 48000];
    renderer.render_into(&mut output);
    assert!(
        energy(&output[2400..12000]) > 0.001,
        "unrelated channel CC7 silenced the note"
    );
    assert!(
        energy(&output[28800..]) < 1e-9,
        "attack channel CC7 was ignored"
    );
    let mut plan = base.clone();
    plan.midi = vec![controller(0, 10, 0), controller(960, 10, 127)];
    let mut renderer =
        Renderer::new(Arc::new(plan), resources.clone(), settings.clone(), 48_000).unwrap();
    let mut panned = vec![[0.0; 2]; 48_000];
    renderer.render_into(&mut panned);
    assert!(panned[2400..12000].iter().all(|x| x[1].abs() < 1e-6));
    assert!(energy(&panned[2400..12000]) > 0.001);
    assert!(
        panned[28800..]
            .iter()
            .all(|x| x[0].abs() < 1e-6 && x[1].is_finite())
    );
    assert!(
        panned[28800..]
            .iter()
            .map(|x| (x[1] * x[1]) as f64)
            .sum::<f64>()
            > 1.0
    );
    let mut no_app_gain = settings.clone();
    no_app_gain.mixes.get_mut("a").unwrap().gain = 1.0;
    let mut reference = Renderer::new(
        Arc::new(base.clone()),
        resources.clone(),
        no_app_gain,
        48_000,
    )
    .unwrap();
    let mut reference_output = vec![[0.0; 2]; 12000];
    reference.render_into(&mut reference_output);
    assert!((energy(&panned[2400..12000]) / energy(&reference_output[2400..]) - 0.5).abs() < 0.002);
    let mut plan = base;
    plan.notes[0].end_tick = 960.0;
    plan.midi = vec![controller(0, 64, 127), controller(2880, 64, 0)];
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 96000];
    renderer.render_into(&mut output);
    assert!(
        energy(&output[36000..48000]) > 0.001,
        "pedal did not sustain the recorded note"
    );
    assert!(energy(&output[84000..]) < 1e-9);
    renderer.seek_tick(1920.0);
    let mut seek = vec![[0.0; 2]; 4800];
    renderer.render_into(&mut seek);
    assert!(
        energy(&seek[480..]) > 0.001,
        "seek lost pedal-held recorded note"
    );
}

#[test]
fn positive_low_tempos_render_with_bypassed_and_enabled_effects() {
    use tabplayer_lib::{
        audio::{dsp::FxSettings, renderer::Renderer},
        settings::TrackSound,
    };
    let (plan, resources, settings) = renderer_fixture(false);
    for bpm in [1.0, 4.0, 7.0] {
        let mut plan = (*plan).clone();
        plan.tempos[0].bpm = bpm;
        plan.duration_ms = 240_000.0 / bpm;
        plan.occurrences[0].end_ms = plan.duration_ms;
        for delay in [false, true] {
            let mut settings = settings.clone();
            let mut effects = FxSettings::default();
            effects.delay.enabled = delay;
            settings.sounds.insert(
                "a".into(),
                TrackSound {
                    voice_id: None,
                    preset_id: "gm".into(),
                    effects,
                    ..Default::default()
                },
            );
            let mut renderer =
                Renderer::new(Arc::new(plan.clone()), resources.clone(), settings, 48_000).unwrap();
            let mut output = vec![[0.0; 2]; 4800];
            renderer.render_into(&mut output);
            assert!(output.iter().flatten().all(|x| x.is_finite()));
            assert!(energy(&output[480..]) > 0.001);
        }
    }
}

#[test]
#[ignore = "requires the prepared pinned CC0 bank; run cargo test --test audio_render -- --ignored"]
fn pinned_recorded_presets_render_at_both_export_rates() {
    use tabplayer_lib::{
        audio::{
            dsp::FxSettings,
            plan::{MeasureOccurrence, PitchPoint},
            renderer::Renderer,
            resources::AudioResources,
            voices::resource_requests,
        },
        settings::TrackSound,
    };
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.analysis/expansion/audio-demos");
    std::fs::create_dir_all(&directory).unwrap();
    for (voice, preset, program, key) in [
        ("green-guitar", "clean", 24, 57),
        ("black-guitar", "crunch", 27, 57),
        ("black-guitar", "lead", 30, 57),
        ("darkblack-bass", "bass", 32, 40),
    ] {
        if std::env::var("TABPLAYER_DEMO_PRESETS")
            .is_ok_and(|list| !list.split(',').any(|name| name == preset))
        {
            continue;
        }
        let (base, _, mut settings) = renderer_fixture(false);
        let mut plan = (*base).clone();
        plan.tracks.truncate(1);
        plan.tracks[0].program = program;
        plan.notes.clear();
        plan.duration_tick = 15360.0;
        plan.duration_ms = 8000.0;
        plan.occurrences = (0..4)
            .map(|bar| MeasureOccurrence {
                bar,
                occurrence: 0,
                meter_numerator: 4,
                meter_denominator: 4,
                start_tick: bar as f64 * 3840.0,
                end_tick: (bar + 1) as f64 * 3840.0,
                start_ms: bar as f64 * 2000.0,
                end_ms: (bar + 1) as f64 * 2000.0,
                click_ticks: None,
            })
            .collect();
        let techniques = [
            Articulation::Picked,
            Articulation::Muted,
            Articulation::Dead,
            Articulation::Ghost,
            Articulation::Staccato,
            Articulation::Legato,
            Articulation::Harmonic,
            Articulation::Feedback,
        ];
        for (index, articulation) in techniques.into_iter().enumerate() {
            let mut note = base.notes[0].clone();
            note.id = format!("demo-{index}");
            note.source.target.bar = (index / 2) as u32;
            note.source.target.beat = (index % 2) as u32;
            note.start_tick = index as f64 * 1920.0;
            note.end_tick = (index + 1) as f64 * 1920.0;
            note.key = key + if index == 6 { 12 } else { 0 };
            note.velocity = if index % 2 == 0 { 115 } else { 55 };
            note.articulation = articulation;
            note.legato_from = if index == 5 {
                Some("demo-4".into())
            } else {
                None
            };
            note.pitch = vec![PitchPoint {
                tick: note.start_tick,
                semitones: 0.0,
            }];
            if index == 0 {
                note.pitch.push(PitchPoint {
                    tick: note.end_tick,
                    semitones: 2.0,
                });
            }
            plan.notes.push(note);
        }
        settings.sounds.insert(
            "a".into(),
            TrackSound {
                voice_id: Some(voice.into()),
                preset_id: preset.into(),
                effects: FxSettings::preset(preset).unwrap(),
                ..Default::default()
            },
        );
        let requests = resource_requests(&plan, &settings);
        let resources = Arc::new(
            AudioResources::load_for_requests(
                &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &requests,
            )
            .unwrap(),
        );
        assert!(resources.samples.len() > 8);
        for rate in [44_100, 48_000] {
            let mut renderer = Renderer::new(
                Arc::new(plan.clone()),
                resources.clone(),
                settings.clone(),
                rate,
            )
            .unwrap();
            let suffix = if ["crunch", "lead"].contains(&preset) {
                "-v2"
            } else {
                "-release-v2"
            };
            let output_path = directory.join(format!("{preset}{suffix}-{rate}.wav"));
            let spec = hound::WavSpec {
                channels: 2,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&output_path, spec).unwrap();
            let mut block = [[0.0; 2]; 512];
            let mut squared = 0.0f64;
            let mut peak = 0.0f32;
            let frames = rate as usize * 11;
            let mut rendered = 0;
            while rendered < frames {
                let count = (frames - rendered).min(512);
                if rendered >= rate as usize * 8 {
                    renderer.begin_tail();
                }
                renderer.render_into(&mut block[..count]);
                for sample in &block[..count] {
                    for &value in sample {
                        assert!(value.is_finite() && value.abs() <= 1.0);
                        squared += value as f64 * value as f64;
                        peak = peak.max(value.abs());
                        writer
                            .write_sample((value * 32767.0).round() as i16)
                            .unwrap();
                    }
                }
                rendered += count;
            }
            writer.finalize().unwrap();
            assert!(squared / frames as f64 > 1e-7);
            println!(
                "{preset} {rate}Hz: {frames} frames peak={peak:.4} RMS={:.4}; {}",
                (squared / (frames * 2) as f64).sqrt(),
                output_path.display()
            );
        }
    }
}

#[test]
fn locked_track_sound_ignores_scheduled_program_changes_and_seek_while_unlocked_renders_bit_identically()
 {
    use tabplayer_lib::{
        audio::{renderer::Renderer, voices::resource_requests},
        settings::TrackSound,
    };
    let (_, mut resources, settings) = renderer_fixture(false);
    let bank = Arc::get_mut(&mut resources).unwrap();
    let mut bass = bank.manifest.instruments[0].clone();
    bass.id = "babyblue-bass".into();
    bass.regions[0].sample_id = "bass".into();
    bank.manifest.instruments.push(bass);
    let mut audio = (*tone()).clone();
    audio.frames = Arc::new(
        (0..96_000)
            .map(|n| {
                let x = (std::f64::consts::TAU * 110.0 * n as f64 / 48_000.0).sin() as f32 * 0.5;
                [x; 2]
            })
            .collect(),
    );
    bank.samples.insert("bass".into(), Arc::new(audio));
    let notes: Vec<_> = [(0, 240, 57, 25), (1920, 2880, 69, 0), (3840, 4800, 57, 33)]
        .into_iter()
        .enumerate()
        .map(|(i, (start, end, key, program))| serde_json::json!({
            "id":format!("n{i}"),"trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":i},"string":1},
            "occurrence":0,"channel":2,"program":program,"startTick":start,"endTick":end,"key":key,"velocity":100,
            "articulation":"picked","legatoFrom":null,"pitch":[{"tick":start,"semitones":0}]
        }))
        .collect();
    let mut midi = Vec::new();
    for (start, end, key, program) in [(0, 240, 57, 25), (1920, 2880, 69, 0), (3840, 4800, 57, 33)]
    {
        midi.extend([
            serde_json::json!({"type":"program","trackId":"a","tick":start,"channel":2,"program":program}),
            serde_json::json!({"type":"noteOn","trackId":"a","tick":start,"channel":2,"key":key,"velocity":100}),
            serde_json::json!({"type":"noteOff","trackId":"a","tick":end,"channel":2,"key":key,"velocity":0}),
        ]);
    }
    let plan: Arc<tabplayer_lib::audio::plan::PlaybackPlan> = Arc::new(serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":5760,"durationMs":3000,
        "tracks":[{"id":"a","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":6,"meterDenominator":4,"startTick":0,"endTick":5760,"startMs":0,"endMs":3000}],
        "notes":notes,"midi":midi
    })).unwrap());

    // 1. Bit-identical proof: an unlocked document renders identically to default settings.
    let mut default_renderer =
        Renderer::new(plan.clone(), resources.clone(), settings.clone(), 48_000).unwrap();
    let mut unlocked_settings = settings.clone();
    unlocked_settings.sounds.insert(
        "a".into(),
        TrackSound {
            voice_id: None,
            preset_id: "gm".into(),
            effects: Default::default(),
            locked: false,
            drum_kit: None,
            plugin: None,
        },
    );
    let mut unlocked_renderer =
        Renderer::new(plan.clone(), resources.clone(), unlocked_settings, 48_000).unwrap();
    let mut default_output = vec![[0.0; 2]; 144_000];
    let mut unlocked_output = vec![[0.0; 2]; 144_000];
    default_renderer.render_into(&mut default_output);
    unlocked_renderer.render_into(&mut unlocked_output);
    for (i, (d, u)) in default_output.iter().zip(&unlocked_output).enumerate() {
        assert_eq!(
            d.map(f32::to_bits),
            u.map(f32::to_bits),
            "frame {i} must render bit-identically when unlocked"
        );
    }

    // 2. Locked track sound: score automations (program 0 piano and program 33 bass) are ignored.
    // The track's sound remains locked to green-guitar (program 25).
    let mut locked_settings = settings.clone();
    locked_settings.sounds.insert(
        "a".into(),
        TrackSound {
            voice_id: None,
            preset_id: "gm".into(),
            effects: Default::default(),
            locked: true,
            drum_kit: None,
            plugin: None,
        },
    );
    let requests = resource_requests(&plan, &locked_settings);
    assert!(
        requests.iter().all(|r| r.instrument_id == "green-guitar"),
        "all requests for a locked guitar track must be green-guitar"
    );

    let mut locked = Renderer::new(
        plan.clone(),
        resources.clone(),
        locked_settings.clone(),
        48_000,
    )
    .unwrap();
    let mut locked_output = vec![[0.0; 2]; 144_000];
    locked.render_into(&mut locked_output);
    // At tick 0 (green-guitar, ~220Hz):
    assert!((frequency(&locked_output[2400..4800]) - 220.0).abs() < 1.0);
    // At tick 1920 (score has program 0 piano, but locked track keeps green-guitar ~220Hz):
    let f1 = frequency(&locked_output[48_000..50_400]);
    println!("f1={}", f1);
    assert!((f1 - 440.0).abs() < 1.0);
    // At tick 3840 (score has program 33 bass, but locked track keeps green-guitar ~220Hz):
    assert!((frequency(&locked_output[98_400..100_800]) - 220.0).abs() < 1.0);

    // 3. Seeking while locked maintains the locked track sound.
    let mut seek = vec![[0.0; 2]; 2400];
    locked.seek_tick(1920.0);
    locked.render_into(&mut seek);
    assert!((frequency(&seek[480..]) - 440.0).abs() < 1.0);
    locked.seek_tick(3840.0);
    locked.render_into(&mut seek);
    assert!((frequency(&seek[480..]) - 220.0).abs() < 1.0);
}
/// A General MIDI track whose guitar program is replaced by a piano at bar one. With `automated`, the score later
/// switches to a violin at 960 and plays a note at 1920 as one, both as an attack the plan matched and as one it did not.
fn lock_plan(
    automated: bool,
    matched: bool,
    bar_one: bool,
) -> Arc<tabplayer_lib::audio::plan::PlaybackPlan> {
    let mut midi = vec![];
    if bar_one {
        midi.push(
            serde_json::json!({"type":"program","trackId":"a","tick":0,"channel":0,"program":0}),
        );
    }
    let mut notes = vec![];
    for (index, (start, end, program)) in [(0, 960, 0), (1920, 2880, 40)].into_iter().enumerate() {
        if start > 0 && automated {
            midi.push(serde_json::json!({"type":"program","trackId":"a","tick":960,"channel":0,"program":40}));
        }
        midi.extend([
            serde_json::json!({"type":"noteOn","trackId":"a","tick":start,"channel":0,"key":60,"velocity":100}),
            serde_json::json!({"type":"noteOff","trackId":"a","tick":end,"channel":0,"key":60,"velocity":0}),
        ]);
        if matched {
            let mut note = serde_json::json!({
                "id":format!("n{index}"),"trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":index},"string":1},
                "occurrence":0,"channel":0,"startTick":start,"endTick":end,"key":60,"velocity":100,
                "articulation":"picked","legatoFrom":null,"pitch":[{"tick":start,"semitones":0}]
            });
            if automated {
                note["program"] = serde_json::json!(program);
            }
            notes.push(note);
        }
    }
    Arc::new(
        serde_json::from_value(serde_json::json!({
            "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
            "tracks":[{"id":"a","program":24,"percussion":false},{"id":"b","program":24,"percussion":false}],
            "tempos":[{"tick":0,"bpm":120}],
            "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
            "notes":notes,"midi":midi
        }))
        .unwrap(),
    )
}
fn gm_lock_settings(locked: bool) -> tabplayer_lib::settings::DocumentSettings {
    let mut settings = tabplayer_lib::settings::DocumentSettings::default();
    settings.sounds.insert(
        "a".into(),
        tabplayer_lib::settings::TrackSound {
            voice_id: Some("gm".into()),
            preset_id: "gm".into(),
            effects: Default::default(),
            locked,
            drum_kit: None,
            plugin: None,
        },
    );
    settings
}
fn differs(a: &[[f32; 2]], b: &[[f32; 2]]) -> bool {
    a.iter()
        .zip(b)
        .any(|(x, y)| x.map(f32::to_bits) != y.map(f32::to_bits))
}
fn render_frames(
    plan: &Arc<tabplayer_lib::audio::plan::PlaybackPlan>,
    settings: tabplayer_lib::settings::DocumentSettings,
    seek: Option<f64>,
    mix: Option<tabplayer_lib::audio::renderer::PreparedMix>,
) -> Vec<[f32; 2]> {
    use tabplayer_lib::audio::renderer::Renderer;
    let (_, resources, _) = renderer_fixture(false);
    let mut renderer = Renderer::new(plan.clone(), resources, settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 96_000];
    if let Some(tick) = seek {
        renderer.seek_tick(tick);
    }
    if let Some(mix) = mix {
        let mut head = vec![[0.0; 2]; 4_800];
        renderer.render_into(&mut head);
        renderer.replace_mix(mix);
        renderer.render_into(&mut output);
        return [head, output].concat();
    }
    renderer.render_into(&mut output);
    output
}

#[test]
fn a_locked_track_keeps_its_bar_one_sound_through_attacks_program_changes_and_seeks() {
    // Both ways the renderer learns a program: the program an attack carries, and the program changes it follows.
    for matched in [true, false] {
        let baseline = lock_plan(false, matched, true);
        let automated = lock_plan(true, matched, true);
        let reference = render_frames(&baseline, gm_lock_settings(false), None, None);
        assert!(energy(&reference) > 1e-6);
        // Unlocked, the later violin is heard, so the plans really differ.
        let unlocked = render_frames(&automated, gm_lock_settings(false), None, None);
        assert!(
            differs(&unlocked, &reference),
            "matched={matched}: the automation must be audible unlocked"
        );
        // Locked, the automation changes nothing.
        let locked = render_frames(&automated, gm_lock_settings(true), None, None);
        assert!(
            !differs(&locked, &reference),
            "matched={matched}: a locked track must ignore the automation"
        );
        // A seek past the automation lands on the same locked sound.
        let reference_seek = render_frames(&baseline, gm_lock_settings(false), Some(2000.0), None);
        let unlocked_seek = render_frames(&automated, gm_lock_settings(false), Some(2000.0), None);
        let locked_seek = render_frames(&automated, gm_lock_settings(true), Some(2000.0), None);
        assert!(
            differs(&unlocked_seek, &reference_seek),
            "matched={matched}: a seek must hear the automation unlocked"
        );
        assert!(
            !differs(&locked_seek, &reference_seek),
            "matched={matched}: a seek must keep the locked sound"
        );
    }
}

#[test]
fn locking_keeps_the_sound_in_effect_at_the_start_not_the_track_first_sound() {
    for matched in [true, false] {
        // The track is a guitar (24) but bar one switches it to a piano (0): the lock is to the piano.
        let bar_one = lock_plan(false, matched, true);
        let unlocked = render_frames(&bar_one, gm_lock_settings(false), None, None);
        let locked = render_frames(&bar_one, gm_lock_settings(true), None, None);
        assert!(
            !differs(&locked, &unlocked),
            "matched={matched}: locking must not change a bar-one sound"
        );
        let guitar = render_frames(
            &lock_plan(false, matched, false),
            gm_lock_settings(true),
            None,
            None,
        );
        assert!(
            differs(&locked, &guitar),
            "matched={matched}: the locked sound must be the piano, not the track's guitar"
        );
    }
}

#[test]
fn a_locked_track_ignores_automation_in_export_and_after_a_mix_change() {
    use tabplayer_lib::{
        audio::renderer::{PreparedMix, Renderer},
        export::{
            audio::{AudioExportRender, AudioExportRequest},
            stems::{StemKind, StemTrack},
            wav::AudioFormat,
        },
    };
    for matched in [true, false] {
        let baseline = lock_plan(false, matched, true);
        let automated = lock_plan(true, matched, true);
        // The mix an export writes.
        let export = |plan: &Arc<tabplayer_lib::audio::plan::PlaybackPlan>, locked: bool| {
            let (_, resources, _) = renderer_fixture(false);
            let renderer =
                Renderer::new(plan.clone(), resources, gm_lock_settings(locked), 48_000).unwrap();
            let request = AudioExportRequest {
                tracks: vec![StemTrack {
                    id: "a".into(),
                    name: "Guitar".into(),
                    preset: "gm".into(),
                    kind: StemKind::Score,
                }],
                range: None,
                format: AudioFormat::wav(48_000, 24),
                speed: 1.0,
                metronome: false,
                metronome_sound: Default::default(),
                tail_seconds: 0.0,
                include_backing: false,
                include_mix: true,
                normalize_rms_db: None,
            };
            let mut render = AudioExportRender::new(renderer, plan, request).unwrap();
            let mut all = vec![];
            loop {
                let mut block = vec![[0.0; 2]; 4096];
                let n = render.render_mix(&mut block).unwrap();
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&block[..n]);
            }
            all
        };
        let reference = export(&baseline, false);
        assert!(energy(&reference) > 1e-6);
        assert!(
            differs(&export(&automated, false), &reference),
            "the automation must be audible in an unlocked export"
        );
        assert!(
            !differs(&export(&automated, true), &reference),
            "a locked track must ignore the automation in an export"
        );
        // A mix change reaches a renderer built locked without unlocking it.
        let mix = tabplayer_lib::settings::ChannelMix {
            gain: 0.5,
            ..Default::default()
        };
        let mut locked_settings = gm_lock_settings(true);
        locked_settings.mixes.insert("a".into(), mix.clone());
        let mut unlocked_settings = gm_lock_settings(false);
        unlocked_settings.mixes.insert("a".into(), mix);
        let prepared = |settings: &tabplayer_lib::settings::DocumentSettings, plan| {
            PreparedMix::prepare(settings, plan, 48_000).unwrap()
        };
        let want = render_frames(
            &baseline,
            gm_lock_settings(false),
            None,
            Some(prepared(&unlocked_settings, &baseline)),
        );
        let heard = render_frames(
            &automated,
            gm_lock_settings(false),
            None,
            Some(prepared(&unlocked_settings, &automated)),
        );
        let got = render_frames(
            &automated,
            gm_lock_settings(true),
            None,
            Some(prepared(&locked_settings, &automated)),
        );
        assert!(
            differs(&heard, &want),
            "the automation must be audible after a mix change when unlocked"
        );
        assert!(
            !differs(&got, &want),
            "a mix change must leave a locked track locked"
        );
    }
}
#[test]
fn unlocking_needs_the_samples_an_unlocked_track_asks_for_that_a_locked_bank_lacks() {
    use tabplayer_lib::{
        audio::{renderer::Renderer, voices::resource_requests},
        settings::TrackSound,
    };
    // A guitar the score switches to a bass: locked, only the guitar is needed.
    let notes: Vec<_> = [(0, 960, 25), (1920, 2880, 33)]
        .into_iter()
        .enumerate()
        .map(|(i, (start, end, program))| serde_json::json!({
            "id":format!("n{i}"),"trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":i},"string":1},
            "occurrence":0,"channel":0,"program":program,"startTick":start,"endTick":end,"key":57,"velocity":100,
            "articulation":"picked","legatoFrom":null,"pitch":[{"tick":start,"semitones":0}]
        }))
        .collect();
    let plan: Arc<tabplayer_lib::audio::plan::PlaybackPlan> = Arc::new(serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
        "tracks":[{"id":"a","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
        "notes":notes,"midi":[]
    })).unwrap());
    let settings = |locked| {
        let mut settings = tabplayer_lib::settings::DocumentSettings::default();
        settings.sounds.insert(
            "a".into(),
            TrackSound {
                voice_id: None,
                preset_id: "gm".into(),
                effects: Default::default(),
                locked,
                drum_kit: None,
                plugin: None,
            },
        );
        settings
    };
    let ids = |locked| -> std::collections::BTreeSet<String> {
        resource_requests(&plan, &settings(locked))
            .into_iter()
            .map(|r| r.instrument_id)
            .collect()
    };
    assert_eq!(ids(true), ["green-guitar".to_string()].into());
    assert_eq!(
        ids(false),
        ["babyblue-bass".to_string(), "green-guitar".to_string()].into()
    );
    // The bank loaded for the locked track cannot build the unlocked one: it must be loaded again for the new settings.
    let (_, mut resources, _) = renderer_fixture(false);
    assert!(Renderer::new(plan.clone(), resources.clone(), settings(true), 48_000).is_ok());
    let error = Renderer::new(plan.clone(), resources.clone(), settings(false), 48_000)
        .err()
        .expect("a locked-era bank has no bass");
    assert_eq!(error, "Unknown recorded instrument babyblue-bass.");
    let bank = Arc::get_mut(&mut resources).unwrap();
    let mut bass = bank.manifest.instruments[0].clone();
    bass.id = "babyblue-bass".into();
    bank.manifest.instruments.push(bass);
    assert!(Renderer::new(plan, resources, settings(false), 48_000).is_ok());
}
#[test]
fn a_locked_track_plays_the_articulation_its_start_sound_gives() {
    use tabplayer_lib::audio::voices::{resource_requests, with_locked_articulations};
    // The score switches a guitar to a bass, so the note is fingered; kept, it is picked as the guitar plays it.
    let plan: Arc<tabplayer_lib::audio::plan::PlaybackPlan> = Arc::new(serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
        "tracks":[{"id":"a","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
        "notes":[{"id":"n0","trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},
            "occurrence":0,"channel":0,"program":33,"startTick":0,"endTick":960,"key":57,"velocity":100,
            "articulation":"fingered","lockedArticulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}],
        "midi":[]
    })).unwrap());
    let sound = |locked| {
        let mut settings = tabplayer_lib::settings::DocumentSettings::default();
        settings.sounds.insert(
            "a".into(),
            tabplayer_lib::settings::TrackSound {
                voice_id: Some("green-guitar".into()),
                preset_id: "gm".into(),
                effects: Default::default(),
                locked,
                drum_kit: None,
                plugin: None,
            },
        );
        settings
    };
    let articulations = |locked| -> Vec<String> {
        resource_requests(&plan, &sound(locked))
            .into_iter()
            .map(|r| r.articulation)
            .collect()
    };
    assert!(articulations(false).contains(&"fingered".to_string()));
    assert!(articulations(true).iter().all(|a| a == "picked"));
    use tabplayer_lib::audio::plan::Articulation;
    assert_eq!(
        with_locked_articulations(plan.clone(), &sound(true)).notes[0].articulation,
        Articulation::Picked
    );
    let unlocked = with_locked_articulations(plan.clone(), &sound(false));
    assert!(Arc::ptr_eq(&unlocked, &plan));
    assert_eq!(unlocked.notes[0].articulation, Articulation::Fingered);
}
#[test]
fn a_real_renderer_and_export_play_the_locked_articulation_only_when_locked() {
    use tabplayer_lib::{
        audio::renderer::Renderer,
        export::{
            audio::{AudioExportRender, AudioExportRequest},
            stems::{StemKind, StemTrack},
            wav::AudioFormat,
        },
    };
    // A guitar whose "fingered" articulation is a different sample (110 Hz) from its "picked" one (220 Hz).
    let (_, mut resources, _) = renderer_fixture(false);
    let bank = Arc::get_mut(&mut resources).unwrap();
    let mut fingered = bank.manifest.instruments[0].regions[0].clone();
    fingered.sample_id = "low".into();
    fingered.articulation = "fingered".into();
    bank.manifest.instruments[0].regions.push(fingered);
    let mut audio = (*tone()).clone();
    audio.frames = Arc::new(
        (0..96_000)
            .map(|n| {
                let x = (std::f64::consts::TAU * 110.0 * n as f64 / 48_000.0).sin() as f32 * 0.5;
                [x; 2]
            })
            .collect(),
    );
    bank.samples.insert("low".into(), Arc::new(audio));
    let plan = |articulation: &str,
                kept: Option<&str>|
     -> Arc<tabplayer_lib::audio::plan::PlaybackPlan> {
        let mut note = serde_json::json!({
            "id":"n0","trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},
            "occurrence":0,"channel":0,"startTick":0,"endTick":1920,"key":57,"velocity":100,
            "articulation":articulation,"legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]
        });
        if let Some(kept) = kept {
            note["lockedArticulation"] = serde_json::json!(kept);
        }
        Arc::new(serde_json::from_value(serde_json::json!({
            "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
            "tracks":[{"id":"a","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],
            "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
            "notes":[note],"midi":[]
        })).unwrap())
    };
    let settings = |locked| {
        let mut settings = tabplayer_lib::settings::DocumentSettings::default();
        settings.sounds.insert(
            "a".into(),
            tabplayer_lib::settings::TrackSound {
                voice_id: Some("green-guitar".into()),
                preset_id: "gm".into(),
                effects: Default::default(),
                locked,
                drum_kit: None,
                plugin: None,
            },
        );
        settings
    };
    let renderer = |plan: &Arc<tabplayer_lib::audio::plan::PlaybackPlan>, locked| {
        Renderer::new(plan.clone(), resources.clone(), settings(locked), 48_000).unwrap()
    };
    let render = |plan: &Arc<tabplayer_lib::audio::plan::PlaybackPlan>, locked| {
        let mut output = vec![[0.0; 2]; 48_000];
        renderer(plan, locked).render_into(&mut output);
        output
    };
    let export = |plan: &Arc<tabplayer_lib::audio::plan::PlaybackPlan>, locked| {
        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "a".into(),
                name: "Guitar".into(),
                preset: "gm".into(),
                kind: StemKind::Score,
            }],
            range: None,
            format: AudioFormat::wav(48_000, 24),
            speed: 1.0,
            metronome: false,
            metronome_sound: Default::default(),
            tail_seconds: 0.0,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        };
        let mut export = AudioExportRender::new(renderer(plan, locked), plan, request).unwrap();
        let mut all = vec![];
        loop {
            let mut block = vec![[0.0; 2]; 4096];
            let n = export.render_mix(&mut block).unwrap();
            if n == 0 {
                break;
            }
            all.extend_from_slice(&block[..n]);
        }
        all
    };
    let automated = plan("fingered", Some("picked"));
    let picked = plan("picked", None);
    let fingered = plan("fingered", None);
    // The two articulations really sound different.
    assert!((frequency(&render(&picked, false)[2400..4800]) - 220.0).abs() < 1.0);
    assert!((frequency(&render(&fingered, false)[2400..4800]) - 110.0).abs() < 1.0);
    // Unlocked, the automated note is fingered; locked, it is picked, bit for bit, in playback and in export.
    assert!(!differs(
        &render(&automated, false),
        &render(&fingered, false)
    ));
    assert!(differs(&render(&automated, false), &render(&picked, false)));
    assert!(!differs(&render(&automated, true), &render(&picked, false)));
    assert!(!differs(
        &export(&automated, false),
        &export(&fingered, false)
    ));
    assert!(!differs(&export(&automated, true), &export(&picked, false)));
    assert!(differs(
        &export(&automated, true),
        &export(&automated, false)
    ));
}

/// Windowed RMS of one rendered second of a held note whose track channel gets the volume events `controllers` (tick, value),
/// as the plan carries a beat's fade. Windows are 50 ms.
fn fade_levels(controllers: &[(u32, u8)]) -> Vec<f64> {
    use tabplayer_lib::audio::renderer::Renderer;
    let (_, resources, settings) = renderer_fixture(false);
    let mut midi = vec![
        serde_json::json!({"type":"controller","trackId":"a","tick":0,"channel":0,"controller":7,"value":120}),
        serde_json::json!({"type":"controller","trackId":"a","tick":0,"channel":0,"controller":11,"value":127}),
    ];
    for (tick, value) in controllers {
        midi.push(serde_json::json!({"type":"controller","trackId":"a","tick":tick,"channel":0,"controller":7,"value":value}));
    }
    let tracks = serde_json::json!([{"id":"a","program":24,"percussion":false}]);
    let note = serde_json::json!({"id":"n0","trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"startTick":0,"endTick":1920,"key":57,"velocity":100,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]});
    let plan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":tracks,"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[note],"midi":midi})).unwrap();
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, 48_000).unwrap();
    let mut out = vec![[0.0f32; 2]; 48_000];
    renderer.render_into(&mut out);
    out.chunks(2_400)
        .map(|window| energy(window).sqrt())
        .collect()
}

// The tick/value pairs below are the volume events the generator writes for a fade on a quarter-note beat
// plus the restore of the written level at the end of the beat that the playback plan adds after a fade out or swell
// (pinned against the plan in gestures.test.ts).
const FADE_IN: [(u32, u8); 8] = [
    (0, 0),
    (120, 19),
    (240, 38),
    (360, 56),
    (480, 75),
    (600, 94),
    (768, 120),
    (1920, 120),
];
const FADE_OUT: [(u32, u8); 8] = [
    (0, 120),
    (120, 101),
    (240, 83),
    (360, 64),
    (480, 45),
    (600, 26),
    (768, 0),
    (960, 120),
];
const SWELL: [(u32, u8); 9] = [
    (0, 0),
    (120, 38),
    (240, 75),
    (384, 120),
    (480, 120),
    (600, 83),
    (720, 45),
    (864, 0),
    (960, 120),
];

#[test]
fn fades_shape_the_rendered_level_of_a_held_note() {
    let held = fade_levels(&[(0, 120)]);
    let steady = held[4..16].iter().sum::<f64>() / 12.0;
    assert!(steady > 0.01, "the unfaded note must sound: {steady}");
    // 768 ticks at 120 bpm is 0.4 s, which is windows 0 to 8 of 50 ms.
    let fade_in = fade_levels(&FADE_IN);
    assert!(
        fade_in[0] < steady * 0.2,
        "fade in starts near silence: {} vs {steady}",
        fade_in[0]
    );
    assert!(
        fade_in.windows(2).take(7).all(|pair| pair[1] > pair[0]),
        "fade in rises every 50 ms: {fade_in:?}"
    );
    assert!(
        (fade_in[10] / steady - 1.0).abs() < 0.1,
        "fade in settles at the written level"
    );
    let fade_out = fade_levels(&FADE_OUT);
    assert!(
        (fade_out[0] / steady - 1.0).abs() < 0.2,
        "fade out starts at the written level"
    );
    assert!(
        fade_out.windows(2).take(7).all(|pair| pair[1] < pair[0]),
        "fade out falls every 50 ms: {fade_out:?}"
    );
    assert!(
        fade_out[9] < steady * 0.02,
        "fade out ends silent: {}",
        fade_out[9]
    );
    // The next beat starts at tick 960 (0.5 s): the restore brings the written level back for the note after the fade.
    assert!(
        fade_out[12..20]
            .iter()
            .all(|level| (level / steady - 1.0).abs() < 0.15),
        "the note after a fade out sounds at the written level: {fade_out:?}"
    );
    // The swell peaks at 0.2 s (tick 384) and is silent again by tick 864 (0.45 s).
    let swell = fade_levels(&SWELL);
    let peak = (0..10)
        .max_by(|a, b| swell[*a].total_cmp(&swell[*b]))
        .unwrap();
    assert!(
        (3..=5).contains(&peak),
        "swell peaks near 0.2 s, not window {peak}: {swell:?}"
    );
    assert!(
        swell[0] < swell[peak] * 0.25 && swell[9] < swell[peak] * 0.05,
        "swell opens and closes quiet: {swell:?}"
    );
    assert!(
        swell[2] > swell[0] && swell[6] < swell[4],
        "swell rises then falls"
    );
    assert!(
        swell[12..20]
            .iter()
            .all(|level| (level / steady - 1.0).abs() < 0.15),
        "the note after a swell sounds at the written level: {swell:?}"
    );
    // Written length is untouched: without a fade the note sounds to the end of the window.
    assert!(
        held[19] > steady * 0.5,
        "the held note keeps sounding to the end of its beat window"
    );
}
