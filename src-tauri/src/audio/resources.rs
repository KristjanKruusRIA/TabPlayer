use super::decode::{DecodedAudio, decode_audio};
use rustysynth::SoundFont;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Cursor,
    path::{Component, Path},
    sync::Arc,
};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub sample_id: String,
    pub root_key: u8,
    pub key_low: u8,
    pub key_high: u8,
    pub velocity_low: u8,
    pub velocity_high: u8,
    pub articulation: String,
    pub variant: u16,
    pub sequence_length: u16,
    pub loop_start: Option<u64>,
    pub loop_end: Option<u64>,
    pub attack_seconds: f64,
    pub release_seconds: f64,
    pub gain_db: f64,
    pub trigger: String,
    pub pitch_keytrack: f64,
    pub velocity_gain_high: u8,
    pub release_decay_db_per_second: f64,
    /// A drum voice of this group stops the voices on its track whose `off_by` names it; 0 is no group.
    #[serde(default)]
    pub group: u32,
    #[serde(default)]
    pub off_by: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub id: String,
    pub name: String,
    pub source_id: String,
    pub regions: Vec<Region>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRevision {
    pub id: String,
    pub repository: String,
    pub revision: String,
    pub license: String,
    pub license_path: String,
    pub license_sha256: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleAsset {
    pub id: String,
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFontAsset {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentManifest {
    pub schema_version: u32,
    pub preparation_id: String,
    pub sources: Vec<SourceRevision>,
    pub instruments: Vec<Instrument>,
    pub samples: Vec<SampleAsset>,
    pub sound_font: SoundFontAsset,
}

pub struct AudioResources {
    pub manifest: InstrumentManifest,
    pub samples: HashMap<String, Arc<DecodedAudio>>,
    pub sound_font: Arc<SoundFont>,
}

#[derive(Clone, Debug)]
pub struct SampleRequest {
    pub instrument_id: String,
    pub key: u8,
    pub velocity: u8,
    pub articulation: String,
}

/// Shared preparation/render selection keeps all round-robin slots for the
/// closest recorded key and velocity layer. Technique aliases use a recorded
/// short/legato attack where available, otherwise the ordinary recorded voice.
pub fn eligible_regions<'a>(
    instrument: &'a Instrument,
    key: u8,
    velocity: u8,
    articulation: &str,
    trigger: &str,
) -> Vec<&'a Region> {
    let normalized = match articulation {
        "muted" => "staccato",
        "tapped" => "legato",
        other => other,
    };
    let primary = if instrument
        .regions
        .iter()
        .any(|r| r.articulation == "fingered")
    {
        "fingered"
    } else {
        "picked"
    };
    let wanted = if trigger == "release" {
        "release"
    } else if instrument
        .regions
        .iter()
        .any(|r| r.trigger == trigger && r.articulation == normalized)
    {
        normalized
    } else {
        primary
    };
    let candidates: Vec<_> = instrument
        .regions
        .iter()
        .filter(|r| r.trigger == trigger && r.articulation == wanted)
        .collect();
    let distance = |r: &&Region| {
        let velocity_distance = if velocity < r.velocity_low {
            r.velocity_low - velocity
        } else {
            velocity.saturating_sub(r.velocity_high)
        };
        let key_distance = if key < r.key_low {
            r.key_low - key
        } else {
            key.saturating_sub(r.key_high)
        };
        (velocity_distance, key_distance, key.abs_diff(r.root_key))
    };
    let Some(closest) = candidates.iter().map(distance).min() else {
        return vec![];
    };
    candidates
        .into_iter()
        .filter(|r| distance(r) == closest)
        .collect()
}

fn read_confined(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = Path::new(relative);
    if relative.contains('\\')
        || relative.contains(':')
        || path.is_absolute()
        || path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(format!("Invalid audio resource path: {relative}"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Audio resource directory: {e}"))?;
    let full = root
        .join(path)
        .canonicalize()
        .map_err(|e| format!("Missing audio resource {relative}: {e}"))?;
    if !full.starts_with(&canonical_root) {
        return Err(format!(
            "Audio resource path escapes its directory: {relative}"
        ));
    }
    fs::read(full).map_err(|e| format!("Could not read audio resource {relative}: {e}"))
}

fn verified(root: &Path, path: &str, hash: &str, size: Option<u64>) -> Result<Vec<u8>, String> {
    let bytes = read_confined(root, path)?;
    if hash.len() != 64
        || format!("{:x}", Sha256::digest(&bytes)) != hash
        || size.is_some_and(|n| n != bytes.len() as u64)
    {
        return Err(format!(
            "Audio resource hash mismatch: {path}; run npm run prepare:audio"
        ));
    }
    Ok(bytes)
}

impl AudioResources {
    /// Fully load and validate resources before installing a prepared renderer.
    pub fn load(root: &Path) -> Result<Self, String> {
        Self::load_inner(root, None)
    }

    /// Select and decode on a preparation worker. The complete recorded library
    /// remains bundled, while the renderer receives only regions with loaded PCM.
    pub fn load_for_requests(root: &Path, requests: &[SampleRequest]) -> Result<Self, String> {
        Self::load_inner(root, Some(requests))
    }

    fn load_inner(root: &Path, requests: Option<&[SampleRequest]>) -> Result<Self, String> {
        let mut manifest: InstrumentManifest =
            serde_json::from_slice(&read_confined(root, "manifest.json")?)
                .map_err(|e| format!("Invalid audio manifest: {e}"))?;
        if manifest.schema_version != 1 {
            return Err("Unsupported audio manifest version".into());
        }
        if let Some(requests) = requests {
            let mut selected = HashSet::new();
            let mut requested_instruments = HashSet::new();
            for request in requests {
                if request.key > 127 || request.velocity == 0 || request.velocity > 127 {
                    return Err("Invalid recorded sample request".into());
                }
                let instrument = manifest
                    .instruments
                    .iter()
                    .find(|i| i.id == request.instrument_id)
                    .ok_or_else(|| {
                        format!("Unknown recorded instrument {}", request.instrument_id)
                    })?;
                requested_instruments.insert(instrument.id.clone());
                let attacks = eligible_regions(
                    instrument,
                    request.key,
                    request.velocity,
                    &request.articulation,
                    "attack",
                );
                if attacks.is_empty() {
                    return Err(format!("No recorded attacks for {}", instrument.id));
                }
                selected.extend(attacks.into_iter().map(|r| r.sample_id.clone()));
                selected.extend(
                    eligible_regions(
                        instrument,
                        request.key,
                        request.velocity,
                        "release",
                        "release",
                    )
                    .into_iter()
                    .map(|r| r.sample_id.clone()),
                );
                if request.articulation == "feedback" {
                    selected.extend(
                        eligible_regions(
                            instrument,
                            request.key,
                            request.velocity,
                            "picked",
                            "attack",
                        )
                        .into_iter()
                        .map(|r| r.sample_id.clone()),
                    );
                }
            }
            manifest
                .instruments
                .retain(|i| requested_instruments.contains(&i.id));
            for instrument in &mut manifest.instruments {
                instrument
                    .regions
                    .retain(|r| selected.contains(&r.sample_id));
            }
            manifest.samples.retain(|s| selected.contains(&s.id));
        }
        let mut sources = HashSet::new();
        for source in &manifest.sources {
            // A repository source is pinned by its 40-digit commit, an archive by its SHA-256.
            if !sources.insert(&source.id)
                || !matches!(source.license.as_str(), "CC0-1.0" | "CC-BY-3.0")
                || !matches!(source.revision.len(), 40 | 64)
                || !source.revision.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Invalid recorded audio provenance".into());
            }
            verified(root, &source.license_path, &source.license_sha256, None)?;
        }
        let mut samples = HashMap::new();
        for asset in &manifest.samples {
            if samples.contains_key(&asset.id) {
                return Err(format!("Duplicate audio sample {}", asset.id));
            }
            let bytes = verified(root, &asset.path, &asset.sha256, Some(asset.size))?;
            let decoded = decode_audio(
                &bytes,
                Path::new(&asset.path).extension().and_then(|e| e.to_str()),
            )
            .map_err(|e| format!("{}: {e}", asset.path))?;
            samples.insert(asset.id.clone(), Arc::new(decoded));
        }
        let mut instruments = HashSet::new();
        for instrument in &manifest.instruments {
            if !instruments.insert(&instrument.id)
                || !sources.contains(&instrument.source_id)
                || instrument.regions.is_empty()
            {
                return Err("Invalid recorded instrument identity".into());
            }
            for region in &instrument.regions {
                let sample = samples
                    .get(&region.sample_id)
                    .ok_or_else(|| format!("Missing region sample {}", region.sample_id))?;
                if region.root_key > 127
                    || region.key_high > 127
                    || region.key_low > region.key_high
                    || region.velocity_high > 127
                    || region.velocity_low > region.velocity_high
                    || region.variant == 0
                    || region.sequence_length == 0
                    || region.variant > region.sequence_length
                    || region.velocity_gain_high == 0
                    || ![
                        region.attack_seconds,
                        region.release_seconds,
                        region.gain_db,
                        region.pitch_keytrack,
                        region.release_decay_db_per_second,
                    ]
                    .iter()
                    .all(|v| v.is_finite())
                    || region.attack_seconds < 0.0
                    || region.release_seconds < 0.0
                    || region.release_decay_db_per_second < 0.0
                    || !matches!(region.trigger.as_str(), "attack" | "release")
                    || !matches!(
                        region.articulation.as_str(),
                        "picked"
                            | "fingered"
                            | "staccato"
                            | "legato"
                            | "release"
                            | "feedback"
                            | "ghost"
                            | "dead"
                            | "slap"
                            | "pop"
                    )
                {
                    return Err(format!(
                        "Invalid recorded sample region in {}",
                        instrument.id
                    ));
                }
                match (region.loop_start, region.loop_end) {
                    (None, None) => {}
                    (Some(start), Some(end))
                        if start < end && end <= sample.frames.len() as u64 => {}
                    _ => return Err(format!("Invalid audio loop in {}", instrument.id)),
                }
            }
        }
        let font = &manifest.sound_font;
        let bytes = verified(root, &font.path, &font.sha256, Some(font.size))?;
        let sound_font = Arc::new(
            SoundFont::new(&mut Cursor::new(bytes))
                .map_err(|e| format!("Could not load the GM SoundFont: {e}"))?,
        );
        Ok(Self {
            manifest,
            samples,
            sound_font,
        })
    }
}
