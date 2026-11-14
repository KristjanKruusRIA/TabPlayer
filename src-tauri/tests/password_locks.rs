//! GP8 parity W16 and W17: a password to edit (a deterrent) and a password to open (real encryption).

use std::{path::Path, sync::Mutex, time::Instant};
use tabplayer_lib::{
    assets::StoredAsset,
    files::{PASSWORD_NEEDED, read_project, write_project},
    intake::read_candidate,
    password_crypto::{
        DAMAGED_FILE, KdfParams, OpenLock, PASSWORD_RULE, PasswordVerifier, Secret,
        WRONG_OPEN_PASSWORD, WRONG_PASSWORD, check_sealed, is_sealed, seal, unseal,
    },
    password_lock::{ProtectionRequest, apply_protection_with, unlock_document},
    project::{
        BaseDocument, BeatTarget, EDIT_LOCKED_MESSAGE, EditCommand, EditProtection, Project,
        ProjectCheckpoint, ProjectSession, SEALED_COPY_MESSAGE,
    },
    recovery::{DocumentViewState, TrackView, ViewTarget, redact_sealed},
    settings::ChannelMix,
    workspace::{DocumentIntake, DocumentRevision, DocumentSnapshot, DocumentWorkspace},
};

/// Small enough for a debug build; the real costs are checked for their bounds, not run.
fn fast() -> KdfParams {
    KdfParams::new(64, 1, 1).unwrap()
}
fn secret(value: &str) -> Secret {
    Secret::new(value)
}
const TITLE: &str = "Moonlight Zebra Sonata";
const PASSWORD: &str = "correct horse battery";
const OTHER: &str = "a different phrase";

fn titled() -> Project {
    let mut project = Project::blank();
    project.base = BaseDocument::Blank {
        title: TITLE.into(),
        artist: "Secret Artist".into(),
        tempo: 120.0,
        tuning: vec![64, 59, 55, 50, 45, 40],
        measure_count: 4,
    };
    project
}
fn note(fret: u32) -> EditCommand {
    EditCommand::SetNote {
        target: BeatTarget {
            track: 0,
            staff: 0,
            bar: 0,
            voice: 0,
            beat: 0,
        },
        string: 1,
        fret,
    }
}
fn mix() -> EditCommand {
    EditCommand::SetTrackMix {
        track_id: "base/0".into(),
        mix: ChannelMix::default(),
    }
}
fn open_one() -> (Mutex<DocumentWorkspace>, String) {
    let workspace = DocumentWorkspace::new().unwrap();
    let id = workspace.active_owner().document_id.clone();
    (Mutex::new(workspace), id)
}
fn current(workspace: &Mutex<DocumentWorkspace>, id: &str) -> DocumentRevision {
    let snapshot = workspace.lock().unwrap().document(id).unwrap();
    DocumentRevision {
        document_id: snapshot.document_id,
        revision: snapshot.revision,
    }
}
fn snapshot(workspace: &Mutex<DocumentWorkspace>, id: &str) -> DocumentSnapshot {
    workspace.lock().unwrap().document(id).unwrap()
}
fn protect(
    workspace: &Mutex<DocumentWorkspace>,
    id: &str,
    request: ProtectionRequest,
) -> Result<DocumentSnapshot, String> {
    apply_protection_with(workspace, &current(workspace, id), request, fast())
}
fn set_edit(workspace: &Mutex<DocumentWorkspace>, id: &str, password: &str) {
    protect(
        workspace,
        id,
        ProtectionRequest::SetEditPassword {
            current: None,
            password: secret(password),
        },
    )
    .unwrap();
}
fn lock_editing(workspace: &Mutex<DocumentWorkspace>, id: &str) {
    protect(workspace, id, ProtectionRequest::LockEditing).unwrap();
}
fn edit(
    workspace: &Mutex<DocumentWorkspace>,
    id: &str,
    command: EditCommand,
) -> Result<(), String> {
    let address = current(workspace, id);
    workspace
        .lock()
        .unwrap()
        .apply_edit(&address, command, None)
        .map(|_| ())
}
fn save(workspace: &Mutex<DocumentWorkspace>, id: &str, path: &Path) {
    let address = current(workspace, id);
    workspace
        .lock()
        .unwrap()
        .save_to_path(&address, path.to_path_buf())
        .unwrap();
}
/// Opens the file at `path` as a new document the way the Open command does, with the password if it needs one.
fn open_file(
    workspace: &Mutex<DocumentWorkspace>,
    path: &Path,
    password: Option<&str>,
) -> Result<String, String> {
    let candidate = match read_candidate(path.to_path_buf(), workspace)? {
        DocumentIntake::Candidate { candidate } => candidate,
        DocumentIntake::Locked { locked } => {
            match unlock_document(
                workspace,
                &locked.token,
                &secret(password.expect("a password")),
            ) {
                Ok(DocumentIntake::Candidate { candidate }) => candidate,
                Ok(_) => panic!("a correct password opens a candidate"),
                Err(error) => return Err(error),
            }
        }
        DocumentIntake::Existing { .. } => panic!("not open yet"),
    };
    let added = workspace.lock().unwrap().add_document(&candidate.token)?;
    Ok(added.active.document_id)
}
fn sealed_project_bytes(project: &Project, password: &str) -> Vec<u8> {
    let lock = OpenLock::create(password, fast()).unwrap();
    seal(&lock, &serde_json::to_vec_pretty(project).unwrap()).unwrap()
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

// ---- cryptography ----------------------------------------------------------------------------------------

#[test]
fn a_sealed_project_round_trips_and_reveals_nothing_of_itself() {
    let plain = serde_json::to_vec_pretty(&titled()).unwrap();
    assert!(contains(&plain, TITLE));
    let lock = OpenLock::create(PASSWORD, fast()).unwrap();
    let sealed = seal(&lock, &plain).unwrap();
    assert!(is_sealed(&sealed));
    assert!(!is_sealed(&plain));
    for text in [
        TITLE,
        "Secret Artist",
        "TabPlayer",
        "schemaVersion",
        PASSWORD,
    ] {
        assert!(
            !contains(&sealed, text),
            "{text} is visible in the sealed file"
        );
    }
    let (opened, again) = unseal(&sealed, &secret(PASSWORD)).unwrap();
    assert_eq!(*opened, plain);
    assert_eq!(again, lock);
    // A fresh nonce per seal: the same project sealed twice shares no ciphertext.
    let second = seal(&lock, &plain).unwrap();
    assert_ne!(sealed, second);
    assert_ne!(sealed[64..], second[64..]);
}

#[test]
fn a_wrong_password_and_every_kind_of_tampering_give_the_same_single_error() {
    let sealed = sealed_project_bytes(&titled(), PASSWORD);
    assert_eq!(
        unseal(&sealed, &secret(OTHER)).err().as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    assert_eq!(
        unseal(&sealed, &secret("")).err().as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    assert_eq!(
        unseal(&sealed, &secret(&"x".repeat(5000))).err().as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    // The salt, the nonce, a cost word (to a value still in bounds), the body and the tag.
    for index in [24, 30, 40, 63, 64, 100, sealed.len() - 1, sealed.len() - 20] {
        let mut changed = sealed.clone();
        changed[index] ^= 1;
        assert_eq!(
            unseal(&changed, &secret(PASSWORD)).err().as_deref(),
            Some(WRONG_OPEN_PASSWORD),
            "byte {index}"
        );
    }
    let mut costs = sealed.clone();
    costs[12] = costs[12].wrapping_add(1);
    assert_eq!(
        unseal(&costs, &secret(PASSWORD)).err().as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    // No error carries the password.
    assert!(!WRONG_OPEN_PASSWORD.contains(PASSWORD));
}

#[test]
fn truncated_or_extended_input_never_opens_and_never_panics() {
    let sealed = sealed_project_bytes(&titled(), PASSWORD);
    for length in 0..sealed.len() {
        let result = unseal(&sealed[..length], &secret(PASSWORD));
        let error = result
            .err()
            .unwrap_or_else(|| panic!("opened at length {length}"));
        assert!(
            error == DAMAGED_FILE || error == WRONG_OPEN_PASSWORD,
            "length {length}: {error}"
        );
        if length < 64 + 16 {
            assert_eq!(
                check_sealed(&sealed[..length]).err().as_deref(),
                Some(DAMAGED_FILE)
            );
        }
    }
    let mut longer = sealed.clone();
    longer.push(0);
    assert_eq!(
        unseal(&longer, &secret(PASSWORD)).err().as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    assert!(check_sealed(&sealed).is_ok());
}

#[test]
fn costs_read_from_a_file_are_bounded_before_any_work_is_done() {
    let sealed = sealed_project_bytes(&titled(), PASSWORD);
    let set = |at: usize, value: u32| {
        let mut changed = sealed.clone();
        changed[at..at + 4].copy_from_slice(&value.to_le_bytes());
        changed
    };
    let started = Instant::now();
    for hostile in [
        set(12, u32::MAX),
        set(12, KdfParams::MAX_MEMORY_KIB + 1),
        set(12, 7),
        set(16, 0),
        set(16, KdfParams::MAX_ITERATIONS + 1),
        set(16, u32::MAX),
        set(20, 0),
        set(20, KdfParams::MAX_PARALLELISM + 1),
        set(20, u32::MAX),
    ] {
        assert_eq!(check_sealed(&hostile).err().as_deref(), Some(DAMAGED_FILE));
        assert_eq!(
            unseal(&hostile, &secret(PASSWORD)).err().as_deref(),
            Some(DAMAGED_FILE)
        );
    }
    for (index, value) in [(8, 2), (9, 2), (10, 2), (11, 1), (0, b'X')] {
        let mut changed = sealed.clone();
        changed[index] = value;
        assert_eq!(check_sealed(&changed).err().as_deref(), Some(DAMAGED_FILE));
    }
    // Refusal is immediate: a gigabyte-scale derivation would take far longer.
    assert!(started.elapsed().as_secs() < 2);
    assert!(KdfParams::new(KdfParams::MAX_MEMORY_KIB, 3, 1).is_ok());
    assert!(KdfParams::new(KdfParams::MAX_MEMORY_KIB + 1, 3, 1).is_err());
    // The costs the app writes with sit inside the bounds it accepts.
    assert!(KdfParams::DEFAULT.validate().is_ok());
    assert!(KdfParams::DEFAULT.memory_kib >= 19 * 1024 && KdfParams::DEFAULT.iterations >= 2);
}

#[test]
fn the_edit_verifier_holds_a_salted_hash_and_never_the_password() {
    let verifier = PasswordVerifier::create(PASSWORD, fast()).unwrap();
    let again = PasswordVerifier::create(PASSWORD, fast()).unwrap();
    assert_ne!(verifier, again, "each password gets its own salt");
    let text = serde_json::to_string(&verifier).unwrap();
    assert!(!text.contains(PASSWORD));
    assert!(text.contains("argon2id"));
    assert!(verifier.verify(&secret(PASSWORD)).is_ok());
    assert_eq!(
        verifier.verify(&secret(OTHER)),
        Err(WRONG_PASSWORD.to_string())
    );
    assert_eq!(
        verifier.verify(&secret("")),
        Err(WRONG_PASSWORD.to_string())
    );
    assert_eq!(
        verifier.verify(&secret(&"y".repeat(5000))),
        Err(WRONG_PASSWORD.to_string())
    );
    let loaded: PasswordVerifier = serde_json::from_str(&text).unwrap();
    assert!(loaded.verify(&secret(PASSWORD)).is_ok());
    // Costs, encodings and unknown fields in a file are checked.
    for (field, value) in [
        ("memoryKib", serde_json::json!(u32::MAX)),
        ("iterations", serde_json::json!(0)),
        ("parallelism", serde_json::json!(99)),
        ("salt", serde_json::json!("AAAA")),
        ("hash", serde_json::json!("not base64!")),
        ("kdf", serde_json::json!("md5")),
    ] {
        let mut value_in_file: serde_json::Value = serde_json::from_str(&text).unwrap();
        value_in_file[field] = value;
        let hostile: PasswordVerifier = serde_json::from_value(value_in_file).unwrap();
        assert!(hostile.validate().is_err(), "{field}");
        assert!(hostile.verify(&secret(PASSWORD)).is_err(), "{field}");
    }
    let mut extra: serde_json::Value = serde_json::from_str(&text).unwrap();
    extra["password"] = serde_json::json!(PASSWORD);
    assert!(serde_json::from_value::<PasswordVerifier>(extra).is_err());
}

#[test]
fn new_passwords_follow_one_rule_and_secrets_never_print() {
    for short in ["", "1234567", "short"] {
        assert_eq!(
            PasswordVerifier::create(short, fast()).err().as_deref(),
            Some(PASSWORD_RULE)
        );
        assert_eq!(
            OpenLock::create(short, fast()).err().as_deref(),
            Some(PASSWORD_RULE)
        );
    }
    assert!(OpenLock::create(&"é".repeat(8), fast()).is_ok());
    assert!(OpenLock::create(&"z".repeat(129), fast()).is_err());
    assert!(!format!("{:?}", secret(PASSWORD)).contains(PASSWORD));
    let lock = OpenLock::create(PASSWORD, fast()).unwrap();
    assert!(!format!("{lock:?}").contains(PASSWORD));
    assert!(lock.accepts(&secret(PASSWORD)));
    assert!(!lock.accepts(&secret(OTHER)));
}

// ---- migration and file format ---------------------------------------------------------------------------

#[test]
fn projects_without_protection_keep_their_exact_form_and_old_files_still_open() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("plain.tabplayer");
    write_project(&path, &titled()).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("editLock") && !text.contains("openLock") && !text.contains("TABPLOCK"));
    assert_eq!(read_project(&path).unwrap(), titled());
    // A schema-1 project from before assets and locks, and an old checkpoint, read as unprotected.
    let legacy = serde_json::json!({
        "format": "TabPlayer", "schemaVersion": 1, "engineVersion": "1.8.4",
        "base": {"kind": "blank", "title": "Old", "artist": "", "tempo": 120.0,
                 "tuning": [64, 59, 55, 50, 45, 40], "measureCount": 4},
        "edits": [],
    });
    let project: Project = serde_json::from_value(legacy).unwrap();
    assert!(project.edit_lock.is_none() && project.open_lock.is_none());
    let checkpoint = ProjectSession::new(Project::blank(), None)
        .unwrap()
        .checkpoint();
    let text = serde_json::to_string(&checkpoint).unwrap();
    assert!(!text.contains("EditLock") && !text.contains("OpenLock"));
    let loaded: ProjectCheckpoint = serde_json::from_str(&text).unwrap();
    assert_eq!(loaded.saved_edit_lock, None);
    // A null lock would read as unprotected and silently drop the protection on the next save.
    let mut protected = serde_json::to_value(Project::blank()).unwrap();
    protected["editLock"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<Project>(protected).is_err());
}

#[test]
fn a_sealed_file_is_encrypted_on_disk_and_other_readers_refuse_it_plainly() {
    let directory = tempfile::tempdir().unwrap();
    let mut project = titled();
    project.open_lock = Some(OpenLock::create(PASSWORD, fast()).unwrap());
    let path = directory.path().join("sealed.tabplayer");
    write_project(&path, &project).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert!(is_sealed(&bytes));
    assert!(!contains(&bytes, TITLE) && !contains(&bytes, "schemaVersion"));
    assert_eq!(read_project(&path).err().as_deref(), Some(PASSWORD_NEEDED));
    let (opened, _) = unseal(&bytes, &secret(PASSWORD)).unwrap();
    let back: Project = serde_json::from_slice(&opened).unwrap();
    assert_eq!(back.base, project.base);
    // The key is never part of the project's JSON, so no backup, checkpoint or log can carry it.
    let json = serde_json::to_string(&project).unwrap();
    assert!(!json.contains("openLock") && !json.contains(PASSWORD));
}

// ---- password to edit ------------------------------------------------------------------------------------

#[test]
fn setting_a_password_to_edit_locks_edits_undo_and_redo_but_not_the_mixer() {
    let (workspace, id) = open_one();
    edit(&workspace, &id, note(3)).unwrap();
    edit(&workspace, &id, note(4)).unwrap();
    {
        let address = current(&workspace, &id);
        workspace.lock().unwrap().undo(&address).unwrap();
    }
    set_edit(&workspace, &id, PASSWORD);
    let unlocked = snapshot(&workspace, &id);
    assert_eq!(unlocked.snapshot.protection.edit, EditProtection::Unlocked);
    assert!(
        unlocked.snapshot.dirty,
        "a new protection is an unsaved change"
    );
    assert!(
        unlocked.snapshot.can_redo,
        "setting a password keeps the redo stack"
    );

    lock_editing(&workspace, &id);
    let before = snapshot(&workspace, &id);
    assert_eq!(before.snapshot.protection.edit, EditProtection::Locked);
    for command in [note(7), EditCommand::AppendMeasure] {
        assert_eq!(
            edit(&workspace, &id, command),
            Err(EDIT_LOCKED_MESSAGE.into())
        );
    }
    let address = current(&workspace, &id);
    assert_eq!(
        workspace.lock().unwrap().undo(&address).map(|_| ()),
        Err(EDIT_LOCKED_MESSAGE.into())
    );
    assert_eq!(
        workspace.lock().unwrap().redo(&address).map(|_| ()),
        Err(EDIT_LOCKED_MESSAGE.into())
    );
    assert_eq!(
        workspace.lock().unwrap().check_unlocked(&id),
        Err(EDIT_LOCKED_MESSAGE.into())
    );
    let asset = StoredAsset::from_bytes("a.wav".into(), "audio/wav".into(), b"bytes");
    assert_eq!(
        workspace.lock().unwrap().stage_asset(&id, asset).err(),
        Some(EDIT_LOCKED_MESSAGE.into())
    );
    assert_eq!(snapshot(&workspace, &id), before, "refusals change nothing");
    // The mixer stays usable, as on a finalized score.
    edit(&workspace, &id, mix()).unwrap();
}

#[test]
fn a_wrong_password_unlocks_nothing_and_changes_nothing() {
    let (workspace, id) = open_one();
    set_edit(&workspace, &id, PASSWORD);
    lock_editing(&workspace, &id);
    let before = snapshot(&workspace, &id);
    for attempt in [
        OTHER,
        "",
        PASSWORD.to_uppercase().as_str(),
        "correct horse batter",
    ] {
        let error = protect(
            &workspace,
            &id,
            ProtectionRequest::UnlockEditing {
                password: secret(attempt),
            },
        )
        .unwrap_err();
        assert_eq!(error, WRONG_PASSWORD);
        assert!(!error.contains(attempt) || attempt.is_empty());
    }
    assert_eq!(snapshot(&workspace, &id), before);
    assert_eq!(
        edit(&workspace, &id, note(1)),
        Err(EDIT_LOCKED_MESSAGE.into())
    );
    let unlocked = protect(
        &workspace,
        &id,
        ProtectionRequest::UnlockEditing {
            password: secret(PASSWORD),
        },
    )
    .unwrap();
    assert_eq!(unlocked.snapshot.protection.edit, EditProtection::Unlocked);
    // One gesture is one edit, as ever.
    let edits = unlocked.snapshot.project.edits.len();
    edit(&workspace, &id, note(5)).unwrap();
    assert_eq!(
        snapshot(&workspace, &id).snapshot.project.edits.len(),
        edits + 1
    );
    // Locking an already locked score, or unlocking an unlocked one, bumps nothing.
    lock_editing(&workspace, &id);
    let locked = snapshot(&workspace, &id);
    lock_editing(&workspace, &id);
    assert_eq!(snapshot(&workspace, &id), locked);
}

#[test]
fn the_password_to_edit_survives_save_and_open_and_is_never_stored_in_clear() {
    let directory = tempfile::tempdir().unwrap();
    let (workspace, id) = open_one();
    edit(&workspace, &id, note(2)).unwrap();
    set_edit(&workspace, &id, PASSWORD);
    let path = directory.path().join("taught.tabplayer");
    save(&workspace, &id, &path);
    assert!(!snapshot(&workspace, &id).snapshot.dirty);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("editLock") && text.contains("argon2id"));
    assert!(!text.contains(PASSWORD));
    // Not in the live snapshot, the edit log or any history entry either.
    let live = serde_json::to_string(&snapshot(&workspace, &id)).unwrap();
    assert!(!live.contains(PASSWORD) && !live.contains("argon2id") && !live.contains("editLock"));
    let history = serde_json::to_string(&snapshot(&workspace, &id).snapshot.project.edits).unwrap();
    assert!(!history.contains("assword"));
    // Reopened, the score starts locked: the session never carries an unlock to the next open.
    let (next, _) = open_one();
    let reopened = open_file(&next, &path, None).unwrap();
    let state = snapshot(&next, &reopened);
    assert_eq!(state.snapshot.protection.edit, EditProtection::Locked);
    assert!(!state.snapshot.dirty);
    assert_eq!(
        edit(&next, &reopened, note(9)),
        Err(EDIT_LOCKED_MESSAGE.into())
    );
    assert_eq!(state.snapshot.project.edits, vec![note(2)]);
    protect(
        &next,
        &reopened,
        ProtectionRequest::UnlockEditing {
            password: secret(PASSWORD),
        },
    )
    .unwrap();
    edit(&next, &reopened, note(9)).unwrap();
}

#[test]
fn changing_or_removing_the_password_to_edit_needs_the_current_one() {
    let directory = tempfile::tempdir().unwrap();
    let (workspace, id) = open_one();
    set_edit(&workspace, &id, PASSWORD);
    let path = directory.path().join("a.tabplayer");
    save(&workspace, &id, &path);
    lock_editing(&workspace, &id);
    let change = |current: Option<&str>, password: &str| {
        protect(
            &workspace,
            &id,
            ProtectionRequest::SetEditPassword {
                current: current.map(secret),
                password: secret(password),
            },
        )
    };
    assert_eq!(change(None, OTHER).err().as_deref(), Some(WRONG_PASSWORD));
    assert_eq!(
        change(Some("not it at all"), OTHER).err().as_deref(),
        Some(WRONG_PASSWORD)
    );
    assert_eq!(
        change(Some(PASSWORD), "short").err().as_deref(),
        Some(PASSWORD_RULE)
    );
    assert_eq!(
        protect(
            &workspace,
            &id,
            ProtectionRequest::RemoveEditPassword {
                current: secret(OTHER)
            }
        )
        .err()
        .as_deref(),
        Some(WRONG_PASSWORD)
    );
    assert!(!snapshot(&workspace, &id).snapshot.dirty);
    // A changed password replaces the old one, and the person who changed it can keep editing.
    let changed = change(Some(PASSWORD), OTHER).unwrap();
    assert_eq!(changed.snapshot.protection.edit, EditProtection::Unlocked);
    assert!(changed.snapshot.dirty);
    lock_editing(&workspace, &id);
    assert_eq!(
        protect(
            &workspace,
            &id,
            ProtectionRequest::UnlockEditing {
                password: secret(PASSWORD)
            }
        )
        .err()
        .as_deref(),
        Some(WRONG_PASSWORD)
    );
    protect(
        &workspace,
        &id,
        ProtectionRequest::RemoveEditPassword {
            current: secret(OTHER),
        },
    )
    .unwrap();
    edit(&workspace, &id, note(1)).unwrap();
    assert_eq!(
        snapshot(&workspace, &id).snapshot.protection.edit,
        EditProtection::None
    );
    save(&workspace, &id, &path);
    assert!(!std::fs::read_to_string(&path).unwrap().contains("editLock"));
    // Asking to remove a password that is not set is an error, not a silent success.
    assert!(
        protect(
            &workspace,
            &id,
            ProtectionRequest::RemoveEditPassword {
                current: secret(OTHER)
            }
        )
        .is_err()
    );
}

#[test]
fn copying_a_score_with_an_edit_password_keeps_the_password() {
    let (workspace, id) = open_one();
    set_edit(&workspace, &id, PASSWORD);
    let address = current(&workspace, &id);
    let template = workspace
        .lock()
        .unwrap()
        .template_project(&address)
        .unwrap();
    assert!(template.edit_lock.is_some());
    let staged = workspace.lock().unwrap().stage_fork(template).unwrap();
    let added = workspace
        .lock()
        .unwrap()
        .add_document(&staged.token)
        .unwrap();
    let copy = snapshot(&workspace, &added.active.document_id);
    assert_eq!(copy.snapshot.protection.edit, EditProtection::Locked);
}

#[test]
fn an_unsaved_password_is_dropped_by_a_clean_shutdown_and_never_stops_a_recovered_score() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    assert!(!session.snapshot().dirty);
    let verifier = PasswordVerifier::create(PASSWORD, fast()).unwrap();
    session
        .change_protection(tabplayer_lib::project::ProtectionChange::SetEdit {
            replacing: None,
            verifier: verifier.clone(),
        })
        .unwrap();
    assert!(session.snapshot().dirty);
    let checkpoint = session.checkpoint();
    assert!(checkpoint.is_dirty());
    let restored: ProjectCheckpoint =
        serde_json::from_str(&serde_json::to_string(&checkpoint).unwrap()).unwrap();
    assert_eq!(restored, checkpoint);
    // A recovered session is locked again: the unlock was only ever in memory.
    assert!(
        ProjectSession::from_checkpoint(restored)
            .unwrap()
            .edit_locked()
    );
    let saved = session.saved_checkpoint().unwrap();
    assert_eq!(saved.project.edit_lock, None);
    assert!(!saved.is_dirty());
}

// ---- password to open ------------------------------------------------------------------------------------

fn sealed_file(
    directory: &Path,
    name: &str,
    project: &Project,
    password: &str,
) -> std::path::PathBuf {
    let path = directory.join(name);
    std::fs::write(&path, sealed_project_bytes(project, password)).unwrap();
    path
}

#[test]
fn opening_a_sealed_file_asks_for_its_password_and_a_wrong_one_keeps_everything_as_it_was() {
    let directory = tempfile::tempdir().unwrap();
    let mut project = titled();
    project.edits.push(note(6));
    let path = sealed_file(directory.path(), "locked.tabplayer", &project, PASSWORD);
    let (workspace, original) = open_one();
    let before = workspace.lock().unwrap().snapshot();
    let DocumentIntake::Locked { locked } = read_candidate(path.clone(), &workspace).unwrap()
    else {
        panic!("a sealed file waits for its password");
    };
    // Nothing of the file is shown, or opened, by asking for a password.
    let shown = serde_json::to_string(&locked).unwrap();
    assert!(!shown.contains(TITLE) && shown.contains("locked.tabplayer"));
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    for attempt in [OTHER, "", "correct horse battery "] {
        assert_eq!(
            unlock_document(&workspace, &locked.token, &secret(attempt))
                .err()
                .as_deref(),
            Some(WRONG_OPEN_PASSWORD)
        );
        assert_eq!(workspace.lock().unwrap().snapshot(), before);
    }
    // Still waiting: the right password now opens it.
    let DocumentIntake::Candidate { candidate } =
        unlock_document(&workspace, &locked.token, &secret(PASSWORD)).unwrap()
    else {
        panic!("the right password opens it");
    };
    assert_eq!(candidate.project.edits, vec![note(6)]);
    let added = workspace
        .lock()
        .unwrap()
        .add_document(&candidate.token)
        .unwrap();
    assert_ne!(added.active.document_id, original);
    let opened = snapshot(&workspace, &added.active.document_id);
    assert!(opened.snapshot.protection.open);
    assert!(!opened.snapshot.dirty);
    // Once opened it no longer waits.
    assert!(unlock_document(&workspace, &locked.token, &secret(PASSWORD)).is_err());
}

#[test]
fn a_sealed_document_saves_sealed_under_the_same_password_without_asking_again() {
    let directory = tempfile::tempdir().unwrap();
    let path = sealed_file(directory.path(), "locked.tabplayer", &titled(), PASSWORD);
    let first_bytes = std::fs::read(&path).unwrap();
    let (workspace, _) = open_one();
    let id = open_file(&workspace, &path, Some(PASSWORD)).unwrap();
    edit(&workspace, &id, note(8)).unwrap();
    assert!(snapshot(&workspace, &id).snapshot.dirty);
    save(&workspace, &id, &path);
    let saved = std::fs::read(&path).unwrap();
    assert!(is_sealed(&saved) && !contains(&saved, TITLE));
    assert_ne!(saved, first_bytes);
    // The new file opens with the same password and holds the edit; the old password still works, no other does.
    let (second, _) = open_one();
    assert!(open_file(&second, &path, Some(OTHER)).is_err());
    let again = open_file(&second, &path, Some(PASSWORD)).unwrap();
    assert_eq!(
        snapshot(&second, &again).snapshot.project.edits,
        vec![note(8)]
    );
    // A copy saved elsewhere is sealed too: Save As cannot drop the protection.
    let copy = directory.path().join("copy.tabplayer");
    save(&workspace, &id, &copy);
    assert!(is_sealed(&std::fs::read(&copy).unwrap()));
}

#[test]
fn a_tampered_sealed_file_looks_exactly_like_a_wrong_password() {
    let directory = tempfile::tempdir().unwrap();
    let mut bytes = sealed_project_bytes(&titled(), PASSWORD);
    let last = bytes.len() - 5;
    bytes[last] ^= 0x40;
    let path = directory.path().join("tampered.tabplayer");
    std::fs::write(&path, &bytes).unwrap();
    let (workspace, _) = open_one();
    let before = workspace.lock().unwrap().snapshot();
    assert_eq!(
        open_file(&workspace, &path, Some(PASSWORD))
            .err()
            .as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    assert_eq!(
        open_file(&workspace, &path, Some(OTHER)).err().as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[test]
fn a_truncated_or_hostile_sealed_file_is_refused_before_a_password_is_asked() {
    let directory = tempfile::tempdir().unwrap();
    let sealed = sealed_project_bytes(&titled(), PASSWORD);
    let (workspace, _) = open_one();
    let before = workspace.lock().unwrap().snapshot();
    let try_open = |name: &str, bytes: &[u8]| {
        let path = directory.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        read_candidate(path, &workspace)
    };
    assert_eq!(
        try_open("magic-only.tabplayer", b"TABPLOCK")
            .err()
            .as_deref(),
        Some(DAMAGED_FILE)
    );
    assert_eq!(
        try_open("header-only.tabplayer", &sealed[..64])
            .err()
            .as_deref(),
        Some(DAMAGED_FILE)
    );
    let mut hostile = sealed.clone();
    hostile[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(
        try_open("hostile.tabplayer", &hostile).err().as_deref(),
        Some(DAMAGED_FILE)
    );
    // Cut inside the body: it asks for a password, and no password can open it.
    let cut = &sealed[..sealed.len() - 10];
    let DocumentIntake::Locked { locked } = try_open("cut.tabplayer", cut).unwrap() else {
        panic!("structurally fine");
    };
    assert_eq!(
        unlock_document(&workspace, &locked.token, &secret(PASSWORD))
            .err()
            .as_deref(),
        Some(WRONG_OPEN_PASSWORD)
    );
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[test]
fn files_waiting_for_a_password_are_few_and_can_be_cancelled() {
    let directory = tempfile::tempdir().unwrap();
    let path = sealed_file(directory.path(), "locked.tabplayer", &titled(), PASSWORD);
    let (workspace, _) = open_one();
    let mut tokens = Vec::new();
    for _ in 0..6 {
        let DocumentIntake::Locked { locked } = read_candidate(path.clone(), &workspace).unwrap()
        else {
            panic!("waiting");
        };
        tokens.push(locked.token);
    }
    // Only the last few still wait; an older one has to be opened again.
    assert!(unlock_document(&workspace, &tokens[0], &secret(PASSWORD)).is_err());
    assert!(workspace.lock().unwrap().cancel_document(&tokens[5]));
    assert!(!workspace.lock().unwrap().cancel_document(&tokens[5]));
    assert!(unlock_document(&workspace, &tokens[5], &secret(PASSWORD)).is_err());
    assert!(unlock_document(&workspace, &tokens[4], &secret(PASSWORD)).is_ok());
}

#[test]
fn the_password_to_open_is_set_changed_and_removed_with_the_current_password() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("plain.tabplayer");
    let (workspace, id) = open_one();
    let set = |current: Option<&str>, password: &str| {
        protect(
            &workspace,
            &id,
            ProtectionRequest::SetOpenPassword {
                current: current.map(secret),
                password: secret(password),
            },
        )
    };
    save(&workspace, &id, &path);
    assert!(!is_sealed(&std::fs::read(&path).unwrap()));
    let sealed = set(None, PASSWORD).unwrap();
    assert!(sealed.snapshot.protection.open && sealed.snapshot.dirty);
    save(&workspace, &id, &path);
    assert!(is_sealed(&std::fs::read(&path).unwrap()));
    assert!(!snapshot(&workspace, &id).snapshot.dirty);
    // Changing it needs the current one; the policy is the same as for any new password.
    assert_eq!(set(None, OTHER).err().as_deref(), Some(WRONG_PASSWORD));
    assert_eq!(
        set(Some(OTHER), OTHER).err().as_deref(),
        Some(WRONG_PASSWORD)
    );
    assert_eq!(
        set(Some(PASSWORD), "short").err().as_deref(),
        Some(PASSWORD_RULE)
    );
    set(Some(PASSWORD), OTHER).unwrap();
    assert!(snapshot(&workspace, &id).snapshot.dirty);
    save(&workspace, &id, &path);
    let (second, _) = open_one();
    assert!(open_file(&second, &path, Some(PASSWORD)).is_err());
    assert!(open_file(&second, &path, Some(OTHER)).is_ok());
    // Removing needs the current password and the next save is plain.
    let remove = |current: &str| {
        protect(
            &workspace,
            &id,
            ProtectionRequest::RemoveOpenPassword {
                current: secret(current),
            },
        )
    };
    assert_eq!(remove(PASSWORD).err().as_deref(), Some(WRONG_PASSWORD));
    let plain = remove(OTHER).unwrap();
    assert!(!plain.snapshot.protection.open && plain.snapshot.dirty);
    save(&workspace, &id, &path);
    assert!(!is_sealed(&std::fs::read(&path).unwrap()));
    assert!(remove(OTHER).is_err());
}

#[test]
fn a_sealed_score_cannot_become_a_plain_copy_or_a_plain_recovery_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = sealed_file(directory.path(), "locked.tabplayer", &titled(), PASSWORD);
    let (workspace, _) = open_one();
    let id = open_file(&workspace, &path, Some(PASSWORD)).unwrap();
    let address = current(&workspace, &id);
    assert_eq!(
        workspace
            .lock()
            .unwrap()
            .template_project(&address)
            .err()
            .as_deref(),
        Some(SEALED_COPY_MESSAGE)
    );
    workspace
        .lock()
        .unwrap()
        .set_view(
            &id,
            DocumentViewState {
                target: ViewTarget {
                    track: 2,
                    staff: 0,
                    bar: 3,
                    voice: 0,
                    beat: 1,
                },
                selected_string: 2,
                selected_note_index: Some(1),
                zoom: 150.0,
                track_view: TrackView::Custom {
                    track_ids: vec!["secret-track-id".into()],
                },
                instrument_visible: true,
                score_display: None,
                keyboard_visible: true,
            },
        )
        .unwrap();
    let documents = workspace.lock().unwrap().recovery_documents().unwrap();
    let sealed = documents
        .iter()
        .find(|document| document.document_id == id)
        .unwrap();
    assert!(sealed.session.is_sealed());
    // The checkpoint itself never serializes the key, but it would hold the whole score in plain form.
    assert!(contains(&serde_json::to_vec(&documents).unwrap(), TITLE));
    let redacted = redact_sealed(documents.clone());
    let text = serde_json::to_string(&redacted).unwrap();
    assert!(
        !text.contains(TITLE)
            && !text.contains("Secret Artist")
            && !text.contains("locked.tabplayer")
    );
    assert!(!text.contains("openLock") && !text.contains(PASSWORD));
    assert!(!text.contains("secret-track-id"));
    assert_eq!(redacted.len(), documents.len());
    for (kept, original) in redacted.iter().zip(&documents) {
        assert_eq!(kept.document_id, original.document_id);
        assert_eq!(kept.revision, original.revision);
        // Only display preferences survive; positions and track ids point into the score.
        assert_eq!(kept.view.zoom, original.view.zoom);
        assert_eq!(kept.view.score_display, original.view.score_display);
        assert_eq!(kept.view.keyboard_visible, original.view.keyboard_visible);
        assert_eq!(kept.view.target, DocumentViewState::default().target);
        assert_eq!(
            kept.view.selected_string,
            DocumentViewState::default().selected_string
        );
        assert_eq!(kept.view.selected_note_index, None);
        assert_eq!(kept.view.track_view, TrackView::Selected {});
    }
    // Unsealed documents are untouched.
    let plain = documents
        .iter()
        .find(|document| document.document_id != id)
        .unwrap();
    assert!(!plain.session.is_sealed());
    assert!(redacted.iter().any(|document| document == plain));
}

#[test]
fn a_document_saved_sealed_stays_sealed_in_recovery_even_if_its_password_was_removed_unsaved() {
    let directory = tempfile::tempdir().unwrap();
    let path = sealed_file(directory.path(), "locked.tabplayer", &titled(), PASSWORD);
    let (workspace, _) = open_one();
    let id = open_file(&workspace, &path, Some(PASSWORD)).unwrap();
    protect(
        &workspace,
        &id,
        ProtectionRequest::RemoveOpenPassword {
            current: secret(PASSWORD),
        },
    )
    .unwrap();
    let documents = workspace.lock().unwrap().recovery_documents().unwrap();
    let removed = documents
        .iter()
        .find(|document| document.document_id == id)
        .unwrap();
    // The live copy is plain, but its saved file is sealed, and both the live and the clean-shutdown form are redacted.
    assert!(removed.session.is_sealed());
    assert!(removed.session.is_dirty());
    let reduced = tabplayer_lib::project::ProjectSession::from_checkpoint(removed.session.clone())
        .unwrap()
        .saved_checkpoint()
        .unwrap();
    assert!(reduced.is_sealed());
}

#[test]
fn passwords_never_appear_in_errors_or_live_state() {
    let (workspace, id) = open_one();
    set_edit(&workspace, &id, PASSWORD);
    lock_editing(&workspace, &id);
    let probe = "swordfish-4821";
    let mut messages = Vec::new();
    for request in [
        ProtectionRequest::UnlockEditing {
            password: secret(probe),
        },
        ProtectionRequest::SetEditPassword {
            current: Some(secret(probe)),
            password: secret(OTHER),
        },
        ProtectionRequest::RemoveEditPassword {
            current: secret(probe),
        },
        ProtectionRequest::RemoveOpenPassword {
            current: secret(probe),
        },
        ProtectionRequest::SetOpenPassword {
            current: None,
            password: secret("tiny"),
        },
    ] {
        messages.push(format!("{:?}", request));
        messages.push(protect(&workspace, &id, request).unwrap_err());
    }
    messages.push(serde_json::to_string(&snapshot(&workspace, &id)).unwrap());
    let request: ProtectionRequest = serde_json::from_str(
        r#"{"kind":"setOpenPassword","current":null,"password":"secret-from-ui"}"#,
    )
    .unwrap();
    messages.push(format!("{request:?}"));
    for message in &messages {
        for password in [probe, PASSWORD, OTHER, "secret-from-ui"] {
            assert!(
                !message.contains(password),
                "{password} leaked into {message}"
            );
        }
    }
}

#[test]
fn the_costs_the_app_writes_with_run_in_a_moments_wait_and_open_what_they_seal() {
    let started = Instant::now();
    let lock = OpenLock::create(PASSWORD, KdfParams::DEFAULT).unwrap();
    let sealed = seal(&lock, b"{}").unwrap();
    let derive_time = started.elapsed();
    let (opened, _) = unseal(&sealed, &secret(PASSWORD)).unwrap();
    assert_eq!(*opened, b"{}");
    assert!(unseal(&sealed, &secret(OTHER)).is_err());
    // Three derivations at 64 MiB: slow enough to resist guessing, fast enough that nobody waits on it.
    assert!(started.elapsed().as_secs() < 30, "{:?}", started.elapsed());
    println!("one derivation at the default costs: {derive_time:?}");
}

#[test]
fn a_score_locked_for_editing_cannot_be_sealed_unsealed_or_finalized_without_its_password() {
    use tabplayer_lib::project::DocumentLock;
    let (workspace, id) = open_one();
    protect(
        &workspace,
        &id,
        ProtectionRequest::SetOpenPassword {
            current: None,
            password: secret(OTHER),
        },
    )
    .unwrap();
    set_edit(&workspace, &id, PASSWORD);
    lock_editing(&workspace, &id);
    let before = snapshot(&workspace, &id);
    let set = |current: Option<&str>| {
        protect(
            &workspace,
            &id,
            ProtectionRequest::SetOpenPassword {
                current: current.map(secret),
                password: secret("yet another phrase"),
            },
        )
    };
    assert_eq!(set(Some(OTHER)).err().as_deref(), Some(EDIT_LOCKED_MESSAGE));
    assert_eq!(
        protect(
            &workspace,
            &id,
            ProtectionRequest::RemoveOpenPassword {
                current: secret(OTHER)
            }
        )
        .err()
        .as_deref(),
        Some(EDIT_LOCKED_MESSAGE)
    );
    for lock in [Some(DocumentLock::Finalized), None] {
        let address = current(&workspace, &id);
        assert_eq!(
            workspace
                .lock()
                .unwrap()
                .set_lock(&address, lock)
                .err()
                .as_deref(),
            // Unfinalizing an unfinalized score changes nothing, so only the finalize is refused.
            if lock.is_some() {
                Some(EDIT_LOCKED_MESSAGE)
            } else {
                None
            }
        );
    }
    assert_eq!(snapshot(&workspace, &id), before);
    // With the password given, all of it works.
    protect(
        &workspace,
        &id,
        ProtectionRequest::UnlockEditing {
            password: secret(PASSWORD),
        },
    )
    .unwrap();
    set(Some(OTHER)).unwrap();
    let address = current(&workspace, &id);
    workspace
        .lock()
        .unwrap()
        .set_lock(&address, Some(DocumentLock::Finalized))
        .unwrap();
    lock_editing(&workspace, &id);
    let address = current(&workspace, &id);
    assert_eq!(
        workspace
            .lock()
            .unwrap()
            .set_lock(&address, None)
            .err()
            .as_deref(),
        Some(EDIT_LOCKED_MESSAGE)
    );
}

#[test]
fn sealing_a_score_removes_the_older_recovery_backup_that_holds_it_in_plain_form() {
    use tabplayer_lib::recovery::{RecoveryEnvelope, RecoveryStore, SessionLifecycle};
    let directory = tempfile::tempdir().unwrap();
    let plain_path = directory.path().join("song.tabplayer");
    write_project(&plain_path, &titled()).unwrap();
    let (workspace, _) = open_one();
    let id = open_file(&workspace, &plain_path, None).unwrap();
    let mut store = RecoveryStore::acquire(directory.path().join("session")).unwrap();
    let checkpoints = || {
        std::fs::read_dir(directory.path().join("session/recovery-v1"))
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("checkpoint")
            })
            .count()
    };
    let mut commit = |documents, keep_previous| {
        let (epoch, generation) = store.next_identity(false).unwrap();
        store
            .commit_keeping(
                &RecoveryEnvelope {
                    format: "TabPlayerRecovery".into(),
                    version: 1,
                    epoch,
                    generation,
                    captured_at_unix_ms: 1,
                    active_document_id: None,
                    documents,
                },
                SessionLifecycle::Running,
                false,
                keep_previous,
            )
            .unwrap();
    };
    let plain = workspace.lock().unwrap().recovery_documents().unwrap();
    commit(plain.clone(), true);
    commit(plain, true);
    assert_eq!(checkpoints(), 2, "two plain checkpoints are kept");
    protect(
        &workspace,
        &id,
        ProtectionRequest::SetOpenPassword {
            current: None,
            password: secret(PASSWORD),
        },
    )
    .unwrap();
    let documents = workspace.lock().unwrap().recovery_documents().unwrap();
    assert!(
        documents
            .iter()
            .any(|document| document.session.is_sealed())
    );
    commit(redact_sealed(documents), false);
    assert_eq!(
        checkpoints(),
        1,
        "only the checkpoint without the score remains"
    );
}
