use crate::audio::dsp::{Compressor, Eq, FxSettings, Reverb};
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub drum_kit: Option<DrumKitMix>,
    /// The name of the system MIDI output port this track plays through instead of the internal sound. Absent is the internal
    /// sound. A port is matched by name, so a score keeps its routing across sessions and machines that name a port alike.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub midi_port: Option<String>,
}
/// The longest port name a mix may carry.
pub const MAX_MIDI_PORT_NAME: usize = 256;
/// Whether `c` is a Unicode format character (general category Cf): bidirectional overrides and isolates, zero-width
/// joiners and spaces, the byte order mark, tag characters and the like, which can make one name read as another.
fn is_format_char(c: char) -> bool {
    matches!(u32::from(c),
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}
/// Whether `name` can name a MIDI output port: not empty, bounded, and free of control and format characters.
pub fn valid_midi_port_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_MIDI_PORT_NAME
        && !name.chars().any(|c| c.is_control() || is_format_char(c))
}
impl Default for ChannelMix {
    fn default() -> Self {
        Self {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            interpretation: None,
            drum_kit: None,
            midi_port: None,
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
        if let Some(drum_kit) = &self.drum_kit {
            drum_kit.validate()?;
        }
        if self
            .midi_port
            .as_deref()
            .is_some_and(|name| !valid_midi_port_name(name))
        {
            return Err(
                "A MIDI output port name must be 1–256 characters without control or format characters."
                    .into(),
            );
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KitElement {
    Kick,
    Snare,
    Hats,
    Toms,
    Cymbals,
    Other,
}

impl KitElement {
    pub const COUNT: usize = 6;
    /// The element's place among `COUNT`, in the order the mix lists them.
    pub fn index(self) -> usize {
        match self {
            Self::Kick => 0,
            Self::Snare => 1,
            Self::Hats => 2,
            Self::Toms => 3,
            Self::Cymbals => 4,
            Self::Other => 5,
        }
    }
}

/// The element a sounding pitch belongs to, for a note whose articulation the plan does not name. The plan names the element
/// of every articulation this does not agree with (the metronome and the bell tree sound pitches of other pieces), so what
/// a note belongs to follows its articulation and only a plan written without that falls back to its pitch.
pub fn gm_kit_element(key: u8) -> KitElement {
    match key {
        35 | 36 => KitElement::Kick,
        37 | 38 | 40 => KitElement::Snare,
        42 | 44 | 46 => KitElement::Hats,
        41 | 43 | 45 | 47 | 48 | 50 => KitElement::Toms,
        49 | 51 | 52 | 53 | 55 | 57 | 59 => KitElement::Cymbals,
        _ => KitElement::Other,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrumElementMix {
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Default for DrumElementMix {
    fn default() -> Self {
        Self {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
        }
    }
}

impl DrumElementMix {
    pub fn is_neutral(&self) -> bool {
        *self == Self::default()
    }
    pub fn validate(&self) -> Result<(), String> {
        if !self.gain.is_finite()
            || !(0.0..=1.0).contains(&self.gain)
            || !self.pan.is_finite()
            || !(-1.0..=1.0).contains(&self.pan)
        {
            return Err("Drum element gain must be 0–1 and pan -1–1.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrumKitMix {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub kick: Option<DrumElementMix>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub snare: Option<DrumElementMix>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub hats: Option<DrumElementMix>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub toms: Option<DrumElementMix>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub cymbals: Option<DrumElementMix>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub other: Option<DrumElementMix>,
}

impl DrumKitMix {
    /// Every element in `KitElement::index` order, the ones the mix leaves out at their defaults.
    pub fn elements(&self) -> [DrumElementMix; KitElement::COUNT] {
        [
            self.kick.unwrap_or_default(),
            self.snare.unwrap_or_default(),
            self.hats.unwrap_or_default(),
            self.toms.unwrap_or_default(),
            self.cymbals.unwrap_or_default(),
            self.other.unwrap_or_default(),
        ]
    }
    /// Whether the kit sounds as no kit would.
    pub fn is_neutral(&self) -> bool {
        self.elements().iter().all(DrumElementMix::is_neutral)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.kick.is_none()
            && self.snare.is_none()
            && self.hats.is_none()
            && self.toms.is_none()
            && self.cymbals.is_none()
            && self.other.is_none()
        {
            return Err("Invalid drum kit mix.".into());
        }
        if let Some(kick) = &self.kick {
            kick.validate()?;
        }
        if let Some(snare) = &self.snare {
            snare.validate()?;
        }
        if let Some(hats) = &self.hats {
            hats.validate()?;
        }
        if let Some(toms) = &self.toms {
            toms.validate()?;
        }
        if let Some(cymbals) = &self.cymbals {
            cymbals.validate()?;
        }
        if let Some(other) = &self.other {
            other.validate()?;
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    /// The drum kit a percussion track plays, as the General MIDI program that selects it in the
    /// sound bank. Left out for the Standard kit, so a file that never chose one is unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drum_kit: Option<u8>,
    /// A VST3 plug-in inserted after the track's pedalboard. Left out for a track with none, so a file that never
    /// used one is unchanged, and an older build, which does not know the key, refuses a file that has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<PluginSlot>,
}

/// The formats a plug-in slot can hold. Only VST3 is hosted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginFormat {
    Vst3,
}

/// The reach of a plug-in slot's input and output trims, in dB.
pub const PLUGIN_TRIM_DB: f64 = 12.0;

/// One plug-in in a track's chain, as the document stores it: which plug-in, whether it sounds, the trims around it
/// and the id of the asset that holds its saved state (see `plugins::state`). Names are what the plug-in reported when
/// it was chosen; they are shown, never used to find it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSlot {
    pub format: PluginFormat,
    /// The VST3 class ID: 32 uppercase hexadecimal characters.
    pub class_id: String,
    pub name: String,
    pub vendor: String,
    pub active: bool,
    /// Trims before and after the plug-in, as `f64` like the other dB fields; the audio path narrows them.
    pub input_db: f64,
    pub output_db: f64,
    /// The id (a lowercase SHA-256 digest) of the state asset, which has the media type `STATE_MEDIA_TYPE`.
    pub state: String,
}
impl PluginSlot {
    pub fn validate(&self) -> Result<(), String> {
        use tabplayer_plugin_protocol::validate::{valid_class_id, valid_name, valid_vendor};
        if !valid_class_id(&self.class_id) {
            return Err("Plug-in class ID is invalid.".into());
        }
        if !valid_name(&self.name) {
            return Err("Plug-in name is invalid.".into());
        }
        if !valid_vendor(&self.vendor) {
            return Err("Plug-in vendor is invalid.".into());
        }
        for trim in [self.input_db, self.output_db] {
            if !trim.is_finite() || trim.abs() > PLUGIN_TRIM_DB {
                return Err("Plug-in level trims must be between -12 and 12 dB.".into());
            }
        }
        if self.state.len() != 64
            || !self
                .state
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Plug-in settings reference is invalid.".into());
        }
        Ok(())
    }
}
/// The drum kits beyond Standard that the bundled sound bank carries (Room, Jazz, Brush), by the
/// program that selects each. `src/audio/drum-kits.json` lists the same, and a test renders the bank
/// to keep both true.
pub const DRUM_KIT_PROGRAMS: [u8; 3] = [8, 32, 40];
impl Default for TrackSound {
    fn default() -> Self {
        Self {
            voice_id: None,
            preset_id: "gm".into(),
            effects: FxSettings::default(),
            locked: false,
            drum_kit: None,
            plugin: None,
        }
    }
}
impl TrackSound {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(plugin) = &self.plugin {
            plugin.validate()?;
        }
        if self
            .drum_kit
            .is_some_and(|kit| !DRUM_KIT_PROGRAMS.contains(&kit))
        {
            return Err("Unknown drum kit.".into());
        }
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
        if self.mix.midi_port.is_some() {
            return Err("A backing track cannot be sent to a MIDI output.".into());
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

/// The master limiter: a ceiling that no sample of the final mix passes, with an instant attack.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MasterLimiter {
    pub enabled: bool,
    pub ceiling_db: f64,
    pub release_ms: f64,
}
impl Default for MasterLimiter {
    fn default() -> Self {
        Self {
            enabled: false,
            ceiling_db: -1.0,
            release_ms: 100.0,
        }
    }
}

/// The song-level chain after the mix: compressor, EQ and reverb on the tracks and backing, then the overall level and
/// balance, then the limiter on everything that sounds, the metronome included. Absent or at its defaults, the mix is
/// untouched.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MasterSettings {
    pub gain_db: f64,
    pub balance: f64,
    pub compressor: Compressor,
    pub eq: Eq,
    pub reverb: Reverb,
    pub limiter: MasterLimiter,
}
impl Default for MasterSettings {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            balance: 0.0,
            // Gentler than a track's compressor, as a bus wants.
            compressor: Compressor {
                threshold_db: -12.0,
                ratio: 2.0,
                attack_ms: 30.0,
                release_ms: 200.0,
                ..Compressor::default()
            },
            eq: Eq::default(),
            reverb: Reverb {
                model: "hall".into(),
                room: 0.6,
                damping: 0.5,
                mix: 0.1,
                ..Reverb::default()
            },
            limiter: MasterLimiter::default(),
        }
    }
}
impl MasterSettings {
    /// The three blocks as a pedalboard, which is what plays them.
    pub fn board(&self) -> FxSettings {
        FxSettings {
            compressor: self.compressor.clone(),
            eq: self.eq.clone(),
            reverb: self.reverb.clone(),
            ..FxSettings::default()
        }
    }
    /// Whether the chain changes nothing it is given. The numbers behind a switched-off block do not count.
    pub fn is_neutral(&self) -> bool {
        self.gain_db == 0.0
            && self.balance == 0.0
            && !self.compressor.enabled
            && !self.eq.enabled
            && !self.reverb.enabled
            && !self.limiter.enabled
    }
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, low, high) in [
            ("master level", self.gain_db, -24.0, 12.0),
            ("master balance", self.balance, -1.0, 1.0),
            ("limiter ceiling", self.limiter.ceiling_db, -12.0, 0.0),
            ("limiter release", self.limiter.release_ms, 10.0, 1000.0),
        ] {
            if !value.is_finite() || value < low || value > high {
                return Err(format!("Invalid {name}: expected {low}..{high}."));
            }
        }
        self.board().validate()
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
    /// Absent until the master is first edited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master: Option<MasterSettings>,
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
        if let Some(master) = &self.master {
            master.validate()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod midi_port_tests {
    use super::*;

    #[test]
    fn a_mix_saved_before_midi_output_loads_unchanged_and_saves_without_the_field() {
        let old = r#"{"gain":0.5,"pan":-0.25,"mute":true,"solo":false}"#;
        let mix: ChannelMix = serde_json::from_str(old).unwrap();
        assert_eq!(mix.midi_port, None);
        assert!(mix.validate().is_ok());
        assert_eq!(
            serde_json::to_string(&mix).unwrap(),
            old,
            "an unrouted mix serializes exactly as before"
        );
        let with_kit =
            r#"{"gain":1,"pan":0,"mute":false,"solo":false,"interpretation":{"style":"pick"}}"#;
        let mix: ChannelMix = serde_json::from_str(with_kit).unwrap();
        assert_eq!(mix.midi_port, None);
        // A whole document saved before the field replays the same.
        let settings: DocumentSettings = serde_json::from_value(serde_json::json!({
            "sounds": {}, "mixes": {"base/0": {"gain":1,"pan":0,"mute":false,"solo":false}},
            "backing": null, "print": serde_json::to_value(PrintLayout::default()).unwrap()
        }))
        .unwrap();
        assert_eq!(settings.mixes["base/0"].midi_port, None);
    }

    #[test]
    fn a_routed_mix_round_trips_and_a_port_name_is_checked() {
        let routed = r#"{"gain":1,"pan":0,"mute":false,"solo":false,"midiPort":"Microsoft GS Wavetable Synth"}"#;
        let mix: ChannelMix = serde_json::from_str(routed).unwrap();
        assert_eq!(
            mix.midi_port.as_deref(),
            Some("Microsoft GS Wavetable Synth")
        );
        assert!(mix.validate().is_ok());
        assert_eq!(
            serde_json::to_string(&mix).unwrap(),
            routed.replace("\"gain\":1,\"pan\":0,", "\"gain\":1.0,\"pan\":0.0,")
        );
        let named = |name: &str| ChannelMix {
            midi_port: Some(name.into()),
            ..ChannelMix::default()
        };
        assert!(named("Port 1 \u{00e4}\u{00f6}").validate().is_ok());
        assert!(named(&"x".repeat(256)).validate().is_ok());
        for bad in [
            String::new(),
            "x".repeat(257),
            "line\nbreak".into(),
            "tab\there".into(),
            "nul\0".into(),
            "del\u{7f}".into(),
            "c1\u{85}".into(),
            "rlo\u{202e}name".into(),
            "zero\u{200b}width".into(),
            "bom\u{feff}".into(),
            "isolate\u{2066}x".into(),
            "soft\u{ad}hyphen".into(),
            "tag\u{e0041}".into(),
        ] {
            assert!(named(&bad).validate().is_err(), "{bad:?}");
        }
        // An explicit null is refused, as for the other optional fields.
        assert!(
            serde_json::from_str::<ChannelMix>(
                r#"{"gain":1,"pan":0,"mute":false,"solo":false,"midiPort":null}"#
            )
            .is_err()
        );
        // A backing track cannot be routed.
        let mut backing: BackingSettings = serde_json::from_value(serde_json::json!({
            "assetId":"a","offsetMs":0,"anchors":[],"mix":{"gain":1,"pan":0,"mute":false,"solo":false}
        }))
        .unwrap();
        assert!(backing.validate().is_ok());
        backing.mix.midi_port = Some("Port".into());
        assert!(backing.validate().is_err());
    }

    #[test]
    fn routing_a_track_is_a_mix_edit_that_validates_and_replays() {
        use crate::edit_types::EditCommand;
        let edit: EditCommand = serde_json::from_value(serde_json::json!({
            "type":"setTrackMix","trackId":"base/0",
            "mix":{"gain":1,"pan":0,"mute":false,"solo":false,"midiPort":"Synth"}
        }))
        .unwrap();
        assert!(edit.validate().is_ok());
        let bad: EditCommand = serde_json::from_value(serde_json::json!({
            "type":"setTrackMix","trackId":"base/0",
            "mix":{"gain":1,"pan":0,"mute":false,"solo":false,"midiPort":""}
        }))
        .unwrap();
        assert!(bad.validate().is_err());
    }
}
