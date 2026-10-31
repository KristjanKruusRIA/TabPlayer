use super::pdf::{self, SvgPage};
use super::{png, svg};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// One track's rendered pages and the file name the dialog expanded for it.
#[derive(Clone, Debug, Deserialize)]
pub struct TrackPages {
    pub name: String,
    pub pages: Vec<SvgPage>,
}

/// Converts every track into files inside `folder` before anything is written, so a refusal
/// leaves nothing behind. SVG and PNG tracks with several pages are numbered after their name.
pub fn track_files(
    folder: &Path,
    format: &str,
    tracks: &[TrackPages],
    dpi: Option<u32>,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    if tracks.is_empty() || tracks.len() > 64 {
        return Err("Choose between one and 64 tracks.".into());
    }
    let total: usize = tracks.iter().map(|track| track.pages.len()).sum();
    if tracks.iter().any(|track| track.pages.is_empty()) || total > 2000 {
        return Err("Choose between one and 2000 pages.".into());
    }
    // The names were made safe by the dialog; anything the native rules would change is refused.
    if let Some(track) = tracks.iter().find(|track| {
        track.name.is_empty() || crate::suggested_name(Some(&track.name), "") != track.name
    }) {
        return Err(format!("\"{}\" cannot be used as a file name.", track.name));
    }
    let dpi = match format {
        "png" => {
            let dpi = dpi.ok_or("Choose a PNG resolution.")?;
            png::check_budget(tracks.iter().flat_map(|track| &track.pages), dpi)?;
            dpi
        }
        "pdf" | "svg" => 0,
        _ => return Err("One file per track is available for PDF, SVG and PNG.".into()),
    };
    let mut outputs = Vec::new();
    for track in tracks {
        let path = crate::with_extension(folder.join(&track.name), format);
        match format {
            "pdf" => outputs.push((
                path,
                pdf::convert_pages(&track.pages, &AtomicBool::new(false))?,
            )),
            "svg" => {
                let pages = svg::convert_pages(&track.pages)?;
                let paths = svg::page_paths(&path, pages.len());
                outputs.extend(
                    paths
                        .into_iter()
                        .zip(pages.into_iter().map(String::into_bytes)),
                );
            }
            _ => {
                let pages = png::render_pages(&track.pages, dpi)?;
                let paths = svg::page_paths(&path, pages.len());
                outputs.extend(paths.into_iter().zip(pages));
            }
        }
    }
    // Two tracks must never share a file, as "Song" with two pages and a track named "Song-1" would.
    let mut seen = HashSet::new();
    for (path, _) in &outputs {
        if !seen.insert(path.to_string_lossy().to_lowercase()) {
            return Err(format!(
                "Two tracks would both be saved as {}. Change the file name.",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    Ok(outputs)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(name: &str, pages: usize) -> TrackPages {
        let page = SvgPage {
            width_mm: 210.0,
            height_mm: 297.0,
            svg: "<svg xmlns='http://www.w3.org/2000/svg' width='210mm' height='297mm' viewBox='0 0 794 1123'><rect width='100%' height='100%' fill='#fff'/><text x='60' y='70' font-family='Noto Sans'>Lead</text></svg>".into(),
        };
        TrackPages {
            name: name.into(),
            pages: vec![page; pages],
        }
    }
    fn names(outputs: &[(PathBuf, Vec<u8>)]) -> Vec<String> {
        outputs
            .iter()
            .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn converts_each_track_to_named_files_in_the_folder() {
        let folder = Path::new("C:/exports");
        let pdf = track_files(
            folder,
            "pdf",
            &[track("1 Lead", 2), track("2 Bass", 1)],
            None,
        )
        .unwrap();
        assert_eq!(names(&pdf), ["1 Lead.pdf", "2 Bass.pdf"]);
        assert!(
            pdf.iter()
                .all(|(path, bytes)| path.parent() == Some(folder) && bytes.starts_with(b"%PDF-"))
        );
        let svg = track_files(folder, "svg", &[track("Lead", 2), track("Bass", 1)], None).unwrap();
        assert_eq!(names(&svg), ["Lead-1.svg", "Lead-2.svg", "Bass.svg"]);
        assert!(svg.iter().all(|(_, bytes)| bytes.starts_with(b"<svg")));
        let png = track_files(folder, "png", &[track("Gtr. 1", 1)], Some(72)).unwrap();
        assert_eq!(names(&png), ["Gtr. 1.png"]);
        assert!(png[0].1.starts_with(b"\x89PNG"));
    }

    #[test]
    fn refuses_names_formats_and_sizes_it_cannot_write_safely() {
        let folder = Path::new("C:/exports");
        for name in ["", "../up", "a/b", "CON", "lead.", "Report\u{202E}fdp"] {
            assert!(
                track_files(folder, "pdf", &[track(name, 1)], None)
                    .unwrap_err()
                    .contains("cannot be used as a file name"),
                "{name:?}"
            );
        }
        assert!(track_files(folder, "midi", &[track("Lead", 1)], None).is_err());
        assert!(track_files(folder, "pdf", &[], None).is_err());
        assert!(track_files(folder, "pdf", &[track("Lead", 0)], None).is_err());
        assert!(track_files(folder, "png", &[track("Lead", 1)], None).is_err());
        // Each track alone fits the PNG budget at 600 dpi; together they do not.
        let many: Vec<_> = (0..3).map(|n| track(&format!("T{n}"), 20)).collect();
        assert!(
            track_files(folder, "png", &many, Some(600))
                .unwrap_err()
                .contains("fewer pages")
        );
    }

    #[test]
    fn refuses_two_tracks_that_would_share_a_file() {
        let folder = Path::new("C:/exports");
        let error =
            track_files(folder, "pdf", &[track("Lead", 1), track("LEAD", 1)], None).unwrap_err();
        assert!(error.contains("Two tracks would both be saved as LEAD.pdf"));
        let error =
            track_files(folder, "svg", &[track("Song", 2), track("Song-1", 1)], None).unwrap_err();
        assert!(error.contains("Song-1.svg"));
    }
}
