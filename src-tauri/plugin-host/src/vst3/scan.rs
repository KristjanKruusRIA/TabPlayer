// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in this folder.
// Changed for TabPlayer (THE-71): the Windows extract only. Changes are marked "TabPlayer:".

// TabPlayer: only the bundle resolution part of SoundCraft's scan.rs is kept, for the Windows layout, and a file or
// folder must be named `*.vst3`. It now lives in the protocol crate, so the app's plug-in library resolves bundles by the
// same rule; this file re-exports it and keeps its tests.
pub use tabplayer_plugin_protocol::bundle::bundle_binary;

#[cfg(test)]
mod tests {
    use super::*;
    use tabplayer_plugin_protocol::bundle::own_arch_dirs;

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
        let inner = bundle.join("Contents").join(own_arch_dirs()[0]);
        std::fs::create_dir_all(&inner).unwrap();
        assert_eq!(bundle_binary(&bundle), None, "no binary yet");
        std::fs::write(inner.join("Other.vst3"), b"x").unwrap();
        assert_eq!(bundle_binary(&bundle), Some(inner.join("Other.vst3")));
        std::fs::write(inner.join("Amp.vst3"), b"x").unwrap();
        assert_eq!(bundle_binary(&bundle), Some(inner.join("Amp.vst3")));
    }
}
