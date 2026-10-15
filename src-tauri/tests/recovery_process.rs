use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};
use tabplayer_lib::recovery::{RecoveryEnvelope, RecoveryStore, SessionLifecycle};

// This child is the test executable itself, never a GUI process or production bypass.
#[test]
fn recovery_lock_child() {
    let Some(path) = std::env::var_os("TABPLAYER_STORE_CHILD_DIR") else {
        return;
    };
    let mode = std::env::var("TABPLAYER_STORE_CHILD_MODE").unwrap();
    let path = std::path::PathBuf::from(path);
    match RecoveryStore::acquire(path.clone()) {
        Err(error) => {
            assert_eq!(mode, "reject", "{error}");
            assert!(error.contains("already using this session"));
            println!("STORE_REJECTED");
        }
        Ok(store) => {
            assert_ne!(mode, "reject", "second owner acquired recovery directory");
            assert_eq!(
                store.load().unwrap().unwrap().recovery.envelope.generation,
                1
            );
            let _interrupted = if mode == "interrupt-diagnostic" {
                use std::io::Write;
                std::fs::write(path.join("recovery-v1/manifest.json"), b"invalid evidence")
                    .unwrap();
                let pending = path.join("recovery-v1/diagnostic-pending");
                std::fs::create_dir(&pending).unwrap();
                let mut writer =
                    atomic_write_file::AtomicWriteFile::open(pending.join("checkpoint-1.json"))
                        .unwrap();
                writer.write_all(b"interrupted diagnostic copy").unwrap();
                writer.sync_all().unwrap();
                Some(writer)
            } else {
                None
            };
            println!("STORE_READY");
            use std::io::Write;
            std::io::stdout().flush().unwrap();
            if mode == "hold" || mode == "interrupt-diagnostic" {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).unwrap();
            }
        }
    }
}

fn child(path: &std::path::Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "recovery_lock_child", "--nocapture"])
        .env("TABPLAYER_STORE_CHILD_DIR", path)
        .env("TABPLAYER_STORE_CHILD_MODE", mode)
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
fn hold(path: &std::path::Path) -> Holder {
    hold_mode(path, "hold")
}
fn hold_mode(path: &std::path::Path, mode: &str) -> Holder {
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
        if line.contains("STORE_READY") {
            return process;
        }
    }
}
fn seed(path: &std::path::Path) {
    let mut store = RecoveryStore::acquire(path.into()).unwrap();
    store
        .commit(
            &RecoveryEnvelope {
                format: "TabPlayerRecovery".into(),
                version: 1,
                epoch: 1,
                generation: 1,
                captured_at_unix_ms: 100,
                active_document_id: None,
                documents: vec![],
            },
            SessionLifecycle::Running,
            false,
        )
        .unwrap();
}

#[test]
fn two_processes_cannot_share_recovery_ownership_and_crash_releases_lock() {
    let first = tempfile::tempdir().unwrap();
    let independent = tempfile::tempdir().unwrap();
    seed(first.path());
    seed(independent.path());
    let mut owner = hold(first.path());
    let _independent_owner = hold(independent.path());
    let rejected = child(first.path(), "reject").output().unwrap();
    assert!(
        rejected.status.success(),
        "{} {}",
        String::from_utf8_lossy(&rejected.stdout),
        String::from_utf8_lossy(&rejected.stderr)
    );
    assert!(String::from_utf8_lossy(&rejected.stdout).contains("STORE_REJECTED"));
    owner.0.kill().unwrap();
    owner.0.wait().unwrap();
    let fresh = child(first.path(), "load").output().unwrap();
    assert!(
        fresh.status.success(),
        "{} {}",
        String::from_utf8_lossy(&fresh.stdout),
        String::from_utf8_lossy(&fresh.stderr)
    );
    assert!(String::from_utf8_lossy(&fresh.stdout).contains("STORE_READY"));
}

#[cfg(windows)]
#[test]
fn interrupted_atomic_diagnostic_copy_does_not_block_explicit_retry() {
    let directory = tempfile::tempdir().unwrap();
    seed(directory.path());
    let mut writer = hold_mode(directory.path(), "interrupt-diagnostic");
    writer.0.kill().unwrap();
    writer.0.wait().unwrap();
    let root = directory.path().join("recovery-v1");
    let pending = root.join("diagnostic-pending");
    let leftovers: Vec<_> = std::fs::read_dir(&pending)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        leftovers.len(),
        1,
        "actual killed atomic writer must leave its named temporary"
    );
    assert!(leftovers[0].starts_with(".checkpoint-1.json."));
    std::fs::write(root.join("unknown.txt"), b"keep unknown").unwrap();
    let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
    store.preserve_diagnostics().unwrap();
    assert_eq!(
        std::fs::read(root.join("diagnostic/manifest.json")).unwrap(),
        b"invalid evidence"
    );
    assert!(root.join("diagnostic/checkpoint-1.json").exists());
    assert!(!pending.exists());
    assert_eq!(
        std::fs::read(root.join("unknown.txt")).unwrap(),
        b"keep unknown"
    );
}
