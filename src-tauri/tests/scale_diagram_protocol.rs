use serde_json::{Value, json};
use tabplayer_lib::project::EditCommand;

fn mark(string: u64, fret: u64) -> Value {
    json!({"string": string, "fret": fret, "shape": "circle", "color": "#b5df73", "text": "R", "textColor": "#161c24"})
}

fn command(diagram: Value) -> Value {
    json!({"type": "setScaleDiagram", "target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "diagram": diagram})
}

fn diagram(marks: Vec<Value>) -> Value {
    json!({"name": "Scale", "strings": 6, "frets": 5, "firstFret": 5, "orientation": "vertical", "showFretMarkers": false, "marks": marks})
}

fn check(value: Value) -> Result<(), String> {
    serde_json::from_value::<EditCommand>(value)
        .map_err(|error| error.to_string())?
        .validate()
}

#[test]
fn a_scale_diagram_accepts_marks_inside_its_window_and_open_marks() {
    assert!(check(command(diagram(vec![mark(1, 0), mark(6, 5), mark(6, 9)]))).is_ok());
    assert!(check(command(Value::Null)).is_ok());
}

#[test]
fn a_scale_diagram_refuses_invalid_geometry_and_marks() {
    let mut cases = vec![
        diagram(vec![mark(0, 5)]),
        diagram(vec![mark(7, 5)]),
        diagram(vec![mark(1, 4)]),
        diagram(vec![mark(1, 10)]),
        diagram(vec![mark(1, 5), mark(1, 5)]),
    ];
    for (field, value) in [
        ("strings", json!(2)),
        ("strings", json!(11)),
        ("frets", json!(3)),
        ("frets", json!(25)),
        ("firstFret", json!(0)),
        ("firstFret", json!(124)),
        ("name", json!("x".repeat(65))),
    ] {
        let mut bad = diagram(vec![]);
        bad[field] = value;
        cases.push(bad);
    }
    for (field, value) in [
        ("text", json!("abcd")),
        ("color", json!("red")),
        ("textColor", json!("#12345g")),
    ] {
        let mut bad = mark(1, 5);
        bad[field] = value;
        cases.push(diagram(vec![bad]));
    }
    for case in cases {
        assert!(check(command(case.clone())).is_err(), "{case}");
    }
}

#[test]
fn a_scale_diagram_refuses_unknown_fields_shapes_and_missing_diagram() {
    let mut extra = diagram(vec![]);
    extra["extra"] = json!(true);
    let mut shape = mark(1, 5);
    shape["shape"] = json!("star");
    for case in [command(extra), command(diagram(vec![shape]))] {
        assert!(check(case).is_err());
    }
    assert!(
        serde_json::from_value::<EditCommand>(json!({"type": "setScaleDiagram", "target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}}))
            .is_err()
    );
}

#[test]
fn a_scale_diagram_text_counts_characters_not_bytes() {
    let mut three = mark(1, 5);
    three["text"] = json!("♯♭♮");
    assert!(check(command(diagram(vec![three]))).is_ok());
}
