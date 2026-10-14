use tabplayer_lib::project::EditCommand;

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
