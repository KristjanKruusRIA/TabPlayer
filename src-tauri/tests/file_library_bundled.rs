use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tabplayer_lib::{
    file_library::{bundled::BundledContent, types::LibraryContentOrigin},
    project::{BaseDocument, ProjectSession},
};
use tempfile::TempDir;

fn source() -> PathBuf {
    fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets/library")).unwrap()
}

fn fixture() -> TempDir {
    let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let manifest = manifest(&source());
    for record in manifest["templates"]
        .as_array()
        .unwrap()
        .iter()
        .chain(manifest["examples"].as_array().unwrap())
        .chain(manifest["documents"].as_array().unwrap())
    {
        let relative = record["path"].as_str().unwrap();
        let destination = root.path().join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(source().join(relative), destination).unwrap();
    }
    fs::copy(
        source().join("manifest.json"),
        root.path().join("manifest.json"),
    )
    .unwrap();
    root
}

fn manifest(root: &Path) -> Value {
    serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap()
}

fn put_manifest(root: &Path, value: &Value) {
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(value).unwrap(),
    )
    .unwrap();
}

fn load(root: &Path) -> Result<BundledContent, String> {
    BundledContent::load(root.to_path_buf())
}

#[test]
fn all_thirteen_bundled_scores_resolve_to_independent_clean_schema_three_projects() {
    let content = load(&source()).unwrap();
    let descriptors = content.descriptors();
    assert_eq!(descriptors.templates.len(), 10);
    assert_eq!(descriptors.examples.len(), 3);
    assert_eq!(descriptors.templates[0].id, "factory-guitar-6");
    assert_eq!(descriptors.examples[0].title, "Windowline");
    for item in descriptors.templates.iter().chain(&descriptors.examples) {
        let project = content.project(&item.id, item.origin.clone()).unwrap();
        assert_eq!(project.schema_version, 3);
        assert!(matches!(project.base, BaseDocument::Blank { .. }));
        assert!(!project.baseline_edits.is_empty());
        assert!(project.edits.is_empty());
        assert!(project.assets.is_empty());
        let session = ProjectSession::new(project.clone(), None).unwrap();
        assert!(!session.snapshot().dirty);
        assert!(!session.snapshot().can_undo);
        assert_eq!(session.fork_project().unwrap(), project);
    }
    let encoded = serde_json::to_value(descriptors).unwrap();
    assert!(encoded["templates"][0].get("path").is_none());
}

#[test]
fn identifiers_and_origin_cannot_select_arbitrary_paths_or_other_content_kinds() {
    let content = load(&source()).unwrap();
    for id in [
        "../manifest.json",
        "templates/factory-guitar-6.tabplayer",
        "",
        "unknown",
    ] {
        assert!(content.project(id, LibraryContentOrigin::Factory).is_err());
    }
    assert!(
        content
            .project("factory-guitar-6", LibraryContentOrigin::Example)
            .is_err()
    );
    assert!(
        content
            .project("example-windowline", LibraryContentOrigin::Factory)
            .is_err()
    );
    assert!(
        content
            .project("factory-guitar-6", LibraryContentOrigin::Personal)
            .is_err()
    );
}

#[test]
fn mutated_or_missing_payload_and_license_fail_closed_at_load_and_access() {
    let root = fixture();
    let content = load(root.path()).unwrap();
    fs::write(
        root.path().join("templates/factory-guitar-6.tabplayer"),
        b"changed",
    )
    .unwrap();
    assert!(
        content
            .project("factory-guitar-6", LibraryContentOrigin::Factory)
            .is_err()
    );
    assert!(load(root.path()).is_err());
    let root = fixture();
    fs::write(root.path().join("CC0-1.0.txt"), b"changed license").unwrap();
    assert!(load(root.path()).is_err());
    let root = fixture();
    fs::remove_file(root.path().join("README.md")).unwrap();
    assert!(load(root.path()).is_err());
}

#[test]
fn strict_manifest_rejects_unknown_fields_inventory_paths_versions_and_digests() {
    for (field, value) in [
        ("version", json!(2)),
        ("format", json!("Other")),
        ("unknown", json!(true)),
    ] {
        let root = fixture();
        let mut value_manifest = manifest(root.path());
        value_manifest[field] = value;
        put_manifest(root.path(), &value_manifest);
        assert!(load(root.path()).is_err(), "{field}");
    }
    for (field, value) in [
        ("id", json!("unknown")),
        ("path", json!("../private.tabplayer")),
        ("path", json!("templates\\factory-guitar-6.tabplayer")),
        ("sha256", json!("A".repeat(64))),
        ("origin", json!("example")),
        ("license", Value::Null),
        ("unexpected", json!(0)),
    ] {
        let root = fixture();
        let mut value_manifest = manifest(root.path());
        value_manifest["templates"][0][field] = value;
        put_manifest(root.path(), &value_manifest);
        assert!(load(root.path()).is_err(), "{field}");
    }
    for field in ["templates", "examples", "documents"] {
        let root = fixture();
        let mut value = manifest(root.path());
        value[field].as_array_mut().unwrap().pop();
        put_manifest(root.path(), &value);
        assert!(load(root.path()).is_err(), "{field}");
    }
    let root = fixture();
    let mut value = manifest(root.path());
    value["templates"][1] = value["templates"][0].clone();
    put_manifest(root.path(), &value);
    assert!(load(root.path()).is_err());
}

#[test]
fn payload_hash_is_insufficient_without_schema_three_canonical_project_validation() {
    for change in ["legacy", "unknown", "invalid"] {
        let root = fixture();
        let path = root.path().join("templates/factory-guitar-6.tabplayer");
        let mut project: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match change {
            "legacy" => {
                project["schemaVersion"] = json!(2);
                project.as_object_mut().unwrap().remove("baselineEdits");
            }
            "unknown" => {
                project["unknown"] = json!(true);
            }
            _ => {
                project["base"]["tempo"] = json!(-1);
            }
        }
        let bytes = serde_json::to_vec(&project).unwrap();
        fs::write(path, &bytes).unwrap();
        let mut value = manifest(root.path());
        value["templates"][0]["sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
        put_manifest(root.path(), &value);
        assert!(load(root.path()).is_err(), "{change}");
    }
}

#[test]
fn oversized_manifest_and_payload_are_bounded_before_untrusted_allocation() {
    let root = fixture();
    fs::File::options()
        .write(true)
        .open(root.path().join("manifest.json"))
        .unwrap()
        .set_len(2 * 1024 * 1024 + 1)
        .unwrap();
    assert!(load(root.path()).is_err());
    let root = fixture();
    fs::File::options()
        .write(true)
        .open(root.path().join("templates/factory-guitar-6.tabplayer"))
        .unwrap()
        .set_len(512 * 1024 * 1024 + 1)
        .unwrap();
    assert!(load(root.path()).is_err());
}

#[test]
fn directories_and_redirected_bundle_namespaces_are_not_resources() {
    let root = fixture();
    let path = root.path().join("templates/factory-guitar-6.tabplayer");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(load(root.path()).is_err());
    let valid_root = fixture();
    let owner = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let linked = owner.path().join("library");
    #[cfg(windows)]
    {
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&linked)
            .arg(valid_root.path())
            .output()
            .unwrap();
        assert!(result.status.success());
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(valid_root.path(), &linked).unwrap();
    assert!(load(&linked).is_err());
}
