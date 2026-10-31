//! A cabinet impulse response the user loaded: that it plays what the document names, falls back to the built-in cabinet
//! when the library cannot supply it, changes without a click, and never allocates, locks or reads a file on the audio
//! thread. Every response here is synthesized by the test; none is read from a file in the repository or on the machine.
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
        cabinet_ir::{self, IrLibrary, parse_wav, prepare_taps},
        decode::DecodedAudio,
        dsp::{CabinetIr, FxSettings, TrackDsp},
        plan::PlaybackPlan,
        renderer::{PreparedMix, Renderer},
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
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

const RATES: [u32; 2] = [44_100, 48_000];

/// The library every track in this process resolves from, in a folder of the build's scratch space.
fn library() -> Arc<IrLibrary> {
    static LIBRARY: OnceLock<Arc<IrLibrary>> = OnceLock::new();
    LIBRARY
        .get_or_init(|| {
            let directory = Path::new(env!("CARGO_TARGET_TMPDIR")).join("cabinet-ir-tests");
            let _ = std::fs::remove_dir_all(&directory);
            cabinet_ir::install(directory, None)
        })
        .clone()
}

fn noise(len: usize, seed: u32) -> Vec<f32> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as f32 / u32::MAX as f32 * 2.0 - 1.0
        })
        .collect()
}
/// A click, then low-passed noise that dies away: a speaker's response in broad terms.
fn speaker(rate: u32, seconds: f64, seed: u32, brightness: f32) -> Vec<f32> {
    let len = (rate as f64 * seconds) as usize;
    let mut low = 0.0f32;
    let coefficient = 1.0 - (-std::f32::consts::TAU * brightness / rate as f32).exp();
    noise(len, seed)
        .iter()
        .enumerate()
        .map(|(n, v)| {
            low += coefficient * (v - low);
            let decay = (-(n as f32) / (0.15 * rate as f32 * seconds as f32 + 1.0)).exp();
            low * decay * 0.25 + if n == 0 { 0.6 } else { 0.0 }
        })
        .collect()
}
fn wav(samples: &[f32], bits: u16, rate: u32) -> Vec<u8> {
    let mut data = Vec::new();
    for v in samples {
        match bits {
            16 => data.extend_from_slice(&((v * 32_767.0).round() as i16).to_le_bytes()),
            24 => data.extend_from_slice(&((v * 8_388_607.0).round() as i32).to_le_bytes()[..3]),
            _ => data.extend_from_slice(&v.to_le_bytes()),
        }
    }
    let (tag, bits) = if bits == 0 { (3u16, 32u16) } else { (1, bits) };
    let mut file = b"RIFF".to_vec();
    file.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    file.extend_from_slice(b"WAVEfmt ");
    file.extend_from_slice(&16u32.to_le_bytes());
    file.extend_from_slice(&tag.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&rate.to_le_bytes());
    file.extend_from_slice(&(rate * bits as u32 / 8).to_le_bytes());
    file.extend_from_slice(&(bits / 8).to_le_bytes());
    file.extend_from_slice(&bits.to_le_bytes());
    file.extend_from_slice(b"data");
    file.extend_from_slice(&(data.len() as u32).to_le_bytes());
    file.extend_from_slice(&data);
    file
}
/// A response in the library: its identity and its file's bytes.
fn import(samples: &[f32], rate: u32) -> (String, Vec<u8>) {
    let bytes = wav(samples, 24, rate);
    let entry = library().import_bytes(&bytes, "Test cabinet.wav").unwrap();
    (entry.id, bytes)
}
/// The taps the app plays for a file at `rate`.
fn taps(bytes: &[u8], rate: u32) -> Vec<f32> {
    prepare_taps(&parse_wav(bytes).unwrap(), rate).unwrap()
}
fn names(mut fx: FxSettings, id: &str, level_db: f64) -> FxSettings {
    fx.cabinet.enabled = true;
    fx.cabinet.ir = Some(CabinetIr {
        id: id.into(),
        name: "Test cabinet".into(),
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
fn built_in(mut fx: FxSettings, model: &str) -> FxSettings {
    fx.cabinet.enabled = true;
    fx.cabinet.model = model.into();
    fx
}
/// A riff-like signal, so every part of the chain does some work: a low note, a chord, and silence between.
fn riff(n: usize, rate: u32) -> f32 {
    let t = n as f64 / rate as f64;
    let beat = t.fract();
    let swell = 0.4 * (-5.0 * beat).exp();
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
fn rms(signal: &[f32]) -> f64 {
    (signal.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / signal.len() as f64).sqrt()
}

#[test]
fn a_response_that_passes_the_signal_changes_nothing() {
    // One click at full level is the identity: the loader sets its midrange gain to 1.
    let mut click = vec![0.0f32; 400];
    click[0] = 1.0;
    for rate in RATES {
        let (id, _) = import(&click, rate);
        let fx = names(FxSettings::default(), &id, 0.0);
        let out = play(&fx, rate, rate as usize / 2);
        for (n, y) in out.iter().enumerate() {
            assert!((*y - riff(n, rate)).abs() < 1e-6, "frame {n} at {rate}");
        }
    }
}
#[test]
fn it_plays_the_response_the_document_names() {
    let (id, bytes) = import(&speaker(48_000, 0.6, 3, 4_000.0), 48_000);
    for rate in [44_100, 48_000, 96_000] {
        let taps = taps(&bytes, rate);
        let frames = rate as usize;
        let out = play(&names(FxSettings::default(), &id, 0.0), rate, frames);
        let input: Vec<f32> = (0..frames).map(|n| riff(n, rate)).collect();
        let mut worst = 0.0f64;
        for n in 0..frames {
            let want: f64 = (0..taps.len().min(n + 1))
                .map(|k| taps[k] as f64 * input[n - k] as f64)
                .sum();
            worst = worst.max((out[n] as f64 - want).abs());
        }
        let peak = out.iter().fold(0.0f32, |p, v| p.max(v.abs())) as f64;
        assert!(peak > 0.05, "the response is heard at {rate}: {peak}");
        assert!(
            worst < peak * 3e-4,
            "{rate}: error {worst} on a peak of {peak}"
        );
    }
}
#[test]
fn a_stereo_track_runs_each_channel_through_the_response() {
    let (id, bytes) = import(&speaker(48_000, 0.4, 5, 5_000.0), 48_000);
    let taps = taps(&bytes, 48_000);
    let mut dsp = TrackDsp::new(names(FxSettings::default(), &id, 0.0), 48_000, 1.0).unwrap();
    let frames = 24_000;
    let (mut left, mut right) = (vec![], vec![]);
    for n in 0..frames {
        let y = dsp.process([riff(n, 48_000), riff(n, 48_000) * 0.5], 120.0);
        left.push(y[0] as f64);
        right.push(y[1] as f64);
    }
    for n in (0..frames).step_by(7) {
        let want: f64 = (0..taps.len().min(n + 1))
            .map(|k| taps[k] as f64 * riff(n - k, 48_000) as f64)
            .sum();
        assert!((left[n] - want).abs() < 2e-4, "left at {n}");
        assert!((right[n] - want * 0.5).abs() < 2e-4, "right at {n}");
    }
}
#[test]
fn the_level_trim_scales_the_response() {
    let (id, _) = import(&speaker(48_000, 0.3, 4, 4_500.0), 48_000);
    let flat = play(&names(FxSettings::default(), &id, 0.0), 48_000, 24_000);
    for db in [-12.0, -6.0, 6.0, 12.0] {
        let trimmed = play(&names(FxSettings::default(), &id, db), 48_000, 24_000);
        let ratio = rms(&trimmed) / rms(&flat);
        assert!(
            (ratio - 10f64.powf(db / 20.0)).abs() < 1e-3,
            "{db} dB: {ratio}"
        );
    }
}
#[test]
fn it_sits_at_the_level_of_the_built_in_cabinets() {
    // Noise across the guitar's band through a cabinet comes out near the level it went in at.
    let (id, _) = import(&speaker(48_000, 0.5, 8, 3_500.0), 48_000);
    let band = noise(96_000, 77);
    let run = |fx: &FxSettings| {
        let mut dsp = TrackDsp::new(fx.clone(), 48_000, 1.0).unwrap();
        band.iter()
            .map(|v| dsp.process([v * 0.1; 2], 120.0)[0])
            .collect::<Vec<_>>()
    };
    let loaded = rms(&run(&names(FxSettings::default(), &id, 0.0))[24_000..]);
    let closed = rms(&run(&built_in(FxSettings::default(), "closed"))[24_000..]);
    let db = 20.0 * (loaded / closed).log10();
    assert!(
        db.abs() < 6.0,
        "a loaded response is {db} dB from the closed cabinet"
    );
}
#[test]
fn a_response_the_library_cannot_supply_plays_the_cabinet_model_exactly() {
    let driven = built_in(amp("lead", 0.7), "closed");
    let plain = play(&driven, 48_000, 48_000);
    assert!(rms(&plain) > 0.01, "the model is heard");

    // Never imported, damaged and removed: each leaves the cabinet model playing, without an error, and the settings
    // exactly as they were.
    let (damaged, _) = import(&speaker(48_000, 0.3, 11, 4_000.0), 48_000);
    let path = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("cabinet-ir-tests")
        .join(format!("{damaged}.wav"));
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[200] ^= 0x7f;
    std::fs::write(&path, &bytes).unwrap();
    let (removed, _) = import(&speaker(48_000, 0.3, 12, 4_000.0), 48_000);
    library().remove(&removed).unwrap();
    for id in ["0".repeat(32), damaged, removed] {
        let mut fx = driven.clone();
        fx.cabinet.ir = Some(CabinetIr {
            id: id.clone(),
            name: "Gone".into(),
            level_db: 3.0,
        });
        let before = fx.clone();
        let out = play(&fx, 48_000, 48_000);
        assert!(
            out.iter()
                .zip(&plain)
                .all(|(a, b)| a.to_bits() == b.to_bits()),
            "{id} does not play the model"
        );
        assert_eq!(fx, before);
    }
    // A response that is named while the cabinet is off changes nothing either.
    let (id, _) = import(&speaker(48_000, 0.3, 13, 4_000.0), 48_000);
    let mut off = names(amp("lead", 0.7), &id, 0.0);
    off.cabinet.enabled = false;
    let off_plain = play(&amp("lead", 0.7), 48_000, 24_000);
    let named = play(&off, 48_000, 24_000);
    assert!(
        off_plain
            .iter()
            .zip(&named)
            .all(|(a, b)| a.to_bits() == b.to_bits())
    );
}
#[test]
fn a_document_without_a_response_serializes_and_loads_as_it_always_did() {
    let fx = built_in(amp("crunch", 0.4), "closed");
    let json = serde_json::to_value(&fx).unwrap();
    assert!(json["cabinet"].get("ir").is_none(), "{}", json["cabinet"]);
    assert_eq!(serde_json::from_value::<FxSettings>(json).unwrap(), fx);
    let old = serde_json::json!({"enabled":true,"model":"closed"});
    assert!(
        serde_json::from_value::<tabplayer_lib::audio::dsp::Cabinet>(old)
            .unwrap()
            .ir
            .is_none()
    );
    let named = names(fx, &"ab".repeat(16), -3.5);
    let again: FxSettings = serde_json::from_str(&serde_json::to_string(&named).unwrap()).unwrap();
    assert_eq!(again, named);
}
#[test]
fn an_edit_that_names_a_response_is_stored_and_an_old_edit_log_replays_as_before() {
    use tabplayer_lib::edit_types::EditCommand;
    let sound = |fx: FxSettings| TrackSound {
        voice_id: None,
        preset_id: "lead".into(),
        effects: fx,
        ..Default::default()
    };
    let plain = built_in(amp("lead", 0.5), "closed");
    let named = names(plain.clone(), &"ab".repeat(16), 2.5);
    for fx in [plain, named] {
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
    // An edit written before the field existed names no response, and is written back byte for byte.
    let old = serde_json::to_string(&sound(built_in(amp("lead", 0.5), "closed"))).unwrap();
    assert!(!old.contains("\"ir\""));
    assert_eq!(
        serde_json::to_string(&serde_json::from_str::<TrackSound>(&old).unwrap()).unwrap(),
        old
    );
}
#[test]
fn only_a_well_formed_response_is_accepted_by_a_sound() {
    let ok = names(FxSettings::default(), &"0f".repeat(16), 0.0);
    assert!(TrackDsp::new(ok.clone(), 48_000, 1.0).is_ok());
    for (id, name, db) in [
        ("0f".repeat(15), "x".to_string(), 0.0),
        ("0F".repeat(16), "x".to_string(), 0.0),
        ("../".repeat(11)[..32].to_string(), "x".to_string(), 0.0),
        ("0f".repeat(16), String::new(), 0.0),
        ("0f".repeat(16), " padded".into(), 0.0),
        ("0f".repeat(16), "bell\u{7}".into(), 0.0),
        ("0f".repeat(16), "x".repeat(65), 0.0),
        ("0f".repeat(16), "x".into(), 13.0),
        ("0f".repeat(16), "x".into(), f64::NAN),
    ] {
        let mut fx = ok.clone();
        fx.cabinet.ir = Some(CabinetIr {
            id,
            name,
            level_db: db,
        });
        assert!(
            TrackDsp::new(fx.clone(), 48_000, 1.0).is_err(),
            "{:?}",
            fx.cabinet.ir
        );
    }
    assert!(
        serde_json::from_value::<CabinetIr>(
            serde_json::json!({"id":"a","name":"b","levelDb":0,"extra":1})
        )
        .is_err()
    );
}

/// The largest step and peak of the left output while the cabinet changes, and over the stretches before and after.
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
fn changing_the_cabinet_to_or_from_a_response_is_smooth() {
    let (a, _) = import(&speaker(48_000, 0.7, 21, 3_800.0), 48_000);
    let (b, _) = import(&speaker(44_100, 0.25, 22, 5_200.0), 44_100);
    let driven = amp("lead", 0.7);
    let (closed, combo) = (
        built_in(driven.clone(), "closed"),
        built_in(driven.clone(), "combo"),
    );
    let (with_a, with_b) = (
        names(driven.clone(), &a, 0.0),
        names(driven.clone(), &b, 0.0),
    );
    assert_smooth(&closed, &with_a, "closed to a response");
    assert_smooth(&with_a, &closed, "a response to closed");
    assert_smooth(&with_a, &with_b, "one response to another");
    assert_smooth(&with_b, &with_a, "the other way");
    assert_smooth(&with_a, &driven, "a response off");
    assert_smooth(&driven, &with_a, "a response on");
    assert_smooth(&with_a, &names(driven.clone(), &a, 6.0), "a level trim");
    // The response going missing hands the cabinet to its model.
    let mut gone = with_a.clone();
    gone.cabinet.ir.as_mut().unwrap().id = "0".repeat(32);
    gone.cabinet.model = "combo".into();
    assert_smooth(&with_a, &gone, "a response lost");
    assert_smooth(&gone, &with_a, "a response found");
    assert_smooth(&combo, &with_b, "combo to a response");
}

type HeldNote = (Arc<PlaybackPlan>, Arc<AudioResources>);
/// One track holding one steady 110 Hz note, to play through a real renderer.
fn held_note() -> HeldNote {
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
fn a_renderer_changing_the_cabinet_mid_note_is_smooth_and_blocks_do_not_matter() {
    let held = held_note();
    let (plan, resources) = &held;
    let (a, _) = import(&speaker(48_000, 0.8, 31, 3_900.0), 48_000);
    let (b, _) = import(&speaker(48_000, 0.3, 32, 5_000.0), 48_000);
    let driven = amp("lead", 0.7);
    let sounds = [
        built_in(driven.clone(), "closed"),
        names(driven.clone(), &a, 0.0),
        names(driven.clone(), &b, 0.0),
        names(driven.clone(), &a, -4.0),
        built_in(driven, "combo"),
    ];
    // The same four changes, with the callback's blocks of two sizes: the audio is the same bits.
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
                let mix = PreparedMix::prepare(&sounding(&sounds[turn]), plan, 48_000).unwrap();
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
    let (small, large) = (render(16), render(1000));
    assert!(
        small
            .iter()
            .zip(&large)
            .all(|(x, y)| x[0].to_bits() == y[0].to_bits()),
        "playback depends on the callback's block size"
    );
    let mut worst = 0.0f32;
    for pair in small.windows(2) {
        assert!(pair[0][0].is_finite());
        worst = worst.max((pair[1][0] - pair[0][0]).abs());
    }
    let peak = small.iter().fold(0.0f32, |p, f| p.max(f[0].abs()));
    assert!(peak > 0.05);
    // A held 110 Hz note's edge is a few hundredths; a click would be as high as the wave.
    assert!(
        worst < peak * 0.35,
        "largest step {worst} on a peak of {peak}"
    );
}

fn boards() -> Vec<FxSettings> {
    let (a, _) = import(&speaker(48_000, 1.0, 41, 4_000.0), 48_000);
    let (b, _) = import(&speaker(44_100, 0.2, 42, 4_800.0), 44_100);
    vec![
        built_in(amp("crunch", 0.6), "closed"),
        names(amp("metal", 0.8), &a, 0.0),
        names(amp("lead", 0.7), &b, 3.0),
        names(amp("lead", 0.7), &a, -3.0),
        built_in(amp("bass", 0.4), "bass"),
        names(FxSettings::default(), &b, 0.0),
        FxSettings::default(),
        names(amp("clean", 0.3), &"0".repeat(32), 0.0),
        names(amp("metal", 0.8), &a, 0.0),
    ]
}
#[test]
fn a_response_stays_off_the_heap() {
    for rate in RATES {
        let mut prepared: Vec<TrackDsp> = boards()
            .iter()
            .map(|fx| TrackDsp::new(fx.clone(), rate, 1.0).unwrap())
            .collect();
        let mut sum = 0.0f32;
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|f| f.set(true));
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
        COUNT_HEAP.with(|f| f.set(false));
        let operations = HEAP_OPERATIONS.with(Cell::get);
        std::hint::black_box(sum);
        assert_eq!(
            operations, 0,
            "a response allocated or freed heap memory at {rate}"
        );
    }
}
#[test]
fn a_silent_track_rests_and_matches_one_that_never_does() {
    let (id, _) = import(&speaker(48_000, 0.9, 51, 4_200.0), 48_000);
    let fx = names(amp("crunch", 0.5), &id, 0.0);
    let (mut resting, mut running) = (
        TrackDsp::new(fx.clone(), 48_000, 1.0).unwrap(),
        TrackDsp::new(fx, 48_000, 1.0).unwrap(),
    );
    running.never_rest();
    // A note, its tail, a long silence that lets the response rest, and the note again.
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
        assert_eq!(a[0], b[0], "frame {n}");
    }
    let (mut resting, mut running) = (
        TrackDsp::new(names(FxSettings::default(), &id, 0.0), 48_000, 1.0).unwrap(),
        TrackDsp::new(names(FxSettings::default(), &id, 0.0), 48_000, 1.0).unwrap(),
    );
    running.never_rest();
    for n in 0..48_000 * 3 {
        let x = if n < 9_600 { riff(n, 48_000) } else { 0.0 };
        resting.process([x, x * 0.6], 120.0);
        running.process([x, x * 0.6], 120.0);
    }
    assert_eq!(resting.driven_at_rest(), [true, true]);
    assert_ne!(running.driven_at_rest(), [true, true]);
}
#[test]
fn a_seek_leaves_nothing_of_the_response_behind() {
    let (id, _) = import(&speaker(48_000, 0.9, 61, 4_000.0), 48_000);
    let fx = names(amp("lead", 0.6), &id, 0.0);
    let mut played = TrackDsp::new(fx.clone(), 48_000, 1.0).unwrap();
    for n in 0..48_000 {
        played.process([riff(n, 48_000), riff(n + 99, 48_000)], 120.0);
    }
    played.reset();
    let mut fresh = TrackDsp::new(fx, 48_000, 1.0).unwrap();
    for n in 0..24_000 {
        let (a, b) = (
            played.process([riff(n, 48_000); 2], 120.0),
            fresh.process([riff(n, 48_000); 2], 120.0),
        );
        assert_eq!(a[0].to_bits(), b[0].to_bits(), "frame {n} after a seek");
    }
}
#[test]
fn rendering_a_response_repeats_exactly() {
    let (a, _) = import(&speaker(48_000, 0.8, 71, 4_100.0), 48_000);
    let (b, _) = import(&speaker(48_000, 0.4, 72, 3_000.0), 48_000);
    let render = || {
        let mut old = TrackDsp::new(names(amp("metal", 0.8), &a, 0.0), 48_000, 1.0).unwrap();
        let mut new = TrackDsp::new(names(amp("lead", 0.6), &b, 2.0), 48_000, 1.0).unwrap();
        let mut output = Vec::new();
        for n in 0..48_000 {
            output.push(old.process([riff(n, 48_000); 2], 120.0)[0].to_bits());
        }
        new.transition_from(&mut old);
        for n in 0..48_000 {
            output.push(new.process([riff(n, 48_000); 2], 120.0)[1].to_bits());
        }
        output
    };
    assert!(render() == render());
}

/// The convolution of `taps` with `input` at frame `n`.
fn convolved(taps: &[f32], input: &[f32], n: usize) -> f64 {
    (0..taps.len().min(n + 1))
        .map(|k| taps[k] as f64 * input[n - k] as f64)
        .sum()
}
#[test]
fn a_change_of_response_crossfades_the_two_by_the_ramp() {
    let rate = 48_000;
    let (a, bytes_a) = import(&speaker(48_000, 0.5, 81, 3_600.0), 48_000);
    let (b, bytes_b) = import(&speaker(48_000, 0.9, 82, 5_100.0), 48_000);
    let (taps_a, taps_b) = (taps(&bytes_a, rate), taps(&bytes_b, rate));
    let frames = 30_000;
    let input: Vec<f32> = (0..frames).map(|n| riff(n, rate)).collect();
    let mut old = TrackDsp::new(names(FxSettings::default(), &a, 0.0), rate, 1.0).unwrap();
    let mut new = TrackDsp::new(names(FxSettings::default(), &b, 0.0), rate, 1.0).unwrap();
    let start = 12_345;
    let mut out = vec![0.0f32; frames];
    for n in 0..start {
        out[n] = old.process([input[n]; 2], 120.0)[0];
    }
    new.transition_from(&mut old);
    for n in start..frames {
        out[n] = new.process([input[n]; 2], 120.0)[0];
    }
    let ramp = (rate as f64 * 0.01) as usize;
    let peak = out.iter().fold(0.0f32, |p, v| p.max(v.abs())) as f64;
    for n in (start - 50..start + ramp + 600).step_by(3) {
        let t = if n < start {
            0.0
        } else {
            ((n - start) as f64 / ramp as f64).min(1.0)
        };
        let want = (1.0 - t) * convolved(&taps_a, &input, n) + t * convolved(&taps_b, &input, n);
        assert!(
            (out[n] as f64 - want).abs() < peak * 5e-4,
            "frame {n} (t {t:.3})"
        );
    }
}
#[test]
fn a_change_from_the_model_to_a_response_crossfades_into_it() {
    let rate = 48_000;
    let (id, bytes) = import(&speaker(48_000, 0.4, 91, 4_400.0), 48_000);
    let taps = taps(&bytes, rate);
    let frames = 24_000;
    let input: Vec<f32> = (0..frames).map(|n| riff(n, rate)).collect();
    let closed = built_in(FxSettings::default(), "closed");
    let mut reference = TrackDsp::new(closed.clone(), rate, 1.0).unwrap();
    let mut old = TrackDsp::new(closed, rate, 1.0).unwrap();
    let mut new = TrackDsp::new(names(FxSettings::default(), &id, 0.0), rate, 1.0).unwrap();
    let start = 9_000;
    let mut out = vec![0.0f32; frames];
    let mut model = vec![0.0f32; frames];
    for n in 0..frames {
        model[n] = reference.process([input[n]; 2], 120.0)[0];
        if n == start {
            new.transition_from(&mut old);
        }
        out[n] = if n < start {
            old.process([input[n]; 2], 120.0)[0]
        } else {
            new.process([input[n]; 2], 120.0)[0]
        };
    }
    // The response starts from silence, as a cabinet switched on mid-play does, so it hears only what comes after.
    let heard: Vec<f32> = input
        .iter()
        .enumerate()
        .map(|(n, v)| if n < start { 0.0 } else { *v })
        .collect();
    let ramp = (rate as f64 * 0.01) as usize;
    let peak = model.iter().fold(0.0f32, |p, v| p.max(v.abs())) as f64;
    for n in (start - 20..start + ramp + 300).step_by(3) {
        let t = if n < start {
            0.0
        } else {
            ((n - start) as f64 / ramp as f64).min(1.0)
        };
        let want = (1.0 - t) * model[n] as f64 + t * convolved(&taps, &heard, n);
        assert!(
            (out[n] as f64 - want).abs() < peak * 5e-4,
            "frame {n} (t {t:.3})"
        );
    }
}
#[test]
fn a_track_plays_the_response_right_wherever_it_sits_in_the_mix() {
    // A mix gives each track its own place in the convolution's blocks, from its index alone. Where it sits changes
    // the last places of the sum and nothing else, and the same place gives the same bits.
    let (id, bytes) = import(&speaker(48_000, 0.6, 3, 4_000.0), 48_000);
    let taps = taps(&bytes, 48_000);
    let fx = names(FxSettings::default(), &id, 0.0);
    let frames = 30_000;
    let input: Vec<f32> = (0..frames).map(|n| riff(n, 48_000)).collect();
    let render = |index: usize| -> Vec<f32> {
        let mut dsp = TrackDsp::new(fx.clone(), 48_000, 1.0).unwrap();
        dsp.set_ir_index(index);
        input
            .iter()
            .map(|&x| dsp.process([x; 2], 120.0)[0])
            .collect()
    };
    let mut renders = Vec::new();
    for index in [0usize, 1, 2, 7, 15] {
        let out = render(index);
        let peak = out.iter().fold(0.0f32, |p, v| p.max(v.abs())) as f64;
        assert!(peak > 0.05, "index {index}: heard");
        let worst = (0..frames)
            .map(|n| {
                let want: f64 = (0..taps.len().min(n + 1))
                    .map(|k| taps[k] as f64 * input[n - k] as f64)
                    .sum();
                (out[n] as f64 - want).abs()
            })
            .fold(0.0, f64::max);
        assert!(worst < peak * 3e-4, "index {index}: error {worst}");
        assert_eq!(out, render(index), "index {index} repeats exactly");
        renders.push(out);
    }
    assert!(renders.windows(2).any(|pair| pair[0] != pair[1]));
}
