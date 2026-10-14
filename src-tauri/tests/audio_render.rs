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
    let plan=serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":tracks,"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":notes,"midi":midi})).unwrap();
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
        },
    );
    let mix = PreparedMix::prepare(&settings, &plan, 48_000).unwrap();
    let mut renderer = Renderer::new(plan, resources, settings, 48_000).unwrap();
    let mut block = [[0.0; 2]; 512];
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    for _ in 0..100 {
        renderer.render_into(&mut block);
    }
    renderer.seek_tick(960.0);
    let retired = renderer.replace_mix(mix);
    renderer.render_into(&mut block);
    COUNT_HEAP.with(|f| f.set(false));
    let operations = HEAP_OPERATIONS.with(Cell::get);
    drop(retired);
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
            {"bar":0,"occurrence":0,"startTick":0,"endTick":720,"startMs":0,"endMs":375,"clickTicks":[0,480]},
            {"bar":1,"occurrence":0,"startTick":720,"endTick":2160,"startMs":375,"endMs":1125,"clickTicks":[720,1200,1680]},
            {"bar":2,"occurrence":0,"startTick":2160,"endTick":5040,"startMs":1125,"endMs":3125,"clickTicks":[2160,2640,3120,3600,4080,4560]},
            {"bar":1,"occurrence":1,"startTick":5040,"endTick":6480,"startMs":3125,"endMs":4125,"clickTicks":[5040,5520,6000]},
            {"bar":3,"occurrence":0,"startTick":6480,"endTick":8400,"startMs":4125,"endMs":5125,"clickTicks":[6480,7440]}
        ])
    } else {
        serde_json::json!([
            {"bar":0,"occurrence":0,"startTick":0,"endTick":1440,"startMs":0,"endMs":750,"clickTicks":[0,480,960]},
            {"bar":0,"occurrence":1,"startTick":1440,"endTick":2880,"startMs":750,"endMs":1500,"clickTicks":[1440,1920,2400]}
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
            format: AudioFormat {
                sample_rate: rate,
                bit_depth: 24,
            },
            speed: 2.0,
            metronome: true,
            tail_seconds: 0.03,
            include_backing: false,
            include_mix: true,
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
        "occurrences":[{"bar":0,"occurrence":0,"startTick":0,"endTick":5760,"startMs":0,"endMs":3000}],
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
