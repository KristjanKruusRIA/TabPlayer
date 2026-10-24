use super::*;
use crate::{
    assets::StoredAsset,
    project::{BeatTarget, EditCommand, Project},
    recovery::{MAX_CHECKPOINT_BYTES, encode_checkpoint},
    settings::{BackingSettings, ChannelMix},
    workspace::DocumentRevision,
};
use std::io::Write;

// Manual acceptance only: these tests stream hundreds of MiB and validate large assets.
fn wait_for(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(180);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "manual acceptance synchronization deadline"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
fn authored_project() -> Project {
    let pcm_bytes = 48_000_u32 * 180 * 2 * 2;
    let mut wav = Vec::with_capacity(pcm_bytes as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(pcm_bytes + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&48_000_u32.to_le_bytes());
    wav.extend_from_slice(&192_000_u32.to_le_bytes());
    wav.extend_from_slice(&4_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&pcm_bytes.to_le_bytes());
    wav.resize(pcm_bytes as usize + 44, 0);
    assert_eq!(wav.len(), 34_560_044);
    let asset =
        StoredAsset::from_bytes("authored-three-minute.wav".into(), "audio/wav".into(), &wav);
    let asset_id = asset.id().unwrap();
    let mut project = Project::blank();
    if let BaseDocument::Blank { measure_count, .. } = &mut project.base {
        *measure_count = 100;
    }
    for track in 1..4 {
        project.edits.push(EditCommand::AddTrack {
            name: format!("Authored track {}", track + 1),
            tuning: vec![64, 59, 55, 50, 45, 40],
            program: 24,
            tuning_name: None,
        });
    }
    for track in 0..4 {
        for bar in 0..100 {
            project.edits.push(EditCommand::SetNote {
                target: BeatTarget {
                    track,
                    staff: 0,
                    bar,
                    voice: 0,
                    beat: 0,
                },
                string: 1,
                fret: (bar + track) % 12,
            });
        }
    }
    project.edits.push(EditCommand::SetBacking {
        backing: Some(BackingSettings {
            processing: None,
            reference_sync: None,
            asset_id: asset_id.clone(),
            offset_ms: 0.0,
            anchors: vec![],
            mix: ChannelMix::default(),
        }),
    });
    project.assets.insert(asset_id, asset);
    project
}
fn add(runtime: &SessionRuntime, audio: &NativeAudio, jobs: &ExportJobs, project: Project) {
    let workspace = runtime.workspace();
    let staged = workspace
        .lock()
        .unwrap()
        .stage_document(project, None)
        .unwrap();
    crate::transition_workspace(audio, jobs, &workspace, |state| {
        state.add_document(&staged.token)
    })
    .unwrap();
}
fn edit_active(runtime: &SessionRuntime) {
    let workspace = runtime.workspace();
    let mut state = workspace.lock().unwrap();
    let id = state.active_owner().document_id.clone();
    let address = DocumentRevision {
        revision: state.document(&id).unwrap().revision,
        document_id: id,
    };
    state
        .apply_edit(&address, EditCommand::AppendMeasure, None)
        .unwrap();
    drop(state);
    runtime.changed();
}

#[test]
#[ignore = "manual native budget acceptance: 3-minute stereo asset and real serializer"]
fn authored_large_capture_serialization_and_single_writer() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SessionRuntime::open(directory.path().into(), Arc::new(|_| {})).unwrap();
    let audio = NativeAudio::new(PathBuf::new(), Arc::new(|_| {}));
    let jobs = ExportJobs::default();
    runtime.resolve(None, vec![], &audio, &jobs).unwrap();
    add(&runtime, &audio, &jobs, authored_project());
    let workspace = runtime.workspace();
    let started = Instant::now();
    let first = capture(&workspace).unwrap();
    let capture_elapsed = started.elapsed();
    let second = capture(&workspace).unwrap();
    let asset = first.0[1].session.project.assets.values().next().unwrap();
    assert!(Arc::ptr_eq(
        &asset.bytes_base64,
        &second.0[1]
            .session
            .project
            .assets
            .values()
            .next()
            .unwrap()
            .bytes_base64
    ));
    assert_eq!(asset.info().unwrap().byte_length, 34_560_044);
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    struct LatchedSink {
        entered: Option<std::sync::mpsc::Sender<()>>,
        resume: std::sync::mpsc::Receiver<()>,
        bytes: u64,
    }
    impl Write for LatchedSink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Some(entered) = self.entered.take() {
                entered.send(()).unwrap();
                self.resume.recv().unwrap();
            }
            self.bytes += bytes.len() as u64;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let serializer = thread::spawn(move || {
        let envelope = RecoveryEnvelope {
            format: "TabPlayerRecovery".into(),
            version: 1,
            epoch: 1,
            generation: 1,
            captured_at_unix_ms: 1,
            active_document_id: first.1,
            documents: first.0,
        };
        let mut sink = LatchedSink {
            entered: Some(entered),
            resume,
            bytes: 0,
        };
        let started = Instant::now();
        encode_checkpoint(&mut sink, &envelope).unwrap();
        (sink.bytes, started.elapsed())
    });
    waiting.recv_timeout(Duration::from_secs(180)).unwrap();
    assert!(workspace.try_lock().is_ok());
    assert!(audio.access.try_lock().is_ok());
    let owner = workspace.lock().unwrap().active_owner().clone();
    let started = Instant::now();
    audio
        .command(
            &workspace,
            &owner,
            TransportCommand::Invalidate { generation: 100 },
        )
        .unwrap();
    let invalidate_elapsed = started.elapsed();
    release.send(()).unwrap();
    let (encoded_bytes, serialization_elapsed) = serializer.join().unwrap();
    let initial_generation = runtime.status().generation.unwrap();
    let store_latch = runtime.inner.store.lock().unwrap();
    runtime.retry().unwrap();
    wait_for(|| runtime.status().state == RecoveryState::Writing);
    for _ in 0..3 {
        runtime.retry().unwrap();
    }
    edit_active(&runtime);
    assert!(runtime.inner.state.lock().unwrap().writing);
    audio
        .command(
            &workspace,
            &owner,
            TransportCommand::Invalidate { generation: 200 },
        )
        .unwrap();
    drop(store_latch);
    wait_for(|| {
        runtime.status().state == RecoveryState::Ready
            && runtime.status().generation == Some(initial_generation + 2)
    });
    runtime.inner.drain();
    let store = runtime.inner.store.lock().unwrap();
    let loaded = store.load().unwrap().unwrap();
    assert_eq!(
        loaded.recovery.envelope.documents,
        capture(&workspace).unwrap().0
    );
    eprintln!(
        "large fixture: backing=34560044 bytes, encoded={encoded_bytes}; capture={capture_elapsed:?}; serializer including latch={serialization_elapsed:?}; Invalidate while serialization latched={invalidate_elapsed:?}; exactly two sequential commits for first capture and latest mutation/retries"
    );
}

#[test]
#[ignore = "manual native budget acceptance: reaches real 512 MiB streaming/disk bound"]
fn real_oversize_failure_retains_live_state_and_discard_commits_clean() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = SessionRuntime::open(directory.path().into(), Arc::new(|_| {})).unwrap();
    let audio = NativeAudio::new(PathBuf::new(), Arc::new(|_| {}));
    let jobs = ExportJobs::default();
    runtime.resolve(None, vec![], &audio, &jobs).unwrap();
    let acknowledged = runtime.status();
    let manifest_path = directory.path().join("recovery-v1/manifest.json");
    let manifest = std::fs::read(&manifest_path).unwrap();
    let project = authored_project();
    let encoded_asset = project.assets.values().next().unwrap().bytes_base64.clone();
    let lower_bound = encoded_asset.len() as u64 * 12;
    assert!(lower_bound > MAX_CHECKPOINT_BYTES);
    for _ in 0..12 {
        add(&runtime, &audio, &jobs, project.clone());
    }
    let workspace = runtime.workspace();
    // Make every never-saved blank dirty, including the original startup blank.
    {
        let mut state = workspace.lock().unwrap();
        for document in state.snapshot().documents {
            state
                .apply_edit(
                    &DocumentRevision {
                        document_id: document.document_id,
                        revision: document.revision,
                    },
                    EditCommand::AppendMeasure,
                    None,
                )
                .unwrap();
        }
    }
    for document in capture(&workspace).unwrap().0.iter().skip(1) {
        assert!(Arc::ptr_eq(
            &encoded_asset,
            &document
                .session
                .project
                .assets
                .values()
                .next()
                .unwrap()
                .bytes_base64
        ));
    }
    let started = Instant::now();
    runtime.retry().unwrap();
    wait_for(|| runtime.status().state == RecoveryState::Failed);
    runtime.inner.drain();
    let failed = runtime.status();
    assert!(failed.error.as_deref().unwrap().contains("exceeds 512 MiB"));
    assert_eq!(failed.generation, acknowledged.generation);
    assert_eq!(failed.captured_at_unix_ms, acknowledged.captured_at_unix_ms);
    assert_eq!(std::fs::read(&manifest_path).unwrap(), manifest);
    let failure_elapsed = started.elapsed();
    {
        let mut state = workspace.lock().unwrap();
        let before = state.snapshot();
        let document = before.documents.last().unwrap();
        // An existing directory is not a valid ordinary Save destination.
        assert!(
            state
                .save_to_path(
                    &DocumentRevision {
                        document_id: document.document_id.clone(),
                        revision: document.revision
                    },
                    directory.path().into()
                )
                .is_err()
        );
        assert_eq!(state.snapshot(), before);
    }
    edit_active(&runtime);
    assert!(!workspace.lock().unwrap().is_frozen());
    let closes = workspace
        .lock()
        .unwrap()
        .snapshot()
        .documents
        .into_iter()
        .map(|document| CloseDocument {
            document_id: document.document_id,
            revision: document.revision,
            discard: true,
        })
        .collect();
    runtime.shutdown(closes, &audio, &jobs).unwrap();
    let store = runtime.inner.store.lock().unwrap();
    let clean = store.load().unwrap().unwrap();
    assert_eq!(clean.manifest.lifecycle, SessionLifecycle::Clean);
    assert!(clean.recovery.envelope.documents.is_empty());
    assert!(clean.manifest.previous.is_none());
    assert_eq!(workspace.lock().unwrap().snapshot().documents.len(), 13);
    eprintln!(
        "oversize fixture: 12 shared assets, encoded payload lower bound={lower_bound} > cap={MAX_CHECKPOINT_BYTES}; actual store failure after {failure_elapsed:?}; old acknowledgement {:?}/{:?} retained; dirty discard committed empty Clean generation {}",
        acknowledged.generation,
        acknowledged.captured_at_unix_ms,
        clean.manifest.current.generation
    );
}

#[test]
#[ignore = "manual native acceptance: oversized checkpoint, thirteen real saves, preferences-off exit"]
fn real_oversize_successful_saves_and_preferences_off_commit_empty_clean() {
    use sha2::{Digest, Sha256};
    let directory = tempfile::tempdir().unwrap();
    let runtime = SessionRuntime::open(directory.path().into(), Arc::new(|_| {})).unwrap();
    let audio = NativeAudio::new(PathBuf::new(), Arc::new(|_| {}));
    let jobs = ExportJobs::default();
    runtime.resolve(None, vec![], &audio, &jobs).unwrap();
    let acknowledged = runtime.status();
    let manifest_path = directory.path().join("recovery-v1/manifest.json");
    let manifest = std::fs::read(&manifest_path).unwrap();
    let original_manifest: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    let project = authored_project();
    let encoded_asset = project.assets.values().next().unwrap().bytes_base64.clone();
    let lower_bound = encoded_asset.len() as u64 * 12;
    assert!(lower_bound > MAX_CHECKPOINT_BYTES);
    for _ in 0..12 {
        add(&runtime, &audio, &jobs, project.clone());
    }
    let workspace = runtime.workspace();
    {
        let mut state = workspace.lock().unwrap();
        for document in state.snapshot().documents {
            state
                .apply_edit(
                    &DocumentRevision {
                        document_id: document.document_id,
                        revision: document.revision,
                    },
                    EditCommand::AppendMeasure,
                    None,
                )
                .unwrap();
        }
    }
    let before = capture(&workspace).unwrap();
    for document in before.0.iter().skip(1) {
        assert!(Arc::ptr_eq(
            &encoded_asset,
            &document
                .session
                .project
                .assets
                .values()
                .next()
                .unwrap()
                .bytes_base64
        ));
    }
    let started = Instant::now();
    runtime.retry().unwrap();
    wait_for(|| runtime.status().state == RecoveryState::Failed);
    runtime.inner.drain();
    let failed = runtime.status();
    assert!(failed.error.as_deref().unwrap().contains("exceeds 512 MiB"));
    assert_eq!(failed.generation, acknowledged.generation);
    assert_eq!(failed.captured_at_unix_ms, acknowledged.captured_at_unix_ms);
    assert_eq!(std::fs::read(&manifest_path).unwrap(), manifest);
    assert_eq!(capture(&workspace).unwrap(), before);
    assert!(!workspace.lock().unwrap().is_frozen());
    let failed_after = started.elapsed();
    let mut saved_files = Vec::new();
    let save_started = Instant::now();
    for (index, document) in before.0.iter().enumerate() {
        let path = directory.path().join(format!("saved-{index}.tabplayer"));
        let saved = workspace
            .lock()
            .unwrap()
            .save_to_path(
                &DocumentRevision {
                    document_id: document.document_id.clone(),
                    revision: document.revision,
                },
                path.clone(),
            )
            .unwrap();
        assert!(!saved.snapshot.dirty);
        assert_eq!(saved.snapshot.path.as_deref(), Some(path.to_str().unwrap()));
        let (reopened, digest) = crate::files::read_project_with_digest(&path).unwrap();
        // This fixture has no redo: every applied command and backing byte must reopen.
        assert_eq!(
            document.session.cursor,
            document.session.project.edits.len()
        );
        assert_eq!(reopened, document.session.project);
        let reopened_session = ProjectSession::new(reopened, Some(path.clone())).unwrap();
        assert_eq!(reopened_session.snapshot(), saved.snapshot);
        saved_files.push((path, digest));
    }
    let saved_after = save_started.elapsed();
    let saved_live = capture(&workspace).unwrap();
    for (old, saved) in before.0.iter().zip(&saved_live.0) {
        assert_eq!(saved.session.project, old.session.project);
        assert_eq!(saved.session.cursor, old.session.cursor);
        assert_eq!(saved.session.saved, old.session.project.edits);
        assert!(saved.session.path.is_some());
    }
    assert!(
        !runtime
            .set_preferences(false)
            .unwrap()
            .restore_previous_session
    );
    assert!(
        !runtime
            .inner
            .store
            .lock()
            .unwrap()
            .read_preferences()
            .unwrap()
            .restore_previous_session
    );
    let closes = workspace
        .lock()
        .unwrap()
        .snapshot()
        .documents
        .into_iter()
        .map(|document| {
            assert!(!document.snapshot.dirty);
            CloseDocument {
                document_id: document.document_id,
                revision: document.revision,
                discard: false,
            }
        })
        .collect();
    runtime.shutdown(closes, &audio, &jobs).unwrap();
    let store = runtime.inner.store.lock().unwrap();
    let clean = store.load().unwrap().unwrap();
    assert_eq!(clean.manifest.lifecycle, SessionLifecycle::Clean);
    assert!(clean.manifest.epoch > original_manifest["epoch"].as_u64().unwrap());
    assert!(clean.manifest.previous.is_none());
    assert!(clean.recovery.envelope.documents.is_empty());
    assert_eq!(capture(&workspace).unwrap(), saved_live);
    assert!(workspace.lock().unwrap().is_frozen());
    for (path, digest) in &saved_files {
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
            *digest
        );
    }
    eprintln!(
        "oversize successful-save exit: encoded lower bound={lower_bound}, actual cap failure after {failed_after:?}; prior acknowledgement {:?}/{:?} retained; {} ordinary schema2 saves/reopens/history+path+clean assertions in {saved_after:?}; native preferences false persisted; empty Clean epoch {} generation {} with no fallback; all saved file hashes and live histories unchanged by shutdown",
        acknowledged.generation,
        acknowledged.captured_at_unix_ms,
        saved_files.len(),
        clean.manifest.epoch,
        clean.manifest.current.generation
    );
}
