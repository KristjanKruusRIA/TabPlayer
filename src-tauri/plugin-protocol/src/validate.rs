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

/// The bidirectional formatting characters, which can make a name read differently from how it is stored.
fn bidi_control(c: char) -> bool {
    matches!(c, '\u{61C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Text of at most `max_chars` characters that is XML-safe, holds no control or bidi control character (tab, line feed
/// and carriage return included) and equals its own trim. This is the cabinet impulse response name rule, tightened:
/// those names are cleaned by `cabinet_ir::display_name` before they reach the rule, but plug-in names arrive raw from
/// third-party code. Names are validated, not normalized, so the sender cleans them first the same way (Task 8): drop
/// control, format and non-characters, trim, cut to 64. `str::trim` and JavaScript's trim differ only at U+0085 and
/// U+FEFF, which are refused at either end so both sides agree.
pub fn valid_text(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty())
        && value.trim() == value
        && !value.starts_with(['\u{feff}', '\u{85}'])
        && !value.ends_with(['\u{feff}', '\u{85}'])
        && value.chars().count() <= max_chars
        && value
            .chars()
            .all(|c| xml_char(c) && !c.is_control() && !bidi_control(c))
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
            "tab\there".into(),
            "line\nbreak".into(),
            "carriage\rreturn".into(),
            "c1\u{85}middle".into(),
            "del\u{7f}".into(),
            "rtl\u{202e}override".into(),
            "mark\u{200f}".into(),
            "isolate\u{2066}x".into(),
        ] {
            assert!(!valid_name(&bad), "{bad:?}");
        }
        assert!(valid_vendor(""));
        assert!(!valid_vendor(" x"));
    }
}
