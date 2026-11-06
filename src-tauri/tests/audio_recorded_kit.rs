//! The recorded drum kit: which notes it plays, how long they ring, what cuts them and how the kit mix reaches them.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::HashMap,
    io::Cursor,
    sync::Arc,
};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        plan::PlaybackPlan,
        renderer::Renderer,
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
        voices::{RECORDED_KIT, resource_requests},
    },
    settings::{ChannelMix, DocumentSettings, DrumElementMix, DrumKitMix, TrackSound},
};

thread_local! {static COUNT_HEAP:Cell<bool>=const {Cell::new(false)};static HEAP_OPERATIONS:Cell<usize>=const {Cell::new(0)};}
/// Counts heap use on the thread that turns counting on, so a render can be shown not to allocate.
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

const RATE: u32 = 48_000;
/// 120 bpm at 960 ppq: 1920 ticks to the second.
const TICKS_PER_SECOND: f64 = 1920.0;

fn sample(seconds: f64, amplitude: f32) -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: RATE,
        channels: 2,
        frames: Arc::new(
            (0..(seconds * RATE as f64) as usize)
                .map(|n| {
                    let x = (std::f64::consts::TAU * 300.0 * n as f64 / RATE as f64).sin() as f32
                        * amplitude;
                    [x, x]
                })
                .collect(),
        ),
    })
}
fn region(sample: &str, key: u8, group: u32, off_by: u32) -> Region {
    Region {
        sample_id: sample.into(),
        root_key: key,
        key_low: key,
        key_high: key,
        velocity_low: 1,
        velocity_high: 127,
        articulation: "picked".into(),
        variant: 1,
        sequence_length: 1,
        trigger: "attack".into(),
        pitch_keytrack: 0.0,
        velocity_gain_high: 1,
        release_seconds: 0.05,
        group,
        off_by,
        ..Default::default()
    }
}
/// A kit with a silent snare (38), a two-second crash (49), an open hi-hat that the closed group cuts (46) and a silent
/// closed hi-hat (42), a quiet two-second ride (51), or no kit at all.
fn resources(kit: bool) -> Arc<AudioResources> {
    let mut font = Cursor::new(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
        ))
        .unwrap(),
    );
    let instruments = if kit {
        vec![Instrument {
            id: RECORDED_KIT.into(),
            regions: vec![
                region("silent", 38, 0, 0),
                region("long", 49, 0, 0),
                region("long", 46, 2, 1),
                region("silent", 42, 1, 0),
                region("quiet", 51, 0, 0),
            ],
            ..Default::default()
        }]
    } else {
        vec![]
    };
    Arc::new(AudioResources {
        manifest: InstrumentManifest {
            schema_version: 1,
            instruments,
            ..Default::default()
        },
        samples: HashMap::from([
            ("silent".into(), sample(1.0, 0.0)),
            ("long".into(), sample(2.0, 0.5)),
            ("quiet".into(), sample(2.0, 0.05)),
        ]),
        sound_font: Arc::new(rustysynth::SoundFont::new(&mut font).unwrap()),
    })
}
/// One drum track; each hit is (start tick, end tick, key, kit sound, choke).
fn plan(hits: &[(f64, f64, u8, Option<u8>, bool)]) -> Arc<PlaybackPlan> {
    let mut notes = vec![];
    let mut midi = vec![];
    for (index, &(start, end, key, kit_sound, choke)) in hits.iter().enumerate() {
        let mut note = serde_json::json!({"id":format!("n{index}"),"trackId":"drums","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":index},"string":0},"occurrence":0,"channel":9,"startTick":start,"endTick":end,"key":key,"velocity":100,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":start,"semitones":0}]});
        if let Some(sound) = kit_sound {
            note["kitSound"] = sound.into();
        }
        if choke {
            note["choke"] = true.into();
        }
        notes.push(note);
        midi.push(serde_json::json!({"type":"noteOn","trackId":"drums","tick":start,"channel":9,"key":key,"velocity":100}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"drums","tick":end,"channel":9,"key":key,"velocity":0}));
    }
    midi.sort_by(|a, b| a["tick"].as_f64().partial_cmp(&b["tick"].as_f64()).unwrap());
    Arc::new(serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":4000,"tracks":[{"id":"drums","program":0,"percussion":true}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":7680,"startMs":0,"endMs":4000}],"notes":notes,"midi":midi})).unwrap())
}
fn render(
    plan: Arc<PlaybackPlan>,
    resources: Arc<AudioResources>,
    settings: DocumentSettings,
) -> Vec<[f32; 2]> {
    let mut renderer = Renderer::new(plan, resources, settings, RATE).unwrap();
    let mut output = vec![[0.0f32; 2]; 2 * RATE as usize];
    renderer.render_into(&mut output);
    output
}
/// Mean power from `from` to `to` seconds.
fn energy(output: &[[f32; 2]], from: f64, to: f64) -> f64 {
    let range = &output[(from * RATE as f64) as usize..(to * RATE as f64) as usize];
    range.iter().map(|x| (x[0] * x[0]) as f64).sum::<f64>() / range.len() as f64
}

#[test]
fn a_kit_sound_plays_its_recording_instead_of_general_midi_and_a_missing_one_plays_general_midi() {
    let snare = |kit_sound| plan(&[(0.0, 480.0, 38, kit_sound, false)]);
    // The kit's snare is silence, so any sound at all would be the General MIDI snare played as well.
    let recorded = render(
        snare(Some(38)),
        resources(true),
        DocumentSettings::default(),
    );
    assert_eq!(energy(&recorded, 0.0, 1.0), 0.0);
    // A note the kit has no sound for (a china, a clap) plays General MIDI.
    let general = render(snare(None), resources(true), DocumentSettings::default());
    assert!(energy(&general, 0.0, 0.5) > 1e-6);
    // So does a sound the kit lacks a recording of, and every note when the audio has no kit.
    let unrecorded = render(
        plan(&[(0.0, 480.0, 38, Some(37), false)]),
        resources(true),
        DocumentSettings::default(),
    );
    assert!(energy(&unrecorded, 0.0, 0.5) > 1e-6);
    let without = render(
        snare(Some(38)),
        resources(false),
        DocumentSettings::default(),
    );
    assert!(energy(&without, 0.0, 0.5) > 1e-6);
    // The room kit is the sound bank's own, so it stays General MIDI.
    let mut room = DocumentSettings::default();
    room.sounds.insert(
        "drums".into(),
        TrackSound {
            drum_kit: Some(8),
            ..TrackSound::default()
        },
    );
    let rooms = render(snare(Some(38)), resources(true), room);
    assert!(energy(&rooms, 0.0, 0.5) > 1e-6);
    // A guitar voice chosen for a drum track has no drums, so the track plays General MIDI.
    let mut guitar = DocumentSettings::default();
    guitar.sounds.insert(
        "drums".into(),
        TrackSound {
            voice_id: Some("green-guitar".into()),
            ..TrackSound::default()
        },
    );
    let guitars = render(snare(Some(38)), resources(true), guitar);
    assert!(energy(&guitars, 0.0, 0.5) > 1e-6);
}

#[test]
fn a_fifth_ringing_stroke_of_one_sound_fades_the_oldest() {
    // Rides 0.1 s apart, a whole number of the test tone's periods, so ringing strokes add up in phase.
    let rides = |count: usize| {
        let hits: Vec<_> = (0..count)
            .map(|i| {
                (
                    i as f64 * 192.0,
                    i as f64 * 192.0 + 96.0,
                    51,
                    Some(51),
                    false,
                )
            })
            .collect();
        let output = render(plan(&hits), resources(true), DocumentSettings::default());
        energy(&output, 0.9, 1.0)
    };
    let (three, four, five, six) = (rides(3), rides(4), rides(5), rides(6));
    assert!(
        four > three * 1.5,
        "four strokes {four} against three {three}"
    );
    // Four ring at once at most: a fifth and a sixth stroke each fade the oldest.
    assert!(
        (five / four - 1.0).abs() < 0.01,
        "five strokes {five} against four {four}"
    );
    assert!(
        (six / four - 1.0).abs() < 0.01,
        "six strokes {six} against four {four}"
    );
}

#[test]
fn a_struck_cymbal_rings_past_its_note_and_a_choked_one_stops_when_its_note_ends() {
    let quarter = 480.0;
    let rung = render(
        plan(&[(0.0, quarter, 49, Some(49), false)]),
        resources(true),
        DocumentSettings::default(),
    );
    let end = quarter / TICKS_PER_SECOND;
    assert!(
        energy(&rung, end + 0.5, end + 1.0) > 0.05,
        "the crash rings out its recording"
    );
    let choked = render(
        plan(&[(0.0, quarter, 49, Some(49), true)]),
        resources(true),
        DocumentSettings::default(),
    );
    assert!(energy(&choked, 0.0, end) > 0.05);
    assert!(
        energy(&choked, end + 0.1, end + 1.0) < 1e-9,
        "the hand stops the choked crash"
    );
}

#[test]
fn a_closed_hi_hat_stops_the_open_one_but_not_the_crash() {
    let open = render(
        plan(&[(0.0, 480.0, 46, Some(46), false)]),
        resources(true),
        DocumentSettings::default(),
    );
    assert!(
        energy(&open, 0.75, 1.5) > 0.05,
        "an open hi-hat rings on its own"
    );
    let closed = render(
        plan(&[
            (0.0, 480.0, 46, Some(46), false),
            (960.0, 1440.0, 42, Some(42), false),
        ]),
        resources(true),
        DocumentSettings::default(),
    );
    assert!(energy(&closed, 0.0, 0.5) > 0.05);
    assert!(
        energy(&closed, 0.65, 1.5) < 1e-9,
        "the closed hi-hat cuts it"
    );
    let crash = render(
        plan(&[
            (0.0, 480.0, 49, Some(49), false),
            (960.0, 1440.0, 42, Some(42), false),
        ]),
        resources(true),
        DocumentSettings::default(),
    );
    assert!(
        energy(&crash, 0.65, 1.5) > 0.05,
        "the hi-hat leaves the crash ringing"
    );
}

#[test]
fn the_kit_mix_mutes_and_levels_recorded_drums_by_element() {
    let hits = || plan(&[(0.0, 480.0, 49, Some(49), false)]);
    let full = render(hits(), resources(true), DocumentSettings::default());
    let mut muted = DocumentSettings::default();
    muted.mixes.insert(
        "drums".into(),
        ChannelMix {
            drum_kit: Some(DrumKitMix {
                cymbals: Some(DrumElementMix {
                    mute: true,
                    ..DrumElementMix::default()
                }),
                ..DrumKitMix::default()
            }),
            ..ChannelMix::default()
        },
    );
    assert!(energy(&full, 0.0, 1.0) > 0.05);
    assert_eq!(
        energy(&render(hits(), resources(true), muted), 0.0, 1.0),
        0.0
    );
    let mut half = DocumentSettings::default();
    half.mixes.insert(
        "drums".into(),
        ChannelMix {
            drum_kit: Some(DrumKitMix {
                cymbals: Some(DrumElementMix {
                    gain: 0.5,
                    ..DrumElementMix::default()
                }),
                ..DrumKitMix::default()
            }),
            ..ChannelMix::default()
        },
    );
    let ratio = energy(&render(hits(), resources(true), half), 0.0, 1.0) / energy(&full, 0.0, 1.0);
    assert!(
        (ratio - 0.25).abs() < 0.01,
        "half the gain is a quarter of the power, got {ratio}"
    );
}

#[test]
fn rendering_the_recorded_kit_does_not_touch_the_heap() {
    // Six rides past the stroke cap, an open hi-hat the closed one cuts, a choked crash, a General MIDI china, a seek
    // into them and the tail: the audio callback's whole recorded-drum path.
    let mut hits: Vec<_> = (0..6)
        .map(|i| {
            (
                i as f64 * 192.0,
                i as f64 * 192.0 + 96.0,
                51,
                Some(51),
                false,
            )
        })
        .collect();
    hits.extend([
        (1200.0, 1400.0, 46, Some(46), false),
        (1300.0, 1500.0, 52, None, false),
        (1400.0, 1600.0, 42, Some(42), false),
        (1500.0, 1700.0, 49, Some(49), true),
    ]);
    let mut renderer = Renderer::new(
        plan(&hits),
        resources(true),
        DocumentSettings::default(),
        RATE,
    )
    .unwrap();
    let mut block = [[0.0f32; 2]; 512];
    let mut heard = false;
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    for _ in 0..200 {
        renderer.render_into(&mut block);
        heard |= block.iter().any(|frame| *frame != [0.0; 2]);
    }
    renderer.seek_tick(1450.0);
    renderer.render_into(&mut block);
    renderer.begin_tail();
    renderer.render_into(&mut block);
    COUNT_HEAP.with(|f| f.set(false));
    assert!(heard, "the blocks under test hold sound");
    assert_eq!(
        HEAP_OPERATIONS.with(Cell::get),
        0,
        "the audio callback allocated or freed heap memory"
    );
}

#[test]
fn drum_notes_ask_for_their_kit_sound_only() {
    let requests = resource_requests(
        &plan(&[
            (0.0, 480.0, 38, Some(1), false),
            (480.0, 960.0, 52, None, false),
        ]),
        &DocumentSettings::default(),
    );
    let keys: Vec<_> = requests
        .iter()
        .filter(|r| r.instrument_id == RECORDED_KIT)
        .map(|r| r.key)
        .collect();
    // The rim shot asks for its own sound, not the snare pitch it shares; the china asks for nothing, and the track adds
    // no placeholder, since its other notes play General MIDI.
    assert_eq!(keys, [1]);
    assert_eq!(requests.len(), 1);
    // The Room kit and a guitar voice play General MIDI, so they load no recordings.
    for sound in [
        TrackSound {
            drum_kit: Some(8),
            ..TrackSound::default()
        },
        TrackSound {
            voice_id: Some("green-guitar".into()),
            ..TrackSound::default()
        },
    ] {
        let mut settings = DocumentSettings::default();
        settings.sounds.insert("drums".into(), sound);
        assert!(
            resource_requests(&plan(&[(0.0, 480.0, 38, Some(1), false)]), &settings).is_empty()
        );
    }
}

/// The bundled kit: every sound it maps plays its recording, and `TABPLAYER_DRUM_DEMO=<path.wav>` writes a demo of the
/// kit for an ear check. Needs `npm run prepare:audio`.
#[test]
#[ignore = "needs the prepared bundled audio"]
fn bundled_kit_plays_every_sound() {
    use std::path::PathBuf;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio");
    let kit = |hits: &[(f64, f64, u8, Option<u8>, bool)]| {
        let plan = plan(hits);
        let requests = resource_requests(&plan, &DocumentSettings::default());
        let resources = Arc::new(AudioResources::load_for_requests(&root, &requests).unwrap());
        (plan, resources)
    };
    let sounds: Vec<u8> = [
        1, 2, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 54, 55, 56, 57, 58,
        59, 60, 61, 62, 63, 64, 67, 68, 69, 70, 71, 72, 73, 74, 75, 80, 81, 82, 83, 84,
    ]
    .into();
    // Every sound has a recording at every velocity, so a request never fails to load and stops playback.
    let manifest: tabplayer_lib::audio::resources::InstrumentManifest =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let instrument = manifest
        .instruments
        .iter()
        .find(|i| i.id == RECORDED_KIT)
        .unwrap();
    for &sound in &sounds {
        for velocity in 1..=127u8 {
            assert!(
                instrument.regions.iter().any(|r| r.trigger == "attack"
                    && (r.key_low..=r.key_high).contains(&sound)
                    && (r.velocity_low..=r.velocity_high).contains(&velocity)),
                "kit sound {sound} has no recording at velocity {velocity}"
            );
        }
    }
    for &sound in &sounds {
        let (plan, resources) = kit(&[(0.0, 480.0, 38, Some(sound), false)]);
        assert!(
            resources
                .manifest
                .instruments
                .iter()
                .any(|i| i.id == RECORDED_KIT)
        );
        let output = render(plan, resources, DocumentSettings::default());
        let peak = output
            .iter()
            .map(|x| x[0].abs().max(x[1].abs()))
            .fold(0.0f32, f32::max);
        // Printed for the ear check: the recordings keep their own levels (the bell tree peaks near -45 dBFS).
        let mut gm = DocumentSettings::default();
        gm.sounds.insert(
            "drums".into(),
            TrackSound {
                voice_id: Some("gm".into()),
                ..TrackSound::default()
            },
        );
        let key = match sound {
            1 => 38,
            2 => 46,
            other => other,
        };
        let (general, resources) = kit(&[(0.0, 480.0, key, None, false)]);
        let general = render(general, resources, gm)
            .iter()
            .map(|x| x[0].abs().max(x[1].abs()))
            .fold(0.0f32, f32::max);
        println!(
            "kit sound {sound}: peak {:.1} dBFS, General MIDI {:.1} dBFS",
            20.0 * peak.max(1e-9).log10(),
            20.0 * general.max(1e-9).log10()
        );
        assert!(peak > 1e-3, "kit sound {sound} is silent");
    }
    let Ok(path) = std::env::var("TABPLAYER_DRUM_DEMO") else {
        return;
    };
    // Eighth notes at 120 bpm (240 ticks): a groove, then each sound on its own, then a crash and a choked crash.
    let mut hits = vec![];
    let mut at = 0.0;
    fn hit(
        hits: &mut Vec<(f64, f64, u8, Option<u8>, bool)>,
        at: &mut f64,
        key: u8,
        sound: Option<u8>,
        choke: bool,
        step: f64,
    ) {
        hits.push((*at, *at + 240.0, key, sound, choke));
        *at += step;
    }
    for bar in 0..2 {
        for eighth in 0..8 {
            let start = at;
            if eighth % 4 == 0 {
                hits.push((start, start + 240.0, 36, Some(36), false));
            }
            if eighth % 4 == 2 {
                hits.push((
                    start,
                    start + 240.0,
                    38,
                    Some(if bar == 1 && eighth == 6 { 1 } else { 38 }),
                    false,
                ));
            }
            let open = eighth == 7;
            hit(
                &mut hits,
                &mut at,
                if open { 46 } else { 42 },
                Some(if open { 46 } else { 42 }),
                false,
                240.0,
            );
        }
    }
    hit(&mut hits, &mut at, 42, Some(42), false, 480.0);
    for &sound in &sounds {
        hit(&mut hits, &mut at, sound, Some(sound), false, 480.0);
    }
    hit(&mut hits, &mut at, 49, Some(49), false, 3840.0);
    hit(&mut hits, &mut at, 49, Some(49), true, 1920.0);
    let end = at + 1920.0;
    hits.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut plan_value = serde_json::to_value(&*plan(&hits)).unwrap();
    plan_value["durationTick"] = end.into();
    plan_value["durationMs"] = (end / TICKS_PER_SECOND * 1000.0).into();
    plan_value["occurrences"][0]["endTick"] = end.into();
    plan_value["occurrences"][0]["endMs"] = (end / TICKS_PER_SECOND * 1000.0).into();
    let plan: Arc<PlaybackPlan> = Arc::new(serde_json::from_value(plan_value).unwrap());
    let requests = resource_requests(&plan, &DocumentSettings::default());
    let resources = Arc::new(AudioResources::load_for_requests(&root, &requests).unwrap());
    let mut renderer = Renderer::new(plan, resources, DocumentSettings::default(), RATE).unwrap();
    let mut output = vec![[0.0f32; 2]; (end / TICKS_PER_SECOND * RATE as f64) as usize];
    renderer.render_into(&mut output);
    let mut wav = Vec::new();
    let data = (output.len() * 4) as u32;
    for part in [
        &b"RIFF"[..],
        &(36 + data).to_le_bytes(),
        b"WAVEfmt ",
        &16u32.to_le_bytes(),
        &1u16.to_le_bytes(),
        &2u16.to_le_bytes(),
        &RATE.to_le_bytes(),
        &(RATE * 4).to_le_bytes(),
        &4u16.to_le_bytes(),
        &16u16.to_le_bytes(),
        b"data",
        &data.to_le_bytes(),
    ] {
        wav.extend_from_slice(part);
    }
    for frame in &output {
        for c in 0..2 {
            wav.extend_from_slice(&((frame[c].clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
    }
    std::fs::write(path, wav).unwrap();
}
