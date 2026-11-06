use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tabplayer_lib::audio::{
    decode::decode_audio,
    resources::{AudioResources, Instrument, Region, SampleRequest, eligible_regions},
};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio")
}

#[test]
fn decode_wav_flac_mp3_vorbis() {
    for extension in ["wav", "flac", "mp3", "ogg"] {
        let audio = decode_audio(
            &fs::read(fixtures().join(format!("tone.{extension}"))).unwrap(),
            Some(extension),
        )
        .unwrap();
        assert_eq!(audio.sample_rate, 44100, "{extension}");
        assert_eq!(audio.channels, 1, "{extension}");
        // Lossy codecs may include one partial frame of decoder padding.
        assert!(
            (audio.frames.len() as f64 / 44100.0 - 0.25).abs() < 0.03,
            "{extension}: {}",
            audio.frames.len()
        );
        assert!(
            audio
                .frames
                .iter()
                .all(|f| f[0].is_finite() && f[0] == f[1])
        );
        // Independent frequency estimate by positive zero crossings.
        let crossings = audio
            .frames
            .windows(2)
            .filter(|f| f[0][0] <= 0.0 && f[1][0] > 0.0)
            .count();
        let frequency = crossings as f64 * 44100.0 / audio.frames.len() as f64;
        assert!((frequency - 440.0).abs() < 15.0, "{extension}: {frequency}");
    }
    assert!(decode_audio(b"not audio", Some("wav")).is_err());
    assert!(decode_audio(&[], None).is_err());
    let wav = fs::read(fixtures().join("tone.wav")).unwrap();
    assert!(decode_audio(&wav[..wav.len() / 2], Some("wav")).is_err());
}

#[test]
fn missing_corrupt_or_escape_sample_rejected() {
    let root = tempfile::tempdir().unwrap();
    let wav = fs::read(fixtures().join("tone.wav")).unwrap();
    let hash = format!("{:x}", Sha256::digest(&wav));
    let mut manifest = serde_json::json!({"schemaVersion":1,"preparationId":"fixture","sources":[],"instruments":[],"samples":[{"id":"test","path":"tone.wav","sha256":hash,"size":wav.len()}],"soundFont":{"path":"sf.sf2","sha256":"0".repeat(64),"size":1}});
    fs::write(
        root.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(
        AudioResources::load(root.path())
            .err()
            .unwrap()
            .contains("tone.wav")
    );
    fs::write(root.path().join("tone.wav"), b"corrupt").unwrap();
    assert!(
        AudioResources::load(root.path())
            .err()
            .unwrap()
            .contains("hash")
    );
    manifest["samples"][0]["path"] = "../outside.wav".into();
    fs::write(
        root.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(
        AudioResources::load(root.path())
            .err()
            .unwrap()
            .contains("path")
    );
}

#[test]
fn authored_stereo_preserves_channels() {
    let mut bytes = std::io::Cursor::new(Vec::new());
    {
        let mut wave = hound::WavWriter::new(
            &mut bytes,
            hound::WavSpec {
                channels: 2,
                sample_rate: 48000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for _ in 0..64 {
            wave.write_sample(0.25_f32).unwrap();
            wave.write_sample(-0.5_f32).unwrap();
        }
        wave.finalize().unwrap();
    }
    let audio = decode_audio(&bytes.into_inner(), Some("wav")).unwrap();
    assert_eq!(audio.channels, 2);
    assert_eq!(audio.frames.len(), 64);
    assert_eq!(audio.frames[0], [0.25, -0.5]);
}

#[test]
fn selected_requests_keep_all_variants_and_closest_key_fallback() {
    let regions = [
        (40, 1, 63, 1),
        (40, 1, 63, 2),
        (40, 64, 127, 1),
        (40, 64, 127, 2),
        (44, 1, 127, 1),
    ]
    .into_iter()
    .map(|(key, lo, hi, variant)| Region {
        sample_id: format!("{key}-{lo}-{variant}"),
        root_key: key,
        key_low: key,
        key_high: key,
        velocity_low: lo,
        velocity_high: hi,
        articulation: "picked".into(),
        variant,
        sequence_length: 2,
        trigger: "attack".into(),
        pitch_keytrack: 100.0,
        velocity_gain_high: 127,
        ..Region::default()
    })
    .collect();
    let instrument = Instrument {
        id: "fixture".into(),
        name: "Fixture".into(),
        source_id: "fixture".into(),
        regions,
    };
    let selected = eligible_regions(&instrument, 40, 50, "muted", "attack");
    assert_eq!(selected.len(), 2);
    assert!(selected.iter().all(|r| r.velocity_high == 63));
    let selected = eligible_regions(&instrument, 127, 100, "harmonic", "attack");
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].root_key, 44);
    let selected = eligible_regions(&instrument, 40, 100, "picked", "attack");
    assert_eq!(selected.len(), 2);
    assert!(selected.iter().all(|r| r.velocity_low == 64));
}

#[test]
fn selected_loading_filters_manifest_and_ignores_unrequested_pcm() {
    let root = tempfile::tempdir().unwrap();
    let wav = fs::read(fixtures().join("tone.wav")).unwrap();
    let hash = format!("{:x}", Sha256::digest(&wav));
    fs::write(root.path().join("selected.wav"), &wav).unwrap();
    // A missing unrequested sample is irrelevant to this prepared plan. A request
    // for it must fail, preserving the caller's already working resource Arc.
    let sf = fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"),
    )
    .unwrap();
    fs::write(root.path().join("sf.sf2"), &sf).unwrap();
    fs::write(root.path().join("LICENSE"), b"CC0").unwrap();
    let manifest = serde_json::json!({"schemaVersion":1,"preparationId":"fixture","sources":[{"id":"fixture","repository":"fixture","revision":"1".repeat(40),"license":"CC0-1.0","licensePath":"LICENSE","licenseSha256":format!("{:x}",Sha256::digest(b"CC0"))}],"instruments":[{"id":"fixture","name":"Fixture","sourceId":"fixture","regions":[
        {"sampleId":"selected","rootKey":40,"keyLow":40,"keyHigh":40,"velocityLow":1,"velocityHigh":127,"articulation":"picked","variant":1,"sequenceLength":1,"loopStart":null,"loopEnd":null,"attackSeconds":0.0,"releaseSeconds":0.1,"gainDb":0.0,"trigger":"attack","pitchKeytrack":100.0,"velocityGainHigh":127,"releaseDecayDbPerSecond":0.0},
        {"sampleId":"unused","rootKey":80,"keyLow":80,"keyHigh":80,"velocityLow":1,"velocityHigh":127,"articulation":"picked","variant":1,"sequenceLength":1,"loopStart":null,"loopEnd":null,"attackSeconds":0.0,"releaseSeconds":0.1,"gainDb":0.0,"trigger":"attack","pitchKeytrack":100.0,"velocityGainHigh":127,"releaseDecayDbPerSecond":0.0}]}],"samples":[{"id":"selected","path":"selected.wav","sha256":hash,"size":wav.len()},{"id":"unused","path":"missing.wav","sha256":hash,"size":wav.len()}],"soundFont":{"path":"sf.sf2","sha256":format!("{:x}",Sha256::digest(&sf)),"size":sf.len()}});
    fs::write(
        root.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let resources = AudioResources::load_for_requests(
        root.path(),
        &[SampleRequest {
            instrument_id: "fixture".into(),
            key: 40,
            velocity: 100,
            articulation: "picked".into(),
        }],
    )
    .unwrap();
    assert_eq!(resources.samples.len(), 1);
    assert_eq!(resources.manifest.samples.len(), 1);
    assert_eq!(resources.manifest.instruments[0].regions.len(), 1);
    assert!(
        AudioResources::load_for_requests(
            root.path(),
            &[SampleRequest {
                instrument_id: "fixture".into(),
                key: 80,
                velocity: 100,
                articulation: "picked".into()
            }]
        )
        .is_err()
    );
}

#[test]
#[ignore = "requires npm run prepare:audio; run explicitly to verify the actual bundled libraries"]
fn pinned_offline_asset_hash_and_license_inventory() {
    let resources =
        AudioResources::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"))
            .unwrap();
    assert_eq!(resources.manifest.instruments.len(), 4);
    assert!(resources.samples.len() > 3000);
    for instrument in &resources.manifest.instruments {
        let attacks: Vec<_> = instrument
            .regions
            .iter()
            .filter(|r| {
                r.trigger == "attack"
                    && (r.articulation == "picked" || r.articulation == "fingered")
            })
            .collect();
        assert!(attacks.len() > 100, "{}", instrument.id);
        assert!(attacks.iter().any(|r| r.velocity_low > 1));
        assert!(attacks.iter().any(|r| r.variant > 1));
        for region in &instrument.regions {
            assert!(resources.samples.contains_key(&region.sample_id));
        }
    }
}

#[test]
#[ignore = "requires npm run prepare:audio; exercise the real recorded pack explicitly"]
fn selected_real_100bar_fourtrack_resource_budget() {
    let mut requests = Vec::new();
    for bar in 0..100 {
        for (track, voice) in [
            "green-guitar",
            "black-guitar",
            "darkblack-bass",
            "babyblue-bass",
        ]
        .iter()
        .enumerate()
        {
            for beat in 0..4 {
                let keys = if track < 2 {
                    [40, 43, 45, 47, 52, 55, 59, 64]
                } else {
                    [28, 31, 33, 35, 40, 43, 47, 52]
                };
                let techniques = [
                    "picked", "staccato", "legato", "ghost", "dead", "harmonic", "feedback",
                    "slap", "pop",
                ];
                requests.push(SampleRequest {
                    instrument_id: (*voice).into(),
                    key: keys[(bar + beat) % 8],
                    velocity: [24, 55, 88, 120][(bar + beat) % 4],
                    articulation: techniques[(bar + beat + track) % techniques.len()].into(),
                });
            }
        }
    }
    let start = std::time::Instant::now();
    let resources = AudioResources::load_for_requests(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
        &requests,
    )
    .unwrap();
    let frames: usize = resources.samples.values().map(|s| s.frames.len()).sum();
    let encoded: u64 = resources.manifest.samples.iter().map(|s| s.size).sum();
    eprintln!(
        "100-bar/4-track fixture: {} requests, {} loaded samples, {encoded} encoded bytes, {frames} stereo frames, {} PCM bytes, {:.3}s",
        requests.len(),
        resources.samples.len(),
        frames * 8,
        start.elapsed().as_secs_f64()
    );
    assert!(resources.samples.len() < 1000);
    for instrument in &resources.manifest.instruments {
        for region in &instrument.regions {
            assert!(resources.samples.contains_key(&region.sample_id));
        }
    }
    for request in &requests {
        let instrument = resources
            .manifest
            .instruments
            .iter()
            .find(|i| i.id == request.instrument_id)
            .unwrap();
        assert!(
            !eligible_regions(
                instrument,
                request.key,
                request.velocity,
                &request.articulation,
                "attack"
            )
            .is_empty()
        );
    }
}

#[test]
fn slap_and_pop_use_their_recordings_and_fall_back_to_the_ordinary_voice() {
    let region = |id: &str, articulation: &str, key: u8| Region {
        sample_id: id.into(),
        root_key: key,
        key_low: key,
        key_high: key,
        velocity_low: 1,
        velocity_high: 127,
        articulation: articulation.into(),
        variant: 1,
        sequence_length: 1,
        trigger: "attack".into(),
        pitch_keytrack: 100.0,
        velocity_gain_high: 127,
        ..Region::default()
    };
    let bass = Instrument {
        id: "bass".into(),
        name: "Bass".into(),
        source_id: "fixture".into(),
        regions: vec![
            region("fingered", "fingered", 33),
            region("slap-a", "slap", 33),
            region("slap-d", "slap", 38),
            region("pop-a", "pop", 45),
        ],
    };
    let ids = |key, articulation| {
        eligible_regions(&bass, key, 100, articulation, "attack")
            .iter()
            .map(|r| r.sample_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(37, "slap"), ["slap-d"]);
    assert_eq!(ids(28, "slap"), ["slap-a"]);
    assert_eq!(ids(52, "pop"), ["pop-a"]);
    let plain = Instrument {
        regions: vec![region("fingered", "fingered", 33)],
        ..bass.clone()
    };
    for articulation in ["slap", "pop"] {
        let selected = eligible_regions(&plain, 40, 100, articulation, "attack");
        assert_eq!(selected[0].sample_id, "fingered");
    }
}

#[test]
fn recorded_sources_accept_cc0_and_cc_by_pins_only() {
    let root = tempfile::tempdir().unwrap();
    let wav = fs::read(fixtures().join("tone.wav")).unwrap();
    fs::write(root.path().join("note.wav"), &wav).unwrap();
    let sf = fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"),
    )
    .unwrap();
    fs::write(root.path().join("sf.sf2"), &sf).unwrap();
    fs::write(root.path().join("LICENSE"), b"terms").unwrap();
    let load = |license: &str, revision: String| {
        let manifest = serde_json::json!({"schemaVersion":1,"preparationId":"fixture","sources":[{"id":"fixture","repository":"fixture","revision":revision,"license":license,"licensePath":"LICENSE","licenseSha256":format!("{:x}",Sha256::digest(b"terms"))}],"instruments":[{"id":"fixture","name":"Fixture","sourceId":"fixture","regions":[
            {"sampleId":"note","rootKey":40,"keyLow":40,"keyHigh":40,"velocityLow":1,"velocityHigh":127,"articulation":"slap","variant":1,"sequenceLength":1,"loopStart":null,"loopEnd":null,"attackSeconds":0.0,"releaseSeconds":0.1,"gainDb":0.0,"trigger":"attack","pitchKeytrack":100.0,"velocityGainHigh":127,"releaseDecayDbPerSecond":0.0}]}],"samples":[{"id":"note","path":"note.wav","sha256":format!("{:x}",Sha256::digest(&wav)),"size":wav.len()}],"soundFont":{"path":"sf.sf2","sha256":format!("{:x}",Sha256::digest(&sf)),"size":sf.len()}});
        fs::write(
            root.path().join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        AudioResources::load(root.path())
    };
    assert!(load("CC0-1.0", "a".repeat(40)).is_ok());
    assert!(load("CC-BY-3.0", "b".repeat(64)).is_ok());
    assert!(load("CC-BY-NC-3.0", "b".repeat(64)).is_err());
    assert!(load("CC-BY-3.0", "b".repeat(63)).is_err());
    assert!(load("CC-BY-3.0", "g".repeat(64)).is_err());
}

/// Autocorrelation pitch over a settled window, preferring the shortest strong lag so an
/// octave-down period is not mistaken for the fundamental.
fn settled_pitch(samples: &[f32], rate: f64) -> f64 {
    let window = (0.25 * rate) as usize;
    let start = ((0.45 * rate) as usize).min(samples.len().saturating_sub(window) / 2);
    let x = &samples[start..(start + window).min(samples.len())];
    let (min_lag, max_lag) = (
        (rate / 500.0) as usize,
        ((rate / 28.0) as usize).min(x.len() / 2),
    );
    let scores: Vec<f64> = (0..=max_lag + 1)
        .map(|lag| {
            if lag < min_lag || lag > max_lag {
                return 0.0;
            }
            (0..x.len() - lag)
                .map(|i| x[i] as f64 * x[i + lag] as f64)
                .sum()
        })
        .collect();
    let best = (min_lag..=max_lag)
        .max_by(|a, b| scores[*a].total_cmp(&scores[*b]))
        .unwrap();
    let lag = (min_lag..=best)
        .find(|&l| {
            scores[l] >= 0.9 * scores[best]
                && scores[l] >= scores[l - 1]
                && scores[l] >= scores[l + 1]
        })
        .unwrap_or(best);
    rate / lag as f64
}

#[test]
#[ignore = "requires npm run prepare:audio; checks the bundled slap and pop recordings"]
fn bundled_slap_and_pop_recordings_sound_at_their_root_keys() {
    let resources =
        AudioResources::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"))
            .unwrap();
    for id in ["darkblack-bass", "babyblue-bass"] {
        let instrument = resources
            .manifest
            .instruments
            .iter()
            .find(|i| i.id == id)
            .unwrap();
        for articulation in ["slap", "pop"] {
            let regions: Vec<_> = instrument
                .regions
                .iter()
                .filter(|r| r.articulation == articulation)
                .collect();
            assert_eq!(regions.len(), 6, "{id} {articulation}");
            for region in regions {
                let audio = &resources.samples[&region.sample_id];
                let mono: Vec<f32> = audio.frames.iter().map(|f| (f[0] + f[1]) * 0.5).collect();
                let hz = settled_pitch(&mono, audio.sample_rate as f64);
                let measured = 69.0 + 12.0 * (hz / 440.0).log2();
                eprintln!("{} {measured:.2}", region.sample_id);
                assert!(
                    (measured - region.root_key as f64).abs() < 0.5,
                    "{} sounds at {measured:.2}, mapped to {}",
                    region.sample_id,
                    region.root_key
                );
            }
        }
    }
}
