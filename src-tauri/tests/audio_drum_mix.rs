use std::{collections::HashMap, io::Cursor, sync::Arc};
use tabplayer_lib::{
    audio::{
        plan::PlaybackPlan,
        renderer::Renderer,
        resources::{AudioResources, InstrumentManifest},
    },
    settings::{ChannelMix, DocumentSettings, DrumElementMix, DrumKitMix},
};

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

fn drum_plan() -> Arc<PlaybackPlan> {
    let tracks = serde_json::json!([
        {"id": "drums", "program": 0, "percussion": true}
    ]);
    let midi = serde_json::json!([
        {"type": "noteOn", "trackId": "drums", "tick": 0, "channel": 9, "key": 36, "velocity": 100},
        {"type": "noteOff", "trackId": "drums", "tick": 960, "channel": 9, "key": 36, "velocity": 0},
        {"type": "noteOn", "trackId": "drums", "tick": 960, "channel": 9, "key": 38, "velocity": 100},
        {"type": "noteOff", "trackId": "drums", "tick": 1920, "channel": 9, "key": 38, "velocity": 0},
    ]);
    let plan = serde_json::from_value(serde_json::json!({
        "generation": 1,
        "ppq": 960,
        "durationTick": 1920,
        "durationMs": 1000,
        "tracks": tracks,
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 1920, "startMs": 0, "endMs": 1000}],
        "notes": [],
        "midi": midi
    }))
    .unwrap();
    Arc::new(plan)
}

fn energy(samples: &[[f32; 2]]) -> f32 {
    samples
        .iter()
        .map(|s| s[0] * s[0] + s[1] * s[1])
        .sum::<f32>()
        / samples.len().max(1) as f32
}

#[test]
fn drum_kit_element_mix_applies_volume_pan_mute_solo() {
    let plan = drum_plan();
    let resources = drum_resources();

    // 1. Kick muted, snare audible
    let mut settings = DocumentSettings::default();
    let mut kit = DrumKitMix::default();
    kit.kick = Some(DrumElementMix {
        gain: 1.0,
        pan: 0.0,
        mute: true,
        solo: false,
    });
    settings.mixes.insert(
        "drums".into(),
        ChannelMix {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            interpretation: None,
            drum_kit: Some(kit),
        },
    );

    let mut renderer = Renderer::new(plan.clone(), resources.clone(), settings, 48_000).unwrap();
    let mut output = vec![[0.0; 2]; 48000];
    renderer.render_into(&mut output);

    // First half (0..24000) was kick: must be silent because kick was muted!
    let kick_energy = energy(&output[0..24000]);
    // Second half (24000..48000) was snare: must have energy!
    let snare_energy = energy(&output[24000..48000]);

    assert_eq!(kick_energy, 0.0, "Kick must be silent when muted");
    assert!(snare_energy > 1e-5, "Snare must sound when not muted");

    // 2. Kick hard panned left (-1.0)
    let mut settings_pan = DocumentSettings::default();
    let mut kit_pan = DrumKitMix::default();
    kit_pan.kick = Some(DrumElementMix {
        gain: 1.0,
        pan: -1.0,
        mute: false,
        solo: false,
    });
    settings_pan.mixes.insert(
        "drums".into(),
        ChannelMix {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            interpretation: None,
            drum_kit: Some(kit_pan),
        },
    );

    let mut renderer_pan =
        Renderer::new(plan.clone(), resources.clone(), settings_pan, 48_000).unwrap();
    let mut output_pan = vec![[0.0; 2]; 24000];
    renderer_pan.render_into(&mut output_pan);

    let left_energy = output_pan.iter().map(|s| s[0] * s[0]).sum::<f32>();
    let right_energy = output_pan.iter().map(|s| s[1] * s[1]).sum::<f32>();
    assert!(left_energy > 1e-4, "Left channel must have audio");
    assert_eq!(
        right_energy, 0.0,
        "Right channel must be completely silent when panned -1.0"
    );

    // 3. Snare soloed: kick must be silent even though kick.mute is false!
    let mut settings_solo = DocumentSettings::default();
    let mut kit_solo = DrumKitMix::default();
    kit_solo.snare = Some(DrumElementMix {
        gain: 1.0,
        pan: 0.0,
        mute: false,
        solo: true,
    });
    settings_solo.mixes.insert(
        "drums".into(),
        ChannelMix {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            interpretation: None,
            drum_kit: Some(kit_solo),
        },
    );

    let mut renderer_solo =
        Renderer::new(plan.clone(), resources.clone(), settings_solo, 48_000).unwrap();
    let mut output_solo = vec![[0.0; 2]; 48000];
    renderer_solo.render_into(&mut output_solo);

    let solo_kick_energy = energy(&output_solo[0..24000]);
    let solo_snare_energy = energy(&output_solo[24000..48000]);
    assert_eq!(
        solo_kick_energy, 0.0,
        "Kick must be silent when snare is soloed"
    );
    assert!(solo_snare_energy > 1e-5, "Snare must sound when soloed");
}

#[test]
fn document_without_kit_mix_renders_bit_identically() {
    let plan = drum_plan();
    let resources = drum_resources();

    let settings_untouched = DocumentSettings::default();
    let mut renderer_untouched =
        Renderer::new(plan.clone(), resources.clone(), settings_untouched, 48_000).unwrap();
    let mut out1 = vec![[0.0; 2]; 48000];
    renderer_untouched.render_into(&mut out1);

    // Another renderer with untouched settings must produce bit-identical output
    let mut renderer2 = Renderer::new(
        plan.clone(),
        resources.clone(),
        DocumentSettings::default(),
        48_000,
    )
    .unwrap();
    let mut out2 = vec![[0.0; 2]; 48000];
    renderer2.render_into(&mut out2);

    assert_eq!(
        out1, out2,
        "Untouched documents must render bit-identically"
    );
}
