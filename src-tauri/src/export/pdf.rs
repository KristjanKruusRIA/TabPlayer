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
    let mut options = usvg::Options {
        font_family: "Noto Sans".into(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    options
        .fontdb_mut()
        .load_font_data(include_bytes!("../../../assets/fonts/Bravura.otf").to_vec());
    options
        .fontdb_mut()
        .load_font_data(include_bytes!("../../../assets/fonts/NotoSans-Regular.ttf").to_vec());
    options.fontdb_mut().set_sans_serif_family("Noto Sans");
    options.fontdb_mut().set_serif_family("Noto Sans");
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
        if !page.width_mm.is_finite()
            || !page.height_mm.is_finite()
            || page.width_mm < 20.0
            || page.width_mm > 1000.0
            || page.height_mm < 20.0
            || page.height_mm > 1000.0
            || page.svg.len() > 20_000_000
        {
            return Err("Invalid PDF page size or content.".into());
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
        let tree = usvg::Tree::from_str(&page.svg, &options)
            .map_err(|e| format!("Invalid notation SVG: {e}"))?;
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
