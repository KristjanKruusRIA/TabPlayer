use super::*;
use crate::{
    project::{EditCommand, Project},
    settings::BackingSettings,
};

fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":7680,"durationMs":6000,"playbackEndTick":7680,
        "tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":80}],
        "occurrences":[
            {"bar":0,"occurrence":0,"startTick":0,"endTick":3840,"startMs":0,"endMs":3000,"meterNumerator":4,"meterDenominator":4},
            {"bar":1,"occurrence":0,"startTick":3840,"endTick":7680,"startMs":3000,"endMs":6000,"meterNumerator":4,"meterDenominator":4}
        ],"notes":[],"midi":[]
    })).unwrap()
}
fn settings() -> DocumentSettings {
    let backing: BackingSettings = serde_json::from_value(serde_json::json!({
        "assetId":"reference","offsetMs":120,"anchors":[],
        "referenceSync":{"entryAudioMs":1120,"exitAudioMs":7120},
        "mix":{"gain":1,"pan":0,"mute":false,"solo":false}
    }))
    .unwrap();
    DocumentSettings {
        backing: Some(backing),
        ..Default::default()
    }
}
fn wav(seconds: u32) -> Vec<u8> {
    let size = seconds * 8000 * 2;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend((36 + size).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(8000u32.to_le_bytes());
    bytes.extend(16000u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(size.to_le_bytes());
    bytes.resize(44 + size as usize, 0);
    bytes
}

#[test]
fn omitted_reference_captures_the_current_native_source_before_omission() {
    let bytes = wav(8);
    let mut settings = settings();
    let asset = StoredAsset::from_bytes("original.wav".into(), "audio/wav".into(), &bytes);
    let id = asset.id().unwrap();
    settings.backing.as_mut().unwrap().asset_id = id.clone();
    let mut project = Project::blank();
    project.assets.insert(id, asset);
    project.edits.push(EditCommand::SetBacking {
        backing: settings.backing.clone(),
    });
    let mut workspace = DocumentWorkspace::new().unwrap();
    let candidate = workspace.stage_document(project, None).unwrap();
    let active = workspace.add_document(&candidate.token).unwrap().active;
    let current = workspace.document(&active.document_id).unwrap();
    let document = DocumentRevision {
        document_id: current.document_id,
        revision: current.revision,
    };
    let workspace = Mutex::new(workspace);
    let jobs = ExportJobs::default();
    let audio = NativeAudio::new(PathBuf::new(), Arc::new(|_| {}));
    let captured = audio
        .launch_export(
            &jobs,
            &workspace,
            &document,
            None,
            export_source_settings(false, &settings),
            None,
            0,
        )
        .unwrap();
    captured.job.finish(Ok(()));
    assert!(
        captured.backing.as_deref() == Some(bytes.as_slice()),
        "omitted reference must capture the exact encoded source"
    );
    assert!(
        prepare_export_backing(&plan(), &settings, captured.backing, false)
            .unwrap()
            .is_none()
    );
}

#[test]
fn omitted_reference_still_rejects_eof_decoder_and_missing_source() {
    let plan = plan();
    let settings = settings();
    for bytes in [Some(wav(6)), Some(b"damaged audio".to_vec()), None] {
        assert!(prepare_export_backing(&plan, &settings, bytes, false).is_err());
    }
}

#[test]
fn omitted_reference_still_rejects_a_dishonest_effective_plan_or_authority() {
    let mut dishonest = plan();
    dishonest.tempos[0].bpm = 120.0;
    dishonest.duration_ms = 4000.0;
    dishonest.occurrences[0].end_ms = 2000.0;
    dishonest.occurrences[1].start_ms = 2000.0;
    dishonest.occurrences[1].end_ms = 4000.0;
    assert!(prepare_export_backing(&dishonest, &settings(), Some(wav(8)), false).is_err());
    assert!(prepare_export_backing(&plan(), &DocumentSettings::default(), None, false).is_err());
    let mut legacy_plan = plan();
    legacy_plan.playback_end_tick = None;
    assert!(prepare_export_backing(&legacy_plan, &settings(), Some(wav(8)), false).is_err());
}

#[test]
fn valid_omitted_reference_keeps_effective_duration_and_wall_tail_without_installing_pcm() {
    let plan = plan();
    let settings = settings();
    let before = serde_json::to_value(&settings).unwrap();
    assert!(
        prepare_export_backing(&plan, &settings, Some(wav(8)), false)
            .unwrap()
            .is_none()
    );
    let schedule =
        crate::export::audio::RenderSchedule::new(&plan, None, 48000, 0.5, 0.5, 60.0).unwrap();
    assert_eq!(schedule.total_frames, 600_000);
    assert_eq!(plan.playback_end_tick, Some(7680.0));
    assert_eq!(serde_json::to_value(&settings).unwrap(), before);
}

#[test]
fn included_reference_uses_the_reference_translation() {
    let (audio, map) = prepare_export_backing(&plan(), &settings(), Some(wav(8)), true)
        .unwrap()
        .unwrap();
    assert_eq!(audio.frames.len(), 64_000);
    assert_eq!(map.source_seconds(0.0), 1.0);
    assert_eq!(map.source_seconds(6.0), 7.0);
}

#[test]
fn omitted_legacy_audio_does_not_add_a_decode_requirement() {
    let mut settings = settings();
    settings.backing.as_mut().unwrap().reference_sync = None;
    let mut plan = plan();
    plan.playback_end_tick = None;
    assert!(export_source_settings(false, &settings).is_none());
    assert!(
        prepare_export_backing(
            &plan,
            &settings,
            Some(b"damaged legacy audio".to_vec()),
            false
        )
        .unwrap()
        .is_none()
    );
    assert!(
        prepare_export_backing(
            &plan,
            &settings,
            Some(b"damaged legacy audio".to_vec()),
            true
        )
        .is_err()
    );
}
