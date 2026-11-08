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

/// Characters of the Unicode "format" category and the like that a name must not hold: the soft hyphen, zero-width and
/// bidirectional marks, word joiners and invisible operators, the byte-order mark and the interlinear annotation marks.
/// Some look like nothing at all (U+200B) and some change how text reads (U+202E), and `valid_text` lets most of them by.
fn format_char(c: char) -> bool {
    matches!(
        c,
        '\u{AD}'
            | '\u{61C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// `raw` as protocol text of at most `max_chars` characters: tab and line breaks become spaces, other control, format and
/// non-characters are dropped, and the result is trimmed (twice, because the cut can expose a space). Other white space,
/// such as U+00A0 and U+3000, is kept as it is: names in Japanese and in other scripts use it. The helper cleans every name
/// it sends with this, and the app cleans again what it receives, so both agree on what a name is (Task 10 review,
/// finding 5). The result is empty or passes [`valid_text`].
pub fn clean_text(raw: &str, max_chars: usize) -> String {
    let kept: String = raw
        .chars()
        .filter_map(|c| match c {
            '\t' | '\n' | '\r' => Some(' '),
            c if c.is_control() || format_char(c) || !xml_char(c) => None,
            c => Some(c),
        })
        .collect();
    let cut: String = kept.trim().chars().take(max_chars).collect();
    cut.trim().to_string()
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

    #[test]
    fn cleaned_text_keeps_what_is_valid_and_drops_look_alikes() {
        // A name that is already valid comes back unchanged, white space of other scripts included.
        for text in [
            "Amp\u{a0}Sim\u{3000}Pro",
            "Neural\u{a0}DSP",
            "Amped ML5",
            "\u{e9}t\u{e9}",
            "a\u{2009}b",
        ] {
            assert!(valid_name(text), "{text:?}");
            assert_eq!(clean_text(text, MAX_NAME_CHARS), text);
        }
        // Zero-width and bidirectional characters are removed; tabs and line breaks become spaces.
        assert_eq!(clean_text("Neural\u{200b} DSP", 64), "Neural DSP");
        assert_eq!(clean_text("a\u{ad}b\u{2060}c\u{202e}d\u{7}e", 64), "abcde");
        assert_eq!(clean_text("  Tab\tand\nbreak ", 64), "Tab and break");
        assert_eq!(clean_text(&"x".repeat(100), 64).len(), 64);
        assert_eq!(
            clean_text(&format!("{} z", "y".repeat(63)), 64),
            "y".repeat(63)
        );
        assert_eq!(clean_text("\u{feff}\u{85}\u{a0}", 64), "");
    }
}
