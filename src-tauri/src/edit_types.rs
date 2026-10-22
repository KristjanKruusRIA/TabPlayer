use crate::engraving::{EngravingOverrides, PageLayout};
use crate::harmony::{HarmonyChord, HarmonyInterval};
use crate::project::BeatTarget;
use crate::settings::{BackingSettings, ChannelMix, PrintLayout, TrackSound};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteTarget {
    pub target: BeatTarget,
    pub string: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexedNoteTarget {
    pub target: BeatTarget,
    pub note_index: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceAddress {
    pub track: u32,
    pub staff: u32,
    pub voice: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MusicPoint {
    pub bar: u32,
    pub tick: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatRange {
    pub start: MusicPoint,
    pub end: MusicPoint,
    pub lanes: Vec<VoiceAddress>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MusicSelection {
    Range {
        range: BeatRange,
    },
    Notes {
        notes: Vec<IndexedNoteTarget>,
    },
    Bars {
        tracks: Vec<u32>,
        first_bar: u32,
        last_bar: u32,
    },
}

impl MusicSelection {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Range { range } => {
                if (range.start.bar, range.start.tick) >= (range.end.bar, range.end.tick) {
                    return Err("Select a nonempty ordered music range.".into());
                }
                let mut seen = HashSet::new();
                if range.lanes.is_empty()
                    || range
                        .lanes
                        .iter()
                        .any(|lane| !seen.insert((lane.track, lane.staff, lane.voice)))
                {
                    return Err("Select nonempty distinct voice lanes.".into());
                }
            }
            Self::Notes { notes } => {
                let mut seen = HashSet::new();
                if notes.is_empty()
                    || notes.iter().any(|note| {
                        let target = &note.target;
                        !seen.insert((
                            target.track,
                            target.staff,
                            target.bar,
                            target.voice,
                            target.beat,
                            note.note_index,
                        ))
                    })
                {
                    return Err("Select nonempty distinct notes.".into());
                }
            }
            Self::Bars {
                tracks,
                first_bar,
                last_bar,
            } => {
                let mut seen = HashSet::new();
                if tracks.is_empty() || tracks.iter().any(|track| !seen.insert(*track)) {
                    return Err("Select nonempty distinct tracks.".into());
                }
                if first_bar > last_bar {
                    return Err("Select an ordered inclusive bar range.".into());
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum StringMoveDirection {
    Higher,
    Lower,
}

impl TryFrom<String> for StringMoveDirection {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "higher" => Ok(Self::Higher),
            "lower" => Ok(Self::Lower),
            _ => Err("Unsupported string move direction.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum SustainKind {
    LetRing,
    PalmMute,
}

impl TryFrom<String> for SustainKind {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "letRing" => Ok(Self::LetRing),
            "palmMute" => Ok(Self::PalmMute),
            _ => Err("Unsupported sustain kind.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum ClipboardMode {
    SingleTrack,
    MultiTrack,
}

impl TryFrom<String> for ClipboardMode {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "singleTrack" => Ok(Self::SingleTrack),
            "multiTrack" => Ok(Self::MultiTrack),
            _ => Err("Unsupported clipboard mode.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum ClipboardKind {
    Phrase,
    Bars,
}

impl TryFrom<String> for ClipboardKind {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "phrase" => Ok(Self::Phrase),
            "bars" => Ok(Self::Bars),
            _ => Err("Unsupported clipboard kind.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum ClipboardLinkKind {
    Tie,
    Slur,
    Slide,
    HammerPull,
}

impl TryFrom<String> for ClipboardLinkKind {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "tie" => Ok(Self::Tie),
            "slur" => Ok(Self::Slur),
            "slide" => Ok(Self::Slide),
            "hammerPull" => Ok(Self::HammerPull),
            _ => Err("Unsupported clipboard link kind.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipboardLink {
    pub from: u32,
    pub to: u32,
    pub kind: ClipboardLinkKind,
    #[serde(deserialize_with = "required_nullable")]
    pub slide_out_type: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipboardHarmony {
    pub track: u32,
    pub staff: u32,
    pub chord_id: String,
    pub chord: HarmonyChord,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MusicClip {
    pub format: String,
    pub version: u32,
    pub engine_version: String,
    pub mode: ClipboardMode,
    pub kind: ClipboardKind,
    pub score_json: String,
    pub links: Vec<ClipboardLink>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub harmony: Option<Vec<ClipboardHarmony>>,
}

impl MusicClip {
    fn validate(&self) -> Result<(), String> {
        if self.format != "TabPlayerClip"
            || !matches!(
                (self.version, self.harmony.is_some()),
                (1, false) | (2, true)
            )
            || self.engine_version != "1.8.4"
        {
            return Err("Unsupported clipboard format, version or engine.".into());
        }
        if self.score_json.len() > 128_000_000 {
            return Err("Clipboard score exceeds the 128,000,000-byte limit.".into());
        }
        let score: serde_json::Value = serde_json::from_str(&self.score_json)
            .map_err(|_| "Clipboard score must contain valid JSON.".to_string())?;
        if !score.is_object() {
            return Err("Clipboard score JSON must be an object.".into());
        }
        let mut seen = HashSet::new();
        for link in &self.links {
            match (&link.kind, link.slide_out_type) {
                (ClipboardLinkKind::Slide, Some(1 | 2)) => {}
                (ClipboardLinkKind::Slide, _) | (_, Some(_)) => {
                    return Err("Only slide links need a Shift or Legato slide type.".into());
                }
                (_, None) => {}
            }
            if !seen.insert((link.from, link.to, &link.kind, link.slide_out_type)) {
                return Err("Clipboard links must be distinct.".into());
            }
        }
        if let Some(harmony) = &self.harmony {
            let mut records = HashSet::new();
            for record in harmony {
                if record.chord_id.is_empty()
                    || !records.insert((record.track, record.staff, &record.chord_id))
                {
                    return Err(
                        "Clipboard harmony needs distinct nonempty chord identities.".into(),
                    );
                }
                record.chord.validate()?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteFilters {
    pub diagrams: bool,
    pub texts: bool,
    pub timers: bool,
    pub track_automations: bool,
    pub master_automations: bool,
    pub sections: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteDestination {
    pub source_track: u32,
    pub track: u32,
    pub staff_map: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum PastePlacement {
    CurrentBar,
    BeforeBar,
}

impl TryFrom<String> for PastePlacement {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "currentBar" => Ok(Self::CurrentBar),
            "beforeBar" => Ok(Self::BeforeBar),
            _ => Err("Unsupported paste placement.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteOptions {
    pub target: BeatTarget,
    pub destinations: Vec<PasteDestination>,
    pub count: u32,
    pub placement: PastePlacement,
    pub filters: PasteFilters,
}

impl PasteOptions {
    fn validate(&self) -> Result<(), String> {
        if !(1..=1000).contains(&self.count) {
            return Err("Paste from 1 to 1000 repetitions.".into());
        }
        if self.destinations.is_empty() {
            return Err("Paste needs at least one track destination.".into());
        }
        let mut sources = HashSet::new();
        let mut tracks = HashSet::new();
        for destination in &self.destinations {
            if !sources.insert(destination.source_track) || !tracks.insert(destination.track) {
                return Err("Paste source and destination tracks must each be distinct.".into());
            }
            let mut staves = HashSet::new();
            if destination.staff_map.is_empty()
                || destination
                    .staff_map
                    .iter()
                    .any(|staff| !staves.insert(*staff))
            {
                return Err("Paste staff mappings must be nonempty and distinct.".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreMetadata {
    pub sub_title: String,
    pub album: String,
    pub words: String,
    pub music: String,
    pub copyright: String,
    pub tab: String,
    pub notices: String,
    pub instructions: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PitchPoint {
    pub offset: f64,
    pub value: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PitchCurve {
    pub r#type: i32,
    pub style: i32,
    pub points: Vec<PitchPoint>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Harmonic {
    pub r#type: i32,
    pub value: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trill {
    pub pitch: i32,
    pub speed: i32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tremolo {
    pub speed: i32,
    pub style: i32,
}

fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(T::deserialize(deserializer)?))
}
pub fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
fn empty_command<'de, D>(deserializer: D) -> Result<(), D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    Empty::deserialize(deserializer).map(|_| ())
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteTechniques {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub let_ring: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub palm_mute: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub dead: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub ghost: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub staccato: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub left_hand_tapped: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub accent: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub dynamics: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub left_finger: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub right_finger: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub slide_in: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub slide_out: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub vibrato: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub ornament: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub bend: Option<Option<PitchCurve>>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub harmonic: Option<Option<Harmonic>>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub trill: Option<Option<Trill>>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatTechniques {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub pick_stroke: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub brush_type: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub brush_duration: Option<f64>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub whammy: Option<Option<PitchCurve>>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub tremolo: Option<Option<Tremolo>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TempoPoint {
    pub beat: u32,
    pub bpm: f64,
    pub linear: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RatioTempoPoint {
    pub bar: u32,
    pub ratio: f64,
    pub bpm: f64,
    pub linear: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaffSettings {
    pub tuning: Vec<i32>,
    pub capo: u32,
    pub transposition: i32,
    pub display_transposition: i32,
    pub clef: i32,
    pub show_tab: bool,
    pub show_notation: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChordDefinition {
    pub name: String,
    pub first_fret: u32,
    pub frets: Vec<i32>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Tie,
    HammerPull,
    Slur,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LyricLine {
    pub start_bar: u32,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Barre {
    pub fret: u32,
    pub shape: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum StemMode {
    Auto,
    Inverted,
    Up,
    Down,
}

impl TryFrom<String> for StemMode {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "auto" => Ok(Self::Auto),
            "inverted" => Ok(Self::Inverted),
            "up" => Ok(Self::Up),
            "down" => Ok(Self::Down),
            _ => Err("Unsupported stem mode.".into()),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GesturePatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub tap: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub slap: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub pop: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub dead_slapped: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub golpe: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub rasgueado: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub fade: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub vibrato: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub slashed: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub show_timer: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub barre: Option<Option<Barre>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub stem: Option<StemMode>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub beaming_mode: Option<i32>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub wah_pedal: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fermata {
    pub r#type: i32,
    pub length: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomBeaming {
    pub unit: i32,
    pub groups: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum SimileKind {
    None,
    Single,
    Double,
}

impl TryFrom<String> for SimileKind {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "none" => Ok(Self::None),
            "single" => Ok(Self::Single),
            "double" => Ok(Self::Double),
            _ => Err("Unsupported simile kind.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EditCommand {
    SetNote {
        target: BeatTarget,
        string: u32,
        fret: u32,
    },
    RemoveNote {
        target: BeatTarget,
        string: u32,
    },
    SetRest {
        target: BeatTarget,
    },
    SetDuration {
        target: BeatTarget,
        duration: i32,
        dots: u8,
    },
    InsertBeat {
        target: BeatTarget,
        duration: i32,
        dots: u8,
    },
    DeleteBeat {
        target: BeatTarget,
    },
    #[serde(deserialize_with = "empty_command")]
    AppendMeasure,
    RemoveMeasure {
        bar: u32,
    },
    InsertMeasures {
        before_bar: u32,
        count: u32,
    },
    RemoveMeasures {
        first_bar: u32,
        last_bar: u32,
    },
    EraseSelection {
        selection: MusicSelection,
    },
    TransposeSelection {
        selection: MusicSelection,
        semitones: i32,
    },
    MoveSelectionStrings {
        selection: MusicSelection,
        direction: StringMoveDirection,
    },
    RefingerSelection {
        selection: MusicSelection,
        max_fret: u32,
    },
    SetSelectionSustain {
        selection: MusicSelection,
        strings: Vec<u32>,
        kind: SustainKind,
        enabled: bool,
    },
    PasteMusic {
        clip: MusicClip,
        options: PasteOptions,
    },
    AddTrack {
        name: String,
        tuning: Vec<i32>,
        program: u8,
    },
    AddPitchedTrack {
        name: String,
        program: u8,
    },
    AddPercussionTrack {
        name: String,
        program: u8,
    },
    AddPitchedNote {
        target: BeatTarget,
        pitch: u8,
    },
    SetPitchedNote {
        target: BeatTarget,
        note_index: u32,
        pitch: u8,
    },
    AddPercussionNote {
        target: BeatTarget,
        articulation: u32,
    },
    SetPercussionNote {
        target: BeatTarget,
        note_index: u32,
        articulation: u32,
    },
    RemoveNoteByIndex {
        target: BeatTarget,
        note_index: u32,
    },
    RemoveTrack {
        track: u32,
    },
    MoveTrack {
        track: u32,
        to: u32,
    },
    DuplicateTrack {
        track: u32,
    },
    SetTrackColor {
        track: u32,
        color: String,
    },
    SetTuning {
        track: u32,
        tuning: Vec<i32>,
    },
    SetScoreInfo {
        title: String,
        artist: String,
        tempo: f64,
    },
    SetScoreMetadata {
        fields: ScoreMetadata,
    },
    SetTrackLyrics {
        track: u32,
        visible: bool,
        lines: Vec<LyricLine>,
    },
    SetDirections {
        bar: u32,
        directions: Vec<i32>,
    },
    SetNoteSpelling {
        target: BeatTarget,
        note_index: u32,
        accidental_mode: i32,
    },
    SetNoteTechniques {
        target: BeatTarget,
        string: u32,
        patch: NoteTechniques,
    },
    SetNoteTechniquesByIndex {
        target: BeatTarget,
        note_index: u32,
        patch: NoteTechniques,
    },
    SetNoteLink {
        from: NoteTarget,
        #[serde(deserialize_with = "required_nullable")]
        to: Option<NoteTarget>,
        kind: LinkKind,
    },
    SetNoteLinkByIndex {
        from: IndexedNoteTarget,
        #[serde(deserialize_with = "required_nullable")]
        to: Option<IndexedNoteTarget>,
        kind: LinkKind,
    },
    SetBeatTechniques {
        target: BeatTarget,
        patch: BeatTechniques,
    },
    SetBeatGestures {
        target: BeatTarget,
        patch: GesturePatch,
    },
    SetOttava {
        from: BeatTarget,
        to: BeatTarget,
        ottava: i32,
    },
    SetCrescendo {
        from: BeatTarget,
        to: BeatTarget,
        crescendo: i32,
        #[serde(deserialize_with = "required_nullable")]
        target_dynamics: Option<i32>,
    },
    SetFermata {
        target: BeatTarget,
        #[serde(deserialize_with = "required_nullable")]
        fermata: Option<Fermata>,
    },
    SetBeatRhythm {
        target: BeatTarget,
        duration: i32,
        dots: u8,
        tuplet_numerator: u32,
        tuplet_denominator: u32,
        grace_type: i32,
    },
    SetTrackInfo {
        track: u32,
        name: String,
        short_name: String,
        program: u8,
    },
    SetStaffSettings {
        track: u32,
        staff: u32,
        settings: StaffSettings,
    },
    AddStaff {
        track: u32,
        settings: StaffSettings,
    },
    RemoveStaff {
        track: u32,
        staff: u32,
    },
    AddVoice {
        track: u32,
        staff: u32,
    },
    RemoveVoice {
        track: u32,
        staff: u32,
        voice: u32,
    },
    CopyVoice {
        track: u32,
        staff: u32,
        source_voice: u32,
        destination_voice: u32,
        start_bar: u32,
        end_bar: u32,
    },
    SetTrackLayout {
        track: u32,
        bars_per_system: u32,
        line_breaks: Vec<u32>,
    },
    SetMeasureSettings {
        bar: u32,
        numerator: u32,
        denominator: u32,
        pickup: bool,
        free_time: bool,
        repeat_start: bool,
        repeat_count: u32,
        endings: Vec<u32>,
        section: String,
        tempos: Vec<TempoPoint>,
    },
    ReplaceTempoAutomations {
        points: Vec<RatioTempoPoint>,
    },
    SetBarNotation {
        track: u32,
        staff: u32,
        bar: u32,
        key_signature: i32,
        key_mode: i32,
        clef: i32,
    },
    SetBarGestures {
        track: u32,
        staff: u32,
        bar: u32,
        clef_ottava: i32,
    },
    SetMasterBarGestures {
        bar: u32,
        common_time: bool,
        double_bar: bool,
        triplet_feel: i32,
        #[serde(deserialize_with = "required_nullable")]
        beaming: Option<CustomBeaming>,
    },
    SetSimile {
        track: u32,
        staff: u32,
        bar: u32,
        kind: SimileKind,
    },
    SetBeatAnnotation {
        target: BeatTarget,
        text: String,
        #[serde(deserialize_with = "required_nullable")]
        chord: Option<ChordDefinition>,
    },
    SetBeatText {
        target: BeatTarget,
        text: String,
    },
    SetHarmonyChord {
        target: BeatTarget,
        #[serde(deserialize_with = "required_nullable")]
        chord: Option<HarmonyChord>,
        fill_empty_beat: bool,
    },
    TransposeHarmony {
        selection: MusicSelection,
        interval: HarmonyInterval,
        include_key_signatures: bool,
        include_chords: bool,
    },
    SetTrackSound {
        track_id: String,
        sound: TrackSound,
    },
    SetTrackMix {
        track_id: String,
        mix: ChannelMix,
    },
    SetBacking {
        #[serde(deserialize_with = "required_nullable")]
        backing: Option<BackingSettings>,
    },
    SetPrintLayout {
        layout: PrintLayout,
    },
    SetEngraving {
        engraving: EngravingOverrides,
    },
    SetPageLayout {
        layout: PageLayout,
    },
}

pub fn validate_tuning(tuning: &[i32]) -> Result<(), String> {
    if tuning.is_empty() || tuning.iter().any(|pitch| !(0..=127).contains(pitch)) {
        return Err("Tuning must contain MIDI pitches from 0 to 127.".into());
    }
    Ok(())
}
pub fn validate_tempo(tempo: f64) -> Result<(), String> {
    if !tempo.is_finite() || tempo <= 0.0 {
        return Err("Tempo must be a positive number.".into());
    }
    Ok(())
}
fn enum_range(value: i32, min: i32, max: i32) -> Result<(), String> {
    if !(min..=max).contains(&value) {
        return Err("Unsupported alphaTab enum value.".into());
    }
    Ok(())
}
fn rhythm(duration: i32, dots: u8) -> Result<(), String> {
    if ![-4, -2, 1, 2, 4, 8, 16, 32, 64, 128, 256].contains(&duration) || dots > 3 {
        return Err("Choose a supported duration and at most three dots.".into());
    }
    Ok(())
}
fn beat_range(from: &BeatTarget, to: &BeatTarget) -> Result<(), String> {
    if (to.track, to.staff, to.voice) != (from.track, from.staff, from.voice)
        || (to.bar, to.beat) < (from.bar, from.beat)
    {
        return Err("Select an ordered range in the same staff and voice.".into());
    }
    Ok(())
}
impl PitchCurve {
    fn validate(&self, max_type: i32) -> Result<(), String> {
        enum_range(self.r#type, 1, max_type)?;
        enum_range(self.style, 0, 2)?;
        if self.points.len() < 2
            || self.points.first().unwrap().offset != 0.0
            || self.points.last().unwrap().offset != 60.0
            || self.points.iter().any(|point| {
                !point.offset.is_finite()
                    || !(0.0..=60.0).contains(&point.offset)
                    || !point.value.is_finite()
                    || (max_type == 8 && point.value < 0.0)
            })
            || self
                .points
                .windows(2)
                .any(|pair| pair[0].offset >= pair[1].offset)
        {
            return Err("Pitch curves need sorted finite points from 0 to 60.".into());
        }
        Ok(())
    }
}
impl StaffSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.tuning.iter().any(|pitch| !(0..=127).contains(pitch))
            || self.capo > 127
            || !(-127..=127).contains(&self.transposition)
            || !(-127..=127).contains(&self.display_transposition)
            || (!self.show_tab && !self.show_notation)
        {
            return Err("Invalid staff settings.".into());
        }
        enum_range(self.clef, 0, 4)
    }
}
impl EditCommand {
    pub fn asset_id(&self) -> Option<&str> {
        match self {
            Self::SetBacking {
                backing: Some(backing),
            } => Some(&backing.asset_id),
            _ => None,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::MoveTrack { track, to } if track == to => {
                return Err("Choose a different track position.".into());
            }
            Self::ReplaceTempoAutomations { points } => {
                if points
                    .first()
                    .is_none_or(|point| point.bar != 0 || point.ratio != 0.0)
                    || points.iter().any(|point| {
                        !point.ratio.is_finite()
                            || !(0.0..=1.0).contains(&point.ratio)
                            || !point.bpm.is_finite()
                            || point.bpm <= 0.0
                    })
                    || points
                        .windows(2)
                        .any(|pair| (pair[0].bar, pair[0].ratio) >= (pair[1].bar, pair[1].ratio))
                {
                    return Err("Tempo replacement needs ordered distinct ratio points starting at bar 0 ratio 0.".into());
                }
            }
            Self::SetHarmonyChord {
                chord: Some(chord), ..
            } => chord.validate()?,
            Self::TransposeHarmony {
                selection,
                interval,
                include_key_signatures,
                include_chords,
            } => {
                selection.validate()?;
                interval.validate()?;
                if matches!(interval, HarmonyInterval::Diatonic { .. })
                    && (*include_key_signatures || *include_chords)
                {
                    return Err(
                        "Diatonic transposition cannot include key signatures or chords.".into(),
                    );
                }
            }
            Self::PasteMusic { clip, options } => {
                clip.validate()?;
                options.validate()?;
            }
            Self::EraseSelection { selection }
            | Self::TransposeSelection { selection, .. }
            | Self::MoveSelectionStrings { selection, .. }
            | Self::RefingerSelection { selection, .. }
            | Self::SetSelectionSustain { selection, .. } => {
                selection.validate()?;
                match self {
                    Self::TransposeSelection { semitones, .. }
                        if *semitones == 0 || !(-127..=127).contains(semitones) =>
                    {
                        return Err(
                            "Transpose by a nonzero semitone count from -127 to 127.".into()
                        );
                    }
                    Self::RefingerSelection { max_fret, .. } if !(1..=127).contains(max_fret) => {
                        return Err("Maximum fret must be from 1 to 127.".into());
                    }
                    Self::SetSelectionSustain { strings, .. } => {
                        let mut seen = HashSet::new();
                        if strings.is_empty()
                            || strings
                                .iter()
                                .any(|string| *string == 0 || !seen.insert(*string))
                        {
                            return Err("Select nonempty distinct positive strings.".into());
                        }
                    }
                    _ => {}
                }
            }
            Self::InsertMeasures { count, .. } if !(1..=1000).contains(count) => {
                return Err("Insert from 1 to 1000 measures.".into());
            }
            Self::RemoveMeasures {
                first_bar,
                last_bar,
            } if first_bar > last_bar => {
                return Err("Select an ordered inclusive measure range.".into());
            }
            Self::SetNote { string, .. }
            | Self::RemoveNote { string, .. }
            | Self::SetNoteTechniques { string, .. }
                if *string == 0 =>
            {
                return Err("Select a guitar string.".into());
            }
            Self::SetDuration { duration, dots, .. } | Self::InsertBeat { duration, dots, .. } => {
                rhythm(*duration, *dots)?
            }
            Self::SetBeatRhythm {
                duration,
                dots,
                tuplet_numerator,
                tuplet_denominator,
                grace_type,
                ..
            } => {
                rhythm(*duration, *dots)?;
                enum_range(*grace_type, 0, 3)?;
                if *tuplet_numerator == 0 || *tuplet_denominator == 0 {
                    return Err("Tuplet values must be positive.".into());
                }
            }
            Self::AddTrack {
                tuning, program, ..
            } => {
                validate_tuning(tuning)?;
                enum_range(*program as i32, 0, 127)?;
            }
            Self::SetTrackInfo { program, .. }
            | Self::AddPitchedTrack { program, .. }
            | Self::AddPercussionTrack { program, .. } => enum_range(*program as i32, 0, 127)?,
            Self::AddPitchedNote { pitch, .. } | Self::SetPitchedNote { pitch, .. } => {
                enum_range(*pitch as i32, 0, 127)?;
            }
            Self::AddPercussionNote { articulation, .. }
            | Self::SetPercussionNote { articulation, .. }
                if *articulation > i32::MAX as u32 =>
            {
                return Err("Invalid percussion articulation.".into());
            }
            Self::SetTuning { tuning, .. } => validate_tuning(tuning)?,
            Self::SetScoreInfo { tempo, .. } => validate_tempo(*tempo)?,
            Self::SetTrackLyrics { lines, .. } if lines.len() > 5 => {
                return Err("A track supports at most five lyric lines.".into());
            }
            Self::SetDirections { directions, .. } => {
                for direction in directions {
                    enum_range(*direction, 0, 18)?;
                }
            }
            Self::SetNoteSpelling {
                accidental_mode, ..
            } => enum_range(*accidental_mode, 0, 6)?,
            Self::SetNoteTechniques { patch, .. }
            | Self::SetNoteTechniquesByIndex { patch, .. } => {
                for (value, min, max) in [
                    (patch.accent, 0, 3),
                    (patch.dynamics, 0, 25),
                    (patch.left_finger, -2, 4),
                    (patch.right_finger, -2, 4),
                    (patch.slide_in, 0, 2),
                    (patch.slide_out, 0, 6),
                    (patch.vibrato, 0, 2),
                    (patch.ornament, 0, 4),
                ] {
                    if let Some(value) = value {
                        enum_range(value, min, max)?;
                    }
                }
                if let Some(Some(bend)) = &patch.bend {
                    bend.validate(8)?;
                }
                if let Some(Some(harmonic)) = &patch.harmonic {
                    enum_range(harmonic.r#type, 0, 6)?;
                    if !harmonic.value.is_finite() || harmonic.value < 0.0 {
                        return Err("Invalid harmonic value.".into());
                    }
                }
                if let Some(Some(trill)) = &patch.trill {
                    enum_range(trill.pitch, 0, 127)?;
                    rhythm(trill.speed, 0)?;
                }
            }
            Self::SetBeatTechniques { patch, .. } => {
                if let Some(pick) = patch.pick_stroke {
                    enum_range(pick, 0, 2)?;
                }
                if let Some(brush) = patch.brush_type {
                    enum_range(brush, 0, 4)?;
                }
                if patch
                    .brush_duration
                    .is_some_and(|duration| !duration.is_finite() || duration < 0.0)
                {
                    return Err("Invalid brush duration.".into());
                }
                if let Some(Some(whammy)) = &patch.whammy {
                    whammy.validate(6)?;
                }
                if let Some(Some(tremolo)) = &patch.tremolo {
                    rhythm(tremolo.speed, 0)?;
                    enum_range(tremolo.style, 0, 1)?;
                }
            }
            Self::SetBeatGestures { patch, .. } => {
                if patch == &GesturePatch::default() {
                    return Err("Choose at least one beat gesture.".into());
                }
                for (value, max) in [
                    (patch.golpe, 2),
                    (patch.rasgueado, 18),
                    (patch.fade, 3),
                    (patch.vibrato, 2),
                    (patch.beaming_mode, 3),
                    (patch.wah_pedal, 2),
                ] {
                    if let Some(value) = value {
                        enum_range(value, 0, max)?;
                    }
                }
                if let Some(Some(barre)) = &patch.barre {
                    if !(1..=127).contains(&barre.fret) {
                        return Err("A barre fret must be from 1 to 127.".into());
                    }
                    enum_range(barre.shape, 1, 2)?;
                }
            }
            Self::SetOttava { from, to, ottava } => {
                beat_range(from, to)?;
                enum_range(*ottava, 0, 4)?;
            }
            Self::SetCrescendo {
                from,
                to,
                crescendo,
                target_dynamics,
            } => {
                beat_range(from, to)?;
                enum_range(*crescendo, 0, 2)?;
                match (crescendo, target_dynamics) {
                    (0, None) => {}
                    (1 | 2, Some(dynamics)) => enum_range(*dynamics, 0, 7)?,
                    _ => {
                        return Err("A hairpin needs a target dynamic; clearing needs null.".into());
                    }
                }
            }
            Self::SetFermata {
                fermata: Some(fermata),
                ..
            } => {
                enum_range(fermata.r#type, 0, 2)?;
                // Guitar Pro stores fermatas of length 0.
                if !fermata.length.is_finite() || fermata.length < 0.0 {
                    return Err("Fermata length must be a finite number of 0 or more.".into());
                }
            }
            Self::SetNoteLink { from, to, kind } => {
                if from.string == 0 {
                    return Err("Select a guitar string.".into());
                }
                if let Some(to) = to {
                    if to.string == 0
                        || (kind != &LinkKind::Slur && to.string != from.string)
                        || (to.target.track, to.target.staff, to.target.voice)
                            != (from.target.track, from.target.staff, from.target.voice)
                        || (to.target.bar, to.target.beat) <= (from.target.bar, from.target.beat)
                    {
                        return Err("Links need a later note in the same staff and voice.".into());
                    }
                }
            }
            Self::SetNoteLinkByIndex {
                from, to: Some(to), ..
            } => {
                if (to.target.track, to.target.staff, to.target.voice)
                    != (from.target.track, from.target.staff, from.target.voice)
                    || (to.target.bar, to.target.beat) <= (from.target.bar, from.target.beat)
                {
                    return Err("Links need a later note in the same staff and voice.".into());
                }
            }
            Self::SetStaffSettings { settings, .. } | Self::AddStaff { settings, .. } => {
                settings.validate()?
            }
            Self::RemoveVoice { voice, .. } if *voice > 3 => {
                return Err("A staff supports at most four voices.".into());
            }
            Self::CopyVoice {
                source_voice,
                destination_voice,
                start_bar,
                end_bar,
                ..
            } if *source_voice > 3
                || *destination_voice > 3
                || source_voice == destination_voice
                || start_bar > end_bar =>
            {
                return Err("Invalid voice copy range.".into());
            }
            Self::SetTrackLayout {
                bars_per_system, ..
            } if *bars_per_system == 0 => return Err("A system needs at least one bar.".into()),
            Self::SetTrackColor { color, .. }
                if color.len() != 7
                    || !color.starts_with('#')
                    || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) =>
            {
                return Err("Choose a track color as #rrggbb.".into());
            }
            Self::SetMeasureSettings {
                numerator,
                denominator,
                endings,
                tempos,
                ..
            } => {
                if *numerator == 0
                    || !denominator.is_power_of_two()
                    || *denominator > 256
                    || endings.iter().any(|ending| !(1..=8).contains(ending))
                {
                    return Err("Invalid meter or alternate endings.".into());
                }
                for tempo in tempos {
                    validate_tempo(tempo.bpm)?;
                }
                if tempos.windows(2).any(|pair| pair[0].beat >= pair[1].beat) {
                    return Err("Tempo positions must be sorted and distinct.".into());
                }
            }
            Self::SetBarNotation {
                key_signature,
                key_mode,
                clef,
                ..
            } => {
                enum_range(*key_signature, -7, 7)?;
                enum_range(*key_mode, 0, 1)?;
                enum_range(*clef, 0, 4)?;
            }
            Self::SetBarGestures { clef_ottava, .. } => enum_range(*clef_ottava, 0, 4)?,
            Self::SetMasterBarGestures {
                triplet_feel,
                beaming,
                ..
            } => {
                enum_range(*triplet_feel, 0, 6)?;
                if let Some(beaming) = beaming {
                    if ![8, 16, 32].contains(&beaming.unit)
                        || beaming.groups.is_empty()
                        || beaming
                            .groups
                            .iter()
                            .any(|group| !(1..=9_007_199_254_740_991).contains(group))
                    {
                        return Err(
                            "Beaming needs a supported unit and positive safe groups.".into()
                        );
                    }
                }
            }
            Self::SetBeatAnnotation {
                chord: Some(chord), ..
            } if chord.frets.is_empty() || chord.frets.iter().any(|fret| *fret < -1) => {
                return Err("Invalid chord diagram.".into());
            }
            Self::SetTrackSound { track_id, sound } => {
                if track_id.is_empty() {
                    return Err("Track identity is required.".into());
                }
                sound.validate()?;
            }
            Self::SetTrackMix { track_id, mix } => {
                if track_id.is_empty() {
                    return Err("Track identity is required.".into());
                }
                mix.validate()?;
            }
            Self::SetBacking {
                backing: Some(backing),
            } => backing.validate()?,
            Self::SetPrintLayout { layout } => layout.validate()?,
            Self::SetEngraving { engraving } => engraving.validate()?,
            Self::SetPageLayout { layout } => layout.validate()?,
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::EditCommand;
    use serde_json::{Value, json};

    fn clipboard_command() -> Value {
        json!({"type": "pasteMusic", "clip": {
            "format": "TabPlayerClip", "version": 1, "engineVersion": "1.8.4",
            "mode": "singleTrack", "kind": "phrase", "scoreJson": "{\"tracks\":[]}",
            "links": [{"from": 0, "to": 1, "kind": "tie", "slideOutType": null}]
        }, "options": {
            "target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0},
            "destinations": [{"sourceTrack": 0, "track": 1, "staffMap": [0]}],
            "count": 1, "placement": "currentBar", "filters": {
                "diagrams": true, "texts": false, "timers": true, "trackAutomations": false,
                "masterAutomations": false, "sections": false
            }
        }})
    }

    #[test]
    fn clipboard_command_roundtrips_phrase_and_multitrack_bars() {
        let value = clipboard_command();
        assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        let mut bars = value;
        bars["clip"]["mode"] = json!("multiTrack");
        bars["clip"]["kind"] = json!("bars");
        bars["clip"]["links"] = json!([]);
        bars["options"]["placement"] = json!("beforeBar");
        bars["options"]["count"] = json!(1000);
        bars["options"]["destinations"] = json!([
            {"sourceTrack": 0, "track": 2, "staffMap": [1, 0]},
            {"sourceTrack": 1, "track": 3, "staffMap": [0]}
        ]);
        bars["options"]["filters"]["masterAutomations"] = json!(true);
        bars["options"]["filters"]["sections"] = json!(true);
        assert_eq!(serde_json::to_value(accepted(&bars)).unwrap(), bars);
    }

    #[test]
    fn clipboard_envelopes_require_all_fields_and_reject_unknown_fields() {
        let value = clipboard_command();
        accepted(&value);
        for path in [
            "",
            "/clip",
            "/clip/links/0",
            "/options",
            "/options/target",
            "/options/destinations/0",
            "/options/filters",
        ] {
            let mut unknown = value.clone();
            unknown.pointer_mut(path).unwrap()["unexpected"] = json!(true);
            rejected(&unknown);
            for field in value.pointer(path).unwrap().as_object().unwrap().keys() {
                let mut missing = value.clone();
                missing
                    .pointer_mut(path)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
                rejected(&missing);
            }
        }
    }

    #[test]
    fn clipboard_pins_format_version_engine_and_named_modes() {
        let original = clipboard_command();
        for (path, invalid) in [
            (
                "/clip/format",
                vec![json!("TabPlayer"), json!(1), json!(null)],
            ),
            (
                "/clip/version",
                vec![json!(0), json!(2), json!(1.5), json!("1"), json!(null)],
            ),
            (
                "/clip/engineVersion",
                vec![json!("1.8.3"), json!(1.8), json!(null)],
            ),
            (
                "/clip/mode",
                vec![json!("track"), json!({"singleTrack": null}), json!(null)],
            ),
            (
                "/clip/kind",
                vec![json!("notes"), json!({"phrase": null}), json!(null)],
            ),
            (
                "/options/placement",
                vec![json!("afterBar"), json!({"currentBar": null}), json!(null)],
            ),
        ] {
            for invalid in invalid {
                let mut value = original.clone();
                *value.pointer_mut(path).unwrap() = invalid;
                rejected(&value);
            }
        }
    }

    #[test]
    fn clipboard_links_require_nullable_slide_type_and_unsigned_endpoints() {
        let original = clipboard_command();
        for kind in ["tie", "slur", "hammerPull", "slide"] {
            let mut value = original.clone();
            value["clip"]["links"][0]["kind"] = json!(kind);
            value["clip"]["links"][0]["slideOutType"] = if kind == "slide" {
                json!(1)
            } else {
                json!(null)
            };
            accepted(&value);
            if kind == "slide" {
                value["clip"]["links"][0]["slideOutType"] = json!(2);
                accepted(&value);
            }
            for invalid in [
                json!(0),
                json!(3),
                json!(1.5),
                json!("1"),
                json!({"shift": null}),
            ] {
                value["clip"]["links"][0]["slideOutType"] = invalid;
                rejected(&value);
            }
            value["clip"]["links"][0]["slideOutType"] = if kind == "slide" {
                json!(null)
            } else {
                json!(1)
            };
            rejected(&value);
        }
        for path in ["/clip/links/0/from", "/clip/links/0/to"] {
            let mut value = original.clone();
            *value.pointer_mut(path).unwrap() = json!(u32::MAX);
            accepted(&value);
            for invalid in [json!(-1), json!(4294967296_u64), json!(0.5), json!(null)] {
                *value.pointer_mut(path).unwrap() = invalid;
                rejected(&value);
            }
        }
        for invalid in [json!("bend"), json!({"tie": null}), json!(null)] {
            let mut value = original.clone();
            value["clip"]["links"][0]["kind"] = invalid;
            rejected(&value);
        }
        let mut duplicate = original.clone();
        let links = duplicate["clip"]["links"].as_array_mut().unwrap();
        links.push(links[0].clone());
        rejected(&duplicate);
        duplicate["clip"]["links"][1]["from"] = json!(1);
        duplicate["clip"]["links"][1]["to"] = json!(2);
        accepted(&duplicate);
    }

    #[test]
    fn clipboard_destinations_and_staff_maps_are_nonempty_and_unique() {
        let original = clipboard_command();
        for path in ["/options/destinations", "/options/destinations/0/staffMap"] {
            for invalid in [json!([]), json!(null), json!({})] {
                let mut value = original.clone();
                *value.pointer_mut(path).unwrap() = invalid;
                rejected(&value);
            }
        }
        let mut value = original.clone();
        value["clip"]["kind"] = json!("bars");
        value["clip"]["mode"] = json!("multiTrack");
        value["options"]["placement"] = json!("beforeBar");
        let mapping = value["options"]["destinations"][0].clone();
        value["options"]["destinations"] = json!([mapping, mapping]);
        rejected(&value);
        value["options"]["destinations"][1]["track"] = json!(2);
        rejected(&value);
        value["options"]["destinations"][1]["track"] = json!(1);
        value["options"]["destinations"][1]["sourceTrack"] = json!(1);
        rejected(&value);
        value["options"]["destinations"][1]["track"] = json!(2);
        accepted(&value);
        value["options"]["destinations"][0]["staffMap"] = json!([0, 0]);
        rejected(&value);
        value["options"]["destinations"][0]["staffMap"] = json!([1, 0]);
        accepted(&value);
    }

    #[test]
    fn clipboard_destination_indices_count_and_filters_have_strict_domains() {
        let original = clipboard_command();
        for path in [
            "/options/target/track",
            "/options/target/staff",
            "/options/target/bar",
            "/options/target/voice",
            "/options/target/beat",
            "/options/destinations/0/sourceTrack",
            "/options/destinations/0/track",
            "/options/destinations/0/staffMap/0",
        ] {
            let mut value = original.clone();
            *value.pointer_mut(path).unwrap() = json!(u32::MAX);
            accepted(&value);
            for invalid in [json!(-1), json!(4294967296_u64), json!(0.5), json!(null)] {
                *value.pointer_mut(path).unwrap() = invalid;
                rejected(&value);
            }
        }
        for count in [json!(0), json!(1001), json!(-1), json!(0.5), json!(null)] {
            let mut value = original.clone();
            value["options"]["count"] = count;
            rejected(&value);
        }
        for field in [
            "diagrams",
            "texts",
            "timers",
            "trackAutomations",
            "masterAutomations",
            "sections",
        ] {
            for flag in [true, false] {
                let mut value = original.clone();
                value["options"]["filters"][field] = json!(flag);
                accepted(&value);
            }
            for invalid in [json!(0), json!(1), json!("true"), json!(null)] {
                let mut value = original.clone();
                value["options"]["filters"][field] = invalid;
                rejected(&value);
            }
        }
    }

    #[test]
    fn clipboard_score_json_requires_valid_json_object() {
        for source in ["{}", "{\"tracks\":[],\"text\":\"♫ café\"}", " { }\r\n"] {
            let mut value = clipboard_command();
            value["clip"]["scoreJson"] = json!(source);
            accepted(&value);
        }
        for source in [
            "",
            "{",
            "{}[]",
            "[]",
            "null",
            "1",
            "\"score\"",
            "{\"tempo\":NaN}",
            "{\"tempo\":1e999}",
        ] {
            let mut value = clipboard_command();
            value["clip"]["scoreJson"] = json!(source);
            rejected(&value);
        }
    }

    #[test]
    fn clipboard_score_json_budget_counts_utf8_bytes() {
        for (extra, valid) in [("", true), (" ", false)] {
            let mut value = clipboard_command();
            let source = format!("{{\"text\":\"{}\"}} {extra}", "é".repeat(63_999_994));
            assert_eq!(source.len(), 128_000_000 + extra.len());
            value["clip"]["scoreJson"] = Value::String(source);
            let command: EditCommand = serde_json::from_value(value).unwrap();
            assert_eq!(command.validate().is_ok(), valid);
        }
    }

    fn music_selections() -> Vec<Value> {
        vec![
            json!({"kind": "range", "range": {
                "start": {"bar": 0, "tick": 0}, "end": {"bar": 0, "tick": 960},
                "lanes": [{"track": 0, "staff": 0, "voice": 0}]
            }}),
            json!({"kind": "notes", "notes": [{
                "target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0},
                "noteIndex": 0
            }]}),
            json!({"kind": "bars", "tracks": [0], "firstBar": 0, "lastBar": 0}),
        ]
    }

    fn range_measure_commands() -> Vec<Value> {
        let mut commands = Vec::new();
        for selection in music_selections() {
            commands.extend([
                json!({"type": "eraseSelection", "selection": selection}),
                json!({"type": "transposeSelection", "selection": selection, "semitones": 12}),
                json!({"type": "moveSelectionStrings", "selection": selection, "direction": "higher"}),
                json!({"type": "refingerSelection", "selection": selection, "maxFret": 24}),
                json!({"type": "setSelectionSustain", "selection": selection,
                    "strings": [1, 3], "kind": "letRing", "enabled": false}),
            ]);
        }
        commands.extend([
            json!({"type": "insertMeasures", "beforeBar": 0, "count": 1}),
            json!({"type": "removeMeasures", "firstBar": 0, "lastBar": 0}),
        ]);
        commands
    }

    #[test]
    fn range_measure_commands_roundtrip_all_selection_variants() {
        for value in range_measure_commands() {
            assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        }
    }

    #[test]
    fn range_measure_commands_require_every_field_and_exact_envelopes() {
        for value in range_measure_commands() {
            accepted(&value);
            let mut unknown = value.clone();
            unknown["unexpected"] = json!(true);
            rejected(&unknown);
            for field in value.as_object().unwrap().keys() {
                let mut missing = value.clone();
                missing.as_object_mut().unwrap().remove(field);
                rejected(&missing);
            }
        }
    }

    #[test]
    fn music_selection_nested_objects_require_exact_complete_shapes() {
        for selection in music_selections() {
            let value = json!({"type": "eraseSelection", "selection": selection});
            accepted(&value);
            let mut paths = vec!["/selection"];
            match value["selection"]["kind"].as_str().unwrap() {
                "range" => paths.extend([
                    "/selection/range",
                    "/selection/range/start",
                    "/selection/range/end",
                    "/selection/range/lanes/0",
                ]),
                "notes" => paths.extend(["/selection/notes/0", "/selection/notes/0/target"]),
                _ => {}
            }
            for path in paths {
                let mut unknown = value.clone();
                unknown.pointer_mut(path).unwrap()["unexpected"] = json!(true);
                rejected(&unknown);
                for field in value.pointer(path).unwrap().as_object().unwrap().keys() {
                    let mut missing = value.clone();
                    missing
                        .pointer_mut(path)
                        .unwrap()
                        .as_object_mut()
                        .unwrap()
                        .remove(field);
                    rejected(&missing);
                }
            }
        }
        for invalid in [
            json!(null),
            json!({}),
            json!("notes"),
            json!({"kind": "beats"}),
        ] {
            rejected(&json!({"type": "eraseSelection", "selection": invalid}));
        }
        rejected(&json!({"type": "eraseSelection", "selection": {
            "kind": "bars", "tracks": [0], "firstBar": 0, "lastBar": 0, "notes": []
        }}));
    }

    #[test]
    fn music_selection_indices_and_ticks_use_unsigned_32_bit_domain() {
        let selections = music_selections();
        let paths = [
            (0, "/selection/range/start/bar"),
            (0, "/selection/range/start/tick"),
            (0, "/selection/range/end/bar"),
            (0, "/selection/range/end/tick"),
            (0, "/selection/range/lanes/0/track"),
            (0, "/selection/range/lanes/0/staff"),
            (0, "/selection/range/lanes/0/voice"),
            (1, "/selection/notes/0/noteIndex"),
            (1, "/selection/notes/0/target/track"),
            (1, "/selection/notes/0/target/staff"),
            (1, "/selection/notes/0/target/bar"),
            (1, "/selection/notes/0/target/voice"),
            (1, "/selection/notes/0/target/beat"),
            (2, "/selection/tracks/0"),
            (2, "/selection/firstBar"),
            (2, "/selection/lastBar"),
        ];
        for (index, path) in paths {
            for invalid in [
                json!(-1),
                json!(4294967296_u64),
                json!(0.5),
                json!(null),
                json!("0"),
            ] {
                let mut value = json!({"type": "eraseSelection", "selection": selections[index]});
                *value.pointer_mut(path).unwrap() = invalid;
                rejected(&value);
            }
        }
        for selection in [
            json!({"kind": "range", "range": {
                "start": {"bar": u32::MAX, "tick": 0},
                "end": {"bar": u32::MAX, "tick": u32::MAX},
                "lanes": [{"track": u32::MAX, "staff": u32::MAX, "voice": u32::MAX}]
            }}),
            json!({"kind": "notes", "notes": [{"noteIndex": u32::MAX, "target": {
                "track": u32::MAX, "staff": u32::MAX, "bar": u32::MAX,
                "voice": u32::MAX, "beat": u32::MAX
            }}]}),
            json!({"kind": "bars", "tracks": [u32::MAX], "firstBar": u32::MAX, "lastBar": u32::MAX}),
        ] {
            accepted(&json!({"type": "eraseSelection", "selection": selection}));
        }
    }

    #[test]
    fn music_selection_collections_are_nonempty_and_unique() {
        for (index, path) in [
            (0, "/selection/range/lanes"),
            (1, "/selection/notes"),
            (2, "/selection/tracks"),
        ] {
            let selection = music_selections().remove(index);
            let value = json!({"type": "eraseSelection", "selection": selection});
            accepted(&value);
            for invalid in [json!([]), json!(null), json!({})] {
                let mut empty = value.clone();
                *empty.pointer_mut(path).unwrap() = invalid;
                rejected(&empty);
            }
            let mut duplicate = value.clone();
            let items = duplicate.pointer_mut(path).unwrap().as_array_mut().unwrap();
            items.push(items[0].clone());
            rejected(&duplicate);
            let mut distinct = value.clone();
            let items = distinct.pointer_mut(path).unwrap().as_array_mut().unwrap();
            let mut item = items[0].clone();
            match index {
                0 => item["voice"] = json!(1),
                1 => item["noteIndex"] = json!(1),
                _ => item = json!(1),
            }
            items.push(item);
            accepted(&distinct);
        }
        let mut distinct = range_measure_commands().remove(5);
        let items = distinct["selection"]["notes"].as_array_mut().unwrap();
        let mut item = items[0].clone();
        item["target"]["beat"] = json!(1);
        items.push(item);
        accepted(&distinct);
    }

    #[test]
    fn music_ranges_are_half_open_but_bar_selections_are_inclusive() {
        let mut value = range_measure_commands().remove(0);
        value["selection"]["range"]["end"] = json!({"bar": 0, "tick": 0});
        rejected(&value);
        value["selection"]["range"]["start"] = json!({"bar": 1, "tick": 0});
        rejected(&value);
        value["selection"]["range"]["start"] = json!({"bar": 0, "tick": 961});
        value["selection"]["range"]["end"] = json!({"bar": 0, "tick": 960});
        rejected(&value);
        value["selection"]["range"]["end"] = json!({"bar": 1, "tick": 0});
        accepted(&value);
        let mut bars = range_measure_commands().remove(10);
        accepted(&bars);
        bars["selection"]["firstBar"] = json!(1);
        rejected(&bars);
        bars["selection"]["lastBar"] = json!(1);
        accepted(&bars);
    }

    #[test]
    fn range_commands_enforce_shift_fret_and_strict_string_modes() {
        let commands = range_measure_commands();
        for (index, field, valid, invalid) in [
            (
                1,
                "semitones",
                vec![json!(-127), json!(-1), json!(1), json!(127)],
                vec![json!(-128), json!(0), json!(128), json!(0.5), json!(null)],
            ),
            (
                3,
                "maxFret",
                vec![json!(1), json!(127)],
                vec![json!(-1), json!(0), json!(128), json!(0.5), json!(null)],
            ),
            (
                2,
                "direction",
                vec![json!("higher"), json!("lower")],
                vec![json!("up"), json!(0), json!(null), json!({"higher": null})],
            ),
            (
                4,
                "kind",
                vec![json!("letRing"), json!("palmMute")],
                vec![
                    json!("sustain"),
                    json!(0),
                    json!(null),
                    json!({"letRing": null}),
                ],
            ),
            (
                4,
                "enabled",
                vec![json!(false), json!(true)],
                vec![json!(0), json!(1), json!("true"), json!(null)],
            ),
        ] {
            for candidate in valid {
                let mut value = commands[index].clone();
                value[field] = candidate;
                accepted(&value);
            }
            for candidate in invalid {
                let mut value = commands[index].clone();
                value[field] = candidate;
                rejected(&value);
            }
        }
        for strings in [json!([1]), json!([u32::MAX]), json!([2, 1])] {
            let mut value = commands[4].clone();
            value["strings"] = strings;
            accepted(&value);
        }
        for strings in [
            json!([]),
            json!([1, 1]),
            json!([0]),
            json!([-1]),
            json!([0.5]),
            json!([4294967296_u64]),
            json!([null]),
            json!(null),
        ] {
            let mut value = commands[4].clone();
            value["strings"] = strings;
            rejected(&value);
        }
    }

    #[test]
    fn measure_commands_enforce_bounded_count_and_ordered_unsigned_indices() {
        let commands = range_measure_commands();
        for (index, field) in [(15, "beforeBar"), (16, "firstBar"), (16, "lastBar")] {
            for invalid in [json!(-1), json!(4294967296_u64), json!(0.5), json!(null)] {
                let mut value = commands[index].clone();
                value[field] = invalid;
                rejected(&value);
            }
        }
        for count in [1, 1000] {
            accepted(&json!({"type": "insertMeasures", "beforeBar": u32::MAX, "count": count}));
        }
        for count in [json!(-1), json!(0), json!(1001), json!(0.5), json!(null)] {
            rejected(&json!({"type": "insertMeasures", "beforeBar": 0, "count": count}));
        }
        accepted(&json!({"type": "removeMeasures", "firstBar": u32::MAX, "lastBar": u32::MAX}));
        rejected(&json!({"type": "removeMeasures", "firstBar": 1, "lastBar": 0}));
    }

    fn lyrics_notation_commands() -> Vec<Value> {
        let target = json!({"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0});
        let end = json!({"track": 0, "staff": 0, "bar": 1, "voice": 0, "beat": 3});
        vec![
            json!({"type": "setTrackLyrics", "track": 0, "visible": true,
                "lines": [{"startBar": 0, "text": "[VERSE] Hel-lo  world+today\n"}]}),
            json!({"type": "setBeatGestures", "target": target, "patch": {"tap": false,
                "slap": true, "pop": true, "deadSlapped": false, "golpe": 2,
                "rasgueado": 18, "fade": 3, "vibrato": 2, "slashed": false,
                "showTimer": true, "barre": {"fret": 127, "shape": 2},
                "stem": "inverted", "beamingMode": 3, "wahPedal": 2}}),
            json!({"type": "setOttava", "from": target, "to": end, "ottava": 4}),
            json!({"type": "setCrescendo", "from": target, "to": end,
                "crescendo": 1, "targetDynamics": 6}),
            json!({"type": "setFermata", "target": target, "fermata": {"type": 2, "length": 1.5}}),
            json!({"type": "setBarGestures", "track": 0, "staff": 0, "bar": 0, "clefOttava": 1}),
            json!({"type": "setMasterBarGestures", "bar": 0, "commonTime": false,
                "doubleBar": true, "tripletFeel": 6, "beaming": {"unit": 8, "groups": [2, 2, 3]}}),
            json!({"type": "setSimile", "track": 0, "staff": 0, "bar": 2, "kind": "double"}),
        ]
    }

    #[test]
    fn lyrics_notation_commands_roundtrip_exact_payloads_and_explicit_clears() {
        for value in lyrics_notation_commands() {
            assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        }
        let commands = lyrics_notation_commands();
        for (index, field, clear) in [
            (0, "lines", json!([])),
            (1, "patch", json!({"barre": null})),
            (3, "targetDynamics", json!(null)),
            (4, "fermata", json!(null)),
            (6, "beaming", json!(null)),
        ] {
            let mut value = commands[index].clone();
            value[field] = clear;
            if index == 3 {
                value["crescendo"] = json!(0);
            }
            assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        }
    }

    #[test]
    fn lyrics_notation_commands_require_all_envelope_fields_and_reject_unknowns() {
        for value in lyrics_notation_commands() {
            accepted(&value);
            let mut unknown = value.clone();
            unknown["unexpected"] = json!(true);
            rejected(&unknown);
            for field in value.as_object().unwrap().keys() {
                let mut missing = value.clone();
                missing.as_object_mut().unwrap().remove(field);
                rejected(&missing);
            }
        }
    }

    #[test]
    fn lyrics_notation_lyrics_preserve_five_slots_and_require_exact_line_shape() {
        let mut value = lyrics_notation_commands().remove(0);
        value["visible"] = json!(false);
        value["lines"] = json!([
            {"startBar": 0, "text": ""}, {"startBar": 1, "text": "a--b"},
            {"startBar": 2, "text": "a\n\nb"}, {"startBar": 3, "text": "A&B <C>"},
            {"startBar": 4294967295_u64, "text": "♪"}
        ]);
        assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        let mut six = value.clone();
        six["lines"]
            .as_array_mut()
            .unwrap()
            .push(json!({"startBar": 0, "text": "six"}));
        rejected(&six);
        for line in [
            json!({"startBar": 0}),
            json!({"text": ""}),
            json!({"startBar": 0, "text": "", "visible": true}),
            json!({"startBar": 0, "text": null}),
            json!({"startBar": 0, "text": 1}),
            json!({"startBar": -1, "text": ""}),
            json!({"startBar": 0.5, "text": ""}),
            json!({"startBar": 4294967296_u64, "text": ""}),
        ] {
            value["lines"] = json!([line]);
            rejected(&value);
        }
        value["lines"] = json!([]);
        for invalid in [json!(null), json!(0), json!("false")] {
            value["visible"] = invalid;
            rejected(&value);
        }
    }

    #[test]
    fn lyrics_notation_targets_require_exact_uint32_indices() {
        for value in lyrics_notation_commands() {
            for field in ["track", "staff", "bar"] {
                if value.get(field).is_some() {
                    let mut maximum = value.clone();
                    maximum[field] = json!(u32::MAX);
                    accepted(&maximum);
                    for invalid in [json!(-1), json!(0.5), json!(4294967296_u64), json!(null)] {
                        let mut invalid_value = value.clone();
                        invalid_value[field] = invalid;
                        rejected(&invalid_value);
                    }
                }
            }
            for nested in ["target", "from", "to"] {
                if value.get(nested).is_some() {
                    let mut unknown = value.clone();
                    unknown[nested]["unexpected"] = json!(0);
                    rejected(&unknown);
                    for field in ["track", "staff", "bar", "voice", "beat"] {
                        let mut missing = value.clone();
                        missing[nested].as_object_mut().unwrap().remove(field);
                        rejected(&missing);
                        for invalid in [json!(-1), json!(0.5), json!(4294967296_u64), json!(null)] {
                            let mut invalid_value = value.clone();
                            invalid_value[nested][field] = invalid;
                            rejected(&invalid_value);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn lyrics_notation_gesture_patch_validates_every_optional_flag_and_enum() {
        let mut value = lyrics_notation_commands().remove(1);
        for field in ["tap", "slap", "pop", "deadSlapped", "slashed", "showTimer"] {
            for valid in [true, false] {
                value["patch"] = json!({field: valid});
                accepted(&value);
            }
            for invalid in [json!(null), json!(0), json!("true")] {
                value["patch"] = json!({field: invalid});
                rejected(&value);
            }
        }
        for (field, max) in [
            ("golpe", 2),
            ("rasgueado", 18),
            ("fade", 3),
            ("vibrato", 2),
            ("beamingMode", 3),
            ("wahPedal", 2),
        ] {
            for valid in 0..=max {
                value["patch"] = json!({field: valid});
                accepted(&value);
            }
            for invalid in [
                json!(-1),
                json!(max + 1),
                json!(0.5),
                json!(null),
                json!(true),
            ] {
                value["patch"] = json!({field: invalid});
                rejected(&value);
            }
        }
        for patch in [json!({}), json!({"unexpected": true}), json!(null)] {
            value["patch"] = patch;
            rejected(&value);
        }
    }

    #[test]
    fn lyrics_notation_barre_distinguishes_omission_clear_and_exact_value() {
        let mut value = lyrics_notation_commands().remove(1);
        for patch in [
            json!({"tap": false}),
            json!({"barre": null}),
            json!({"barre": {"fret": 1, "shape": 1}}),
            json!({"barre": {"fret": 127, "shape": 2}}),
        ] {
            value["patch"] = patch;
            assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        }
        for barre in [
            json!({}),
            json!({"fret": 1}),
            json!({"shape": 1}),
            json!({"fret": 1, "shape": 1, "unexpected": false}),
            json!({"fret": 0, "shape": 1}),
            json!({"fret": 128, "shape": 1}),
            json!({"fret": 0.5, "shape": 1}),
            json!({"fret": 1, "shape": 0}),
            json!({"fret": 1, "shape": 3}),
            json!({"fret": 1, "shape": null}),
        ] {
            value["patch"] = json!({"barre": barre});
            rejected(&value);
        }
    }

    #[test]
    fn lyrics_notation_stem_and_simile_accept_only_named_modes() {
        let mut gesture = lyrics_notation_commands().remove(1);
        for mode in ["auto", "inverted", "up", "down"] {
            gesture["patch"] = json!({"stem": mode});
            accepted(&gesture);
        }
        for invalid in [json!("left"), json!(0), json!(null), json!({"auto": null})] {
            gesture["patch"] = json!({"stem": invalid});
            rejected(&gesture);
        }
        let mut simile = lyrics_notation_commands().pop().unwrap();
        for mode in ["none", "single", "double"] {
            simile["kind"] = json!(mode);
            accepted(&simile);
        }
        for invalid in [
            json!("firstOfDouble"),
            json!(0),
            json!(null),
            json!({"none": null}),
        ] {
            simile["kind"] = invalid;
            rejected(&simile);
        }
    }

    #[test]
    fn lyrics_notation_ranges_require_ordered_same_staff_voice_endpoints() {
        for mut value in lyrics_notation_commands()
            .into_iter()
            .filter(|value| value.get("from").is_some())
        {
            accepted(&value);
            for field in ["track", "staff", "voice"] {
                let mut other_voice = value.clone();
                other_voice["to"][field] = json!(1);
                rejected(&other_voice);
            }
            value["to"] = value["from"].clone();
            accepted(&value);
            value["from"]["beat"] = json!(1);
            rejected(&value);
            value["to"]["bar"] = json!(1);
            accepted(&value);
            value["from"]["bar"] = json!(2);
            rejected(&value);
        }
    }

    #[test]
    fn lyrics_notation_crescendo_requires_target_for_nonzero_and_null_for_clear() {
        let mut value = lyrics_notation_commands().remove(3);
        for mode in [1, 2] {
            value["crescendo"] = json!(mode);
            for dynamic in 0..=7 {
                value["targetDynamics"] = json!(dynamic);
                accepted(&value);
            }
            for invalid in [json!(-1), json!(8), json!(0.5), json!(null)] {
                value["targetDynamics"] = invalid;
                rejected(&value);
            }
        }
        value["crescendo"] = json!(0);
        value["targetDynamics"] = json!(null);
        accepted(&value);
        value["targetDynamics"] = json!(0);
        rejected(&value);
        for invalid in [json!(-1), json!(3), json!(0.5), json!(null)] {
            value["crescendo"] = invalid;
            rejected(&value);
        }
    }

    #[test]
    fn lyrics_notation_fermata_requires_exact_shape_non_negative_length_and_valid_type() {
        let mut value = lyrics_notation_commands().remove(4);
        for kind in 0..=2 {
            for length in [0.0, 0.01] {
                value["fermata"] = json!({"type": kind, "length": length});
                accepted(&value);
            }
        }
        for invalid in [
            json!({}),
            json!({"type": 0}),
            json!({"length": 1}),
            json!({"type": 0, "length": 1, "unexpected": true}),
            json!({"type": -1, "length": 1}),
            json!({"type": 3, "length": 1}),
            json!({"type": 0.5, "length": 1}),
            json!({"type": 0, "length": -1}),
            json!({"type": 0, "length": null}),
            json!({"type": 0, "length": "1"}),
        ] {
            value["fermata"] = invalid;
            rejected(&value);
        }
    }

    #[test]
    fn lyrics_notation_beaming_requires_supported_unit_positive_safe_groups_and_exact_shape() {
        let mut value = lyrics_notation_commands().remove(6);
        for unit in [8, 16, 32] {
            value["beaming"] = json!({"unit": unit, "groups": [1, 9_007_199_254_740_991_u64]});
            accepted(&value);
        }
        for invalid in [
            json!({}),
            json!({"unit": 8}),
            json!({"groups": [1]}),
            json!({"unit": 8, "groups": [1], "unexpected": true}),
            json!({"unit": 4, "groups": [1]}),
            json!({"unit": 64, "groups": [1]}),
            json!({"unit": 8.5, "groups": [1]}),
            json!({"unit": 8, "groups": []}),
            json!({"unit": 8, "groups": [0]}),
            json!({"unit": 8, "groups": [-1]}),
            json!({"unit": 8, "groups": [0.5]}),
            json!({"unit": 8, "groups": [null]}),
            json!({"unit": 8, "groups": [9_007_199_254_740_992_u64]}),
        ] {
            value["beaming"] = invalid;
            rejected(&value);
        }
    }

    #[test]
    fn lyrics_notation_bar_and_ottava_controls_enforce_enum_and_boolean_domains() {
        let commands = lyrics_notation_commands();
        for (index, field, max) in [
            (2, "ottava", 4),
            (5, "clefOttava", 4),
            (6, "tripletFeel", 6),
        ] {
            let mut value = commands[index].clone();
            for valid in 0..=max {
                value[field] = json!(valid);
                accepted(&value);
            }
            for invalid in [json!(-1), json!(max + 1), json!(0.5), json!(null)] {
                value[field] = invalid;
                rejected(&value);
            }
        }
        for field in ["commonTime", "doubleBar"] {
            for valid in [false, true] {
                let mut value = commands[6].clone();
                value[field] = json!(valid);
                accepted(&value);
            }
            for invalid in [json!(null), json!(0), json!("false")] {
                let mut value = commands[6].clone();
                value[field] = invalid;
                rejected(&value);
            }
        }
    }

    fn entry_commands() -> Vec<Value> {
        let target = json!({"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0});
        vec![
            json!({"type": "setScoreMetadata", "fields": {
                "subTitle": "", "album": "Album", "words": "Words", "music": "Music",
                "copyright": "Copyright", "tab": "Tab", "notices": "Notices", "instructions": "Instructions"
            }}),
            json!({"type": "setDirections", "bar": 0, "directions": [0, 18, 0]}),
            json!({"type": "setNoteSpelling", "target": target, "noteIndex": 0, "accidentalMode": 6}),
            json!({"type": "addPitchedTrack", "name": "Piano", "program": 0}),
            json!({"type": "addPercussionTrack", "name": "Drums", "program": 127}),
            json!({"type": "addPitchedNote", "target": target, "pitch": 60}),
            json!({"type": "setPitchedNote", "target": target, "noteIndex": 1, "pitch": 127}),
            json!({"type": "addPercussionNote", "target": target, "articulation": 91}),
            json!({"type": "setPercussionNote", "target": target, "noteIndex": 1, "articulation": 0}),
            json!({"type": "removeNoteByIndex", "target": target, "noteIndex": 0}),
            json!({"type": "setNoteTechniquesByIndex", "target": target, "noteIndex": 0, "patch": {"dynamics": 3}}),
            json!({"type": "setNoteLinkByIndex", "from": {"target": target, "noteIndex": 0}, "to": null, "kind": "tie"}),
        ]
    }

    fn accepted(value: &Value) -> EditCommand {
        let command: EditCommand = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("Command must deserialize: {value}: {error}"));
        command
            .validate()
            .unwrap_or_else(|error| panic!("Command must validate: {value}: {error}"));
        command
    }

    fn rejected(value: &Value) {
        assert!(
            serde_json::from_value::<EditCommand>(value.clone())
                .map(|command| command.validate().is_err())
                .unwrap_or(true),
            "Command must be rejected: {value}"
        );
    }

    #[test]
    fn entry_commands_roundtrip_with_exact_public_fields() {
        for value in entry_commands() {
            assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        }
    }

    #[test]
    fn entry_commands_require_every_field_and_reject_unknown_fields() {
        for value in entry_commands() {
            accepted(&value);
            let mut unknown = value.clone();
            unknown["unexpected"] = json!(true);
            rejected(&unknown);
            for field in value
                .as_object()
                .unwrap()
                .keys()
                .filter(|field| *field != "type")
            {
                let mut missing = value.clone();
                missing.as_object_mut().unwrap().remove(field);
                rejected(&missing);
            }
        }
    }

    #[test]
    fn metadata_requires_all_eight_strings_but_accepts_empty_strings() {
        let mut value = entry_commands().remove(0);
        accepted(&value);
        for field in [
            "subTitle",
            "album",
            "words",
            "music",
            "copyright",
            "tab",
            "notices",
            "instructions",
        ] {
            let mut missing = value.clone();
            missing["fields"].as_object_mut().unwrap().remove(field);
            rejected(&missing);
            for invalid in [json!(null), json!(1), json!(false)] {
                let mut wrong_type = value.clone();
                wrong_type["fields"][field] = invalid;
                rejected(&wrong_type);
            }
            value["fields"][field] = json!("");
        }
        accepted(&value);
        value["fields"]["title"] = json!("unexpected");
        rejected(&value);
    }

    #[test]
    fn directions_accept_all_public_values_and_reject_invalid_numbers() {
        let mut value = entry_commands().remove(1);
        accepted(&value);
        for direction in 0..=18 {
            value["directions"] = json!([direction]);
            accepted(&value);
        }
        value["directions"] = json!([]);
        accepted(&value);
        for invalid in [json!(-1), json!(19), json!(0.5), json!(null)] {
            value["directions"] = json!([invalid]);
            rejected(&value);
        }
    }

    #[test]
    fn spelling_accepts_default_and_six_forced_modes() {
        let mut value = entry_commands().remove(2);
        accepted(&value);
        for mode in 0..=6 {
            value["accidentalMode"] = json!(mode);
            accepted(&value);
        }
        for invalid in [json!(-1), json!(7), json!(1.5), json!(null)] {
            value["accidentalMode"] = invalid;
            rejected(&value);
        }
    }

    #[test]
    fn new_tracks_and_pitched_notes_require_midi_values() {
        for mut value in entry_commands().into_iter().filter(|value| {
            matches!(
                value["type"].as_str().unwrap(),
                "addPitchedTrack" | "addPercussionTrack" | "addPitchedNote" | "setPitchedNote"
            )
        }) {
            accepted(&value);
            let field = if value.get("program").is_some() {
                "program"
            } else {
                "pitch"
            };
            for valid in [0, 127] {
                value[field] = json!(valid);
                accepted(&value);
            }
            for invalid in [json!(-1), json!(128), json!(256), json!(0.5), json!(null)] {
                value[field] = invalid;
                rejected(&value);
            }
        }
    }

    #[test]
    fn percussion_articulation_accepts_nonnegative_public_integer_domain() {
        for mut value in entry_commands()
            .into_iter()
            .filter(|value| value.get("articulation").is_some())
        {
            accepted(&value);
            for valid in [0, 91, i32::MAX] {
                value["articulation"] = json!(valid);
                accepted(&value);
            }
            for invalid in [json!(-1), json!(2147483648_u64), json!(0.5), json!(null)] {
                value["articulation"] = invalid;
                rejected(&value);
            }
        }
    }

    #[test]
    fn indexed_targets_require_nonnegative_integer_index_and_exact_shape() {
        for mut value in entry_commands()
            .into_iter()
            .filter(|value| value.get("noteIndex").is_some())
        {
            accepted(&value);
            value["noteIndex"] = json!(u32::MAX);
            accepted(&value);
            for invalid in [json!(-1), json!(4294967296_u64), json!(0.5), json!(null)] {
                value["noteIndex"] = invalid;
                rejected(&value);
            }
        }
        let mut link = entry_commands().pop().unwrap();
        accepted(&link);
        for field in ["target", "noteIndex"] {
            let mut missing = link.clone();
            missing["from"].as_object_mut().unwrap().remove(field);
            rejected(&missing);
        }
        link["from"]["string"] = json!(1);
        rejected(&link);
        let mut nested_target = entry_commands().remove(2);
        nested_target["target"]["extra"] = json!(1);
        rejected(&nested_target);
    }

    #[test]
    fn indexed_techniques_enforce_existing_patch_domains_and_nullability() {
        let mut value = entry_commands().remove(10);
        accepted(&value);
        for patch in [
            json!({}),
            json!({"bend": null, "harmonic": null, "trill": null}),
            json!({"accent": 3, "dynamics": 25, "leftFinger": -2, "rightFinger": 4,
                "slideIn": 2, "slideOut": 6, "vibrato": 2, "ornament": 4}),
        ] {
            value["patch"] = patch;
            accepted(&value);
        }
        for patch in [
            json!({"dynamics": 26}),
            json!({"accent": -1}),
            json!({"leftFinger": 5}),
            json!({"rightFinger": -3}),
            json!({"slideIn": 3}),
            json!({"slideOut": 7}),
            json!({"vibrato": 3}),
            json!({"ornament": 5}),
            json!({"ghost": null}),
            json!({"extra": true}),
            json!({"harmonic": {"type": 7, "value": 0}}),
            json!({"trill": {"pitch": 128, "speed": 16}}),
            json!({"bend": {"type": 1, "style": 0, "points": [{"offset": 0, "value": 0}]}}),
        ] {
            value["patch"] = patch;
            rejected(&value);
        }
    }

    #[test]
    fn indexed_links_require_nullable_destination_and_later_same_voice_note() {
        let mut value = entry_commands().pop().unwrap();
        accepted(&value);
        value["to"] = json!({"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 1}, "noteIndex": 2});
        for kind in ["tie", "hammerPull", "slur"] {
            value["kind"] = json!(kind);
            accepted(&value);
        }
        for field in ["track", "staff", "voice"] {
            let mut other_voice = value.clone();
            other_voice["to"]["target"][field] = json!(1);
            rejected(&other_voice);
        }
        for field in ["target", "noteIndex"] {
            let mut missing = value.clone();
            missing["to"].as_object_mut().unwrap().remove(field);
            rejected(&missing);
        }
        let mut unknown = value.clone();
        unknown["to"]["string"] = json!(1);
        rejected(&unknown);
        value["to"]["target"]["beat"] = json!(0);
        rejected(&value);
        value["to"]["target"]["bar"] = json!(1);
        accepted(&value);
        value["from"]["target"]["bar"] = json!(2);
        rejected(&value);
        value["from"]["target"]["bar"] = json!(0);
        value["kind"] = json!("legato");
        rejected(&value);
    }
}
