use crate::project::{Project, ProjectError};
use atomic_write_file::AtomicWriteFile;
use std::{io::Write, path::Path};

pub fn read_project(path: &Path) -> Result<Project, ProjectError> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|err| format!("Invalid project: {err}"))?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(1)
    {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct LegacyProject {
            format: String,
            schema_version: u32,
            engine_version: String,
            base: crate::project::BaseDocument,
            edits: Vec<crate::project::EditCommand>,
        }
        let legacy: LegacyProject = serde_json::from_value(value.clone())
            .map_err(|err| format!("Invalid project: {err}"))?;
        value = serde_json::json!({"format":legacy.format,"schemaVersion":legacy.schema_version + 1,
            "engineVersion":legacy.engine_version,"base":legacy.base,"edits":legacy.edits,"assets":{}});
    }
    let project: Project =
        serde_json::from_value(value).map_err(|err| format!("Invalid project: {err}"))?;
    project.validate()?;
    Ok(project)
}

pub fn write_project(path: &Path, project: &Project) -> Result<(), ProjectError> {
    project.validate()?;
    let bytes = serde_json::to_vec_pretty(project).map_err(|err| err.to_string())?;
    write_bytes(path, &bytes)
}

pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), ProjectError> {
    let mut file = AtomicWriteFile::open(path).map_err(|err| err.to_string())?;
    file.write_all(bytes).map_err(|err| err.to_string())?;
    file.commit().map_err(|err| err.to_string())
}
