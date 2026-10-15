use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use tabplayer_lib::{
    file_library::{index::LibraryIndex, types::*},
    project::Project,
};

fn root(path: &Path, digit: char) -> LibraryRoot {
    LibraryRoot {
        id: digit.to_string().repeat(64),
        path: path.to_string_lossy().into_owned(),
        configuration_revision: 1,
        availability: LibraryAvailability::Available,
        indexed_at_unix_ms: None,
    }
}

fn score(directory: &Path, name: &str) {
    fs::create_dir_all(directory).unwrap();
    fs::write(
        directory.join(name),
        serde_json::to_vec(&Project::blank()).unwrap(),
    )
    .unwrap();
}

#[cfg(any(unix, windows))]
fn directory_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => return,
            Err(error)
                if error.raw_os_error() == Some(1314)
                    || error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => panic!("Cannot create directory link: {error}"),
        }
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Cannot create directory junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn query(root_id: Option<String>, text: &str) -> LibraryQuery {
    LibraryQuery {
        root_id,
        text: text.into(),
        sort: LibrarySort::Title,
        offset: 0,
        limit: 100,
    }
}

fn metadata(title: &str) -> LibraryMetadata {
    LibraryMetadata {
        title: title.into(),
        artist: "Björk Ensemble".into(),
        album: "Öö Album".into(),
        track_names: vec!["Fretless Bass".into()],
        metadata_truncated: false,
    }
}

fn scan(index: &LibraryIndex, configured: &LibraryRoot, title: &str) -> IndexCommitForTest {
    let started = index.begin(configured.clone()).unwrap();
    loop {
        let batch = index.next(&started.job_id).unwrap();
        for file in batch.files {
            let input = index.read(&started.job_id, &file.file_id).unwrap();
            index
                .accept(
                    &started.job_id,
                    &file.file_id,
                    MetadataResult {
                        sha256: input.sha256,
                        metadata: Some(metadata(title)),
                        error: None,
                    },
                )
                .unwrap();
        }
        if batch.done {
            break;
        }
    }
    let committed = index.finish(&started.job_id, configured).unwrap();
    IndexCommitForTest {
        revision: committed.index_revision,
        time: committed.indexed_at_unix_ms,
    }
}

struct IndexCommitForTest {
    revision: u64,
    time: u64,
}

#[test]
fn completed_index_persists_metadata_search_and_replaces_vanished_files() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("Laulud 日本語");
    score(&songs, "unrelated.TABPLAYER");
    fs::write(songs.join("not-a-score.txt"), b"ignored").unwrap();
    let configured = root(&songs, 'a');
    let directory = temp.path().join("library");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    assert_eq!(index.search(&query(None, "")).unwrap().total, 0);
    let receipt = scan(&index, &configured, "Night Song");
    assert!(receipt.revision > 0 && receipt.time > 0);
    for text in ["bjÖrk öÖ fretless", "night ensemble", "unrelated bass"] {
        let page = index.search(&query(None, text)).unwrap();
        assert_eq!(page.total, 1, "{text}");
        assert_eq!(page.index_revision, receipt.revision);
        assert_eq!(page.rows[0].status, LibraryResultStatus::Indexed);
    }
    assert_eq!(
        index
            .search(&query(None, "night nonexistent"))
            .unwrap()
            .total,
        0
    );
    drop(index);
    let reopened = LibraryIndex::new(directory, vec![configured.clone()]).unwrap();
    assert_eq!(reopened.search(&query(None, "fretless")).unwrap().total, 1);
    fs::remove_file(songs.join("unrelated.TABPLAYER")).unwrap();
    scan(&reopened, &configured, "unused");
    assert_eq!(reopened.search(&query(None, "")).unwrap().total, 0);
}

#[test]
fn removed_root_or_retired_job_cannot_publish_or_read() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    let old = index.begin(configured.clone()).unwrap();
    let file = index.next(&old.job_id).unwrap().files.remove(0);
    let input = index.read(&old.job_id, &file.file_id).unwrap();
    let replacement = index.begin(configured.clone()).unwrap();
    assert!(index.cancel(&old.job_id).is_err());
    assert!(
        index
            .accept(
                &old.job_id,
                &file.file_id,
                MetadataResult {
                    sha256: input.sha256.clone(),
                    metadata: Some(metadata("Stale")),
                    error: None,
                }
            )
            .is_err()
    );
    assert!(index.finish(&old.job_id, &configured).is_err());
    assert_eq!(index.search(&query(None, "original")).unwrap().total, 1);
    index.cancel(&replacement.job_id).unwrap();
    let removed = index.begin(configured.clone()).unwrap();
    let removed_file = index.next(&removed.job_id).unwrap().files.remove(0);
    index.retire_root(&configured.id).unwrap();
    assert!(index.read(&removed.job_id, &removed_file.file_id).is_err());
    assert!(index.finish(&removed.job_id, &configured).is_err());
    assert_eq!(index.search(&query(None, "")).unwrap().total, 0);
    assert!(
        !temp
            .path()
            .join(format!("library/index-{}.json", configured.id))
            .exists()
    );
}

#[test]
fn revision_and_path_changes_cannot_publish_a_previous_scan() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let directory = temp.path().join("library");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    let before = fs::read(directory.join(format!("index-{}.json", configured.id))).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    let input = index
        .read(&started.job_id, &batch.files[0].file_id)
        .unwrap();
    index
        .accept(
            &started.job_id,
            &batch.files[0].file_id,
            MetadataResult {
                sha256: input.sha256,
                metadata: Some(metadata("New")),
                error: None,
            },
        )
        .unwrap();
    let mut changed = configured.clone();
    changed.configuration_revision += 1;
    assert!(index.finish(&started.job_id, &changed).is_err());
    assert_eq!(
        fs::read(directory.join(format!("index-{}.json", configured.id))).unwrap(),
        before
    );
    assert_eq!(index.search(&query(None, "original")).unwrap().total, 1);
    let mut unsafe_root = configured.clone();
    unsafe_root.id = "../catalog".into();
    assert!(index.begin(unsafe_root).is_err());
}

#[test]
fn batches_and_metadata_receipts_are_serial_and_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    for number in 0..105 {
        score(&songs, &format!("{number:03}.tabplayer"));
    }
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let first = index.next(&started.job_id).unwrap();
    assert_eq!(first.files.len(), 100);
    assert!(!first.done);
    let first_input = index
        .read(&started.job_id, &first.files[0].file_id)
        .unwrap();
    assert!(
        index
            .read(&started.job_id, &first.files[1].file_id)
            .is_err()
    );
    assert!(
        index
            .accept(
                &started.job_id,
                &first.files[0].file_id,
                MetadataResult {
                    sha256: "wrong".into(),
                    metadata: Some(metadata("Wrong")),
                    error: None,
                }
            )
            .is_err()
    );
    index
        .accept(
            &started.job_id,
            &first.files[0].file_id,
            MetadataResult {
                sha256: first_input.sha256,
                metadata: Some(metadata("Equal")),
                error: None,
            },
        )
        .unwrap();
    for file in first.files.iter().skip(1) {
        let input = index.read(&started.job_id, &file.file_id).unwrap();
        index
            .accept(
                &started.job_id,
                &file.file_id,
                MetadataResult {
                    sha256: input.sha256,
                    metadata: Some(metadata("Equal")),
                    error: None,
                },
            )
            .unwrap();
    }
    let last = index.next(&started.job_id).unwrap();
    assert_eq!(last.files.len(), 5);
    assert!(last.done);
    assert!(index.finish(&started.job_id, &configured).is_err());
    for file in last.files {
        let input = index.read(&started.job_id, &file.file_id).unwrap();
        index
            .accept(
                &started.job_id,
                &file.file_id,
                MetadataResult {
                    sha256: input.sha256,
                    metadata: Some(metadata("Equal")),
                    error: None,
                },
            )
            .unwrap();
    }
    index.finish(&started.job_id, &configured).unwrap();
    let first = index.search(&query(None, "")).unwrap();
    let mut second_query = query(None, "");
    second_query.offset = 100;
    let second = index.search(&second_query).unwrap();
    assert_eq!(
        (first.total, first.rows.len(), second.rows.len()),
        (105, 100, 5)
    );
    assert!(first.rows.last().unwrap().path < second.rows.first().unwrap().path);
}

#[test]
fn overlapping_roots_deduplicate_all_folders_and_keep_root_scoped_results() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("scores");
    let child = parent.join("child");
    score(&parent, "parent.tabplayer");
    score(&child, "child.tabplayer");
    let outer = root(&parent, 'a');
    let inner = root(&child, 'b');
    let index = LibraryIndex::new(
        temp.path().join("library"),
        vec![outer.clone(), inner.clone()],
    )
    .unwrap();
    scan(&index, &outer, "Outer");
    scan(&index, &inner, "Inner");
    assert_eq!(index.search(&query(None, "")).unwrap().total, 2);
    assert_eq!(
        index
            .search(&query(Some(inner.id.clone()), ""))
            .unwrap()
            .total,
        1
    );
    index.retire_root(&outer.id).unwrap();
    assert_eq!(index.search(&query(None, "")).unwrap().total, 1);
}

#[test]
fn changed_or_malformed_files_are_counted_and_remain_openable_filename_rows() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "changed.tabplayer");
    fs::write(songs.join("malformed.tabplayer"), b"{").unwrap();
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    for file in batch.files {
        if file.filename == "changed.tabplayer" {
            fs::write(songs.join(&file.filename), b"changed").unwrap();
        }
        assert!(index.read(&started.job_id, &file.file_id).is_err());
    }
    index.finish(&started.job_id, &configured).unwrap();
    let page = index.search(&query(None, "")).unwrap();
    assert_eq!(page.total, 2);
    assert!(
        page.rows
            .iter()
            .all(|row| row.metadata.is_none() && row.status != LibraryResultStatus::Indexed)
    );
}

#[test]
fn unavailable_root_and_failed_atomic_publication_preserve_previous_index() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let directory = temp.path().join("library");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    fs::rename(&songs, temp.path().join("moved")).unwrap();
    assert!(index.begin(configured.clone()).is_err());
    let page = index.search(&query(None, "original")).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.rows[0].status, LibraryResultStatus::Unavailable);
    fs::rename(temp.path().join("moved"), &songs).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    let input = index
        .read(&started.job_id, &batch.files[0].file_id)
        .unwrap();
    index
        .accept(
            &started.job_id,
            &batch.files[0].file_id,
            MetadataResult {
                sha256: input.sha256,
                metadata: Some(metadata("New")),
                error: None,
            },
        )
        .unwrap();
    let target = directory.join(format!("index-{}.json", configured.id));
    let before = fs::read(&target).unwrap();
    fs::remove_file(&target).unwrap();
    fs::create_dir(&target).unwrap();
    assert!(index.finish(&started.job_id, &configured).is_err());
    assert_eq!(index.search(&query(None, "original")).unwrap().total, 1);
    fs::remove_dir(&target).unwrap();
    fs::write(target, before).unwrap();
}

#[test]
fn metadata_is_utf8_bounded_and_truncation_is_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    let input = index
        .read(&started.job_id, &batch.files[0].file_id)
        .unwrap();
    let mut result = metadata(&"ö".repeat(3000));
    result.track_names = vec!["Bass".into(); 300];
    index
        .accept(
            &started.job_id,
            &batch.files[0].file_id,
            MetadataResult {
                sha256: input.sha256,
                metadata: Some(result),
                error: None,
            },
        )
        .unwrap();
    index.finish(&started.job_id, &configured).unwrap();
    let result = index
        .search(&query(None, ""))
        .unwrap()
        .rows
        .remove(0)
        .metadata
        .unwrap();
    assert_eq!(result.title.len(), 4096);
    assert_eq!(result.track_names.len(), 256);
    assert!(result.metadata_truncated);
}

#[test]
fn depth_limit_and_owned_storage_exclusion_never_publish_a_partial_refresh() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let directory = songs.join("file-library-v1");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    score(&directory, "private.tabplayer");
    score(&songs.join("recovery-v1"), "private.tabplayer");
    scan(&index, &configured, "Original");
    assert_eq!(index.search(&query(None, "")).unwrap().total, 1);
    let mut deep = songs.clone();
    for _ in 0..65 {
        deep.push("d");
    }
    score(&deep, "deep.tabplayer");
    let started = index.begin(configured.clone()).unwrap();
    let mut failed = false;
    loop {
        match index.next(&started.job_id) {
            Ok(batch) => {
                for file in batch.files {
                    let input = index.read(&started.job_id, &file.file_id).unwrap();
                    index
                        .accept(
                            &started.job_id,
                            &file.file_id,
                            MetadataResult {
                                sha256: input.sha256,
                                metadata: Some(metadata("Partial")),
                                error: None,
                            },
                        )
                        .unwrap();
                }
                if batch.done {
                    break;
                }
            }
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    assert!(failed);
    assert!(index.finish(&started.job_id, &configured).is_err());
    assert_eq!(index.search(&query(None, "original")).unwrap().total, 1);
}

#[test]
fn a_replaced_directory_and_oversized_file_are_not_read_as_score_data() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "replaced.tabplayer");
    let huge = fs::File::create(songs.join("huge.gp")).unwrap();
    huge.set_len(64 * 1024 * 1024 + 1).unwrap();
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    fs::remove_file(songs.join("replaced.tabplayer")).unwrap();
    fs::create_dir(songs.join("replaced.tabplayer")).unwrap();
    for file in batch.files {
        assert!(index.read(&started.job_id, &file.file_id).is_err());
    }
    index.finish(&started.job_id, &configured).unwrap();
    assert_eq!(index.search(&query(None, "")).unwrap().total, 2);
}

#[test]
fn corrupt_derived_cache_is_preserved_and_reported_without_hiding_other_roots() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let directory = temp.path().join("library");
    fs::create_dir(&directory).unwrap();
    let path = directory.join(format!("index-{}.json", configured.id));
    fs::write(&path, b"corrupt cache").unwrap();
    let index = LibraryIndex::new(directory, vec![configured]).unwrap();
    let page = index.search(&query(None, "")).unwrap();
    assert!(page.warning.is_some());
    assert_eq!(page.total, 0);
    assert_eq!(fs::read(path).unwrap(), b"corrupt cache");
}

#[cfg(any(unix, windows))]
#[test]
fn symlinks_and_outside_replacements_never_cross_the_root_scope() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    let outside = temp.path().join("scores-sibling");
    let nested = songs.join("nested");
    score(&nested, "replace.tabplayer");
    score(&outside, "replace.tabplayer");
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    fs::remove_file(nested.join("replace.tabplayer")).unwrap();
    fs::remove_dir(&nested).unwrap();
    directory_link(&outside, &nested);
    assert!(
        index
            .read(&started.job_id, &batch.files[0].file_id)
            .is_err()
    );
    index.finish(&started.job_id, &configured).unwrap();
    assert!(
        index
            .search(&query(None, ""))
            .unwrap()
            .rows
            .iter()
            .all(|row| !row.path.contains("scores-sibling"))
    );
    scan(&index, &configured, "Ignored");
    assert_eq!(index.search(&query(None, "")).unwrap().total, 0);
}

#[cfg(windows)]
#[test]
fn an_inaccessible_directory_cannot_replace_a_completed_index() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    score(&songs.join("locked"), "two.tabplayer");
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(0x02000000)
        .open(songs.join("locked"))
        .unwrap();
    let started = index.begin(configured.clone()).unwrap();
    assert!(index.next(&started.job_id).is_err());
    assert!(index.finish(&started.job_id, &configured).is_err());
    assert_eq!(index.search(&query(None, "original")).unwrap().total, 2);
    drop(held);
}

#[test]
fn resolve_uses_only_completed_current_descriptors_and_preserves_missing_path_receipts() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    let file = &batch.files[0];
    assert!(index.resolve(&configured.id, &file.file_id).is_err());
    let input = index.read(&started.job_id, &file.file_id).unwrap();
    index
        .accept(
            &started.job_id,
            &file.file_id,
            MetadataResult {
                sha256: input.sha256,
                metadata: Some(metadata("Committed")),
                error: None,
            },
        )
        .unwrap();
    index.finish(&started.job_id, &configured).unwrap();
    let resolved = index.resolve(&configured.id, &file.file_id).unwrap();
    assert_eq!(
        resolved,
        songs.join("one.tabplayer").canonicalize().unwrap()
    );
    fs::remove_file(songs.join("one.tabplayer")).unwrap();
    assert_eq!(
        index.resolve(&configured.id, &file.file_id).unwrap(),
        resolved
    );
    assert!(index.resolve(&configured.id, "arbitrary").is_err());
    index.retire_root(&configured.id).unwrap();
    assert!(index.resolve(&configured.id, &file.file_id).is_err());
}

#[cfg(any(unix, windows))]
#[test]
fn retiring_a_redirected_cache_directory_preserves_the_external_target() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let directory = temp.path().join("library");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let external_target = external.join(format!("index-{}.json", configured.id));
    fs::write(&external_target, b"preserve external").unwrap();
    fs::rename(&directory, temp.path().join("original-library")).unwrap();
    directory_link(&external, &directory);
    assert!(index.retire_root(&configured.id).is_err());
    assert_eq!(fs::read(&external_target).unwrap(), b"preserve external");
    assert_eq!(index.search(&query(None, "")).unwrap().total, 0);
}

#[cfg(windows)]
#[test]
fn an_unreadable_individual_score_is_counted_without_failing_the_folder() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let index = LibraryIndex::new(temp.path().join("library"), vec![configured.clone()]).unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(songs.join("one.tabplayer"))
        .unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    for file in batch.files {
        assert!(index.read(&started.job_id, &file.file_id).is_err());
    }
    index.finish(&started.job_id, &configured).unwrap();
    let page = index.search(&query(None, "")).unwrap();
    assert_eq!(page.total, 1);
    assert!(page.rows[0].metadata.is_none());
    drop(held);
}

#[test]
fn missing_root_cache_stays_visible_but_cannot_claim_an_unrelated_canonical_folder() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let directory = temp.path().join("library");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    drop(index);
    let cache_path = directory.join(format!("index-{}.json", configured.id));
    let mut cache: serde_json::Value =
        serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
    fs::remove_file(songs.join("one.tabplayer")).unwrap();
    fs::remove_dir(&songs).unwrap();
    let reopened = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    let page = reopened.search(&query(None, "original")).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.rows[0].status, LibraryResultStatus::Unavailable);
    drop(reopened);
    let outside = temp.path().join("outside");
    score(&outside, "private.tabplayer");
    let outside_root = outside.canonicalize().unwrap();
    let outside_score = outside.join("private.tabplayer").canonicalize().unwrap();
    let identity = outside_score.to_string_lossy().into_owned();
    #[cfg(windows)]
    let identity = identity.to_ascii_lowercase();
    let mut hash = Sha256::new();
    hash.update(configured.id.as_bytes());
    hash.update([0]);
    hash.update(identity.as_bytes());
    cache["canonicalRoot"] = serde_json::json!(outside_root);
    cache["files"][0]["row"]["path"] = serde_json::json!(outside_score);
    cache["files"][0]["row"]["id"] = serde_json::json!(format!("{:x}", hash.finalize()));
    let forged = serde_json::to_vec(&cache).unwrap();
    fs::write(&cache_path, &forged).unwrap();
    let reopened = LibraryIndex::new(directory, vec![configured]).unwrap();
    let page = reopened.search(&query(None, "")).unwrap();
    assert_eq!(page.total, 0);
    assert!(page.warning.is_some());
    assert_eq!(fs::read(cache_path).unwrap(), forged);
}

#[cfg(windows)]
#[test]
fn atomic_index_rename_failure_preserves_prior_bytes_and_observation() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let configured = root(&songs, 'a');
    let directory = temp.path().join("library");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    let target = directory.join(format!("index-{}.json", configured.id));
    let before = fs::read(&target).unwrap();
    let started = index.begin(configured.clone()).unwrap();
    let batch = index.next(&started.job_id).unwrap();
    let input = index
        .read(&started.job_id, &batch.files[0].file_id)
        .unwrap();
    index
        .accept(
            &started.job_id,
            &batch.files[0].file_id,
            MetadataResult {
                sha256: input.sha256,
                metadata: Some(metadata("Replacement")),
                error: None,
            },
        )
        .unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&target)
        .unwrap();
    assert!(index.finish(&started.job_id, &configured).is_err());
    assert_eq!(index.search(&query(None, "original")).unwrap().total, 1);
    drop(held);
    assert_eq!(fs::read(target).unwrap(), before);
}

#[cfg(windows)]
#[test]
fn a_canonical_root_held_without_sharing_keeps_its_index_after_restart() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("scores");
    score(&songs, "one.tabplayer");
    let mut configured = root(&songs, 'a');
    configured.path = songs.canonicalize().unwrap().to_string_lossy().into_owned();
    let directory = temp.path().join("library");
    let index = LibraryIndex::new(directory.clone(), vec![configured.clone()]).unwrap();
    scan(&index, &configured, "Original");
    drop(index);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(0x02000000)
        .open(&configured.path)
        .unwrap();
    assert!(fs::read_dir(&configured.path).is_err());
    let reopened = LibraryIndex::new(directory, vec![configured]).unwrap();
    let page = reopened.search(&query(None, "original")).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.rows[0].status, LibraryResultStatus::Unavailable);
    drop(held);
}
