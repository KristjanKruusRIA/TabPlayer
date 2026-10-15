use super::*;
use crate::settings::{BackingFilter, BackingProcessing};
fn fixture() -> (PlaybackPlan, DocumentSettings, Vec<u8>) {
    let plan=serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":1920,"durationMs":1000,"playbackEndTick":1920,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"startTick":0,"endTick":1920,"startMs":0,"endMs":1000,"meterNumerator":4,"meterDenominator":4}],"notes":[],"midi":[]})).unwrap();
    let mut settings = DocumentSettings::default();
    settings.backing=Some(serde_json::from_value(serde_json::json!({"assetId":"a","offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":500,"exitAudioMs":1500},"processing":{"semitones":12,"cents":0,"filter":"bassEnhance"},"mix":{"gain":1,"pan":0,"mute":false,"solo":false}})).unwrap());
    let size = 8000u32 * 2 * 2;
    let mut wav = b"RIFF".to_vec();
    wav.extend((36 + size).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16u32.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(8000u32.to_le_bytes());
    wav.extend(16000u32.to_le_bytes());
    wav.extend(2u16.to_le_bytes());
    wav.extend(16u16.to_le_bytes());
    wav.extend(b"data");
    wav.extend(size.to_le_bytes());
    for n in 0..16000 {
        let s = (std::f64::consts::TAU * 440. * n as f64 / 8000.).sin() * 1000.;
        wav.extend((s as i16).to_le_bytes());
    }
    (plan, settings, wav)
}
#[test]
fn frozen_processed_export_preparation_preserves_source_and_omitted_timing_gates() {
    let (plan, settings, bytes) = fixture();
    let before = serde_json::to_value(&settings).unwrap();
    let (audio, map) = prepare_export_backing(&plan, &settings, Some(bytes.clone()), true)
        .unwrap()
        .unwrap();
    assert_eq!(audio.frames.len(), 16000);
    assert_eq!(map.source_seconds(0.), 0.5);
    assert!(
        prepare_export_backing(&plan, &settings, Some(bytes), false)
            .unwrap()
            .is_none()
    );
    assert_eq!(serde_json::to_value(&settings).unwrap(), before);
    for include in [false, true] {
        assert!(prepare_export_backing(&plan, &settings, None, include).is_err());
        assert!(prepare_export_backing(&plan, &settings, Some(vec![0; 8]), include).is_err());
        let mut stale = plan.clone();
        stale.playback_end_tick = None;
        assert!(prepare_export_backing(&stale, &settings, None, include).is_err());
    }
}
#[test]
fn native_export_preparation_rejects_invalid_processing_before_omission() {
    let (plan, mut settings, bytes) = fixture();
    settings.backing.as_mut().unwrap().processing = Some(BackingProcessing {
        semitones: f64::NAN,
        cents: 0.,
        filter: BackingFilter::None,
    });
    for include in [false, true] {
        assert!(prepare_export_backing(&plan, &settings, Some(bytes.clone()), include).is_err());
    }
}
