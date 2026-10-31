use serde_json::json;
use tabplayer_lib::project::{
    BaseDocument, EditCommand, NEW_SCORE_DEFAULT_LIMIT, NewScoreDefaults, Project,
};

fn defaults() -> NewScoreDefaults {
    NewScoreDefaults {
        artist: "The Band".into(),
        words: "Ann".into(),
        music: "Ben".into(),
        tab: "Cy".into(),
        copyright: "© The Band".into(),
    }
}

#[test]
fn defaults_fill_the_blank_base_and_one_baseline_metadata_edit() {
    let project = Project::blank_with_defaults(&defaults()).unwrap();
    assert!(
        matches!(&project.base, BaseDocument::Blank { artist, title, .. } if artist == "The Band" && title == "Untitled")
    );
    assert!(project.edits.is_empty(), "Defaults are not an undo step.");
    assert_eq!(project.baseline_edits.len(), 1);
    let EditCommand::SetScoreMetadata { fields } = &project.baseline_edits[0] else {
        panic!("expected metadata");
    };
    assert_eq!(
        serde_json::to_value(fields).unwrap(),
        json!({"subTitle":"","album":"","words":"Ann","music":"Ben","copyright":"© The Band","tab":"Cy","notices":"","instructions":""})
    );
}

#[test]
fn empty_defaults_match_the_plain_blank_score_and_artist_alone_needs_no_edit() {
    assert_eq!(
        Project::blank_with_defaults(&NewScoreDefaults::default()).unwrap(),
        Project::blank()
    );
    let artist = Project::blank_with_defaults(&NewScoreDefaults {
        artist: "Solo".into(),
        ..NewScoreDefaults::default()
    })
    .unwrap();
    assert!(artist.baseline_edits.is_empty());
    assert!(matches!(&artist.base, BaseDocument::Blank { artist, .. } if artist == "Solo"));
}

#[test]
fn defaults_are_limited_and_strictly_shaped() {
    let mut long = defaults();
    long.copyright = "é".repeat(NEW_SCORE_DEFAULT_LIMIT);
    assert!(Project::blank_with_defaults(&long).is_ok());
    long.copyright.push('x');
    assert!(
        Project::blank_with_defaults(&long)
            .unwrap_err()
            .contains("at most 1000")
    );
    assert!(
        serde_json::from_value::<NewScoreDefaults>(
            json!({"artist":"","words":"","music":"","tab":"","copyright":"","album":""})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<NewScoreDefaults>(
            json!({"artist":"","words":"","music":"","tab":""})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<NewScoreDefaults>(
            json!({"artist":1,"words":"","music":"","tab":"","copyright":""})
        )
        .is_err()
    );
}
