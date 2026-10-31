use crate::password_crypto::{is_sealed, seal};
use crate::project::{Project, ProjectError};
use atomic_write_file::AtomicWriteFile;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};
use zeroize::Zeroizing;

/// Why a sealed file cannot be read without its password. Opening one goes through the document workspace.
pub const PASSWORD_NEEDED: &str =
    "This project is password-protected. Open it in TabPlayer to enter its password.";

pub fn read_project_with_digest(path: &Path) -> Result<(Project, String), ProjectError> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    if is_sealed(&bytes) {
        return Err(PASSWORD_NEEDED.into());
    }
    let project: Project =
        serde_json::from_slice(&bytes).map_err(|err| format!("Invalid project: {err}"))?;
    project.validate()?;
    Ok((project, format!("{:x}", Sha256::digest(&bytes))))
}

pub fn read_project(path: &Path) -> Result<Project, ProjectError> {
    read_project_with_digest(path).map(|(project, _)| project)
}

/// Writes the project, sealed under its password to open when it has one. The digest is of the bytes in the file.
pub fn write_project_with_digest(path: &Path, project: &Project) -> Result<String, ProjectError> {
    project.validate()?;
    let mut json =
        Zeroizing::new(serde_json::to_vec_pretty(project).map_err(|err| err.to_string())?);
    let bytes = match &project.open_lock {
        Some(lock) => seal(lock, &json)?,
        None => std::mem::take(&mut *json),
    };
    write_bytes(path, &bytes)?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

pub fn write_project(path: &Path, project: &Project) -> Result<(), ProjectError> {
    write_project_with_digest(path, project).map(|_| ())
}

pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), ProjectError> {
    let mut file = AtomicWriteFile::open(path).map_err(|err| err.to_string())?;
    file.write_all(bytes).map_err(|err| err.to_string())?;
    file.commit().map_err(|err| err.to_string())
}
