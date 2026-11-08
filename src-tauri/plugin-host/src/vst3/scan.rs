// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in this folder.
// Changed for TabPlayer (THE-71): the Windows extract only. Changes are marked "TabPlayer:".

// TabPlayer: only the bundle resolution part of SoundCraft's scan.rs is kept, for the Windows layout, and a file or
// folder must be named `*.vst3`.
use std::path::{Path, PathBuf};

/// The `Contents/<dir>` folder names that hold this machine's binaries, most specific first.
fn arch_dirs() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &["arm64-win", "arm64ec-win", "arm64x-win"]
    } else if cfg!(target_arch = "x86") {
        &["x86-win"]
    } else {
        &["x86_64-win"]
    }
}

fn is_vst3_name(path: &Path) -> bool {
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
    for dir in arch_dirs() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_must_end_in_vst3() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        assert_eq!(bundle_binary(&text), None);
        assert_eq!(bundle_binary(&dir.path().join("missing.vst3")), None);
        let single = dir.path().join("one.VST3");
        std::fs::write(&single, b"x").unwrap();
        assert_eq!(bundle_binary(&single), Some(single.clone()));
    }

    #[test]
    fn a_bundle_folder_resolves_its_binary() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("Amp.vst3");
        let inner = bundle.join("Contents").join(arch_dirs()[0]);
        std::fs::create_dir_all(&inner).unwrap();
        assert_eq!(bundle_binary(&bundle), None, "no binary yet");
        std::fs::write(inner.join("Other.vst3"), b"x").unwrap();
        assert_eq!(bundle_binary(&bundle), Some(inner.join("Other.vst3")));
        std::fs::write(inner.join("Amp.vst3"), b"x").unwrap();
        assert_eq!(bundle_binary(&bundle), Some(inner.join("Amp.vst3")));
    }
}
