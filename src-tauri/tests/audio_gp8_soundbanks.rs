use std::{
    fs,
    io::Cursor,
    num::{NonZeroU8, NonZeroU32},
    path::{Path, PathBuf},
    sync::Arc,
};
use tabplayer_lib::{
    app_settings::SoundbankSettings,
    audio::{
        gp8_soundbanks,
        plan::{Articulation, PlaybackPlan},
        renderer::Renderer,
        resources::AudioResources,
        voices::resource_requests,
    },
    settings::{DocumentSettings, TrackSound},
};
use tempfile::tempdir;
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

fn audio_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio")
}

fn encode_sine_ogg(freq_hz: f64, amplitude: f32, seconds: f64) -> Vec<u8> {
    let rate = 44_100u32;
    let frames = (rate as f64 * seconds) as usize;
    let mut mono = Vec::with_capacity(frames);
    for i in 0..frames {
        let t = i as f64 / rate as f64;
        mono.push((std::f64::consts::TAU * freq_hz * t).sin() as f32 * amplitude);
    }
    let mut out = Cursor::new(Vec::new());
    let mut encoder = VorbisEncoderBuilder::new_with_serial(
        NonZeroU32::new(rate).unwrap(),
        NonZeroU8::new(1).unwrap(),
        &mut out,
        1,
    )
    .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
        target_quality: 0.4,
    })
    .build()
    .unwrap();
    for chunk in mono.chunks(512) {
        encoder.encode_audio_block([chunk]).unwrap();
    }
    encoder.finish().unwrap();
    out.into_inner()
}

fn build_amarchive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut table = Vec::new();
    let header_size = 25usize;
    let raw_table_len: usize = entries.iter().map(|(name, _)| 12 + name.len() + 1).sum();
    let mut data_offset = (header_size + raw_table_len) as u64;
    let mut payload = Vec::new();
    for (name, bytes) in entries {
        table.extend_from_slice(&data_offset.to_le_bytes());
        table.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        table.extend_from_slice(name.as_bytes());
        table.push(0);
        payload.extend_from_slice(bytes);
        data_offset += bytes.len() as u64;
    }

    let mut out = Vec::with_capacity(header_size + table.len() + payload.len());
    out.extend_from_slice(b"AMARCHIVE");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    out.extend_from_slice(&(table.len() as u32).to_le_bytes());
    out.extend_from_slice(&(header_size as u32).to_le_bytes());
    out.extend_from_slice(&table);
    out.extend_from_slice(&payload);
    out
}

fn write_bank(root: &Path, name: &str, entries: &[(&str, &[u8])]) {
    let banks = root.join("banks");
    fs::create_dir_all(&banks).unwrap();
    fs::write(
        banks.join(format!("{name}.gp7bank")),
        build_amarchive(entries),
    )
    .unwrap();
}

fn write_set(root: &Path, id: &str, name: &str, instrument_set: &str, soundbanks: &[(&str, &str)]) {
    let sets = root.join("sets");
    fs::create_dir_all(&sets).unwrap();
    let refs: Vec<_> = soundbanks
        .iter()
        .map(|(el, sb)| serde_json::json!({ "element": el, "soundbank": sb }))
        .collect();
    let json = serde_json::json!({
        "id": id,
        "name": name,
        "description": "",
        "instrumentSet": instrument_set,
        "soundbanks": refs,
    });
    fs::write(
        sets.join(format!("{id}.json")),
        serde_json::to_vec(&json).unwrap(),
    )
    .unwrap();
}

fn build_synthetic_gp8_root(root: &Path) {
    fs::write(
        root.join("META"),
        "Id=soundbank-standard\nName=Standard Soundbank\nVersion=2.0.0-test\n",
    )
    .unwrap();

    // Electric guitar with 3 pickups, dynamic layers, string preference, repitch, and recorded harmonic.
    let ogg_bridge_soft = encode_sine_ogg(220.0, 0.25, 0.35);
    let ogg_bridge_loud = encode_sine_ogg(220.0, 0.70, 0.35);
    let ogg_middle = encode_sine_ogg(440.0, 0.50, 0.35);
    let ogg_neck = encode_sine_ogg(660.0, 0.55, 0.35);
    let ogg_wrong_string = encode_sine_ogg(990.0, 0.50, 0.35);
    let ogg_harmonic_low = encode_sine_ogg(150.0, 0.60, 0.35);
    let guitar_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<SoundBank id="Strat-Guitar" name="Strat" type="electricGuitar" description="Clean &amp; bright" tuning="40 45 50 55 59 64">
  <SamplesTree>
    <Node class="pick"><Node class="sustain"><Node class="down"><Samples>
      <Sample midi="57" string="4" dynamic="f" option="none">
        <Wave pickup="bridge" file="wrong_string.ogg" repitch="0" gain="0.0"/>
      </Sample>
      <Sample midi="57" string="5" dynamic="p" option="none">
        <Wave pickup="bridge" file="bridge_soft.ogg" repitch="0" gain="0.0"/>
        <Wave pickup="middle" file="middle.ogg" repitch="0" gain="0.0"/>
        <Wave pickup="neck" file="neck.ogg" repitch="0" gain="0.0"/>
      </Sample>
      <Sample midi="57" string="5" dynamic="f" option="none">
        <Wave pickup="bridge" file="bridge_loud.ogg" repitch="0" gain="0.0"/>
        <Wave pickup="middle" file="middle.ogg" repitch="0" gain="0.0"/>
        <Wave pickup="neck" file="neck.ogg" repitch="0" gain="0.0"/>
      </Sample>
    </Samples></Node></Node></Node>
    <Node class="harmonic"><Node class="natural"><Node class="12th"><Samples>
      <Sample midi="57" string="5" dynamic="f" option="none">
        <Wave pickup="bridge" file="harm_low.ogg" repitch="0" gain="0.0"/>
        <Wave pickup="neck" file="harm_low.ogg" repitch="0" gain="0.0"/>
      </Sample>
    </Samples></Node></Node></Node>
  </SamplesTree>
</SoundBank>"#;
    write_bank(
        root,
        "Strat-Guitar",
        &[
            ("Samples.xml", guitar_xml.as_bytes()),
            ("wrong_string.ogg", &ogg_wrong_string),
            ("bridge_soft.ogg", &ogg_bridge_soft),
            ("bridge_loud.ogg", &ogg_bridge_loud),
            ("middle.ogg", &ogg_middle),
            ("neck.ogg", &ogg_neck),
            ("harm_low.ogg", &ogg_harmonic_low),
        ],
    );
    write_set(
        root,
        "Strat-Guitar",
        "Strat",
        "electricGuitar",
        &[("Pitched", "Strat-Guitar")],
    );

    // Bass with bridge/neck pickups and repitch test (+1200 cents shifts 110 Hz to ~220 Hz).
    let ogg_bass_110 = encode_sine_ogg(110.0, 0.55, 0.35);
    let bass_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<SoundBank id="Jazz-Bass" name="Jazz Bass" type="electricBass" description="" tuning="28 33 38 43">
  <SamplesTree>
    <Node class="finger"><Node class="sustain"><Node class="index"><Samples>
      <Sample midi="40" string="2" dynamic="f" option="none">
        <Wave pickup="bridge" file="bass.ogg" repitch="1200.0" gain="0.0"/>
        <Wave pickup="neck" file="bass.ogg" repitch="0.0" gain="0.0"/>
      </Sample>
    </Samples></Node></Node></Node>
  </SamplesTree>
</SoundBank>"#;
    write_bank(
        root,
        "Jazz-Bass",
        &[
            ("Samples.xml", bass_xml.as_bytes()),
            ("bass.ogg", &ogg_bass_110),
        ],
    );
    write_set(
        root,
        "Jazz-Bass",
        "Jazz Bass",
        "electricBass",
        &[("Pitched", "Jazz-Bass")],
    );

    // Drum kit: kick, snare, hi-hat (stick vs brush beaters), crash (hit vs choke).
    let ogg_kick = encode_sine_ogg(80.0, 0.65, 0.20);
    let ogg_hat_open = encode_sine_ogg(1200.0, 0.50, 0.60);
    let ogg_hat_closed = encode_sine_ogg(2400.0, 0.45, 0.08);
    let ogg_hat_brush = encode_sine_ogg(500.0, 0.45, 0.30);
    let ogg_crash_ring = encode_sine_ogg(900.0, 0.55, 0.50);
    let ogg_crash_choke = encode_sine_ogg(1700.0, 0.55, 0.25);

    let kick_xml = r#"<SoundBank id="Custom-Kick" name="Kick" type="kickDrum"><SamplesTree><Node class="pedal"><Node class="hit"><Node class="hit"><Samples><Sample midi="-1" string="-1" dynamic="f" option="none"><Wave pickup="none" file="kick.ogg" repitch="0" gain="0.0"/></Sample></Samples></Node></Node></Node></SamplesTree></SoundBank>"#;
    let hihat_xml = r#"<SoundBank id="Custom-Hihat" name="Hihat" type="hiHat"><SamplesTree>
      <Node class="stick"><Node class="hit">
        <Node class="open"><Samples><Sample midi="-1" string="-1" dynamic="f" option="none"><Wave pickup="none" file="hat_open.ogg" repitch="0" gain="0.0"/></Sample></Samples></Node>
        <Node class="closed"><Samples><Sample midi="-1" string="-1" dynamic="f" option="none"><Wave pickup="none" file="hat_closed.ogg" repitch="0" gain="0.0"/></Sample></Samples></Node>
      </Node></Node>
      <Node class="brush"><Node class="hit">
        <Node class="open"><Samples><Sample midi="-1" string="-1" dynamic="f" option="none"><Wave pickup="none" file="hat_brush.ogg" repitch="0" gain="0.0"/></Sample></Samples></Node>
      </Node></Node>
    </SamplesTree></SoundBank>"#;
    let crash_xml = r#"<SoundBank id="Custom-Crash01" name="Crash" type="crash"><SamplesTree>
      <Node class="stick"><Node class="hit">
        <Node class="hit"><Samples><Sample midi="-1" string="-1" dynamic="f" option="none"><Wave pickup="none" file="crash_ring.ogg" repitch="0" gain="0.0"/></Sample></Samples></Node>
        <Node class="choke"><Samples><Sample midi="-1" string="-1" dynamic="f" option="none"><Wave pickup="none" file="crash_choke.ogg" repitch="0" gain="0.0"/></Sample></Samples></Node>
      </Node></Node>
    </SamplesTree></SoundBank>"#;

    write_bank(
        root,
        "Custom-Kick",
        &[
            ("Samples.xml", kick_xml.as_bytes()),
            ("kick.ogg", &ogg_kick),
        ],
    );
    write_bank(
        root,
        "Custom-Hihat",
        &[
            ("Samples.xml", hihat_xml.as_bytes()),
            ("hat_open.ogg", &ogg_hat_open),
            ("hat_closed.ogg", &ogg_hat_closed),
            ("hat_brush.ogg", &ogg_hat_brush),
        ],
    );
    write_bank(
        root,
        "Custom-Crash01",
        &[
            ("Samples.xml", crash_xml.as_bytes()),
            ("crash_ring.ogg", &ogg_crash_ring),
            ("crash_choke.ogg", &ogg_crash_choke),
        ],
    );
    write_set(
        root,
        "Drumkit-Custom",
        "Drums (Custom)",
        "drumKit",
        &[
            ("Kick Drum", "Custom-Kick"),
            ("Hi-Hat", "Custom-Hihat"),
            ("Crash Medium", "Custom-Crash01"),
        ],
    );
    write_set(
        root,
        "Drumkit-Vintage",
        "Drums (Vintage)",
        "drumKit",
        &[
            ("Kick Drum", "Custom-Kick"),
            ("Hi-Hat", "Custom-Hihat"),
            ("Crash Medium", "Custom-Crash01"),
        ],
    );
}

fn dominant_zero_crossing_hz(samples: &[f32], rate: u32) -> f64 {
    let crossings: Vec<f64> = samples
        .windows(2)
        .enumerate()
        .filter(|(_, w)| w[0] < 0.0 && w[1] >= 0.0)
        .map(|(i, w)| i as f64 - w[0] as f64 / (w[1] - w[0]) as f64)
        .collect();
    if crossings.len() < 2 {
        return 0.0;
    }
    (crossings.len() - 1) as f64 * rate as f64 / (crossings.last().unwrap() - crossings[0])
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn render_plan(plan: PlaybackPlan, settings: DocumentSettings) -> (Vec<[f32; 2]>, Vec<String>) {
    let plan = Arc::new(plan);
    let requests = resource_requests(&plan, &settings);
    let resources = Arc::new(AudioResources::load_for_requests(&audio_root(), &requests).unwrap());
    let notices = resources.manifest.notices.clone();
    let mut renderer = Renderer::new(plan.clone(), resources, settings, 48_000).unwrap();
    let frames = ((plan.duration_ms / 1000.0) * 48_000.0).ceil() as usize;
    let mut out = vec![[0.0; 2]; frames.max(24_000)];
    renderer.render_into(&mut out);
    (out, notices)
}

#[test]
fn pitched_guitar_pickups_repitch_dynamics_string_preference_and_recorded_harmonics() {
    let dir = tempdir().unwrap();
    let bank_root = dir.path().join("com.arobas-music.soundbank.standard");
    fs::create_dir_all(&bank_root).unwrap();
    build_synthetic_gp8_root(&bank_root);

    // Passing parent folder containing com.arobas-music.soundbank.standard also resolves cleanly.
    let _guard = gp8_soundbanks::scoped_override(SoundbankSettings {
        enabled: true,
        path: Some(dir.path().to_string_lossy().into_owned()),
    });
    let st = gp8_soundbanks::status();
    assert!(st.available);
    assert_eq!(st.version.as_deref(), Some("2.0.0-test"));
    let strat = st.sets.iter().find(|s| s.id == "Strat-Guitar").unwrap();
    assert_eq!(strat.pickups, vec!["bridge", "middle", "neck"]);

    let one_note_guitar_plan = |key: u8, velocity: u8, art: &str| -> PlaybackPlan {
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 960, "durationMs": 500,
            "tracks": [{"id": "g", "program": 27, "percussion": false}],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 960, "startMs": 0, "endMs": 500}],
            "notes": [{"id": "n0", "trackId": "g", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 720, "key": key, "velocity": velocity, "articulation": art, "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]}],
            "midi": []
        }))
        .unwrap()
    };

    // Bridge (220 Hz) vs Neck (660 Hz) also verifies highest string (5) beat string 4 (990 Hz).
    let settings_with = |pickup: &str| {
        let mut s = DocumentSettings::default();
        s.sounds.insert(
            "g".into(),
            TrackSound {
                voice_id: Some("gp8:Strat-Guitar".into()),
                pickup: Some(pickup.into()),
                ..TrackSound::default()
            },
        );
        s
    };
    let (bridge_soft, notices) = render_plan(
        one_note_guitar_plan(57, 25, "picked"),
        settings_with("bridge"),
    );
    assert!(notices.is_empty());
    let bridge_soft_l: Vec<f32> = bridge_soft[2000..12000].iter().map(|f| f[0]).collect();
    let freq_bridge = dominant_zero_crossing_hz(&bridge_soft_l, 48_000);
    assert!(
        (freq_bridge - 220.0).abs() < 15.0,
        "expected ~220 Hz bridge (not 990 Hz wrong string), got {freq_bridge}"
    );

    let (bridge_loud, _) = render_plan(
        one_note_guitar_plan(57, 120, "picked"),
        settings_with("bridge"),
    );
    let bridge_loud_l: Vec<f32> = bridge_loud[2000..12000].iter().map(|f| f[0]).collect();
    assert!(
        rms(&bridge_loud_l) > rms(&bridge_soft_l) * 1.5,
        "loud dynamic should render louder than soft dynamic"
    );

    let (neck_out, _) = render_plan(
        one_note_guitar_plan(57, 100, "picked"),
        settings_with("neck"),
    );
    let neck_l: Vec<f32> = neck_out[2000..12000].iter().map(|f| f[0]).collect();
    let freq_neck = dominant_zero_crossing_hz(&neck_l, 48_000);
    assert!(
        (freq_neck - 660.0).abs() < 20.0,
        "expected ~660 Hz neck, got {freq_neck}"
    );

    // Repitch (+1200 cents) on Jazz-Bass bridge shifts 110 Hz sample up to ~220 Hz.
    let bass_plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 960, "durationMs": 500,
        "tracks": [{"id": "b", "program": 33, "percussion": false}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 960, "startMs": 0, "endMs": 500}],
        "notes": [{"id": "n0", "trackId": "b", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 720, "key": 40, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]}],
        "midi": []
    })).unwrap();
    let mut s_bass_br = DocumentSettings::default();
    s_bass_br.sounds.insert(
        "b".into(),
        TrackSound {
            voice_id: Some("gp8:Jazz-Bass".into()),
            pickup: Some("bridge".into()),
            ..TrackSound::default()
        },
    );
    let (bass_out, _) = render_plan(bass_plan, s_bass_br);
    let bass_l: Vec<f32> = bass_out[2000..12000].iter().map(|f| f[0]).collect();
    let freq_bass = dominant_zero_crossing_hz(&bass_l, 48_000);
    assert!(
        (freq_bass - 220.0).abs() < 20.0,
        "expected +1200 cent repitch -> ~220 Hz, got {freq_bass}"
    );

    // Recorded harmonic plays full 150 Hz fundamental without synthetic 700 Hz HPF attenuation
    // (~0.226 RMS vs ~0.08 if attenuated by 700 Hz HPF).
    let (harm_out, _) = render_plan(
        one_note_guitar_plan(57, 127, "harmonic"),
        settings_with("bridge"),
    );
    let harm_l: Vec<f32> = harm_out[2000..12000].iter().map(|f| f[0]).collect();
    let harm_rms = rms(&harm_l);
    let harm_hz = dominant_zero_crossing_hz(&harm_l, 48_000);
    assert!(
        harm_rms > 0.20 && (harm_hz - 150.0).abs() < 10.0,
        "recorded harmonic shouldn't be attenuated by synthetic 700 Hz HPF, got rms={harm_rms}, hz={harm_hz}"
    );
    let _ = Articulation::Harmonic;
}

#[test]
fn drum_kit_hihat_choke_cymbal_choke_brush_beater_and_gm_fallback() {
    let dir = tempdir().unwrap();
    build_synthetic_gp8_root(dir.path());
    let _guard = gp8_soundbanks::scoped_override(SoundbankSettings {
        enabled: true,
        path: Some(dir.path().to_string_lossy().into_owned()),
    });

    // Open hat at t=0s choked by closed hat at t=0.125s (tick 240 at 120bpm).
    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 1920, "durationMs": 1000,
        "tracks": [{"id": "d", "program": 0, "percussion": true}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 1920, "startMs": 0, "endMs": 1000}],
        "notes": [
            {"id": "n0", "trackId": "d", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 1920, "key": 46, "kitSound": 46, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "n1", "trackId": "d", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 1}, "string": 1}, "occurrence": 0, "startTick": 240, "endTick": 480, "key": 42, "kitSound": 42, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 240, "semitones": 0}]}
        ],
        "midi": []
    }))
    .unwrap();
    let (choked_out, _) = render_plan(plan, DocumentSettings::default());
    let tail_rms = rms(&choked_out[20_000..40_000]
        .iter()
        .map(|f| f[0])
        .collect::<Vec<_>>());
    assert!(
        tail_rms < 0.01,
        "closed hi-hat must choke ringing 0.6s open hi-hat tail, got rms={tail_rms}"
    );

    // Choked crash selects dedicated recorded "choke" region (1700 Hz) instead of "hit" (900 Hz).
    let crash_plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 960, "durationMs": 500,
        "tracks": [{"id": "d", "program": 0, "percussion": true}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 960, "startMs": 0, "endMs": 500}],
        "notes": [
            {"id": "c0", "trackId": "d", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 480, "key": 49, "kitSound": 49, "choke": true, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]}
        ],
        "midi": []
    }))
    .unwrap();
    let (crash_out, _) = render_plan(crash_plan, DocumentSettings::default());
    let crash_l: Vec<f32> = crash_out[500..8000].iter().map(|f| f[0]).collect();
    let crash_hz = dominant_zero_crossing_hz(&crash_l, 48_000);
    assert!(
        (crash_hz - 1700.0).abs() < 40.0,
        "expected recorded crash choke ~1700 Hz, got {crash_hz}"
    );

    // Brush kit (drum_kit: Some(40)) picks brush beater (~500 Hz) cleanly without stick bleed.
    let brush_plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 960, "durationMs": 500,
        "tracks": [{"id": "d", "program": 0, "percussion": true}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 960, "startMs": 0, "endMs": 500}],
        "notes": [
            {"id": "b0", "trackId": "d", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 480, "key": 46, "kitSound": 46, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]}
        ],
        "midi": []
    }))
    .unwrap();
    let mut brush_settings = DocumentSettings::default();
    brush_settings.sounds.insert(
        "d".into(),
        TrackSound {
            drum_kit: Some(40),
            ..TrackSound::default()
        },
    );
    let (brush_out, _) = render_plan(brush_plan, brush_settings);
    let brush_hz = dominant_zero_crossing_hz(
        &brush_out[500..8000]
            .iter()
            .map(|f| f[0])
            .collect::<Vec<_>>(),
        48_000,
    );
    assert!(
        (brush_hz - 500.0).abs() < 30.0,
        "expected brush open hat ~500 Hz, got {brush_hz}"
    );

    // Unmapped percussion key (39 = Hand Clap) falls back to GM SoundFont cleanly without error.
    let clap_plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 960, "durationMs": 500,
        "tracks": [{"id": "d", "program": 0, "percussion": true}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 960, "startMs": 0, "endMs": 500}],
        "notes": [
            {"id": "p0", "trackId": "d", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 480, "key": 39, "kitSound": 39, "velocity": 110, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]}
        ],
        "midi": [{"type": "noteOn", "trackId": "d", "tick": 0, "channel": 9, "key": 39, "velocity": 110}]
    }))
    .unwrap();
    let (clap_out, notices) = render_plan(clap_plan, DocumentSettings::default());
    assert!(notices.is_empty());
    assert!(
        rms(&clap_out.iter().map(|f| f[0]).collect::<Vec<_>>()) > 0.001,
        "GM clap fallback should produce sound"
    );
}

#[test]
fn legacy_voice_ids_map_to_gp8_when_enabled_and_gm_when_disabled() {
    let dir = tempdir().unwrap();
    build_synthetic_gp8_root(dir.path());
    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 960, "durationMs": 500,
        "tracks": [{"id": "g", "program": 25, "percussion": false}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 960, "startMs": 0, "endMs": 500}],
        "notes": [{"id": "n0", "trackId": "g", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 720, "key": 57, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]}],
        "midi": [{"type": "noteOn", "trackId": "g", "tick": 0, "channel": 0, "key": 57, "velocity": 100}]
    }))
    .unwrap();
    let mut settings = DocumentSettings::default();
    settings.sounds.insert(
        "g".into(),
        TrackSound {
            voice_id: Some("green-guitar".into()),
            ..TrackSound::default()
        },
    );

    {
        let _on = gp8_soundbanks::scoped_override(SoundbankSettings {
            enabled: true,
            path: Some(dir.path().to_string_lossy().into_owned()),
        });
        let reqs = resource_requests(&plan, &settings);
        assert!(reqs.iter().any(|r| r.instrument_id == "gp8:Strat-Guitar"));
        let (out, _) = render_plan(plan.clone(), settings.clone());
        let hz = dominant_zero_crossing_hz(
            &out[2000..12000].iter().map(|f| f[0]).collect::<Vec<_>>(),
            48_000,
        );
        assert!((hz - 220.0).abs() < 15.0);
    }
    {
        let _off = gp8_soundbanks::scoped_override(SoundbankSettings {
            enabled: false,
            path: None,
        });
        let reqs = resource_requests(&plan, &settings);
        assert!(
            reqs.is_empty(),
            "legacy voices fall back to GM when GP8 is disabled"
        );
        let (out, _) = render_plan(plan, settings);
        assert!(
            rms(&out.iter().map(|f| f[0]).collect::<Vec<_>>()) > 0.001,
            "GM fallback must sound"
        );
    }
}

#[test]
fn corrupt_and_unsafe_gp8_archives_and_xml_fall_back_gracefully_without_crashing() {
    let dir = tempdir().unwrap();
    build_synthetic_gp8_root(dir.path());
    // Overwrite Strat-Guitar bank with bad archive cases and verify graceful GM fallback + notice.
    let strat_bank_path = dir.path().join("banks").join("Strat-Guitar.gp7bank");
    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 480, "durationMs": 250,
        "tracks": [{"id": "g", "program": 27, "percussion": false}],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 480, "startMs": 0, "endMs": 250}],
        "notes": [{"id": "n0", "trackId": "g", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 360, "key": 57, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]}],
        "midi": [{"type": "noteOn", "trackId": "g", "tick": 0, "channel": 0, "key": 57, "velocity": 100}]
    }))
    .unwrap();
    let mut settings = DocumentSettings::default();
    settings.sounds.insert(
        "g".into(),
        TrackSound {
            voice_id: Some("gp8:Strat-Guitar".into()),
            ..TrackSound::default()
        },
    );

    let corrupt_payloads: Vec<Vec<u8>> = vec![
        b"BADMAGIC_NOT_AN_ARCHIVE_HEADER_12345".to_vec(),
        build_amarchive(&[("../escape.ogg", b"x"), ("Samples.xml", b"<SoundBank/>")]),
        build_amarchive(&[(
            "Samples.xml",
            br#"<SoundBank type="electricGuitar"><SamplesTree><Node class="pick"><Samples><Sample midi="57" string="1" dynamic="f" option="none"><Wave pickup="bridge" file="not_vorbis.ogg"/></Sample></Samples></Node></SamplesTree>"#,
        )]),
        build_amarchive(&[
            (
                "Samples.xml",
                br#"<SoundBank type="electricGuitar"><SamplesTree><Node class="pick"><Samples><Sample midi="57" string="1" dynamic="f" option="none"><Wave pickup="bridge" file="corrupt.ogg"/></Sample></Samples></Node></SamplesTree></SoundBank>"#,
            ),
            ("corrupt.ogg", b"definitely not ogg vorbis"),
        ]),
    ];

    for payload in corrupt_payloads {
        fs::write(&strat_bank_path, payload).unwrap();
        let _guard = gp8_soundbanks::scoped_override(SoundbankSettings {
            enabled: true,
            path: Some(dir.path().to_string_lossy().into_owned()),
        });
        let (out, notices) = render_plan(plan.clone(), settings.clone());
        assert!(
            !notices.is_empty(),
            "corrupt bank should report a notice rather than panicking"
        );
        assert!(
            rms(&out.iter().map(|f| f[0]).collect::<Vec<_>>()) > 0.001,
            "GM fallback should still render"
        );
    }
}

#[test]
fn soundbank_epoch_advances_on_scoped_override_changes() {
    let e0 = gp8_soundbanks::epoch();
    let dir = tempdir().unwrap();
    build_synthetic_gp8_root(dir.path());
    let e1;
    {
        let _g = gp8_soundbanks::scoped_override(SoundbankSettings {
            enabled: true,
            path: Some(dir.path().to_string_lossy().into_owned()),
        });
        e1 = gp8_soundbanks::epoch();
        assert!(e1 > e0);
    }
    let e2 = gp8_soundbanks::epoch();
    assert!(e2 > e1);
}

#[test]
#[ignore = "Requires locally installed Guitar Pro 8 Standard Soundbank"]
fn real_installed_gp8_soundbank_smoke() {
    let path = PathBuf::from(
        r"C:\ProgramData\Arobas Music\Soundbanks\com.arobas-music.soundbank.standard",
    );
    assert!(
        path.is_dir(),
        "GP8 soundbank not found at {}",
        path.display()
    );
    let _guard = gp8_soundbanks::scoped_override(SoundbankSettings {
        enabled: true,
        path: Some(path.to_string_lossy().into_owned()),
    });
    let st = gp8_soundbanks::status();
    assert!(st.available);
    assert!(
        st.set_count >= 350,
        "expected >= 350 GP8 sets, got {}",
        st.set_count
    );
    let strat = st.sets.iter().find(|s| s.id == "Strat-Guitar").unwrap();
    assert_eq!(strat.pickups, vec!["bridge", "middle", "neck"]);
    let jbass = st.sets.iter().find(|s| s.id == "Jazz-Bass").unwrap();
    assert_eq!(jbass.pickups, vec!["bridge", "neck"]);

    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation": 1, "ppq": 960, "durationTick": 3840, "durationMs": 2000,
        "tracks": [
            {"id": "strat_br", "program": 27, "percussion": false},
            {"id": "strat_nk", "program": 27, "percussion": false},
            {"id": "bass", "program": 33, "percussion": false},
            {"id": "piano", "program": 0, "percussion": false},
            {"id": "violin", "program": 40, "percussion": false},
            {"id": "sax", "program": 65, "percussion": false},
            {"id": "drums", "program": 0, "percussion": true}
        ],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000}],
        "notes": [
            {"id": "g1", "trackId": "strat_br", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 960, "key": 52, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "n1", "trackId": "strat_nk", "source": {"target": {"track": 1, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 960, "key": 52, "velocity": 100, "articulation": "muted", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "b1", "trackId": "bass", "source": {"target": {"track": 2, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 960, "key": 33, "velocity": 100, "articulation": "slap", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "p1", "trackId": "piano", "source": {"target": {"track": 3, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 960, "key": 60, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "v1", "trackId": "violin", "source": {"target": {"track": 4, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 960, "key": 69, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "s1", "trackId": "sax", "source": {"target": {"track": 5, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 960, "key": 64, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "d1", "trackId": "drums", "source": {"target": {"track": 6, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 1}, "occurrence": 0, "startTick": 0, "endTick": 480, "key": 36, "kitSound": 36, "velocity": 110, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]},
            {"id": "d2", "trackId": "drums", "source": {"target": {"track": 6, "staff": 0, "bar": 0, "voice": 0, "beat": 1}, "string": 1}, "occurrence": 0, "startTick": 480, "endTick": 960, "key": 38, "kitSound": 38, "velocity": 110, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 480, "semitones": 0}]},
            {"id": "g2", "trackId": "strat_br", "source": {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 1}, "string": 1}, "occurrence": 0, "startTick": 960, "endTick": 1920, "key": 52, "velocity": 100, "articulation": "harmonic", "legatoFrom": null, "pitch": [{"tick": 960, "semitones": 0}]},
            {"id": "b2", "trackId": "bass", "source": {"target": {"track": 2, "staff": 0, "bar": 0, "voice": 0, "beat": 1}, "string": 1}, "occurrence": 0, "startTick": 960, "endTick": 1920, "key": 45, "velocity": 100, "articulation": "pop", "legatoFrom": null, "pitch": [{"tick": 960, "semitones": 0}]},
            {"id": "d3", "trackId": "drums", "source": {"target": {"track": 6, "staff": 0, "bar": 0, "voice": 0, "beat": 2}, "string": 1}, "occurrence": 0, "startTick": 960, "endTick": 1440, "key": 46, "kitSound": 46, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 960, "semitones": 0}]},
            {"id": "d4", "trackId": "drums", "source": {"target": {"track": 6, "staff": 0, "bar": 0, "voice": 0, "beat": 3}, "string": 1}, "occurrence": 0, "startTick": 1440, "endTick": 1920, "key": 42, "kitSound": 42, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 1440, "semitones": 0}]},
            {"id": "d5", "trackId": "drums", "source": {"target": {"track": 6, "staff": 0, "bar": 0, "voice": 0, "beat": 4}, "string": 1}, "occurrence": 0, "startTick": 1920, "endTick": 2400, "key": 49, "kitSound": 49, "choke": true, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 1920, "semitones": 0}]},
            {"id": "d6", "trackId": "drums", "source": {"target": {"track": 6, "staff": 0, "bar": 0, "voice": 0, "beat": 5}, "string": 1}, "occurrence": 0, "startTick": 2400, "endTick": 2880, "key": 54, "kitSound": 54, "velocity": 100, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 2400, "semitones": 0}]}
        ],
        "midi": []
    }))
    .unwrap();
    let mut settings = DocumentSettings::default();
    settings.sounds.insert(
        "strat_br".into(),
        TrackSound {
            pickup: Some("bridge".into()),
            ..TrackSound::default()
        },
    );
    settings.sounds.insert(
        "strat_nk".into(),
        TrackSound {
            pickup: Some("neck".into()),
            ..TrackSound::default()
        },
    );
    let (out, notices) = render_plan(plan, settings);
    assert!(notices.is_empty(), "unexpected notices: {notices:?}");
    assert!(out.iter().flatten().all(|s| s.is_finite()));
    let peak = out.iter().flatten().map(|s| s.abs()).fold(0.0f32, f32::max);
    assert!(
        peak > 0.05 && peak <= 10.0,
        "expected healthy real GP8 mix output, peak={peak}"
    );
}
