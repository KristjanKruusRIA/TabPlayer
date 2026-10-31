use serde::{Deserialize, Deserializer, Serialize, de::Error};
use std::path::PathBuf;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn safe_unsigned<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > MAX_SAFE_INTEGER {
        return Err(D::Error::custom(
            "Library number exceeds the safe integer limit.",
        ));
    }
    Ok(value)
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn nullable_safe_unsigned<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|value| value > MAX_SAFE_INTEGER) {
        return Err(D::Error::custom(
            "Library number exceeds the safe integer limit.",
        ));
    }
    Ok(value)
}

fn version_one<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if value != 1 {
        return Err(D::Error::custom("Unsupported file-library version."));
    }
    Ok(value)
}

fn page_limit<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if value != 100 {
        return Err(D::Error::custom("Library page limit must be 100."));
    }
    Ok(value)
}

fn catalog_format<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value != "TabPlayerFileLibrary" {
        return Err(D::Error::custom("Unsupported file-library format."));
    }
    Ok(value)
}

fn lowercase_sha256<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(D::Error::custom("Expected a lowercase SHA-256 digest."));
    }
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibrarySection {
    Recent,
    Templates,
    Folders,
    Examples,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LibrarySource {
    Recent { id: String },
    Indexed { root_id: String, id: String },
    Template { id: String },
    Example { id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryMetadata {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub track_names: Vec<String>,
    pub metadata_truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryAvailability {
    Available,
    Missing,
    Unreadable,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentEntry {
    pub id: String,
    pub path: String,
    #[serde(deserialize_with = "required_nullable")]
    pub metadata: Option<LibraryMetadata>,
    pub pinned: bool,
    #[serde(deserialize_with = "safe_unsigned")]
    pub last_opened_unix_ms: u64,
    pub availability: LibraryAvailability,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryRoot {
    pub id: String,
    pub path: String,
    #[serde(deserialize_with = "safe_unsigned")]
    pub configuration_revision: u64,
    pub availability: LibraryAvailability,
    #[serde(deserialize_with = "nullable_safe_unsigned")]
    pub indexed_at_unix_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryContentOrigin {
    Factory,
    Personal,
    Example,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryContent {
    pub id: String,
    pub title: String,
    pub description: String,
    pub instruments: Vec<String>,
    pub origin: LibraryContentOrigin,
    #[serde(deserialize_with = "required_nullable")]
    pub license: Option<String>,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibrarySnapshot {
    #[serde(deserialize_with = "version_one")]
    pub version: u32,
    #[serde(deserialize_with = "safe_unsigned")]
    pub revision: u64,
    pub welcome_seen: bool,
    pub recents: Vec<RecentEntry>,
    pub roots: Vec<LibraryRoot>,
    pub templates: Vec<LibraryContent>,
    pub examples: Vec<LibraryContent>,
    #[serde(deserialize_with = "required_nullable")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundledLibrary {
    pub templates: Vec<LibraryContent>,
    pub examples: Vec<LibraryContent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LibraryChange {
    Pin { id: String, pinned: bool },
    RemoveRecent { id: String },
    RemoveRoot { id: String },
    RenameTemplate { id: String, name: String },
    RemoveTemplate { id: String },
    WelcomeSeen {},
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibrarySort {
    Title,
    Artist,
    Modified,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryQuery {
    #[serde(deserialize_with = "required_nullable")]
    pub root_id: Option<String>,
    pub text: String,
    /// Field filters over the indexed metadata. Each is a case-insensitive
    /// substring match (all whitespace-separated words) and empty means unfiltered.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub artist: String,
    /// Matches indexed track names; the index holds no instrument or genre field.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instrument: String,
    pub sort: LibrarySort,
    pub offset: u32,
    #[serde(deserialize_with = "page_limit")]
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryResultStatus {
    Indexed,
    MetadataUnavailable,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryResult {
    pub id: String,
    pub root_id: String,
    pub path: String,
    #[serde(deserialize_with = "required_nullable")]
    pub metadata: Option<LibraryMetadata>,
    pub status: LibraryResultStatus,
    #[serde(deserialize_with = "nullable_safe_unsigned")]
    pub modified_unix_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPage {
    #[serde(deserialize_with = "safe_unsigned")]
    pub index_revision: u64,
    pub total: u32,
    pub rows: Vec<LibraryResult>,
    #[serde(deserialize_with = "required_nullable")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryScanPhase {
    Enumerating,
    Reading,
    Parsing,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryScan {
    pub job_id: String,
    pub root_id: String,
    #[serde(deserialize_with = "safe_unsigned")]
    pub configuration_revision: u64,
    pub phase: LibraryScanPhase,
    pub discovered: u32,
    pub processed: u32,
    pub skipped: u32,
    pub issues: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryScanFile {
    pub file_id: String,
    pub filename: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryBatch {
    pub scan: LibraryScan,
    pub files: Vec<LibraryScanFile>,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MetadataEdit {
    SetScoreInfo { title: String, artist: String },
    SetScoreMetadata { album: String },
    SetTrackInfo { track: u32, name: String },
    AddTrack { name: String },
    AddPitchedTrack { name: String },
    AddPercussionTrack { name: String },
    RemoveTrack { track: u32 },
    MoveTrack { track: u32, to: u32 },
    DuplicateTrack { track: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MetadataBase {
    Blank { title: String, artist: String },
    File { bytes_base64: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataInput {
    pub sha256: String,
    pub base: MetadataBase,
    pub edits: Vec<MetadataEdit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataResult {
    pub sha256: String,
    #[serde(deserialize_with = "required_nullable")]
    pub metadata: Option<LibraryMetadata>,
    #[serde(deserialize_with = "required_nullable")]
    pub error: Option<String>,
}

impl MetadataResult {
    pub fn validate(&self) -> Result<(), String> {
        if self.metadata.is_some() == self.error.is_some() {
            return Err("Metadata result must contain either metadata or an error.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileLibraryChangedEvent {
    #[serde(deserialize_with = "safe_unsigned")]
    pub revision: u64,
    #[serde(deserialize_with = "required_nullable")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreFilesDroppedEvent {
    pub drop_token: String,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentReceipt {
    pub path: PathBuf,
    pub digest: String,
    pub opened_at_unix_ms: u64,
    pub metadata: Option<LibraryMetadata>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Catalog {
    #[serde(deserialize_with = "catalog_format")]
    pub format: String,
    #[serde(deserialize_with = "version_one")]
    pub version: u32,
    #[serde(deserialize_with = "safe_unsigned")]
    pub revision: u64,
    pub welcome_seen: bool,
    pub recents: Vec<CatalogRecent>,
    pub roots: Vec<CatalogRoot>,
    pub templates: Vec<CatalogTemplate>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogRecent {
    pub id: String,
    pub path: PathBuf,
    #[serde(deserialize_with = "lowercase_sha256")]
    pub digest: String,
    #[serde(deserialize_with = "required_nullable")]
    pub metadata: Option<LibraryMetadata>,
    pub pinned: bool,
    #[serde(deserialize_with = "safe_unsigned")]
    pub last_opened_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogRoot {
    #[serde(deserialize_with = "lowercase_sha256")]
    pub id: String,
    pub path: PathBuf,
    #[serde(deserialize_with = "safe_unsigned")]
    pub configuration_revision: u64,
    #[serde(deserialize_with = "nullable_safe_unsigned")]
    pub indexed_at_unix_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogTemplate {
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "lowercase_sha256")]
    pub sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn catalog() -> Value {
        json!({
            "format":"TabPlayerFileLibrary","version":1,"revision":0,"welcomeSeen":false,
            "recents":[{"id":"recent-1","path":"score.gp","digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","metadata":null,"pinned":true,"lastOpenedUnixMs":1}],
            "roots":[{"id":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","path":"scores","configurationRevision":1,"indexedAtUnixMs":null}],
            "templates":[{"id":"template-1","name":"Study","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]
        })
    }

    #[test]
    fn catalog_preserves_native_records_but_rejects_future_and_derived_fields() {
        let literal = catalog();
        let decoded: Catalog = serde_json::from_value(literal.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), literal);
        for field in ["format", "version", "revision", "welcomeSeen"] {
            let mut missing = catalog();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<Catalog>(missing).is_err(),
                "{field}"
            );
        }
        for (field, value) in [
            ("format", json!("FutureLibrary")),
            ("version", json!(2)),
            ("revision", json!(9_007_199_254_740_992u64)),
            ("futureField", json!(true)),
        ] {
            let mut invalid = catalog();
            invalid[field] = value;
            assert!(
                serde_json::from_value::<Catalog>(invalid).is_err(),
                "{field}"
            );
        }
        for collection in ["recents", "roots", "templates"] {
            let mut invalid = catalog();
            invalid[collection][0]["availability"] = json!("available");
            assert!(serde_json::from_value::<Catalog>(invalid).is_err());
        }
        let mut missing_metadata = catalog();
        missing_metadata["recents"][0]
            .as_object_mut()
            .unwrap()
            .remove("metadata");
        assert!(serde_json::from_value::<Catalog>(missing_metadata).is_err());
        let mut missing_indexed_time = catalog();
        missing_indexed_time["roots"][0]
            .as_object_mut()
            .unwrap()
            .remove("indexedAtUnixMs");
        assert!(serde_json::from_value::<Catalog>(missing_indexed_time).is_err());
    }

    #[test]
    fn catalog_digests_and_root_ids_cannot_form_unsafe_payload_or_index_paths() {
        for value in [
            "",
            "../catalog",
            "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg",
        ] {
            for (collection, field) in [
                ("recents", "digest"),
                ("roots", "id"),
                ("templates", "sha256"),
            ] {
                let mut invalid = catalog();
                invalid[collection][0][field] = json!(value);
                assert!(
                    serde_json::from_value::<Catalog>(invalid).is_err(),
                    "{collection}.{field}: {value}"
                );
            }
        }
    }
}
