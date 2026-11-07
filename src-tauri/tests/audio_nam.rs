use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::HashMap,
    f64::consts::TAU,
    io::Cursor,
    path::Path,
    sync::{Arc, OnceLock},
};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        dsp::{CaptureRef, FxSettings, TrackDsp},
        nam::{CaptureStage, NamModel, NamState, parse_nam},
        nam_library,
        plan::PlaybackPlan,
        renderer::{PreparedMix, Renderer},
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
    },
    export::{
        audio::{AudioExportRender, AudioExportRequest},
        stems::{StemKind, StemTrack},
        wav::AudioFormat,
    },
    settings::{DocumentSettings, TrackSound},
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

fn heap_operations_during(work: impl FnOnce()) -> usize {
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|flag| flag.set(true));
    work();
    COUNT_HEAP.with(|flag| flag.set(false));
    HEAP_OPERATIONS.with(Cell::get)
}

const FIXTURES: [&[u8]; 4] = [
    include_bytes!("fixtures/nam/wavenet.nam"),
    include_bytes!("fixtures/nam/lstm.nam"),
    include_bytes!("fixtures/nam/wavenet_standard.nam"),
    include_bytes!("fixtures/nam/wavenet_minimal.nam"),
];

#[test]
fn process_stays_off_the_heap() {
    for bytes in FIXTURES {
        let model = NamModel::build(&parse_nam(bytes).unwrap());
        let mut state = NamState::new(&model);
        state.prewarm(&model);
        let mut snapshot = NamState::new(&model);
        let mut sum = 0.0f32;
        let operations = heap_operations_during(|| {
            for i in 0..48_000 {
                let x = 0.3 * ((i as f32) * 0.0287).sin();
                sum += state.process(&model, x);
            }
            snapshot.snapshot_from(&state);
        });
        assert!(sum.is_finite());
        assert_eq!(operations, 0);
    }
}

#[test]
fn an_old_edit_log_replays_beside_one_that_names_a_capture() {
    use tabplayer_lib::audio::dsp::{CaptureRef, FxSettings};
    use tabplayer_lib::edit_types::EditCommand;
    use tabplayer_lib::settings::TrackSound;
    let sound = |fx: FxSettings| TrackSound {
        voice_id: None,
        preset_id: "lead".into(),
        effects: fx,
        ..Default::default()
    };
    let mut plain = FxSettings::default();
    plain.amp.model = "lead".into();
    let mut named = plain.clone();
    named.amp.capture = Some(CaptureRef {
        id: "ab".repeat(16),
        name: "Plexi".into(),
        level_db: 2.5,
    });
    for fx in [plain.clone(), named] {
        let edit =
            serde_json::json!({"type":"setTrackSound","trackId":"t","sound":sound(fx.clone())});
        let command: EditCommand = serde_json::from_value(edit.clone()).unwrap();
        assert_eq!(serde_json::to_value(&command).unwrap(), edit);
        let EditCommand::SetTrackSound { sound, .. } = command else {
            panic!("not a sound edit")
        };
        sound.validate().unwrap();
        assert_eq!(sound.effects, fx);
    }
    let old = serde_json::to_string(&sound(plain)).unwrap();
    assert!(!old.contains("capture"));
    assert_eq!(
        serde_json::to_string(&serde_json::from_str::<TrackSound>(&old).unwrap()).unwrap(),
        old
    );
}
const RATES: [u32; 2] = [44_100, 48_000];

/// The identities of the four fixtures in the library every track in this process resolves from.
fn ids() -> &'static [String; 4] {
    static IDS: OnceLock<[String; 4]> = OnceLock::new();
    IDS.get_or_init(|| {
        let directory = Path::new(env!("CARGO_TARGET_TMPDIR")).join("nam-capture-tests");
        let _ = std::fs::remove_dir_all(&directory);
        let library = nam_library::install(directory);
        std::array::from_fn(|n| {
            library
                .import_bytes(FIXTURES[n], &format!("Fixture {n}.nam"))
                .unwrap()
                .id
        })
    })
}
fn with_capture(mut fx: FxSettings, id: &str, level_db: f64) -> FxSettings {
    fx.amp.enabled = true;
    fx.amp.capture = Some(CaptureRef {
        id: id.into(),
        name: "Test capture".into(),
        level_db,
    });
    fx
}
fn amp(model: &str, drive: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.amp.enabled = true;
    fx.amp.model = model.into();
    fx.amp.drive = drive;
    fx
}
/// A riff-like signal, so every part of the chain does some work: a low note, a chord, and silence between.
fn riff(n: usize, rate: u32) -> f32 {
    let t = n as f64 / rate as f64;
    let swell = 0.4 * (-5.0 * t.fract()).exp();
    let note =
        (TAU * 82.41 * t).sin() + 0.7 * (TAU * 123.47 * t).sin() + 0.4 * (TAU * 164.81 * t).sin();
    (swell * note) as f32
}
fn play(fx: &FxSettings, rate: u32, frames: usize) -> Vec<f32> {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 1.0).unwrap();
    (0..frames)
        .map(|n| dsp.process([riff(n, rate); 2], 120.0)[0])
        .collect()
}
fn same_bits(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}
fn rms(signal: &[f32]) -> f64 {
    (signal.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / signal.len() as f64).sqrt()
}

#[test]
fn unresolved_capture_plays_builtin_bit_identical() {
    let missing = with_capture(amp("lead", 0.7), &"0".repeat(32), 3.0);
    let plain = amp("lead", 0.7);
    for rate in RATES {
        let expected = play(&plain, rate, rate as usize);
        assert!(rms(&expected) > 0.01, "the circuit is heard");
        assert!(same_bits(&expected, &play(&missing, rate, rate as usize)));
    }
    // A capture named while the amp is off changes nothing either.
    let mut off = with_capture(FxSettings::default(), &ids()[0], 0.0);
    off.amp.enabled = false;
    assert!(same_bits(
        &play(&FxSettings::default(), 48_000, 24_000),
        &play(&off, 48_000, 24_000)
    ));
    // A resolved capture with the settings otherwise equal is a different sound.
    let named = with_capture(plain.clone(), &ids()[0], 0.0);
    assert!(!same_bits(
        &play(&plain, 48_000, 24_000),
        &play(&named, 48_000, 24_000)
    ));
}

#[test]
fn capture_plays_and_repeats_exactly() {
    for rate in RATES {
        for id in [&ids()[0], &ids()[1]] {
            let fx = with_capture(amp("clean", 0.3), id, 1.0);
            let first = play(&fx, rate, rate as usize);
            assert!(first.iter().all(|v| v.is_finite()));
            assert!(rms(&first) > 0.005, "the capture is heard at {rate}");
            assert!(same_bits(&first, &play(&fx, rate, rate as usize)));
            // After a seek it plays as a fresh one.
            let mut dsp = TrackDsp::new(fx.clone(), rate, 1.0).unwrap();
            for n in 0..rate as usize / 2 {
                dsp.process([riff(n + 7, rate), riff(n, rate) * 0.4], 120.0);
            }
            dsp.reset();
            let again: Vec<f32> = (0..rate as usize)
                .map(|n| dsp.process([riff(n, rate); 2], 120.0)[0])
                .collect();
            assert!(
                same_bits(&first, &again),
                "reset differs from fresh at {rate}"
            );
        }
    }
}

#[test]
fn a_stereo_track_runs_each_channel_through_its_own_stage() {
    let rate = 48_000;
    let fx = with_capture(FxSettings::default(), &ids()[0], 0.0);
    let (mut stereo, mut left, mut right) = (
        TrackDsp::new(fx.clone(), rate, 1.0).unwrap(),
        TrackDsp::new(fx.clone(), rate, 1.0).unwrap(),
        TrackDsp::new(fx, rate, 1.0).unwrap(),
    );
    // Mono for a while, then a pan splits the channels; each then plays as a track of its own would.
    // Past a long silence the channels run as one again, and a note after it still plays as two tracks would.
    for n in 0..rate as usize * 5 {
        let loud = n < rate as usize || n >= rate as usize * 4;
        let a = if loud {
            riff(n % rate as usize, rate)
        } else {
            0.0
        };
        let b = if n < 9_000 || n >= rate as usize * 4 + 9_000 {
            a
        } else {
            a * 0.5
        };
        let y = stereo.process([a, b], 120.0);
        let l = left.process([a, a], 120.0);
        let r = right.process([b, b], 120.0);
        assert_eq!(y[0].to_bits(), l[0].to_bits(), "left at {n}");
        assert_eq!(y[1].to_bits(), r[0].to_bits(), "right at {n}");
    }
}

fn held_note() -> (Arc<PlaybackPlan>, Arc<AudioResources>) {
    let mut font = Cursor::new(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
        ))
        .unwrap(),
    );
    let frames = (0..192_000)
        .map(|n| [((TAU * 110.0 * n as f64 / 48_000.0).sin() * 0.3) as f32; 2])
        .collect();
    let resources = AudioResources {
        manifest: InstrumentManifest {
            schema_version: 1,
            instruments: vec![Instrument {
                id: "green-guitar".into(),
                regions: vec![Region {
                    sample_id: "sine".into(),
                    root_key: 45,
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
        samples: HashMap::from([(
            "sine".into(),
            Arc::new(DecodedAudio {
                sample_rate: 48_000,
                channels: 2,
                frames: Arc::new(frames),
            }),
        )]),
        sound_font: Arc::new(rustysynth::SoundFont::new(&mut font).unwrap()),
    };
    let plan = serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
        "tracks":[{"id":"a","program":24,"percussion":false}],
        "tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
        "notes":[{"id":"n","trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"startTick":0,"endTick":3840,"key":45,"velocity":100,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}],
        "midi":[]
    }))
    .unwrap();
    (Arc::new(plan), Arc::new(resources))
}
fn sounding(fx: &FxSettings) -> DocumentSettings {
    let mut settings = DocumentSettings::default();
    settings.sounds.insert(
        "a".into(),
        TrackSound {
            voice_id: None,
            preset_id: "lead".into(),
            effects: fx.clone(),
            ..Default::default()
        },
    );
    settings
}

#[test]
fn blocks_do_not_matter_and_a_held_note_switches_without_a_click() {
    let (plan, resources) = held_note();
    let driven = amp("lead", 0.7);
    let sounds = [
        driven.clone(),
        with_capture(driven.clone(), &ids()[0], 0.0),
        with_capture(driven.clone(), &ids()[1], 0.0),
        with_capture(driven.clone(), &ids()[1], 4.0),
        driven,
    ];
    let render = |block: usize| {
        let mut renderer = Renderer::new(
            plan.clone(),
            resources.clone(),
            sounding(&sounds[0]),
            48_000,
        )
        .unwrap();
        let mut output = Vec::new();
        let mut buffer = vec![[0.0f32; 2]; block];
        for turn in 0..sounds.len() {
            if turn > 0 {
                let mix = PreparedMix::prepare(&sounding(&sounds[turn]), &plan, 48_000).unwrap();
                drop(renderer.replace_mix(mix));
            }
            let mut left = 24_000;
            while left > 0 {
                drop(renderer.settle_mix());
                let take = left.min(block);
                renderer.render_into(&mut buffer[..take]);
                output.extend_from_slice(&buffer[..take]);
                left -= take;
            }
        }
        output
    };
    let (small, large) = (render(64), render(512));
    assert!(
        small
            .iter()
            .zip(&large)
            .all(|(x, y)| x[0].to_bits() == y[0].to_bits() && x[1].to_bits() == y[1].to_bits()),
        "playback depends on the callback's block size"
    );
    let mut worst = 0.0f32;
    for pair in small.windows(2) {
        assert!(pair[0][0].is_finite());
        worst = worst.max((pair[1][0] - pair[0][0]).abs());
    }
    let peak = small.iter().fold(0.0f32, |p, f| p.max(f[0].abs()));
    assert!(peak > 0.05);
    assert!(
        worst < peak * 0.35,
        "largest step {worst} on a peak of {peak}"
    );
}

#[test]
fn export_render_equals_playback() {
    let (plan, resources) = held_note();
    let fx = with_capture(amp("lead", 0.7), &ids()[0], 0.0);
    let frames = 36_000;
    let mut renderer =
        Renderer::new(plan.clone(), resources.clone(), sounding(&fx), 48_000).unwrap();
    let mut played = vec![[0.0f32; 2]; frames];
    renderer.render_into(&mut played);
    let request = AudioExportRequest {
        tracks: vec![StemTrack {
            id: "a".into(),
            name: "a".into(),
            preset: "lead".into(),
            kind: StemKind::Score,
        }],
        range: None,
        format: AudioFormat::wav(48_000, 24),
        speed: 1.0,
        metronome: false,
        metronome_sound: Default::default(),
        tail_seconds: 0.1,
        include_backing: false,
        include_mix: true,
        normalize_rms_db: None,
    };
    let mut export = AudioExportRender::new(
        Renderer::new(plan.clone(), resources.clone(), sounding(&fx), 48_000).unwrap(),
        &plan,
        request,
    )
    .unwrap();
    let mut exported = Vec::new();
    let mut buffer = vec![[0.0f32; 2]; 4096];
    while exported.len() < frames {
        let n = export.render_mix(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        exported.extend_from_slice(&buffer[..n]);
    }
    assert!(exported.len() >= frames);
    let peak = played.iter().fold(0.0f32, |p, f| p.max(f[0].abs()));
    assert!(peak > 0.02, "the capture is heard: {peak}");
    assert!(
        played
            .iter()
            .zip(&exported)
            .all(|(a, b)| a[0].to_bits() == b[0].to_bits() && a[1].to_bits() == b[1].to_bits()),
        "an export differs from playback"
    );
}

#[test]
fn rested_equals_never_rested() {
    for id in [&ids()[0], &ids()[3]] {
        let fx = with_capture(amp("crunch", 0.5), id, 0.0);
        let (mut resting, mut running) = (
            TrackDsp::new(fx.clone(), 48_000, 1.0).unwrap(),
            TrackDsp::new(fx, 48_000, 1.0).unwrap(),
        );
        running.never_rest();
        for n in 0..(24_000 + 48_000 * 3 + 24_000) {
            let x = if n < 24_000 || n >= 24_000 + 48_000 * 3 {
                riff(n % 24_000, 48_000)
            } else {
                0.0
            };
            let (a, b) = (
                resting.process([x, x], 120.0),
                running.process([x, x], 120.0),
            );
            assert_eq!(a[0].to_bits(), b[0].to_bits(), "frame {n}");
        }
    }
    let fx = with_capture(FxSettings::default(), &ids()[0], 0.0);
    let mut dsp = TrackDsp::new(fx, 48_000, 1.0).unwrap();
    for n in 0..48_000 * 3 {
        let x = if n < 9_600 { riff(n, 48_000) } else { 0.0 };
        dsp.process([x, x * 0.6], 120.0);
    }
    assert_eq!(dsp.driven_at_rest(), [true, true]);
}

/// The largest step and peak of the left output while the amp changes, and over the stretches before and after.
fn change(first: &FxSettings, next: &FxSettings, rate: u32, path: &str) -> [[f64; 2]; 3] {
    let unit = rate as usize / 4;
    let tone = |n: usize| ((TAU * 110.0 * n as f64 / rate as f64).sin() * 0.15) as f32;
    let mut dsp = TrackDsp::new(first.clone(), rate, 1.0).unwrap();
    let (mut last, mut most, mut n) = (0.0f64, [[0.0f64; 2]; 3], 0);
    for (window, frames) in [
        (usize::MAX, unit),
        (0, unit),
        (1, unit),
        (usize::MAX, unit * 2),
        (2, unit),
    ] {
        if window == 1 {
            if path == "set_settings" {
                dsp.set_settings(next.clone()).unwrap();
            } else {
                let mut new = TrackDsp::new(next.clone(), rate, 1.0).unwrap();
                new.transition_from(&mut dsp);
                dsp = new;
            }
        }
        for _ in 0..frames {
            let y = dsp.process([tone(n); 2], 120.0)[0] as f64;
            assert!(y.is_finite());
            n += 1;
            if window != usize::MAX {
                most[window][0] = most[window][0].max((y - last).abs());
                most[window][1] = most[window][1].max(y.abs());
            }
            last = y;
        }
    }
    most
}
/// Same thresholds as the amp-change tests in `audio_tone.rs`: a jump is the height of the wave, near 0.2 here.
fn assert_smooth(first: &FxSettings, next: &FxSettings, what: &str) {
    for rate in RATES {
        for path in ["set_settings", "transition_from"] {
            let [before, during, after] = change(first, next, rate, path);
            let step = before[0].max(after[0]);
            let peak = before[1].max(after[1]);
            assert!(
                during[0] <= step * 1.5 + 0.002,
                "{what} by {path} at {rate}: step {} against {step}",
                during[0]
            );
            assert!(
                during[1] <= peak * 1.5 + 0.01,
                "{what} by {path} at {rate}: peak {} against {peak}",
                during[1]
            );
        }
    }
}

#[test]
fn capture_switch_is_smooth() {
    let ids = ids();
    let driven = amp("lead", 0.7);
    let (a, b) = (
        with_capture(driven.clone(), &ids[0], 0.0),
        with_capture(driven.clone(), &ids[1], 0.0),
    );
    assert_smooth(&a, &b, "one capture to another");
    assert_smooth(&b, &a, "and back");
    assert_smooth(
        &a,
        &with_capture(driven.clone(), &ids[0], 6.0),
        "a level change",
    );
    assert_smooth(&driven, &a, "built-in to a capture");
    assert_smooth(&a, &driven, "a capture undone to the built-in");
    assert_smooth(&a, &FxSettings::default(), "a capture's amp off");
    assert_smooth(&FxSettings::default(), &a, "a capture's amp on");
    let mut tweaked = a.clone();
    tweaked.amp.drive = 0.2;
    tweaked.amp.gain_db = 3.0;
    assert_smooth(&a, &tweaked, "the same capture with other knobs");
}

/// Boards to move through one after another, as a player editing the sound would.
fn boards() -> Vec<FxSettings> {
    let ids = ids();
    vec![
        amp("crunch", 0.6),
        with_capture(amp("metal", 0.8), &ids[0], 0.0),
        with_capture(amp("lead", 0.7), &ids[1], 3.0),
        with_capture(amp("lead", 0.7), &ids[3], -3.0),
        with_capture(amp("lead", 0.2), &ids[3], -3.0),
        amp("bass", 0.4),
        FxSettings::default(),
        with_capture(amp("clean", 0.3), &"0".repeat(32), 0.0),
        with_capture(amp("metal", 0.8), &ids[0], 0.0),
    ]
}
#[test]
fn stays_off_the_heap() {
    for rate in RATES {
        let mut prepared: Vec<TrackDsp> = boards()
            .iter()
            .map(|fx| TrackDsp::new(fx.clone(), rate, 1.0).unwrap())
            .collect();
        let mut sum = 0.0f32;
        let operations = heap_operations_during(|| {
            for index in 0..prepared.len() {
                if index > 0 {
                    let (done, rest) = prepared.split_at_mut(index);
                    rest[0].transition_from(&mut done[index - 1]);
                }
                // Past the crossfade, and past a track starting to pan, which splits the channels.
                for n in 0..rate as usize / 5 {
                    let x = riff(n, rate);
                    let right = if n < rate as usize / 10 { x } else { x * 0.7 };
                    sum += prepared[index].process([x, right], 120.0)[0];
                }
                // On to rest, which rejoins the channels, and out of it again.
                for _ in 0..rate as usize * 5 / 2 {
                    sum += prepared[index].process([0.0; 2], 120.0)[0];
                }
                for n in 0..rate as usize / 100 {
                    sum += prepared[index].process([riff(n, rate); 2], 120.0)[0];
                }
                prepared[index].reset();
            }
        });
        std::hint::black_box(sum);
        assert_eq!(operations, 0, "a capture allocated or freed at {rate}");
    }
}

#[test]
fn undo_capture_frees_off_thread() {
    for rate in RATES {
        for id in [&ids()[0], &ids()[1]] {
            let mut playing =
                TrackDsp::new(with_capture(amp("lead", 0.7), id, 0.0), rate, 1.0).unwrap();
            for n in 0..rate as usize / 2 {
                playing.process([riff(n, rate); 2], 120.0);
            }
            // The undone sound is prepared off the audio thread; the callback takes it over.
            let mut undone = TrackDsp::new(amp("lead", 0.7), rate, 1.0).unwrap();
            let mut sum = 0.0f32;
            let operations = heap_operations_during(|| {
                undone.transition_from(&mut playing);
                for n in 0..rate as usize {
                    sum += undone.process([riff(n, rate); 2], 120.0)[0];
                }
            });
            std::hint::black_box(sum);
            assert_eq!(
                operations, 0,
                "undoing a capture touched the heap at {rate}"
            );
            drop(playing);
            drop(undone);
        }
    }
    // The built-in amp comes back: past the ramp it equals one that never had a capture.
    let rate = 48_000;
    let mut playing =
        TrackDsp::new(with_capture(amp("lead", 0.7), &ids()[0], 0.0), rate, 1.0).unwrap();
    let mut undone = TrackDsp::new(amp("lead", 0.7), rate, 1.0).unwrap();
    let mut never = TrackDsp::new(amp("lead", 0.7), rate, 1.0).unwrap();
    for n in 0..rate as usize / 4 {
        let x = riff(n, rate);
        playing.process([x; 2], 120.0);
        never.process([x; 2], 120.0);
    }
    undone.transition_from(&mut playing);
    let (mut a, mut b) = (vec![], vec![]);
    for n in rate as usize / 4..rate as usize * 3 {
        let x = riff(n, rate);
        a.push(undone.process([x; 2], 120.0)[0]);
        b.push(never.process([x; 2], 120.0)[0]);
    }
    let tail = a.len() - rate as usize;
    let worst = a[tail..]
        .iter()
        .zip(&b[tail..])
        .fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
    let peak = b[tail..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(
        worst < peak * 0.02 + 1e-4,
        "the built-in amp returns: {worst} on {peak}"
    );
}

#[test]
fn second_board_capture_independent() {
    let ids = ids();
    for rate in RATES {
        let main = with_capture(amp("clean", 0.3), &ids[0], 0.0);
        let second = with_capture(amp("lead", 0.6), &ids[3], 2.0);
        let mut both = main.clone();
        both.second = Some(Box::new(second.clone()));
        let (mut chained, mut first, mut next) = (
            TrackDsp::new(both, rate, 1.0).unwrap(),
            TrackDsp::new(main, rate, 1.0).unwrap(),
            TrackDsp::new(second, rate, 1.0).unwrap(),
        );
        let mut heard = 0.0f32;
        for n in 0..rate as usize {
            let x = [riff(n, rate), riff(n, rate) * 0.8];
            let want = next.process(first.process(x, 120.0), 120.0);
            let got = chained.process(x, 120.0);
            assert_eq!(got[0].to_bits(), want[0].to_bits(), "left {n} at {rate}");
            assert_eq!(got[1].to_bits(), want[1].to_bits(), "right {n} at {rate}");
            heard = heard.max(got[0].abs());
        }
        assert!(heard > 0.01);
    }
}

#[test]
fn an_old_edit_log_line_is_read_and_written_back_byte_for_byte() {
    use tabplayer_lib::edit_types::EditCommand;
    // Written by hand as a log from before captures existed: a plain amp, no `capture` key.
    const OLD: &str = r#"{"type":"setTrackSound","trackId":"t","sound":{"voiceId":null,"presetId":"lead","effects":{"gate":{"enabled":false,"thresholdDb":-60.0,"releaseMs":100.0},"compressor":{"enabled":false,"thresholdDb":-18.0,"ratio":4.0,"attackMs":10.0,"releaseMs":100.0,"makeupDb":0.0},"amp":{"enabled":true,"model":"lead","drive":0.5,"gainDb":0.0},"cabinet":{"enabled":false,"model":"open"},"eq":{"enabled":false,"lowDb":0.0,"midDb":0.0,"highDb":0.0,"midHz":1000.0},"chorus":{"enabled":false,"rateHz":1.0,"depthMs":5.0,"mix":0.15},"delay":{"enabled":false,"quarterNotes":1.0,"feedback":0.25,"mix":0.15},"reverb":{"enabled":false,"room":0.5,"damping":0.5,"mix":0.12}}}}"#;
    let command: EditCommand = serde_json::from_str(OLD).unwrap();
    assert_eq!(serde_json::to_string(&command).unwrap(), OLD);
    let EditCommand::SetTrackSound { sound, .. } = command else {
        panic!("not a sound edit")
    };
    sound.validate().unwrap();
    assert!(sound.effects.amp.capture.is_none());
}

#[test]
fn the_stage_rate_limits_are_those_the_track_relies_on() {
    for rate in [8_000, 44_100, 48_000, 192_000] {
        assert!(CaptureStage::rate_supported(rate));
    }
    assert!(!CaptureStage::rate_supported(384_001));
}
