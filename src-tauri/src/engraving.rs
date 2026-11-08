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
named_enum!(TextFamily {
    Inherit = "inherit", Sans = "sans", Serif = "serif", Mono = "mono"
});
named_enum!(PageProfile {
    Document = "document", ScoreTab = "ScoreTab", Score = "Score", Tab = "Tab"
});

named_enum!(TextFont {
    NotoSans = "notoSans", NotoSerif = "notoSerif", NotoSansMono = "notoSansMono"
});
named_enum!(MusicFont { Bravura = "bravura", Petaluma = "petaluma", Leland = "leland" });

/// Deserializes a present, non-null value for an optional field. A missing field is `None` through `#[serde(default)]`.
fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Accepts only a JSON object. Derived struct deserializers also accept an array as positional fields, which TypeScript refuses.
fn object_only<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if !value.is_object() {
        return Err(serde::de::Error::custom("Expected an object."));
    }
    T::deserialize(value).map_err(serde::de::Error::custom)
}

/// `object_only` for an optional field that is present: `null` and arrays are refused.
fn non_null_object<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    object_only(deserializer).map(Some)
}

/// One role's font choices. Every field is optional; an absent field keeps the element's own default.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleFont {
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub font: Option<TextFont>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub size: Option<f64>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub bold: Option<bool>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub italic: Option<bool>,
}

impl RoleFont {
    fn validate(&self, role: &str) -> Result<(), String> {
        if *self == Self::default() {
            return Err("A role font must set at least one field.".into());
        }
        // Tab numbers keep the narrower range of the tab number scale.
        let range = if role == "tabNumbers" {
            TAB_SCALE_RANGE
        } else {
            TEXT_SCALE_RANGE
        };
        if self
            .size
            .is_some_and(|size| !size.is_finite() || !range.contains(&size))
        {
            return Err("A role font size is outside its supported range.".into());
        }
        if self.font.is_none() && (self.bold.is_some() || self.italic.is_some()) {
            return Err("Bold and italic need a chosen font.".into());
        }
        // Noto Sans Mono has no italic face (and so no bold italic).
        if self.font == Some(TextFont::NotoSansMono) && self.italic == Some(true) {
            return Err("Noto Sans Mono has no italic face.".into());
        }
        Ok(())
    }
}

macro_rules! role_fonts {
    ($($field:ident = $name:literal),+ $(,)?) => {
        /// The ten font roles; an absent role keeps today's look.
        #[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct RoleFonts {
            $(
                #[serde(default, deserialize_with = "non_null_object", skip_serializing_if = "Option::is_none")]
                pub $field: Option<RoleFont>,
            )+
        }

        impl RoleFonts {
            pub fn is_default(&self) -> bool {
                $(self.$field.is_none())&&+
            }

            fn validate(&self) -> Result<(), String> {
                $(if let Some(role) = &self.$field {
                    role.validate($name)?;
                })+
                Ok(())
            }
        }
    };
}

role_fonts!(
    title_block = "titleBlock",
    page_header = "pageHeader",
    page_footer = "pageFooter",
    chord_names = "chordNames",
    staff_text = "staffText",
    lyrics = "lyrics",
    track_names = "trackNames",
    bar_numbers = "barNumbers",
    markers = "markers",
    tab_numbers = "tabNumbers",
);

/// Text font roles and the music font. The default (Bravura, no roles) is never written.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngravingFonts {
    #[serde(default, skip_serializing_if = "MusicFont::is_default")]
    pub music: MusicFont,
    #[serde(
        default,
        deserialize_with = "object_only",
        skip_serializing_if = "RoleFonts::is_default"
    )]
    pub roles: RoleFonts,
}

impl MusicFont {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

impl EngravingFonts {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub fn validate(&self) -> Result<(), String> {
        self.roles.validate()
    }
}

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

/// The supported size scales, shared by the typography scales and the font role sizes (TypeScript: `TEXT_SCALE_RANGE`, `TAB_SCALE_RANGE`).
const TEXT_SCALE_RANGE: std::ops::RangeInclusive<f64> = 0.5..=2.0;
const TAB_SCALE_RANGE: std::ops::RangeInclusive<f64> = 0.75..=1.5;

/// Text font family and size scales. `None` and `Inherit` keep the renderer defaults.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngravingTypography {
    pub family: TextFamily,
    #[serde(deserialize_with = "required_nullable")]
    pub text_scale: Option<f64>,
    #[serde(deserialize_with = "required_nullable")]
    pub title_scale: Option<f64>,
    #[serde(deserialize_with = "required_nullable")]
    pub tab_scale: Option<f64>,
}

impl EngravingTypography {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub fn validate(&self) -> Result<(), String> {
        let fits = |value: Option<f64>, range: std::ops::RangeInclusive<f64>| {
            value.is_none_or(|value| value.is_finite() && range.contains(&value))
        };
        if !fits(self.text_scale, TEXT_SCALE_RANGE)
            || !fits(self.title_scale, TEXT_SCALE_RANGE)
            || !fits(self.tab_scale, TAB_SCALE_RANGE)
        {
            return Err("Typography scales must be null or within their supported range.".into());
        }
        Ok(())
    }
}

/// One bar's width as a weight within its system (1 is the default width). The default is the absence of an entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BarWidth {
    pub bar: u32,
    pub scale: f64,
}

pub const MAX_BAR_INDEX: u32 = 99_999;
pub const MAX_BAR_WIDTHS: usize = 10_000;
pub const MAX_SYSTEM_GAPS: usize = 10_000;
pub const MAX_STAFF_GROUPS: usize = 64;
pub const MAX_GROUP_TRACKS: usize = 64;
pub const MAX_STAFF_GAPS: usize = 256;
pub const MAX_TRACK_ID_BYTES: usize = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StaffGroupKind {
    Bracket,
    Brace,
}

/// Tracks drawn under one bracket or brace. Members are track identities, never trimmed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaffGroup {
    pub track_ids: Vec<String>,
    pub kind: StaffGroupKind,
}

/// A track's staff gap as a factor of the standard gap (1 is the default).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaffGap {
    pub track_id: String,
    pub scale: f64,
}

fn valid_staff_track_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_TRACK_ID_BYTES
}

/// A system's gap as a factor of the standard gap (1 is the default). `bar` is an anchor bar; the gap applies to the rendered system that contains it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemGap {
    pub bar: u32,
    pub scale: f64,
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
    /// Absent (and omitted again when default) in documents saved before typography existed.
    #[serde(default, skip_serializing_if = "EngravingTypography::is_default")]
    pub typography: EngravingTypography,
    /// Absent (and omitted again when empty) in documents saved before bar widths existed. Entries run in bar order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bar_widths: Vec<BarWidth>,
    /// Absent (and omitted again when empty) in documents saved before system gaps existed. Entries run in bar order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub system_gaps: Vec<SystemGap>,
    /// Absent (and omitted again when default) in documents saved before font roles existed.
    #[serde(
        default,
        deserialize_with = "object_only",
        skip_serializing_if = "EngravingFonts::is_default"
    )]
    pub fonts: EngravingFonts,
    /// Absent (and omitted again when empty) in documents saved before staff groups existed. An explicit empty list is accepted and written back without the field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub staff_groups: Vec<StaffGroup>,
    /// Absent (and omitted again when empty) in documents saved before staff gaps existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub staff_gaps: Vec<StaffGap>,
}

impl EngravingOverrides {
    fn validate_bar_widths(&self) -> Result<(), String> {
        if self.bar_widths.len() > MAX_BAR_WIDTHS {
            return Err("Too many bar widths.".into());
        }
        // Strictly ascending bars are distinct and in order.
        let ordered = self
            .bar_widths
            .windows(2)
            .all(|pair| pair[0].bar < pair[1].bar);
        let fits = self.bar_widths.iter().all(|entry| {
            entry.bar <= MAX_BAR_INDEX
                && entry.scale.is_finite()
                && (0.25..=4.0).contains(&entry.scale)
        });
        if !ordered || !fits {
            return Err(
                "Bar widths must be 25% to 400% of the default, one per bar, in bar order.".into(),
            );
        }
        Ok(())
    }

    fn validate_system_gaps(&self) -> Result<(), String> {
        if self.system_gaps.len() > MAX_SYSTEM_GAPS {
            return Err("Too many system gaps.".into());
        }
        let ordered = self
            .system_gaps
            .windows(2)
            .all(|pair| pair[0].bar < pair[1].bar);
        let fits = self.system_gaps.iter().all(|entry| {
            entry.bar <= MAX_BAR_INDEX
                && entry.scale.is_finite()
                && (0.25..=4.0).contains(&entry.scale)
        });
        if !ordered || !fits {
            return Err(
                "System gaps must be 25% to 400% of the standard gap, one per bar, in bar order."
                    .into(),
            );
        }
        Ok(())
    }

    fn validate_staff_groups(&self) -> Result<(), String> {
        const MESSAGE: &str =
            "Staff groups must name 2 to 64 distinct tracks, each in one group only.";
        if self.staff_groups.len() > MAX_STAFF_GROUPS {
            return Err(MESSAGE.into());
        }
        let mut seen = HashSet::new();
        for group in &self.staff_groups {
            if !(2..=MAX_GROUP_TRACKS).contains(&group.track_ids.len()) {
                return Err(MESSAGE.into());
            }
            for id in &group.track_ids {
                if !valid_staff_track_id(id) || !seen.insert(id.as_str()) {
                    return Err(MESSAGE.into());
                }
            }
        }
        Ok(())
    }

    fn validate_staff_gaps(&self) -> Result<(), String> {
        const MESSAGE: &str = "Staff gaps must be 25% to 400% of the default, one per track.";
        if self.staff_gaps.len() > MAX_STAFF_GAPS {
            return Err(MESSAGE.into());
        }
        let mut seen = HashSet::new();
        for entry in &self.staff_gaps {
            if !valid_staff_track_id(&entry.track_id)
                || !seen.insert(entry.track_id.as_str())
                || !entry.scale.is_finite()
                || !(0.25..=4.0).contains(&entry.scale)
            {
                return Err(MESSAGE.into());
            }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self
            .system_spacing
            .is_some_and(|value| !value.is_finite() || !(0.25..=4.0).contains(&value))
        {
            return Err("System spacing must be null or a finite factor from 0.25 to 4.".into());
        }
        self.typography.validate()?;
        self.validate_bar_widths()?;
        self.validate_system_gaps()?;
        self.fonts.validate()?;
        self.validate_staff_groups()?;
        self.validate_staff_gaps()?;
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_header_footer"
    )]
    pub header_footer: Option<HeaderFooter>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageBand {
    pub left: String,
    pub center: String,
    pub right: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageBands {
    pub header: PageBand,
    pub footer: PageBand,
}

/// Header and footer text with %FIELD% placeholders, as the frontend fills them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeaderFooter {
    pub first: PageBands,
    pub other: PageBands,
}

/// An absent field means the default header and footer; an explicit null is malformed.
fn present_header_footer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<HeaderFooter>, D::Error> {
    HeaderFooter::deserialize(deserializer).map(Some)
}

const HEADER_FIELDS: [&str; 12] = [
    "TITLE",
    "SUBTITLE",
    "ARTIST",
    "ALBUM",
    "WORDS",
    "MUSIC",
    "COPYRIGHT",
    "TABBER",
    "INSTRUCTIONS",
    "NOTICES",
    "PAGE",
    "PAGES",
];

fn validate_header_text(text: &str) -> Result<(), String> {
    if text.chars().count() > 200 {
        return Err("Header and footer text must be at most 200 characters.".into());
    }
    if text.chars().any(|c| matches!(c, '\u{FFFE}' | '\u{FFFF}')) {
        return Err("Header and footer text contains characters that cannot be printed.".into());
    }
    if text.chars().any(|c| c.is_control()) {
        return Err("Header and footer text must be a single line.".into());
    }
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            return Err("Use %% for a percent sign in headers and footers.".into());
        };
        let name = &after[..end];
        if !name.is_empty() && !HEADER_FIELDS.contains(&name) {
            return Err(format!("Unknown header or footer field %{name}%."));
        }
        rest = &after[end + 1..];
    }
    Ok(())
}

impl HeaderFooter {
    pub fn validate(&self) -> Result<(), String> {
        for bands in [&self.first, &self.other] {
            for band in [&bands.header, &bands.footer] {
                for text in [&band.left, &band.center, &band.right] {
                    validate_header_text(text)?;
                }
            }
        }
        Ok(())
    }
}

impl PageLayout {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(header_footer) = &self.header_footer {
            header_footer.validate()?;
        }
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
