use super::*;
use crate::{project::Project, workspace::CloseDocument};
use std::{sync::mpsc, thread, time::Duration};

fn fixture() -> (
    Arc<NativeAudio>,
    Arc<Mutex<DocumentWorkspace>>,
    Arc<ExportJobs>,
) {
    (
        Arc::new(NativeAudio::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            Arc::new(|_| {}),
        )),
        Arc::new(Mutex::new(DocumentWorkspace::new().unwrap())),
        Arc::new(ExportJobs::default()),
    )
}

fn plan(generation: u64) -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":generation,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap()
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
        processing: None,
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

fn audition_request() -> crate::audio::audition::AuditionRequest {
    serde_json::from_value(serde_json::json!({
        "voice": crate::settings::TrackSound::default(),
        "program": 24,
        "percussion": false,
        "mix": {"gain": 1, "pan": 0, "mute": false, "solo": false},
        "notes": [{"key": 40, "startMs": 0, "velocity": 100}],
        "durationMs": 500,
    }))
    .unwrap()
}

#[test]
fn audition_checks_only_the_owner_and_never_opens_a_device() {
    let (audio, workspace, jobs) = fixture();
    let first = workspace.lock().unwrap().active_owner().clone();
    // No output stream has ever opened: nothing plays, nothing is opened, and a
    // prepare in flight (the access lock) does not delay or fail the request.
    let held = audio.access.lock().unwrap();
    assert_eq!(
        audio
            .audition(&workspace, &first, audition_request())
            .unwrap(),
        crate::audio::audition::AuditionResult { played: false }
    );
    drop(held);
    assert!(audio.service.audition_rate().is_none());
    let desired = audio.service.status().desired_generation;
    // The previous owner is stale once another document becomes active.
    let second = add(&audio, &jobs, &workspace);
    assert_eq!(
        audio
            .audition(&workspace, &first, audition_request())
            .unwrap_err(),
        "Audio owner is no longer active."
    );
    assert_eq!(
        audio
            .audition(
                &workspace,
                &AudioOwner {
                    document_id: "missing".into(),
                    activation_id: second.activation_id.clone(),
                },
                audition_request()
            )
            .unwrap_err(),
        "Audio owner is no longer active."
    );
    assert!(
        audio
            .audition(&workspace, &second, audition_request())
            .is_ok()
    );
    assert_eq!(audio.service.status().desired_generation, desired + 1);
    // Invalid requests are refused whatever the owner.
    let mut invalid = audition_request();
    invalid.notes.clear();
    assert!(audio.audition(&workspace, &second, invalid).is_err());
}

#[test]
fn audition_renders_one_at_a_time_and_the_latest_request_wins() {
    use crate::audio::audition::AuditionClip;
    let (audio, workspace, _jobs) = fixture();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let mut consumer = audio.service.attach_test_audition(48_000);
    let clip = |frames: usize| {
        Ok(Box::new(AuditionClip {
            rate: 48_000,
            frames: vec![[0.5; 2]; frames],
            tone: false,
        }))
    };
    let (started, started_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel::<()>();
    // The oldest request starts rendering and stalls inside its render.
    let first = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            audio.audition_with(&workspace, &owner, audition_request(), |_, _| {
                started.send(()).unwrap();
                release_rx.recv().unwrap();
                clip(100)
            })
        })
    };
    started_rx.recv().unwrap();
    let wait_for = |sequence: u64| {
        while audio
            .audition_sequence
            .load(std::sync::atomic::Ordering::SeqCst)
            < sequence
        {
            thread::sleep(Duration::from_millis(1));
        }
    };
    // Two newer requests arrive while it renders; the second overtakes the first.
    let second = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            audio.audition_with(&workspace, &owner, audition_request(), |_, _| clip(200))
        })
    };
    wait_for(2);
    let third = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            audio.audition_with(&workspace, &owner, audition_request(), |_, _| clip(300))
        })
    };
    wait_for(3);
    // The overtaken middle request gives up without waiting for the stalled render.
    assert!(!second.join().unwrap().unwrap().played);
    // A refused request does not overtake the latest valid one.
    let stale = AudioOwner {
        document_id: "missing".into(),
        activation_id: owner.activation_id.clone(),
    };
    assert!(
        audio
            .audition(&workspace, &stale, audition_request())
            .is_err()
    );
    let mut invalid = audition_request();
    invalid.notes.clear();
    assert!(audio.audition(&workspace, &owner, invalid).is_err());
    assert_eq!(
        audio
            .audition_sequence
            .load(std::sync::atomic::Ordering::SeqCst),
        3
    );
    release.send(()).unwrap();
    // The stalled render finishes after being overtaken: dropped, never queued.
    assert!(!first.join().unwrap().unwrap().played);
    assert!(third.join().unwrap().unwrap().played);
    use ringbuf::traits::Consumer;
    assert_eq!(consumer.try_pop().unwrap().frames.len(), 300);
    assert!(consumer.try_pop().is_none());
}

#[test]
fn a_panicking_audition_render_does_not_block_later_auditions() {
    use crate::audio::audition::AuditionClip;
    let (audio, workspace, _jobs) = fixture();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let _consumer = audio.service.attach_test_audition(48_000);
    let panicked = {
        let (audio, workspace, owner) = (audio.clone(), workspace.clone(), owner.clone());
        thread::spawn(move || {
            audio.audition_with(&workspace, &owner, audition_request(), |_, _| {
                panic!("render failed")
            })
        })
    };
    assert!(panicked.join().is_err());
    assert!(audio.audition_render.is_poisoned());
    let played = audio
        .audition_with(&workspace, &owner, audition_request(), |_, _| {
            Ok(Box::new(AuditionClip {
                rate: 48_000,
                frames: vec![[0.5; 2]; 100],
                tone: false,
            }))
        })
        .unwrap();
    assert!(played.played);
}

/// Every change of a knob in the Sound rig reaches `audio_set_mix`. With the same backing as before, nothing about the
fn valid_wav(pcm_bytes: u32) -> Vec<u8> {
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
    wav
}

/// backing is needed, so its asset must not be decoded (a long recording is tens of megabytes of base64) under the workspace lock.
#[test]
fn set_mix_with_an_unchanged_backing_does_not_decode_the_asset() {
    use crate::{
        assets::DECODES,
        project::EditCommand,
        settings::{BackingSettings, ChannelMix},
    };
    let (audio, workspace, _jobs) = fixture();
    let directory = tempfile::tempdir().unwrap();
    let owner = workspace.lock().unwrap().active_owner().clone();
    let original = DocumentRevision {
        document_id: owner.document_id.clone(),
        revision: 0,
    };
    // 32 MB of backing, as a long recording would be.
    let big = valid_wav(32 * 1024 * 1024 - 44);
    let staged = workspace
        .lock()
        .unwrap()
        .stage_asset(
            &owner.document_id,
            StoredAsset::from_bytes(
                directory
                    .path()
                    .join("long.wav")
                    .to_string_lossy()
                    .into_owned(),
                "audio/wav".into(),
                &big,
            ),
        )
        .unwrap();
    let backing = BackingSettings {
        processing: None,
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
    let mut settings = DocumentSettings::default();
    settings.backing = Some(backing);
    audio
        .command(
            &workspace,
            &owner,
            TransportCommand::Invalidate { generation: 1 },
        )
        .unwrap();
    // Preparing opens the output device. The Linux and Windows CI runners have none, so there the test says so and
    // stops; on a machine with a device it runs in full.
    if let Err(error) = audio.prepare(
        &workspace,
        &owner,
        plan(1),
        settings.clone(),
        None,
        "source".into(),
        None,
    ) {
        assert!(
            error.contains("No audio output device")
                || error.contains("Could not configure audio output"),
            "{error}"
        );
        eprintln!("no usable audio output device ({error}); skipped");
        return;
    }
    assert_eq!(
        *audio.current_backing.lock().unwrap(),
        Some(staged.asset_id.clone())
    );
    assert!(audio.service.status().backing_duration_seconds.is_some());
    let decodes = || DECODES.with(|count| count.get());
    let before = decodes();
    let started = std::time::Instant::now();
    for i in 1..=20 {
        let mut tweak = settings.clone();
        if let Some(b) = &mut tweak.backing {
            b.mix.gain = 0.5 + (i as f32) * 0.01;
        }
        audio.set_mix(&workspace, &owner, tweak, 1).unwrap();
    }
    let unchanged = started.elapsed();
    println!(
        "20 set_mix calls with an unchanged 32 MB backing: {unchanged:?}, {} asset decodes",
        decodes() - before
    );
    assert_eq!(decodes(), before, "an unchanged backing is not decoded");

    // Remove backing installs: drops backing and player status duration becomes None.
    let mut without_backing = settings.clone();
    without_backing.backing = None;
    let decodes_before_remove = decodes();
    audio
        .set_mix(&workspace, &owner, without_backing.clone(), 1)
        .unwrap();
    assert_eq!(
        *audio.current_backing.lock().unwrap(),
        None,
        "remove clears current_backing"
    );
    assert_eq!(
        audio.service.status().backing_duration_seconds,
        None,
        "remove drops backing audio from player status"
    );
    assert_eq!(
        decodes(),
        decodes_before_remove,
        "removing backing does not decode"
    );

    // Add-back backing installs: decodes once and reinstalls backing.
    let decodes_before_add_back = decodes();
    audio
        .set_mix(&workspace, &owner, settings.clone(), 1)
        .unwrap();
    assert_eq!(
        *audio.current_backing.lock().unwrap(),
        Some(staged.asset_id.clone()),
        "add-back restores current_backing"
    );
    assert!(
        audio.service.status().backing_duration_seconds.is_some(),
        "add-back restores backing duration"
    );
    assert_eq!(
        decodes(),
        decodes_before_add_back + 1,
        "add-back decodes the backing once"
    );

    // Replace backing installs: stage a second valid WAV and set_mix with it.
    let second_wav = valid_wav(48_000 * 10 * 4);
    let staged2 = workspace
        .lock()
        .unwrap()
        .stage_asset(
            &owner.document_id,
            StoredAsset::from_bytes(
                directory
                    .path()
                    .join("second.wav")
                    .to_string_lossy()
                    .into_owned(),
                "audio/wav".into(),
                &second_wav,
            ),
        )
        .unwrap();
    let backing2 = BackingSettings {
        processing: None,
        reference_sync: None,
        asset_id: staged2.asset_id.clone(),
        offset_ms: 0.0,
        anchors: vec![],
        mix: ChannelMix::default(),
    };
    workspace
        .lock()
        .unwrap()
        .apply_edit(
            &DocumentRevision {
                document_id: owner.document_id.clone(),
                revision: 1,
            },
            EditCommand::SetBacking {
                backing: Some(backing2.clone()),
            },
            Some(&staged2.token),
        )
        .unwrap();
    let mut settings2 = DocumentSettings::default();
    settings2.backing = Some(backing2);
    let decodes_before_replace = decodes();
    audio
        .set_mix(&workspace, &owner, settings2.clone(), 1)
        .unwrap();
    assert_eq!(
        *audio.current_backing.lock().unwrap(),
        Some(staged2.asset_id.clone()),
        "replace installs new current_backing"
    );
    let duration2 = audio.service.status().backing_duration_seconds;
    assert!(duration2.is_some(), "replace installs new backing duration");
    assert_eq!(
        decodes(),
        decodes_before_replace + 1,
        "replace decodes the new asset once"
    );

    // Errors keep the old audio: stale generation returns error and keeps old backing and duration.
    let stale_err = audio.set_mix(&workspace, &owner, settings.clone(), 999);
    assert!(stale_err.is_err(), "stale generation returns error");
    assert_eq!(
        *audio.current_backing.lock().unwrap(),
        Some(staged2.asset_id.clone()),
        "stale error retains old backing"
    );
    assert_eq!(
        audio.service.status().backing_duration_seconds,
        duration2,
        "stale error retains old audio duration"
    );
}
