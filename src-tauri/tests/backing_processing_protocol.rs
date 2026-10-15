use serde_json::Value;
use tabplayer_lib::settings::BackingSettings;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../tests/backing-processing-protocol.json")).unwrap()
}

#[test]
fn accepts_valid_processing_protocol() {
    for case in fixtures()["valid"].as_array().unwrap() {
        let result = serde_json::from_value::<BackingSettings>(case["backing"].clone());
        assert!(result.is_ok(), "{}: {result:?}", case["id"]);
        result.unwrap().validate().unwrap();
    }
}

#[test]
fn rejects_invalid_processing_protocol() {
    let fixture = fixtures();
    let accepted: Vec<_> = fixture["invalid"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| {
            serde_json::from_value::<BackingSettings>(case["backing"].clone())
                .is_ok_and(|settings| settings.validate().is_ok())
        })
        .map(|case| case["id"].as_str().unwrap())
        .collect();
    assert!(accepted.is_empty(), "Accepted invalid cases: {accepted:?}");
}

#[test]
fn accepts_explicit_processing_object() {
    let case = fixtures()["valid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "mode_none")
        .unwrap()
        .clone();
    let settings: BackingSettings = serde_json::from_value(case["backing"].clone()).unwrap();
    settings.validate().unwrap();
}

#[test]
fn legacy_processing_defaults_and_omits_on_serialization() {
    use tabplayer_lib::settings::{BackingFilter, BackingProcessing};
    let neutral = BackingProcessing::default();
    assert_eq!(neutral.semitones, 0.0);
    assert_eq!(neutral.cents, 0.0);
    assert_eq!(neutral.filter, BackingFilter::None);
    neutral.validate().unwrap();
    for case in fixtures()["valid"].as_array().unwrap() {
        let settings: BackingSettings = serde_json::from_value(case["backing"].clone()).unwrap();
        if case["backing"]["processing"].is_null() {
            assert!(settings.processing.is_none());
            assert!(
                serde_json::to_value(settings)
                    .unwrap()
                    .get("processing")
                    .is_none()
            );
        } else {
            let wire = serde_json::to_value(settings).unwrap();
            assert_eq!(
                wire["processing"]["semitones"].as_f64(),
                case["backing"]["processing"]["semitones"].as_f64(),
                "{}",
                case["id"]
            );
            assert_eq!(
                wire["processing"]["cents"].as_f64(),
                case["backing"]["processing"]["cents"].as_f64(),
                "{}",
                case["id"]
            );
            assert_eq!(
                wire["processing"]["filter"], case["backing"]["processing"]["filter"],
                "{}",
                case["id"]
            );
        }
    }
}

#[test]
fn rejects_direct_nonfinite_and_fractional_pitch_without_normalizing_pairs() {
    use tabplayer_lib::settings::BackingProcessing;
    let mut settings: BackingSettings =
        serde_json::from_value(fixtures()["valid"][0]["backing"].clone()).unwrap();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.5] {
        for semitones_field in [true, false] {
            let mut processing = BackingProcessing::default();
            if semitones_field {
                processing.semitones = bad;
            } else {
                processing.cents = bad;
            }
            assert!(processing.validate().is_err());
            settings.processing = Some(processing);
            assert!(settings.validate().is_err());
        }
    }
    let processing = BackingProcessing {
        semitones: -1.0,
        cents: 100.0,
        ..Default::default()
    };
    processing.validate().unwrap();
    assert_eq!(
        serde_json::to_value(processing).unwrap(),
        serde_json::json!({"semitones": -1.0, "cents": 100.0, "filter": "none"})
    );
}

#[test]
fn rejects_tagged_object_filter_spellings() {
    for mode in [
        "none",
        "bassEnhance",
        "bassAttenuation",
        "mediumEnhance",
        "mediumAttenuation",
        "highEnhance",
        "highAttenuation",
    ] {
        let mut backing = fixtures()["valid"][2]["backing"].clone();
        backing["processing"]["filter"] = serde_json::json!({mode: null});
        assert!(
            serde_json::from_value::<BackingSettings>(backing).is_err(),
            "{mode}"
        );
    }
}
