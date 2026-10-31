use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tabplayer_lib::{
    project::{Project, ProjectSession},
    workspace::{AudioOwner, CloseDocument, DocumentIntake, DocumentRevision, DocumentSnapshot},
};

fn check_cases<T: DeserializeOwned + Serialize>(group: &str) {
    let cases: Value =
        serde_json::from_str(include_str!("../../tests/document-workspace-protocol.json")).unwrap();
    for case in cases[group].as_array().unwrap() {
        let result = serde_json::from_value::<T>(case["value"].clone());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{group}: {}",
            case["name"]
        );
        if let Ok(value) = result {
            assert_eq!(serde_json::to_value(value).unwrap(), case["value"]);
        }
    }
}

#[test]
fn document_addresses_are_strict_and_revision_is_safe() {
    check_cases::<DocumentRevision>("revisions");
    check_cases::<CloseDocument>("closes");
}

#[test]
fn audio_owner_requires_both_nonempty_identities() {
    check_cases::<AudioOwner>("owners");
}

#[test]
fn addressed_snapshot_preserves_existing_inner_snapshot() {
    let snapshot = ProjectSession::new(Project::blank(), None)
        .unwrap()
        .snapshot();
    let record = DocumentSnapshot {
        document_id: "document-test-1".into(),
        revision: 0,
        snapshot: snapshot.clone(),
    };
    assert_eq!(
        serde_json::to_value(record).unwrap(),
        json!({"documentId":"document-test-1","revision":0,"snapshot":snapshot})
    );
    assert_eq!(
        serde_json::to_value(DocumentIntake::Existing {
            document_id: "document-test-1".into()
        })
        .unwrap(),
        json!({"kind":"existing","documentId":"document-test-1"})
    );
}
