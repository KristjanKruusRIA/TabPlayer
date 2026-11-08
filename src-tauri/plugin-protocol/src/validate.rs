//! The class ID and name rules. One implementation, used by `ClassInfo::validate` here, by the app's `PluginSlot::validate`
//! and by the helper (preflight ruling P10).
use crate::limits::MAX_NAME_CHARS;

/// A VST3 class ID as the protocol writes it: exactly 32 uppercase hexadecimal characters.
pub fn valid_class_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

/// A character an XML 1.0 document can hold. This is the rule the cabinet impulse response names already use.
fn xml_char(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{D}' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}'
    )
}

/// Text of at most `max_chars` characters that is XML-safe and equals its own trim. The names are validated, not
/// normalized, so the sender trims (`str::trim` and JavaScript's trim differ only at U+0085 and U+FEFF, which are
/// refused at either end so both sides agree).
pub fn valid_text(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty())
        && value.trim() == value
        && !value.starts_with(['\u{feff}', '\u{85}'])
        && !value.ends_with(['\u{feff}', '\u{85}'])
        && value.chars().count() <= max_chars
        && value.chars().all(xml_char)
}

/// A plug-in name: 1 to [`MAX_NAME_CHARS`] characters.
pub fn valid_name(value: &str) -> bool {
    valid_text(value, MAX_NAME_CHARS, false)
}

/// A vendor name: 0 to [`MAX_NAME_CHARS`] characters.
pub fn valid_vendor(value: &str) -> bool {
    valid_text(value, MAX_NAME_CHARS, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_ids_are_32_uppercase_hex() {
        assert!(valid_class_id("0123456789ABCDEF0123456789ABCDEF"));
        for bad in [
            "",
            "0123456789ABCDEF0123456789ABCDE",
            "0123456789ABCDEF0123456789ABCDEF0",
            "0123456789abcdef0123456789abcdef",
            "0123456789ABCDEF0123456789ABCDEG",
            "0123456789ABCDEF0123456789ABCDE\u{e9}",
            "0123456789ABCDEF 123456789ABCDEF",
        ] {
            assert!(!valid_class_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn names_follow_the_cabinet_rule() {
        assert!(valid_name("Amped ML5"));
        assert!(valid_name(&"x".repeat(MAX_NAME_CHARS)));
        assert!(valid_name(&"\u{e9}".repeat(MAX_NAME_CHARS)));
        for bad in [
            String::new(),
            "x".repeat(MAX_NAME_CHARS + 1),
            " padded".into(),
            "padded ".into(),
            "bell\u{7}".into(),
            "nul\0".into(),
            "\u{feff}bom".into(),
            "tail\u{85}".into(),
            "bad\u{fffe}".into(),
        ] {
            assert!(!valid_name(&bad), "{bad:?}");
        }
        assert!(valid_vendor(""));
        assert!(!valid_vendor(" x"));
    }
}
