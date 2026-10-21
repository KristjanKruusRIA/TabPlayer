use super::pdf::{SvgPage, export_options, notation_tree};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use svg2pdf::usvg;

/// Writes each page back as standalone SVG, with text flattened to outlines from the bundled fonts.
pub fn convert_pages(pages: &[SvgPage]) -> Result<Vec<String>, String> {
    if pages.is_empty() || pages.len() > 2000 {
        return Err("Choose between one and 2000 pages.".into());
    }
    let options = export_options();
    let write = usvg::WriteOptions {
        indent: usvg::Indent::None,
        attributes_indent: usvg::Indent::None,
        ..usvg::WriteOptions::default()
    };
    pages
        .iter()
        .map(|page| {
            let tree = notation_tree(page, &options, "SVG")?;
            // PDF refuses these through svg2pdf; an outline would otherwise silently drop them.
            if unresolved_text(tree.root()) {
                return Err("A piece of text could not be displayed with any font.".into());
            }
            with_page_box(&tree.to_string(&write), page)
        })
        .collect()
}

fn unresolved_text(group: &usvg::Group) -> bool {
    group.children().iter().any(|node| match node {
        usvg::Node::Text(text) => text
            .layouted()
            .iter()
            .flat_map(|span| &span.positioned_glyphs)
            .any(|glyph| glyph.id.0 == 0),
        usvg::Node::Group(group) => unresolved_text(group),
        _ => false,
    })
}

/// The writer emits only a pixel size; keep the physical page size and let viewers scale it.
fn with_page_box(svg: &str, page: &SvgPage) -> Result<String, String> {
    let malformed = || "Could not write the SVG page size.".to_string();
    let rest = svg.strip_prefix("<svg width=\"").ok_or_else(malformed)?;
    let (width, rest) = rest.split_once('"').ok_or_else(malformed)?;
    let rest = rest.strip_prefix(" height=\"").ok_or_else(malformed)?;
    let (height, rest) = rest.split_once('"').ok_or_else(malformed)?;
    Ok(format!(
        "<svg width=\"{}mm\" height=\"{}mm\" viewBox=\"0 0 {width} {height}\"{rest}",
        page.width_mm, page.height_mm
    ))
}

/// One page keeps the chosen name; several pages are numbered after it, padded so they sort.
pub fn page_paths(path: &Path, count: usize) -> Vec<PathBuf> {
    if count == 1 {
        return vec![path.to_path_buf()];
    }
    let stem = path.file_stem().unwrap_or_default();
    let digits = count.to_string().len();
    (1..=count)
        .map(|number| {
            let mut name = OsString::from(stem);
            name.push(format!("-{number:0digits$}.svg"));
            path.with_file_name(name)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    const BACKGROUND: &str = "<rect width='100%' height='100%' fill='#fff'/>";
    fn page_with(content: &str) -> SvgPage {
        SvgPage {
            width_mm: 210.0,
            height_mm: 297.0,
            svg: format!(
                "<svg xmlns='http://www.w3.org/2000/svg' width='210mm' height='297mm' viewBox='0 0 794 1123'>{BACKGROUND}{content}</svg>"
            ),
        }
    }
    fn page() -> SvgPage {
        page_with(
            "<text x='60' y='70' font-family='Noto Sans'>TabPlayer Ä</text><text x='100' y='100' font-family='Bravura' font-size='34'>&#57424;</text>",
        )
    }
    fn paths(group: &usvg::Group) -> usize {
        group
            .children()
            .iter()
            .map(|node| match node {
                usvg::Node::Path(_) => 1,
                usvg::Node::Group(group) => paths(group),
                _ => 0,
            })
            .sum()
    }
    #[test]
    fn writes_text_as_outlines_that_need_no_fonts() {
        let blank = convert_pages(&[page_with("")]).unwrap().remove(0);
        let pages = convert_pages(&[page(), page()]).unwrap();
        assert_eq!(pages.len(), 2);
        for svg in &pages {
            assert!(svg.starts_with(
                "<svg width=\"210mm\" height=\"297mm\" viewBox=\"0 0 793.7008 1122.5197\""
            ));
            assert!(!svg.contains("<text"));
            assert!(svg.contains("fill=\"#ffffff\""));
            // The background alone is one path; the outlined words and the music glyph add more.
            assert!(svg.matches("<path").count() > blank.matches("<path").count() + 1);
            // With no fonts at all, the outlines still come back as the same paths.
            let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap();
            assert_eq!(paths(tree.root()), svg.matches("<path").count());
        }
    }
    #[test]
    fn refuses_text_without_a_bundled_glyph() {
        let error = convert_pages(&[page_with(
            "<text x='10' y='50' font-family='Noto Sans'>&#x10FFFF;</text>",
        )])
        .unwrap_err();
        assert!(error.contains("could not be displayed with any font"));
    }
    #[test]
    fn refuses_resources_and_page_counts_outside_limits() {
        assert!(convert_pages(&[]).is_err());
        let mut p = page();
        p.svg =
            "<svg xmlns='http://www.w3.org/2000/svg'><image href='file:///C:/secret.png'/></svg>"
                .into();
        assert!(convert_pages(&[p]).is_err());
        let mut p = page();
        p.width_mm = 5.0;
        assert!(convert_pages(&[p]).unwrap_err().contains("SVG page size"));
    }
    #[test]
    fn numbers_files_only_for_several_pages() {
        let path = Path::new("C:/scores/song.svg");
        assert_eq!(
            page_paths(path, 1),
            vec![PathBuf::from("C:/scores/song.svg")]
        );
        assert_eq!(
            page_paths(path, 3),
            ["song-1.svg", "song-2.svg", "song-3.svg"]
                .map(|name| PathBuf::from("C:/scores").join(name))
        );
        let padded = page_paths(path, 12);
        assert_eq!(padded[0], PathBuf::from("C:/scores/song-01.svg"));
        assert_eq!(padded[11], PathBuf::from("C:/scores/song-12.svg"));
    }
}
