use crate::audio::dsp::FxSettings;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelMix {
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}
impl Default for ChannelMix {
    fn default() -> Self {
        Self {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
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
pub struct BackingSettings {
    pub asset_id: String,
    pub offset_ms: f64,
    pub anchors: Vec<SyncAnchor>,
    pub mix: ChannelMix,
}
impl BackingSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.asset_id.is_empty() || !self.offset_ms.is_finite() {
            return Err("Backing asset and finite offset are required.".into());
        }
        for anchor in &self.anchors {
            if !anchor.ratio.is_finite()
                || !(0.0..=1.0).contains(&anchor.ratio)
                || !anchor.audio_ms.is_finite()
                || anchor.audio_ms < 0.0
            {
                return Err(
                    "Backing anchors need a ratio 0–1 and nonnegative finite audio time.".into(),
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
        self.print.validate()
    }
}
