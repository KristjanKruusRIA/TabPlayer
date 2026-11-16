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
// Balance of the recorded kit against General MIDI: what the kit sounds like next to the sound bank's drums by loudness, not
// by peak, and how each answers velocity. See docs/validation/2026-11-16-recorded-kit-balance.md. Every test below reads the
// prepared bundled audio and is ignored by default.

/// A stroke of a drum pattern: its start tick (960 to the quarter note), its kit sound and its velocity. The kit sound is also
/// the General MIDI key, except 1 (rim shot, General MIDI plays 38) and 2 (half-open hi-hat, 46).
type Stroke = (f64, u8, u8);

/// Controller 7 at Guitar Pro's default track volume of 15, which alphaTab writes as 15 * 8 = 120; 119 is within 0.1 dB of that.
const FILE_VOLUME: u8 = 119;

fn gm_key(sound: u8) -> u8 {
    match sound {
        1 => 38,
        2 => 46,
        other => other,
    }
}

/// The plan of one drum track playing `strokes` at `bpm` for `seconds`. `volume` is the channel volume (controller 7) sent at
/// the start, as a Guitar Pro file sends it; None sends none, as the tests above do. `recorded` gives each note its kit sound;
/// without it a note plays General MIDI (with the General MIDI voice in the settings).
fn pattern_plan(
    strokes: &[Stroke],
    bpm: f64,
    seconds: f64,
    volume: Option<u8>,
    recorded: bool,
) -> Arc<PlaybackPlan> {
    let ticks_per_second = 16.0 * bpm;
    let last = strokes.iter().map(|s| s.0 + 240.0).fold(0.0, f64::max);
    let end = ((seconds + 1.0) * ticks_per_second).max(last);
    let mut strokes = strokes.to_vec();
    strokes.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut notes = vec![];
    let mut midi = vec![];
    if let Some(value) = volume {
        midi.push(serde_json::json!({"type":"controller","trackId":"drums","tick":0.0,"channel":9,"controller":7,"value":value}));
    }
    for (index, &(start, sound, velocity)) in strokes.iter().enumerate() {
        let key = gm_key(sound);
        let stop = start + 240.0;
        let mut note = serde_json::json!({"id":format!("n{index}"),"trackId":"drums","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":index},"string":0},"occurrence":0,"channel":9,"startTick":start,"endTick":stop,"key":key,"velocity":velocity,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":start,"semitones":0}]});
        if recorded {
            note["kitSound"] = sound.into();
        }
        notes.push(note);
        midi.push(serde_json::json!({"type":"noteOn","trackId":"drums","tick":start,"channel":9,"key":key,"velocity":velocity}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"drums","tick":stop,"channel":9,"key":key,"velocity":0}));
    }
    midi.sort_by(|a, b| a["tick"].as_f64().partial_cmp(&b["tick"].as_f64()).unwrap());
    Arc::new(serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":end,"durationMs":end / ticks_per_second * 1000.0,"tracks":[{"id":"drums","program":0,"percussion":true}],"tempos":[{"tick":0,"bpm":bpm}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":end,"startMs":0,"endMs":end / ticks_per_second * 1000.0}],"notes":notes,"midi":midi})).unwrap())
}

/// The bundled audio with every recording `strokes` ask for (and the sound bank), loaded once for any number of renders.
fn bundled_resources(strokes: &[Stroke]) -> Arc<AudioResources> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio");
    let plan = pattern_plan(strokes, 120.0, 1.0, None, true);
    let requests = resource_requests(&plan, &DocumentSettings::default());
    Arc::new(AudioResources::load_for_requests(&root, &requests).unwrap())
}

fn render_pattern(
    strokes: &[Stroke],
    bpm: f64,
    seconds: f64,
    volume: Option<u8>,
    recorded: bool,
    resources: &Arc<AudioResources>,
) -> Vec<[f32; 2]> {
    let mut settings = DocumentSettings::default();
    if !recorded {
        settings.sounds.insert(
            "drums".into(),
            TrackSound {
                voice_id: Some("gm".into()),
                ..TrackSound::default()
            },
        );
    }
    let plan = pattern_plan(strokes, bpm, seconds, volume, recorded);
    let mut renderer = Renderer::new(plan, resources.clone(), settings, RATE).unwrap();
    let mut output = vec![[0.0f32; 2]; (seconds * RATE as f64) as usize];
    renderer.render_into(&mut output);
    output
}

fn db(power: f64) -> f64 {
    10.0 * power.max(1e-20).log10()
}
/// Mean power per channel, over `from` to `to` seconds.
fn mean_power(x: &[[f32; 2]], from: f64, to: f64) -> f64 {
    let a = ((from * RATE as f64) as usize).min(x.len());
    let b = ((to * RATE as f64) as usize).min(x.len());
    if b <= a {
        return 0.0;
    }
    x[a..b]
        .iter()
        .map(|f| (f[0] as f64 * f[0] as f64 + f[1] as f64 * f[1] as f64) / 2.0)
        .sum::<f64>()
        / (b - a) as f64
}
fn peak_db(x: &[[f32; 2]]) -> f64 {
    20.0 * x
        .iter()
        .map(|f| f[0].abs().max(f[1].abs()))
        .fold(0.0f32, f32::max)
        .max(1e-9)
        .log10() as f64
}
/// ITU-R BS.1770 K-weighting at 48 kHz (a shelf and a high-pass), so a level counts low and high frequencies as an ear does.
fn k_weighted(x: &[[f32; 2]]) -> Vec<[f32; 2]> {
    const STAGES: [([f64; 3], [f64; 2]); 2] = [
        (
            [1.53512485958697, -2.69169618940638, 1.19839281085285],
            [-1.69065929318241, 0.73248077421585],
        ),
        ([1.0, -2.0, 1.0], [-1.99004745483398, 0.99007225036621]),
    ];
    let mut out = x.to_vec();
    for channel in 0..2 {
        for (b, a) in STAGES {
            let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for frame in out.iter_mut() {
                let input = frame[channel] as f64;
                let y = b[0] * input + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
                x2 = x1;
                x1 = input;
                y2 = y1;
                y1 = y;
                frame[channel] = y as f32;
            }
        }
    }
    out
}

struct HitStats {
    peak: f64,
    rms50: f64,
    rms300: f64,
    k300: f64,
    early_late: f64,
    t20: f64,
    t40: f64,
}
/// One hit rendered from its start: peak, levels over the first 50 and 300 ms (the second K-weighted), the first 50 ms
/// against the next 950 ms (high is dry and punchy, low is ringing), and the time its 10 ms power last stays within 20 and
/// 40 dB of its loudest.
fn hit_stats(x: &[[f32; 2]]) -> HitStats {
    let k = k_weighted(x);
    let window = RATE as usize / 100;
    let envelope: Vec<f64> = x
        .chunks(window)
        .map(|w| {
            w.iter()
                .map(|f| (f[0] as f64 * f[0] as f64 + f[1] as f64 * f[1] as f64) / 2.0)
                .sum::<f64>()
                / w.len() as f64
        })
        .collect();
    let top = envelope.iter().copied().fold(0.0, f64::max);
    let until = |drop: f64| {
        envelope
            .iter()
            .rposition(|&p| p > top * 10f64.powf(-drop / 10.0))
            .map_or(0.0, |i| (i + 1) as f64 / 100.0)
    };
    HitStats {
        peak: peak_db(x),
        rms50: db(mean_power(x, 0.0, 0.05)),
        rms300: db(mean_power(x, 0.0, 0.3)),
        k300: db(mean_power(&k, 0.0, 0.3)),
        early_late: db(mean_power(x, 0.0, 0.05) * 0.05) - db(mean_power(x, 0.05, 1.0) * 0.95),
        t20: until(20.0),
        t40: until(40.0),
    }
}

/// The two-bar groove of the demo the owner approved by ear on 2026-11-06: sixteen steps of 240 ticks at 120 bpm, a kick on
/// every fourth step, a snare between (a rim shot on the last of the second bar), closed hi-hats and an open one on each bar's
/// last step, all at one velocity: 100 in that demo, 95 for what Guitar Pro writes for a note with no dynamic.
fn groove(velocity: u8) -> Vec<Stroke> {
    let mut strokes = vec![];
    for bar in 0..2 {
        for step in 0..8 {
            let at = (bar * 8 + step) as f64 * 240.0;
            if step % 4 == 0 {
                strokes.push((at, 36, velocity));
            }
            if step % 4 == 2 {
                strokes.push((at, if bar == 1 && step == 6 { 1 } else { 38 }, velocity));
            }
            strokes.push((at, if step == 7 { 46 } else { 42 }, velocity));
        }
    }
    strokes
}
/// A fast metal pattern at 180 bpm, eight bars of sixteenth notes: the kick on every sixteenth (double kick) except in the
/// fill bars (the fourth and eighth) after beat 2, the snare on 2 and 4 with a ghost note before each, a crash on every
/// beat, and in a fill bar eight sixteenth toms down the kit, louder as they go. The velocities are those a Guitar Pro file
/// has: ghost notes 45 to 55, normal 92 to 110, accents 127. A last kick and crash close it.
fn metal() -> Vec<Stroke> {
    let mut strokes = vec![];
    for bar in 0..8usize {
        let fill = bar % 4 == 3;
        for step in 0..16usize {
            let at = (bar * 16 + step) as f64 * 240.0;
            if !fill || step < 8 {
                let velocity = if step == 0 {
                    127
                } else if step % 4 == 0 {
                    100
                } else {
                    92
                };
                strokes.push((at, 36, velocity));
            }
            if step == 4 || (step == 12 && !fill) {
                strokes.push((at, 38, if step == 12 && bar % 4 == 2 { 127 } else { 110 }));
            }
            if step == 3 || (step == 11 && !fill) {
                strokes.push((at, 38, 45 + (bar as u8 % 2) * 10));
            }
            if step % 4 == 0 && (!fill || step < 8) {
                strokes.push((at, 49, if step == 0 && bar % 4 == 0 { 127 } else { 100 }));
            }
            if fill && step >= 8 {
                let sound = [50, 50, 48, 48, 45, 45, 43, 41][step - 8];
                strokes.push((at, sound, 95 + (step as u8 - 8) * 4));
            }
        }
    }
    strokes.push((128.0 * 240.0, 36, 127));
    strokes.push((128.0 * 240.0, 49, 127));
    strokes
}

fn group_of(sound: u8) -> usize {
    match sound {
        35 | 36 => 0,
        1 | 37 | 38 => 1,
        2 | 42 | 44 | 46 => 2,
        41 | 43 | 45 | 47 | 48 | 50 => 3,
        _ => 4,
    }
}
const GROUPS: [&str; 5] = ["kick", "snare", "hats", "toms", "cymbals"];

/// The kit and General MIDI playing `strokes` alone, group by group and all together, at one channel volume: each group's
/// K-weighted level over the clip, how far the kick's and snare backbeat's first 50 ms stand above everything else playing then.
fn balance(label: &str, strokes: &[Stroke], bpm: f64, seconds: f64, volume: Option<u8>) {
    let resources = bundled_resources(strokes);
    let ticks_per_second = 16.0 * bpm;
    println!("## {label}, channel volume {volume:?}");
    for recorded in [true, false] {
        let all = render_pattern(strokes, bpm, seconds, volume, recorded, &resources);
        let solos: Vec<Vec<[f32; 2]>> = (0..5)
            .map(|group| {
                let part: Vec<Stroke> = strokes
                    .iter()
                    .copied()
                    .filter(|s| group_of(s.1) == group)
                    .collect();
                if part.is_empty() {
                    vec![[0.0; 2]; all.len()]
                } else {
                    render_pattern(&part, bpm, seconds, volume, recorded, &resources)
                }
            })
            .collect();
        let whole = db(mean_power(&k_weighted(&all), 0.0, seconds));
        let levels: Vec<String> = solos
            .iter()
            .enumerate()
            .map(|(group, solo)| {
                format!(
                    "{} {:+.1}",
                    GROUPS[group],
                    db(mean_power(&k_weighted(solo), 0.0, seconds)) - whole
                )
            })
            .collect();
        // How far the first 50 ms of a stroke stand above all else playing then (the whole clip minus that group's own).
        let above = |group: usize, wanted: &dyn Fn(&Stroke) -> bool| {
            let rest: Vec<[f32; 2]> = all
                .iter()
                .zip(&solos[group])
                .map(|(a, b)| [a[0] - b[0], a[1] - b[1]])
                .collect();
            let values: Vec<f64> = strokes
                .iter()
                .filter(|s| group_of(s.1) == group && wanted(s))
                .map(|s| {
                    let from = s.0 / ticks_per_second;
                    db(mean_power(&solos[group], from, from + 0.05))
                        - db(mean_power(&rest, from, from + 0.05))
                })
                .collect();
            values.iter().sum::<f64>() / values.len().max(1) as f64
        };
        println!(
            "{}: whole {:.1} dB K, peak {:.1} dBFS; groups alone re whole: {}; stands out of the rest by: kick {:+.1} dB, snare backbeats {:+.1} dB",
            if recorded { "kit" } else { "General MIDI" },
            whole,
            peak_db(&all),
            levels.join(", "),
            above(0, &|_| true),
            above(1, &|s| s.2 >= 90)
        );
    }
}

/// `cargo test --release --test audio_recorded_kit -- --ignored --nocapture recorded_kit_balance`
#[test]
#[ignore = "needs the prepared bundled audio"]
fn recorded_kit_balance() {
    let elements: [(&str, u8); 9] = [
        ("kick", 36),
        ("snare", 38),
        ("rim shot", 1),
        ("closed hat", 42),
        ("open hat", 46),
        ("low tom", 45),
        ("high tom", 48),
        ("crash", 49),
        ("ride", 51),
    ];
    let required = [40u8, 70, 100, 127];
    // Required, plus the dynamics Guitar Pro writes (pp to fff) between them.
    let velocities = [31u8, 40, 47, 63, 70, 79, 95, 100, 111, 127];
    println!("## One hit, 16 s, channel volume {FILE_VOLUME}");
    println!(
        "| element | vel | engine | peak dBFS | 0-50 ms dB | 0-300 ms dB | 0-300 ms K dB | early/late dB | to -20 dB s | to -40 dB s |"
    );
    let mut stats = std::collections::HashMap::new();
    for &(name, sound) in &elements {
        for &velocity in &velocities {
            let strokes = [(0.0, sound, velocity)];
            let resources = bundled_resources(&strokes);
            for recorded in [true, false] {
                let output = render_pattern(
                    &strokes,
                    120.0,
                    16.0,
                    Some(FILE_VOLUME),
                    recorded,
                    &resources,
                );
                let s = hit_stats(&output);
                if required.contains(&velocity) {
                    println!(
                        "| {name} | {velocity} | {} | {:.1} | {:.1} | {:.1} | {:.1} | {:+.1} | {:.2} | {:.2} |",
                        if recorded { "kit" } else { "gm" },
                        s.peak,
                        s.rms50,
                        s.rms300,
                        s.k300,
                        s.early_late,
                        s.t20,
                        s.t40
                    );
                }
                stats.insert((sound, velocity, recorded), s);
            }
        }
    }
    println!("## Velocity response: 0-300 ms K level re velocity 100, dB (kit / General MIDI)");
    println!("| element | 40 | 70 | 100 | 127 |");
    for &(name, sound) in &elements {
        let row: Vec<String> = required
            .iter()
            .map(|&v| {
                let level = |recorded| {
                    stats[&(sound, v, recorded)].k300 - stats[&(sound, 100, recorded)].k300
                };
                format!("{:+.1} / {:+.1}", level(true), level(false))
            })
            .collect();
        println!("| {name} | {} |", row.join(" | "));
    }
    println!("## Kit minus General MIDI, 0-300 ms K level, dB, at each velocity");
    println!(
        "| element | {} |",
        velocities.map(|v| v.to_string()).join(" | ")
    );
    for &(name, sound) in &elements {
        let row: Vec<String> = velocities
            .iter()
            .map(|&v| {
                format!(
                    "{:+.1}",
                    stats[&(sound, v, true)].k300 - stats[&(sound, v, false)].k300
                )
            })
            .collect();
        println!("| {name} | {} |", row.join(" | "));
    }
    // The recording itself, played from its start without the engine, against what the engine renders from it (velocity 100,
    // the kit's own gain applied): what the room does is in the recording, not added by playback.
    println!(
        "## The recording alone and rendered, velocity 100: early/late dB, to -20 dB s, to -40 dB s"
    );
    for &(name, sound) in &elements {
        let strokes = [(0.0, sound, 100u8)];
        let resources = bundled_resources(&strokes);
        let instrument = resources
            .manifest
            .instruments
            .iter()
            .find(|i| i.id == RECORDED_KIT)
            .unwrap();
        let region = tabplayer_lib::audio::voices::select_region(
            instrument,
            sound,
            100,
            tabplayer_lib::audio::plan::Articulation::Picked,
            0,
            "attack",
        )
        .unwrap();
        let audio = &resources.samples[&region.sample_id];
        let raw = hit_stats(audio.frames.as_ref());
        let rendered = &stats[&(sound, 100u8, true)];
        println!(
            "| {name} | {} Hz | recording {:+.1}, {:.2}, {:.2} | rendered {:+.1}, {:.2}, {:.2} |",
            audio.sample_rate,
            raw.early_late,
            raw.t20,
            raw.t40,
            rendered.early_late,
            rendered.t20,
            rendered.t40
        );
    }
    for volume in [None, Some(103), Some(FILE_VOLUME), Some(127)] {
        balance("groove at 100", &groove(100), 120.0, 4.5, volume);
        balance("groove at 95", &groove(95), 120.0, 4.5, volume);
        balance("metal", &metal(), 180.0, 15.0, volume);
    }
}

/// Writes the two clips the owner compares kits by, from the prepared bundled audio: `<dir>/<label>-groove.wav` and
/// `<dir>/<label>-metal.wav`. `TABPLAYER_DRUM_CLIPS=<dir> TABPLAYER_DRUM_LABEL=<label>`, and `TABPLAYER_DRUM_GM=1` plays
/// General MIDI instead of the kit.
#[test]
#[ignore = "needs the prepared bundled audio"]
fn recorded_kit_clips() {
    let Ok(dir) = std::env::var("TABPLAYER_DRUM_CLIPS") else {
        return;
    };
    let label = std::env::var("TABPLAYER_DRUM_LABEL").unwrap_or("kit".into());
    let recorded = std::env::var("TABPLAYER_DRUM_GM").is_err();
    for (name, strokes, bpm, seconds) in [
        ("groove", groove(100), 120.0, 4.5),
        ("groove95", groove(95), 120.0, 4.5),
        ("metal", metal(), 180.0, 15.0),
    ] {
        let resources = bundled_resources(&strokes);
        let output = render_pattern(
            &strokes,
            bpm,
            seconds,
            Some(FILE_VOLUME),
            recorded,
            &resources,
        );
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
                wav.extend_from_slice(
                    &((frame[c].clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes(),
                );
            }
        }
        let path = std::path::Path::new(&dir).join(format!("{label}-{name}.wav"));
        std::fs::write(&path, wav).unwrap();
        println!(
            "{}: {:.1} dB K, peak {:.1} dBFS",
            path.display(),
            db(mean_power(&k_weighted(&output), 0.0, seconds)),
            peak_db(&output)
        );
    }
}

/// Every recording layer of each element at full gain, and the level the kit and General MIDI give at every velocity from 1 to
/// 127, as CSV: `layer,sound,from,to,gain_high,variant,peak,k300` and `sweep,sound,velocity,kit_peak,gm_peak,kit_k300,gm_k300`.
#[test]
#[ignore = "needs the prepared bundled audio"]
fn recorded_kit_velocity_sweep() {
    let sounds = [35u8, 36, 38, 1, 42, 46, 45, 48, 49, 51];
    for sound in sounds {
        let all: Vec<Stroke> = (1..=127u8).map(|v| (0.0, sound, v)).collect();
        let resources = bundled_resources(&all);
        let instrument = resources
            .manifest
            .instruments
            .iter()
            .find(|i| i.id == RECORDED_KIT)
            .unwrap();
        for region in instrument
            .regions
            .iter()
            .filter(|r| r.key_low == sound && r.trigger == "attack")
        {
            let Some(audio) = resources.samples.get(&region.sample_id) else {
                continue;
            };
            let k = k_weighted(audio.frames.as_ref());
            println!(
                "layer,{sound},{},{},{},{},{:.1},{:.1}",
                region.velocity_low,
                region.velocity_high,
                region.velocity_gain_high,
                region.variant,
                peak_db(audio.frames.as_ref()),
                db(mean_power(&k, 0.0, 0.3))
            );
        }
        for velocity in 1..=127u8 {
            let hit = [(0.0, sound, velocity)];
            let kit = render_pattern(&hit, 120.0, 0.6, Some(FILE_VOLUME), true, &resources);
            let general = render_pattern(&hit, 120.0, 0.6, Some(FILE_VOLUME), false, &resources);
            println!(
                "sweep,{sound},{velocity},{:.1},{:.1},{:.1},{:.1}",
                peak_db(&kit),
                peak_db(&general),
                db(mean_power(&k_weighted(&kit), 0.0, 0.3)),
                db(mean_power(&k_weighted(&general), 0.0, 0.3))
            );
        }
    }
}

/// The 0-300 ms K-weighted level of every drum-kit sound the kit and General MIDI give at four velocities, as CSV
/// `level,sound,velocity,kit_k300,gm_k300`, at channel volume `FILE_VOLUME`: what the levels in the kit's map are set from.
#[test]
#[ignore = "needs the prepared bundled audio"]
fn recorded_kit_levels() {
    let sounds = [
        35u8, 36, 37, 38, 1, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 55, 57, 59, 2,
    ];
    for sound in sounds {
        let all: Vec<Stroke> = [79u8, 95, 100, 111]
            .iter()
            .map(|&v| (0.0, sound, v))
            .collect();
        let resources = bundled_resources(&all);
        for &(_, _, velocity) in &all {
            let hit = [(0.0, sound, velocity)];
            let level = |recorded| {
                let out = render_pattern(&hit, 120.0, 0.6, Some(FILE_VOLUME), recorded, &resources);
                db(mean_power(&k_weighted(&out), 0.0, 0.3))
            };
            println!(
                "level,{sound},{velocity},{:.2},{:.2}",
                level(true),
                level(false)
            );
        }
    }
}
// Where a drum's energy is, by frequency band and by time, unweighted (the K-weighted levels above roll the low end off). See the
// kick section of docs/validation/2026-11-16-recorded-kit-balance.md. `TABPLAYER_DRUM_LABEL=<name>` names the rows and
// `TABPLAYER_DRUM_GM=1` plays General MIDI instead of the kit.

/// Band edges in Hz: below 60, 60 to 120, 120 to 300, 300 to 2 000, 2 000 to 6 000 (the click) and above 6 000.
const BAND_EDGES: [f64; 7] = [0.0, 60.0, 120.0, 300.0, 2000.0, 6000.0, 1e9];
const BAND_NAMES: [&str; 6] = ["<60", "60-120", "120-300", "300-2k", "2k-6k", ">6k"];

/// In place radix-2 FFT (the length is a power of two).
fn fft(data: &mut [(f64, f64)]) {
    let n = data.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            data.swap(i, j);
        }
    }
    let mut size = 2;
    while size <= n {
        let angle = -std::f64::consts::TAU / size as f64;
        let (wr, wi) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(size) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..size / 2 {
                let (a, b) = (start + k, start + k + size / 2);
                let (tr, ti) = (
                    data[b].0 * cr - data[b].1 * ci,
                    data[b].0 * ci + data[b].1 * cr,
                );
                data[b] = (data[a].0 - tr, data[a].1 - ti);
                data[a] = (data[a].0 + tr, data[a].1 + ti);
                let next = (cr * wr - ci * wi, cr * wi + ci * wr);
                (cr, ci) = next;
            }
        }
        size <<= 1;
    }
}

/// Mean-square power (dB re full scale squared) of `from` to `to` seconds in the six bands and, last, above 100 Hz, both
/// channels averaged. The window is flat with its last quarter faded out, so the cut does not smear the low end over the highs.
fn band_levels(x: &[[f32; 2]], from: f64, to: f64) -> [f64; 7] {
    let a = ((from * RATE as f64) as usize).min(x.len());
    let b = ((to * RATE as f64) as usize).min(x.len());
    let n = b.saturating_sub(a);
    if n == 0 {
        return [-200.0; 7];
    }
    let size = n.next_power_of_two().max(4096) * 2;
    let fade = (n / 4).max(1);
    let weight = |i: usize| {
        if i + fade < n {
            1.0
        } else {
            0.5 * (1.0 + (std::f64::consts::PI * (i + fade - n) as f64 / fade as f64).cos())
        }
    };
    let norm: f64 = (0..n).map(|i| weight(i) * weight(i)).sum();
    let mut power = [0.0f64; 7];
    for channel in 0..2 {
        let mut data = vec![(0.0, 0.0); size];
        for i in 0..n {
            data[i].0 = x[a + i][channel] as f64 * weight(i);
        }
        fft(&mut data);
        for k in 0..=size / 2 {
            let hz = k as f64 * RATE as f64 / size as f64;
            let share = if k == 0 || k == size / 2 { 1.0 } else { 2.0 };
            let p =
                share * (data[k].0 * data[k].0 + data[k].1 * data[k].1) / size as f64 / norm / 2.0;
            for band in 0..6 {
                if hz >= BAND_EDGES[band] && hz < BAND_EDGES[band + 1] {
                    power[band] += p;
                }
            }
            if hz >= 100.0 {
                power[6] += p;
            }
        }
    }
    power.map(db)
}
fn band_row(levels: &[f64; 7]) -> String {
    let total = db(levels[..6]
        .iter()
        .map(|l| 10f64.powf(l / 10.0))
        .sum::<f64>());
    format!(
        "{} | >100 {:.1} | total {:.1}",
        BAND_NAMES
            .iter()
            .zip(levels)
            .map(|(n, l)| format!("{n} {l:.1}"))
            .collect::<Vec<_>>()
            .join(" | "),
        levels[6],
        total
    )
}
/// The strongest frequency between `lo` and `hi` Hz in `from` to `to` seconds (a Hann window, both channels added).
fn dominant_hz(x: &[[f32; 2]], from: f64, to: f64, lo: f64, hi: f64) -> f64 {
    let a = ((from * RATE as f64) as usize).min(x.len());
    let b = ((to * RATE as f64) as usize).min(x.len());
    let n = b.saturating_sub(a).max(2);
    let size = n.next_power_of_two() * 4;
    let mut data = vec![(0.0, 0.0); size];
    for i in 0..(b - a) {
        let w = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos();
        data[i].0 = (x[a + i][0] + x[a + i][1]) as f64 * w;
    }
    fft(&mut data);
    let (mut best, mut at) = (0.0, 0.0);
    for k in 1..size / 2 {
        let hz = k as f64 * RATE as f64 / size as f64;
        let m = data[k].0 * data[k].0 + data[k].1 * data[k].1;
        if hz >= lo && hz <= hi && m > best {
            (best, at) = (m, hz);
        }
    }
    at
}
fn peak_between(x: &[[f32; 2]], from: f64, to: f64) -> f64 {
    let a = ((from * RATE as f64) as usize).min(x.len());
    let b = ((to * RATE as f64) as usize).min(x.len());
    peak_db(&x[a..b])
}
/// The label the measurement rows carry, and whether the kit (not General MIDI) plays.
fn row_label() -> (String, bool) {
    let recorded = std::env::var("TABPLAYER_DRUM_GM").is_err();
    (
        if recorded {
            std::env::var("TABPLAYER_DRUM_LABEL").unwrap_or("kit".into())
        } else {
            "gm".into()
        },
        recorded,
    )
}

/// One hit of each element named (kick 36 at 95, 100 and 127, snare 38 at 110 and 127, crash 49 at 100 and 127, closed hat 42
/// at 100): peak, peak and level of the first 10 and 50 ms, level of the first second, and the bands of the first second and
/// of the first 50 ms. `cargo test --release --test audio_recorded_kit -- --ignored --nocapture recorded_kit_bands`
#[test]
#[ignore = "needs the prepared bundled audio"]
fn recorded_kit_bands() {
    let (label, recorded) = row_label();
    for (name, sound, velocity) in [
        ("kick", 36u8, 95u8),
        ("kick", 36, 100),
        ("kick", 36, 127),
        ("snare", 38, 110),
        ("snare", 38, 127),
        ("crash", 49, 100),
        ("crash", 49, 127),
        ("closed hat", 42, 100),
    ] {
        let strokes = [(0.0, sound, velocity)];
        let resources = bundled_resources(&strokes);
        let out = render_pattern(
            &strokes,
            120.0,
            2.0,
            Some(FILE_VOLUME),
            recorded,
            &resources,
        );
        let top = out
            .iter()
            .map(|f| f[0].abs().max(f[1].abs()))
            .fold(0.0, f32::max);
        let at = |keep: &dyn Fn(f32) -> bool| {
            out.iter()
                .position(|f| keep(f[0].abs().max(f[1].abs())))
                .unwrap_or(0) as f64
                * 1000.0
                / RATE as f64
        };
        let start_ms = at(&|v| v > top * 0.0316);
        let peak_ms = at(&|v| v >= top);
        println!(
            "hit,{label},{name},{velocity}: peak {:.1} dBFS, first 10 ms peak {:.1} rms {:.1}, first 50 ms peak {:.1} rms {:.1}, first second rms {:.1}, starts (30 dB under the peak) at {:.1} ms, peak at {:.1} ms, strongest 30-300 Hz in the first 300 ms at {:.0} Hz",
            peak_db(&out),
            peak_between(&out, 0.0, 0.01),
            db(mean_power(&out, 0.0, 0.01)),
            peak_between(&out, 0.0, 0.05),
            db(mean_power(&out, 0.0, 0.05)),
            db(mean_power(&out, 0.0, 1.0)),
            start_ms,
            peak_ms,
            dominant_hz(&out, 0.0, 0.3, 30.0, 300.0)
        );
        println!(
            "bands1s,{label},{name},{velocity}: {}",
            band_row(&band_levels(&out, 0.0, 1.0))
        );
        println!(
            "bands50ms,{label},{name},{velocity}: {}",
            band_row(&band_levels(&out, 0.0, 0.05))
        );
    }
}

/// A pattern's groups alone (unweighted level and bands over the clip), and at the kick's onsets the kick's own bands and the
/// rest of the mix's, over the first 10 and 50 ms of each kick, power-averaged over the onsets. The 10 ms window cannot resolve
/// the bands below about 100 Hz.
#[test]
#[ignore = "needs the prepared bundled audio"]
fn recorded_kit_kick_masking() {
    let (label, recorded) = row_label();
    for (name, strokes, bpm, seconds) in [
        ("metal", metal(), 180.0, 15.0),
        ("groove95", groove(95), 120.0, 4.5),
    ] {
        let resources = bundled_resources(&strokes);
        let ticks_per_second = 16.0 * bpm;
        let all = render_pattern(
            &strokes,
            bpm,
            seconds,
            Some(FILE_VOLUME),
            recorded,
            &resources,
        );
        let solo = |group: usize| {
            let part: Vec<Stroke> = strokes
                .iter()
                .copied()
                .filter(|s| group_of(s.1) == group)
                .collect();
            if part.is_empty() {
                vec![[0.0; 2]; all.len()]
            } else {
                render_pattern(&part, bpm, seconds, Some(FILE_VOLUME), recorded, &resources)
            }
        };
        let solos: Vec<_> = (0..5).map(solo).collect();
        println!(
            "pattern,{label},{name}: whole peak {:.1}, whole unweighted {:.1} dB",
            peak_db(&all),
            db(mean_power(&all, 0.0, seconds))
        );
        for (group, solo) in solos.iter().enumerate() {
            println!(
                "group,{label},{name},{}: peak {:.1}, unweighted {:.1} dB, bands {}",
                GROUPS[group],
                peak_db(solo),
                db(mean_power(solo, 0.0, seconds)),
                band_row(&band_levels(solo, 0.0, seconds))
            );
        }
        let rest: Vec<[f32; 2]> = all
            .iter()
            .zip(&solos[0])
            .map(|(a, b)| [a[0] - b[0], a[1] - b[1]])
            .collect();
        let onsets: Vec<f64> = strokes
            .iter()
            .filter(|s| group_of(s.1) == 0)
            .map(|s| s.0 / ticks_per_second)
            .collect();
        // How much a kick's first 50 ms stand out of the kick's own ring before it (the 40 ms before the onset, which holds the
        // tails of the kicks before it), by the kick group alone, over every band and above 100 Hz.
        let mut contrast = [0.0f64; 7];
        let mut counted = 0;
        for &at in onsets.iter().filter(|&&at| at >= 0.04) {
            let (after, before) = (
                band_levels(&solos[0], at, at + 0.05),
                band_levels(&solos[0], at - 0.04, at),
            );
            for (c, (a, b)) in contrast.iter_mut().zip(after.iter().zip(&before)) {
                *c += (a - b).min(60.0);
            }
            counted += 1;
        }
        println!(
            "kickcontrast,{label},{name}: kick onset over the ring before it, dB: {}",
            BAND_NAMES
                .iter()
                .chain([&">100"])
                .zip(contrast)
                .map(|(n, c)| format!("{n} {:.1}", c / counted.max(1) as f64))
                .collect::<Vec<_>>()
                .join(" | ")
        );
        for window in [0.01, 0.05] {
            for (who, signal) in [("kick", &solos[0]), ("rest", &rest)] {
                let mut sum = [0.0f64; 7];
                for &at in &onsets {
                    let levels = band_levels(signal, at, at + window);
                    for (s, l) in sum.iter_mut().zip(levels) {
                        *s += 10f64.powf(l / 10.0);
                    }
                }
                let mean = sum.map(|s| db(s / onsets.len() as f64));
                println!(
                    "onset{:.0}ms,{label},{name},{who}: {}",
                    window * 1000.0,
                    band_row(&mean)
                );
            }
        }
    }
}

/// The bands of every `.flac` recording in the folder `TABPLAYER_DRUM_RAW`, played from its start without the engine: the first
/// 50 ms and the first second, unweighted. For comparing the same drum on the microphones the upstream library has.
#[test]
#[ignore = "needs a folder of recordings"]
fn recorded_kit_raw_recordings() {
    let Ok(dir) = std::env::var("TABPLAYER_DRUM_RAW") else {
        return;
    };
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "flac"))
        .collect();
    paths.sort();
    for path in paths {
        let audio = tabplayer_lib::audio::decode::decode_audio(
            &std::fs::read(&path).unwrap(),
            Some("flac"),
        )
        .unwrap();
        assert_eq!(audio.sample_rate, RATE, "the bands assume {RATE} Hz");
        let x = audio.frames.as_ref();
        let name = path.file_stem().unwrap().to_string_lossy();
        println!(
            "raw,{name}: peak {:.1} dBFS, first 50 ms peak {:.1}, first second rms {:.1}, strongest 30-300 Hz in the first 300 ms at {:.0} Hz",
            peak_db(x),
            peak_between(x, 0.0, 0.05),
            db(mean_power(x, 0.0, 1.0)),
            dominant_hz(x, 0.0, 0.3, 30.0, 300.0)
        );
        println!("raw50ms,{name}: {}", band_row(&band_levels(x, 0.0, 0.05)));
        println!("raw1s,{name}: {}", band_row(&band_levels(x, 0.0, 1.0)));
    }
}
/// How close and how dry each recording is, for every `.flac` of every folder in `TABPLAYER_DRUM_DIST` (one folder per microphone
/// position), played from its start without the engine: when its sound arrives (the first sample within 30 dB of its peak; a
/// microphone farther from the drum hears it later, 1 ms being 34 cm), the first 50 ms against the next 1.45 s counted from there
/// (high is direct, low is room), the time its 10 ms power takes to fall 20 and 40 dB, and how far its 2 to 6 kHz band sits under
/// its total in the first 50 ms.
#[test]
#[ignore = "needs folders of recordings"]
fn recorded_kit_distance() {
    let Ok(dir) = std::env::var("TABPLAYER_DRUM_DIST") else {
        return;
    };
    let mut mics: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    mics.sort();
    for mic in mics {
        let mut files: Vec<_> = std::fs::read_dir(&mic)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "flac"))
            .collect();
        files.sort();
        for path in files {
            let audio = tabplayer_lib::audio::decode::decode_audio(
                &std::fs::read(&path).unwrap(),
                Some("flac"),
            )
            .unwrap();
            assert_eq!(audio.sample_rate, RATE);
            let all = audio.frames.as_ref();
            let top = all
                .iter()
                .map(|f| f[0].abs().max(f[1].abs()))
                .fold(0.0, f32::max);
            let start = all
                .iter()
                .position(|f| f[0].abs().max(f[1].abs()) > top * 0.0316)
                .unwrap_or(0);
            let x = &all[start..];
            let s = hit_stats(&x[..x.len().min(RATE as usize * 3 / 2)]);
            let bands = band_levels(x, 0.0, 0.05);
            let total = db(bands[..6].iter().map(|l| 10f64.powf(l / 10.0)).sum::<f64>());
            println!(
                "dist,{},{}: arrives {:.1} ms, direct/late {:+.1} dB, to -20 dB {:.2} s, to -40 dB {:.2} s, 2-6k under total {:.1} dB, peak {:.1} dBFS",
                mic.file_name().unwrap().to_string_lossy(),
                path.file_stem().unwrap().to_string_lossy(),
                start as f64 * 1000.0 / RATE as f64,
                s.early_late,
                s.t20,
                s.t40,
                total - bands[4],
                peak_db(all)
            );
        }
    }
}

/// The engine against the recording it plays: for each element at velocity 127, the kit's render of one hit is fitted by one gain
/// to the recording the region names (`resources.samples`, the prepared file decoded), and the residual is how far under the render
/// what that gain cannot explain lies (the engine's 16 kHz low-pass and the like). The gain is printed with the region's own
/// `volume` and the channel volume's, which a correct engine makes agree within the velocity curve.
#[test]
#[ignore = "needs the prepared bundled audio"]
fn recorded_kit_fidelity() {
    for (name, sound) in [
        ("kick", 36u8),
        ("snare", 38),
        ("closed hat", 42),
        ("low tom", 45),
        ("high tom", 48),
        ("crash", 49),
        ("ride", 51),
    ] {
        let strokes = [(0.0, sound, 127u8)];
        let resources = bundled_resources(&strokes);
        let instrument = resources
            .manifest
            .instruments
            .iter()
            .find(|i| i.id == RECORDED_KIT)
            .unwrap();
        let region = tabplayer_lib::audio::voices::select_region(
            instrument,
            sound,
            127,
            tabplayer_lib::audio::plan::Articulation::Picked,
            0,
            "attack",
        )
        .unwrap();
        let source = resources.samples[&region.sample_id].frames.clone();
        let out = render_pattern(&strokes, 120.0, 3.0, Some(FILE_VOLUME), true, &resources);
        let n = source.len().min(out.len());
        let (mut rs, mut ss, mut rr) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..n {
            for c in 0..2 {
                let (r, s) = (out[i][c] as f64, source[i][c] as f64);
                rs += r * s;
                ss += s * s;
                rr += r * r;
            }
        }
        let gain = rs / ss;
        let residual = rr - rs * rs / ss;
        // The best lag within 2 ms, to show the render is not shifted against the file.
        println!(
            "fidelity,{name}: file {}, fitted gain {:+.1} dB, region volume {:+.1} dB, channel volume {:+.1} dB, residual {:.1} dB under the render",
            region.sample_id,
            20.0 * gain.abs().log10(),
            region.gain_db,
            20.0 * (FILE_VOLUME as f64 / 127.0).log10(),
            db(rr) - db(residual)
        );
    }
}
