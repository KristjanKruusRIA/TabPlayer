use crate::{
    project::Project,
    workspace::{DocumentIntake, DocumentWorkspace},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

const SCORE_LIMIT: u64 = 64 * 1024 * 1024;
const PROJECT_LIMIT: u64 = 512 * 1024 * 1024;
const CHANGED: &str = "The score changed while it was being read. Retry opening it.";

pub fn read_candidate(
    path: PathBuf,
    workspace: &Mutex<DocumentWorkspace>,
) -> Result<DocumentIntake, String> {
    read_candidate_checked(path, workspace, None, || Ok(()))
}

pub(crate) fn read_candidate_checked(
    path: PathBuf,
    workspace: &Mutex<DocumentWorkspace>,
    scope: Option<&Path>,
    admit: impl Fn() -> Result<(), String>,
) -> Result<DocumentIntake, String> {
    read_candidate_using(path, workspace, scope, admit, read_stable)
}

fn read_candidate_using(
    path: PathBuf,
    workspace: &Mutex<DocumentWorkspace>,
    scope: Option<&Path>,
    admit: impl Fn() -> Result<(), String>,
    read: impl FnOnce(&Path, Option<&Path>, u64) -> Result<(PathBuf, Vec<u8>), String>,
) -> Result<DocumentIntake, String> {
    {
        let state = workspace.lock().map_err(|error| error.to_string())?;
        admit()?;
        check_admission(&state)?;
        if let Some(document_id) = state.find_open_path(&path) {
            return Ok(DocumentIntake::Existing { document_id });
        }
    }
    let native = path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tabplayer"));
    let (original, bytes) = read(
        &path,
        scope,
        if native { PROJECT_LIMIT } else { SCORE_LIMIT },
    )?;
    let (project, native_path, digest) = if native {
        let project: Project =
            serde_json::from_slice(&bytes).map_err(|error| format!("Invalid project: {error}"))?;
        project.validate()?;
        (
            project,
            Some(path.clone()),
            Some(format!("{:x}", Sha256::digest(&bytes))),
        )
    } else {
        (
            Project::from_file(original.to_string_lossy().into_owned(), &bytes),
            None,
            None,
        )
    };
    if scope.is_some() && resolve(&path, scope)? != original {
        return Err(CHANGED.into());
    }
    let mut state = workspace.lock().map_err(|error| error.to_string())?;
    admit()?;
    check_admission(&state)?;
    state
        .stage_document_with_digest(project, native_path, digest)
        .map(|candidate| DocumentIntake::Candidate { candidate })
}

fn check_admission(workspace: &DocumentWorkspace) -> Result<(), String> {
    if workspace.is_frozen() {
        Err("The workspace is completing a session transition.".into())
    } else {
        Ok(())
    }
}

fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn reject_links(path: &Path) -> Result<(), String> {
    let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component);
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if reparse(&metadata) {
            return Err(
                "Indexed score paths cannot contain symbolic links or reparse points.".into(),
            );
        }
    }
    Ok(())
}

fn component_prefix(path: &Path, root: &Path) -> bool {
    let mut components = path.components();
    root.components().all(|component| {
        components.next().is_some_and(|next| {
            #[cfg(windows)]
            {
                component.as_os_str().eq_ignore_ascii_case(next.as_os_str())
            }
            #[cfg(not(windows))]
            {
                component == next
            }
        })
    })
}

fn resolve(path: &Path, scope: Option<&Path>) -> Result<PathBuf, String> {
    let root = if let Some(root) = scope {
        reject_links(root)?;
        reject_links(path)?;
        let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
        if !fs::metadata(&root)
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            return Err("The configured score folder is no longer a directory.".into());
        }
        Some(root)
    } else {
        None
    };
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if root
        .as_ref()
        .is_some_and(|root| !component_prefix(&canonical, root))
    {
        return Err("The score is outside its configured folder.".into());
    }
    if !fs::metadata(&canonical)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Choose a regular score file.".into());
    }
    Ok(canonical)
}

fn stamp(metadata: Metadata) -> Result<(u64, SystemTime), String> {
    if !metadata.is_file() {
        return Err("Choose a regular score file.".into());
    }
    Ok((
        metadata.len(),
        metadata.modified().map_err(|error| error.to_string())?,
    ))
}

fn read_stable(
    path: &Path,
    scope: Option<&Path>,
    limit: u64,
) -> Result<(PathBuf, Vec<u8>), String> {
    let original = resolve(path, scope)?;
    let file = File::open(&original).map_err(|error| error.to_string())?;
    let bytes = read_file(&file, &mut &file, path, scope, &original, limit)?;
    Ok((original, bytes))
}

fn read_file(
    file: &File,
    reader: &mut impl Read,
    path: &Path,
    scope: Option<&Path>,
    original: &Path,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let before = stamp(file.metadata().map_err(|error| error.to_string())?)?;
    if before.0 > limit {
        return Err(format!(
            "Score exceeds the {} MiB input limit.",
            limit / (1024 * 1024)
        ));
    }
    let bytes = read_bounded(reader, before.0)?;
    let current = resolve(path, scope)?;
    if current != original
        || stamp(file.metadata().map_err(|error| error.to_string())?)? != before
        || stamp(fs::metadata(&current).map_err(|error| error.to_string())?)? != before
    {
        return Err(CHANGED.into());
    }
    Ok(bytes)
}

fn read_bounded(reader: &mut impl Read, length: u64) -> Result<Vec<u8>, String> {
    let length = usize::try_from(length).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(length);
    let mut buffer = [0; 64 * 1024];
    loop {
        let remaining = length - bytes.len();
        let chunk = buffer.len().min(remaining + 1);
        let count = reader
            .read(&mut buffer[..chunk])
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return if bytes.len() == length {
                Ok(bytes)
            } else {
                Err(CHANGED.into())
            };
        }
        if count > remaining {
            return Err(CHANGED.into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};

    #[test]
    fn bounded_read_accepts_the_exact_observed_size() {
        assert_eq!(
            read_bounded(&mut Cursor::new(b"music"), 5).unwrap(),
            b"music"
        );
        assert_eq!(read_bounded(&mut Cursor::new(b""), 0).unwrap(), b"");
    }

    #[test]
    fn bounded_read_stops_after_one_sentinel_byte_when_the_file_grows() {
        let mut reader = Cursor::new(b"music plus unexpected bytes");
        assert!(read_bounded(&mut reader, 5).is_err());
        assert_eq!(reader.position(), 6);
    }

    #[test]
    fn bounded_read_rejects_a_file_that_shrinks() {
        assert!(read_bounded(&mut Cursor::new(b"tiny"), 5).is_err());
    }

    #[test]
    fn freeze_after_actual_read_rejects_final_staging_with_the_workspace_lock_released() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("score.gp");
        fs::write(&path, b"music").unwrap();
        let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
        let before = workspace.lock().unwrap().snapshot();
        let result = read_candidate_using(
            path,
            &workspace,
            None,
            || Ok(()),
            |path, scope, limit| {
                let result = read_stable(path, scope, limit)?;
                workspace.try_lock().unwrap().freeze().unwrap();
                Ok(result)
            },
        );
        assert!(result.is_err());
        assert!(workspace.lock().unwrap().is_frozen());
        assert_eq!(workspace.lock().unwrap().snapshot(), before);
    }

    struct DuringRead<'a, F> {
        file: &'a File,
        change: Option<F>,
    }

    impl<F: FnOnce()> Read for DuringRead<'_, F> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let count = self.file.read(buffer)?;
            if let Some(change) = self.change.take() {
                change();
            }
            Ok(count)
        }
    }

    #[test]
    fn changed_file_is_rejected_after_actual_chunked_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("score.gp");
        fs::write(&path, vec![0; 2 * 64 * 1024]).unwrap();
        let file = File::open(&path).unwrap();
        let writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
        let mut reader = DuringRead {
            file: &file,
            change: Some(|| writer.set_len(3 * 64 * 1024).unwrap()),
        };
        let error = read_file(
            &file,
            &mut reader,
            &path,
            None,
            &fs::canonicalize(&path).unwrap(),
            SCORE_LIMIT,
        )
        .unwrap_err();
        assert!(error.contains("changed"), "{error}");
    }

    #[test]
    fn replaced_path_is_rejected_after_reading_the_original_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("score.gp");
        fs::write(&path, b"original music").unwrap();
        let file = File::open(&path).unwrap();
        let mut reader = DuringRead {
            file: &file,
            change: Some(|| {
                fs::rename(&path, directory.path().join("moved.gp")).unwrap();
                fs::write(&path, b"different").unwrap();
            }),
        };
        let error = read_file(
            &file,
            &mut reader,
            &path,
            None,
            &fs::canonicalize(&path).unwrap(),
            SCORE_LIMIT,
        )
        .unwrap_err();
        assert!(error.contains("changed"), "{error}");
    }
}
