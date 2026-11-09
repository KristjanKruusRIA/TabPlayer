//! What a probe reports: the audio-effect classes of a bundle, with names the protocol accepts.
//!
//! A plug-in's names arrive raw from third-party code, and the protocol's validators refuse control and bidirectional
//! characters (`tabplayer_plugin_protocol::validate`). So names are cleaned here, the way `cabinet_ir::display_name`
//! cleans a file name, before they are sent: control, format and non-characters are dropped, white space is trimmed and
//! the text is cut to its cap.
use tabplayer_plugin_protocol::{
    control::ClassInfo,
    limits::{MAX_CLASSES, MAX_NAME_CHARS, MAX_SUBCATEGORIES_CHARS, MAX_VERSION_CHARS},
    validate::clean_text,
};

/// The category of a VST3 class that is a processor.
const AUDIO_CLASS: &str = "Audio Module Class";
/// What a nameless class is called.
const UNNAMED: &str = "Unnamed plug-in";

/// A class as the factory reports it, before cleaning.
#[derive(Debug, Clone)]
pub struct RawClassInfo {
    pub cid: [u8; 16],
    pub category: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub sub_categories: String,
}

/// The 32 uppercase hexadecimal characters of a class ID: its 16 bytes in order.
pub fn class_id_text(cid: &[u8; 16]) -> String {
    cid.iter().map(|b| format!("{b:02X}")).collect()
}

/// The bytes of a class ID in the protocol's form, or none.
pub fn class_id_bytes(text: &str) -> Option<[u8; 16]> {
    if !tabplayer_plugin_protocol::validate::valid_class_id(text) {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// Whether a class is an audio effect: a processor class whose sub-categories name `Fx` and not `Instrument`. A class
/// without sub-categories (a version 1 factory) is not offered, since it could just as well be a synthesizer.
pub fn is_audio_effect(class: &RawClassInfo) -> bool {
    if class.category != AUDIO_CLASS {
        return false;
    }
    let mut fx = false;
    for token in class.sub_categories.split('|') {
        let token = token.trim();
        if token.eq_ignore_ascii_case("Instrument") {
            return false;
        }
        fx |= token.eq_ignore_ascii_case("Fx");
    }
    fx
}

/// One class as the protocol sends it.
pub fn clean_class(class: &RawClassInfo) -> ClassInfo {
    let mut name = clean_text(&class.name, MAX_NAME_CHARS);
    if name.is_empty() {
        name = UNNAMED.into();
    }
    ClassInfo {
        class_id: class_id_text(&class.cid),
        name,
        vendor: clean_text(&class.vendor, MAX_NAME_CHARS),
        version: clean_text(&class.version, MAX_VERSION_CHARS),
        subcategories: clean_text(&class.sub_categories, MAX_SUBCATEGORIES_CHARS),
    }
}

/// The audio-effect classes of a bundle, cleaned, at most [`MAX_CLASSES`], each class ID once.
pub fn effect_classes(raw: &[RawClassInfo]) -> Vec<ClassInfo> {
    let mut out: Vec<ClassInfo> = Vec::new();
    for class in raw.iter().filter(|c| is_audio_effect(c)) {
        let info = clean_class(class);
        if out.iter().all(|seen| seen.class_id != info.class_id) {
            out.push(info);
        }
        if out.len() == MAX_CLASSES {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(name: &str, category: &str, sub: &str) -> RawClassInfo {
        RawClassInfo {
            cid: [0xAB; 16],
            category: category.into(),
            name: name.into(),
            vendor: "Vendor".into(),
            version: "1.0".into(),
            sub_categories: sub.into(),
        }
    }

    #[test]
    fn class_ids_round_trip_in_byte_order() {
        let cid: [u8; 16] = std::array::from_fn(|i| (i as u8) * 17);
        let text = class_id_text(&cid);
        assert_eq!(text, "00112233445566778899AABBCCDDEEFF");
        assert_eq!(class_id_bytes(&text), Some(cid));
        assert_eq!(class_id_bytes("00112233445566778899aabbccddeeff"), None);
        assert_eq!(class_id_bytes("0011"), None);
    }

    #[test]
    fn hostile_names_become_names_the_protocol_accepts() {
        let hostile = [
            "  Amp\u{7}\u{0}Sim  ",
            "Tab\tand\nbreak\rhere",
            "\u{202E}drow\u{202C}ed",
            "\u{FEFF}bom",
            "tail\u{85}",
            "mark\u{200F}\u{200B}",
            "bad\u{FFFE}\u{FFFF}char",
            "\u{2066}isolate\u{2069}",
            &"x".repeat(500),
            &format!("{} ", "y".repeat(63)),
            &"\u{e9}".repeat(100),
            "  \u{a0}  ",
            "",
        ];
        for text in hostile {
            let name = clean_text(text, MAX_NAME_CHARS);
            assert!(
                name.is_empty() || tabplayer_plugin_protocol::validate::valid_name(&name),
                "{text:?} became {name:?}"
            );
            assert!(name.chars().count() <= MAX_NAME_CHARS);
            let class = clean_class(&raw(text, AUDIO_CLASS, "Fx"));
            assert!(class.validate().is_ok(), "{text:?}: {class:?}");
        }
        assert_eq!(clean_text("Tab\tand\nbreak", 64), "Tab and break");
        assert_eq!(clean_text("  Amp  ", 64), "Amp");
        assert_eq!(clean_class(&raw("", AUDIO_CLASS, "Fx")).name, UNNAMED);
    }

    #[test]
    fn only_audio_effects_are_listed() {
        let mut effect = raw("Amp", AUDIO_CLASS, "Fx|Distortion");
        effect.cid = [1; 16];
        let mut synth = raw("Synth", AUDIO_CLASS, "Instrument|Synth");
        synth.cid = [2; 16];
        let mut controller = raw("Amp", "Component Controller Class", "");
        controller.cid = [3; 16];
        let mut plain = raw("Old", AUDIO_CLASS, "");
        plain.cid = [4; 16];
        let mut both = raw("Odd", AUDIO_CLASS, "Fx|Instrument");
        both.cid = [5; 16];
        let mut lower = raw("Lower", AUDIO_CLASS, "fx");
        lower.cid = [6; 16];
        let listed = effect_classes(&[
            effect.clone(),
            synth,
            controller,
            plain,
            both,
            lower,
            effect,
        ]);
        let names: Vec<_> = listed.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Amp", "Lower"],
            "duplicates and non-effects are dropped"
        );
        assert_eq!(listed[0].class_id, "01".repeat(16));
    }

    #[test]
    fn at_most_sixty_four_classes_are_listed() {
        let many: Vec<RawClassInfo> = (0..200u8)
            .map(|i| {
                let mut c = raw(&format!("Amp {i}"), AUDIO_CLASS, "Fx");
                c.cid = [i; 16];
                c
            })
            .collect();
        assert_eq!(effect_classes(&many).len(), MAX_CLASSES);
    }
}
