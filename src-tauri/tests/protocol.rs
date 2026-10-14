use tabplayer_lib::project::EditCommand;

#[test]
fn accepts_triple_dots_and_rejects_more() {
    for kind in ["setDuration", "insertBeat"] {
        let command: EditCommand = serde_json::from_value(serde_json::json!({
            "type": kind, "target": {"track":0,"staff":0,"bar":0,"voice":0,"beat":0},
            "duration":8, "dots":3
        }))
        .unwrap();
        assert!(command.validate().is_ok());
        let invalid: EditCommand = serde_json::from_value(serde_json::json!({
            "type": kind, "target": {"track":0,"staff":0,"bar":0,"voice":0,"beat":0},
            "duration":8, "dots":4
        }))
        .unwrap();
        assert!(invalid.validate().is_err());
    }
}

#[test]
fn every_frontend_command_round_trips_through_rust() {
    let examples: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/protocol.json")).unwrap();
    assert_eq!(examples.len(), 12);
    for mut example in examples {
        let command: EditCommand = serde_json::from_value(example.clone()).unwrap();
        // JSON has one numeric type; serde distinguishes integer and floating storage.
        if let Some(tempo) = example.get_mut("tempo") {
            *tempo = serde_json::json!(tempo.as_f64().unwrap());
        }
        assert_eq!(serde_json::to_value(command).unwrap(), example);
    }
}
