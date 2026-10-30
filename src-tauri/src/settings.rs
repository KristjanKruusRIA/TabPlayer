use crate::audio::dsp::FxSettings;
use crate::engraving::{EngravingOverrides, PageLayout};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelMix {
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    /// How the track's stringed notes are performed. The playback plan applies it; absent is the default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub interpretation: Option<TrackInterpretation>,
}
impl Default for ChannelMix {
    fn default() -> Self {
        Self {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            interpretation: None,
        }
    }
}
impl ChannelMix {
    pub fn validate(&self) -> Result<(), String> {
        if !self.gain.is_finite()
            || !(0.0..=1.0).contains(&self.gain)
            || !self.pan.is_finite()
            || !(-1.0..=1.0).contains(&self.pan)
        {
            return Err("Mix gain must be 0–1 and pan -1–1.".into());
        }
        if let Some(interpretation) = &self.interpretation {
            interpretation.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayingStyle {
    Pick,
    Fingers,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PalmMuteIntensity {
    Light,
    Heavy,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StrongBeatAccent {
    Light,
    Strong,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomaticBrush {
    Down,
    Up,
}
/// Track interpretation. Every field is absent at its default, and at least one is present.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackInterpretation {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub style: Option<PlayingStyle>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub palm_mute: Option<PalmMuteIntensity>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub accent: Option<StrongBeatAccent>,
    /// Only `true` is stored.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub let_ring: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub brush: Option<AutomaticBrush>,
}
/// A field that is written is written with a value: an explicit `null` is refused, as TypeScript refuses it.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
impl TrackInterpretation {
    pub fn validate(&self) -> Result<(), String> {
        if self.style.is_none()
            && self.palm_mute.is_none()
            && self.accent.is_none()
            && self.let_ring.is_none()
            && self.brush.is_none()
            || self.let_ring == Some(false)
        {
            return Err("Invalid track interpretation.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackSound {
    #[serde(deserialize_with = "crate::edit_types::required_nullable")]
    pub voice_id: Option<String>,
    pub preset_id: String,
    pub effects: FxSettings,
}
impl Default for TrackSound {
    fn default() -> Self {
        Self {
            voice_id: None,
            preset_id: "gm".into(),
            effects: FxSettings::default(),
        }
    }
}
impl TrackSound {
    pub fn validate(&self) -> Result<(), String> {
        if !["clean", "crunch", "lead", "bass", "gm"].contains(&self.preset_id.as_str()) {
            return Err("Unknown sound preset.".into());
        }
        if self.voice_id.as_ref().is_some_and(|id| {
            ![
                "gm",
                "green-guitar",
                "black-guitar",
                "darkblack-bass",
                "babyblue-bass",
            ]
            .contains(&id.as_str())
        }) {
            return Err("Unknown instrument voice.".into());
        }
        self.effects.validate()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncAnchor {
    pub bar: u32,
    pub occurrence: u32,
    pub ratio: f64,
    pub audio_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceSyncBounds {
    pub entry_audio_ms: f64,
    pub exit_audio_ms: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
pub enum BackingFilter {
    #[default]
    None,
    BassEnhance,
    BassAttenuation,
    MediumEnhance,
    MediumAttenuation,
    HighEnhance,
    HighAttenuation,
}

impl TryFrom<String> for BackingFilter {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "none" => Ok(Self::None),
            "bassEnhance" => Ok(Self::BassEnhance),
            "bassAttenuation" => Ok(Self::BassAttenuation),
            "mediumEnhance" => Ok(Self::MediumEnhance),
            "mediumAttenuation" => Ok(Self::MediumAttenuation),
            "highEnhance" => Ok(Self::HighEnhance),
            "highAttenuation" => Ok(Self::HighAttenuation),
            _ => Err("Unknown backing filter.".into()),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackingProcessing {
    pub semitones: f64,
    pub cents: f64,
    pub filter: BackingFilter,
}
impl<'de> Deserialize<'de> for BackingProcessing {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ProcessingVisitor;

        impl<'de> serde::de::Visitor<'de> for ProcessingVisitor {
            type Value = BackingProcessing;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a backing processing object")
            }

            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                map: M,
            ) -> Result<Self::Value, M::Error> {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Fields {
                    semitones: f64,
                    cents: f64,
                    filter: BackingFilter,
                }

                let fields =
                    Fields::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
                Ok(BackingProcessing {
                    semitones: fields.semitones,
                    cents: fields.cents,
                    filter: fields.filter,
                })
            }
        }

        deserializer.deserialize_map(ProcessingVisitor)
    }
}

impl BackingProcessing {
    pub fn validate(&self) -> Result<(), String> {
        if !self.semitones.is_finite()
            || self.semitones.fract() != 0.0
            || !(-12.0..=12.0).contains(&self.semitones)
            || !self.cents.is_finite()
            || self.cents.fract() != 0.0
            || !(-100.0..=100.0).contains(&self.cents)
        {
            return Err("Backing pitch needs integer semitones -12–12 and cents -100–100.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackingSettings {
    pub asset_id: String,
    pub offset_ms: f64,
    pub anchors: Vec<SyncAnchor>,
    pub mix: ChannelMix,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_sync: Option<ReferenceSyncBounds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing: Option<BackingProcessing>,
}
impl BackingSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.asset_id.is_empty() || !self.offset_ms.is_finite() {
            return Err("Backing asset and finite offset are required.".into());
        }
        let bounds = if let Some(bounds) = &self.reference_sync {
            let entry = bounds.entry_audio_ms - self.offset_ms;
            let exit = bounds.exit_audio_ms - self.offset_ms;
            if !bounds.entry_audio_ms.is_finite()
                || !bounds.exit_audio_ms.is_finite()
                || !entry.is_finite()
                || !exit.is_finite()
                || entry < 0.0
                || exit <= entry
            {
                return Err(
                    "Reference bounds need nonnegative finite source entry before exit.".into(),
                );
            }
            Some((entry, exit))
        } else {
            None
        };
        for anchor in &self.anchors {
            if !anchor.ratio.is_finite()
                || !(0.0..=1.0).contains(&anchor.ratio)
                || !anchor.audio_ms.is_finite()
                || if let Some((entry, exit)) = bounds {
                    let source = anchor.audio_ms - self.offset_ms;
                    !source.is_finite() || source <= entry || source >= exit
                } else {
                    anchor.audio_ms < 0.0
                }
            {
                return Err(
                    "Backing anchors need a ratio 0–1 and finite audio time inside active bounds."
                        .into(),
                );
            }
        }
        for (index, anchor) in self.anchors.iter().enumerate() {
            if self.anchors[..index].iter().any(|other| {
                (other.bar, other.occurrence, other.ratio)
                    == (anchor.bar, anchor.occurrence, anchor.ratio)
            }) {
                return Err("Backing anchors must have distinct score locations.".into());
            }
        }
        if let Some(processing) = &self.processing {
            processing.validate()?;
        }
        if self.mix.interpretation.is_some() {
            return Err("A backing track has no interpretation.".into());
        }
        self.mix.validate()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrintLayout {
    pub paper: String,
    pub orientation: String,
    pub margin_mm: f64,
    pub scale: f64,
    pub profile: String,
}
impl Default for PrintLayout {
    fn default() -> Self {
        Self {
            paper: "A4".into(),
            orientation: "portrait".into(),
            margin_mm: 15.0,
            scale: 1.0,
            profile: "ScoreTab".into(),
        }
    }
}
impl PrintLayout {
    pub fn validate(&self) -> Result<(), String> {
        if !["A4", "Letter"].contains(&self.paper.as_str())
            || !["portrait", "landscape"].contains(&self.orientation.as_str())
            || !["ScoreTab", "Score", "Tab"].contains(&self.profile.as_str())
            || !self.margin_mm.is_finite()
            || !(0.0..=100.0).contains(&self.margin_mm)
            || !self.scale.is_finite()
            || self.scale <= 0.0
        {
            return Err("Choose a supported print layout.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSettings {
    pub sounds: BTreeMap<String, TrackSound>,
    pub mixes: BTreeMap<String, ChannelMix>,
    #[serde(deserialize_with = "crate::edit_types::required_nullable")]
    pub backing: Option<BackingSettings>,
    pub print: PrintLayout,
    #[serde(default)]
    pub engraving: EngravingOverrides,
    #[serde(default)]
    pub page: Option<PageLayout>,
}
impl DocumentSettings {
    pub fn validate(&self) -> Result<(), String> {
        for (id, sound) in &self.sounds {
            if id.is_empty() {
                return Err("Track identity is required.".into());
            }
            sound.validate()?;
        }
        for (id, mix) in &self.mixes {
            if id.is_empty() {
                return Err("Track identity is required.".into());
            }
            mix.validate()?;
        }
        if let Some(backing) = &self.backing {
            backing.validate()?;
        }
        self.print.validate()?;
        self.engraving.validate()?;
        if let Some(page) = &self.page {
            page.validate()?;
        }
        Ok(())
    }
}
