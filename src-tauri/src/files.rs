use crate::project::{Project, ProjectError};
use atomic_write_file::AtomicWriteFile;
use std::{io::Write, path::Path};

pub fn read_project(path: &Path) -> Result<Project, ProjectError> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    let project: Project =
        serde_json::from_slice(&bytes).map_err(|err| format!("Invalid project: {err}"))?;
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
