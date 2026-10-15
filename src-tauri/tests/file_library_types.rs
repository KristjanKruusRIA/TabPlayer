use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tabplayer_lib::file_library::types::*;

fn roundtrip<T: DeserializeOwned + Serialize>(value: Value) {
    let decoded: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
}

fn reject_extra<T: DeserializeOwned>(mut value: Value) {
    value["futureField"] = json!(true);
    assert!(
        serde_json::from_value::<T>(value.clone()).is_err(),
        "Accepted unknown field: {value}"
    );
}

fn require_nullable<T: DeserializeOwned>(value: Value, field: &str) {
    assert!(serde_json::from_value::<T>(value.clone()).is_ok());
    let mut missing = value;
    missing.as_object_mut().unwrap().remove(field);
    assert!(serde_json::from_value::<T>(missing).is_err(), "{field}");
}

#[test]
fn tagged_sources_changes_and_metadata_edits_preserve_literal_wire_contracts() {
    for value in [
        json!({"kind":"recent","id":"recent-1"}),
        json!({"kind":"indexed","rootId":"root-1","id":"file-1"}),
        json!({"kind":"template","id":"template-1"}),
        json!({"kind":"example","id":"example-1"}),
    ] {
        roundtrip::<LibrarySource>(value.clone());
        reject_extra::<LibrarySource>(value);
    }
    for value in [
        json!({"kind":"pin","id":"recent-1","pinned":true}),
        json!({"kind":"removeRecent","id":"recent-1"}),
        json!({"kind":"removeRoot","id":"root-1"}),
        json!({"kind":"renameTemplate","id":"template-1","name":"Study"}),
        json!({"kind":"removeTemplate","id":"template-1"}),
        json!({"kind":"welcomeSeen"}),
    ] {
        roundtrip::<LibraryChange>(value.clone());
        reject_extra::<LibraryChange>(value);
    }
    for value in [
        json!({"type":"setScoreInfo","title":"","artist":"Author"}),
        json!({"type":"setScoreMetadata","album":"Album"}),
        json!({"type":"setTrackInfo","track":0,"name":"Bass"}),
        json!({"type":"addTrack","name":"Guitar"}),
        json!({"type":"addPitchedTrack","name":"Keys"}),
        json!({"type":"addPercussionTrack","name":"Drums"}),
        json!({"type":"removeTrack","track":1}),
    ] {
        roundtrip::<MetadataEdit>(value.clone());
        reject_extra::<MetadataEdit>(value);
    }
    assert!(serde_json::from_value::<LibrarySource>(json!({"kind":"future","id":"x"})).is_err());
    assert!(serde_json::from_value::<LibraryChange>(json!({"kind":"reset"})).is_err());
    assert!(
        serde_json::from_value::<MetadataEdit>(json!({"type":"setLyrics","text":"x"})).is_err()
    );
    assert!(
        serde_json::from_value::<LibrarySource>(json!({"kind":"indexed","root_id":"r","id":"f"}))
            .is_err()
    );
    assert!(
        serde_json::from_value::<MetadataEdit>(
            json!({"type":"setScoreMetadata","album":"A","copyright":"x"})
        )
        .is_err()
    );
}

#[test]
fn metadata_base_is_only_the_read_only_projection() {
    for value in [
        json!({"sha256":"digest","base":{"kind":"blank","title":"Study","artist":"Author"},"edits":[]}),
        json!({"sha256":"digest","base":{"kind":"file","bytesBase64":"AA=="},"edits":[{"type":"setTrackInfo","track":0,"name":"Lead"}]}),
    ] {
        roundtrip::<MetadataInput>(value.clone());
        reject_extra::<MetadataInput>(value);
    }
    assert!(serde_json::from_value::<MetadataInput>(json!({
        "sha256":"digest","base":{"kind":"file","bytesBase64":"AA==","filename":"score.gp"},"edits":[]
    })).is_err());
    assert!(
        serde_json::from_value::<MetadataInput>(json!({
            "sha256":"digest","base":{"kind":"future"},"edits":[]
        }))
        .is_err()
    );
}

#[test]
fn nullable_fields_must_be_present_even_when_their_value_is_null() {
    require_nullable::<RecentEntry>(
        json!({"id":"r","path":"score.gp","metadata":null,"pinned":false,"lastOpenedUnixMs":0,"availability":"unknown"}),
        "metadata",
    );
    require_nullable::<LibraryRoot>(
        json!({"id":"r","path":"scores","configurationRevision":0,"availability":"unknown","indexedAtUnixMs":null}),
        "indexedAtUnixMs",
    );
    require_nullable::<LibraryContent>(
        json!({"id":"t","title":"Study","description":"","instruments":[],"origin":"personal","license":null,"sha256":"digest"}),
        "license",
    );
    require_nullable::<LibrarySnapshot>(
        json!({"version":1,"revision":0,"welcomeSeen":false,"recents":[],"roots":[],"templates":[],"examples":[],"warning":null}),
        "warning",
    );
    require_nullable::<LibraryQuery>(
        json!({"rootId":null,"text":"","sort":"title","offset":0,"limit":100}),
        "rootId",
    );
    let result = json!({"id":"f","rootId":"r","path":"score.gp","metadata":null,"status":"metadataUnavailable","modifiedUnixMs":null});
    require_nullable::<LibraryResult>(result.clone(), "metadata");
    require_nullable::<LibraryResult>(result, "modifiedUnixMs");
    require_nullable::<LibraryPage>(
        json!({"indexRevision":0,"total":0,"rows":[],"warning":null}),
        "warning",
    );
    let result = json!({"sha256":"digest","metadata":null,"error":"Cannot parse score"});
    require_nullable::<MetadataResult>(result.clone(), "metadata");
    require_nullable::<MetadataResult>(result, "error");
    require_nullable::<FileLibraryChangedEvent>(json!({"revision":0,"warning":null}), "warning");
}

#[test]
fn revisions_and_timestamps_cannot_round_when_transferred_to_javascript() {
    for value in [json!(-1), json!(1.5), json!(9_007_199_254_740_992u64)] {
        assert!(
            serde_json::from_value::<FileLibraryChangedEvent>(
                json!({"revision":value,"warning":null})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<LibraryRoot>(json!({"id":"r","path":"scores","configurationRevision":value,"availability":"available","indexedAtUnixMs":null})).is_err());
        assert!(serde_json::from_value::<LibraryRoot>(json!({"id":"r","path":"scores","configurationRevision":0,"availability":"available","indexedAtUnixMs":value})).is_err());
        assert!(serde_json::from_value::<RecentEntry>(json!({"id":"r","path":"score.gp","metadata":null,"pinned":false,"lastOpenedUnixMs":value,"availability":"unknown"})).is_err());
        assert!(serde_json::from_value::<LibraryResult>(json!({"id":"f","rootId":"r","path":"score.gp","metadata":null,"status":"unavailable","modifiedUnixMs":value})).is_err());
        assert!(
            serde_json::from_value::<LibraryPage>(
                json!({"indexRevision":value,"total":0,"rows":[],"warning":null})
            )
            .is_err()
        );
    }
    roundtrip::<FileLibraryChangedEvent>(
        json!({"revision":9_007_199_254_740_991u64,"warning":null}),
    );
    roundtrip::<LibraryRoot>(
        json!({"id":"r","path":"scores","configurationRevision":9_007_199_254_740_991u64,"availability":"available","indexedAtUnixMs":9_007_199_254_740_991u64}),
    );
}

#[test]
fn page_limits_and_unsigned_counts_reject_invalid_requests() {
    for limit in [json!(0), json!(99), json!(101), json!(100.5), json!(-100)] {
        assert!(
            serde_json::from_value::<LibraryQuery>(
                json!({"rootId":null,"text":"","sort":"title","offset":0,"limit":limit})
            )
            .is_err()
        );
    }
    for value in [json!(-1), json!(0.5), json!(4_294_967_296u64)] {
        assert!(
            serde_json::from_value::<LibraryQuery>(
                json!({"rootId":null,"text":"","sort":"modified","offset":value,"limit":100})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ScoreFilesDroppedEvent>(
                json!({"dropToken":"drop-1","count":value})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<MetadataEdit>(json!({"type":"removeTrack","track":value}))
                .is_err()
        );
        assert!(serde_json::from_value::<LibraryScan>(json!({"jobId":"j","rootId":"r","configurationRevision":0,"phase":"reading","discovered":value,"processed":0,"skipped":0,"issues":[]})).is_err());
    }
    roundtrip::<LibraryQuery>(
        json!({"rootId":null,"text":"groove","sort":"artist","offset":100,"limit":100}),
    );
}

#[test]
fn metadata_result_has_exactly_one_of_summary_and_error() {
    for value in [
        json!({"sha256":"digest","metadata":null,"error":"Cannot parse score"}),
        json!({"sha256":"digest","metadata":{"title":"Study","artist":"Author","album":"","trackNames":["Lead"],"metadataTruncated":false},"error":null}),
    ] {
        let result: MetadataResult = serde_json::from_value(value.clone()).unwrap();
        assert!(result.validate().is_ok());
        roundtrip::<MetadataResult>(value);
    }
    for value in [
        json!({"sha256":"digest","metadata":null,"error":null}),
        json!({"sha256":"digest","metadata":{"title":"","artist":"","album":"","trackNames":[],"metadataTruncated":false},"error":"Failure"}),
    ] {
        let result: MetadataResult = serde_json::from_value(value).unwrap();
        assert!(result.validate().is_err());
    }
}

#[test]
fn snapshots_batches_and_events_reject_unknown_fields_and_future_values() {
    reject_extra::<LibraryMetadata>(
        json!({"title":"","artist":"","album":"","trackNames":[],"metadataTruncated":false}),
    );
    reject_extra::<LibrarySnapshot>(
        json!({"version":1,"revision":0,"welcomeSeen":false,"recents":[],"roots":[],"templates":[],"examples":[],"warning":null}),
    );
    reject_extra::<BundledLibrary>(json!({"templates":[],"examples":[]}));
    reject_extra::<LibraryPage>(json!({"indexRevision":0,"total":0,"rows":[],"warning":null}));
    reject_extra::<MetadataResult>(json!({"sha256":"digest","metadata":null,"error":"Failure"}));
    reject_extra::<FileLibraryChangedEvent>(json!({"revision":0,"warning":null}));
    reject_extra::<ScoreFilesDroppedEvent>(json!({"dropToken":"d","count":2}));
    let scan = json!({"jobId":"j","rootId":"r","configurationRevision":1,"phase":"parsing","discovered":2,"processed":1,"skipped":0,"issues":[]});
    roundtrip::<LibraryBatch>(
        json!({"scan":scan,"files":[{"fileId":"f","filename":"score.gp"}],"done":false}),
    );
    reject_extra::<LibraryScan>(scan.clone());
    reject_extra::<LibraryBatch>(json!({"scan":scan,"files":[],"done":true}));
    assert!(serde_json::from_value::<LibraryBatch>(json!({"scan":scan,"files":[{"fileId":"f","filename":"score.gp","path":"outside.gp"}],"done":false})).is_err());
    let mut future_scan = scan;
    future_scan["phase"] = json!("suspended");
    assert!(serde_json::from_value::<LibraryScan>(future_scan).is_err());
    assert!(serde_json::from_value::<LibrarySnapshot>(json!({"version":2,"revision":0,"welcomeSeen":false,"recents":[],"roots":[],"templates":[],"examples":[],"warning":null})).is_err());
    assert!(serde_json::from_value::<LibraryRoot>(json!({"id":"r","path":"scores","configurationRevision":0,"availability":"future","indexedAtUnixMs":null})).is_err());
    assert!(
        serde_json::from_value::<LibraryQuery>(
            json!({"rootId":null,"text":"","sort":"filename","offset":0,"limit":100})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<LibraryContent>(json!({"id":"t","title":"","description":"","instruments":[],"origin":"download","license":null,"sha256":"digest"})).is_err());
    assert!(serde_json::from_value::<LibraryResult>(json!({"id":"f","rootId":"r","path":"score.gp","metadata":null,"status":"future","modifiedUnixMs":null})).is_err());
}
