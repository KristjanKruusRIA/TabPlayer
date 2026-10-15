use crate::edit_types::required_nullable;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

macro_rules! named_enum {
    ($name:ident { $first:ident = $first_value:literal $(, $variant:ident = $value:literal)* $(,)? }) => {
        #[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
        #[serde(try_from = "String")]
        pub enum $name {
            #[default]
            #[serde(rename = $first_value)]
            $first,
            $(#[serde(rename = $value)] $variant,)*
        }

        impl TryFrom<String> for $name {
            type Error = String;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                match value.as_str() {
                    $first_value => Ok(Self::$first),
                    $($value => Ok(Self::$variant),)*
                    _ => Err(concat!("Unsupported ", stringify!($name), " value.").into()),
                }
            }
        }
    };
}

named_enum!(NamePolicy {
    Inherit = "inherit", Hidden = "hidden", FirstSystem = "firstSystem", AllSystems = "allSystems"
});
named_enum!(TrackProfile {
    Source = "source", Standard = "standard", Tablature = "tablature",
    StandardTab = "standardTab", Slash = "slash", Numbered = "numbered"
});
named_enum!(BracketMode {
    Inherit = "inherit", None = "none", Staves = "staves", Similar = "similar"
});
named_enum!(ChordPlacement {
    Inherit = "inherit", Hidden = "hidden", Top = "top", Inline = "inline", Both = "both"
});
named_enum!(NameMode { Inherit = "inherit", Full = "full", Short = "short" });
named_enum!(NameDirection { Inherit = "inherit", Horizontal = "horizontal", Vertical = "vertical" });
named_enum!(BarNumberMode {
    Inherit = "inherit", All = "all", FirstSystem = "firstSystem", Hidden = "hidden"
});
named_enum!(MultiRestMode { Inherit = "inherit", Off = "off", On = "on" });
named_enum!(TabRhythmMode {
    Inherit = "inherit", Auto = "auto", Hidden = "hidden", Beams = "beams", Connected = "connected"
});
named_enum!(FingeringMode {
    Inherit = "inherit", Score = "score", Piano = "piano", Above = "above", AbovePiano = "abovePiano"
});
named_enum!(PageProfile {
    Document = "document", ScoreTab = "ScoreTab", Score = "Score", Tab = "Tab"
});

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngravingStylesheet {
    #[serde(deserialize_with = "required_nullable")]
    pub hide_dynamics: Option<bool>,
    pub brackets: BracketMode,
    #[serde(deserialize_with = "required_nullable")]
    pub extend_bar_lines: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub system_separators: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub tuning: Option<bool>,
    pub chords: ChordPlacement,
    pub single_names: NamePolicy,
    pub multi_names: NamePolicy,
    pub first_names: NameMode,
    pub other_names: NameMode,
    pub first_name_direction: NameDirection,
    pub other_name_direction: NameDirection,
    pub bar_numbers: BarNumberMode,
    pub multi_rests: MultiRestMode,
    #[serde(deserialize_with = "required_nullable")]
    pub hide_empty_staves: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub hide_empty_first_system: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub single_staff_brackets: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngravingNotation {
    pub tab_rhythm: TabRhythmMode,
    pub fingering: FingeringMode,
    #[serde(deserialize_with = "required_nullable")]
    pub small_grace_tab: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub extend_bend_arrows: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub extend_line_effects: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub parenthesize_tied_bends: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub show_tied_bend_numbers: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub show_dive_whammy_zeros: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackProfileOverride {
    pub track_id: String,
    pub profile: TrackProfile,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngravingOverrides {
    pub stylesheet: EngravingStylesheet,
    pub notation: EngravingNotation,
    #[serde(deserialize_with = "required_nullable")]
    pub system_spacing: Option<f64>,
    pub profiles: Vec<TrackProfileOverride>,
}

impl EngravingOverrides {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .system_spacing
            .is_some_and(|value| !value.is_finite() || !(0.25..=4.0).contains(&value))
        {
            return Err("System spacing must be null or a finite factor from 0.25 to 4.".into());
        }
        let mut ids = HashSet::new();
        if self
            .profiles
            .iter()
            .any(|entry| entry.track_id.is_empty() || !ids.insert(&entry.track_id))
        {
            return Err("Engraving profile track identities must be nonempty and distinct.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageMargins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageLayout {
    pub width_mm: f64,
    pub height_mm: f64,
    pub margins_mm: PageMargins,
    pub scale: f64,
    pub profile: PageProfile,
}

impl PageLayout {
    pub fn validate(&self) -> Result<(), String> {
        if !self.width_mm.is_finite()
            || !(20.0..=1000.0).contains(&self.width_mm)
            || !self.height_mm.is_finite()
            || !(20.0..=1000.0).contains(&self.height_mm)
            || !self.scale.is_finite()
            || !(0.25..=3.0).contains(&self.scale)
        {
            return Err("Page dimensions must be 20–1000 mm and scale 0.25–3.".into());
        }
        let margins = &self.margins_mm;
        if [margins.top, margins.right, margins.bottom, margins.left]
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err("Page margins must be finite and nonnegative.".into());
        }
        let px_per_mm = 96.0 / 25.4;
        if self.width_mm * px_per_mm - (margins.left * px_per_mm + margins.right * px_per_mm)
            < 100.0
            || self.height_mm * px_per_mm
                - (margins.top * px_per_mm + margins.bottom * px_per_mm)
                - 64.0
                < 100.0
        {
            return Err("Page body must fit at least 100 pixels in each dimension after headers and margins.".into());
        }
        Ok(())
    }
}
