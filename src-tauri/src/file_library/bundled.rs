use super::types::{BundledLibrary, LibraryContent, LibraryContentOrigin};
use crate::project::Project;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PROJECT_BYTES: u64 = 512 * 1024 * 1024;
const TEMPLATE_IDS: [&str; 10] = [
    "factory-guitar-6",
    "factory-guitar-7",
    "factory-guitar-8",
    "factory-guitar-9",
    "factory-bass-4",
    "factory-bass-5",
    "factory-bass-6",
    "factory-keys",
    "factory-drums",
    "factory-band",
];
const EXAMPLE_IDS: [&str; 3] = [
    "example-windowline",
    "example-seven-steps-five-echoes",
    "example-lantern-counterpoint",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    templates: Vec<Entry>,
    examples: Vec<Entry>,
    documents: Vec<Document>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    title: String,
    description: String,
    instruments: Vec<String>,
    origin: LibraryContentOrigin,
    license: String,
    sha256: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    path: String,
    sha256: String,
}

impl Entry {
    fn descriptor(&self) -> LibraryContent {
        LibraryContent {
            id: self.id.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            instruments: self.instruments.clone(),
            origin: self.origin.clone(),
            license: Some(self.license.clone()),
            sha256: self.sha256.clone(),
        }
    }
}

pub struct BundledContent {
    directory: PathBuf,
    manifest: Manifest,
}

impl BundledContent {
    pub fn load(directory: PathBuf) -> Result<Self, String> {
        inspect(&directory, true)?;
        let bytes = read_bounded(&directory.join("manifest.json"), MAX_MANIFEST_BYTES)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid bundled library manifest: {error}"))?;
        if manifest.format != "TabPlayerBundledLibrary" || manifest.version != 1 {
            return Err("Unsupported bundled library manifest.".into());
        }
        let mut ids = HashSet::new();
        for (entries, known, kind, origin) in [
            (
                &manifest.templates,
                TEMPLATE_IDS.as_slice(),
                "templates",
                LibraryContentOrigin::Factory,
            ),
            (
                &manifest.examples,
                EXAMPLE_IDS.as_slice(),
                "examples",
                LibraryContentOrigin::Example,
            ),
        ] {
            if entries.len() != known.len() {
                return Err(format!("Missing or unknown bundled {kind} inventory."));
            }
            for item in entries {
                if !known.contains(&item.id.as_str())
                    || !ids.insert(item.id.as_str())
                    || item.path != format!("{kind}/{}.tabplayer", item.id)
                    || item.origin != origin
                    || item.license != "CC0-1.0"
                    || !digest(&item.sha256)
                    || !text(&item.title)
                    || !text(&item.description)
                    || item.instruments.is_empty()
                    || item.instruments.len() > 16
                    || !item.instruments.iter().all(|name| text(name))
                {
                    return Err("Invalid bundled library descriptor, ID or resource path.".into());
                }
            }
        }
        let mut paths = HashSet::new();
        if manifest.documents.len() != 2 {
            return Err("Missing bundled library dedication/license inventory.".into());
        }
        for document in &manifest.documents {
            if !["README.md", "CC0-1.0.txt"].contains(&document.path.as_str())
                || !paths.insert(document.path.as_str())
                || !digest(&document.sha256)
            {
                return Err("Invalid bundled library document path or hash.".into());
            }
            read_hashed(
                &directory.join(&document.path),
                &document.sha256,
                MAX_MANIFEST_BYTES,
            )?;
        }
        let content = Self {
            directory,
            manifest,
        };
        for item in content
            .manifest
            .templates
            .iter()
            .chain(&content.manifest.examples)
        {
            content.project(&item.id, item.origin.clone())?;
        }
        Ok(content)
    }

    pub fn descriptors(&self) -> BundledLibrary {
        BundledLibrary {
            templates: self
                .manifest
                .templates
                .iter()
                .map(Entry::descriptor)
                .collect(),
            examples: self
                .manifest
                .examples
                .iter()
                .map(Entry::descriptor)
                .collect(),
        }
    }

    pub fn project(&self, id: &str, origin: LibraryContentOrigin) -> Result<Project, String> {
        let entries = match origin {
            LibraryContentOrigin::Factory => &self.manifest.templates,
            LibraryContentOrigin::Example => &self.manifest.examples,
            LibraryContentOrigin::Personal => {
                return Err("Personal templates are not bundled content.".into());
            }
        };
        let item = entries
            .iter()
            .find(|item| item.id == id)
            .ok_or("Unknown bundled library content ID or kind.")?;
        let bytes = read_hashed(
            &self.directory.join(&item.path),
            &item.sha256,
            MAX_PROJECT_BYTES,
        )?;
        // Unlike ordinary user-file admission, bundled resources must already be schema 3.
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid bundled project: {error}"))?;
        if value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(3)
        {
            return Err("Bundled project must use schema 3.".into());
        }
        let project: Project = serde_json::from_value(value)
            .map_err(|error| format!("Invalid bundled project: {error}"))?;
        project.validate()?;
        Ok(project)
    }
}

fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.encode_utf16().count() <= 2048
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn inspect(path: &Path, directory: bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Bundled library resource path must be absolute.".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => return Err("Invalid bundled library resource path.".into()),
            Component::CurDir => continue,
            Component::Prefix(_) | Component::RootDir => {
                current.push(component);
                continue;
            }
            Component::Normal(_) => current.push(component),
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("Cannot inspect bundled library resource: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Bundled library symlink/junction resources are not allowed.".into());
        }
        if current != path || directory {
            if !metadata.is_dir() {
                return Err("Bundled library resource directory is not regular.".into());
            }
        } else if !metadata.is_file() {
            return Err("Bundled library resource must be a regular file.".into());
        }
    }
    Ok(())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    inspect(path, false)?;
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Cannot open bundled library resource: {error}"))?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    if !before.is_file() || before.len() > limit {
        return Err("Bundled library resource exceeds its file/size limit.".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    if bytes.len() as u64 != before.len()
        || bytes.len() as u64 > limit
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("Bundled library resource changed while being read.".into());
    }
    Ok(bytes)
}

fn read_hashed(path: &Path, sha256: &str, limit: u64) -> Result<Vec<u8>, String> {
    let bytes = read_bounded(path, limit)?;
    if format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err("Bundled library resource hash mismatch.".into());
    }
    Ok(bytes)
}
