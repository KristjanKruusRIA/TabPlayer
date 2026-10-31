use crate::edit_types::required_nullable;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

macro_rules! named_enum {
    ($name:ident { $($variant:ident = $value:literal),+ $(,)? }) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(try_from = "String")]
        pub enum $name {
            $(#[serde(rename = $value)] $variant,)+
        }
        impl TryFrom<String> for $name {
            type Error = String;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                match value.as_str() {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(concat!("Unsupported ", stringify!($name), " value.").into()),
                }
            }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                match self { $(Self::$variant => $value,)+ }
            }
        }
    };
}

named_enum!(ChordFormulaId {
    Major = "major", Minor = "minor", Dim = "dim", Aug = "aug", Sus2 = "sus2", Sus4 = "sus4",
    Power = "power", Six = "6", MinorSix = "m6", Seven = "7", MajorSeven = "maj7",
    MinorSeven = "m7", MinorMajorSeven = "mMaj7", MinorSevenFlatFive = "m7b5", DimSeven = "dim7",
    Nine = "9", MajorNine = "maj9", MinorNine = "m9", Eleven = "11", MinorEleven = "m11",
    Thirteen = "13", SevenSus4 = "7sus4"
});
named_enum!(HarmonyNameMode { Manual = "manual", Theory = "theory" });
named_enum!(IntervalQuality {
    Perfect = "perfect", Major = "major", Minor = "minor", Augmented = "augmented", Diminished = "diminished"
});
named_enum!(IntervalDirection { Up = "up", Down = "down" });

pub type ChordDegree = u8;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpelledPitchClass {
    pub step: u8,
    pub alteration: i8,
}

impl SpelledPitchClass {
    fn validate(&self) -> Result<(), String> {
        if self.step > 6 || !(-2..=2).contains(&self.alteration) {
            return Err("Invalid spelled pitch class.".into());
        }
        Ok(())
    }

    fn name(&self) -> String {
        let accidental = match self.alteration {
            -2 => "bb",
            -1 => "b",
            0 => "",
            1 => "#",
            2 => "##",
            _ => unreachable!(),
        };
        format!(
            "{}{accidental}",
            ["C", "D", "E", "F", "G", "A", "B"][self.step as usize]
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChordAlteration {
    pub degree: ChordDegree,
    pub shift: i8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChordRecipe {
    pub root: SpelledPitchClass,
    pub formula: ChordFormulaId,
    pub alterations: Vec<ChordAlteration>,
    pub omissions: Vec<ChordDegree>,
    #[serde(deserialize_with = "required_nullable")]
    pub bass: Option<SpelledPitchClass>,
}

impl ChordFormulaId {
    fn degrees(&self) -> BTreeMap<ChordDegree, i8> {
        use ChordFormulaId::*;
        let base: &[(u8, i8)] = match self {
            Minor | MinorSix | MinorSeven | MinorMajorSeven | MinorNine | MinorEleven => {
                &[(1, 0), (3, -1), (5, 0)]
            }
            Dim | DimSeven | MinorSevenFlatFive => &[(1, 0), (3, -1), (5, -1)],
            Aug => &[(1, 0), (3, 0), (5, 1)],
            Sus2 => &[(1, 0), (2, 0), (5, 0)],
            Sus4 | SevenSus4 => &[(1, 0), (4, 0), (5, 0)],
            Power => &[(1, 0), (5, 0)],
            _ => &[(1, 0), (3, 0), (5, 0)],
        };
        let mut degrees: BTreeMap<_, _> = base.iter().copied().collect();
        match self {
            Six | MinorSix => {
                degrees.insert(6, 0);
            }
            Seven | MinorSeven | MinorSevenFlatFive | Nine | MinorNine | Eleven | MinorEleven
            | Thirteen | SevenSus4 => {
                degrees.insert(7, -1);
            }
            MajorSeven | MinorMajorSeven | MajorNine => {
                degrees.insert(7, 0);
            }
            DimSeven => {
                degrees.insert(7, -2);
            }
            _ => {}
        }
        if matches!(
            self,
            Nine | MajorNine | MinorNine | Eleven | MinorEleven | Thirteen
        ) {
            degrees.insert(9, 0);
        }
        if matches!(self, Eleven | MinorEleven | Thirteen) {
            degrees.insert(11, 0);
        }
        if matches!(self, Thirteen) {
            degrees.insert(13, 0);
        }
        degrees
    }
}

impl ChordRecipe {
    pub fn validate(&self) -> Result<(), String> {
        self.root.validate()?;
        if let Some(bass) = &self.bass {
            bass.validate()?;
        }
        let mut degrees = self.formula.degrees();
        let mut altered = HashSet::new();
        for alteration in &self.alterations {
            if ![5, 9, 11, 13].contains(&alteration.degree)
                || ![-1, 1].contains(&alteration.shift)
                || !altered.insert(alteration.degree)
                || degrees
                    .get(&alteration.degree)
                    .is_some_and(|shift| *shift != 0)
            {
                return Err("Invalid or contradictory chord alteration.".into());
            }
            degrees.insert(alteration.degree, alteration.shift);
        }
        let mut omitted = HashSet::new();
        for degree in &self.omissions {
            if ![1, 2, 3, 4, 5, 6, 7, 9, 11, 13].contains(degree)
                || !omitted.insert(*degree)
                || degrees.remove(degree).is_none()
            {
                return Err("Invalid, duplicate or absent chord omission.".into());
            }
        }
        if degrees.is_empty() {
            return Err("A chord recipe needs at least one tone.".into());
        }
        Ok(())
    }

    pub fn format_name(&self) -> Result<String, String> {
        self.validate()?;
        let suffix = match self.formula {
            ChordFormulaId::Major => "",
            ChordFormulaId::Minor => "m",
            ChordFormulaId::Power => "5",
            _ => self.formula.as_ref(),
        };
        let mut name = format!("{}{suffix}", self.root.name());
        let mut alterations: Vec<_> = self.alterations.iter().collect();
        alterations.sort_by_key(|alteration| alteration.degree);
        let mut modifiers: Vec<_> = alterations
            .iter()
            .map(|alteration| {
                format!(
                    "{}{}",
                    if alteration.shift < 0 { "b" } else { "#" },
                    alteration.degree
                )
            })
            .collect();
        let mut omissions = self.omissions.clone();
        omissions.sort_unstable();
        modifiers.extend(omissions.iter().map(|degree| format!("no{degree}")));
        if !modifiers.is_empty() {
            name.push_str(&format!("({})", modifiers.join(",")));
        }
        if let Some(bass) = &self.bass {
            name.push_str(&format!("/{}", bass.name()));
        }
        Ok(name)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarmonyChord {
    pub name: String,
    pub name_mode: HarmonyNameMode,
    #[serde(deserialize_with = "required_nullable")]
    pub recipe: Option<ChordRecipe>,
    pub first_fret: u8,
    pub frets: Vec<i32>,
    pub fingers: Vec<i8>,
    pub barre_frets: Vec<u8>,
    pub show_name: bool,
    pub show_diagram: bool,
    pub show_fingering: bool,
}

impl HarmonyChord {
    pub fn validate(&self) -> Result<(), String> {
        if self.first_fret > 127
            || self.frets.len() > 12
            || self.frets.len() != self.fingers.len()
            || self.frets.iter().any(|fret| !(-1..=127).contains(fret))
            || self.fingers.iter().any(|finger| !(-2..=4).contains(finger))
            || self.barre_frets.iter().any(|fret| *fret > 127)
        {
            return Err("Invalid harmony chord snapshot.".into());
        }
        match (&self.name_mode, &self.recipe) {
            (HarmonyNameMode::Manual, None) => Ok(()),
            (HarmonyNameMode::Theory, Some(recipe)) if self.name == recipe.format_name()? => Ok(()),
            _ => Err("Chord name mode, recipe and formatted name must agree.".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HarmonyInterval {
    Semitones {
        semitones: i32,
    },
    Chromatic {
        number: u8,
        quality: IntervalQuality,
        direction: IntervalDirection,
        octaves: u8,
    },
    Diatonic {
        steps: i32,
    },
}

impl HarmonyInterval {
    pub fn validate(&self) -> Result<(), String> {
        let semitones = match self {
            Self::Semitones { semitones } => *semitones,
            Self::Diatonic { steps } => {
                return if *steps != 0 && (-70..=70).contains(steps) {
                    Ok(())
                } else {
                    Err("Diatonic steps must be nonzero from -70 to 70.".into())
                };
            }
            Self::Chromatic {
                number,
                quality,
                direction,
                octaves,
            } => {
                if !(1..=7).contains(number) || *octaves > 9 {
                    return Err("Unsupported chromatic interval number or octave count.".into());
                }
                let perfect = [1, 4, 5].contains(number);
                let adjustment = match quality {
                    IntervalQuality::Perfect if perfect => 0,
                    IntervalQuality::Major if !perfect => 0,
                    IntervalQuality::Minor if !perfect => -1,
                    IntervalQuality::Augmented => 1,
                    IntervalQuality::Diminished if *number != 1 => {
                        if perfect {
                            -1
                        } else {
                            -2
                        }
                    }
                    _ => return Err("Interval quality is incompatible with its number.".into()),
                };
                let magnitude = [0, 2, 4, 5, 7, 9, 11][*number as usize - 1]
                    + adjustment
                    + i32::from(*octaves) * 12;
                if direction == &IntervalDirection::Down {
                    -magnitude
                } else {
                    magnitude
                }
            }
        };
        if semitones == 0 || !(-127..=127).contains(&semitones) {
            return Err("Transpose by a nonzero semitone count from -127 to 127.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarmonyLibraryEntry {
    pub id: String,
    pub label: String,
    pub chord: HarmonyChord,
    pub tuning: Vec<i32>,
    pub capo: u8,
    pub transposition: i32,
}

pub fn validate_uuid(id: &str) -> Result<(), String> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("Library entry identity must be a UUID.".into());
    }
    Ok(())
}

impl HarmonyLibraryEntry {
    pub fn validate(&self) -> Result<(), String> {
        validate_uuid(&self.id)?;
        if !(1..=200).contains(&self.label.chars().count())
            || self.tuning.len() > 12
            || self.tuning.iter().any(|pitch| !(0..=127).contains(pitch))
            || self.capo > 127
            || !(-127..=127).contains(&self.transposition)
        {
            return Err("Invalid harmony library label or instrument context.".into());
        }
        self.chord.validate()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarmonyLibrary {
    pub format: String,
    pub version: u32,
    pub entries: Vec<HarmonyLibraryEntry>,
}

impl HarmonyLibrary {
    pub fn validate(&self) -> Result<(), String> {
        if self.format != "TabPlayerHarmonyLibrary" || self.version != 1 {
            return Err("Unsupported harmony library format or version.".into());
        }
        let mut seen = HashSet::new();
        for entry in &self.entries {
            entry.validate()?;
            if !seen.insert(entry.id.to_ascii_lowercase()) {
                return Err("Harmony library entries must have distinct UUIDs.".into());
            }
        }
        Ok(())
    }
}

named_enum!(ScaleMarkShape {
    Circle = "circle", Square = "square", Diamond = "diamond", Triangle = "triangle", Cross = "cross"
});
named_enum!(ScaleOrientation { Horizontal = "horizontal", Vertical = "vertical" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScaleMark {
    pub string: u8,
    pub fret: u8,
    pub shape: ScaleMarkShape,
    pub color: String,
    pub text: String,
    pub text_color: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScaleDiagram {
    pub name: String,
    pub strings: u8,
    pub frets: u8,
    pub first_fret: u8,
    pub orientation: ScaleOrientation,
    pub show_fret_markers: bool,
    pub marks: Vec<ScaleMark>,
}

/// Text an XML 1.0 document can hold: no control characters and no U+FFFE or U+FFFF.
fn xml_text(value: &str) -> bool {
    !value
        .chars()
        .any(|c| c.is_control() || c == '\u{fffe}' || c == '\u{ffff}')
}

fn hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl ScaleDiagram {
    pub fn validate(&self) -> Result<(), String> {
        let last = i32::from(self.first_fret) + i32::from(self.frets) - 1;
        if self.name.chars().count() > 64
            || !xml_text(&self.name)
            || !(3..=10).contains(&self.strings)
            || !(4..=24).contains(&self.frets)
            || self.first_fret < 1
            || last > 127
            || self.marks.len() > usize::from(self.strings) * (usize::from(self.frets) + 1)
        {
            return Err("Invalid scale diagram.".into());
        }
        let mut seen = HashSet::new();
        for mark in &self.marks {
            let in_window = (i32::from(self.first_fret)..=last).contains(&i32::from(mark.fret));
            if !(1..=self.strings).contains(&mark.string)
                || !(mark.fret == 0 || in_window)
                || !seen.insert((mark.string, mark.fret))
                || mark.text.chars().count() > 3
                || !xml_text(&mark.text)
                || !hex_color(&mark.color)
                || !hex_color(&mark.text_color)
            {
                return Err("Invalid scale diagram mark.".into());
            }
        }
        Ok(())
    }
}
