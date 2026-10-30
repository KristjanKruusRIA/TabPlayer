use super::*;
use crate::{
    project::{BeatTarget, EditCommand, Project},
    workspace::DocumentRevision,
};

fn audio() -> NativeAudio {
    NativeAudio::new(PathBuf::new(), Arc::new(|_| {}))
}
fn open(path: &std::path::Path) -> SessionRuntime {
    SessionRuntime::open(path.to_path_buf(), Arc::new(|_| {})).unwrap()
}
fn resolve(runtime: &SessionRuntime, audio: &NativeAudio, jobs: &ExportJobs) -> SessionResolution {
    runtime.resolve(None, vec![], audio, jobs).unwrap()
}
fn address(workspace: &DocumentWorkspace, id: &str) -> DocumentRevision {
    DocumentRevision {
        document_id: id.into(),
        revision: workspace.document(id).unwrap().revision,
    }
}
fn edit(runtime: &SessionRuntime, fret: u32) {
    let workspace = runtime.workspace();
    let mut state = workspace.lock().unwrap();
    let id = state.active_owner().document_id.clone();
    let address = address(&state, &id);
    state
        .apply_edit(
            &address,
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
            },
            None,
        )
        .unwrap();
    drop(state);
    runtime.changed();
}
fn closes(runtime: &SessionRuntime) -> Vec<CloseDocument> {
    runtime
        .workspace()
        .lock()
        .unwrap()
        .snapshot()
        .documents
        .into_iter()
        .map(|record| CloseDocument {
            document_id: record.document_id,
            revision: record.revision,
            discard: true,
        })
        .collect()
}

#[test]
fn reloaded_webview_attaches_to_the_live_session_without_resolving_startup() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    assert!(!runtime.startup().resumed);
    assert!(runtime.attach().is_err());
    let first = resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    let startup = runtime.startup();
    assert!(startup.resumed);
    assert!(startup.preview.is_none());
    let attached = runtime.attach().unwrap();
    assert_eq!(attached.workspace.documents.len(), 1);
    assert_eq!(attached.workspace.active, first.workspace.active);
    let id = attached.workspace.active.document_id.clone();
    assert!(attached.views.contains_key(&id));
    assert!(attached.workspace.documents[0].snapshot.dirty);
    // Reloading again is harmless, and startup itself still resolves only once.
    assert_eq!(runtime.attach().unwrap(), attached);
    assert!(runtime.resolve(None, vec![], &audio, &jobs).is_err());
}

#[test]
fn genuine_recovery_prompt_is_not_resumed_or_skipped_by_reload() {
    let directory = tempfile::tempdir().unwrap();
    let audio = audio();
    let jobs = ExportJobs::default();
    let runtime = open(directory.path());
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 5);
    runtime.changed();
    checkpoint(&runtime);
    drop(runtime);
    let recovered = open(directory.path());
    let first = recovered.startup();
    assert!(!first.resumed);
    let preview = first.preview.clone().unwrap();
    // A reload while the prompt is open sees the same prompt and cannot attach.
    assert_eq!(recovered.startup().preview.unwrap().token, preview.token);
    assert!(!recovered.startup().resumed);
    assert!(recovered.attach().is_err());
}

#[test]
fn startup_resolve_is_atomic_and_single_use() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    assert!(runtime.workspace().lock().unwrap().is_frozen());
    assert!(!directory.path().join("recovery-v1/manifest.json").exists());
    assert!(SessionRuntime::open(directory.path().into(), Arc::new(|_| {})).is_err());
    assert!(
        runtime
            .resolve(Some("foreign".into()), vec![], &audio, &jobs)
            .is_err()
    );
    let result = resolve(&runtime, &audio, &jobs);
    assert!(!runtime.workspace().lock().unwrap().is_frozen());
    assert_eq!(result.workspace.documents.len(), 1);
    assert!(runtime.resolve(None, vec![], &audio, &jobs).is_err());
    {
        let workspace = runtime.workspace();
        let candidate = workspace
            .lock()
            .unwrap()
            .stage_document(Project::blank(), None)
            .unwrap();
        crate::transition_workspace(&audio, &jobs, &workspace, |state| {
            state.add_document(&candidate.token)
        })
        .unwrap();
    }
    runtime.changed();
    checkpoint(&runtime);
    let old_owner = runtime.workspace().lock().unwrap().active_owner().clone();
    drop(runtime);
    let recovered = open(directory.path());
    let preview = recovered.startup().preview.unwrap();
    assert_eq!(preview.reason, RecoveryReason::Crash);
    let ids = preview
        .documents
        .iter()
        .map(|d| d.document_id.clone())
        .collect::<Vec<_>>();
    assert!(
        recovered
            .resolve(
                Some(preview.token.clone()),
                vec![ids[0].clone(), ids[0].clone()],
                &audio,
                &jobs
            )
            .is_err()
    );
    assert!(
        recovered
            .resolve(
                Some(preview.token.clone()),
                ids.iter().rev().cloned().collect(),
                &audio,
                &jobs
            )
            .is_err()
    );
    assert!(
        recovered
            .resolve(
                Some(preview.token.clone()),
                vec!["foreign-document".into()],
                &audio,
                &jobs
            )
            .is_err()
    );
    let restored = recovered
        .resolve(Some(preview.token.clone()), ids.clone(), &audio, &jobs)
        .unwrap();
    assert_eq!(restored.workspace.active.document_id, old_owner.document_id);
    assert_ne!(
        restored.workspace.active.activation_id,
        old_owner.activation_id
    );
    assert!(
        recovered
            .resolve(Some(preview.token), ids, &audio, &jobs)
            .is_err()
    );
}

#[test]
fn clean_shutdown_records_intended_session_and_resume_retains_live_redo() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    edit(&runtime, 9);
    let workspace = runtime.workspace();
    {
        let mut state = workspace.lock().unwrap();
        let id = state.active_owner().document_id.clone();
        let address = address(&state, &id);
        state.undo(&address).unwrap();
    }
    let before = workspace.lock().unwrap().recovery_documents().unwrap();
    assert!(runtime.shutdown(vec![], &audio, &jobs).is_err());
    assert!(!workspace.lock().unwrap().is_frozen());
    runtime.shutdown(closes(&runtime), &audio, &jobs).unwrap();
    assert!(workspace.lock().unwrap().is_frozen());
    assert_eq!(
        runtime
            .inner
            .store
            .lock()
            .unwrap()
            .load()
            .unwrap()
            .unwrap()
            .manifest
            .lifecycle,
        SessionLifecycle::Clean
    );
    assert!(
        runtime
            .inner
            .store
            .lock()
            .unwrap()
            .load()
            .unwrap()
            .unwrap()
            .recovery
            .envelope
            .documents
            .is_empty()
    );
    assert_eq!(
        workspace.lock().unwrap().recovery_documents().unwrap(),
        before
    );
    runtime.resume(&audio, &jobs).unwrap();
    assert!(!workspace.lock().unwrap().is_frozen());
    let loaded = runtime.inner.store.lock().unwrap().load().unwrap().unwrap();
    assert_eq!(loaded.manifest.lifecycle, SessionLifecycle::Running);
    assert_eq!(loaded.recovery.envelope.documents, before);
    assert!(loaded.manifest.previous.is_none());
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "synchronization deadline");
        thread::yield_now();
    }
}

#[test]
fn latched_old_checkpoint_cannot_publish_after_retirement() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Arc::new(open(directory.path()));
    let audio = Arc::new(audio());
    let jobs = Arc::new(ExportJobs::default());
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    let workspace = runtime.workspace();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let store_latch = runtime.inner.store.lock().unwrap();
    runtime.retry().unwrap();
    wait_until(|| runtime.status().state == RecoveryState::Writing);
    let pending = closes(&runtime);
    let (done, completion) = std::sync::mpsc::channel();
    let closer = {
        let (runtime, audio, jobs) = (runtime.clone(), audio.clone(), jobs.clone());
        thread::spawn(move || done.send(runtime.close(pending, &audio, &jobs)).unwrap())
    };
    wait_until(|| workspace.lock().unwrap().is_frozen());
    // Frozen admission covers mutations and even a picker result returning now.
    {
        let mut state = workspace.lock().unwrap();
        assert!(state.stage_document(Project::blank(), None).is_err());
        assert!(
            state
                .set_view(&owner.document_id, DocumentViewState::default())
                .is_err()
        );
        let address = address(&state, &owner.document_id);
        assert!(crate::validate_export_origin(&state, &address).is_err());
    }
    let (ack, acknowledged) = std::sync::mpsc::channel();
    let transport = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            // Actual production ownership method; ordinary Pause/Stop reach the
            // existing unprepared service error without waiting on the store latch.
            let invalidate = audio.command(
                &workspace,
                &owner,
                TransportCommand::Invalidate { generation: 100 },
            );
            let pause = audio.command(
                &workspace,
                &owner,
                TransportCommand::Pause { generation: 100 },
            );
            let stop = audio.command(
                &workspace,
                &owner,
                TransportCommand::Stop { generation: 100 },
            );
            ack.send((invalidate, pause, stop)).unwrap();
        })
    };
    let ack_result = acknowledged.recv_timeout(Duration::from_secs(5));
    let early = completion.try_recv();
    drop(store_latch);
    let (invalidate, pause, stop) = ack_result.unwrap();
    assert!(invalidate.is_ok());
    assert!(pause.unwrap_err().contains("Prepare"));
    assert!(stop.unwrap_err().contains("Prepare"));
    assert!(early.is_err());
    let result = completion
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    closer.join().unwrap();
    transport.join().unwrap();
    assert_ne!(result.active, owner);
    assert_eq!(audio.service.status().desired_generation, 101);
    let loaded = runtime.inner.store.lock().unwrap().load().unwrap().unwrap();
    assert!(loaded.manifest.previous.is_none());
    assert_eq!(
        loaded.recovery.envelope.documents[0].document_id,
        result.active.document_id
    );
    assert!(
        loaded
            .recovery
            .envelope
            .documents
            .iter()
            .all(|d| d.document_id != owner.document_id)
    );
    assert!(
        audio
            .command(
                &workspace,
                &owner,
                TransportCommand::Invalidate {
                    generation: u64::MAX
                }
            )
            .is_err()
    );
}

#[test]
fn committed_retirement_at_generation_max_publishes_without_wrap() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Arc::new(open(directory.path()));
    let audio = Arc::new(audio());
    let jobs = Arc::new(ExportJobs::default());
    resolve(&runtime, &audio, &jobs);
    let owner = runtime.workspace().lock().unwrap().active_owner().clone();
    let store_latch = runtime.inner.store.lock().unwrap();
    let pending = closes(&runtime);
    let closer = {
        let (runtime, audio, jobs) = (runtime.clone(), audio.clone(), jobs.clone());
        thread::spawn(move || runtime.close(pending, &audio, &jobs))
    };
    wait_until(|| runtime.workspace().lock().unwrap().is_frozen());
    audio
        .command(
            &runtime.workspace(),
            &owner,
            TransportCommand::Invalidate {
                generation: u64::MAX,
            },
        )
        .unwrap();
    drop(store_latch);
    let snapshot = closer.join().unwrap().unwrap();
    assert_ne!(snapshot.active, owner);
    assert_eq!(audio.service.status().desired_generation, u64::MAX);
    assert!(
        audio
            .command(
                &runtime.workspace(),
                &owner,
                TransportCommand::Invalidate {
                    generation: u64::MAX
                }
            )
            .is_err()
    );
    let plan=serde_json::from_value(serde_json::json!({"generation":u64::MAX,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[],"tempos":[{"tick":0,"bpm":120}],"occurrences":[],"notes":[],"midi":[]})).unwrap();
    assert!(
        audio
            .prepare(
                &runtime.workspace(),
                &owner,
                plan,
                crate::settings::DocumentSettings::default(),
                None,
                "stale".into(),
                None
            )
            .unwrap_err()
            .contains("owner")
    );
    assert_eq!(audio.service.status().desired_generation, u64::MAX);
    let loaded = runtime.inner.store.lock().unwrap().load().unwrap().unwrap();
    assert_eq!(
        loaded.recovery.envelope.active_document_id,
        Some(snapshot.active.document_id)
    );
}

#[test]
fn retirement_write_failure_keeps_live_history_owner_and_candidates() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    let workspace = runtime.workspace();
    let candidate = workspace
        .lock()
        .unwrap()
        .stage_document(Project::blank(), None)
        .unwrap();
    let before = workspace.lock().unwrap().snapshot();
    // A directory at the exact manifest target makes retirement fail without
    // injecting a test-only store behavior or touching the saved user files.
    let root = directory.path().join("recovery-v1");
    let manifest = root.join("manifest.json");
    let saved = std::fs::read(&manifest).unwrap();
    std::fs::remove_file(&manifest).unwrap();
    std::fs::create_dir(&manifest).unwrap();
    assert!(runtime.close(closes(&runtime), &audio, &jobs).is_err());
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    assert!(!workspace.lock().unwrap().is_frozen());
    assert!(workspace.lock().unwrap().cancel_document(&candidate.token));
    std::fs::remove_dir(&manifest).unwrap();
    std::fs::write(&manifest, saved).unwrap();
}

#[test]
fn large_backing_capture_shares_payload_and_releases_workspace() {
    use crate::{
        assets::StoredAsset,
        settings::{BackingSettings, ChannelMix},
    };
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    let workspace = runtime.workspace();
    let bytes = vec![17; 8 * 1024 * 1024];
    let owner = workspace.lock().unwrap().active_owner().clone();
    {
        let mut state = workspace.lock().unwrap();
        let staged = state
            .stage_asset(
                &owner.document_id,
                StoredAsset::from_bytes("authored-large.wav".into(), "audio/wav".into(), &bytes),
            )
            .unwrap();
        let address = address(&state, &owner.document_id);
        state
            .apply_edit(
                &address,
                EditCommand::SetBacking {
                    backing: Some(BackingSettings {
                        processing: None,
                        reference_sync: None,
                        asset_id: staged.asset_id,
                        offset_ms: 0.0,
                        anchors: vec![],
                        mix: ChannelMix::default(),
                    }),
                },
                Some(&staged.token),
            )
            .unwrap();
    }
    let started = Instant::now();
    let first = capture(&workspace).unwrap();
    let elapsed = started.elapsed();
    let second = capture(&workspace).unwrap();
    let a = &first.0[0]
        .session
        .project
        .assets
        .values()
        .next()
        .unwrap()
        .bytes_base64;
    let b = &second.0[0]
        .session
        .project
        .assets
        .values()
        .next()
        .unwrap()
        .bytes_base64;
    assert!(Arc::ptr_eq(a, b));
    eprintln!("8 MiB backing capture critical section: {elapsed:?}");
    let store_latch = runtime.inner.store.lock().unwrap();
    runtime.retry().unwrap();
    wait_until(|| runtime.status().state == RecoveryState::Writing);
    audio
        .command(
            &workspace,
            &owner,
            TransportCommand::Invalidate { generation: 100 },
        )
        .unwrap();
    assert_eq!(audio.service.status().desired_generation, 100);
    drop(store_latch);
    wait_until(|| !runtime.inner.state.lock().unwrap().writing);
}

#[test]
fn native_session_directory_is_explicit_only_in_diagnostic_mode() {
    let directory = tempfile::tempdir().unwrap();
    let production = directory.path().join("production");
    assert_eq!(
        choose_session_directory(production.clone(), false, Some("relative".into())).unwrap(),
        production
    );
    assert!(choose_session_directory(production.clone(), true, None).is_err());
    assert!(choose_session_directory(production.clone(), true, Some("relative".into())).is_err());
    let isolated = directory.path().join("isolated");
    assert_eq!(
        choose_session_directory(production, true, Some(isolated.clone())).unwrap(),
        isolated
    );
}

fn checkpoint(runtime: &SessionRuntime) {
    let generation = runtime.status().generation.unwrap_or(0);
    runtime.retry().unwrap();
    wait_until(|| {
        let status = runtime.status();
        status.state == RecoveryState::Ready && status.generation.is_some_and(|v| v > generation)
    });
    wait_until(|| !runtime.inner.state.lock().unwrap().writing);
}
#[test]
fn startup_reconciles_changed_saved_path_again_after_preview() {
    let directory = tempfile::tempdir().unwrap();
    let audio = audio();
    let jobs = ExportJobs::default();
    let runtime = open(directory.path());
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    let path = directory.path().join("authored.tabplayer");
    {
        let workspace = runtime.workspace();
        let mut state = workspace.lock().unwrap();
        let id = state.active_owner().document_id.clone();
        let address = address(&state, &id);
        state.save_to_path(&address, path.clone()).unwrap();
    }
    runtime.changed();
    checkpoint(&runtime);
    drop(runtime);
    let runtime = open(directory.path());
    let preview = runtime.startup().preview.unwrap();
    assert!(preview.documents[0].snapshot.path.is_some());
    std::fs::write(&path, b"externally replaced after preview").unwrap();
    let result = runtime
        .resolve(
            Some(preview.token),
            preview
                .documents
                .iter()
                .map(|d| d.document_id.clone())
                .collect(),
            &audio,
            &jobs,
        )
        .unwrap();
    assert!(result.workspace.documents[0].snapshot.path.is_none());
    assert!(
        result
            .issues
            .iter()
            .any(|issue| issue.message.contains("Save As"))
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"externally replaced after preview"
    );
}

#[test]
fn clean_discard_retains_pathless_blank_template_baseline_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    let mut value = serde_json::to_value(Project::blank()).unwrap();
    value["schemaVersion"] = serde_json::json!(3);
    value["baselineEdits"] = serde_json::json!([{"type":"appendMeasure"}]);
    let template: Project = serde_json::from_value(value).unwrap();
    let workspace = runtime.workspace();
    let candidate = workspace
        .lock()
        .unwrap()
        .stage_document(template.clone(), None)
        .unwrap();
    crate::transition_workspace(&audio, &jobs, &workspace, |state| {
        state.add_document(&candidate.token)
    })
    .unwrap();
    let id = workspace.lock().unwrap().active_owner().document_id.clone();
    edit(&runtime, 7);
    runtime.shutdown(closes(&runtime), &audio, &jobs).unwrap();
    drop(runtime);
    let restarted = open(directory.path());
    let preview = restarted.startup().preview.unwrap();
    assert_eq!(preview.reason, RecoveryReason::Clean);
    let recovered = preview
        .documents
        .iter()
        .find(|record| record.document_id == id)
        .unwrap();
    assert_eq!(recovered.snapshot.project, template.view());
    assert!(!recovered.snapshot.dirty);
    assert!(!recovered.snapshot.can_undo);
    assert!(!recovered.snapshot.can_redo);
    assert!(recovered.snapshot.path.is_none());
}

#[test]
fn clean_projection_preserves_saved_branch_imported_baseline_and_order() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    let workspace = runtime.workspace();
    let native_id = workspace.lock().unwrap().active_owner().document_id.clone();
    {
        let mut state = workspace.lock().unwrap();
        let address = address(&state, &native_id);
        state
            .save_to_path(&address, directory.path().join("authored.tabplayer"))
            .unwrap();
    }
    edit(&runtime, 9);
    let saved = workspace.lock().unwrap().recovery_documents().unwrap()[0]
        .session
        .saved
        .clone();
    let candidate = workspace
        .lock()
        .unwrap()
        .stage_document(
            Project::from_file("authored.gp".into(), b"authored imported bytes"),
            None,
        )
        .unwrap();
    crate::transition_workspace(&audio, &jobs, &workspace, |state| {
        state.add_document(&candidate.token)
    })
    .unwrap();
    let imported_id = workspace.lock().unwrap().active_owner().document_id.clone();
    edit(&runtime, 4);
    let blank = workspace
        .lock()
        .unwrap()
        .stage_document(Project::blank(), None)
        .unwrap();
    crate::transition_workspace(&audio, &jobs, &workspace, |state| {
        state.add_document(&blank.token)
    })
    .unwrap();
    edit(&runtime, 5);
    let defaults = crate::project::NewScoreDefaults {
        tab: "Cy".into(),
        ..Default::default()
    };
    let authored_blank = workspace
        .lock()
        .unwrap()
        .stage_document(Project::blank_with_defaults(&defaults).unwrap(), None)
        .unwrap();
    crate::transition_workspace(&audio, &jobs, &workspace, |state| {
        state.add_document(&authored_blank.token)
    })
    .unwrap();
    edit(&runtime, 6);
    let before = workspace.lock().unwrap().recovery_documents().unwrap();
    let pending = closes(&runtime);
    let mut stale = pending.clone();
    stale[0].revision -= 1;
    assert!(runtime.shutdown(stale, &audio, &jobs).is_err());
    runtime.shutdown(pending, &audio, &jobs).unwrap();
    let loaded = runtime.inner.store.lock().unwrap().load().unwrap().unwrap();
    assert_eq!(
        loaded
            .recovery
            .envelope
            .documents
            .iter()
            .map(|d| d.document_id.as_str())
            .collect::<Vec<_>>(),
        vec![native_id.as_str(), imported_id.as_str()]
    );
    assert_eq!(
        loaded.recovery.envelope.active_document_id,
        Some(imported_id)
    );
    assert_eq!(
        loaded.recovery.envelope.documents[0].session.project.edits,
        saved
    );
    assert!(
        loaded.recovery.envelope.documents[1]
            .session
            .project
            .edits
            .is_empty()
    );
    assert!(matches!(
        loaded.recovery.envelope.documents[1].session.project.base,
        BaseDocument::File { .. }
    ));
    assert_eq!(
        workspace.lock().unwrap().recovery_documents().unwrap(),
        before
    );
    runtime.resume(&audio, &jobs).unwrap();
    assert_eq!(
        runtime
            .inner
            .store
            .lock()
            .unwrap()
            .load()
            .unwrap()
            .unwrap()
            .recovery
            .envelope
            .documents,
        before
    );
}

#[test]
fn preference_failure_keeps_value_and_preference_off_commits_empty_clean() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    let path = directory.path().join("session-preferences.json");
    std::fs::create_dir(&path).unwrap();
    assert!(runtime.set_preferences(false).is_err());
    assert!(runtime.startup().preferences.restore_previous_session);
    std::fs::remove_dir(&path).unwrap();
    runtime.set_preferences(false).unwrap();
    edit(&runtime, 7);
    runtime.shutdown(closes(&runtime), &audio, &jobs).unwrap();
    let loaded = runtime.inner.store.lock().unwrap().load().unwrap().unwrap();
    assert!(loaded.recovery.envelope.documents.is_empty());
    assert_eq!(loaded.manifest.lifecycle, SessionLifecycle::Clean);
    drop(runtime);
    let restarted = open(directory.path());
    assert!(!restarted.startup().preferences.restore_previous_session);
    let preview = restarted.startup().preview.unwrap();
    assert_eq!(preview.reason, RecoveryReason::Clean);
    restarted
        .resolve(Some(preview.token), vec![], &audio, &jobs)
        .unwrap();
    assert_eq!(
        restarted
            .workspace()
            .lock()
            .unwrap()
            .snapshot()
            .documents
            .len(),
        1
    );
}

#[test]
fn newer_revision_during_one_writer_is_retained_for_next_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    let old_generation = runtime.status().generation.unwrap();
    let store_latch = runtime.inner.store.lock().unwrap();
    runtime.retry().unwrap();
    wait_until(|| runtime.status().state == RecoveryState::Writing);
    edit(&runtime, 9);
    assert!(runtime.inner.state.lock().unwrap().writing);
    drop(store_latch);
    wait_until(|| !runtime.inner.state.lock().unwrap().writing);
    assert_eq!(runtime.status().state, RecoveryState::Pending);
    let loaded = runtime.inner.store.lock().unwrap().load().unwrap().unwrap();
    assert_eq!(
        loaded.recovery.envelope.documents[0]
            .session
            .project
            .edits
            .len(),
        1
    );
    assert!(loaded.manifest.current.generation > old_generation);
    checkpoint(&runtime);
    let loaded = runtime.inner.store.lock().unwrap().load().unwrap().unwrap();
    assert_eq!(
        loaded.recovery.envelope.documents[0]
            .session
            .project
            .edits
            .len(),
        2
    );
}

#[test]
fn frozen_export_admission_is_native() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    {
        let workspace = runtime.workspace();
        let state = workspace.lock().unwrap();
        let address = address(&state, &state.active_owner().document_id);
        assert!(crate::validate_export_origin(&state, &address).is_err());
    }
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    {
        let workspace = runtime.workspace();
        let state = workspace.lock().unwrap();
        let address = address(&state, &state.active_owner().document_id);
        assert!(crate::validate_export_origin(&state, &address).is_ok());
    }
}

fn silent_plan(generation: u64) -> crate::audio::plan::PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":generation,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[],"tempos":[{"tick":0,"bpm":120}],"occurrences":[],"notes":[],"midi":[]})).unwrap()
}
#[test]
fn clean_freeze_rejects_new_audio_work_but_keeps_owner_invalidate_pause_stop() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    runtime.shutdown(closes(&runtime), &audio, &jobs).unwrap();
    let workspace = runtime.workspace();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let generation = audio.service.status().desired_generation;
    assert!(
        audio
            .prepare(
                &workspace,
                &owner,
                silent_plan(generation + 1),
                crate::settings::DocumentSettings::default(),
                None,
                "frozen".into(),
                None
            )
            .unwrap_err()
            .contains("transition")
    );
    assert!(
        audio
            .set_mix(
                &workspace,
                &owner,
                crate::settings::DocumentSettings::default(),
                generation
            )
            .unwrap_err()
            .contains("transition")
    );
    // An audition is new audio work too: refused with the same transition error.
    let audition: crate::audio::audition::AuditionRequest =
        serde_json::from_value(serde_json::json!({
            "voice": crate::settings::TrackSound::default(),
            "program": 24,
            "percussion": false,
            "mix": {"gain": 1, "pan": 0, "mute": false, "solo": false},
            "notes": [{"key": 40, "startMs": 0, "velocity": 100}],
            "durationMs": 500,
        }))
        .unwrap();
    assert!(
        audio
            .audition(&workspace, &owner, audition)
            .unwrap_err()
            .contains("transition")
    );
    for command in [
        TransportCommand::Play { generation },
        TransportCommand::PlayRange {
            generation,
            start_tick: 0.0,
            end_tick: None,
        },
        TransportCommand::SeekTick {
            generation,
            tick: 0.0,
        },
        TransportCommand::SetPractice {
            generation,
            settings: crate::audio::device::PracticeSettings::default(),
        },
        TransportCommand::SetLoop {
            generation,
            start_tick: 0.0,
            end_tick: 960.0,
        },
        TransportCommand::ClearLoop { generation },
        TransportCommand::SelectDevice {
            generation,
            device_id: None,
        },
    ] {
        assert!(
            audio
                .command(&workspace, &owner, command)
                .unwrap_err()
                .contains("transition")
        );
    }
    assert!(
        audio
            .command(&workspace, &owner, TransportCommand::Pause { generation })
            .unwrap_err()
            .contains("Prepare")
    );
    assert!(
        audio
            .command(&workspace, &owner, TransportCommand::Stop { generation })
            .unwrap_err()
            .contains("Prepare")
    );
    audio
        .command(
            &workspace,
            &owner,
            TransportCommand::Invalidate {
                generation: generation + 10,
            },
        )
        .unwrap();
    assert_eq!(audio.service.status().desired_generation, generation + 10);
}
#[test]
fn terminal_generation_requires_restart_before_any_new_preparation() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    let workspace = runtime.workspace();
    let owner = workspace.lock().unwrap().active_owner().clone();
    assert!(
        audio
            .prepare(
                &workspace,
                &owner,
                silent_plan(u64::MAX),
                crate::settings::DocumentSettings::default(),
                None,
                "max".into(),
                None
            )
            .unwrap_err()
            .contains("restart")
    );
    assert_eq!(audio.service.status().desired_generation, 1);
    audio
        .command(
            &workspace,
            &owner,
            TransportCommand::Invalidate {
                generation: u64::MAX,
            },
        )
        .unwrap();
    assert!(
        audio
            .prepare(
                &workspace,
                &owner,
                silent_plan(100),
                crate::settings::DocumentSettings::default(),
                None,
                "max".into(),
                None
            )
            .unwrap_err()
            .contains("restart")
    );
    assert_eq!(audio.service.status().desired_generation, u64::MAX);
}

#[test]
fn corrupt_clean_documents_require_explicit_unavailable_resolution() {
    use sha2::{Digest, Sha256};
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    runtime.shutdown(closes(&runtime), &audio, &jobs).unwrap();
    drop(runtime);
    let root = directory.path().join("recovery-v1");
    let manifest_path = root.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    let payload = root.join(format!(
        "checkpoint-{}.json",
        manifest["current"]["generation"].as_u64().unwrap()
    ));
    let mut envelope: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&payload).unwrap()).unwrap();
    envelope["documents"][0]["session"]["cursor"] = serde_json::json!(999);
    let bytes = serde_json::to_vec(&envelope).unwrap();
    manifest["current"]["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(&bytes)));
    std::fs::write(&payload, &bytes).unwrap();
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let original = std::fs::read(&manifest_path).unwrap();
    let runtime = open(directory.path());
    let preview = runtime.startup().preview.unwrap();
    assert_eq!(preview.reason, RecoveryReason::Unavailable);
    assert!(preview.documents.is_empty());
    assert_eq!(std::fs::read(&manifest_path).unwrap(), original);
    runtime
        .resolve(Some(preview.token), vec![], &audio, &jobs)
        .unwrap();
    assert!(root.join("diagnostic/manifest.json").exists());
}

#[test]
fn change_during_completion_callback_keeps_pending_status() {
    let directory = tempfile::tempdir().unwrap();
    let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let resume = Mutex::new(resume);
    let callback_arm = armed.clone();
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let events = delivered.clone();
    let runtime = SessionRuntime::open(
        directory.path().into(),
        Arc::new(move |status| {
            if status.state == RecoveryState::Ready && callback_arm.swap(false, Ordering::AcqRel) {
                entered.send(()).unwrap();
                resume.lock().unwrap().recv().unwrap();
            }
            events.lock().unwrap().push(status);
        }),
    )
    .unwrap();
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    armed.store(true, Ordering::Release);
    runtime.retry().unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    edit(&runtime, 9);
    let status = runtime.status();
    release.send(()).unwrap();
    assert_eq!(status.state, RecoveryState::Pending);
    wait_until(|| !runtime.inner.state.lock().unwrap().writing);
    assert_eq!(
        delivered.lock().unwrap().last().unwrap().state,
        RecoveryState::Pending
    );
    checkpoint(&runtime);
    assert_eq!(
        runtime
            .inner
            .store
            .lock()
            .unwrap()
            .load()
            .unwrap()
            .unwrap()
            .recovery
            .envelope
            .documents[0]
            .session
            .project
            .edits
            .len(),
        2
    );
}

#[test]
fn retirement_rearms_scheduler_before_reopening_native_mutations() {
    let directory = tempfile::tempdir().unwrap();
    let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (committed, commit_seen) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let resume = Mutex::new(resume);
    let callback_arm = armed.clone();
    let runtime = Arc::new(
        SessionRuntime::open(
            directory.path().into(),
            Arc::new(move |status| {
                if status.state == RecoveryState::Ready
                    && callback_arm.swap(false, Ordering::AcqRel)
                {
                    committed.send(()).unwrap();
                    resume.lock().unwrap().recv().unwrap();
                }
            }),
        )
        .unwrap(),
    );
    let audio = Arc::new(audio());
    let jobs = Arc::new(ExportJobs::default());
    resolve(&runtime, &audio, &jobs);
    let workspace = runtime.workspace();
    let old_owner = workspace.lock().unwrap().active_owner().clone();
    let pending = closes(&runtime);
    armed.store(true, Ordering::Release);
    let closer = {
        let (runtime, audio, jobs) = (runtime.clone(), audio.clone(), jobs.clone());
        thread::spawn(move || runtime.close(pending, &audio, &jobs))
    };
    commit_seen.recv_timeout(Duration::from_secs(5)).unwrap();
    // Let the off-lock delivery finish, but latch native publication at its gate.
    let access_latch = audio.access.lock().unwrap();
    release.send(()).unwrap();
    wait_until(|| !runtime.inner.state.lock().unwrap().publishing);
    // The real short scheduling mutex now latches final rearming after publication.
    let schedule_latch = runtime.inner.state.lock().unwrap();
    drop(access_latch);
    wait_until(|| workspace.lock().unwrap().active_owner() != &old_owner);
    let admitted = workspace
        .lock()
        .unwrap()
        .stage_document(Project::blank(), None);
    drop(schedule_latch);
    let result = closer.join().unwrap().unwrap();
    assert!(admitted.is_err());
    assert_eq!(workspace.lock().unwrap().active_owner(), &result.active);
    edit(&runtime, 7);
    assert_eq!(runtime.status().state, RecoveryState::Pending);
}

#[test]
fn startup_omissions_preserve_valid_evidence_and_failure_keeps_resolution_pending() {
    for retained in [0, 1] {
        let directory = tempfile::tempdir().unwrap();
        let runtime = open(directory.path());
        let audio = audio();
        let jobs = ExportJobs::default();
        resolve(&runtime, &audio, &jobs);
        let workspace = runtime.workspace();
        let candidate = workspace
            .lock()
            .unwrap()
            .stage_document(Project::blank(), None)
            .unwrap();
        crate::transition_workspace(&audio, &jobs, &workspace, |state| {
            state.add_document(&candidate.token)
        })
        .unwrap();
        runtime.changed();
        checkpoint(&runtime);
        drop(runtime);
        let root = directory.path().join("recovery-v1");
        let manifest_bytes = std::fs::read(root.join("manifest.json")).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
        let referenced = ["current", "previous"]
            .into_iter()
            .filter_map(|key| {
                manifest[key]["generation"].as_u64().map(|generation| {
                    let name = format!("checkpoint-{generation}.json");
                    let bytes = std::fs::read(root.join(&name)).unwrap();
                    (name, bytes)
                })
            })
            .collect::<Vec<_>>();
        let runtime = open(directory.path());
        let preview = runtime.startup().preview.unwrap();
        assert_eq!(preview.documents.len(), 2);
        let ids = preview
            .documents
            .iter()
            .take(retained)
            .map(|d| d.document_id.clone())
            .collect::<Vec<_>>();
        let omitted = preview
            .documents
            .iter()
            .skip(retained)
            .map(|d| d.document_id.clone())
            .collect::<Vec<_>>();
        let before = serde_json::to_value(runtime.workspace().lock().unwrap().snapshot()).unwrap();
        let obstruction = root.join("diagnostic-pending");
        std::fs::write(&obstruction, b"unowned obstruction").unwrap();
        let failed = runtime.resolve(Some(preview.token.clone()), ids.clone(), &audio, &jobs);
        assert!(
            failed.is_err(),
            "diagnostic preservation failure must block startup resolution"
        );
        assert_eq!(
            std::fs::read(root.join("manifest.json")).unwrap(),
            manifest_bytes
        );
        for (name, bytes) in &referenced {
            assert_eq!(&std::fs::read(root.join(name)).unwrap(), bytes);
        }
        assert_eq!(
            serde_json::to_value(runtime.workspace().lock().unwrap().snapshot()).unwrap(),
            before
        );
        assert!(runtime.workspace().lock().unwrap().is_frozen());
        assert_eq!(runtime.startup().preview.unwrap().token, preview.token);
        std::fs::remove_file(obstruction).unwrap();
        let result = runtime
            .resolve(Some(preview.token), ids.clone(), &audio, &jobs)
            .unwrap();
        assert_eq!(
            std::fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            manifest_bytes
        );
        for (name, bytes) in &referenced {
            assert_eq!(
                &std::fs::read(root.join("diagnostic").join(name)).unwrap(),
                bytes
            );
        }
        let store = runtime.inner.store.lock().unwrap();
        let committed = store.load().unwrap().unwrap();
        assert_eq!(committed.manifest.lifecycle, SessionLifecycle::Running);
        assert!(committed.manifest.epoch > manifest["epoch"].as_u64().unwrap());
        for id in &omitted {
            assert!(
                !result
                    .workspace
                    .documents
                    .iter()
                    .any(|document| &document.document_id == id)
            );
            assert!(
                !committed
                    .recovery
                    .envelope
                    .documents
                    .iter()
                    .any(|document| &document.document_id == id)
            );
        }
        for id in &ids {
            assert!(
                committed
                    .recovery
                    .envelope
                    .documents
                    .iter()
                    .any(|document| &document.document_id == id)
            );
        }
    }
}

#[test]
fn delayed_pending_delivery_cannot_regress_acknowledgement_or_outlive_retirement() {
    let directory = tempfile::tempdir().unwrap();
    let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let resume = Mutex::new(resume);
    let callback_arm = armed.clone();
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let events = delivered.clone();
    let runtime = Arc::new(
        SessionRuntime::open(
            directory.path().into(),
            Arc::new(move |status| {
                if status.state == RecoveryState::Pending
                    && callback_arm.swap(false, Ordering::AcqRel)
                {
                    entered.send(()).unwrap();
                    resume.lock().unwrap().recv().unwrap();
                }
                events.lock().unwrap().push(status);
            }),
        )
        .unwrap(),
    );
    let audio = Arc::new(audio());
    let jobs = Arc::new(ExportJobs::default());
    resolve(&runtime, &audio, &jobs);
    let old_generation = runtime.status().generation;
    armed.store(true, Ordering::Release);
    let editor = {
        let runtime = runtime.clone();
        thread::spawn(move || edit(&runtime, 7))
    };
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    runtime.retry().unwrap();
    wait_until(|| {
        runtime.status().state == RecoveryState::Ready
            && runtime.status().generation > old_generation
    });
    let acknowledgement = runtime.status();
    let pending = closes(&runtime);
    let before_close = runtime.workspace().lock().unwrap().active_owner().clone();
    let (closed, close_result) = std::sync::mpsc::channel();
    let closer = {
        let (runtime, audio, jobs) = (runtime.clone(), audio.clone(), jobs.clone());
        thread::spawn(move || {
            let result = runtime.close(pending, &audio, &jobs);
            closed.send(result).unwrap();
        })
    };
    let workspace = runtime.workspace();
    wait_until(|| {
        let state = workspace.lock().unwrap();
        state.is_frozen() || state.active_owner() != &before_close
    });
    // A delayed status callback cannot hold the audio/workspace boundary.
    let owner = workspace.lock().unwrap().active_owner().clone();
    audio
        .command(
            &workspace,
            &owner,
            TransportCommand::Invalidate { generation: 300 },
        )
        .unwrap();
    let stopped = audio.command(
        &workspace,
        &owner,
        TransportCommand::Stop { generation: 300 },
    );
    let retirement_was_waiting = close_result.try_recv().is_err();
    release.send(()).unwrap();
    editor.join().unwrap();
    closer.join().unwrap();
    assert!(stopped.is_ok() || stopped.unwrap_err().contains("Prepare a score"));
    assert!(
        retirement_was_waiting,
        "retirement must drain the in-flight delivery"
    );
    let events = delivered.lock().unwrap();
    for pair in events.windows(2) {
        assert!(
            pair[1].generation >= pair[0].generation,
            "delivered acknowledgement regressed"
        );
        assert!(
            pair[1].captured_at_unix_ms >= pair[0].captured_at_unix_ms,
            "delivered capture time regressed"
        );
    }
    assert!(events.last().unwrap().generation > acknowledgement.generation);
    assert_eq!(
        serde_json::to_value(events.last().unwrap()).unwrap(),
        serde_json::to_value(runtime.status()).unwrap()
    );
}

#[test]
fn status_callback_can_query_mutate_and_retry_without_recursive_delivery() {
    let directory = tempfile::tempdir().unwrap();
    let current = Arc::new(Mutex::new(std::sync::Weak::<SessionRuntime>::new()));
    let callback_runtime = current.clone();
    let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let callback_arm = armed.clone();
    let inside = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let callback_inside = inside.clone();
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let events = delivered.clone();
    let runtime = Arc::new(
        SessionRuntime::open(
            directory.path().into(),
            Arc::new(move |status| {
                assert!(
                    !callback_inside.swap(true, Ordering::AcqRel),
                    "recursive status delivery"
                );
                if status.state == RecoveryState::Ready
                    && callback_arm.swap(false, Ordering::AcqRel)
                {
                    let runtime = callback_runtime.lock().unwrap().upgrade().unwrap();
                    edit(&runtime, 9);
                    assert_eq!(runtime.status().state, RecoveryState::Pending);
                    runtime.retry().unwrap();
                }
                events.lock().unwrap().push(status);
                callback_inside.store(false, Ordering::Release);
            }),
        )
        .unwrap(),
    );
    *current.lock().unwrap() = Arc::downgrade(&runtime);
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    let initial = runtime.status().generation.unwrap();
    edit(&runtime, 7);
    armed.store(true, Ordering::Release);
    runtime.retry().unwrap();
    wait_until(|| {
        runtime
            .status()
            .generation
            .is_some_and(|generation| generation >= initial + 2)
    });
    runtime.inner.drain();
    let events = delivered.lock().unwrap();
    assert!(
        events
            .iter()
            .any(|status| status.state == RecoveryState::Pending
                && status.generation == Some(initial + 1))
    );
    assert_eq!(
        serde_json::to_value(events.last().unwrap()).unwrap(),
        serde_json::to_value(runtime.status()).unwrap()
    );
}

#[test]
fn clean_shutdown_keeps_only_the_saved_lock_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = open(directory.path());
    let audio = audio();
    let jobs = ExportJobs::default();
    resolve(&runtime, &audio, &jobs);
    edit(&runtime, 7);
    let workspace = runtime.workspace();
    let id = workspace.lock().unwrap().active_owner().document_id.clone();
    let lock = Some(crate::project::DocumentLock::Finalized);
    {
        let mut state = workspace.lock().unwrap();
        let address = address(&state, &id);
        state
            .save_to_path(&address, directory.path().join("kept.tabplayer"))
            .unwrap();
        let address = crate::workspace::DocumentRevision {
            revision: state.document(&id).unwrap().revision,
            ..address
        };
        state.set_lock(&address, lock).unwrap();
        assert!(state.document(&id).unwrap().snapshot.dirty);
    }
    // Unsaved: the clean shutdown reduces the document to its saved, unlocked checkpoint.
    runtime.shutdown(closes(&runtime), &audio, &jobs).unwrap();
    drop(runtime);
    let runtime = open(directory.path());
    let preview = runtime.startup().preview.unwrap();
    let recovered = preview
        .documents
        .iter()
        .find(|record| record.document_id == id)
        .unwrap();
    assert_eq!(recovered.snapshot.project.lock, None);
    assert!(!recovered.snapshot.dirty);
    // Saved: the lock survives the reduction and the restart.
    let audio = self::audio();
    runtime
        .resolve(Some(preview.token.clone()), vec![id.clone()], &audio, &jobs)
        .unwrap();
    let workspace = runtime.workspace();
    {
        let mut state = workspace.lock().unwrap();
        let address = address(&state, &id);
        state.set_lock(&address, lock).unwrap();
        let address = crate::workspace::DocumentRevision {
            revision: state.document(&id).unwrap().revision,
            ..address
        };
        state
            .save_to_path(&address, directory.path().join("kept.tabplayer"))
            .unwrap();
    }
    runtime.shutdown(closes(&runtime), &audio, &jobs).unwrap();
    drop(runtime);
    let runtime = open(directory.path());
    let preview = runtime.startup().preview.unwrap();
    let recovered = preview
        .documents
        .iter()
        .find(|record| record.document_id == id)
        .unwrap();
    assert_eq!(recovered.snapshot.project.lock, lock);
    assert!(!recovered.snapshot.dirty);
}
