use serde_json::{Value, json};
use tabplayer_lib::audio::{device::TransportCommand, plan::PlaybackPlan};

fn protocol() -> Value {
    serde_json::from_str(include_str!("../../tests/selection-playback-protocol.json")).unwrap()
}

#[test]
fn play_range_requires_an_explicit_nullable_end_and_strict_fields() {
    for case in protocol()["commands"].as_array().unwrap() {
        let decoded = serde_json::from_value::<TransportCommand>(case["value"].clone());
        assert_eq!(
            decoded.is_ok(),
            case["decode"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(command) = decoded {
            let output = serde_json::to_value(command).unwrap();
            assert_eq!(output.as_object().unwrap().len(), 4);
            assert_eq!(output["type"], case["value"]["type"]);
            assert_eq!(output["generation"], case["value"]["generation"]);
            assert_eq!(
                output["startTick"].as_f64(),
                case["value"]["startTick"].as_f64()
            );
            assert!(output.get("endTick").is_some());
            assert_eq!(
                output["endTick"].as_f64(),
                case["value"]["endTick"].as_f64()
            );
        }
    }
}

#[test]
fn performed_map_missing_empty_and_grace_rows_are_compatible_but_null_is_not() {
    let input = protocol();
    let original: PlaybackPlan = serde_json::from_value(input["plan"].clone()).unwrap();
    original.validate().unwrap();
    assert!(
        serde_json::to_value(original)
            .unwrap()
            .get("performedBeats")
            .is_none()
    );
    for rows in [json!([]), input["performedBeats"].clone()] {
        let mut plan = input["plan"].clone();
        plan["performedBeats"] = rows.clone();
        let decoded: PlaybackPlan = serde_json::from_value(plan).unwrap();
        decoded.validate().unwrap();
        let expected = serde_json::from_value(rows).unwrap();
        assert_eq!(decoded.performed_beats, Some(expected));
        let output = serde_json::to_value(&decoded).unwrap();
        let reopened: PlaybackPlan = serde_json::from_value(output).unwrap();
        assert_eq!(reopened, decoded);
    }
    let mut plan = input["plan"].clone();
    plan["performedBeats"] = Value::Null;
    assert!(serde_json::from_value::<PlaybackPlan>(plan).is_err());
}

#[test]
fn performed_map_rejects_nonfinite_native_ticks() {
    let input = protocol();
    let mut value = input["plan"].clone();
    value["performedBeats"] = input["performedBeats"].clone();
    let original: PlaybackPlan = serde_json::from_value(value).unwrap();
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for field in 0..3 {
            let mut plan = original.clone();
            let row = &mut plan.performed_beats.as_mut().unwrap()[0];
            match field {
                0 => row.start_tick = value,
                1 => row.end_tick = value,
                _ => row.lead_in_tick = value,
            }
            assert!(plan.validate().is_err());
        }
    }
}

#[test]
fn performed_map_rejects_invalid_addresses_spans_duplicates_and_extra_fields() {
    let input = protocol();
    let base = &input["performedBeats"][0];
    let mut invalid = Vec::new();
    for (field, value) in [
        ("startTick", json!(-1)),
        ("startTick", json!(121)),
        ("endTick", json!(3841)),
        ("leadInTick", json!(1)),
        ("occurrence", json!(1)),
        ("extra", json!(0)),
    ] {
        let mut row = base.clone();
        row[field] = value;
        invalid.push(json!([row]));
    }
    for (field, value) in [
        ("track", json!(1)),
        ("bar", json!(1)),
        ("beat", json!(-1)),
        ("staff", json!(0.5)),
        ("extra", json!(0)),
    ] {
        let mut row = base.clone();
        row["target"][field] = value;
        invalid.push(json!([row]));
    }
    invalid.push(json!([base, base]));
    for rows in invalid {
        let mut plan = input["plan"].clone();
        plan["performedBeats"] = rows.clone();
        match serde_json::from_value::<PlaybackPlan>(plan) {
            Ok(decoded) => assert!(decoded.validate().is_err(), "accepted {rows}"),
            Err(_) => {}
        }
    }
}
