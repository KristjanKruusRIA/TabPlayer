use serde_json::{Value, json};
use tabplayer_lib::{
    audio::plan::PlaybackPlan,
    edit_types::EditCommand,
    export_backing::{BackingAssetReadRequest, BackingAssetReadResponse},
    settings::BackingSettings,
    workspace::MAX_DOCUMENT_REVISION,
};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../tests/reference-sync-protocol.json")).unwrap()
}

fn payload(name: &str) -> Value {
    fixtures()["valid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()["payload"]
        .clone()
}

fn accepts(kind: &str, value: &Value) -> bool {
    match kind {
        "backing" => serde_json::from_value::<BackingSettings>(value.clone())
            .is_ok_and(|backing| backing.validate().is_ok()),
        "command" => serde_json::from_value::<EditCommand>(value.clone())
            .is_ok_and(|command| command.validate().is_ok()),
        "plan" => serde_json::from_value::<PlaybackPlan>(value.clone())
            .is_ok_and(|plan| plan.validate().is_ok()),
        "assetRead" => serde_json::from_value::<BackingAssetReadRequest>(value.clone())
            .is_ok_and(|request| request.validate().is_ok()),
        _ => panic!("Unknown protocol fixture kind: {kind}"),
    }
}

fn check_cases(kind: &str, valid: bool) {
    let fixture = fixtures();
    let cases = fixture[if valid { "valid" } else { "invalid" }]
        .as_array()
        .unwrap();
    let selected: Vec<_> = cases.iter().filter(|case| case["kind"] == kind).collect();
    assert!(!selected.is_empty());
    let failures: Vec<_> = selected
        .iter()
        .filter(|case| accepts(kind, &case["payload"]) != valid)
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    assert!(
        failures.is_empty(),
        "{kind} expected valid={valid}: {failures:?}"
    );
}

macro_rules! protocol_cases {
    ($valid_name:ident, $invalid_name:ident, $kind:literal) => {
        #[test]
        fn $valid_name() {
            check_cases($kind, true);
        }
        #[test]
        fn $invalid_name() {
            check_cases($kind, false);
        }
    };
}

protocol_cases!(
    accepts_backing_settings,
    rejects_invalid_backing_settings,
    "backing"
);
protocol_cases!(
    accepts_tempo_replacement,
    rejects_invalid_tempo_replacement,
    "command"
);
protocol_cases!(
    accepts_active_plan_end,
    rejects_invalid_active_plan_end,
    "plan"
);
protocol_cases!(accepts_asset_read, rejects_invalid_asset_read, "assetRead");

#[test]
fn omitted_and_null_reference_bounds_serialize_as_legacy() {
    for name in ["legacy bounds omitted", "legacy bounds null"] {
        let settings: BackingSettings = serde_json::from_value(payload(name)).unwrap();
        settings.validate().unwrap();
        assert!(settings.reference_sync.is_none());
        assert!(
            serde_json::to_value(settings)
                .unwrap()
                .get("referenceSync")
                .is_none()
        );
    }
    let plan: PlaybackPlan =
        serde_json::from_value(payload("legacy plan missing active end")).unwrap();
    plan.validate().unwrap();
    assert!(plan.playback_end_tick.is_none());
    assert!(
        serde_json::to_value(plan)
            .unwrap()
            .get("playbackEndTick")
            .is_none()
    );
}

#[test]
fn reference_bounds_and_anchors_reject_nonfinite_or_overflowing_physical_times() {
    let original: BackingSettings =
        serde_json::from_value(payload("reference negative stored source40")).unwrap();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut settings = original.clone();
        settings.reference_sync.as_mut().unwrap().entry_audio_ms = bad;
        assert!(settings.validate().is_err());
        let mut settings = original.clone();
        settings.reference_sync.as_mut().unwrap().exit_audio_ms = bad;
        assert!(settings.validate().is_err());
        let mut settings = original.clone();
        settings.anchors[0].audio_ms = bad;
        assert!(settings.validate().is_err());
        let mut settings = original.clone();
        settings.offset_ms = bad;
        assert!(settings.validate().is_err());
        let mut settings = original.clone();
        settings.anchors[0].ratio = bad;
        assert!(settings.validate().is_err());
    }
    let mut settings = original;
    settings.offset_ms = -f64::MAX;
    settings.reference_sync.as_mut().unwrap().exit_audio_ms = f64::MAX;
    assert!(settings.validate().is_err());
}

#[test]
fn reference_anchor_indices_keep_the_unsigned_integer_domain() {
    for field in ["bar", "occurrence"] {
        for bad in [json!(-1), json!(0.5), json!(4294967296_u64), json!(null)] {
            let mut value = payload("reference negative stored source40");
            value["anchors"][0][field] = bad;
            assert!(!accepts("backing", &value));
        }
    }
}

#[test]
fn tempo_replacement_rejects_nonfinite_values_in_direct_native_commands() {
    let original: EditCommand = serde_json::from_value(payload("ratio tempo replacement")).unwrap();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut command = original.clone();
        let EditCommand::ReplaceTempoAutomations { points } = &mut command else {
            panic!("expected tempo replacement");
        };
        points[1].ratio = bad;
        assert!(command.validate().is_err());
        let mut command = original.clone();
        let EditCommand::ReplaceTempoAutomations { points } = &mut command else {
            panic!("expected tempo replacement");
        };
        points[1].bpm = bad;
        assert!(command.validate().is_err());
    }
}

#[test]
fn active_end_requires_exact_final_occurrence_and_preserves_full_extent() {
    let original: PlaybackPlan =
        serde_json::from_value(payload("active musical end before note extent")).unwrap();
    assert_eq!(original.playback_end_tick, Some(7680.0));
    assert_eq!(original.duration_tick, 8640.0);
    assert_eq!(original.duration_ms, 4500.0);
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 7680.0001] {
        let mut plan = original.clone();
        plan.playback_end_tick = Some(bad);
        assert!(plan.validate().is_err());
    }
    let mut plan = original;
    plan.occurrences.clear();
    assert!(plan.validate().is_err());
}

#[test]
fn asset_read_validation_checks_direct_revisions_and_safe_boundary() {
    let mut request: BackingAssetReadRequest =
        serde_json::from_value(payload("strict source byte read")).unwrap();
    request.document.revision = MAX_DOCUMENT_REVISION;
    request.validate().unwrap();
    request.document.revision += 1;
    assert!(request.validate().is_err());
    request.document.revision = 0;
    request.document.document_id.clear();
    assert!(request.validate().is_err());
}

#[test]
fn asset_read_response_uses_exact_required_camel_case_fields() {
    let request = payload("strict source byte read");
    let value = json!({
        "document": request["document"], "assetId": request["assetId"],
        "sha256": "a".repeat(64), "bytesBase64": "YQ=="
    });
    let response: BackingAssetReadResponse = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), value);
    for field in ["document", "assetId", "sha256", "bytesBase64"] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<BackingAssetReadResponse>(missing).is_err());
    }
    let mut extra = value.clone();
    extra["other"] = json!(true);
    assert!(serde_json::from_value::<BackingAssetReadResponse>(extra).is_err());
    let mut extra = value;
    extra["document"]["other"] = json!(true);
    assert!(serde_json::from_value::<BackingAssetReadResponse>(extra).is_err());
}
