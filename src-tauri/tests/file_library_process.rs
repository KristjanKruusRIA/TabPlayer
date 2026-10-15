use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
};
use tabplayer_lib::file_library::{store::LibraryStore, types::BundledLibrary};
fn bundled() -> BundledLibrary {
    BundledLibrary {
        templates: vec![],
        examples: vec![],
    }
}

#[test]
fn library_lock_child() {
    let Some(directory) = std::env::var_os("TABPLAYER_LIBRARY_CHILD_DIR") else {
        return;
    };
    let mode = std::env::var("TABPLAYER_LIBRARY_CHILD_MODE").unwrap();
    match LibraryStore::acquire(directory.into(), bundled()) {
        Err(error) => {
            assert_eq!(mode, "reject", "{error}");
            assert!(
                error.contains("already"),
                "lock must reject before reading corrupt catalog: {error}"
            );
            println!("LIBRARY_REJECTED");
        }
        Ok(store) => {
            assert_ne!(mode, "reject", "second process acquired library");
            if mode == "read" {
                assert!(store.snapshot().unwrap().welcome_seen);
            }
            let _interrupted = if mode == "hold-temp" {
                let templates = std::path::PathBuf::from(
                    std::env::var_os("TABPLAYER_LIBRARY_CHILD_DIR").unwrap(),
                )
                .join("templates");
                std::fs::create_dir_all(&templates).unwrap();
                let mut writer = atomic_write_file::AtomicWriteFile::open(
                    templates.join(format!("{}.tabplayer", "a".repeat(64))),
                )
                .unwrap();
                writer
                    .write_all(b"interrupted unpublished template payload")
                    .unwrap();
                writer.sync_all().unwrap();
                Some(writer)
            } else {
                None
            };
            println!("LIBRARY_READY");
            std::io::stdout().flush().unwrap();
            if mode == "hold" || mode == "hold-temp" {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).unwrap();
            }
        }
    }
}
fn child(path: &Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "library_lock_child", "--nocapture"])
        .env("TABPLAYER_LIBRARY_CHILD_DIR", path)
        .env("TABPLAYER_LIBRARY_CHILD_MODE", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
struct Holder(Child);
impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn hold(path: &Path) -> Holder {
    hold_mode(path, "hold")
}
fn hold_mode(path: &Path, mode: &str) -> Holder {
    let mut process = Holder(child(path, mode).spawn().unwrap());
    let mut output = BufReader::new(process.0.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert_ne!(
            output.read_line(&mut line).unwrap(),
            0,
            "owner exited before readiness"
        );
        if line.contains("LIBRARY_READY") {
            return process;
        }
    }
}

#[cfg(windows)]
#[test]
fn killed_atomic_payload_writer_is_cleaned_without_publishing_a_template() {
    let data = tempfile::tempdir().unwrap();
    let bytes=br#"{"format":"TabPlayerFileLibrary","version":1,"revision":1,"welcomeSeen":true,"recents":[],"roots":[],"templates":[]}"#;
    std::fs::write(data.path().join("catalog.json"), bytes).unwrap();
    let mut owner = hold_mode(data.path(), "hold-temp");
    owner.0.kill().unwrap();
    owner.0.wait().unwrap();
    let templates = data.path().join("templates");
    let leftovers: Vec<_> = std::fs::read_dir(&templates)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        leftovers.len(),
        1,
        "real interrupted writer must leave its temporary"
    );
    assert!(leftovers[0].starts_with(&format!(".{}.tabplayer.", "a".repeat(64))));
    let unknown = templates.join(format!(".{}.tabplayer.Ab12345", "b".repeat(64)));
    std::fs::write(&unknown, b"preserve near match").unwrap();
    let store = LibraryStore::acquire(data.path().into(), bundled()).unwrap();
    assert!(store.snapshot().unwrap().templates.is_empty());
    assert_eq!(
        std::fs::read(data.path().join("catalog.json")).unwrap(),
        bytes
    );
    assert_eq!(std::fs::read_dir(templates).unwrap().count(), 1);
    assert!(unknown.exists());
}
#[test]
fn library_os_lock_releases_after_child_exit() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(data.path().join("catalog.json"), br#"{"format":"TabPlayerFileLibrary","version":1,"revision":1,"welcomeSeen":true,"recents":[],"roots":[],"templates":[]}"#).unwrap();
    let mut owner = hold(data.path());
    let catalog = data.path().join("catalog.json");
    let valid = std::fs::read(&catalog).unwrap();
    std::fs::write(&catalog, b"corrupt while locked").unwrap();
    let rejected = child(data.path(), "reject").output().unwrap();
    assert!(
        rejected.status.success(),
        "{} {}",
        String::from_utf8_lossy(&rejected.stdout),
        String::from_utf8_lossy(&rejected.stderr)
    );
    assert!(String::from_utf8_lossy(&rejected.stdout).contains("LIBRARY_REJECTED"));
    std::fs::write(&catalog, &valid).unwrap();
    owner.0.kill().unwrap();
    owner.0.wait().unwrap();
    let fresh = child(data.path(), "read").output().unwrap();
    assert!(
        fresh.status.success(),
        "{} {}",
        String::from_utf8_lossy(&fresh.stdout),
        String::from_utf8_lossy(&fresh.stderr)
    );
    assert!(String::from_utf8_lossy(&fresh.stdout).contains("LIBRARY_READY"));
    assert_eq!(std::fs::read(catalog).unwrap(), valid);
}
