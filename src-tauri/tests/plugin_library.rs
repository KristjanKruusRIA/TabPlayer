//! The plug-in library with the real probe helper (THE-71, Task 10).
//!
//! These tests need the built helper and the built test plug-in, so they are `#[ignore]`d (preflight ruling P7) and a
//! plain `cargo test` never needs them. Build both and run them with `--ignored`; a missing binary then fails the test and
//! names the build command:
//!
//! ```text
//! cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin
//! cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_library -- --ignored
//! ```

#[cfg(windows)]
mod windows_tests {
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};
    use tabplayer_lib::plugins::{
        helper::{HelperError, HelperOptions, probe, probe_with},
        library::{LibraryError, PluginLibrary, Resolved},
        status::PluginStatus,
    };
    use tabplayer_test_plugin::TEST_CLASS_ID;

    const NEEDS: &str = "cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin";

    /// `target/debug`, where this test binary's `deps` folder lives.
    fn target_dir() -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        exe.parent().unwrap().parent().unwrap().to_path_buf()
    }

    fn helper_exe() -> PathBuf {
        let exe = target_dir().join("tabplayer-plugin-host.exe");
        assert!(
            exe.is_file(),
            "the plug-in helper is not built ({}). Build it first: {NEEDS}",
            exe.display()
        );
        exe
    }

    /// The test plug-in laid out as a `.vst3` bundle in `dir`.
    fn make_bundle(dir: &Path) -> PathBuf {
        let dll = target_dir().join("tabplayer_test_plugin.dll");
        assert!(
            dll.is_file(),
            "the test plug-in is not built ({}). Build it first: {NEEDS}",
            dll.display()
        );
        let inner = dir
            .join("TestGain.vst3")
            .join("Contents")
            .join("x86_64-win");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::copy(&dll, inner.join("TestGain.vst3")).unwrap();
        dir.join("TestGain.vst3")
    }

    #[test]
    #[ignore = "needs: cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin"]
    fn adds_test_bundle_through_probe_helper() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = make_bundle(dir.path());
        let exe = helper_exe();
        let data = dir.path().join("data");
        let mut library = PluginLibrary::open(&data);
        let entries = library
            .add(&bundle, |path| probe(&exe, path, Duration::from_secs(60)))
            .expect("the test plug-in is added");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.class_id, TEST_CLASS_ID);
        assert!(!entry.name.is_empty());
        assert!(entry.bundle.is_absolute());
        assert_eq!(
            std::fs::canonicalize(&entry.bundle).unwrap(),
            std::fs::canonicalize(&bundle).unwrap()
        );
        assert!(entry.module_len > 0);
        assert_eq!(
            library.resolve(TEST_CLASS_ID),
            Resolved::Found(entry.clone())
        );

        // What was saved is what a new session reads, and the inner module stands for the same bundle.
        let mut reopened = PluginLibrary::open(&data);
        assert_eq!(reopened.entries(), &entries[..]);
        let inner = bundle
            .join("Contents")
            .join("x86_64-win")
            .join("TestGain.vst3");
        let again = reopened
            .add(&inner, |path| probe(&exe, path, Duration::from_secs(60)))
            .expect("the inner module is added");
        assert_eq!(again, entries, "one class from one bundle, replaced");

        // A path that is not there is refused before any helper starts.
        let missing = reopened.add(&dir.path().join("Missing.vst3"), |_| unreachable!());
        assert!(matches!(missing, Err(LibraryError::NotFound(_))));
        // A module the helper cannot read comes back as a probe failure with a status, and changes nothing.
        let broken = dir.path().join("Broken.vst3");
        let broken_inner = broken.join("Contents").join("x86_64-win");
        std::fs::create_dir_all(&broken_inner).unwrap();
        std::fs::write(broken_inner.join("Broken.vst3"), b"not a dll").unwrap();
        let error = reopened
            .add(&broken, |path| probe(&exe, path, Duration::from_secs(60)))
            .expect_err("not a plug-in");
        let LibraryError::Probe(probe_error) = error else {
            panic!("{error:?}")
        };
        assert!(probe_error.status().is_some(), "{probe_error:?}");
        assert_eq!(PluginLibrary::open(&data).entries(), &entries[..]);
    }

    /// How many processes run from the program named `image`.
    fn running(image: &str) -> usize {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs");
        let wanted = image.to_ascii_lowercase();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.to_ascii_lowercase().contains(&wanted))
            .count()
    }

    #[test]
    #[ignore = "needs: cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin"]
    fn probe_timeout_kills_probe_helper() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = make_bundle(dir.path());
        // A copy of the helper under a name of its own, so its processes can be counted whatever else runs.
        let image = format!(
            "probe-kill-{}-{}.exe",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let exe = dir.path().join(&image);
        std::fs::copy(helper_exe(), &exe).unwrap();
        let options = HelperOptions {
            // The factory entry point of the test plug-in never returns.
            env: vec![("TABPLAYER_TEST_PLUGIN_HANG_FACTORY".into(), "1".into())],
            args: Vec::new(),
        };
        let data = dir.path().join("data");
        let mut library = PluginLibrary::open(&data);

        let started = Instant::now();
        let watched = image.clone();
        let seen = std::thread::spawn(move || {
            // The helper really started and sat in the factory while the probe waited.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if running(&watched) > 0 {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            false
        });
        let error = library
            .add(&bundle, |path| {
                probe_with(&exe, path, Duration::from_secs(1), &options)
            })
            .expect_err("the factory hangs");
        assert_eq!(error, LibraryError::Probe(HelperError::ProbeTimeout));
        let LibraryError::Probe(inner) = &error else {
            unreachable!()
        };
        assert_eq!(inner.status(), Some(PluginStatus::Hung));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        assert!(seen.join().unwrap(), "the probe helper never showed up");

        // It was killed, not left behind.
        let deadline = Instant::now() + Duration::from_secs(10);
        while running(&image) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(running(&image), 0, "the probe helper is still running");
        assert!(library.entries().is_empty());
        assert!(!data.exists(), "a failed scan writes nothing");
    }
}
