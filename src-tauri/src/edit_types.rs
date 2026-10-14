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
    SetNoteTechniques {
        target: BeatTarget,
        string: u32,
        patch: NoteTechniques,
    },
    SetNoteLink {
        from: NoteTarget,
        #[serde(deserialize_with = "required_nullable")]
        to: Option<NoteTarget>,
        kind: LinkKind,
    },
    SetBeatTechniques {
        target: BeatTarget,
        patch: BeatTechniques,
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
            Self::SetNote { string, .. } | Self::RemoveNote { string, .. } if *string == 0 => {
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
            Self::SetTrackInfo { program, .. } => enum_range(*program as i32, 0, 127)?,
            Self::SetTuning { tuning, .. } => validate_tuning(tuning)?,
            Self::SetScoreInfo { tempo, .. } => validate_tempo(*tempo)?,
            Self::SetNoteTechniques { string, patch, .. } => {
                if *string == 0 {
                    return Err("Select a guitar string.".into());
                }
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
