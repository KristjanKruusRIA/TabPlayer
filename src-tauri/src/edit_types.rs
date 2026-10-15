use crate::project::BeatTarget;
use crate::settings::{BackingSettings, ChannelMix, PrintLayout, TrackSound};
use serde::{Deserialize, Serialize};

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
                if !fermata.length.is_finite() || fermata.length <= 0.0 {
                    return Err("Fermata length must be a positive finite number.".into());
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
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::EditCommand;
    use serde_json::{Value, json};

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
                "stem": "inverted", "beamingMode": 3}}),
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
    fn lyrics_notation_fermata_requires_exact_shape_positive_length_and_valid_type() {
        let mut value = lyrics_notation_commands().remove(4);
        for kind in 0..=2 {
            value["fermata"] = json!({"type": kind, "length": 0.01});
            accepted(&value);
        }
        for invalid in [
            json!({}),
            json!({"type": 0}),
            json!({"length": 1}),
            json!({"type": 0, "length": 1, "unexpected": true}),
            json!({"type": -1, "length": 1}),
            json!({"type": 3, "length": 1}),
            json!({"type": 0.5, "length": 1}),
            json!({"type": 0, "length": 0}),
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
