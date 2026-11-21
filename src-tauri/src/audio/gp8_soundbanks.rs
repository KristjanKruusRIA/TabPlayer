use super::decode::{DecodedAudio, decode_audio};
use super::resources::{Instrument, Region, SampleRequest, eligible_regions};
use crate::app_settings::SoundbankSettings;
use crate::settings::valid_gp8_set_id;
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

const MAX_META_BYTES: u64 = 16 * 1024;
const MAX_SET_FILES: usize = 1024;
const MAX_SET_JSON_BYTES: u64 = 64 * 1024;
const MAX_BANK_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 16_384;
const MAX_TABLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_XML_BYTES: usize = 2 * 1024 * 1024;
const MAX_XML_DEPTH: usize = 32;
const MAX_SAMPLES_PER_BANK: usize = 16_384;
const MAX_WAVES_PER_BANK: usize = 32_768;
const MAX_PCM_CACHE_BYTES: usize = 256 * 1024 * 1024;

const AMARCHIVE_MAGIC: &[u8; 9] = b"AMARCHIVE";
const AMARCHIVE_HEADER_SIZE: usize = 25;
const MAX_ARCHIVE_ENTRY_NAME_LEN: usize = 512;

const LEGACY_VOICE_MAPPING: [(&str, &str); 4] = [
    ("green-guitar", "Strat-Guitar"),
    ("black-guitar", "Metal-Guitar"),
    ("darkblack-bass", "Jazz-Bass"),
    ("babyblue-bass", "Pre-Bass"),
];

const STANDARD_SET_DIR_NAME: &str = "com.arobas-music.soundbank.standard";

const AUXILIARY_PERCUSSION_FALLBACK: [(&str, &str, &[u8], (u32, u32)); 25] = [
    ("RelaxedHandClap-Percu", "", &[39], (0, 0)),
    ("Tambourine-Percu", "", &[54], (0, 0)),
    ("Vibraslap-Percu", "", &[58], (0, 0)),
    ("BongoHigh-Percu", "", &[60], (0, 0)),
    ("BongoLow-Percu", "", &[61], (0, 0)),
    ("CongaHigh-Percu", "mute", &[62], (2, 2)),
    ("CongaHigh-Percu", "hit", &[63], (2, 2)),
    ("CongaLow-Percu", "", &[64], (2, 2)),
    ("TimbaleHigh-Percu", "", &[65], (0, 0)),
    ("TimbaleLow-Percu", "", &[66], (0, 0)),
    ("AgogoHigh-Percu", "", &[67], (0, 0)),
    ("AgogoLow-Percu", "", &[68], (0, 0)),
    ("Cabasa-Percu", "", &[69], (0, 0)),
    ("Maracas-Percu", "", &[70], (0, 0)),
    ("WhistleLow-Percu", "", &[71], (4, 4)),
    ("WhistleHigh-Percu", "", &[72], (4, 4)),
    ("Guiro-Percu", "hit", &[73], (0, 0)),
    ("Guiro-Percu", "return", &[74], (0, 0)),
    ("Claves-Percu", "", &[75], (0, 0)),
    ("WoodblockHigh-Percu", "", &[76], (0, 0)),
    ("WoodblockLow-Percu", "", &[77], (0, 0)),
    ("Cuica-Percu", "mute", &[78], (5, 5)),
    ("Cuica-Percu", "hit", &[79], (5, 5)),
    ("Triangle-Percu", "mute", &[80], (3, 3)),
    ("Triangle-Percu", "hit", &[81], (3, 3)),
];

const AUXILIARY_PERCUSSION_EXTRA: [(&str, &str, &[u8], (u32, u32)); 6] = [
    ("ShakerStudio-Percu", "", &[82], (0, 0)),
    ("JingleBell-Percu", "", &[83], (0, 0)),
    ("BellTree-Percu", "", &[84], (0, 0)),
    ("Castanets-Percu", "", &[85], (0, 0)),
    ("Surdo-Percu", "mute", &[86], (6, 6)),
    ("Surdo-Percu", "hit", &[87], (6, 6)),
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gp8SetInfo {
    pub id: String,
    pub name: String,
    pub instrument_set: String,
    pub category: String,
    pub pickups: Vec<String>,
    pub is_percussion: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gp8Status {
    pub enabled: bool,
    pub available: bool,
    pub configured_path: Option<String>,
    pub resolved_path: Option<String>,
    pub detected_default_path: Option<String>,
    pub version: Option<String>,
    pub set_count: usize,
    pub error: Option<String>,
    pub sets: Vec<Gp8SetInfo>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSetFile {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    instrument_set: String,
    #[serde(default)]
    soundbanks: Vec<RawSetBankRef>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSetBankRef {
    element: String,
    soundbank: String,
}

#[derive(Clone, Debug)]
struct SetDefinition {
    info: Gp8SetInfo,
    soundbanks: Vec<RawSetBankRef>,
}

#[derive(Clone, Debug)]
struct ArchiveEntry {
    offset: u64,
    size: u32,
}

#[derive(Clone, Debug)]
struct ArchiveIndex {
    entries: HashMap<String, ArchiveEntry>,
}

#[derive(Clone, Debug)]
struct ParsedWave {
    pickup: String,
    file: String,
    repitch: f64,
    gain_db: f64,
}

#[derive(Clone, Debug)]
struct ParsedSample {
    path: String,
    midi: i16,
    string: i16,
    dynamic: String,
    option: String,
    waves: Vec<ParsedWave>,
}

#[derive(Clone, Debug)]
struct ParsedBank {
    bank_type: String,
    samples: Vec<ParsedSample>,
    pickups: Vec<String>,
}

#[derive(Default)]
struct PcmCache {
    entries: HashMap<(String, String), (Arc<DecodedAudio>, usize)>,
    order: VecDeque<(String, String)>,
    total_bytes: usize,
}

impl PcmCache {
    fn get(&self, key: &(String, String)) -> Option<Arc<DecodedAudio>> {
        self.entries.get(key).map(|(audio, _)| audio.clone())
    }

    fn insert(&mut self, key: (String, String), audio: Arc<DecodedAudio>) {
        let bytes = audio
            .frames
            .len()
            .saturating_mul(std::mem::size_of::<[f32; 2]>());
        if bytes > MAX_PCM_CACHE_BYTES {
            return;
        }
        if let Some((_, prev_bytes)) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(prev_bytes);
        }
        while self.total_bytes.saturating_add(bytes) > MAX_PCM_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, removed_bytes)) = self.entries.remove(&oldest) {
                self.total_bytes = self.total_bytes.saturating_sub(removed_bytes);
            }
        }
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.order.push_back(key.clone());
        self.entries.insert(key, (audio, bytes));
    }
}

struct Catalog {
    root: PathBuf,
    version: Option<String>,
    sets_list: Vec<SetDefinition>,
    sets_by_id: HashMap<String, usize>,
    available_banks: HashSet<String>,
    parsed_banks: HashMap<String, ParsedBank>,
    pcm_cache: PcmCache,
}

struct Gp8State {
    settings: SoundbankSettings,
    detected_default: Option<PathBuf>,
    resolved_path: Option<PathBuf>,
    error: Option<String>,
    catalog: Option<Catalog>,
}

impl Default for Gp8State {
    fn default() -> Self {
        Self {
            settings: SoundbankSettings {
                enabled: false,
                path: None,
            },
            detected_default: None,
            resolved_path: None,
            error: None,
            catalog: None,
        }
    }
}

static GLOBAL_STATE: OnceLock<Mutex<Gp8State>> = OnceLock::new();
static EPOCH: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static THREAD_OVERRIDE: RefCell<Option<Gp8State>> = const { RefCell::new(None) };
    static THREAD_EPOCH: Cell<u64> = const { Cell::new(0) };
}

fn global_state() -> &'static Mutex<Gp8State> {
    GLOBAL_STATE.get_or_init(|| Mutex::new(Gp8State::default()))
}

fn bump_epoch() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

fn bump_thread_epoch() {
    THREAD_EPOCH.with(|c| c.set(c.get().wrapping_add(1)));
}

pub fn epoch() -> u64 {
    EPOCH
        .load(Ordering::SeqCst)
        .wrapping_add(THREAD_EPOCH.with(|c| c.get()))
}

pub struct ScopedOverride {
    previous: Option<Gp8State>,
}

impl Drop for ScopedOverride {
    fn drop(&mut self) {
        THREAD_OVERRIDE.with(|cell| {
            *cell.borrow_mut() = self.previous.take();
        });
        bump_thread_epoch();
    }
}

/// Replaces GP8 configuration only for the current thread until the guard drops, so parallel
/// tests never collide on global soundbank state.
pub fn scoped_override(settings: SoundbankSettings) -> ScopedOverride {
    let state = build_state(settings);
    let previous = THREAD_OVERRIDE.with(|cell| cell.borrow_mut().replace(state));
    bump_thread_epoch();
    ScopedOverride { previous }
}

fn with_state<R>(f: impl FnOnce(&mut Gp8State) -> R) -> R {
    THREAD_OVERRIDE.with(|cell| {
        let mut borrowed = cell.borrow_mut();
        if let Some(state) = borrowed.as_mut() {
            return f(state);
        }
        drop(borrowed);
        let mut guard = global_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut guard)
    })
}

pub fn configure(settings: SoundbankSettings) -> Gp8Status {
    let next = build_state(settings);
    let status = status_of(&next);
    let mut guard = global_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = next;
    drop(guard);
    bump_epoch();
    status
}

pub fn status() -> Gp8Status {
    with_state(|state| status_of(state))
}

pub fn is_available() -> bool {
    with_state(|state| state.catalog.is_some())
}

pub fn has_set(set_id: &str) -> bool {
    with_state(|state| {
        state
            .catalog
            .as_ref()
            .is_some_and(|cat| cat.sets_by_id.contains_key(set_id))
    })
}

pub fn is_percussion_instrument_id(id: &str) -> bool {
    let Some((set_id, _)) = parse_runtime_id(id) else {
        return false;
    };
    with_state(|state| {
        state.catalog.as_ref().is_some_and(|cat| {
            cat.sets_by_id
                .get(set_id)
                .is_some_and(|&idx| cat.sets_list[idx].info.is_percussion)
        })
    })
}

pub fn legacy_voice_to_gp8(legacy_id: &str) -> Option<String> {
    let (_, mapped) = LEGACY_VOICE_MAPPING
        .iter()
        .find(|&&(id, _)| id == legacy_id)?;
    with_state(|state| {
        let cat = state.catalog.as_ref()?;
        cat.sets_by_id
            .contains_key(*mapped)
            .then(|| format!("gp8:{mapped}"))
    })
}

pub fn default_set_for_program(
    program: u8,
    percussion: bool,
    drum_kit: Option<u8>,
) -> Option<String> {
    with_state(|state| {
        let cat = state.catalog.as_ref()?;
        let pick = |candidates: &[&str]| -> Option<String> {
            candidates
                .iter()
                .find(|id| cat.sets_by_id.contains_key(**id))
                .map(|id| (*id).to_owned())
        };
        if percussion {
            return match drum_kit {
                Some(8) => pick(&["Drumkit-Oak", "Drumkit-Master", "Drumkit-Custom"]),
                Some(32) => pick(&["Drumkit-Vintage", "Drumkit-Star", "Drumkit-Custom"]),
                Some(40) => pick(&["Drumkit-Vintage", "Drumkit-Custom"]),
                _ => pick(&["Drumkit-Custom", "Drumkit-Master"]),
            };
        }
        let candidates: &[&str] = match program {
            0 => &["German-APiano", "Eastern-APiano"],
            1 => &["Eastern-APiano", "German-APiano"],
            2 => &["CP-EPiano", "MarkI-EPiano"],
            3 => &["Upright-APiano", "German-APiano"],
            4 => &["MarkI-EPiano", "200A-EPiano"],
            5 => &["200A-EPiano", "MarkI-EPiano"],
            6 => &["Harpsichord-Key"],
            7 => &["AddClavinet-Key", "Harpsichord-Key"],
            8 => &["Celesta-Tuned"],
            9..=11 => &["Vibraphone-Tuned", "Celesta-Tuned"],
            12..=15 => &["Xylophone-Tuned", "Vibraphone-Tuned"],
            16 => &["Ballad-Organ", "Full-Organ"],
            17 => &["Jazz-Organ", "Full-Organ"],
            18 => &["Rock-Organ", "Full-Organ"],
            19..=20 => &["Full-Organ", "Ballad-Organ"],
            21 => &["Accordion", "Bandoneon"],
            22 => &["Harmonica"],
            23 => &["Bandoneon", "Accordion"],
            24 => &["Concerto-Nylon"],
            25 => &["D-Steel"],
            26 => &["Jazz-Guitar", "ES-Guitar", "L4-Guitar"],
            27 => &["Strat-Guitar", "Tele-Guitar"],
            28 => &["Strat-Guitar", "Tele-Guitar"],
            29 => &["Classic-Guitar", "Strat-Guitar"],
            30 => &["Metal-Guitar", "Classic-Guitar"],
            31 => &["Strat-Guitar"],
            32 => &["Acoustic-Bass"],
            33 => &["Jazz-Bass", "Pre-Bass"],
            34 => &["Pre-Bass", "Jazz-Bass"],
            35 => &["Fretless-Bass", "Jazz-Bass"],
            36 => &["Jazz-Bass", "Modern-Bass"],
            37 => &["Modern-Bass", "Jazz-Bass"],
            38 => &["FMSyn-Bass", "OB-Bass"],
            39 => &["OB-Bass", "FMSyn-Bass"],
            40 => &["Violin-Solo", "Violin1-Ensemble"],
            41 => &["Viola-Solo", "Violin1-Ensemble"],
            42 => &["Cello-Solo"],
            43 => &["Contrabass-Solo"],
            44 => &["Violin1-Ensemble"],
            45 => &["Violin1-Ensemble-Pizz", "Violin1-Ensemble"],
            46 => &["Harp-Solo"],
            47 => &["TimpaniLo-Tuned"],
            48..=49 => &["Violin1-Ensemble"],
            50..=51 => &["OBStrings-Pad", "SolinaString-Pad"],
            52..=53 => &["MetaChoir-Pad", "Vocal-Pad"],
            54 => &["Vocal-Pad", "MetaChoir-Pad"],
            55 => &["SolinaString-Pad", "OBStrings-Pad"],
            56 => &["Trumpet-Solo"],
            57 => &["Trombone-Solo"],
            58 => &["BassTuba-Solo"],
            59 => &["Trumpet-Sordino-Solo", "Trumpet-Solo"],
            60 => &["FrenchHorn-Solo"],
            61 => &["Trumpet-Ensemble", "Trumpet-Solo"],
            62 => &["Simple-Brass", "FM-Brass"],
            63 => &["FM-Brass", "Simple-Brass"],
            64 => &["Soprano-Sax", "Alto-Sax"],
            65 => &["Alto-Sax"],
            66 => &["Tenor-Sax"],
            67 => &["Baritone-Sax"],
            68 => &["Oboe-Solo"],
            69 => &["EnglishHorn-Solo"],
            70 => &["Bassoon-Solo"],
            71 => &["Clarinet-Solo"],
            72 => &["Piccolo-Solo", "Flute-Solo"],
            73 => &["Flute-Solo"],
            74..=79 => &["Recorder-Solo", "Flute-Solo"],
            80 => &["Classic-Lead"],
            81 => &["Dist-Lead", "Classic-Lead"],
            82..=83 => &["Brassy-Lead", "Classic-Lead"],
            84..=87 => &["Dave-Lead", "Classic-Lead"],
            88..=89 => &["Warm-Pad", "Lush-Pad"],
            90..=91 => &["MetaChoir-Pad", "Warm-Pad"],
            92..=95 => &["Lush-Pad", "OBStrings-Pad", "Warm-Pad"],
            96..=103 => &["Harpy-Seq", "Warm-Pad"],
            104 => &["Electric-Sitar"],
            105..=108 => &["5-Banjo"],
            109 => &["Bagpipe"],
            110 => &["Violin-Solo"],
            111 => &["Oboe-Solo"],
            112..=119 => &["Vibraphone-Tuned", "Celesta-Tuned"],
            _ => return None,
        };
        pick(candidates)
    })
}

pub fn parse_runtime_id(id: &str) -> Option<(&str, Option<&str>)> {
    let rest = id.strip_prefix("gp8:")?;
    if let Some((set_id, variant)) = rest.split_once('@') {
        if !valid_gp8_set_id(set_id) || !matches!(variant, "bridge" | "middle" | "neck" | "brush") {
            return None;
        }
        Some((set_id, Some(variant)))
    } else {
        valid_gp8_set_id(rest).then_some((rest, None))
    }
}

pub fn resolve_runtime_id(
    set_id: &str,
    pickup: Option<&str>,
    _percussion: bool,
    drum_kit: Option<u8>,
) -> Option<String> {
    with_state(|state| {
        let cat = state.catalog.as_ref()?;
        let &idx = cat.sets_by_id.get(set_id)?;
        let set = &cat.sets_list[idx];
        if set.info.is_percussion && drum_kit == Some(40) && !percussion_only_brushes_missing(set) {
            return Some(format!("gp8:{set_id}@brush"));
        }
        if !set.info.is_percussion && !set.info.pickups.is_empty() {
            if let Some(chosen) =
                pickup.filter(|p| set.info.pickups.iter().any(|avail| avail == *p))
            {
                return Some(format!("gp8:{set_id}@{chosen}"));
            }
        }
        Some(format!("gp8:{set_id}"))
    })
}

fn percussion_only_brushes_missing(set: &SetDefinition) -> bool {
    set.info.instrument_set != "drumKit"
}

pub fn load_instrument_for_requests(
    runtime_id: &str,
    requests: &[SampleRequest],
) -> Result<Option<(Instrument, HashMap<String, Arc<DecodedAudio>>)>, String> {
    let Some((set_id, variant)) = parse_runtime_id(runtime_id) else {
        return Err(format!("Invalid GP8 instrument identifier: {runtime_id}"));
    };
    with_state(|state| {
        let Some(catalog) = state.catalog.as_mut() else {
            return Ok(None);
        };
        let Some(&idx) = catalog.sets_by_id.get(set_id) else {
            return Ok(None);
        };
        let set = catalog.sets_list[idx].clone();
        let full_instrument = if set.info.is_percussion {
            build_percussion_instrument(catalog, runtime_id, &set, variant)?
        } else {
            build_pitched_instrument(catalog, runtime_id, &set, variant)?
        };
        if full_instrument.regions.is_empty() {
            return Ok(None);
        }

        let mut selected = HashSet::new();
        for request in requests.iter().filter(|r| r.instrument_id == runtime_id) {
            if request.key > 127 || request.velocity == 0 || request.velocity > 127 {
                return Err("Invalid GP8 sample request".into());
            }
            if set.info.is_percussion {
                for region in eligible_regions(
                    &full_instrument,
                    request.key,
                    request.velocity,
                    &request.articulation,
                    "attack",
                )
                .into_iter()
                .filter(|r| (r.key_low..=r.key_high).contains(&request.key))
                {
                    selected.insert(region.sample_id.clone());
                }
            } else {
                let attacks = eligible_regions(
                    &full_instrument,
                    request.key,
                    request.velocity,
                    &request.articulation,
                    "attack",
                );
                for region in attacks {
                    selected.insert(region.sample_id.clone());
                }
                if request.articulation == "feedback" {
                    for region in eligible_regions(
                        &full_instrument,
                        request.key,
                        request.velocity,
                        "picked",
                        "attack",
                    ) {
                        selected.insert(region.sample_id.clone());
                    }
                }
            }
        }
        if selected.is_empty() {
            return Ok(None);
        }

        let mut filtered = full_instrument;
        filtered.regions.retain(|r| selected.contains(&r.sample_id));
        let mut decoded = HashMap::new();
        for sample_id in selected {
            let Some((bank_name, file_name)) = sample_id
                .strip_prefix("gp8:")
                .and_then(|rest| rest.split_once(':'))
            else {
                continue;
            };
            let audio = load_decoded_entry(catalog, bank_name, file_name)?;
            decoded.insert(sample_id, audio);
        }
        Ok(Some((filtered, decoded)))
    })
}

fn status_of(state: &Gp8State) -> Gp8Status {
    Gp8Status {
        enabled: state.settings.enabled,
        available: state.catalog.is_some(),
        configured_path: state.settings.path.clone(),
        resolved_path: state
            .resolved_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        detected_default_path: state
            .detected_default
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        version: state.catalog.as_ref().and_then(|c| c.version.clone()),
        set_count: state.catalog.as_ref().map_or(0, |c| c.sets_list.len()),
        error: state.error.clone(),
        sets: state
            .catalog
            .as_ref()
            .map(|c| c.sets_list.iter().map(|s| s.info.clone()).collect())
            .unwrap_or_default(),
    }
}

pub fn default_soundbank_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let program_data =
            std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
        let path = PathBuf::from(program_data)
            .join("Arobas Music")
            .join("Soundbanks")
            .join(STANDARD_SET_DIR_NAME);
        return path.is_dir().then_some(path);
    }
    if cfg!(target_os = "macos") {
        let path = PathBuf::from("/Library/Application Support/Arobas Music/Soundbanks")
            .join(STANDARD_SET_DIR_NAME);
        return path.is_dir().then_some(path);
    }
    None
}

fn build_state(settings: SoundbankSettings) -> Gp8State {
    let detected_default = default_soundbank_dir();
    if !settings.enabled {
        return Gp8State {
            settings,
            detected_default,
            resolved_path: None,
            error: None,
            catalog: None,
        };
    }

    let candidate = settings
        .path
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| detected_default.clone());
    let Some(candidate_path) = candidate else {
        return Gp8State {
            settings,
            detected_default,
            resolved_path: None,
            error: None,
            catalog: None,
        };
    };

    let custom = settings.path.is_some();
    match resolve_and_scan_catalog(&candidate_path) {
        Ok(catalog) => {
            let resolved_path = Some(catalog.root.clone());
            Gp8State {
                settings,
                detected_default,
                resolved_path,
                error: None,
                catalog: Some(catalog),
            }
        }
        Err(err) => {
            let error = if custom || candidate_path.exists() {
                Some(err)
            } else {
                None
            };
            Gp8State {
                settings,
                detected_default,
                resolved_path: None,
                error,
                catalog: None,
            }
        }
    }
}

fn resolve_soundbank_root(candidate: &Path) -> Result<PathBuf, String> {
    if candidate.as_os_str().is_empty() {
        return Err("Soundbank path is empty.".into());
    }
    let resolved_candidate = if candidate.join("sets").is_dir() && candidate.join("banks").is_dir()
    {
        candidate.to_path_buf()
    } else if candidate.join(STANDARD_SET_DIR_NAME).join("sets").is_dir()
        && candidate.join(STANDARD_SET_DIR_NAME).join("banks").is_dir()
    {
        candidate.join(STANDARD_SET_DIR_NAME)
    } else {
        return Err(
            "Selected folder does not contain a GP8 soundbank (sets/ and banks/ were not found)."
                .into(),
        );
    };
    let canonical = std::fs::canonicalize(&resolved_candidate)
        .map_err(|e| format!("Cannot open soundbank folder: {e}"))?;
    let sets_canon = std::fs::canonicalize(canonical.join("sets"))
        .map_err(|e| format!("Cannot open soundbank sets/: {e}"))?;
    let banks_canon = std::fs::canonicalize(canonical.join("banks"))
        .map_err(|e| format!("Cannot open soundbank banks/: {e}"))?;
    if !sets_canon.starts_with(&canonical) || !banks_canon.starts_with(&canonical) {
        return Err("Soundbank subfolders must remain inside the soundbank root.".into());
    }
    Ok(canonical)
}

fn read_confined_bytes(root: &Path, rel: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!(
            "Refusing non-relative soundbank path: {}",
            rel.display()
        ));
    }
    let joined = root.join(rel);
    let canonical = std::fs::canonicalize(&joined)
        .map_err(|e| format!("Cannot open {}: {e}", rel.display()))?;
    if !canonical.starts_with(root) {
        return Err(format!("Soundbank path escapes root: {}", rel.display()));
    }
    let file = open_regular_file(&canonical)?;
    let len = file
        .metadata()
        .map_err(|e| format!("Cannot stat {}: {e}", rel.display()))?
        .len();
    if len > max_bytes {
        return Err(format!(
            "Soundbank file {} exceeds {} byte limit",
            rel.display(),
            max_bytes
        ));
    }
    let mut buf = Vec::with_capacity(len as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Cannot read {}: {e}", rel.display()))?;
    if buf.len() as u64 > max_bytes {
        return Err(format!("Soundbank file {} exceeds size cap", rel.display()));
    }
    Ok(buf)
}

fn open_regular_file(path: &Path) -> Result<File, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        const NON_BLOCKING: i32 = 0o4000;
        #[cfg(not(target_os = "linux"))]
        const NON_BLOCKING: i32 = 0x4;
        opts.custom_flags(NON_BLOCKING);
    }
    let file = opts
        .open(path)
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Cannot inspect {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    Ok(file)
}

fn resolve_and_scan_catalog(candidate: &Path) -> Result<Catalog, String> {
    let root = resolve_soundbank_root(candidate)?;
    let version = read_meta_version(&root);

    let mut available_banks = HashSet::new();
    let banks_dir = std::fs::read_dir(root.join("banks"))
        .map_err(|e| format!("Cannot list soundbank banks/: {e}"))?;
    for entry in banks_dir {
        let entry = entry.map_err(|e| format!("Cannot inspect banks/ entry: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("gp7bank") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if valid_gp8_set_id(stem) {
                available_banks.insert(stem.to_owned());
            }
        }
    }

    let sets_dir = std::fs::read_dir(root.join("sets"))
        .map_err(|e| format!("Cannot list soundbank sets/: {e}"))?;
    let mut sets_list = Vec::new();
    for entry in sets_dir {
        if sets_list.len() >= MAX_SET_FILES {
            return Err("Too many soundbank set files".into());
        }
        let entry = entry.map_err(|e| format!("Cannot inspect sets/ entry: {e}"))?;
        let file_name = entry.file_name();
        let Some(name_str) = file_name.to_str() else {
            continue;
        };
        if !name_str.ends_with(".json") {
            continue;
        }
        let rel = Path::new("sets").join(name_str);
        let bytes = read_confined_bytes(&root, &rel, MAX_SET_JSON_BYTES)?;
        let parsed: RawSetFile = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid soundbank set {}: {e}", name_str))?;
        let _ = &parsed.description;
        if !valid_gp8_set_id(&parsed.id) || parsed.name.trim().is_empty() {
            return Err(format!("Invalid soundbank set identity in {}", name_str));
        }
        if parsed.soundbanks.is_empty()
            || !parsed
                .soundbanks
                .iter()
                .all(|b| valid_gp8_set_id(&b.soundbank) && available_banks.contains(&b.soundbank))
        {
            continue;
        }
        let (category, is_percussion) = classify_instrument_set(&parsed.instrument_set);
        sets_list.push(SetDefinition {
            info: Gp8SetInfo {
                id: parsed.id,
                name: parsed.name,
                instrument_set: parsed.instrument_set,
                category: category.to_owned(),
                pickups: Vec::new(),
                is_percussion,
            },
            soundbanks: parsed.soundbanks,
        });
    }
    sets_list.sort_by(|a, b| {
        a.info
            .name
            .cmp(&b.info.name)
            .then(a.info.id.cmp(&b.info.id))
    });
    if sets_list.is_empty() {
        return Err("No valid GP8 soundbank sets were found in the selected folder.".into());
    }

    let mut sets_by_id = HashMap::with_capacity(sets_list.len());
    for (idx, set) in sets_list.iter().enumerate() {
        sets_by_id.insert(set.info.id.clone(), idx);
    }

    let mut catalog = Catalog {
        root,
        version,
        sets_list,
        sets_by_id,
        available_banks,
        parsed_banks: HashMap::new(),
        pcm_cache: PcmCache::default(),
    };

    // Eagerly scan only electric guitars/basses (~25 banks) so pickup options appear in the UI immediately.
    let pickup_banks: Vec<(usize, String)> = catalog
        .sets_list
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            matches!(
                s.info.instrument_set.as_str(),
                "electricGuitar" | "electricBass" | "fretlessBass"
            )
        })
        .filter_map(|(idx, s)| s.soundbanks.first().map(|b| (idx, b.soundbank.clone())))
        .collect();
    for (idx, bank_name) in pickup_banks {
        if let Ok(bank) = get_or_parse_bank(&mut catalog, &bank_name) {
            catalog.sets_list[idx].info.pickups = bank.pickups.clone();
        }
    }

    Ok(catalog)
}

fn read_meta_version(root: &Path) -> Option<String> {
    let bytes = read_confined_bytes(root, Path::new("META"), MAX_META_BYTES).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    for line in text.lines() {
        if let Some(version) = line.strip_prefix("Version=") {
            let trimmed = version.trim();
            if !trimmed.is_empty() && trimmed.len() <= 64 && !trimmed.chars().any(char::is_control)
            {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

fn classify_instrument_set(instrument_set: &str) -> (&'static str, bool) {
    match instrument_set {
        "nylonGuitar" | "steelGuitar" | "electricGuitar" | "resonatorGuitar" | "ukulele"
        | "banjo" | "mandolin" | "sitar" | "electricSitar" | "bagpipe" | "folk" => {
            ("guitars", false)
        }
        "acousticBass" | "electricBass" | "fretlessBass" | "uprightBass" | "bassSynthesizer"
        | "synthBass" => ("basses", false),
        "drumKit" => ("drums", true),
        "acousticPiano" | "electricPiano" | "electricOrgan" | "harpsichord" | "clavinet"
        | "celesta" | "vibraphone" | "marimba" | "xylophone" | "glockenspiel" | "accordion"
        | "bandoneon" | "harmonica" | "tuned" => ("keys", false),
        "violin" | "viola" | "cello" | "contrabass" | "harp" | "strings" | "stringEnsemble"
        | "orchestral" | "mellotron" => ("strings", false),
        "trumpet" | "trombone" | "tuba" | "frenchHorn" | "flugelHorn" | "brass" | "saxophone"
        | "oboe" | "englishHorn" | "bassoon" | "contrabassoon" | "clarinet" | "piccolo"
        | "flute" | "recorder" => ("winds", false),
        "leadSynthesizer" | "padSynthesizer" | "brassSynthesizer" | "keySynthesizer"
        | "seqSynthesizer" | "choir" | "synth" => ("synths", false),
        "africaKit" | "latinoKit" | "sambaKit" | "bongos" | "congas" | "bongosNCongas"
        | "timbales" | "agogos" | "whistles" | "woodblocks" | "maracas" | "agogo" | "bellTree"
        | "bongo" | "cabasa" | "castanets" | "china" | "claves" | "conga" | "cowbell" | "crash"
        | "cuica" | "cymbal" | "grancassa" | "guiro" | "handClap" | "hiHat" | "jingleBell"
        | "kickDrum" | "maraca" | "piatti" | "ride" | "shaker" | "snare" | "splash" | "surdo"
        | "tambourine" | "timbale" | "tom" | "triangle" | "unpitched" | "vibraslap" | "whistle"
        | "woodblock" => ("percussion", true),
        _ if instrument_set.ends_with("Kit") || instrument_set.ends_with("Percu") => {
            ("percussion", true)
        }
        _ if instrument_set.contains("Guitar") || instrument_set.ends_with("Guitar") => {
            ("guitars", false)
        }
        _ if instrument_set.contains("Bass") || instrument_set.ends_with("Bass") => {
            ("basses", false)
        }
        _ => ("other", false),
    }
}

fn open_bank_archive(root: &Path, bank_name: &str) -> Result<(File, ArchiveIndex), String> {
    if !valid_gp8_set_id(bank_name) {
        return Err(format!("Invalid bank name: {bank_name}"));
    }
    let rel = Path::new("banks").join(format!("{bank_name}.gp7bank"));
    let canonical = std::fs::canonicalize(root.join(&rel))
        .map_err(|e| format!("Cannot open bank {bank_name}: {e}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("Bank path escapes root: {bank_name}"));
    }
    let mut file = open_regular_file(&canonical)?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("Cannot stat bank {bank_name}: {e}"))?
        .len();
    if file_len < AMARCHIVE_HEADER_SIZE as u64 || file_len > MAX_BANK_BYTES {
        return Err(format!("Invalid bank size for {bank_name}"));
    }

    let mut header = [0u8; AMARCHIVE_HEADER_SIZE];
    file.read_exact(&mut header)
        .map_err(|e| format!("Cannot read bank header for {bank_name}: {e}"))?;
    if &header[0..9] != AMARCHIVE_MAGIC {
        return Err(format!("Invalid AMARCHIVE magic in {bank_name}"));
    }
    let version = u32::from_le_bytes(header[9..13].try_into().unwrap());
    if version != 1 {
        return Err(format!(
            "Unsupported AMARCHIVE version {version} in {bank_name}"
        ));
    }
    let entry_count = u32::from_le_bytes(header[13..17].try_into().unwrap()) as usize;
    let table_size = u32::from_le_bytes(header[17..21].try_into().unwrap()) as usize;
    let table_offset = u32::from_le_bytes(header[21..25].try_into().unwrap()) as u64;
    if entry_count > MAX_ARCHIVE_ENTRIES
        || table_size > MAX_TABLE_BYTES
        || table_offset < AMARCHIVE_HEADER_SIZE as u64
        || table_offset
            .checked_add(table_size as u64)
            .is_none_or(|end| end > file_len)
    {
        return Err(format!("Invalid AMARCHIVE table bounds in {bank_name}"));
    }

    file.seek(SeekFrom::Start(table_offset))
        .map_err(|e| format!("Cannot seek archive table in {bank_name}: {e}"))?;
    let mut table = vec![0u8; table_size];
    file.read_exact(&mut table)
        .map_err(|e| format!("Cannot read archive table in {bank_name}: {e}"))?;

    let mut entries = HashMap::with_capacity(entry_count);
    let mut cursor = 0usize;
    for _ in 0..entry_count {
        if cursor + 12 >= table.len() {
            return Err(format!("Truncated AMARCHIVE table in {bank_name}"));
        }
        let offset = u64::from_le_bytes(table[cursor..cursor + 8].try_into().unwrap());
        let size = u32::from_le_bytes(table[cursor + 8..cursor + 12].try_into().unwrap());
        cursor += 12;
        let Some(nul_rel) = table[cursor..].iter().position(|&b| b == 0) else {
            return Err(format!("Unterminated entry name in {bank_name}"));
        };
        if nul_rel == 0 || nul_rel > MAX_ARCHIVE_ENTRY_NAME_LEN {
            return Err(format!("Invalid entry name length in {bank_name}"));
        }
        let name = std::str::from_utf8(&table[cursor..cursor + nul_rel])
            .map_err(|_| format!("Non-UTF-8 entry name in {bank_name}"))?;
        cursor += nul_rel + 1;
        if !valid_archive_entry_name(name) {
            return Err(format!("Unsafe archive entry name '{name}' in {bank_name}"));
        }
        if (size as u64) > MAX_ENTRY_BYTES
            || offset < AMARCHIVE_HEADER_SIZE as u64
            || offset
                .checked_add(size as u64)
                .is_none_or(|end| end > file_len)
        {
            return Err(format!(
                "Out-of-bounds archive entry '{name}' in {bank_name}"
            ));
        }
        if entries
            .insert(name.to_owned(), ArchiveEntry { offset, size })
            .is_some()
        {
            return Err(format!("Duplicate archive entry '{name}' in {bank_name}"));
        }
    }

    Ok((file, ArchiveIndex { entries }))
}

fn valid_archive_entry_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && !name.contains("..")
        && !name.chars().any(char::is_control)
}

fn read_archive_entry(
    file: &mut File,
    index: &ArchiveIndex,
    name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let entry = index
        .entries
        .get(name)
        .ok_or_else(|| format!("Missing archive entry {name}"))?;
    if entry.size as usize > max_bytes {
        return Err(format!("Archive entry {name} exceeds byte limit"));
    }
    file.seek(SeekFrom::Start(entry.offset))
        .map_err(|e| format!("Cannot seek entry {name}: {e}"))?;
    let mut bytes = vec![0u8; entry.size as usize];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("Cannot read entry {name}: {e}"))?;
    Ok(bytes)
}

fn get_or_parse_bank<'a>(
    catalog: &'a mut Catalog,
    bank_name: &str,
) -> Result<&'a ParsedBank, String> {
    if !catalog.parsed_banks.contains_key(bank_name) {
        let (mut file, index) = open_bank_archive(&catalog.root, bank_name)?;
        let xml_bytes = read_archive_entry(&mut file, &index, "Samples.xml", MAX_XML_BYTES)?;
        let xml_text = std::str::from_utf8(&xml_bytes)
            .map_err(|_| format!("Non-UTF-8 Samples.xml in {bank_name}"))?;
        let parsed = parse_samples_xml(xml_text)
            .map_err(|e| format!("Invalid Samples.xml in {bank_name}: {e}"))?;
        for sample in &parsed.samples {
            for wave in &sample.waves {
                if !index.entries.contains_key(&wave.file) {
                    return Err(format!(
                        "Missing wave archive entry '{}' in {bank_name}",
                        wave.file
                    ));
                }
            }
        }
        catalog.parsed_banks.insert(bank_name.to_owned(), parsed);
    }
    Ok(catalog.parsed_banks.get(bank_name).unwrap())
}

fn load_decoded_entry(
    catalog: &mut Catalog,
    bank_name: &str,
    file_name: &str,
) -> Result<Arc<DecodedAudio>, String> {
    let key = (bank_name.to_owned(), file_name.to_owned());
    if let Some(cached) = catalog.pcm_cache.get(&key) {
        return Ok(cached);
    }
    let (mut file, index) = open_bank_archive(&catalog.root, bank_name)?;
    let bytes = read_archive_entry(&mut file, &index, file_name, MAX_ENTRY_BYTES as usize)?;
    let ext = Path::new(file_name).extension().and_then(|e| e.to_str());
    let decoded =
        Arc::new(decode_audio(&bytes, ext).map_err(|e| format!("{bank_name}/{file_name}: {e}"))?);
    catalog.pcm_cache.insert(key, decoded.clone());
    Ok(decoded)
}

fn unescape_xml(raw: &str) -> Result<String, String> {
    if !raw.contains('&') {
        return Ok(raw.to_owned());
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after_amp = &rest[amp + 1..];
        let Some(semi) = after_amp.find(';') else {
            return Err("Unterminated XML entity".into());
        };
        let entity = &after_amp[..semi];
        match entity {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                let code = u32::from_str_radix(&entity[2..], 16)
                    .map_err(|_| format!("Bad hex entity &{entity};"))?;
                let ch = char::from_u32(code).ok_or("Invalid Unicode entity")?;
                out.push(ch);
            }
            _ if entity.starts_with('#') => {
                let code: u32 = entity[1..]
                    .parse()
                    .map_err(|_| format!("Bad decimal entity &{entity};"))?;
                let ch = char::from_u32(code).ok_or("Invalid Unicode entity")?;
                out.push(ch);
            }
            _ => return Err(format!("Unsupported XML entity &{entity};")),
        }
        rest = &after_amp[semi + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn parse_xml_attributes(attrs_str: &str) -> Result<Vec<(String, String)>, String> {
    let bytes = attrs_str.as_bytes();
    let mut i = 0usize;
    let mut out = Vec::new();
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let name_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
            i += 1;
        }
        let name = std::str::from_utf8(&bytes[name_start..i])
            .map_err(|_| "Non-UTF-8 attribute")?
            .to_owned();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            return Err(format!("Missing '=' after attribute {name}"));
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || (bytes[i] != b'"' && bytes[i] != b'\'') {
            return Err(format!("Unquoted attribute value for {name}"));
        }
        let quote = bytes[i];
        i += 1;
        let val_start = i;
        while i < bytes.len() && bytes[i] != quote {
            i += 1;
        }
        if i >= bytes.len() {
            return Err(format!("Unterminated attribute {name}"));
        }
        let raw_val = std::str::from_utf8(&bytes[val_start..i]).map_err(|_| "Bad UTF-8 value")?;
        i += 1;
        out.push((name, unescape_xml(raw_val)?));
    }
    Ok(out)
}

fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn parse_samples_xml(xml: &str) -> Result<ParsedBank, String> {
    let xml = xml.trim_start_matches('\u{feff}');
    let mut pos = 0usize;
    let mut node_stack: Vec<String> = Vec::new();
    let mut element_stack: Vec<String> = Vec::new();
    let mut bank_type = String::new();
    let mut samples: Vec<ParsedSample> = Vec::new();
    let mut wave_count = 0usize;
    let mut current_sample: Option<ParsedSample> = None;
    let mut pickup_set: HashSet<String> = HashSet::new();

    while let Some(rel_lt) = xml[pos..].find('<') {
        pos += rel_lt;
        if xml[pos..].starts_with("<?") {
            let Some(end) = xml[pos..].find("?>") else {
                return Err("Unterminated XML processing instruction".into());
            };
            pos += end + 2;
            continue;
        }
        if xml[pos..].starts_with("<!--") {
            let Some(end) = xml[pos..].find("-->") else {
                return Err("Unterminated XML comment".into());
            };
            pos += end + 3;
            continue;
        }
        let Some(rel_gt) = xml[pos + 1..].find('>') else {
            return Err("Unterminated XML tag".into());
        };
        let inside = xml[pos + 1..pos + 1 + rel_gt].trim();
        pos += 1 + rel_gt + 1;
        if inside.is_empty() {
            return Err("Empty XML tag".into());
        }
        if let Some(closing) = inside.strip_prefix('/') {
            let tag = closing.trim();
            let Some(expected) = element_stack.pop() else {
                return Err(format!("Unexpected closing </{tag}>"));
            };
            if expected != tag {
                return Err(format!(
                    "Mismatched closing </{tag}> (expected </{expected}>)"
                ));
            }
            if tag == "Node" {
                node_stack.pop();
            } else if tag == "Sample" {
                if let Some(sample) = current_sample.take() {
                    samples.push(sample);
                }
            }
            continue;
        }

        let (tag_body, self_closing) = match inside.strip_suffix('/') {
            Some(trimmed) => (trimmed.trim_end(), true),
            None => (inside, false),
        };
        let (tag, attrs_str) = match tag_body.find(char::is_whitespace) {
            Some(idx) => (&tag_body[..idx], tag_body[idx..].trim()),
            None => (tag_body, ""),
        };
        if !self_closing && element_stack.len() >= MAX_XML_DEPTH {
            return Err("XML nesting depth limit exceeded".into());
        }
        let attrs = parse_xml_attributes(attrs_str)?;

        match tag {
            "SoundBank" => {
                bank_type = attr(&attrs, "type").unwrap_or("").to_owned();
            }
            "Node" => {
                let class_name = attr(&attrs, "class")
                    .or_else(|| attr(&attrs, "name"))
                    .unwrap_or("")
                    .to_owned();
                if !self_closing {
                    node_stack.push(class_name);
                }
            }
            "Sample" => {
                if samples.len() >= MAX_SAMPLES_PER_BANK {
                    return Err("Sample count limit exceeded".into());
                }
                let midi = attr(&attrs, "midi")
                    .unwrap_or("-1")
                    .parse::<i16>()
                    .map_err(|_| "Invalid midi attribute")?;
                let string = attr(&attrs, "string")
                    .unwrap_or("-1")
                    .parse::<i16>()
                    .unwrap_or(-1);
                let dynamic = attr(&attrs, "dynamic").unwrap_or("mf").to_owned();
                let option = attr(&attrs, "option").unwrap_or("none").to_owned();
                let sample = ParsedSample {
                    path: node_stack.join("/"),
                    midi,
                    string,
                    dynamic,
                    option,
                    waves: Vec::new(),
                };
                if self_closing {
                    samples.push(sample);
                } else {
                    current_sample = Some(sample);
                }
            }
            "Wave" => {
                wave_count += 1;
                if wave_count > MAX_WAVES_PER_BANK {
                    return Err("Wave count limit exceeded".into());
                }
                let file = attr(&attrs, "file")
                    .ok_or("Missing file attribute on Wave")?
                    .to_owned();
                if !valid_archive_entry_name(&file) {
                    return Err(format!("Unsafe wave filename '{file}'"));
                }
                let pickup = attr(&attrs, "pickup").unwrap_or("none").to_owned();
                if matches!(pickup.as_str(), "bridge" | "middle" | "neck") {
                    pickup_set.insert(pickup.clone());
                }
                let repitch = attr(&attrs, "repitch")
                    .unwrap_or("0")
                    .parse::<f64>()
                    .unwrap_or(0.0);
                let gain_db = attr(&attrs, "gain")
                    .unwrap_or("0")
                    .parse::<f64>()
                    .unwrap_or(0.0);
                if !repitch.is_finite() || !gain_db.is_finite() {
                    return Err("Non-finite repitch or gain attribute".into());
                }
                if let Some(sample) = current_sample.as_mut() {
                    sample.waves.push(ParsedWave {
                        pickup,
                        file,
                        repitch,
                        gain_db,
                    });
                }
            }
            _ => {}
        }

        if !self_closing {
            element_stack.push(tag.to_owned());
        }
    }

    if !element_stack.is_empty() {
        return Err("Unclosed XML elements".into());
    }

    let mut pickups = Vec::new();
    for pos in ["bridge", "middle", "neck"] {
        if pickup_set.contains(pos) {
            pickups.push(pos.to_owned());
        }
    }

    Ok(ParsedBank {
        bank_type,
        samples,
        pickups,
    })
}

fn dynamic_rank(dynamic: &str) -> Option<(usize, u8)> {
    match dynamic {
        "pppp" => Some((0, 8)),
        "ppp" => Some((1, 20)),
        "pp" => Some((2, 36)),
        "p" => Some((3, 52)),
        "mp" => Some((4, 68)),
        "mf" => Some((5, 84)),
        "f" => Some((6, 96)),
        "ff" => Some((7, 108)),
        "fff" => Some((8, 118)),
        "ffff" => Some((9, 126)),
        _ => None,
    }
}

fn velocity_ranges(sorted_ranks: &[(usize, u8)]) -> HashMap<usize, (u8, u8)> {
    let mut map = HashMap::new();
    if sorted_ranks.is_empty() {
        return map;
    }
    let mut prev_high = 0u8;
    for (idx, &(rank, center)) in sorted_ranks.iter().enumerate() {
        let low = prev_high.saturating_add(1);
        let high = if idx + 1 == sorted_ranks.len() {
            127
        } else {
            let next_center = sorted_ranks[idx + 1].1;
            ((u16::from(center) + u16::from(next_center)) / 2) as u8
        };
        map.insert(rank, (low, high.max(low)));
        prev_high = high.max(low);
    }
    map
}

fn key_ranges(sorted_roots: &[u8]) -> HashMap<u8, (u8, u8)> {
    let mut map = HashMap::new();
    if sorted_roots.is_empty() {
        return map;
    }
    let mut prev_high: Option<u8> = None;
    for (idx, &root) in sorted_roots.iter().enumerate() {
        let low = prev_high.map_or(0, |h| h.saturating_add(1));
        let high = if idx + 1 == sorted_roots.len() {
            127
        } else {
            let next_root = sorted_roots[idx + 1];
            ((u16::from(root) + u16::from(next_root)) / 2) as u8
        };
        map.insert(root, (low, high.max(low)));
        prev_high = Some(high.max(low));
    }
    map
}

fn map_pitched_articulation(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("pick/") {
        "picked"
    } else if lower.starts_with("finger/sustain") {
        "fingered"
    } else if lower.starts_with("slap/") {
        "slap"
    } else if lower.starts_with("pop/") {
        "pop"
    } else if lower.starts_with("harmonic/") {
        "harmonic"
    } else {
        "picked"
    }
}

fn select_wave<'a>(
    waves: &'a [ParsedWave],
    preferred_pickup: Option<&str>,
) -> Option<&'a ParsedWave> {
    if let Some(pref) = preferred_pickup {
        if let Some(found) = waves.iter().find(|w| w.pickup == pref) {
            return Some(found);
        }
    }
    for fallback in ["bridge", "neck", "middle", "none"] {
        if let Some(found) = waves.iter().find(|w| w.pickup == fallback) {
            return Some(found);
        }
    }
    waves.first()
}

fn pitched_release_seconds(instrument_set: &str) -> f64 {
    if matches!(
        instrument_set,
        "electricGuitar"
            | "steelGuitar"
            | "nylonGuitar"
            | "resonatorGuitar"
            | "ukulele"
            | "banjo"
            | "mandolin"
            | "electricBass"
            | "acousticBass"
            | "fretlessBass"
            | "uprightBass"
    ) {
        0.08
    } else {
        0.15
    }
}

fn build_pitched_instrument(
    catalog: &mut Catalog,
    runtime_id: &str,
    set: &SetDefinition,
    variant: Option<&str>,
) -> Result<Instrument, String> {
    let Some(bank_ref) = set.soundbanks.first() else {
        return Ok(Instrument::default());
    };
    let bank_name = bank_ref.soundbank.clone();
    let bank = get_or_parse_bank(catalog, &bank_name)?.clone();
    let release_seconds = pitched_release_seconds(&set.info.instrument_set);
    let _ = &bank.bank_type;

    // Group by (articulation, root_midi, dynamic_rank, variant_slot) keeping highest string number
    // (open / highest string carries the cleanest timbre when frets overlap across strings).
    #[derive(Clone)]
    struct Candidate<'a> {
        string: i16,
        wave: &'a ParsedWave,
    }
    let mut grouped: BTreeMap<(&'static str, u8, usize, String), Candidate<'_>> = BTreeMap::new();
    for sample in &bank.samples {
        if sample.midi < 0 || sample.midi > 127 {
            continue;
        }
        let Some(wave) = select_wave(&sample.waves, variant) else {
            continue;
        };
        let Some((dyn_idx, dyn_center)) = dynamic_rank(&sample.dynamic) else {
            continue;
        };
        let _ = dyn_center;
        let articulation = map_pitched_articulation(&sample.path);
        let root_midi = sample.midi as u8;
        let slot_key = format!("{}|{}", sample.path, sample.option);
        let entry = grouped.entry((articulation, root_midi, dyn_idx, slot_key));
        entry
            .and_modify(|existing| {
                if sample.string > existing.string {
                    existing.string = sample.string;
                    existing.wave = wave;
                }
            })
            .or_insert(Candidate {
                string: sample.string,
                wave,
            });
    }

    // Reorganize into (articulation, root_midi) -> dynamic_rank -> Vec<Candidate>.
    let mut by_art_root: BTreeMap<(&'static str, u8), BTreeMap<usize, Vec<Candidate<'_>>>> =
        BTreeMap::new();
    for ((art, root, dyn_idx, _slot), cand) in grouped {
        by_art_root
            .entry((art, root))
            .or_default()
            .entry(dyn_idx)
            .or_default()
            .push(cand);
    }

    // Collect roots per articulation so key_low..=key_high cover 0..=127 continuously.
    let mut roots_by_art: HashMap<&'static str, Vec<u8>> = HashMap::new();
    for &(art, root) in by_art_root.keys() {
        roots_by_art.entry(art).or_default().push(root);
    }
    let key_maps: HashMap<&'static str, HashMap<u8, (u8, u8)>> = roots_by_art
        .into_iter()
        .map(|(art, mut roots)| {
            roots.sort_unstable();
            roots.dedup();
            (art, key_ranges(&roots))
        })
        .collect();

    let mut regions = Vec::new();
    for ((art, root), by_dyn) in by_art_root {
        let &(key_low, key_high) = &key_maps[art][&root];
        let sorted_ranks: Vec<(usize, u8)> = by_dyn
            .keys()
            .filter_map(|&idx| match idx {
                0 => Some((0, 8)),
                1 => Some((1, 20)),
                2 => Some((2, 36)),
                3 => Some((3, 52)),
                4 => Some((4, 68)),
                5 => Some((5, 84)),
                6 => Some((6, 96)),
                7 => Some((7, 108)),
                8 => Some((8, 118)),
                9 => Some((9, 126)),
                _ => None,
            })
            .collect();
        let vel_map = velocity_ranges(&sorted_ranks);
        for (dyn_idx, cands) in by_dyn {
            let &(velocity_low, velocity_high) = &vel_map[&dyn_idx];
            let seq_len = cands.len().min(u16::MAX as usize) as u16;
            for (var_idx, cand) in cands.into_iter().take(u16::MAX as usize).enumerate() {
                regions.push(Region {
                    sample_id: format!("gp8:{}:{}", bank_name, cand.wave.file),
                    root_key: root,
                    key_low,
                    key_high,
                    velocity_low,
                    velocity_high,
                    articulation: art.to_owned(),
                    variant: (var_idx + 1) as u16,
                    sequence_length: seq_len,
                    loop_start: None,
                    loop_end: None,
                    attack_seconds: 0.0,
                    release_seconds,
                    gain_db: cand.wave.gain_db,
                    trigger: "attack".into(),
                    pitch_keytrack: 100.0,
                    velocity_gain_high: 127,
                    release_decay_db_per_second: 0.0,
                    group: 0,
                    off_by: 0,
                    tuning_cents: cand.wave.repitch,
                });
            }
        }
    }

    Ok(Instrument {
        id: runtime_id.to_owned(),
        name: set.info.name.clone(),
        source_id: "gp8".into(),
        regions,
    })
}

fn path_beater(path: &str) -> &str {
    path.split('/').next().unwrap_or("")
}

fn path_technique(path: &str) -> &str {
    path.split('/').nth(1).unwrap_or("")
}

fn path_detail(path: &str) -> &str {
    path.split('/').nth(2).unwrap_or("")
}

fn prefer_beater<'a>(samples: &[&'a ParsedSample], prefer_brush: bool) -> Vec<&'a ParsedSample> {
    let available: HashSet<&str> = samples.iter().map(|s| path_beater(&s.path)).collect();
    let order: &[&str] = if prefer_brush {
        &["brush", "stick", "rod", "hand", "mallet", "blow", "pedal"]
    } else {
        &["stick", "pedal", "hand", "mallet", "blow", "rod", "brush"]
    };
    let chosen = order.iter().find(|&&b| available.contains(b)).copied();
    let Some(chosen_beater) = chosen else {
        return samples.to_vec();
    };
    samples
        .iter()
        .copied()
        .filter(|s| path_beater(&s.path) == chosen_beater)
        .collect()
}

fn add_percussion_bank_regions(
    regions: &mut Vec<Region>,
    bank_name: &str,
    bank: &ParsedBank,
    element: &str,
    prefer_brush: bool,
    seen_targets: &mut HashSet<(String, u8, String)>,
) {
    let targets = map_element_paths_to_gm_keys(element, bank);
    for (filter_detail, gm_keys, articulation, (group, off_by)) in targets {
        let matching: Vec<&ParsedSample> = bank
            .samples
            .iter()
            .filter(|s| {
                filter_detail.is_empty()
                    || path_detail(&s.path) == filter_detail
                    || (filter_detail == "return" && path_technique(&s.path) == "scrape")
            })
            .collect();
        if matching.is_empty() {
            continue;
        }
        // Only apply beater preference when this slice mixes multiple beaters (e.g., stick/rod/brush).
        // Do not accidentally drop `pedal` for `pedal/hit/pedal` if `filter_detail == "pedal"` already narrowed it.
        let filtered = if filter_detail.is_empty()
            || matching
                .iter()
                .map(|s| path_beater(&s.path))
                .collect::<HashSet<_>>()
                .len()
                > 1
        {
            prefer_beater(&matching, prefer_brush)
        } else {
            matching
        };

        for &gm_key in gm_keys {
            if !seen_targets.insert((bank_name.to_owned(), gm_key, articulation.to_owned())) {
                continue;
            }
            // Group surviving samples by dynamic rank.
            let mut by_dyn: BTreeMap<usize, Vec<&ParsedSample>> = BTreeMap::new();
            for sample in &filtered {
                let Some((dyn_idx, _)) = dynamic_rank(&sample.dynamic) else {
                    continue;
                };
                by_dyn.entry(dyn_idx).or_default().push(*sample);
            }
            if by_dyn.is_empty() {
                continue;
            }
            let sorted_ranks: Vec<(usize, u8)> = by_dyn
                .keys()
                .filter_map(|&idx| match idx {
                    0 => Some((0, 8)),
                    1 => Some((1, 20)),
                    2 => Some((2, 36)),
                    3 => Some((3, 52)),
                    4 => Some((4, 68)),
                    5 => Some((5, 84)),
                    6 => Some((6, 96)),
                    7 => Some((7, 108)),
                    8 => Some((8, 118)),
                    9 => Some((9, 126)),
                    _ => None,
                })
                .collect();
            let vel_map = velocity_ranges(&sorted_ranks);
            for (dyn_idx, mut list) in by_dyn {
                list.sort_by(|a, b| a.option.cmp(&b.option).then(a.path.cmp(&b.path)));
                let &(velocity_low, velocity_high) = &vel_map[&dyn_idx];
                let items: Vec<(&ParsedSample, &ParsedWave)> = list
                    .into_iter()
                    .filter_map(|s| select_wave(&s.waves, None).map(|w| (s, w)))
                    .collect();
                let seq_len = items.len().min(u16::MAX as usize) as u16;
                if seq_len == 0 {
                    continue;
                }
                for (var_idx, (_s, wave)) in items.into_iter().take(u16::MAX as usize).enumerate() {
                    regions.push(Region {
                        sample_id: format!("gp8:{}:{}", bank_name, wave.file),
                        root_key: gm_key,
                        key_low: gm_key,
                        key_high: gm_key,
                        velocity_low,
                        velocity_high,
                        articulation: articulation.to_owned(),
                        variant: (var_idx + 1) as u16,
                        sequence_length: seq_len,
                        loop_start: None,
                        loop_end: None,
                        attack_seconds: 0.0,
                        release_seconds: 0.05,
                        gain_db: wave.gain_db,
                        trigger: "attack".into(),
                        pitch_keytrack: 0.0,
                        velocity_gain_high: 127,
                        release_decay_db_per_second: 0.0,
                        group,
                        off_by,
                        tuning_cents: wave.repitch,
                    });
                }
            }
        }
    }
}

type PercPathTarget = (&'static str, &'static [u8], &'static str, (u32, u32));

fn map_element_paths_to_gm_keys(element: &str, bank: &ParsedBank) -> Vec<PercPathTarget> {
    match element {
        "Kick Drum" | "Acoustic Kick Drum" => vec![("", &[35, 36], "picked", (0, 0))],
        "Snare" => vec![
            ("hit", &[38, 40], "picked", (0, 0)),
            ("sidestick", &[37], "picked", (0, 0)),
            ("rimshot", &[1], "picked", (0, 0)),
        ],
        "Hi-Hat" => vec![
            ("closed", &[42], "picked", (1, 1)),
            ("pedal", &[44], "picked", (1, 1)),
            ("half", &[2], "picked", (1, 1)),
            ("open", &[46], "picked", (1, 1)),
        ],
        "Tom Very Low" | "Low Floor Tom" => vec![("", &[41], "picked", (0, 0))],
        "Tom Low" => vec![("", &[43], "picked", (0, 0))],
        "Tom Medium" => vec![("", &[45, 47], "picked", (0, 0))],
        "Tom High" => vec![("", &[48], "picked", (0, 0))],
        "Tom Very High" => vec![("", &[50], "picked", (0, 0))],
        "Tom" => vec![("", &[45], "picked", (0, 0))],
        "Crash Medium" => vec![
            ("hit", &[49], "picked", (0, 0)),
            ("choke", &[49], "choke", (0, 0)),
        ],
        "Crash High" => vec![
            ("hit", &[57], "picked", (0, 0)),
            ("choke", &[57], "choke", (0, 0)),
        ],
        "Crash" => vec![
            ("hit", &[49, 57], "picked", (0, 0)),
            ("choke", &[49, 57], "choke", (0, 0)),
        ],
        "Splash" => vec![
            ("hit", &[55], "picked", (0, 0)),
            ("choke", &[55], "choke", (0, 0)),
        ],
        "China" => vec![
            ("hit", &[52], "picked", (0, 0)),
            ("choke", &[52], "choke", (0, 0)),
        ],
        "Ride" => vec![
            ("mid", &[51], "picked", (0, 0)),
            ("bell", &[53], "picked", (0, 0)),
            ("edge", &[59], "picked", (0, 0)),
            ("hit", &[51], "picked", (0, 0)),
            ("none", &[51], "picked", (0, 0)),
            ("choke", &[51, 53, 59], "choke", (0, 0)),
        ],
        "Ride Cymbal 2" => vec![
            ("edge", &[59], "picked", (0, 0)),
            ("mid", &[59], "picked", (0, 0)),
            ("bell", &[53], "picked", (0, 0)),
            ("hit", &[59], "picked", (0, 0)),
            ("choke", &[59], "choke", (0, 0)),
        ],
        "Mid Cowbell" | "Low Cowbell" | "High Cowbell" | "Cowbell" => {
            vec![("", &[56], "picked", (0, 0))]
        }
        "Hand Clap" => vec![("", &[39], "picked", (0, 0))],
        "Tambourine" => vec![("", &[54], "picked", (0, 0))],
        "Vibraslap" => vec![("", &[58], "picked", (0, 0))],
        "High Bongo" | "Bongo" => vec![("", &[60], "picked", (0, 0))],
        "Low Bongo" => vec![("", &[61], "picked", (0, 0))],
        "High Conga" | "Conga" => vec![
            ("mute", &[62], "picked", (2, 2)),
            ("hit", &[63], "picked", (2, 2)),
        ],
        "Low Conga" => vec![("", &[64], "picked", (2, 2))],
        "High Timbale" | "Timbale" => vec![("", &[65], "picked", (0, 0))],
        "Low Timbale" => vec![("", &[66], "picked", (0, 0))],
        "High Agogo" | "Agogo" => vec![("", &[67], "picked", (0, 0))],
        "Low Agogo" => vec![("", &[68], "picked", (0, 0))],
        "Cabasa" => vec![("", &[69], "picked", (0, 0))],
        "Left Maraca" | "Right Maraca" | "Maraca" => vec![("", &[70], "picked", (0, 0))],
        "Low Whistle" => vec![("", &[71], "picked", (4, 4))],
        "High Whistle" | "Whistle" => vec![("", &[72], "picked", (4, 4))],
        "Guiro" => vec![
            ("hit", &[73], "picked", (0, 0)),
            ("return", &[74], "picked", (0, 0)),
        ],
        "Claves" => vec![("", &[75], "picked", (0, 0))],
        "High Woodblock" | "Woodblock" => vec![("", &[76], "picked", (0, 0))],
        "Low Woodblock" => vec![("", &[77], "picked", (0, 0))],
        "Cuica" => vec![
            ("mute", &[78], "picked", (5, 5)),
            ("hit", &[79], "picked", (5, 5)),
        ],
        "Triangle" => vec![
            ("mute", &[80], "picked", (3, 3)),
            ("hit", &[81], "picked", (3, 3)),
        ],
        "Shaker" => vec![("", &[82], "picked", (0, 0))],
        "Jingle Bell" | "Sleighbell" => vec![("", &[83], "picked", (0, 0))],
        "Bell Tree" => vec![("", &[84], "picked", (0, 0))],
        "Castanets" => vec![("", &[85], "picked", (0, 0))],
        "Surdo" => vec![
            ("mute", &[86], "picked", (6, 6)),
            ("hit", &[87], "picked", (6, 6)),
        ],
        "Grancassa" => vec![("", &[35], "picked", (0, 0))],
        "Piatti" => vec![("", &[52, 57], "picked", (0, 0))],
        "Sticks" => vec![("", &[31], "picked", (0, 0))],
        "Metronome" => vec![("", &[33, 34], "picked", (0, 0))],
        _ => match bank.bank_type.as_str() {
            "kickDrum" => vec![("", &[35, 36], "picked", (0, 0))],
            "snare" => vec![("hit", &[38, 40], "picked", (0, 0))],
            "hiHat" => vec![
                ("closed", &[42], "picked", (1, 1)),
                ("pedal", &[44], "picked", (1, 1)),
                ("half", &[2], "picked", (1, 1)),
                ("open", &[46], "picked", (1, 1)),
            ],
            "tom" => vec![("", &[45], "picked", (0, 0))],
            _ => vec![("", &[38], "picked", (0, 0))],
        },
    }
}

fn build_percussion_instrument(
    catalog: &mut Catalog,
    runtime_id: &str,
    set: &SetDefinition,
    variant: Option<&str>,
) -> Result<Instrument, String> {
    let prefer_brush = variant == Some("brush");
    let mut regions = Vec::new();
    let mut seen_targets = HashSet::new();
    let mut mapped_keys: HashSet<(u8, &'static str)> = HashSet::new();

    // For a drumKit, if multiple cowbells exist, prefer Mid Cowbell first so key 56 gets one clean voice.
    let mut refs: Vec<RawSetBankRef> = set.soundbanks.clone();
    refs.sort_by_key(|r| match r.element.as_str() {
        "Mid Cowbell" => 0,
        "Low Cowbell" => 1,
        "High Cowbell" => 2,
        _ => 3,
    });

    let mut cowbell_mapped = false;
    for bank_ref in &refs {
        let is_cowbell = matches!(
            bank_ref.element.as_str(),
            "Mid Cowbell" | "Low Cowbell" | "High Cowbell"
        );
        if is_cowbell && cowbell_mapped {
            continue;
        }
        let bank = get_or_parse_bank(catalog, &bank_ref.soundbank)?.clone();
        let before = regions.len();
        add_percussion_bank_regions(
            &mut regions,
            &bank_ref.soundbank,
            &bank,
            &bank_ref.element,
            prefer_brush,
            &mut seen_targets,
        );
        if is_cowbell && regions.len() > before {
            cowbell_mapped = true;
        }
    }

    for r in &regions {
        mapped_keys.insert((
            r.key_low,
            if r.articulation == "choke" {
                "choke"
            } else {
                "picked"
            },
        ));
    }

    // Attach missing auxiliary world-percussion sounds for full drumKit tracks whenever present on disk.
    if set.info.instrument_set == "drumKit" {
        for &(bank_name, detail, keys, choke) in AUXILIARY_PERCUSSION_FALLBACK
            .iter()
            .chain(AUXILIARY_PERCUSSION_EXTRA.iter())
        {
            if !catalog.available_banks.contains(bank_name) {
                continue;
            }
            if !keys.iter().any(|&k| !mapped_keys.contains(&(k, "picked"))) {
                continue;
            }
            let Ok(bank) = get_or_parse_bank(catalog, bank_name).cloned() else {
                continue;
            };
            let matching: Vec<&ParsedSample> = bank
                .samples
                .iter()
                .filter(|s| {
                    detail.is_empty()
                        || path_detail(&s.path) == detail
                        || (detail == "return" && path_technique(&s.path) == "scrape")
                })
                .collect();
            if matching.is_empty() {
                continue;
            }
            let filtered = prefer_beater(&matching, false);
            for &gm_key in keys {
                if mapped_keys.contains(&(gm_key, "picked")) {
                    continue;
                }
                let mut by_dyn: BTreeMap<usize, Vec<&ParsedSample>> = BTreeMap::new();
                for sample in &filtered {
                    if let Some((dyn_idx, _)) = dynamic_rank(&sample.dynamic) {
                        by_dyn.entry(dyn_idx).or_default().push(*sample);
                    }
                }
                if by_dyn.is_empty() {
                    continue;
                }
                let sorted_ranks: Vec<(usize, u8)> = by_dyn
                    .keys()
                    .filter_map(|&idx| match idx {
                        0 => Some((0, 8)),
                        1 => Some((1, 20)),
                        2 => Some((2, 36)),
                        3 => Some((3, 52)),
                        4 => Some((4, 68)),
                        5 => Some((5, 84)),
                        6 => Some((6, 96)),
                        7 => Some((7, 108)),
                        8 => Some((8, 118)),
                        9 => Some((9, 126)),
                        _ => None,
                    })
                    .collect();
                let vel_map = velocity_ranges(&sorted_ranks);
                for (dyn_idx, mut list) in by_dyn {
                    list.sort_by(|a, b| a.option.cmp(&b.option).then(a.path.cmp(&b.path)));
                    let &(velocity_low, velocity_high) = &vel_map[&dyn_idx];
                    let items: Vec<(&ParsedSample, &ParsedWave)> = list
                        .into_iter()
                        .filter_map(|s| select_wave(&s.waves, None).map(|w| (s, w)))
                        .collect();
                    let seq_len = items.len().min(u16::MAX as usize) as u16;
                    for (var_idx, (_s, wave)) in
                        items.into_iter().take(u16::MAX as usize).enumerate()
                    {
                        regions.push(Region {
                            sample_id: format!("gp8:{}:{}", bank_name, wave.file),
                            root_key: gm_key,
                            key_low: gm_key,
                            key_high: gm_key,
                            velocity_low,
                            velocity_high,
                            articulation: "picked".into(),
                            variant: (var_idx + 1) as u16,
                            sequence_length: seq_len,
                            loop_start: None,
                            loop_end: None,
                            attack_seconds: 0.0,
                            release_seconds: 0.05,
                            gain_db: wave.gain_db,
                            trigger: "attack".into(),
                            pitch_keytrack: 0.0,
                            velocity_gain_high: 127,
                            release_decay_db_per_second: 0.0,
                            group: choke.0,
                            off_by: choke.1,
                            tuning_cents: wave.repitch,
                        });
                    }
                }
                mapped_keys.insert((gm_key, "picked"));
            }
        }
    }

    Ok(Instrument {
        id: runtime_id.to_owned(),
        name: set.info.name.clone(),
        source_id: "gp8".into(),
        regions,
    })
}
