use super::decode::{DecodedAudio, decode_audio};
use super::kit_processing::{KitProcessing, process_hit};
use super::voices::RECORDED_KIT;
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
    /// The sample id of a second microphone's recording of the same performance, which the instrument's kit processing mixes into
    /// this one once at load. It is a recording of the manifest, not a region of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub companion_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub id: String,
    pub name: String,
    pub source_id: String,
    pub regions: Vec<Region>,
    /// How the instrument's recorded hits are shaped when they are loaded (see `kit_processing`), as written in the manifest and read
    /// by `kit_processing()`; None plays them as recorded. Kept as plain data so a bad table costs the kit and not the manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing: Option<serde_json::Value>,
}

impl Instrument {
    /// The instrument's kit processing table, read and checked; None when it plays as recorded.
    pub fn kit_processing(&self) -> Result<Option<KitProcessing>, String> {
        let Some(value) = &self.processing else {
            return Ok(None);
        };
        let table: KitProcessing = serde_json::from_value(value.clone())
            .map_err(|e| format!("invalid kit processing table: {e}"))?;
        table.validate()?;
        Ok(Some(table))
    }
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
    /// What the loader set aside, in words: an instrument whose kit data was refused, so its drum tracks play General MIDI instead.
    #[serde(skip)]
    pub notices: Vec<String>,
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
        // A kit whose processing data is refused is set aside whole, before any request narrows it: the document's other audio loads,
        // its drum tracks play General MIDI (the renderer's fall back for a missing kit), and the manifest says why.
        let mut notices = Vec::new();
        let mut tables = HashMap::new();
        let mut refused = Vec::new();
        for instrument in &manifest.instruments {
            match check_kit(&manifest, instrument) {
                Ok(Some(table)) => {
                    tables.insert(instrument.id.clone(), table);
                }
                Ok(None) => {}
                Err(error) => refused.push((instrument.id.clone(), error)),
            }
        }
        let mut set_aside_ids_now = HashSet::new();
        for (id, error) in refused {
            // Only the percussion kit has General MIDI to fall back to; any other instrument's bad data stays a failed load.
            if id != RECORDED_KIT {
                return Err(format!("{id}: {error}"));
            }
            notices.push(set_aside(&mut manifest, &id, &error));
            set_aside_ids_now.insert(id);
        }
        // Requests for an instrument set aside are dropped: its notes play General MIDI.
        let requests: Option<Vec<SampleRequest>> = requests.map(|requests| {
            requests
                .iter()
                .filter(|r| !set_aside_ids_now.contains(&r.instrument_id))
                .cloned()
                .collect()
        });
        if let Some(requests) = &requests {
            let mut selected = HashSet::new();
            let mut requested_instruments = HashSet::new();
            for request in requests.iter() {
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
                for region in attacks {
                    selected.insert(region.sample_id.clone());
                    selected.extend(region.companion_id.clone());
                }
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
        let mut shaped_failures = Vec::new();
        for instrument in &manifest.instruments {
            let Some(table) = tables.get(&instrument.id) else {
                continue;
            };
            match shape_kit(table, instrument, &samples) {
                Ok(shaped) => {
                    let own: HashSet<&str> = instrument
                        .regions
                        .iter()
                        .map(|r| r.sample_id.as_str())
                        .collect();
                    let companions: Vec<String> = instrument
                        .regions
                        .iter()
                        .filter_map(|r| r.companion_id.clone())
                        .filter(|c| !own.contains(c.as_str()))
                        .collect();
                    samples.extend(shaped);
                    for companion in companions {
                        samples.remove(&companion);
                    }
                }
                Err(error) => shaped_failures.push((instrument.id.clone(), error)),
            }
        }
        for (id, error) in shaped_failures {
            if id != RECORDED_KIT {
                return Err(format!("{id}: {error}"));
            }
            for sample in set_aside_ids(&mut manifest, &id) {
                samples.remove(&sample);
            }
            let notice = format!("{id}: {error}; its drum tracks play General MIDI");
            eprintln!("TabPlayer: {notice}");
            notices.push(notice);
        }
        manifest.notices = notices;
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

/// Takes an instrument out of the manifest, with the recordings no other instrument uses; returns those recordings' ids.
fn set_aside_ids(manifest: &mut InstrumentManifest, id: &str) -> Vec<String> {
    let Some(at) = manifest.instruments.iter().position(|i| i.id == id) else {
        return vec![];
    };
    let gone = manifest.instruments.remove(at);
    let kept: HashSet<&str> = manifest
        .instruments
        .iter()
        .flat_map(|i| i.regions.iter())
        .flat_map(|r| std::iter::once(r.sample_id.as_str()).chain(r.companion_id.as_deref()))
        .collect();
    let removed: Vec<String> = gone
        .regions
        .iter()
        .flat_map(|r| std::iter::once(r.sample_id.clone()).chain(r.companion_id.clone()))
        .filter(|s| !kept.contains(s.as_str()))
        .collect();
    manifest.samples.retain(|s| !removed.contains(&s.id));
    removed
}

/// `set_aside_ids` for an instrument refused before anything is decoded; returns the notice, which is also written to standard error.
fn set_aside(manifest: &mut InstrumentManifest, id: &str, error: &str) -> String {
    set_aside_ids(manifest, id);
    let notice = format!("{id}: {error}; its drum tracks play General MIDI");
    eprintln!("TabPlayer: {notice}");
    notice
}

/// Checks the kit data of one instrument as a whole, before any request narrows it, so a bad pair of regions is refused whatever is
/// asked for: its table (read, bounded); every sound the table names has a recording of its own and none lies in a key range;
/// every sound's profile and companion agree; no recording has two profiles or two companions; nothing the processing replaces is
/// looped or shared with another instrument; every named recording exists. Returns the table, or None for an instrument without.
fn check_kit(
    manifest: &InstrumentManifest,
    instrument: &Instrument,
) -> Result<Option<KitProcessing>, String> {
    let Some(table) = instrument.kit_processing()? else {
        if instrument.regions.iter().any(|r| r.companion_id.is_some()) {
            return Err("it names a companion recording but has no kit processing".into());
        }
        return Ok(None);
    };
    let known: HashSet<&str> = manifest.samples.iter().map(|s| s.id.as_str()).collect();
    let others: HashSet<&str> = manifest
        .instruments
        .iter()
        .filter(|o| o.id != instrument.id)
        .flat_map(|o| o.regions.iter())
        .flat_map(|r| std::iter::once(r.sample_id.as_str()).chain(r.companion_id.as_deref()))
        .collect();
    let own: HashSet<&str> = instrument
        .regions
        .iter()
        .map(|r| r.sample_id.as_str())
        .collect();
    let keys: Vec<u8> = table.sounds.keys().filter_map(|k| k.parse().ok()).collect();
    let mut shaping: HashMap<&str, (Option<&str>, Option<&str>)> = HashMap::new();
    let mut served: HashMap<&str, &str> = HashMap::new();
    let mut recorded: HashSet<String> = HashSet::new();
    for region in &instrument.regions {
        let single = region.key_low == region.key_high;
        if !single
            && keys
                .iter()
                .any(|k| (region.key_low..=region.key_high).contains(k))
        {
            return Err(format!(
                "a kit sound named in the processing table lies in the key range of {}",
                region.sample_id
            ));
        }
        let key = region.key_low.to_string();
        let profile = single
            .then(|| table.sounds.get(&key))
            .flatten()
            .map(String::as_str);
        if profile.is_some() {
            recorded.insert(key);
        }
        let wants = profile.is_some_and(|p| table.profiles[p].companion.is_some());
        if wants != region.companion_id.is_some() {
            return Err("a kit sound's companion recording and its profile disagree".into());
        }
        if profile.is_some() && (region.loop_start.is_some() || region.loop_end.is_some()) {
            return Err(format!(
                "{} is looped, which processing would invalidate",
                region.sample_id
            ));
        }
        if profile.is_some() {
            for used in std::iter::once(&region.sample_id).chain(region.companion_id.as_ref()) {
                if !known.contains(used.as_str()) {
                    return Err(format!("Missing recording {used}"));
                }
                if others.contains(used.as_str()) {
                    return Err(format!(
                        "{used} is also used by another instrument, and processing would change it for both"
                    ));
                }
            }
        }
        if let Some(companion) = &region.companion_id {
            if own.contains(companion.as_str()) {
                return Err(format!("{companion} is a companion and a hit of its own"));
            }
            if served
                .insert(companion.as_str(), region.sample_id.as_str())
                .is_some_and(|other| other != region.sample_id)
            {
                return Err("a companion recording serves two hits".into());
            }
        }
        match shaping.insert(
            region.sample_id.as_str(),
            (profile, region.companion_id.as_deref()),
        ) {
            Some((earlier, _)) if earlier != profile => {
                return Err(format!(
                    "kit sounds shaped differently share the recording {}",
                    region.sample_id
                ));
            }
            Some((_, earlier)) if earlier != region.companion_id.as_deref() => {
                return Err(format!(
                    "the recording {} has two different companions",
                    region.sample_id
                ));
            }
            _ => {}
        }
    }
    if let Some(missing) = table.sounds.keys().find(|k| !recorded.contains(*k)) {
        return Err(format!(
            "the processing table names kit sound {missing}, which has no recording"
        ));
    }
    Ok(Some(table))
}

/// Shapes each recorded hit of a checked kit, once, on the thread that loads it, and returns the processed recording of each hit.
/// Nothing is replaced here: the caller does that only when every hit succeeded.
fn shape_kit(
    table: &KitProcessing,
    instrument: &Instrument,
    samples: &HashMap<String, Arc<DecodedAudio>>,
) -> Result<HashMap<String, Arc<DecodedAudio>>, String> {
    let mut shaped: HashMap<String, Arc<DecodedAudio>> = HashMap::new();
    for region in &instrument.regions {
        let Some(name) = (region.key_low == region.key_high)
            .then(|| table.sounds.get(&region.key_low.to_string()))
            .flatten()
        else {
            continue;
        };
        if shaped.contains_key(&region.sample_id) {
            continue;
        }
        let main = samples
            .get(&region.sample_id)
            .ok_or_else(|| format!("Missing region sample {}", region.sample_id))?;
        let companion = region
            .companion_id
            .as_ref()
            .map(|id| {
                samples
                    .get(id)
                    .ok_or_else(|| format!("Missing companion recording {id}"))
            })
            .transpose()?;
        let result = process_hit(&table.profiles[name], main, companion.map(|c| &**c))
            .map_err(|e| format!("{}: {e}", region.sample_id))?;
        shaped.insert(region.sample_id.clone(), Arc::new(result));
    }
    Ok(shaped)
}
