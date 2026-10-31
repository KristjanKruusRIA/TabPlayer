use std::{collections::HashMap, io::Cursor, sync::Arc};
use tabplayer_lib::{
    audio::{
        device::{CallbackTransport, TransportCommand},
        plan::PlaybackPlan,
        renderer::{PreparedMix, Renderer},
        resources::{AudioResources, InstrumentManifest},
    },
    export::{
        audio::{AudioExportRender, AudioExportRequest},
        stems::{StemKind, StemTrack},
        wav::AudioFormat,
    },
    settings::{ChannelMix, DocumentSettings, DrumElementMix, DrumKitMix},
};

//__HELPERS_BEGIN__
const RATE: u32 = 48_000;
/// A bass drum for the first half second and a snare for the second.
const SECOND: usize = RATE as usize;
const HALF: usize = SECOND / 2;
/// A frame while the bass drum is still sounding: it has gone quiet well before the snare starts.
const RINGING: usize = 1500;

fn drum_resources() -> Arc<AudioResources> {
    let mut font = Cursor::new(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
        ))
        .unwrap(),
    );
    Arc::new(AudioResources {
        manifest: InstrumentManifest {
            schema_version: 1,
            instruments: vec![],
            ..Default::default()
        },
        samples: HashMap::new(),
        sound_font: Arc::new(rustysynth::SoundFont::new(&mut font).unwrap()),
    })
}

fn plan_of(midi: serde_json::Value) -> Arc<PlaybackPlan> {
    Arc::new(
        serde_json::from_value(serde_json::json!({
            "generation": 1,
            "ppq": 960,
            "durationTick": 1920,
            "durationMs": 1000,
            "tracks": [{"id": "drums", "program": 0, "percussion": true}],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 1920, "startMs": 0, "endMs": 1000}],
            "notes": [],
            "midi": midi
        }))
        .unwrap(),
    )
}

fn hit(key: u8, on: u32, off: u32, element: Option<&str>) -> Vec<serde_json::Value> {
    [("noteOn", on, 100), ("noteOff", off, 0)]
        .into_iter()
        .map(|(kind, tick, velocity)| {
            let mut event = serde_json::json!({"type": kind, "trackId": "drums", "tick": tick, "channel": 9, "key": key, "velocity": velocity});
            if let Some(element) = element {
                event["kitElement"] = element.into();
            }
            event
        })
        .collect()
}

fn drum_plan() -> Arc<PlaybackPlan> {
    let mut midi = hit(36, 0, 960, None);
    midi.extend(hit(38, 960, 1920, None));
    plan_of(serde_json::Value::Array(midi))
}

fn element(gain: f32, pan: f32, mute: bool, solo: bool) -> Option<DrumElementMix> {
    Some(DrumElementMix {
        gain,
        pan,
        mute,
        solo,
    })
}

fn settings_with(kit: Option<DrumKitMix>) -> DocumentSettings {
    let mut settings = DocumentSettings::default();
    settings.mixes.insert(
        "drums".into(),
        ChannelMix {
            drum_kit: kit,
            ..Default::default()
        },
    );
    settings
}

fn render(plan: &Arc<PlaybackPlan>, settings: DocumentSettings, frames: usize) -> Vec<[f32; 2]> {
    let mut renderer = Renderer::new(plan.clone(), drum_resources(), settings, RATE).unwrap();
    let mut output = vec![[0.0; 2]; frames];
    renderer.render_into(&mut output);
    output
}

fn energy(samples: &[[f32; 2]]) -> f32 {
    samples
        .iter()
        .map(|s| s[0] * s[0] + s[1] * s[1])
        .sum::<f32>()
        / samples.len().max(1) as f32
}

fn peak(samples: &[[f32; 2]]) -> f32 {
    samples
        .iter()
        .flat_map(|s| s.iter())
        .fold(0.0, |peak, v| v.abs().max(peak))
}

/// FNV-1a over the bits of every sample.
fn fingerprint(samples: &[[f32; 2]]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for sample in samples {
        for value in sample {
            for byte in value.to_bits().to_le_bytes() {
                hash = (hash ^ byte as u64).wrapping_mul(0x100000001b3);
            }
        }
    }
    hash
}

fn close(a: &[[f32; 2]], b: &[[f32; 2]], tolerance: f32) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| (x[0] - y[0]).abs() <= tolerance && (x[1] - y[1]).abs() <= tolerance)
}
//__HELPERS_END__

/// What `drum_plan` rendered as before the kit mix existed (one second at 48 kHz, no kit), measured on `feat/gp8-parity`
/// ahead of this feature. A change to how a track without a kit sounds changes this.
const BASELINE: u64 = 10123778408878268807;

#[test]
fn a_track_without_a_kit_renders_exactly_as_it_did_before_the_kit_mix() {
    let plan = drum_plan();
    let output = render(&plan, DocumentSettings::default(), SECOND);
    assert!(energy(&output[..HALF]) > 1e-5 && energy(&output[HALF..]) > 1e-5);
    assert_eq!(
        fingerprint(&output),
        BASELINE,
        "a track without a kit must sound as it did"
    );
    // Saying nothing about the kit and saying it with no kit are the same document.
    assert_eq!(output, render(&plan, settings_with(None), SECOND));
}

#[test]
fn a_kit_that_changes_nothing_sounds_as_no_kit_does() {
    let plan = drum_plan();
    let baseline = render(&plan, DocumentSettings::default(), SECOND);
    let neutral = element(1.0, 0.0, false, false);
    for kit in [
        DrumKitMix {
            kick: neutral,
            ..Default::default()
        },
        DrumKitMix {
            kick: neutral,
            snare: neutral,
            hats: neutral,
            toms: neutral,
            cymbals: neutral,
            other: neutral,
        },
    ] {
        assert_eq!(
            baseline,
            render(&plan, settings_with(Some(kit)), SECOND),
            "elements all at their defaults are the track without a kit"
        );
    }
}

#[test]
fn an_element_level_scales_what_that_element_plays_and_nothing_else() {
    let plan = drum_plan();
    let baseline = render(&plan, DocumentSettings::default(), SECOND);
    let output = render(
        &plan,
        settings_with(Some(DrumKitMix {
            kick: element(0.5, 0.0, false, false),
            ..Default::default()
        })),
        SECOND,
    );
    // The snare is not the kick: it plays as before, and the kick's first half second at half level.
    assert!(
        close(&output[HALF..], &baseline[HALF..], 1e-4 * peak(&baseline)),
        "the snare must be untouched by the kick's level"
    );
    let early = &output[..HALF - 4000];
    let full = &baseline[..HALF - 4000];
    let halved: Vec<[f32; 2]> = full.iter().map(|s| [s[0] * 0.5, s[1] * 0.5]).collect();
    assert!(
        close(early, &halved, 1e-4 * peak(full)),
        "the kick must play at half its level"
    );
    assert!(peak(early) > 0.01, "the comparison is of real sound");
}

#[test]
fn an_element_pan_moves_only_that_element() {
    let plan = drum_plan();
    let baseline = render(&plan, DocumentSettings::default(), SECOND);
    let output = render(
        &plan,
        settings_with(Some(DrumKitMix {
            kick: element(1.0, -1.0, false, false),
            ..Default::default()
        })),
        SECOND,
    );
    let left: f32 = output[..HALF - 4000].iter().map(|s| s[0] * s[0]).sum();
    let right: f32 = output[..HALF - 4000].iter().map(|s| s[1] * s[1]).sum();
    assert!(left > 1e-4, "a hard-left kick sounds on the left");
    assert_eq!(right, 0.0, "and not at all on the right");
    assert!(close(
        &output[HALF..],
        &baseline[HALF..],
        1e-4 * peak(&baseline)
    ));
}

#[test]
fn an_element_mute_and_solo_gate_the_other_elements() {
    let plan = drum_plan();
    let muted = render(
        &plan,
        settings_with(Some(DrumKitMix {
            kick: element(1.0, 0.0, true, false),
            ..Default::default()
        })),
        SECOND,
    );
    assert_eq!(
        energy(&muted[..HALF - 4000]),
        0.0,
        "a muted kick plays nothing"
    );
    assert!(energy(&muted[HALF..]) > 1e-5, "the snare still plays");

    let soloed = render(
        &plan,
        settings_with(Some(DrumKitMix {
            snare: element(1.0, 0.0, false, true),
            ..Default::default()
        })),
        SECOND,
    );
    assert_eq!(
        energy(&soloed[..HALF - 4000]),
        0.0,
        "with the snare soloed the kick plays nothing"
    );
    assert!(energy(&soloed[HALF..]) > 1e-5, "the snare plays");

    // A muted element stays muted even when it is the soloed one.
    let both = render(
        &plan,
        settings_with(Some(DrumKitMix {
            snare: element(1.0, 0.0, true, true),
            ..Default::default()
        })),
        SECOND,
    );
    assert_eq!(energy(&both), 0.0);
}

#[test]
fn a_note_follows_the_element_the_plan_names_and_otherwise_its_pitch() {
    // Key 37 sounds a side stick, which is a snare by pitch; the plan says this one is another piece.
    let named = plan_of(serde_json::Value::Array(hit(37, 0, 1920, Some("other"))));
    let unnamed = plan_of(serde_json::Value::Array(hit(37, 0, 1920, None)));
    let silencing = |element: &str| {
        let mut kit = DrumKitMix::default();
        let muted = DrumElementMix {
            mute: true,
            ..Default::default()
        };
        match element {
            "snare" => kit.snare = Some(muted),
            _ => kit.other = Some(muted),
        }
        settings_with(Some(kit))
    };
    // Without a kit, the plan's element changes nothing.
    assert_eq!(
        render(&named, DocumentSettings::default(), HALF),
        render(&unnamed, DocumentSettings::default(), HALF)
    );
    assert!(energy(&render(&named, silencing("snare"), HALF)) > 1e-5);
    assert_eq!(energy(&render(&named, silencing("other"), HALF)), 0.0);
    assert_eq!(energy(&render(&unnamed, silencing("snare"), HALF)), 0.0);
    assert!(energy(&render(&unnamed, silencing("other"), HALF)) > 1e-5);
}

#[test]
fn a_kit_installed_into_a_playing_renderer_leaves_what_rings_alone() {
    let plan = drum_plan();
    let reference = render(&plan, DocumentSettings::default(), SECOND);
    let mut renderer = Renderer::new(
        plan.clone(),
        drum_resources(),
        DocumentSettings::default(),
        RATE,
    )
    .unwrap();
    let mut output = vec![[0.0; 2]; SECOND];
    renderer.render_into(&mut output[..RINGING]);
    // The first kit edit arrives while the bass drum rings: it must not be cut, struck again, or restarted.
    let kit = settings_with(Some(DrumKitMix {
        snare: element(1.0, 0.0, true, false),
        ..Default::default()
    }));
    let retired = renderer.replace_mix(PreparedMix::prepare(&kit, &plan, RATE).unwrap());
    assert!(retired.is_some());
    renderer.render_into(&mut output[RINGING..]);
    assert!(
        energy(&reference[RINGING..RINGING + 1500]) > 1e-6,
        "the bass drum is still sounding where the kit arrives"
    );
    assert!(
        close(&output[..HALF], &reference[..HALF], 1e-5),
        "the ringing bass drum sounds as if nothing was installed"
    );
    // What the kit then governs is heard from the hit itself: the snare is muted, attack included.
    assert!(
        peak(&reference[HALF..HALF + 480]) > 0.01,
        "the snare is what the kit mutes"
    );
    assert_eq!(peak(&output[HALF..HALF + 480]), 0.0);
    assert_eq!(energy(&output[HALF + 480..]), 0.0);
}

#[test]
fn a_level_from_the_first_kit_edit_applies_from_the_attack() {
    let plan = drum_plan();
    let reference = render(&plan, DocumentSettings::default(), SECOND);
    let mut renderer = Renderer::new(
        plan.clone(),
        drum_resources(),
        DocumentSettings::default(),
        RATE,
    )
    .unwrap();
    let mut output = vec![[0.0; 2]; SECOND];
    renderer.render_into(&mut output[..RINGING]);
    let kit = settings_with(Some(DrumKitMix {
        snare: element(0.25, 0.0, false, false),
        ..Default::default()
    }));
    drop(renderer.replace_mix(PreparedMix::prepare(&kit, &plan, RATE).unwrap()));
    renderer.render_into(&mut output[RINGING..]);
    let want = 0.25 * peak(&reference[HALF..HALF + 480]);
    let got = peak(&output[HALF..HALF + 480]);
    assert!(
        (got - want).abs() < 0.02 * want,
        "attack at a quarter level: {got} vs {want}"
    );
}

#[test]
fn an_active_kit_applies_from_the_attack_after_a_seek() {
    let plan = drum_plan();
    // The snare is struck again by the seek (it is held there), with a kit in effect that has just changed its level.
    let after_seek = |snare: Option<DrumElementMix>| {
        let before = settings_with(Some(DrumKitMix {
            snare: element(1.0, 0.0, false, false),
            kick: element(0.9, 0.0, false, false),
            ..Default::default()
        }));
        let kit = settings_with(Some(DrumKitMix {
            snare,
            kick: element(0.9, 0.0, false, false),
            ..Default::default()
        }));
        let mut renderer = Renderer::new(plan.clone(), drum_resources(), before, RATE).unwrap();
        let mut warm = vec![[0.0; 2]; 3000];
        renderer.render_into(&mut warm);
        drop(renderer.replace_mix(PreparedMix::prepare(&kit, &plan, RATE).unwrap()));
        let mut ramp = vec![[0.0; 2]; 10];
        renderer.render_into(&mut ramp);
        renderer.seek_tick(1100.0);
        let mut after = vec![[0.0; 2]; 480];
        renderer.render_into(&mut after);
        peak(&after)
    };
    let full = after_seek(element(1.0, 0.0, false, false));
    assert!(full > 0.01);
    assert_eq!(after_seek(element(1.0, 0.0, true, false)), 0.0);
    let quarter = after_seek(element(0.25, 0.0, false, false));
    assert!(
        (quarter - 0.25 * full).abs() < 0.02 * full,
        "{quarter} vs {full}"
    );
}

#[test]
fn a_kit_removed_from_a_playing_renderer_lets_its_elements_ring_out() {
    let plan = drum_plan();
    let kit = settings_with(Some(DrumKitMix {
        kick: element(0.5, 0.0, false, false),
        ..Default::default()
    }));
    let reference = render(&plan, kit.clone(), SECOND);
    let mut renderer = Renderer::new(plan.clone(), drum_resources(), kit, RATE).unwrap();
    let mut output = vec![[0.0; 2]; SECOND];
    renderer.render_into(&mut output[..RINGING]);
    drop(
        renderer
            .replace_mix(PreparedMix::prepare(&DocumentSettings::default(), &plan, RATE).unwrap()),
    );
    renderer.render_into(&mut output[RINGING..]);
    // The kick keeps sounding, and returns to its full level over the ramp rather than stepping there.
    assert!(energy(&output[RINGING..HALF - 4000]) > 1e-6);
    let before = output[RINGING - 1][0].abs();
    let after = output[RINGING][0].abs();
    let full = render(&plan, DocumentSettings::default(), SECOND);
    assert!(
        (after - before).abs() <= 0.25 * peak(&full[..HALF]),
        "no step at the install"
    );
    assert!(
        peak(&output[HALF..HALF + 3000]) > 0.01,
        "and the snare plays"
    );
    assert!(peak(&reference[HALF..HALF + 3000]) > 0.01);
}

#[test]
fn muting_a_ringing_element_fades_it_out_instead_of_stepping() {
    // A crash held for the whole second; the kit already in effect (a quiet kick), then the cymbals are muted.
    let plan = plan_of(serde_json::Value::Array(hit(49, 0, 1920, None)));
    let started = settings_with(Some(DrumKitMix {
        kick: element(0.9, 0.0, false, false),
        ..Default::default()
    }));
    let muted = settings_with(Some(DrumKitMix {
        kick: element(0.9, 0.0, false, false),
        cymbals: element(1.0, 0.0, true, false),
        ..Default::default()
    }));
    let reference = render(&plan, started.clone(), SECOND);
    let mut renderer = Renderer::new(plan.clone(), drum_resources(), started, RATE).unwrap();
    let mut output = vec![[0.0; 2]; SECOND];
    let install = 12_000;
    renderer.render_into(&mut output[..install]);
    drop(renderer.replace_mix(PreparedMix::prepare(&muted, &plan, RATE).unwrap()));
    renderer.render_into(&mut output[install..]);
    assert_eq!(&output[..install], &reference[..install]);
    // The first frame after the install is still nearly the whole sound: the level moves, it does not jump.
    let level = |frame: usize| -> f32 {
        let window = &reference[frame..frame + 64];
        let heard = &output[frame..frame + 64];
        peak(heard) / peak(window)
    };
    assert!(peak(&reference[install..install + 64]) > 0.01);
    assert!(
        level(install) > 0.9,
        "the mute must not step within a sample"
    );
    // The fade is short and complete.
    assert!(level(install + 240) < 0.8 && level(install + 240) > 0.1);
    assert_eq!(energy(&output[install + 1200..]), 0.0);
}

#[test]
fn an_export_carries_the_kit_mix() {
    let plan = drum_plan();
    let export = |settings: DocumentSettings| {
        let renderer = Renderer::new(plan.clone(), drum_resources(), settings, RATE).unwrap();
        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "drums".into(),
                name: "Drums".into(),
                preset: "gm".into(),
                kind: StemKind::Score,
            }],
            range: None,
            format: AudioFormat::wav(RATE, 24),
            speed: 1.0,
            metronome: false,
            tail_seconds: 0.0,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        };
        let mut render = AudioExportRender::new(renderer, &plan, request).unwrap();
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
    let plain = export(DocumentSettings::default());
    assert!(plain.len() >= SECOND && energy(&plain[..HALF - 4000]) > 1e-6);
    let kit = export(settings_with(Some(DrumKitMix {
        kick: element(1.0, 0.0, true, false),
        ..Default::default()
    })));
    assert_eq!(
        energy(&kit[..HALF - 4000]),
        0.0,
        "the kick is muted in the export"
    );
    assert!(energy(&kit[HALF..SECOND]) > 1e-6, "the snare is not");
}

#[test]
fn a_kit_element_in_a_plan_is_one_of_the_six_and_is_left_out_when_absent() {
    let named = plan_of(serde_json::Value::Array(hit(37, 0, 1920, Some("other"))));
    let text = serde_json::to_string(&*named).unwrap();
    assert!(text.contains("\"kitElement\":\"other\""));
    let plain = serde_json::to_string(&*drum_plan()).unwrap();
    assert!(
        !plain.contains("kitElement"),
        "old plans round-trip unchanged"
    );
    let unknown = serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 1920, "durationMs": 1000,
        "tracks": [{"id": "drums", "program": 0, "percussion": true}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [],
        "notes": [],
        "midi": hit(37, 0, 1920, Some("xylophone"))
    });
    assert!(serde_json::from_value::<PlaybackPlan>(unknown).is_err());
}

/// A transport with the drum plan installed, driven the way the app drives it.
fn transport(settings: DocumentSettings) -> CallbackTransport {
    let plan = drum_plan();
    let mut transport = CallbackTransport::headless(RATE);
    let renderer = Renderer::new(plan, drum_resources(), settings, RATE).unwrap();
    assert!(
        transport
            .install_with_practice(Box::new(renderer), 1, false, Default::default())
            .is_none()
    );
    transport
}

fn command(transport: &mut CallbackTransport, command: TransportCommand) {
    transport.command(command).unwrap();
}

fn play(transport: &mut CallbackTransport, frames: usize) -> Vec<[f32; 2]> {
    let mut output = vec![[0.0; 2]; frames];
    transport.render_into(&mut output);
    output
}

fn install(transport: &mut CallbackTransport, settings: &DocumentSettings) {
    let mix = PreparedMix::prepare(settings, &drum_plan(), RATE).unwrap();
    assert!(transport.replace_mix(mix, 1).is_some());
}

#[test]
fn a_kit_edit_made_while_stopped_applies_from_the_first_attack_on_play() {
    for (kick, scale) in [
        (element(1.0, 0.0, true, false), 0.0),
        (element(0.25, 0.0, false, false), 0.25),
    ] {
        let mut t = transport(DocumentSettings::default());
        command(&mut t, TransportCommand::Play { generation: 1 });
        play(&mut t, 3000);
        command(&mut t, TransportCommand::Stop { generation: 1 });
        // The kit's first edit arrives while nothing is playing.
        install(
            &mut t,
            &settings_with(Some(DrumKitMix {
                kick,
                ..Default::default()
            })),
        );
        command(&mut t, TransportCommand::Play { generation: 1 });
        let heard = peak(&play(&mut t, 480));
        let mut plain = transport(DocumentSettings::default());
        command(&mut plain, TransportCommand::Play { generation: 1 });
        let full = peak(&play(&mut plain, 480));
        assert!(full > 0.01);
        assert!(
            (heard - scale * full).abs() <= 0.02 * full,
            "kick at {scale} from the hit: {heard} vs {full}"
        );
    }
}

#[test]
fn a_kit_edit_made_while_paused_applies_from_the_first_attack_after_a_seek() {
    let mut t = transport(DocumentSettings::default());
    command(&mut t, TransportCommand::Play { generation: 1 });
    play(&mut t, 3000);
    command(&mut t, TransportCommand::Pause { generation: 1 });
    install(
        &mut t,
        &settings_with(Some(DrumKitMix {
            kick: element(1.0, 0.0, true, false),
            ..Default::default()
        })),
    );
    command(
        &mut t,
        TransportCommand::SeekTick {
            generation: 1,
            tick: 0.0,
        },
    );
    command(&mut t, TransportCommand::Play { generation: 1 });
    assert_eq!(peak(&play(&mut t, 480)), 0.0);
}

#[test]
fn a_kit_edit_made_while_paused_with_notes_ringing_resumes_without_a_click() {
    let kit = |kick| {
        settings_with(Some(DrumKitMix {
            kick,
            snare: element(0.9, 0.0, false, false),
            ..Default::default()
        }))
    };
    // The same pause and resume, with and without the mute arriving while paused.
    let resumed = |edit: bool| {
        let mut t = transport(kit(element(1.0, 0.0, false, false)));
        command(&mut t, TransportCommand::Play { generation: 1 });
        let before = play(&mut t, 1500);
        command(&mut t, TransportCommand::Pause { generation: 1 });
        if edit {
            install(&mut t, &kit(element(1.0, 0.0, true, false)));
        }
        command(&mut t, TransportCommand::Play { generation: 1 });
        (before, play(&mut t, 1000))
    };
    let (before, control) = resumed(false);
    let (_, after) = resumed(true);
    assert!(
        peak(&before[1000..]) > 0.01,
        "the kick is ringing at the pause"
    );
    // The kick keeps ringing from where it stopped and fades out over the ramp: no step at the resume.
    assert_eq!(after[0][0].signum(), control[0][0].signum());
    assert!(
        (after[0][0] - control[0][0]).abs() <= 0.01 * peak(&control[..480]),
        "click on resume: {} against {}",
        after[0][0],
        control[0][0]
    );
    assert!(peak(&after[..240]) > 0.3 * peak(&control[..240]));
    assert_eq!(
        peak(&after[600..]),
        0.0,
        "and it is silent once the ramp ends"
    );
}

#[test]
fn a_kit_edit_made_after_a_seek_into_held_notes_applies_from_the_first_frame() {
    let kit = |snare| {
        settings_with(Some(DrumKitMix {
            kick: element(0.9, 0.0, false, false),
            snare,
            ..Default::default()
        }))
    };
    let after = |snare| {
        let mut t = transport(kit(element(1.0, 0.0, false, false)));
        command(&mut t, TransportCommand::Play { generation: 1 });
        play(&mut t, 3000);
        command(&mut t, TransportCommand::Pause { generation: 1 });
        // Into the middle of the snare, which the seek strikes again before any frame is rendered.
        command(
            &mut t,
            TransportCommand::SeekTick {
                generation: 1,
                tick: 1100.0,
            },
        );
        install(&mut t, &kit(snare));
        command(&mut t, TransportCommand::Play { generation: 1 });
        peak(&play(&mut t, 480))
    };
    let full = after(element(1.0, 0.0, false, false));
    assert!(full > 0.01);
    assert_eq!(after(element(1.0, 0.0, true, false)), 0.0);
    let quarter = after(element(0.25, 0.0, false, false));
    assert!(
        (quarter - 0.25 * full).abs() <= 0.02 * full,
        "{quarter} vs {full}"
    );
}
