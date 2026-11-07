use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};
use svg2pdf::{ConversionOptions, usvg};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SvgPage {
    pub svg: String,
    pub width_mm: f32,
    pub height_mm: f32,
}

/// Alias families the webview draws role text with, and the real family each stands for. The SVG names the alias; the weight and slant
/// the role chose arrive as the text's `font-weight` and `font-style`.
const FONT_ALIASES: [(&str, &str); 3] = [
    ("TabPlayer Sans", "Noto Sans"),
    ("TabPlayer Serif", "Noto Serif"),
    ("TabPlayer Mono", "Noto Sans Mono"),
];

fn real_family(name: &str) -> Option<&'static str> {
    FONT_ALIASES
        .iter()
        .find(|(alias, _)| *alias == name)
        .map(|(_, real)| *real)
}

/// Loads every bundled face. The four faces bundled before D12 go first, in their original order, and their IDs are returned: they are the
/// only faces glyph fallback may use (see `legacy_fallback_selector`).
fn load_export_fonts(database: &mut usvg::fontdb::Database) -> Vec<usvg::fontdb::ID> {
    let mut legacy = Vec::new();
    for bytes in [
        include_bytes!("../../../assets/fonts/Bravura.otf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSans-Regular.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSansCJKjp-Regular.otf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoEmoji.ttf").as_slice(),
    ] {
        legacy.extend(database.load_font_source(usvg::fontdb::Source::Binary(
            std::sync::Arc::new(bytes.to_vec()),
        )));
    }
    for bytes in [
        include_bytes!("../../../assets/fonts/NotoSans-Bold.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSans-Italic.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSans-BoldItalic.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSerif-Regular.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSerif-Bold.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSerif-Italic.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSerif-BoldItalic.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSansMono-Regular.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSansMono-Bold.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/Petaluma.otf").as_slice(),
        include_bytes!("../../../assets/fonts/Leland.otf").as_slice(),
    ] {
        database.load_font_data(bytes.to_vec());
    }
    legacy
}

/// Font selection with the alias families mapped to their real families. A request that names an alias asks for the weight and slant
/// it carries. A request that names none asks for normal style and weight 400, which is the one face each family had before D12.
fn alias_font_selector() -> usvg::FontSelectionFn<'static> {
    Box::new(|font, fontdb| {
        use usvg::fontdb::Family;
        let aliased = font.families().iter().any(
            |family| matches!(family, usvg::FontFamily::Named(name) if real_family(name).is_some()),
        );
        let mut names = Vec::new();
        for family in font.families() {
            names.push(match family {
                usvg::FontFamily::Serif => Family::Serif,
                usvg::FontFamily::SansSerif => Family::SansSerif,
                usvg::FontFamily::Cursive => Family::Cursive,
                usvg::FontFamily::Fantasy => Family::Fantasy,
                usvg::FontFamily::Monospace => Family::Monospace,
                usvg::FontFamily::Named(name) => Family::Name(real_family(name).unwrap_or(name)),
            });
        }
        // The default font, as usvg's own selector ends its list.
        names.push(Family::Serif);
        let (weight, style, stretch) = if aliased {
            (
                usvg::fontdb::Weight(font.weight()),
                match font.style() {
                    usvg::FontStyle::Normal => usvg::fontdb::Style::Normal,
                    usvg::FontStyle::Italic => usvg::fontdb::Style::Italic,
                    usvg::FontStyle::Oblique => usvg::fontdb::Style::Oblique,
                },
                match font.stretch() {
                    usvg::FontStretch::UltraCondensed => usvg::fontdb::Stretch::UltraCondensed,
                    usvg::FontStretch::ExtraCondensed => usvg::fontdb::Stretch::ExtraCondensed,
                    usvg::FontStretch::Condensed => usvg::fontdb::Stretch::Condensed,
                    usvg::FontStretch::SemiCondensed => usvg::fontdb::Stretch::SemiCondensed,
                    usvg::FontStretch::Normal => usvg::fontdb::Stretch::Normal,
                    usvg::FontStretch::SemiExpanded => usvg::fontdb::Stretch::SemiExpanded,
                    usvg::FontStretch::Expanded => usvg::fontdb::Stretch::Expanded,
                    usvg::FontStretch::ExtraExpanded => usvg::fontdb::Stretch::ExtraExpanded,
                    usvg::FontStretch::UltraExpanded => usvg::fontdb::Stretch::UltraExpanded,
                },
            )
        } else {
            (
                usvg::fontdb::Weight::NORMAL,
                usvg::fontdb::Style::Normal,
                usvg::fontdb::Stretch::Normal,
            )
        };
        fontdb.query(&usvg::fontdb::Query {
            families: &names,
            weight,
            stretch,
            style,
        })
    })
}

/// usvg's own fallback search (same style rule, database order) limited to `allowed`: every other face counts as already used.
/// The allowed faces are the four bundled before D12, loaded first, so a default document resolves each missing glyph exactly as before.
fn legacy_fallback_selector(allowed: Vec<usvg::fontdb::ID>) -> usvg::FallbackSelectionFn<'static> {
    let default = usvg::FontResolver::default_fallback_selector();
    Box::new(move |c, used, fontdb| {
        let mut excluded = used.to_vec();
        excluded.extend(
            fontdb
                .faces()
                .map(|face| face.id)
                .filter(|id| !allowed.contains(id)),
        );
        default(c, &excluded, fontdb)
    })
}

/// Bundled fonts only, with every external or embedded resource denied.
pub(crate) fn export_options() -> usvg::Options<'static> {
    let mut options = usvg::Options {
        font_family: "Noto Sans".into(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    let legacy = load_export_fonts(options.fontdb_mut());
    options.fontdb_mut().set_sans_serif_family("Noto Sans");
    options.fontdb_mut().set_serif_family("Noto Sans");
    options.font_resolver = usvg::FontResolver {
        select_font: alias_font_selector(),
        select_fallback: legacy_fallback_selector(legacy),
    };
    options
}
/// Checks one rendered page and parses it with the export options.
pub(crate) fn notation_tree(
    page: &SvgPage,
    options: &usvg::Options,
    kind: &str,
) -> Result<usvg::Tree, String> {
    if !page.width_mm.is_finite()
        || !page.height_mm.is_finite()
        || page.width_mm < 20.0
        || page.width_mm > 1000.0
        || page.height_mm < 20.0
        || page.height_mm > 1000.0
        || page.svg.len() > 20_000_000
    {
        return Err(format!("Invalid {kind} page size or content."));
    }
    // Notation is entirely vector/text. Reject resource-bearing markup even though resolvers also deny it.
    let lower = page.svg.to_ascii_lowercase();
    if [
        "<image",
        "<script",
        "<foreignobject",
        "<!doctype",
        "<!entity",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        return Err("External SVG resources are not supported in score exports.".into());
    }
    usvg::Tree::from_str(&page.svg, options).map_err(|e| format!("Invalid notation SVG: {e}"))
}
pub fn convert_pages(pages: &[SvgPage], cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    convert_pages_with_progress(pages, cancel, |_| {})
}
pub fn convert_pages_with_progress(
    pages: &[SvgPage],
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<Vec<u8>, String> {
    if pages.is_empty() || pages.len() > 2000 {
        return Err("Choose between one and 2000 printable pages.".into());
    }
    let options = export_options();
    let mut alloc = Ref::new(1);
    let catalog = alloc.bump();
    let tree_id = alloc.bump();
    let page_ids: Vec<_> = (0..pages.len()).map(|_| alloc.bump()).collect();
    let mut pdf = Pdf::new();
    pdf.catalog(catalog).pages(tree_id);
    pdf.pages(tree_id)
        .kids(page_ids.iter().copied())
        .count(pages.len() as i32);
    for (index, (page, page_id)) in pages.iter().zip(page_ids).enumerate() {
        if cancel.load(Ordering::Acquire) {
            return Err("PDF export cancelled.".into());
        }
        let tree = notation_tree(page, &options, "PDF")?;
        let (chunk, svg_id) = svg2pdf::to_chunk(
            &tree,
            ConversionOptions {
                pdfa: true,
                ..ConversionOptions::default()
            },
        )
        .map_err(|e| format!("Could not convert notation to PDF: {e}"))?;
        let mut map = HashMap::new();
        let chunk = chunk.renumber(|old| *map.entry(old).or_insert_with(|| alloc.bump()));
        let svg_id = map[&svg_id];
        let content_id = alloc.bump();
        let width = page.width_mm * 72.0 / 25.4;
        let height = page.height_mm * 72.0 / 25.4;
        let mut p = pdf.page(page_id);
        p.parent(tree_id)
            .media_box(Rect::new(0.0, 0.0, width, height))
            .contents(content_id);
        p.resources().x_objects().pair(Name(b"Score"), svg_id);
        p.finish();
        let mut content = Content::new();
        content
            .transform([width, 0.0, 0.0, height, 0.0, 0.0])
            .x_object(Name(b"Score"));
        pdf.stream(content_id, &content.finish());
        pdf.extend(&chunk);
        progress(index as u64 + 1);
    }
    if cancel.load(Ordering::Acquire) {
        return Err("PDF export cancelled.".into());
    }
    Ok(pdf.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn page() -> SvgPage {
        SvgPage { width_mm:210.0,height_mm:297.0,svg:"<svg xmlns='http://www.w3.org/2000/svg' width='210mm' height='297mm' viewBox='0 0 794 1123'><rect x='30' y='30' width='20' height='20'/><text x='60' y='70' font-family='Noto Sans'>TabPlayer Ä</text><text x='100' y='100' font-family='Bravura' font-size='34'>&#57424;</text></svg>".into() }
    }
    /// The face (PostScript name) that serves each glyph of `text` drawn with the given text attributes, in glyph order.
    fn serving_faces(
        options: &usvg::Options,
        attributes: &str,
        text: &str,
    ) -> Vec<(String, String)> {
        let svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='2000' height='100'><text x='10' y='50' font-size='24' {attributes}>{text}</text></svg>"
        );
        let tree = usvg::Tree::from_str(&svg, options).unwrap();
        let usvg::Node::Text(text) = &tree.root().children()[0] else {
            panic!("Expected text");
        };
        text.layouted()
            .iter()
            .flat_map(|span| &span.positioned_glyphs)
            .map(|glyph| {
                let face = tree.fontdb().face(glyph.font).unwrap();
                let name = if glyph.id.0 == 0 {
                    format!("missing:{}", face.post_script_name)
                } else {
                    face.post_script_name.clone()
                };
                (glyph.text.clone(), name)
            })
            .collect()
    }
    /// The face serving each character drawn alone, one text node apiece, so a character no face has cannot stop the others from resolving.
    fn serving_faces_each(
        options: &usvg::Options,
        attributes: &str,
        characters: impl Iterator<Item = char>,
    ) -> Vec<(char, String)> {
        let characters: Vec<char> = characters.filter(|c| !c.is_whitespace()).collect();
        let body: String = characters
            .iter()
            .map(|c| {
                let c = match c {
                    '&' => "&amp;".to_string(),
                    '<' => "&lt;".to_string(),
                    '>' => "&gt;".to_string(),
                    other => other.to_string(),
                };
                format!("<text x='10' y='50' font-size='24' {attributes}>{c}</text>")
            })
            .collect();
        let svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'>{body}</svg>"
        );
        let tree = usvg::Tree::from_str(&svg, options).unwrap();
        tree.root()
            .children()
            .iter()
            .zip(characters)
            .filter_map(|(node, character)| {
                let usvg::Node::Text(text) = node else {
                    return None;
                };
                let glyph = text
                    .layouted()
                    .iter()
                    .flat_map(|span| &span.positioned_glyphs)
                    .next()?;
                let face = tree.fontdb().face(glyph.font).unwrap();
                Some((
                    character,
                    if glyph.id.0 == 0 {
                        format!("missing:{}", face.post_script_name)
                    } else {
                        face.post_script_name.clone()
                    },
                ))
            })
            .collect()
    }
    #[test]
    fn sharp_in_text_resolves_like_before() {
        // Characterization, recorded before the D12 font selectors existed: a default `Noto Sans` run reaches the music
        // accidentals through the fallback chain, and the chain's order must not change.
        let options = export_options();
        let faces = serving_faces(
            &options,
            "font-family='Noto Sans'",
            "\u{266f}\u{266d}\u{266e}",
        );
        assert_eq!(
            faces,
            vec![
                ("\u{266f}".to_string(), "Bravura".to_string()),
                ("\u{266d}".to_string(), "Bravura".to_string()),
                ("\u{266e}".to_string(), "Bravura".to_string()),
            ]
        );
    }
    /// The export options as they were before D12: four bundled faces, usvg's default resolver.
    fn pre_d12_options() -> usvg::Options<'static> {
        let mut options = usvg::Options {
            font_family: "Noto Sans".into(),
            ..usvg::Options::default()
        };
        for bytes in [
            include_bytes!("../../../assets/fonts/Bravura.otf").as_slice(),
            include_bytes!("../../../assets/fonts/NotoSans-Regular.ttf").as_slice(),
            include_bytes!("../../../assets/fonts/NotoSansCJKjp-Regular.otf").as_slice(),
            include_bytes!("../../../assets/fonts/NotoEmoji.ttf").as_slice(),
        ] {
            options.fontdb_mut().load_font_data(bytes.to_vec());
        }
        options.fontdb_mut().set_sans_serif_family("Noto Sans");
        options.fontdb_mut().set_serif_family("Noto Sans");
        options
    }
    const ALIAS_STACK: &str = "Noto Sans, Noto Sans CJK JP, Noto Emoji";
    #[test]
    fn alias_family_resolves_real_face_with_style() {
        let options = export_options();
        for (alias, style, expected) in [
            (
                "TabPlayer Serif",
                "font-weight='700' font-style='italic'",
                "NotoSerif-BoldItalic",
            ),
            ("TabPlayer Serif", "", "NotoSerif-Regular"),
            ("TabPlayer Serif", "font-style='italic'", "NotoSerif-Italic"),
            ("TabPlayer Sans", "font-weight='700'", "NotoSans-Bold"),
            (
                "TabPlayer Sans",
                "font-weight='700' font-style='italic'",
                "NotoSans-BoldItalic",
            ),
            ("TabPlayer Mono", "font-weight='700'", "NotoSansMono-Bold"),
            ("TabPlayer Mono", "", "NotoSansMono-Regular"),
        ] {
            let faces = serving_faces(
                &options,
                &format!("font-family='{alias}, {ALIAS_STACK}' {style}"),
                "Abc",
            );
            assert_eq!(faces.len(), 3, "{alias} {style}");
            assert!(
                faces.iter().all(|(_, face)| face == expected),
                "{alias} {style}: {faces:?}"
            );
        }
    }
    #[test]
    fn alias_family_resolves_from_the_font_shorthand_alphatab_writes() {
        // alphaTab styles its text with `font:` in a style attribute, quoting each family and putting weight and slant first.
        let options = export_options();
        for (shorthand, expected) in [
            (
                "italic bold 12px \"TabPlayer Serif\", \"Noto Sans\", \"Noto Sans CJK JP\", \"Noto Emoji\"",
                "NotoSerif-BoldItalic",
            ),
            (
                "bold 14px \"TabPlayer Mono\", \"Noto Sans\"",
                "NotoSansMono-Bold",
            ),
            (
                "italic 12px \"Noto Sans\", \"Noto Sans CJK JP\", \"Noto Emoji\"",
                "NotoSans-Regular",
            ),
        ] {
            let faces = serving_faces(&options, &format!("style='font:{shorthand}'"), "Abc");
            assert!(
                faces.iter().all(|(_, face)| face == expected),
                "{shorthand}: {faces:?}"
            );
        }
    }
    #[test]
    fn default_requests_keep_pre_d12_faces() {
        let before = pre_d12_options();
        let after = export_options();
        let sample = "Abc \u{d6}\u{f6} \u{540c}\u{3058}\u{697d}\u{8b5c} \u{1f3b8} \u{266f}\u{266d}\u{266e} \u{e050}";
        for attributes in [
            "font-family='Noto Sans'",
            "font-family='Noto Sans' font-style='italic'",
            "font-family='Noto Sans' font-weight='700'",
            "font-family='Noto Sans' font-weight='700' font-style='italic'",
            "font-family='Noto Sans, Noto Sans CJK JP, Noto Emoji' font-weight='700'",
            "font-family='Bravura'",
            "font-family='Bravura' font-weight='700' font-style='italic'",
            "font-family='Noto Sans CJK JP'",
            "font-family='Noto Emoji'",
            "font-family='serif'",
            "font-family='sans-serif' font-weight='700'",
            "font-family='Arial' font-style='italic'",
            "",
        ] {
            assert_eq!(
                serving_faces(&after, attributes, sample),
                serving_faces(&before, attributes, sample),
                "{attributes}"
            );
        }
        // The faces themselves, so the comparison cannot pass by both sides being wrong in the same way.
        let italic = serving_faces(&after, "font-family='Noto Sans' font-style='italic'", "Ab");
        assert!(italic.iter().all(|(_, face)| face == "NotoSans-Regular"));
        let bold = serving_faces(&after, "font-family='Noto Sans' font-weight='700'", "Ab");
        assert!(bold.iter().all(|(_, face)| face == "NotoSans-Regular"));
        let music = serving_faces(&after, "font-family='Bravura'", "\u{e050}");
        assert!(music.iter().all(|(_, face)| face == "Bravura"));
    }
    #[test]
    fn fallback_never_picks_new_faces() {
        let options = export_options();
        let legacy: Vec<String> = pre_d12_options()
            .fontdb
            .faces()
            .map(|face| face.post_script_name.clone())
            .collect();
        // Characters Noto Serif may lack: every glyph served by anything but the chosen face must come from a face bundled before D12.
        let faces = serving_faces_each(
            &options,
            &format!("font-family='TabPlayer Serif, {ALIAS_STACK}'"),
            (0x100u32..0x250)
                .chain(0x370..0x530)
                .chain(0x2190..0x2400)
                .chain(0x2500..0x27c0)
                .chain(0xe000..0xf400)
                .filter_map(char::from_u32),
        );
        assert!(!faces.is_empty());
        for (glyph, face) in &faces {
            let face = face.trim_start_matches("missing:");
            assert!(
                face == "NotoSerif-Regular" || legacy.iter().any(|name| name == face),
                "{glyph:?} fell to {face}"
            );
        }
        // The bundled Noto Sans covers nothing Noto Serif lacks, so the fallback that does happen goes to the music and CJK faces.
        assert!(
            faces.iter().any(|(_, face)| face == "Bravura"),
            "Fixture must contain a glyph that falls back"
        );
        // Directly: with every pre-D12 face already used, nothing is left even though Noto Serif and Noto Sans Mono have an `a`.
        let mut database = options.fontdb.clone();
        let all: Vec<usvg::fontdb::ID> = database.faces().map(|face| face.id).collect();
        let allowed: Vec<usvg::fontdb::ID> = pre_d12_options()
            .fontdb
            .faces()
            .filter_map(|old| {
                all.iter()
                    .copied()
                    .find(|id| database.face(*id).unwrap().post_script_name == old.post_script_name)
            })
            .collect();
        assert_eq!(allowed.len(), 4);
        let select = legacy_fallback_selector(allowed.clone());
        assert_eq!(select('a', &allowed, &mut database), None);
        let serif = all
            .iter()
            .copied()
            .find(|id| database.face(*id).unwrap().post_script_name == "NotoSerif-Regular")
            .unwrap();
        let picked = select('a', &[serif], &mut database).expect("a legacy face has an a");
        assert!(allowed.contains(&picked));
    }
    #[test]
    fn petaluma_missing_glyph_falls_back_to_bravura() {
        let options = export_options();
        let faces = serving_faces_each(
            &options,
            "font-family='Petaluma, Bravura'",
            (0xe000u32..0xf400).filter_map(char::from_u32),
        );
        assert!(faces.iter().any(|(_, face)| face.starts_with("Petaluma")));
        let from_bravura: Vec<_> = faces
            .iter()
            .filter(|(_, face)| face.starts_with("Bravura"))
            .collect();
        assert!(
            !from_bravura.is_empty(),
            "Some symbol must fall from Petaluma to Bravura"
        );
        // Everything served is either Petaluma or Bravura: no other face is used as a music fallback.
        assert!(faces.iter().all(|(_, face)| {
            let face = face.trim_start_matches("missing:");
            face.starts_with("Petaluma") || face.starts_with("Bravura")
        }));
    }
    #[test]
    fn pdf_embeds_chosen_faces() {
        let mut p = page();
        p.svg = "<svg xmlns='http://www.w3.org/2000/svg' width='210mm' height='297mm' viewBox='0 0 794 1123'><text x='60' y='70' font-family='TabPlayer Serif, Noto Sans, Noto Sans CJK JP, Noto Emoji' font-weight='700' font-style='italic' font-size='18'>Chosen</text><text x='100' y='200' font-family='Petaluma, Bravura' font-size='36'>&#57424;</text></svg>".into();
        let bytes = convert_pages(&[p], &AtomicBool::new(false)).unwrap();
        let content = String::from_utf8_lossy(&bytes);
        assert!(content.contains("NotoSerif-BoldItalic"));
        assert!(content.contains("Petaluma"));
        assert!(!content.contains("Bravura"));
    }
    #[test]
    fn merges_physical_vector_pages_with_embedded_bundled_fonts() {
        let bytes = convert_pages(&[page(), page()], &AtomicBool::new(false)).unwrap();
        let content = String::from_utf8_lossy(&bytes);
        assert!(content.starts_with("%PDF-"));
        assert!(content.contains("/Count 2"));
        assert!(content.contains("/FontFile"));
        assert!(!content.contains("/Subtype /Image"));
        assert!(content.contains("595.275"));
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.analysis/expansion/vector-export.pdf");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    #[test]
    fn exports_exact_mixed_unicode_title_with_vector_notation() {
        let mut p = page();
        p.svg = p.svg.replace(
            "TabPlayer Ä",
            "Öölaul — 同じ楽譜 🎸 · A very long independently authored document title for horizontal score tab overflow",
        );
        let mut options = usvg::Options::default();
        load_export_fonts(options.fontdb_mut());
        let tree = usvg::Tree::from_str(&p.svg, &options).unwrap();
        fn assert_resolved(group: &usvg::Group, tree: &usvg::Tree) {
            for node in group.children() {
                match node {
                    usvg::Node::Text(text) => {
                        for glyph in text
                            .layouted()
                            .iter()
                            .flat_map(|span| &span.positioned_glyphs)
                        {
                            assert_ne!(
                                glyph.id.0,
                                0,
                                "Unresolved mixed-title glyph {:?} using {:?}",
                                glyph.text,
                                tree.fontdb().face(glyph.font).unwrap().families
                            );
                        }
                    }
                    usvg::Node::Group(group) => assert_resolved(group, tree),
                    _ => {}
                }
            }
        }
        assert_resolved(tree.root(), &tree);
        let bytes = convert_pages(&[p], &AtomicBool::new(false)).unwrap();
        let content = String::from_utf8_lossy(&bytes);
        assert!(content.starts_with("%PDF-"));
        assert!(content.contains("/Count 1"));
        assert!(content.contains("/FontFile"));
        assert!(!content.contains("/Subtype /Image"));
        assert!(content.contains("595.275"));
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.analysis/parity/pdf-unicode-regression.pdf");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    #[test]
    fn bundled_unicode_fallback_has_nonzero_glyphs_and_vector_outlines() {
        let mut options = usvg::Options::default();
        load_export_fonts(options.fontdb_mut());
        for (family, text) in [
            ("Noto Sans", "Öö—·"),
            ("Noto Sans CJK JP", "同じ楽譜"),
            ("Noto Emoji", "🎸"),
            ("Bravura", "\u{e050}"),
        ] {
            for character in text.chars() {
                let svg = format!(
                    "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><text x='10' y='50' font-family='{family}' font-size='24'>{character}</text></svg>"
                );
                let tree = usvg::Tree::from_str(&svg, &options).unwrap();
                let usvg::Node::Text(text) = &tree.root().children()[0] else {
                    panic!("Expected text for {character}");
                };
                let glyphs: Vec<_> = text
                    .layouted()
                    .iter()
                    .flat_map(|span| &span.positioned_glyphs)
                    .collect();
                assert!(!glyphs.is_empty(), "Missing glyph for {character}");
                for glyph in glyphs {
                    assert_ne!(glyph.id.0, 0, "Missing glyph for {character}");
                    let face = tree.fontdb().face(glyph.font).unwrap();
                    assert!(
                        face.families.iter().any(|(name, _)| name == family),
                        "Unexpected fallback for {character}: {:?}",
                        face.families
                    );
                }
                assert!(
                    text.flattened()
                        .children()
                        .iter()
                        .any(|node| matches!(node, usvg::Node::Path(_))),
                    "No vector outline for {character}"
                );
            }
        }
    }
    #[test]
    fn preserves_latin_ligatures_across_multiple_unicode_fallbacks() {
        let mut options = usvg::Options::default();
        load_export_fonts(options.fontdb_mut());
        let parse = |value: &str| {
            usvg::Tree::from_str(&format!("<svg xmlns='http://www.w3.org/2000/svg' width='600' height='100'><text x='10' y='50' font-family='Noto Sans' font-size='24'>{value}</text></svg>"), &options).unwrap()
        };
        let plain = parse("fl");
        let usvg::Node::Text(plain_text) = &plain.root().children()[0] else {
            panic!("Expected Latin text");
        };
        let ligature = &plain_text.layouted()[0].positioned_glyphs;
        assert_eq!(
            ligature.len(),
            1,
            "Fixture must exercise a real Latin ligature"
        );
        for value in ["fl同じ楽譜🎸fl", "同じfl🎸楽譜fl", "🎸fl同じ楽譜fl"] {
            let tree = parse(value);
            let usvg::Node::Text(text) = &tree.root().children()[0] else {
                panic!("Expected mixed text");
            };
            let glyphs: Vec<_> = text
                .layouted()
                .iter()
                .flat_map(|span| &span.positioned_glyphs)
                .collect();
            assert_eq!(
                glyphs
                    .iter()
                    .map(|glyph| glyph.text.as_str())
                    .collect::<String>(),
                value
            );
            assert!(glyphs.iter().all(|glyph| glyph.id.0 != 0));
            let latin: Vec<_> = glyphs.iter().filter(|glyph| glyph.text == "fl").collect();
            assert_eq!(latin.len(), 2);
            for glyph in latin {
                assert_eq!(glyph.id, ligature[0].id);
                assert!(
                    tree.fontdb()
                        .face(glyph.font)
                        .unwrap()
                        .families
                        .iter()
                        .any(|(name, _)| name == "Noto Sans")
                );
            }
            let mut p = page();
            p.svg = p.svg.replace("TabPlayer Ä", value);
            let bytes = convert_pages(&[p], &AtomicBool::new(false)).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("/Subtype /Image"));
        }
    }
    #[test]
    fn still_rejects_a_character_without_a_bundled_glyph() {
        let mut p = page();
        p.svg = p.svg.replace("TabPlayer Ä", "fl 同じ楽譜 🎸 \u{10ffff}");
        assert!(
            convert_pages(&[p], &AtomicBool::new(false))
                .unwrap_err()
                .contains("could not be displayed with any font")
        );
    }
    #[test]
    fn refuses_remote_file_data_resources_and_cancelled_conversion() {
        for href in [
            "https://example.invalid/x.svg",
            "file:///C:/secret.png",
            "data:image/png;base64,AA",
        ] {
            let mut p = page();
            p.svg = format!("<svg xmlns='http://www.w3.org/2000/svg'><image href='{href}'/></svg>");
            assert!(convert_pages(&[p], &AtomicBool::new(false)).is_err());
        }
        assert!(
            convert_pages(&[page()], &AtomicBool::new(true))
                .unwrap_err()
                .contains("cancel")
        );
    }
    #[test]
    fn reports_complete_pages_and_cancellation_during_conversion() {
        let cancel = AtomicBool::new(false);
        let mut counts = Vec::new();
        let result = convert_pages_with_progress(&[page(), page()], &cancel, |n| {
            counts.push(n);
            cancel.store(true, std::sync::atomic::Ordering::Release);
        });
        assert!(result.unwrap_err().contains("cancel"));
        assert_eq!(counts, vec![1]);
    }
    #[test]
    fn ordinary_score_text_can_mention_urls_without_becoming_a_resource() {
        let mut p = page();
        p.svg = p.svg.replace(
            "TabPlayer Ä",
            "href=file:///score-text @import url(example)",
        );
        assert!(convert_pages(&[p], &AtomicBool::new(false)).is_ok());
    }
}
