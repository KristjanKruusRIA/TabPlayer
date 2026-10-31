use serde_json::{Value, json};
use tabplayer_lib::{
    engraving::{EngravingOverrides, PageLayout},
    project::{EditCommand, Project, ProjectSession},
    settings::DocumentSettings,
};

fn engraving() -> Value {
    json!({
        "stylesheet": {
            "hideDynamics": null, "brackets": "inherit", "extendBarLines": null,
            "systemSeparators": null, "tuning": null, "chords": "inherit",
            "singleNames": "inherit", "multiNames": "inherit", "firstNames": "inherit",
            "otherNames": "inherit", "firstNameDirection": "inherit",
            "otherNameDirection": "inherit", "barNumbers": "inherit", "multiRests": "inherit",
            "hideEmptyStaves": null, "hideEmptyFirstSystem": null, "singleStaffBrackets": null
        },
        "notation": {
            "tabRhythm": "inherit", "fingering": "inherit", "smallGraceTab": null,
            "extendBendArrows": null, "extendLineEffects": null, "parenthesizeTiedBends": null,
            "showTiedBendNumbers": null, "showDiveWhammyZeros": null
        },
        "systemSpacing": null, "profiles": []
    })
}

fn page() -> Value {
    json!({"widthMm": 180.0, "heightMm": 240.0,
        "marginsMm": {"top": 10.0, "right": 12.0, "bottom": 14.0, "left": 16.0},
        "scale": 1.0, "profile": "document"})
}

fn engraving_command() -> Value {
    let mut value = engraving();
    value["profiles"] = json!([{"trackId": "base/0", "profile": "source"}]);
    json!({"type": "setEngraving", "engraving": value})
}

fn page_command() -> Value {
    json!({"type": "setPageLayout", "layout": page()})
}

fn accepted(value: &Value) -> EditCommand {
    let command: EditCommand = serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("Expected command {value}: {error}"));
    command
        .validate()
        .unwrap_or_else(|error| panic!("Expected valid command {value}: {error}"));
    command
}

fn rejected(value: &Value) {
    assert!(
        serde_json::from_value::<EditCommand>(value.clone())
            .map(|command| command.validate().is_err())
            .unwrap_or(true),
        "Accepted invalid command {value}"
    );
}

#[test]
fn engraving_commands_roundtrip_complete_nullable_and_explicit_overrides() {
    let mut styled = engraving_command();
    styled["engraving"]["stylesheet"]["hideDynamics"] = json!(false);
    styled["engraving"]["notation"]["showTiedBendNumbers"] = json!(true);
    styled["engraving"]["systemSpacing"] = json!(1.25);
    for value in [engraving_command(), page_command(), styled] {
        assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    }
}

#[test]
fn engraving_commands_require_every_nested_field_and_reject_unknown_fields() {
    for (value, paths) in [
        (
            engraving_command(),
            vec![
                "",
                "/engraving",
                "/engraving/stylesheet",
                "/engraving/notation",
                "/engraving/profiles/0",
            ],
        ),
        (page_command(), vec!["", "/layout", "/layout/marginsMm"]),
    ] {
        for path in paths {
            let mut unknown = value.clone();
            unknown.pointer_mut(path).unwrap()["unexpected"] = json!(true);
            rejected(&unknown);
            for field in value.pointer(path).unwrap().as_object().unwrap().keys() {
                let mut missing = value.clone();
                missing
                    .pointer_mut(path)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
                rejected(&missing);
            }
        }
    }
}

#[test]
fn engraving_nullable_booleans_accept_inheritance_and_reject_other_types() {
    for (group, fields) in [
        (
            "stylesheet",
            vec![
                "hideDynamics",
                "extendBarLines",
                "systemSeparators",
                "tuning",
                "hideEmptyStaves",
                "hideEmptyFirstSystem",
                "singleStaffBrackets",
            ],
        ),
        (
            "notation",
            vec![
                "smallGraceTab",
                "extendBendArrows",
                "extendLineEffects",
                "parenthesizeTiedBends",
                "showTiedBendNumbers",
                "showDiveWhammyZeros",
            ],
        ),
    ] {
        for field in fields {
            for valid in [json!(null), json!(true), json!(false)] {
                let mut value = engraving_command();
                value["engraving"][group][field] = valid;
                accepted(&value);
            }
            for invalid in [json!(0), json!(1), json!("true"), json!([]), json!({})] {
                let mut value = engraving_command();
                value["engraving"][group][field] = invalid;
                rejected(&value);
            }
        }
    }
}

#[test]
fn engraving_named_modes_accept_only_the_specified_string_domains() {
    for (path, modes) in [
        (
            "/engraving/stylesheet/brackets",
            vec!["inherit", "none", "staves", "similar"],
        ),
        (
            "/engraving/stylesheet/chords",
            vec!["inherit", "hidden", "top", "inline", "both"],
        ),
        (
            "/engraving/stylesheet/singleNames",
            vec!["inherit", "hidden", "firstSystem", "allSystems"],
        ),
        (
            "/engraving/stylesheet/multiNames",
            vec!["inherit", "hidden", "firstSystem", "allSystems"],
        ),
        (
            "/engraving/stylesheet/firstNames",
            vec!["inherit", "full", "short"],
        ),
        (
            "/engraving/stylesheet/otherNames",
            vec!["inherit", "full", "short"],
        ),
        (
            "/engraving/stylesheet/firstNameDirection",
            vec!["inherit", "horizontal", "vertical"],
        ),
        (
            "/engraving/stylesheet/otherNameDirection",
            vec!["inherit", "horizontal", "vertical"],
        ),
        (
            "/engraving/stylesheet/barNumbers",
            vec!["inherit", "all", "firstSystem", "hidden"],
        ),
        (
            "/engraving/stylesheet/multiRests",
            vec!["inherit", "off", "on"],
        ),
        (
            "/engraving/notation/tabRhythm",
            vec!["inherit", "auto", "hidden", "beams", "connected"],
        ),
        (
            "/engraving/notation/fingering",
            vec!["inherit", "score", "piano", "above", "abovePiano"],
        ),
        (
            "/engraving/profiles/0/profile",
            vec![
                "source",
                "standard",
                "tablature",
                "standardTab",
                "slash",
                "numbered",
            ],
        ),
    ] {
        for mode in modes {
            let mut value = engraving_command();
            *value.pointer_mut(path).unwrap() = json!(mode);
            assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        }
        for invalid in [
            json!("unknown"),
            json!(0),
            json!(null),
            json!({"inherit": null}),
        ] {
            let mut value = engraving_command();
            *value.pointer_mut(path).unwrap() = invalid;
            rejected(&value);
        }
    }
    for profile in ["document", "ScoreTab", "Score", "Tab"] {
        let mut value = page_command();
        value["layout"]["profile"] = json!(profile);
        assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    }
    for invalid in [
        json!("scoreTab"),
        json!("inherit"),
        json!(null),
        json!({"document": null}),
    ] {
        let mut value = page_command();
        value["layout"]["profile"] = invalid;
        rejected(&value);
    }
}

#[test]
fn engraving_profile_ids_are_nonempty_distinct_and_not_score_resolved_natively() {
    let mut value = engraving_command();
    value["engraving"]["profiles"] = json!([
        {"trackId": "removed/track", "profile": "numbered"},
        {"trackId": "future/track", "profile": "tablature"}
    ]);
    accepted(&value);
    value["engraving"]["profiles"][1]["trackId"] = json!("removed/track");
    rejected(&value);
    for invalid in [json!(""), json!(null), json!(0)] {
        value["engraving"]["profiles"][1]["trackId"] = invalid;
        rejected(&value);
    }
    value["engraving"]["profiles"] = json!([]);
    accepted(&value);
    value["engraving"]["profiles"] = json!(null);
    rejected(&value);
}

fn typography(family: &str, text: Value, title: Value, tab: Value) -> Value {
    json!({"family": family, "textScale": text, "titleScale": title, "tabScale": tab})
}

#[test]
fn engraving_typography_is_optional_and_round_trips_only_when_set() {
    // Documents and commands from before typography existed stay valid and serialize unchanged.
    let plain = engraving_command();
    assert!(plain["engraving"].get("typography").is_none());
    assert_eq!(serde_json::to_value(accepted(&plain)).unwrap(), plain);
    let mut set = engraving_command();
    set["engraving"]["typography"] = typography("serif", json!(1.5), json!(null), json!(0.75));
    assert_eq!(serde_json::to_value(accepted(&set)).unwrap(), set);
    // An explicit default is accepted and is written back without the field.
    let mut explicit = engraving_command();
    explicit["engraving"]["typography"] =
        typography("inherit", json!(null), json!(null), json!(null));
    assert_eq!(serde_json::to_value(accepted(&explicit)).unwrap(), plain);
    for (field, value) in [
        ("textScale", 0.5),
        ("textScale", 2.0),
        ("titleScale", 0.5),
        ("titleScale", 2.0),
        ("tabScale", 0.75),
        ("tabScale", 1.5),
    ] {
        let mut ok = engraving_command();
        ok["engraving"]["typography"] = typography("sans", json!(null), json!(null), json!(null));
        ok["engraving"]["typography"][field] = json!(value);
        accepted(&ok);
    }
    for (field, invalid) in [
        ("textScale", json!(0.49)),
        ("textScale", json!(2.01)),
        ("textScale", json!("1")),
        ("titleScale", json!(0.0)),
        ("titleScale", json!(-1)),
        ("titleScale", json!(2.01)),
        ("tabScale", json!(0.74)),
        ("tabScale", json!(1.51)),
        ("tabScale", json!({})),
        ("family", json!("comic")),
        ("family", json!(null)),
    ] {
        let mut bad = engraving_command();
        bad["engraving"]["typography"] = typography("sans", json!(null), json!(null), json!(null));
        bad["engraving"]["typography"][field] = invalid;
        rejected(&bad);
    }
    let mut extra = engraving_command();
    extra["engraving"]["typography"] = typography("sans", json!(null), json!(null), json!(null));
    extra["engraving"]["typography"]["extra"] = json!(1);
    rejected(&extra);
    let mut missing = engraving_command();
    missing["engraving"]["typography"] = json!({"family": "sans"});
    rejected(&missing);
}

fn widths(entries: Value) -> Value {
    let mut value = engraving_command();
    value["engraving"]["barWidths"] = entries;
    value
}

#[test]
fn engraving_bar_widths_are_optional_ordered_bounded_and_round_trip_only_when_set() {
    // A command from before bar widths existed stays valid and serializes unchanged.
    let plain = engraving_command();
    assert!(plain["engraving"].get("barWidths").is_none());
    assert_eq!(serde_json::to_value(accepted(&plain)).unwrap(), plain);
    let set = widths(
        json!([{"bar": 0, "scale": 1.5}, {"bar": 1, "scale": 1.0}, {"bar": 3, "scale": 0.25}, {"bar": 99999, "scale": 4.0}]),
    );
    assert_eq!(serde_json::to_value(accepted(&set)).unwrap(), set);
    // An explicit empty list is accepted and is written back without the field.
    assert_eq!(
        serde_json::to_value(accepted(&widths(json!([])))).unwrap(),
        plain
    );
    for invalid in [
        json!([{"bar": 1, "scale": 0.249}]),
        json!([{"bar": 1, "scale": 4.01}]),
        json!([{"bar": 1, "scale": 0.0}]),
        json!([{"bar": 1, "scale": -1.5}]),
        json!([{"bar": 1, "scale": "2"}]),
        json!([{"bar": 1, "scale": null}]),
        json!([{"bar": 100000, "scale": 2.0}]),
        json!([{"bar": -1, "scale": 2.0}]),
        json!([{"bar": 1.5, "scale": 2.0}]),
        json!([{"bar": 4294967296u64, "scale": 2.0}]),
        json!([{"bar": 2, "scale": 2.0}, {"bar": 1, "scale": 2.0}]),
        json!([{"bar": 2, "scale": 2.0}, {"bar": 2, "scale": 1.5}]),
        json!([{"bar": 1}]),
        json!([{"scale": 2.0}]),
        json!([{"bar": 1, "scale": 2.0, "extra": true}]),
        json!({"bar": 1, "scale": 2.0}),
        json!(null),
    ] {
        rejected(&widths(invalid));
    }
    // Hostile sizes are refused: one entry past the cap, however well formed.
    let many = |count: u32| {
        Value::Array(
            (0..count)
                .map(|bar| json!({"bar": bar, "scale": 2.0}))
                .collect(),
        )
    };
    accepted(&widths(many(10_000)));
    rejected(&widths(many(10_001)));
    let mut non_finite = EngravingOverrides::default();
    for scale in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        non_finite.bar_widths = vec![tabplayer_lib::engraving::BarWidth { bar: 0, scale }];
        assert!(non_finite.validate().is_err());
    }
}

#[test]
fn engraving_bar_widths_survive_history_undo_redo_save_and_reopen_beside_an_old_log() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    let last_widths = |project: Value| {
        project["edits"]
            .as_array()
            .and_then(|edits| edits.last().cloned())
            .and_then(|edit| edit["engraving"].get("barWidths").cloned())
    };
    // An old log: a setEngraving written before bar widths existed is retained and replayed unchanged.
    session.apply_edit(accepted(&engraving_command())).unwrap();
    let old = session.snapshot().project;
    let old_stored = serde_json::to_value(session.stored_project()).unwrap();
    assert_eq!(last_widths(serde_json::to_value(&old).unwrap()), None);
    session
        .apply_edit(accepted(&widths(json!([{"bar": 2, "scale": 1.7}]))))
        .unwrap();
    let dragged = session.snapshot().project;
    assert_eq!(dragged.edits.len(), 2);
    assert_eq!(
        last_widths(serde_json::to_value(&dragged).unwrap()),
        Some(json!([{"bar": 2, "scale": 1.7}]))
    );
    // Restoring the defaults is one more edit that leaves the field out.
    session.apply_edit(accepted(&engraving_command())).unwrap();
    assert_eq!(session.snapshot().project.edits.len(), 3);
    assert_eq!(
        last_widths(serde_json::to_value(&session.snapshot().project).unwrap()),
        None
    );
    session.undo().unwrap();
    assert_eq!(session.snapshot().project, dragged);
    session.undo().unwrap();
    assert_eq!(session.snapshot().project, old);
    session.redo().unwrap();
    assert_eq!(session.snapshot().project, dragged);
    let stored = serde_json::to_value(session.stored_project()).unwrap();
    let reopened = ProjectSession::new(serde_json::from_value(stored).unwrap(), None).unwrap();
    assert_eq!(reopened.snapshot().project, dragged);
    assert_eq!(
        last_widths(serde_json::to_value(&reopened.snapshot().project).unwrap()),
        Some(json!([{"bar": 2, "scale": 1.7}]))
    );
    // The old log alone still opens.
    let reopened_old =
        ProjectSession::new(serde_json::from_value(old_stored).unwrap(), None).unwrap();
    assert_eq!(reopened_old.snapshot().project, old);
}

#[test]
fn engraving_system_spacing_requires_null_or_a_bounded_factor() {
    for valid in [json!(null), json!(0.25), json!(4.0)] {
        let mut value = engraving_command();
        value["engraving"]["systemSpacing"] = valid;
        accepted(&value);
    }
    for invalid in [json!(0.249), json!(4.001), json!(-1), json!("1"), json!({})] {
        let mut value = engraving_command();
        value["engraving"]["systemSpacing"] = invalid;
        rejected(&value);
    }
}

#[test]
fn engraving_page_geometry_has_bounded_dimensions_scale_and_independent_margins() {
    for (field, values) in [
        ("widthMm", vec![19.99, 1000.01, -1.0]),
        ("heightMm", vec![19.99, 1000.01, -1.0]),
        ("scale", vec![0.249, 3.001, 0.0]),
    ] {
        for invalid in values {
            let mut value = page_command();
            value["layout"][field] = json!(invalid);
            rejected(&value);
        }
        let mut value = page_command();
        value["layout"][field] = json!(null);
        rejected(&value);
    }
    for scale in [0.25, 3.0] {
        let mut value = page_command();
        value["layout"]["scale"] = json!(scale);
        accepted(&value);
    }
    let mut large = page_command();
    large["layout"]["widthMm"] = json!(1000.0);
    large["layout"]["heightMm"] = json!(1000.0);
    accepted(&large);
    for field in ["top", "right", "bottom", "left"] {
        for invalid in [json!(-0.001), json!(1000.0), json!(null), json!("10")] {
            let mut value = page_command();
            value["layout"]["marginsMm"][field] = invalid;
            rejected(&value);
        }
    }
}

#[test]
fn engraving_page_body_reserves_the_header_footer_and_at_least_100_pixels() {
    let mut value = page_command();
    value["layout"]["widthMm"] = json!(100.0);
    value["layout"]["heightMm"] = json!(100.0);
    value["layout"]["marginsMm"] = json!({"top": 0.0, "right": 0.0, "bottom": 0.0, "left": 0.0});
    for (axis, dimension, reservation) in [("right", 100.0, 0.0), ("bottom", 100.0, 64.0)] {
        value["layout"]["marginsMm"][axis] = json!(dimension - (101.0 + reservation) * 25.4 / 96.0);
        accepted(&value);
        value["layout"]["marginsMm"][axis] = json!(dimension - (99.0 + reservation) * 25.4 / 96.0);
        rejected(&value);
        value["layout"]["marginsMm"][axis] = json!(0.0);
    }
}

#[test]
fn engraving_grouped_pixel_width_accepts_exactly_100_pixels() {
    let mut value = page_command();
    value["layout"]["widthMm"] = json!(100.0);
    value["layout"]["marginsMm"]["left"] = json!(16.0);
    value["layout"]["marginsMm"]["right"] = json!(57.54166666666667);
    accepted(&value);
}

#[test]
fn engraving_grouped_pixel_width_rejects_just_below_100_pixels() {
    let mut value = page_command();
    value["layout"]["widthMm"] = json!(50.0);
    value["layout"]["marginsMm"]["left"] = json!(0.0);
    value["layout"]["marginsMm"]["right"] = json!(23.541666666666668);
    rejected(&value);
}

#[test]
fn engraving_grouped_pixel_height_accepts_exactly_100_pixels_after_headers() {
    let mut value = page_command();
    value["layout"]["heightMm"] = json!(70.0);
    value["layout"]["marginsMm"]["top"] = json!(0.0);
    value["layout"]["marginsMm"]["bottom"] = json!(26.608333333333345);
    accepted(&value);
}

#[test]
fn engraving_grouped_pixel_height_rejects_just_below_100_pixels_after_headers() {
    let mut value = page_command();
    value["layout"]["heightMm"] = json!(50.0);
    value["layout"]["marginsMm"]["top"] = json!(0.0);
    value["layout"]["marginsMm"]["bottom"] = json!(6.608333333333339);
    rejected(&value);
}

#[test]
fn engraving_page_rejects_finite_margins_that_overflow_pixel_conversion() {
    let mut value: PageLayout = serde_json::from_value(page()).unwrap();
    value.margins_mm.left = f64::MAX;
    assert!(value.validate().is_err());
}

#[test]
fn engraving_native_float_validation_rejects_nonfinite_spacing_and_geometry() {
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut value = EngravingOverrides::default();
        value.system_spacing = Some(invalid);
        assert!(value.validate().is_err());
        for field in [
            "widthMm", "heightMm", "scale", "top", "right", "bottom", "left",
        ] {
            let mut value: PageLayout = serde_json::from_value(page()).unwrap();
            match field {
                "widthMm" => value.width_mm = invalid,
                "heightMm" => value.height_mm = invalid,
                "scale" => value.scale = invalid,
                "top" => value.margins_mm.top = invalid,
                "right" => value.margins_mm.right = invalid,
                "bottom" => value.margins_mm.bottom = invalid,
                _ => value.margins_mm.left = invalid,
            }
            assert!(value.validate().is_err(), "Accepted nonfinite {field}");
        }
    }
}

#[test]
fn engraving_derived_settings_default_only_missing_new_top_level_fields() {
    let old = json!({"sounds": {}, "mixes": {}, "backing": null, "print": {
        "paper": "A4", "orientation": "portrait", "marginMm": 15.0, "scale": 1.0, "profile": "ScoreTab"
    }});
    let settings: DocumentSettings = serde_json::from_value(old.clone()).unwrap();
    settings.validate().unwrap();
    let derived = serde_json::to_value(settings).unwrap();
    assert_eq!(derived["engraving"], engraving());
    assert_eq!(derived.get("page"), Some(&Value::Null));
    assert_eq!(derived["print"], old["print"]);
    for field in ["sounds", "mixes", "backing", "print"] {
        let mut missing = old.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<DocumentSettings>(missing).is_err());
    }
    for field in ["engraving", "page"] {
        let mut missing = derived.clone();
        missing.as_object_mut().unwrap().remove(field);
        let restored: DocumentSettings = serde_json::from_value(missing).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), derived);
    }
    assert_eq!(
        serde_json::to_value(DocumentSettings::default()).unwrap()["engraving"],
        engraving()
    );
    for field in ["stylesheet", "notation", "systemSpacing", "profiles"] {
        let mut missing = derived.clone();
        missing["engraving"].as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<DocumentSettings>(missing).is_err());
    }
    let mut invalid = derived.clone();
    invalid["engraving"] = json!(null);
    assert!(serde_json::from_value::<DocumentSettings>(invalid).is_err());
    let mut invalid = derived.clone();
    invalid["page"] = page();
    invalid["page"]["marginsMm"]["left"] = json!(1000.0);
    assert!(
        serde_json::from_value::<DocumentSettings>(invalid)
            .unwrap()
            .validate()
            .is_err()
    );
    let mut invalid = derived;
    invalid["engraving"]["systemSpacing"] = json!(4.01);
    assert!(
        serde_json::from_value::<DocumentSettings>(invalid)
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn engraving_native_history_retains_commands_undo_redo_and_rejects_invalid_edits() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    let base = session.snapshot().project.base;
    let commands = [
        engraving_command(),
        page_command(),
        json!({"type": "setPrintLayout", "layout": {"paper": "Letter", "orientation": "landscape",
            "marginMm": 20.0, "scale": 1.5, "profile": "Score"}}),
    ];
    for command in &commands {
        session.apply_edit(accepted(command)).unwrap();
    }
    let configured = session.snapshot().project;
    assert_eq!(configured.base, base);
    assert_eq!(configured.schema_version, 3);
    assert_eq!(configured.engine_version, "1.8.4");
    assert_eq!(configured.edits.len(), 3);
    session.undo().unwrap();
    assert_eq!(session.snapshot().project.edits.len(), 2);
    session.redo().unwrap();
    assert_eq!(session.snapshot().project, configured);
    let before = session.snapshot();
    let mut invalid = engraving_command();
    invalid["engraving"]["systemSpacing"] = json!(4.01);
    assert!(
        session
            .apply_edit(serde_json::from_value(invalid).unwrap())
            .is_err()
    );
    assert_eq!(session.snapshot(), before);
    let stored = serde_json::to_value(session.stored_project()).unwrap();
    let reopened = ProjectSession::new(serde_json::from_value(stored).unwrap(), None).unwrap();
    assert_eq!(reopened.snapshot().project, configured);
}

fn header_footer() -> Value {
    let bands = |header: &str, footer: &str| {
        json!({"header": {"left": header, "center": "", "right": ""},
            "footer": {"left": "", "center": footer, "right": "100%% %PAGES%"}})
    };
    json!({"first": bands("%TITLE% – %ARTIST%", "%PAGE%"), "other": bands("", "%COPYRIGHT%")})
}

#[test]
fn engraving_page_header_footer_is_optional_and_round_trips() {
    let mut value = page_command();
    let plain: PageLayout = serde_json::from_value(value["layout"].clone()).unwrap();
    assert!(
        serde_json::to_value(&plain)
            .unwrap()
            .get("headerFooter")
            .is_none()
    );
    value["layout"]["headerFooter"] = header_footer();
    accepted(&value);
    let layout: PageLayout = serde_json::from_value(value["layout"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&layout).unwrap(), value["layout"]);
    for field in [
        "TITLE",
        "SUBTITLE",
        "ARTIST",
        "ALBUM",
        "WORDS",
        "MUSIC",
        "COPYRIGHT",
        "TABBER",
        "INSTRUCTIONS",
        "NOTICES",
        "PAGE",
        "PAGES",
    ] {
        value["layout"]["headerFooter"]["other"]["header"]["right"] = json!(format!("%{field}%"));
        accepted(&value);
    }
    value["layout"]["headerFooter"]["other"]["header"]["right"] = json!("é".repeat(200));
    accepted(&value);
}

#[test]
fn engraving_page_header_footer_rejects_invalid_text_and_shapes() {
    for invalid in [
        json!("%COMPOSER%"),
        json!("%title%"),
        json!("50% off"),
        json!("a\nb"),
        json!("é".repeat(201)),
        json!("a\u{FFFE}b"),
        json!("a\u{FFFF}"),
        json!(null),
        json!(1),
    ] {
        let mut value = page_command();
        value["layout"]["headerFooter"] = header_footer();
        value["layout"]["headerFooter"]["first"]["footer"]["left"] = invalid;
        rejected(&value);
    }
    for path in ["", "/first", "/first/header"] {
        let mut value = page_command();
        value["layout"]["headerFooter"] = header_footer();
        value["layout"]["headerFooter"].pointer_mut(path).unwrap()["unexpected"] = json!(true);
        rejected(&value);
    }
    let mut value = page_command();
    value["layout"]["headerFooter"] = header_footer();
    value["layout"]["headerFooter"]["other"]["footer"]
        .as_object_mut()
        .unwrap()
        .remove("right");
    rejected(&value);
    value["layout"]["headerFooter"] = json!(null);
    rejected(&value);
}
