use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tabplayer_lib::{
    files::read_project_with_digest,
    project::{BaseDocument, EditCommand, ProjectSession},
};

#[test]
fn all_bundled_scores_pass_native_admission_and_keep_clean_fork_baselines() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets/library");
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let mut count = 0;
    for record in manifest["templates"]
        .as_array()
        .unwrap()
        .iter()
        .chain(manifest["examples"].as_array().unwrap())
    {
        let path = root.join(record["path"].as_str().unwrap());
        let bytes = fs::read(&path).unwrap();
        let expected = record["sha256"].as_str().unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
        let (project, digest) = read_project_with_digest(&path).unwrap();
        assert_eq!(digest, expected);
        assert_eq!(project.schema_version, 3);
        assert!(matches!(project.base, BaseDocument::Blank { .. }));
        assert!(project.assets.is_empty());
        assert!(project.edits.is_empty());
        assert!(!project.baseline_edits.is_empty());
        let mut session = ProjectSession::new(project.clone(), None).unwrap();
        let checkpoint = session.checkpoint();
        assert_eq!(session.fork_project().unwrap(), project);
        assert_eq!(session.checkpoint(), checkpoint);
        assert!(!session.snapshot().can_undo);
        assert!(!session.snapshot().can_redo);
        assert!(!session.snapshot().dirty);
        session
            .apply_edit(EditCommand::SetScoreInfo {
                title: "Independent user edit".into(),
                artist: "TabPlayer".into(),
                tempo: 120.0,
            })
            .unwrap();
        assert!(session.snapshot().can_undo);
        session.undo().unwrap();
        assert_eq!(session.snapshot().project, project.view());
        assert!(!session.snapshot().can_undo);
        assert!(session.snapshot().can_redo);
        assert!(!session.snapshot().dirty);
        assert_eq!(fs::read(path).unwrap(), bytes);
        count += 1;
    }
    assert_eq!(count, 13);
}
