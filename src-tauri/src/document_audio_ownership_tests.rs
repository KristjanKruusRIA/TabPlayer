use super::*;
use crate::{project::Project, workspace::CloseDocument};
use std::{sync::mpsc, thread, time::Duration};

fn fixture() -> (
    Arc<NativeAudio>,
    Arc<Mutex<DocumentWorkspace>>,
    Arc<ExportJobs>,
) {
    (
        Arc::new(NativeAudio::new(PathBuf::new(), Arc::new(|_| {}))),
        Arc::new(Mutex::new(DocumentWorkspace::new().unwrap())),
        Arc::new(ExportJobs::default()),
    )
}

fn plan(generation: u64) -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":generation,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap()
}

fn add(audio: &NativeAudio, jobs: &ExportJobs, workspace: &Mutex<DocumentWorkspace>) -> AudioOwner {
    let candidate = workspace
        .lock()
        .unwrap()
        .stage_document(Project::blank(), None)
        .unwrap();
    crate::transition_workspace(audio, jobs, workspace, |workspace| {
        workspace.add_document(&candidate.token)
    })
    .unwrap()
    .active
}

fn commands(generation: u64) -> Vec<TransportCommand> {
    vec![
        TransportCommand::Play { generation },
        TransportCommand::PlayRange {
            generation,
            start_tick: 0.0,
            end_tick: None,
        },
        TransportCommand::Pause { generation },
        TransportCommand::Stop { generation },
        TransportCommand::Invalidate { generation },
        TransportCommand::SeekTick {
            generation,
            tick: 0.0,
        },
        TransportCommand::SetPractice {
            generation,
            settings: PracticeSettings::default(),
        },
        TransportCommand::SetLoop {
            generation,
            start_tick: 0.0,
            end_tick: 960.0,
        },
        TransportCommand::ClearLoop { generation },
        TransportCommand::SelectDevice {
            generation,
            device_id: Some("unavailable-stale-device".into()),
        },
    ]
}

#[test]
fn stale_activation_rejects_before_generation_mutation() {
    let (audio, workspace, jobs) = fixture();
    let first_a = workspace.lock().unwrap().active_owner().clone();
    audio
        .command(
            &workspace,
            &first_a,
            TransportCommand::Invalidate { generation: 10 },
        )
        .unwrap();
    let (release, delayed) = mpsc::channel();
    let worker = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), first_a.clone());
        thread::spawn(move || {
            delayed.recv().unwrap();
            assert!(
                audio
                    .prepare(
                        &workspace,
                        &owner,
                        plan(100),
                        DocumentSettings::default(),
                        Some(vec![9]),
                        "old".into(),
                        None
                    )
                    .unwrap_err()
                    .contains("owner")
            );
            assert!(
                audio
                    .set_mix(&workspace, &owner, DocumentSettings::default(), 100)
                    .unwrap_err()
                    .contains("owner")
            );
            for command in commands(100) {
                assert!(
                    audio
                        .command(&workspace, &owner, command)
                        .unwrap_err()
                        .contains("owner")
                );
            }
        })
    };
    let b = add(&audio, &jobs, &workspace);
    let current_a = crate::transition_workspace(&audio, &jobs, &workspace, |workspace| {
        workspace.activate_document(&first_a.document_id)
    })
    .unwrap()
    .active;
    assert_ne!(current_a.activation_id, first_a.activation_id);
    assert_eq!(audio.service.status().desired_generation, 12);
    *audio.embedded.lock().unwrap() = Some(("current".into(), vec![1, 2]));
    *audio.current_backing.lock().unwrap() = Some("current-asset".into());
    release.send(()).unwrap();
    worker.join().unwrap();
    crate::transition_workspace(&audio, &jobs, &workspace, |workspace| {
        workspace.close_documents(&[CloseDocument {
            document_id: b.document_id.clone(),
            revision: 0,
            discard: true,
        }])
    })
    .unwrap();
    for owner in [
        first_a,
        b,
        AudioOwner {
            document_id: "missing".into(),
            activation_id: current_a.activation_id.clone(),
        },
    ] {
        for command in commands(u64::MAX) {
            assert!(
                audio
                    .command(&workspace, &owner, command)
                    .unwrap_err()
                    .contains("owner")
            );
        }
        assert!(
            audio
                .prepare(
                    &workspace,
                    &owner,
                    plan(100),
                    DocumentSettings::default(),
                    None,
                    "stale".into(),
                    None
                )
                .is_err()
        );
        assert!(
            audio
                .set_mix(&workspace, &owner, DocumentSettings::default(), 100)
                .is_err()
        );
    }
    assert_eq!(audio.service.status().desired_generation, 12);
    assert_eq!(audio.service.prepared_generation(), None);
    assert_eq!(
        *audio.embedded.lock().unwrap(),
        Some(("current".into(), vec![1, 2]))
    );
    assert_eq!(
        *audio.current_backing.lock().unwrap(),
        Some("current-asset".into())
    );
    // A current owner still reaches the existing service generation/preparation checks.
    assert!(
        !audio
            .command(
                &workspace,
                &current_a,
                TransportCommand::Play { generation: 12 }
            )
            .unwrap_err()
            .contains("owner")
    );
}

#[test]
fn invalidate_overtakes_latched_prepare_and_queued_transition() {
    let (audio, workspace, jobs) = fixture();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let candidate = workspace
        .lock()
        .unwrap()
        .stage_document(Project::blank(), None)
        .unwrap();
    let cache_latch = audio.embedded.lock().unwrap();
    let (started, starting) = mpsc::channel();
    let prepare = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            started.send(()).unwrap();
            audio.prepare(
                &workspace,
                &owner,
                plan(10),
                DocumentSettings::default(),
                None,
                "a".into(),
                None,
            )
        })
    };
    starting.recv_timeout(Duration::from_secs(5)).unwrap();
    // The existing cache lock latches the real prepare path after its owner check.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while audio.access.try_lock().is_ok() {
        assert!(std::time::Instant::now() < deadline);
        thread::yield_now();
    }
    let (queued, waiting) = mpsc::channel();
    let (published, publication) = mpsc::channel();
    let transition = {
        let (audio, workspace, jobs) = (audio.clone(), workspace.clone(), jobs.clone());
        thread::spawn(move || {
            assert!(audio.access.try_lock().is_err());
            queued.send(()).unwrap();
            let result = crate::transition_workspace(&audio, &jobs, &workspace, |workspace| {
                workspace.add_document(&candidate.token)
            });
            published.send(result).unwrap();
        })
    };
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let (ack, acknowledged) = mpsc::channel();
    let invalidator = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            ack.send(audio.command(
                &workspace,
                &owner,
                TransportCommand::Invalidate { generation: 100 },
            ))
            .unwrap()
        })
    };
    let result = acknowledged.recv_timeout(Duration::from_secs(5));
    // Release before assertions so regressions fail without hanging worker cleanup.
    let observed = audio.service.status().desired_generation;
    let published_early = publication.try_recv();
    drop(cache_latch);
    assert!(published_early.is_err());
    assert!(result.unwrap().is_ok());
    assert_eq!(observed, 100);
    assert!(prepare.join().unwrap().is_err());
    let current = publication
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap()
        .active;
    transition.join().unwrap();
    invalidator.join().unwrap();
    assert_eq!(audio.service.status().desired_generation, 101);
    assert_eq!(workspace.lock().unwrap().active_owner(), &current);
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
    assert_eq!(audio.service.status().desired_generation, 101);
    assert_eq!(audio.service.prepared_generation(), None);
    assert!(audio.embedded.lock().unwrap().is_none());
    assert!(audio.current_backing.lock().unwrap().is_none());
}

#[test]
fn gate_orders_inflight_prepare_then_activation() {
    let (audio, workspace, jobs) = fixture();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let candidate = workspace
        .lock()
        .unwrap()
        .stage_document(Project::blank(), None)
        .unwrap();
    let latch = audio.embedded.lock().unwrap();
    let worker = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            // Validation fails after the latch; no output device is required.
            let mut invalid = plan(10);
            invalid.ppq = 0;
            audio.prepare(
                &workspace,
                &owner,
                invalid,
                DocumentSettings::default(),
                None,
                "a".into(),
                None,
            )
        })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while audio.access.try_lock().is_ok() {
        assert!(std::time::Instant::now() < deadline);
        thread::yield_now();
    }
    assert_eq!(workspace.lock().unwrap().active_owner(), &owner);
    let (queued, waiting) = mpsc::channel();
    let (published, publication) = mpsc::channel();
    let transition = {
        let (audio, workspace, jobs) = (audio.clone(), workspace.clone(), jobs.clone());
        thread::spawn(move || {
            assert!(audio.access.try_lock().is_err());
            queued.send(()).unwrap();
            published
                .send(crate::transition_workspace(
                    &audio,
                    &jobs,
                    &workspace,
                    |workspace| workspace.add_document(&candidate.token),
                ))
                .unwrap();
        })
    };
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let early = publication.try_recv();
    drop(latch);
    assert!(early.is_err());
    assert!(worker.join().unwrap().is_err());
    let current = publication
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap()
        .active;
    transition.join().unwrap();
    assert_ne!(current, owner);
    assert_eq!(audio.service.status().desired_generation, 1);
    for command in commands(100) {
        assert!(
            audio
                .command(&workspace, &owner, command)
                .unwrap_err()
                .contains("owner")
        );
    }
    assert!(
        audio
            .set_mix(&workspace, &owner, DocumentSettings::default(), 100)
            .unwrap_err()
            .contains("owner")
    );
    assert_eq!(audio.service.status().desired_generation, 1);
}

#[test]
fn export_launch_rechecks_origin_revision_backing_and_holds_running_slot() {
    use crate::{
        project::EditCommand,
        settings::{BackingSettings, ChannelMix},
    };
    let (audio, workspace, jobs) = fixture();
    let directory = tempfile::tempdir().unwrap();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let original = DocumentRevision {
        document_id: owner.document_id.clone(),
        revision: 0,
    };
    let staged = workspace
        .lock()
        .unwrap()
        .stage_asset(
            &owner.document_id,
            StoredAsset::from_bytes(
                directory
                    .path()
                    .join("a.wav")
                    .to_string_lossy()
                    .into_owned(),
                "audio/wav".into(),
                b"A backing",
            ),
        )
        .unwrap();
    let backing = BackingSettings {
        reference_sync: None,
        asset_id: staged.asset_id.clone(),
        offset_ms: 0.0,
        anchors: vec![],
        mix: ChannelMix::default(),
    };
    workspace
        .lock()
        .unwrap()
        .apply_edit(
            &original,
            EditCommand::SetBacking {
                backing: Some(backing.clone()),
            },
            Some(&staged.token),
        )
        .unwrap();
    let current = DocumentRevision {
        document_id: owner.document_id.clone(),
        revision: 1,
    };
    let mut settings = DocumentSettings::default();
    settings.backing = Some(backing);
    let destination = directory.path().join("export.wav");
    // Every long export path goes through the same real launch boundary; print has no path.
    for path in [Some(destination.as_path()), None] {
        assert!(
            audio
                .launch_export(&jobs, &workspace, &original, path, Some(&settings), None, 0)
                .is_err()
        );
        assert!(!jobs.has_running().unwrap());
    }
    let b = add(&audio, &jobs, &workspace);
    assert!(
        audio
            .launch_export(
                &jobs,
                &workspace,
                &current,
                Some(&destination),
                Some(&settings),
                None,
                0
            )
            .is_err()
    );
    crate::transition_workspace(&audio, &jobs, &workspace, |workspace| {
        workspace.activate_document(&owner.document_id)
    })
    .unwrap();
    let source_copy = directory.path().join("backing-copy.wav");
    std::fs::write(&source_copy, b"A backing").unwrap();
    assert!(
        audio
            .launch_export(
                &jobs,
                &workspace,
                &current,
                Some(&source_copy),
                Some(&settings),
                None,
                0
            )
            .is_err()
    );
    assert_eq!(std::fs::read(&source_copy).unwrap(), b"A backing");
    assert!(!jobs.has_running().unwrap());
    let captured = audio
        .launch_export(
            &jobs,
            &workspace,
            &current,
            Some(&destination),
            Some(&settings),
            None,
            0,
        )
        .unwrap();
    assert_eq!(captured.backing, Some(b"A backing".to_vec()));
    assert_eq!(captured.projects.len(), 2);
    assert!(
        crate::transition_workspace(&audio, &jobs, &workspace, |workspace| workspace
            .activate_document(&b.document_id))
        .is_err()
    );
    assert!(jobs.cancel(&b.document_id, &captured.job.id).is_err());
    jobs.cancel(&owner.document_id, &captured.job.id).unwrap();
    assert!(jobs.has_running().unwrap());
    assert!(
        crate::transition_workspace(&audio, &jobs, &workspace, |workspace| workspace
            .activate_document(&b.document_id))
        .is_err()
    );
    captured.job.finish(Err("cancelled".into()));
    crate::transition_workspace(&audio, &jobs, &workspace, |workspace| {
        workspace.close_documents(&[CloseDocument {
            document_id: owner.document_id.clone(),
            revision: 1,
            discard: true,
        }])
    })
    .unwrap();
    assert!(
        audio
            .launch_export(&jobs, &workspace, &current, None, None, None, 1)
            .is_err()
    );
    assert!(!destination.exists());
}
