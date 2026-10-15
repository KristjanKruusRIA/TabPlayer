use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};
use tabplayer_lib::file_library::{metadata_input::MetadataInputReader, types::MetadataBase};

fn project(version: u32) -> Value {
    let mut value = json!({
        "format":"TabPlayer","schemaVersion":version,"engineVersion":"1.8.4",
        "base":{"kind":"blank","title":"Study","artist":"Author","tempo":120,"tuning":[64,59,55,50,45,40],"measureCount":4},
        "edits":[]
    });
    if version >= 2 {
        value["assets"] = json!({});
    }
    if version == 3 {
        value["baselineEdits"] = json!([]);
    }
    value
}

fn read_value(directory: &Path, value: &Value) -> Result<Value, String> {
    let path = directory.join("score.tabplayer");
    fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
    MetadataInputReader::read(&path).map(|value| serde_json::to_value(value).unwrap())
}

#[test]
fn metadata_projection_preserves_baseline_then_applied_order_and_hashes_source_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let mut value = project(3);
    value["baselineEdits"] = json!([
        {"type":"setScoreInfo","title":"","artist":"Artist","tempo":90},
        {"type":"addTrack","name":"Guitar","tuning":[64,59,55,50,45,40],"program":25},
        {"type":"setScoreMetadata","fields":{"subTitle":"","album":"Album","words":"","music":"","copyright":"","tab":"","notices":"","instructions":""}}
    ]);
    value["edits"] = json!([
        {"type":"setTrackInfo","track":0,"name":"Lead","shortName":"L","program":25},
        {"type":"addPitchedTrack","name":"Keys","program":0},
        {"type":"addPercussionTrack","name":"Drums","program":0},
        {"type":"removeTrack","track":1},
        {"type":"setBeatText","target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"text":"Ignored"}
    ]);
    let actual = read_value(directory.path(), &value).unwrap();
    assert_eq!(
        actual["base"],
        json!({"kind":"blank","title":"Study","artist":"Author"})
    );
    assert_eq!(
        actual["edits"],
        json!([
            {"type":"setScoreInfo","title":"","artist":"Artist"},
            {"type":"addTrack","name":"Guitar"},
            {"type":"setScoreMetadata","album":"Album"},
            {"type":"setTrackInfo","track":0,"name":"Lead"},
            {"type":"addPitchedTrack","name":"Keys"},
            {"type":"addPercussionTrack","name":"Drums"},
            {"type":"removeTrack","track":1}
        ])
    );
    assert_eq!(
        actual["sha256"],
        format!(
            "{:x}",
            Sha256::digest(fs::read(directory.path().join("score.tabplayer")).unwrap())
        )
    );
}

#[test]
fn legacy_projection_has_no_baseline_and_file_base_has_only_original_score_bytes() {
    let directory = tempfile::tempdir().unwrap();
    for version in [1, 2, 3] {
        let bytes = b"original score bytes";
        let mut value = project(version);
        value["base"] = json!({"kind":"file","filename":"original.gp","bytesBase64":STANDARD.encode(bytes),"sha256":format!("{:x}",Sha256::digest(bytes))});
        value["edits"] =
            json!([{"type":"setTrackInfo","track":0,"name":"Renamed","shortName":"R","program":1}]);
        let actual = read_value(directory.path(), &value).unwrap();
        assert_eq!(
            actual["base"],
            json!({"kind":"file","bytesBase64":STANDARD.encode(bytes)})
        );
        assert_eq!(
            actual["edits"],
            json!([{"type":"setTrackInfo","track":0,"name":"Renamed"}])
        );
    }
}

#[test]
fn direct_score_bytes_are_bounded_and_have_an_exact_digest() {
    let directory = tempfile::tempdir().unwrap();
    for suffix in ["gp", "GPX", "gp3", "gp4", "gp5", "xml", "musicxml", "mxl"] {
        let path = directory.path().join(format!("score.{suffix}"));
        let bytes = [0, 1, 2, 255, b'\n'];
        fs::write(&path, bytes).unwrap();
        let input = MetadataInputReader::read(&path).unwrap();
        assert_eq!(input.sha256, format!("{:x}", Sha256::digest(bytes)));
        assert_eq!(
            input.base,
            MetadataBase::File {
                bytes_base64: STANDARD.encode(bytes)
            }
        );
        assert!(input.edits.is_empty());
    }
    for (filename, limit) in [
        ("large.gp", 64_u64 * 1024 * 1024),
        ("large.tabplayer", 512_u64 * 1024 * 1024),
    ] {
        let path = directory.path().join(filename);
        fs::File::create(&path).unwrap().set_len(limit + 1).unwrap();
        assert!(MetadataInputReader::read(&path).is_err(), "{filename}");
    }
}

#[test]
fn strict_project_and_base_shapes_reject_future_unknown_missing_and_legacy_fields() {
    let directory = tempfile::tempdir().unwrap();
    for version in [1, 2, 3] {
        let mut value = project(version);
        value["future"] = json!(true);
        assert!(read_value(directory.path(), &value).is_err());
        let mut value = project(version);
        value["base"]["future"] = json!(true);
        assert!(read_value(directory.path(), &value).is_err());
        for field in ["format", "schemaVersion", "engineVersion", "base", "edits"] {
            let mut value = project(version);
            value.as_object_mut().unwrap().remove(field);
            assert!(
                read_value(directory.path(), &value).is_err(),
                "{version}:{field}"
            );
        }
    }
    for (version, field) in [(1, "assets"), (1, "baselineEdits"), (2, "baselineEdits")] {
        let mut value = project(version);
        value[field] = if field == "assets" {
            json!({})
        } else {
            json!([])
        };
        assert!(read_value(directory.path(), &value).is_err());
    }
    for (field, replacement) in [
        ("schemaVersion", json!(4)),
        ("schemaVersion", json!(3.5)),
        ("format", json!("Future")),
    ] {
        let mut value = project(3);
        value[field] = replacement;
        assert!(read_value(directory.path(), &value).is_err());
    }
    for field in ["assets", "baselineEdits"] {
        let mut value = project(3);
        value.as_object_mut().unwrap().remove(field);
        assert!(read_value(directory.path(), &value).is_err());
    }
}

#[test]
fn projection_does_not_claim_canonical_music_or_asset_validation() {
    let directory = tempfile::tempdir().unwrap();
    let mut value = project(3);
    value["base"]["tempo"] = json!(-1);
    value["base"]["tuning"] = json!([1000]);
    value["base"]["measureCount"] = json!(0);
    value["assets"] = json!({"unvalidated":{"bytesBase64":"not base64"}});
    value["edits"] = json!([{"type":"futureMusicCommand","payload":"ignored"},{"type":"addTrack","name":"","tuning":[1000],"program":255}]);
    assert_eq!(
        read_value(directory.path(), &value).unwrap()["edits"],
        json!([{"type":"addTrack","name":""}])
    );
}

#[test]
fn malformed_json_relevant_operations_and_corrupt_original_bytes_fail() {
    let directory = tempfile::tempdir().unwrap();
    for edit in [
        json!({"type":"setScoreInfo","title":"Title"}),
        json!({"type":"removeTrack","track":-1}),
        json!({"type":"setTrackInfo","track":0,"name":false}),
        json!({"type":"setScoreMetadata","fields":{"album":null}}),
        json!({"type":4}),
        json!("setScoreInfo"),
    ] {
        let mut value = project(3);
        value["edits"] = json!([edit]);
        assert!(read_value(directory.path(), &value).is_err());
    }
    for (bytes, digest) in [("%%%", "digest"), ("AA==", "wrong")] {
        let mut value = project(3);
        value["base"] =
            json!({"kind":"file","filename":"original.gp","bytesBase64":bytes,"sha256":digest});
        assert!(read_value(directory.path(), &value).is_err());
    }
    for bytes in [
        b"{".as_slice(),
        b"{\"format\":\"TabPlayer\",\"schemaVersion\":3,\"base\":{",
        b"{\"x\":\"\\uD800\"}",
    ] {
        let path = directory.path().join("broken.tabplayer");
        fs::write(&path, bytes).unwrap();
        assert!(MetadataInputReader::read(&path).is_err());
    }
    let path = directory.path().join("duplicate.tabplayer");
    let source = serde_json::to_string(&project(3)).unwrap().replacen(
        "\"format\":\"TabPlayer\"",
        "\"format\":\"TabPlayer\",\"format\":\"TabPlayer\"",
        1,
    );
    fs::write(&path, source).unwrap();
    assert!(MetadataInputReader::read(&path).is_err());
}

#[test]
fn large_assets_and_unrelated_command_strings_are_streamed_without_projection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large.tabplayer");
    let mut file = fs::File::create(&path).unwrap();
    let mut value = project(3);
    value.as_object_mut().unwrap().remove("assets");
    value.as_object_mut().unwrap().remove("edits");
    let prefix = serde_json::to_string(&value).unwrap();
    write!(
        file,
        "{},\"assets\":{{\"backing\":{{\"bytesBase64\":\"",
        &prefix[..prefix.len() - 1]
    )
    .unwrap();
    let chunk = vec![b'A'; 64 * 1024];
    for _ in 0..128 {
        file.write_all(&chunk).unwrap();
    }
    write!(
        file,
        "\"}}}},\"edits\":[{{\"type\":\"setBeatText\",\"text\":\""
    )
    .unwrap();
    for _ in 0..64 {
        file.write_all(&chunk).unwrap();
    }
    write!(file, "\"}},{{\"name\":\"").unwrap();
    for _ in 0..64 {
        file.write_all(&chunk).unwrap();
    }
    write!(file,"\",\"type\":\"futureCommand\"}},{{\"name\":\"Final\",\"track\":0,\"type\":\"setTrackInfo\"}}]}}").unwrap();
    drop(file);
    let input = MetadataInputReader::read(&path).unwrap();
    assert_eq!(
        serde_json::to_value(input.edits).unwrap(),
        json!([{"type":"setTrackInfo","track":0,"name":"Final"}])
    );
    assert_eq!(
        input.sha256,
        format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
    );
}

#[test]
fn emitted_metadata_operations_have_one_aggregate_two_mib_bound() {
    let directory = tempfile::tempdir().unwrap();
    let mut value = project(3);
    value["edits"] = json!([{"type":"setScoreInfo","title":"x".repeat(2*1024*1024),"artist":"Author","tempo":120}]);
    assert!(
        read_value(directory.path(), &value)
            .unwrap_err()
            .contains("2 MiB")
    );
    value["edits"] = json!(vec![json!({"type":"addTrack","name":"Guitar"}); 60_000]);
    assert!(
        read_value(directory.path(), &value)
            .unwrap_err()
            .contains("2 MiB")
    );
    value["edits"] = json!([{"type":"addTrack","name":"\n".repeat(1_100_000)}]);
    assert!(
        read_value(directory.path(), &value)
            .unwrap_err()
            .contains("2 MiB")
    );
    value["baselineEdits"] = json!([{"type":"addTrack","name":"x".repeat(1_100_000)}]);
    value["edits"] = json!([{"type":"addTrack","name":"y".repeat(1_100_000)}]);
    assert!(
        read_value(directory.path(), &value)
            .unwrap_err()
            .contains("2 MiB")
    );
}

#[test]
fn unordered_source_keys_preserve_order_unicode_and_the_complete_byte_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("reordered.tabplayer");
    let source = concat!(
        r#"{
      "edits":[{"name":"Later","track":0,"type":"setTrackInfo"}],
      "assets":{},
      "base":{"measureCount":4,"tuning":[64],"tempo":120,"artist":"\u00c4rtist","title":"Study \ud83c\udfb8","kind":"blank"},
      "baselineEdits":[{"name":"Earlier","type":"addTrack"}],
      "engineVersion":"1.8.4","schemaVersion":3,"format":"TabPlayer"
    }"#,
        " \t\r\n"
    );
    // The trailing bytes are JSON whitespace and belong to the input digest.
    fs::write(&path, source.as_bytes()).unwrap();
    let input = MetadataInputReader::read(&path).unwrap();
    assert_eq!(
        input.base,
        MetadataBase::Blank {
            title: "Study 🎸".into(),
            artist: "Ärtist".into()
        }
    );
    assert_eq!(
        serde_json::to_value(input.edits).unwrap(),
        json!([{"type":"addTrack","name":"Earlier"},{"type":"setTrackInfo","track":0,"name":"Later"}])
    );
    assert_eq!(
        input.sha256,
        format!("{:x}", Sha256::digest(source.as_bytes()))
    );
    fs::write(&path, format!("{source} false")).unwrap();
    assert!(MetadataInputReader::read(&path).is_err());
}

#[test]
fn ignored_commands_are_independent_of_discriminator_and_duplicate_candidate_order() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("unknown.tabplayer");
    for command in [
        r#"{"type":"futureCommand","name":"a","name":"b","fields":{"album":"a","album":"b"}}"#,
        r#"{"name":"a","name":"b","fields":{"album":"a","album":"b"},"type":"futureCommand"}"#,
        r#"{"type":"setBeatText","title":false,"track":null,"fields":{"album":null}}"#,
        r#"{"title":"a","title":"b","name":"Track","type":"addTrack"}"#,
    ] {
        let source = serde_json::to_string(&project(3))
            .unwrap()
            .replace("\"edits\":[]", &format!("\"edits\":[{command}]"));
        fs::write(&path, source).unwrap();
        assert!(MetadataInputReader::read(&path).is_ok(), "{command}");
    }
    for command in [
        r#"{"name":"a","name":"b","type":"addTrack"}"#,
        r#"{"type":"addTrack","name":"a","name":"b"}"#,
        r#"{"type":"futureCommand","type":"futureCommand"}"#,
        r#"{"fields":{"album":"a","album":"b"},"type":"setScoreMetadata"}"#,
        r#"{"name":"Missing type"}"#,
    ] {
        let source = serde_json::to_string(&project(3))
            .unwrap()
            .replace("\"edits\":[]", &format!("\"edits\":[{command}]"));
        fs::write(&path, source).unwrap();
        assert!(MetadataInputReader::read(&path).is_err(), "{command}");
    }
}

#[test]
fn skipped_strings_still_require_complete_valid_json_and_utf8() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid.tabplayer");
    let value = serde_json::to_string(&project(3)).unwrap();
    for suffix in [
        b"\"unterminated".as_slice(),
        b"\"bad\\q\"",
        b"\"bad\\uD800\"",
        b"\"bad\xff\"",
        b"\"raw\nnewline\"",
        b"[1,]",
    ] {
        let prefix = value.replace("\"assets\":{}", "\"assets\":{\"ignored\":REPLACE}");
        let mut bytes = prefix[..prefix.find("REPLACE").unwrap()]
            .as_bytes()
            .to_vec();
        bytes.extend_from_slice(suffix);
        bytes.extend_from_slice(prefix[prefix.find("REPLACE").unwrap() + 7..].as_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(MetadataInputReader::read(&path).is_err(), "{suffix:?}");
    }
}
