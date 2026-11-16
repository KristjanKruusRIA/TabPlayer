//! A one-key kit on disk for the loader's tests: a manifest with a processing table, a main recording, a second microphone's recording of
//! the same hit and a snare, all authored here.
#![allow(dead_code)]
use sha2::{Digest, Sha256};
use std::fs;
use tabplayer_lib::audio::resources::{Region, SampleRequest};

/// The id the loader gives the percussion kit, the one instrument with a General MIDI fall back.
pub const KIT_ID: &str = "virtuosity-kit";

// The recorded kit's processing: baked once when the recordings are loaded, from a table in the manifest that is not trusted.

/// A mono thump (70 Hz under a decay) of `seconds`, starting `start` seconds in, as a 48 kHz float WAV.
pub fn thump_wav(start: f64, seconds: f64, sign: f32) -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    {
        let mut wave = hound::WavWriter::new(
            &mut bytes,
            hound::WavSpec {
                channels: 1,
                sample_rate: 48000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for n in 0..(seconds * 48000.0) as usize {
            let t = n as f64 / 48000.0 - start;
            let x = if t < 0.0 {
                0.0
            } else {
                (std::f64::consts::TAU * 70.0 * t).sin() * (-t * 12.0).exp() * 0.5
            };
            wave.write_sample(x as f32 * sign).unwrap();
        }
        wave.finalize().unwrap();
    }
    bytes.into_inner()
}

/// A resources folder with a two-key kit: key 36 plays "main" with "second" (the same hit on a second microphone, 3.2 ms later and
/// inverted) as its companion, through `table`; key 38 plays "snare". A second instrument, "other", plays "other" at key 50 with
/// no processing, as a guitar would.
pub fn kit_root(table: serde_json::Value, companion_of_kick: bool) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let font = fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
    ))
    .unwrap();
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let license = b"CC0 fixture\n";
    let mut files = vec![
        ("main.wav", thump_wav(0.004, 1.5, 1.0)),
        ("second.wav", thump_wav(0.0072, 1.5, -1.0)),
        ("snare.wav", thump_wav(0.004, 1.5, 1.0)),
        ("other.wav", thump_wav(0.004, 1.5, 1.0)),
        ("third.wav", thump_wav(0.006, 1.5, 1.0)),
    ];
    files.push(("license.txt", license.to_vec()));
    files.push(("sf.sf2", font.clone()));
    for (name, bytes) in &files {
        fs::write(root.path().join(name), bytes).unwrap();
    }
    let region = |sample: &str, key: u8, companion: Option<&str>| {
        serde_json::to_value(Region {
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
            velocity_gain_high: 127,
            companion_id: companion.map(String::from),
            ..Region::default()
        })
        .unwrap()
    };
    let asset = |id: &str, path: &str| {
        let bytes = files.iter().find(|(n, _)| *n == path).unwrap().1.clone();
        serde_json::json!({"id":id,"path":path,"sha256":hash(&bytes),"size":bytes.len()})
    };
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "preparationId": "fixture",
        "sources": [{"id":"k","repository":"a/b","revision":"0".repeat(40),"license":"CC0-1.0","licensePath":"license.txt","licenseSha256":hash(license)}],
        "instruments": [{
            "id": KIT_ID, "name": "Kit", "sourceId": "k",
            "regions": [region("main", 36, companion_of_kick.then_some("second")), region("snare", 38, None)],
            "processing": table
        }, {
            "id": "other", "name": "Other", "sourceId": "k",
            "regions": [region("other", 50, None)]
        }],
        "samples": [asset("main", "main.wav"), asset("second", "second.wav"), asset("snare", "snare.wav"), asset("other", "other.wav"), asset("third", "third.wav")],
        "soundFont": {"path":"sf.sf2","sha256":hash(&font),"size":font.len()}
    });
    fs::write(
        root.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    root
}

pub fn kit_table() -> serde_json::Value {
    serde_json::json!({
        "profiles": {
            "kick": {
                "companion": {"gainDb": 0, "maxOffsetMs": 8, "minCorrelation": 0.5},
                "eq": [{"kind": "highpass", "hz": 30, "db": 0, "q": 0.707}],
                "envelope": {"holdMs": 50, "decayDbPerSecond": 200, "endMs": 400}
            },
            "snare": {"envelope": {"holdMs": 20, "decayDbPerSecond": 100, "endMs": 250}}
        },
        "sounds": {"36": "kick", "38": "snare"}
    })
}

pub fn kick_request() -> Vec<SampleRequest> {
    vec![SampleRequest {
        instrument_id: KIT_ID.into(),
        key: 36,
        velocity: 100,
        articulation: "picked".into(),
    }]
}

/// Rewrites the folder's manifest.
pub fn edit_manifest(root: &tempfile::TempDir, change: impl FnOnce(&mut serde_json::Value)) {
    let path = root.path().join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    change(&mut manifest);
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
}

/// A request for the instrument "other"'s one key.
pub fn other_request() -> SampleRequest {
    SampleRequest {
        instrument_id: "other".into(),
        key: 50,
        velocity: 100,
        articulation: "picked".into(),
    }
}
