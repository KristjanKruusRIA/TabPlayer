//! Synthetic recordings and plans shared by the palm-mute tests: no fetched audio, no owner score.
use std::{collections::HashMap, io::Cursor, sync::Arc};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        plan::PlaybackPlan,
        renderer::Renderer,
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
    },
    settings::DocumentSettings,
};

pub const RATE: u32 = 48_000;
/// The lowest sampled root of the recorded guitars (E2); the owner's drop D one octave low sits below it.
pub const ROOT: u8 = 40;

/// A plucked string like the recordings: about 20 ms of near-silence, then a bright pick with a harmonic series that decays.
pub fn pluck(seconds: f64, decay: f64) -> Arc<DecodedAudio> {
    let f0 = 440.0 * 2f64.powf((ROOT as f64 - 69.0) / 12.0);
    let mut seed = 12345u32;
    let frames = (0..(seconds * 48_000.0) as usize)
        .map(|n| {
            let t = n as f64 / 48_000.0;
            if t < 0.02 {
                let x = 0.0005 * (std::f64::consts::TAU * f0 * t).sin() as f32;
                return [x, x];
            }
            let t = t - 0.02;
            let mut x = 0.0;
            for h in 1..=24 {
                x += (std::f64::consts::TAU * f0 * h as f64 * t).sin() / (h as f64).powf(0.8)
                    * (-t / (decay / (1.0 + 0.1 * h as f64))).exp();
            }
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 8) as f64 / 8_388_608.0 - 1.0;
            let x = (0.12 * x + 0.1 * noise * (-t / 0.004).exp()) as f32;
            [x, x]
        })
        .collect();
    Arc::new(DecodedAudio {
        sample_rate: 48_000,
        channels: 2,
        frames: Arc::new(frames),
    })
}

/// The recorded dead-note thud is about 7 dB below the recorded open note (the RMS of the first 200 ms of the two recordings in the sound bank).
pub fn quieter(audio: Arc<DecodedAudio>, factor: f32) -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        frames: Arc::new(
            audio
                .frames
                .iter()
                .map(|f| [f[0] * factor, f[1] * factor])
                .collect(),
        ),
    })
}

pub fn region(sample: &str, articulation: &str, trigger: &str, release_seconds: f64) -> Region {
    Region {
        sample_id: sample.into(),
        root_key: ROOT,
        key_low: 0,
        key_high: 127,
        velocity_low: 0,
        velocity_high: 127,
        articulation: articulation.into(),
        variant: 1,
        sequence_length: 1,
        trigger: trigger.into(),
        pitch_keytrack: 100.0,
        velocity_gain_high: 127,
        attack_seconds: 0.01,
        release_seconds,
        ..Default::default()
    }
}

/// A `black-guitar` (General MIDI program 30) with an open, a staccato and a dead recording and, when asked, a loud release recording.
pub fn resources(release: bool) -> Arc<AudioResources> {
    let mut font = Cursor::new(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
        ))
        .unwrap(),
    );
    let mut regions = vec![
        region("open", "picked", "attack", 0.25),
        region("stac", "staccato", "attack", 0.05),
        region("thud", "dead", "attack", 0.08),
    ];
    let mut samples = HashMap::from([
        ("open".to_string(), pluck(1.2, 0.5)),
        ("stac".to_string(), pluck(0.6, 0.12)),
        ("thud".to_string(), quieter(pluck(0.3, 0.05), 0.45)),
    ]);
    if release {
        regions.push(region("rel", "release", "release", 0.25));
        samples.insert(
            "rel".into(),
            Arc::new(DecodedAudio {
                sample_rate: 48_000,
                channels: 2,
                frames: Arc::new(vec![[0.5, 0.5]; 14_400]),
            }),
        );
    }
    let instruments = [
        "black-guitar",
        "green-guitar",
        "babyblue-bass",
        "darkblack-bass",
    ]
    .map(|id| Instrument {
        id: id.into(),
        // The bass recordings of the palm mute and the dead note release over a quarter of a second, like the real ones.
        regions: regions
            .iter()
            .cloned()
            .map(|mut r| {
                if id.ends_with("bass")
                    && (r.articulation == "staccato" || r.articulation == "dead")
                {
                    r.release_seconds = 0.25;
                }
                r
            })
            .collect(),
        ..Default::default()
    });
    Arc::new(AudioResources {
        manifest: InstrumentManifest {
            schema_version: 1,
            instruments: instruments.to_vec(),
            ..Default::default()
        },
        samples,
        sound_font: Arc::new(rustysynth::SoundFont::new(&mut font).unwrap()),
    })
}

/// (start s, length s, key, articulation, string, legato origin); 120 BPM, so a second is 1920 ticks.
pub type Note = (f64, f64, u8, &'static str, u32, Option<&'static str>);
pub fn plan(notes: &[Note], seconds: f64, program: u8) -> Arc<PlaybackPlan> {
    let notes: Vec<_> = notes
        .iter()
        .enumerate()
        .map(|(i, &(start, length, key, articulation, string, legato))| {
            serde_json::json!({"id":format!("n{i}"),"trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":i},"string":string},
                "occurrence":0,"startTick":start*1920.0,"endTick":(start+length)*1920.0,"key":key,"velocity":100,"articulation":articulation,
                "legatoFrom":legato,"pitch":[{"tick":start*1920.0,"semitones":0}]})
        })
        .collect();
    Arc::new(
        serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":seconds*1920.0,"durationMs":seconds*1000.0,
            "tracks":[{"id":"a","program":program,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],
            "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":seconds*1920.0,"startMs":0,"endMs":seconds*1000.0}],
            "notes":notes,"midi":[]}))
        .unwrap(),
    )
}

pub fn render(notes: &[Note], seconds: f64, release: bool) -> Vec<f32> {
    render_program(30, notes, seconds, release)
}

pub fn render_program(program: u8, notes: &[Note], seconds: f64, release: bool) -> Vec<f32> {
    render_chain(program, notes, seconds, release, None)
}

/// As `render_program`, through an effect chain.
pub fn render_chain(
    program: u8,
    notes: &[Note],
    seconds: f64,
    release: bool,
    effects: Option<tabplayer_lib::audio::dsp::FxSettings>,
) -> Vec<f32> {
    let mut settings = DocumentSettings::default();
    if let Some(effects) = effects {
        settings.sounds.insert(
            "a".into(),
            tabplayer_lib::settings::TrackSound {
                voice_id: None,
                preset_id: "clean".into(),
                effects,
                ..Default::default()
            },
        );
    }
    let mut renderer = Renderer::new(
        plan(notes, seconds, program),
        resources(release),
        settings,
        RATE,
    )
    .unwrap();
    let mut output = vec![[0.0f32; 2]; (seconds * RATE as f64) as usize];
    renderer.render_into(&mut output);
    output.iter().map(|f| (f[0] + f[1]) * 0.5).collect()
}

/// The factory "funk clean" chain without its wah: a compressor (-26 dB, 6:1, 5 ms attack, +5 dB makeup) into a clean amp and a cabinet. The
/// compressor squashes an open note and lets a short thud's transient through, which lifted a pitched-down dead note above the open note.
pub fn clean_compressed() -> tabplayer_lib::audio::dsp::FxSettings {
    let mut fx = tabplayer_lib::audio::dsp::FxSettings::preset("clean").unwrap();
    fx.compressor.enabled = true;
    fx.compressor.threshold_db = -26.0;
    fx.compressor.ratio = 6.0;
    fx.compressor.attack_ms = 5.0;
    fx.compressor.release_ms = 80.0;
    fx.compressor.makeup_db = 5.0;
    fx.amp.gain_db = 12.0;
    fx
}
