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

fn load_export_fonts(database: &mut usvg::fontdb::Database) {
    for bytes in [
        include_bytes!("../../../assets/fonts/Bravura.otf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSans-Regular.ttf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoSansCJKjp-Regular.otf").as_slice(),
        include_bytes!("../../../assets/fonts/NotoEmoji.ttf").as_slice(),
    ] {
        database.load_font_data(bytes.to_vec());
    }
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
    load_export_fonts(options.fontdb_mut());
    options.fontdb_mut().set_sans_serif_family("Noto Sans");
    options.fontdb_mut().set_serif_family("Noto Sans");
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
    fn converts_composed_systems_with_defs_use_and_clip_paths() {
        let mut p = page();
        p.svg = "<svg xmlns='http://www.w3.org/2000/svg' width='210mm' height='297mm' viewBox='0 0 794 1123'><style>.at{font-family:Bravura;font-size:34px}text{fill:#111}</style><g transform=\"translate(40 60)\"><defs><g id=\"export-s0-content\"><rect x=\"30\" y=\"120\" width=\"20\" height=\"20\"/><text x=\"100\" y=\"250\" font-family=\"Bravura\" font-size=\"34\">&#57424;</text></g><clipPath id=\"export-s0-c0\"><rect x=\"-100000\" y=\"-100000\" width=\"200000\" height=\"100180\"/></clipPath><clipPath id=\"export-s0-c1\"><rect x=\"-100000\" y=\"180\" width=\"200000\" height=\"101000\"/></clipPath></defs><g transform=\"translate(0 0)\"><use href=\"#export-s0-content\" clip-path=\"url(#export-s0-c0)\"/></g><g transform=\"translate(0 40)\"><use href=\"#export-s0-content\" clip-path=\"url(#export-s0-c1)\"/></g><g data-tp-accolade=\"group-brace\" transform=\"translate(10 260)\" class=\"at\" ><text style=\"font-size: 300%; stroke:none\">&#57344;</text></g></g></svg>".into();
        let tree = notation_tree(&p, &export_options(), "PDF").unwrap();
        // Each <use> must survive as a clipped group holding text, and every text must resolve to Bravura.
        fn walk(
            group: &usvg::Group,
            tree: &usvg::Tree,
            clipped: &mut usize,
            texts: &mut usize,
            glyphs: &mut usize,
        ) {
            for node in group.children() {
                match node {
                    usvg::Node::Text(text) => {
                        *texts += 1;
                        for glyph in text.layouted().iter().flat_map(|s| &s.positioned_glyphs) {
                            *glyphs += 1;
                            let face = tree.fontdb().face(glyph.font).unwrap();
                            assert!(
                                face.families.iter().any(|(name, _)| name == "Bravura"),
                                "glyph {:?} is not Bravura",
                                glyph.text
                            );
                        }
                    }
                    usvg::Node::Group(inner) => {
                        if inner.clip_path().is_some() {
                            *clipped += 1;
                            let mut inside = 0;
                            walk(inner, tree, &mut 0, &mut inside, &mut 0);
                            assert!(inside >= 1, "a clipped use holds no text");
                        }
                        walk(inner, tree, clipped, texts, glyphs);
                    }
                    _ => {}
                }
            }
        }
        let (mut clipped, mut texts, mut glyphs) = (0, 0, 0);
        walk(tree.root(), &tree, &mut clipped, &mut texts, &mut glyphs);
        assert_eq!(clipped, 2);
        assert!(texts >= 2);
        // Two clipped uses plus the accolade each lay out a Bravura glyph.
        assert!(glyphs >= 3, "only {glyphs} laid-out glyphs");
        let bytes = convert_pages(&[p], &AtomicBool::new(false)).unwrap();
        let content = String::from_utf8_lossy(&bytes);
        assert!(content.starts_with("%PDF-"));
        assert!(content.contains("/FontFile"));
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
