use tabplayer_lib::{
    files::{read_project, write_project},
    project::{BaseDocument, Project},
};

#[test]
fn a_native_file_round_trips_original_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.tabplayer");
    let mut project = Project::blank();
    project.base = BaseDocument::File {
        filename: "song.gp".into(),
        bytes_base64: "aGVsbG8=".into(),
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
    };
    write_project(&path, &project).unwrap();
    assert_eq!(read_project(&path).unwrap(), project);
}

#[test]
fn invalid_project_does_not_replace_an_existing_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let mut invalid = Project::blank();
    invalid.engine_version = "different".into();
    assert!(write_project(&path, &invalid).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn rejects_corruption_unknown_commands_and_future_schema() {
    for bad in [
        serde_json::json!({"schemaVersion": 3}),
        serde_json::json!({"engineVersion": "future"}),
        serde_json::json!({"edits": [{"type": "runCode", "code": "hello"}]}),
        serde_json::json!({"base": {"kind":"file", "filename":"x.gp", "bytesBase64":"aGVsbG8=", "sha256":"wrong"}}),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.tabplayer");
        let mut value = serde_json::to_value(Project::blank()).unwrap();
        for (key, val) in bad.as_object().unwrap() {
            value[key] = val.clone();
        }
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_project(&path).is_err(), "accepted {bad}");
    }
}

#[test]
fn unavailable_destination_returns_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        write_project(
            &dir.path().join("missing/song.tabplayer"),
            &Project::blank()
        )
        .is_err()
    );
}

#[cfg(windows)]
#[test]
fn a_sharing_lock_preserves_the_previous_file_when_commit_fails() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let mut changed = Project::blank();
    changed.base = BaseDocument::Blank {
        title: "Changed".into(),
        artist: "".into(),
        tempo: 120.0,
        tuning: vec![64],
        measure_count: 1,
    };
    assert!(write_project(&path, &changed).is_err());
    drop(lock);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
