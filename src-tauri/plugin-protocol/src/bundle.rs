// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in the helper's
// `src/vst3` folder. Changed for TabPlayer (THE-71): the Windows extract only, moved here from the helper's `scan.rs` so
// the app's plug-in library and the helper resolve a bundle to its binary by one rule (Task 10 review, finding 9). The
// tests are in the helper's `scan.rs` and the app's `plugins/library.rs`, which have a temporary-folder crate.
//! Where the loadable binary of a `.vst3` bundle is.
use std::path::{Path, PathBuf};

/// Every `Contents/<dir>` folder name a Windows module can be in, for any machine.
pub const ARCH_DIRS: [&str; 5] = [
    "x86_64-win",
    "x86-win",
    "arm64-win",
    "arm64ec-win",
    "arm64x-win",
];

/// The `Contents/<dir>` folder names that hold this machine's binaries, most specific first.
pub fn own_arch_dirs() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &["arm64-win", "arm64ec-win", "arm64x-win"]
    } else if cfg!(target_arch = "x86") {
        &["x86-win"]
    } else {
        &["x86_64-win"]
    }
}

/// Whether a file or folder is named `*.vst3`, in any letter case.
pub fn is_vst3_name(path: &Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|x| x.eq_ignore_ascii_case("vst3"))
}

/// The loadable binary of a plugin: a single-file `.vst3` itself, or inside a bundle folder
/// `Contents/x86_64-win/<name>.vst3`, falling back to the first `.vst3` file there.
pub fn bundle_binary(path: &Path) -> Option<PathBuf> {
    if !is_vst3_name(path) {
        return None;
    }
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if !path.is_dir() {
        return None;
    }
    let stem = path.file_stem()?;
    for dir in own_arch_dirs() {
        let folder = path.join("Contents").join(dir);
        let mut named = folder.join(stem);
        named.set_extension("vst3");
        if named.is_file() {
            return Some(named);
        }
        let Ok(rd) = std::fs::read_dir(&folder) else {
            continue;
        };
        let mut files: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && is_vst3_name(p))
            .take(64)
            .collect();
        files.sort();
        if let Some(f) = files.into_iter().next() {
            return Some(f);
        }
    }
    None
}
