use crate::fs_identity::{FileId, file_id_io};
use crate::workspace::same_path;
use std::{
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

#[derive(Clone)]
struct ProtectedRoot {
    path: PathBuf,
    identity: PathBuf,
}

/// Native-owned namespaces that ordinary document and export writes cannot enter.
#[derive(Clone, Default)]
pub struct ProtectedPaths {
    roots: Vec<ProtectedRoot>,
}

impl ProtectedPaths {
    pub fn new(roots: Vec<PathBuf>) -> Result<Self, String> {
        Ok(Self {
            roots: roots
                .into_iter()
                .map(|path| {
                    let path = std::path::absolute(path).map_err(|error| error.to_string())?;
                    let identity = destination_identity(&path)?;
                    Ok(ProtectedRoot { path, identity })
                })
                .collect::<Result<_, String>>()?,
        })
    }

    pub fn check(&self, path: &Path) -> Result<(), String> {
        if self.roots.is_empty() {
            return Ok(());
        }
        let destination = destination_identity(path)?;
        // Atomic writes replace the parent directory's leaf entry, not a symlink target.
        let entry = match path.file_name() {
            Some(filename) => destination_identity(
                path.parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .unwrap_or(Path::new(".")),
            )?
            .join(filename),
            None => destination.clone(),
        };
        for root in &self.roots {
            let current = destination_identity(&root.path)?;
            if [&destination, &entry].iter().any(|destination| {
                within(destination, &root.identity) || within(destination, &current)
            }) {
                return Err(
                    "Choose a destination outside TabPlayer's protected library and recovery storage."
                        .into(),
                );
            }
            // Names differ for one folder (a share spelling of this machine, for one), so compare the folders themselves.
            if [&destination, &entry]
                .iter()
                .try_fold(false, |found, resolved| {
                    Ok::<_, String>(found || reaches(resolved, &root.path)?)
                })?
            {
                return Err(
                    "Choose a destination outside TabPlayer's protected library and recovery storage."
                        .into(),
                );
            }
        }
        Ok(())
    }
}

/// A folder with no usable identity (a file system that reports index 0 or -1) cannot be matched by
/// identity, and one this user may not read cannot be the protected root, which TabPlayer made and
/// can read. Neither is an answer about the path, so the name checks above decide for those folders.
fn no_identity(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::PermissionDenied | ErrorKind::Unsupported
    )
}

/// Whether `path`, or a folder above it that exists, is the folder `root` names. Any failure to
/// identify a folder that exists, other than `no_identity`, refuses the path.
fn reaches(path: &Path, root: &Path) -> Result<bool, String> {
    reaches_by(path, root, &file_id_io)
}

fn reaches_by(
    path: &Path,
    root: &Path,
    identify: &dyn Fn(&Path) -> std::io::Result<FileId>,
) -> Result<bool, String> {
    let root_id = match identify(root) {
        Ok(id) => id,
        Err(error) if no_identity(&error) => return Ok(false),
        Err(_) if !root.exists() => return Ok(false),
        Err(error) => return Err(format!("Could not identify {}: {error}", root.display())),
    };
    for ancestor in path.ancestors() {
        let ancestor = if ancestor.as_os_str().is_empty() {
            Path::new(".")
        } else {
            ancestor
        };
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => match identify(ancestor) {
                Ok(id) if id == root_id => return Ok(true),
                Ok(_) => {}
                Err(error) if no_identity(&error) => {}
                Err(error) => {
                    return Err(format!(
                        "Could not identify {}: {error}",
                        ancestor.display()
                    ));
                }
            },
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::PermissionDenied
                ) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(false)
}

fn within(path: &Path, root: &Path) -> bool {
    path.ancestors().any(|ancestor| same_path(ancestor, root))
}

// Canonicalize the nearest existing ancestor without losing native path units.
// Capturing absent namespaces must not create them or follow a dangling alias.
fn destination_identity(path: &Path) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return std::fs::canonicalize(path)
            .map_err(|_| "Choose a destination without unresolved parent traversal.".into());
    }
    let mut ancestor = std::path::absolute(path).map_err(|error| error.to_string())?;
    let mut suffix = Vec::new();
    loop {
        match std::fs::canonicalize(&ancestor) {
            Ok(mut identity) => {
                for component in suffix.into_iter().rev() {
                    identity.push(component);
                }
                return Ok(identity);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                match std::fs::symlink_metadata(&ancestor) {
                    Ok(_) => return Err(error.to_string()),
                    Err(metadata_error) if metadata_error.kind() == ErrorKind::NotFound => {}
                    Err(metadata_error) => return Err(metadata_error.to_string()),
                }
                suffix.push(
                    ancestor
                        .file_name()
                        .ok_or("Choose a file destination.")?
                        .to_owned(),
                );
                if !ancestor.pop() {
                    return Err(error.to_string());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alias_directory(alias: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, alias).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_dir(target, alias) {
            assert_eq!(error.raw_os_error(), Some(1314));
            let result = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(alias)
                .arg(target)
                .output()
                .unwrap();
            assert!(result.status.success(), "{result:?}");
        }
    }

    fn remove_alias(alias: &Path) {
        #[cfg(unix)]
        std::fs::remove_file(alias).unwrap();
        #[cfg(windows)]
        std::fs::remove_dir(alias).unwrap();
    }

    #[test]
    fn denies_each_namespace_and_unicode_descendants_but_allows_component_siblings() {
        let directory = tempfile::tempdir().unwrap();
        let roots: Vec<_> = ["file-library-v1", "recovery-v1", "bundled Ä library"]
            .iter()
            .map(|name| directory.path().join(name))
            .collect();
        for root in &roots {
            std::fs::create_dir(root).unwrap();
        }
        let protection = ProtectedPaths::new(roots.clone()).unwrap();
        for root in roots {
            assert!(protection.check(&root).is_err());
            assert!(protection.check(&root.join("nested/未保存 Ä.gp")).is_err());
        }
        for name in [
            "file-library-v10",
            "recovery-v1-copy",
            "bundled Ä library copy",
        ] {
            assert!(
                protection
                    .check(&directory.path().join(name).join("score.gp"))
                    .is_ok()
            );
        }
    }

    #[test]
    fn protects_absent_multilevel_namespaces_before_they_are_created() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("not-yet/created/file-library-v1");
        let protection = ProtectedPaths::new(vec![root.clone()]).unwrap();
        assert!(
            protection
                .check(&root.join("payloads/new.tabplayer"))
                .is_err()
        );
        assert!(!directory.path().join("not-yet").exists());
        assert!(
            protection
                .check(&directory.path().join("other/new/song.gp"))
                .is_ok()
        );
    }

    #[test]
    fn resolves_existing_destination_aliases_and_retains_original_root_after_retarget() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        let old = directory.path().join("old-library");
        let redirected = directory.path().join("redirected");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&redirected).unwrap();
        alias_directory(&root, &old);
        let protection = ProtectedPaths::new(vec![root.clone()]).unwrap();
        let alias = directory.path().join("alias");
        alias_directory(&alias, &root);
        assert!(protection.check(&alias.join("catalog.json")).is_err());
        remove_alias(&alias);
        remove_alias(&root);
        alias_directory(&root, &redirected);
        assert!(protection.check(&root.join("catalog.json")).is_err());
        assert!(protection.check(&redirected.join("catalog.json")).is_err());
        // The captured namespace is retained even after the configured path redirects.
        assert!(protection.check(&old.join("payload.tabplayer")).is_err());
    }

    #[test]
    fn rechecks_aliases_created_after_capture() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        let output = directory.path().join("output");
        std::fs::create_dir(&root).unwrap();
        let protection = ProtectedPaths::new(vec![root.clone()]).unwrap();
        assert!(protection.check(&output.join("score.pdf")).is_ok());
        alias_directory(&output, &root);
        assert!(protection.check(&output.join("score.pdf")).is_err());
    }

    #[test]
    fn protects_directory_entry_when_leaf_alias_points_outside() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        let external = directory.path().join("external");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&external).unwrap();
        let protection = ProtectedPaths::new(vec![root.clone()]).unwrap();
        let alias = root.join("redirected");
        alias_directory(&alias, &external);
        assert!(protection.check(&alias).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn protects_atomic_replacement_of_file_leaf_alias_into_external_storage() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        std::fs::create_dir(&root).unwrap();
        let external = directory.path().join("external.pdf");
        std::fs::write(&external, b"external").unwrap();
        let alias = root.join("catalog.json");
        std::os::unix::fs::symlink(&external, &alias).unwrap();
        let protection = ProtectedPaths::new(vec![root]).unwrap();
        let result = protection
            .check(&alias)
            .and_then(|()| crate::files::write_bytes(&alias, b"replacement"));
        assert!(result.is_err());
        assert!(
            std::fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read(&external).unwrap(), b"external");
    }

    #[test]
    fn unresolved_parent_traversal_and_dangling_alias_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        let protection = ProtectedPaths::new(vec![root.clone()]).unwrap();
        assert!(
            protection
                .check(&directory.path().join("missing/../score.gp"))
                .is_err()
        );
        let alias = directory.path().join("dangling");
        alias_directory(&alias, &root);
        assert!(protection.check(&alias.join("score.gp")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn follows_existing_windows_ascii_case_identity() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("File-Library-V1");
        let protection = ProtectedPaths::new(vec![root]).unwrap();
        assert!(
            protection
                .check(&directory.path().join("file-library-v1/score.gp"))
                .is_err()
        );
    }

    /// As a file system that reports index 0 or -1 answers: the folder exists and has no identity.
    fn no_usable_identity() -> std::io::Error {
        std::io::Error::new(ErrorKind::Unsupported, "no usable file identity")
    }

    #[test]
    fn a_folder_with_no_usable_identity_is_no_match_and_does_not_refuse_the_path() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        let target = directory.path().join("music");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&target).unwrap();
        let root_id = crate::fs_identity::file_id_io(&root).unwrap();
        let identify = |path: &Path| {
            if path == root {
                Ok(root_id)
            } else {
                Err(no_usable_identity())
            }
        };
        assert_eq!(
            reaches_by(&target.join("song.gp"), &root, &identify),
            Ok(false)
        );
        // The root itself still matches by identity, and on such a volume the name checks still apply.
        assert_eq!(
            reaches_by(&root.join("song.gp"), &root, &identify),
            Ok(true)
        );
        let unusable = |_: &Path| Err(no_usable_identity());
        assert_eq!(
            reaches_by(&target.join("song.gp"), &root, &unusable),
            Ok(false)
        );
        assert!(
            ProtectedPaths::new(vec![root.clone()])
                .unwrap()
                .check(&root.join("song.gp"))
                .is_err()
        );
    }

    #[test]
    fn any_other_failure_to_identify_a_folder_that_exists_still_refuses() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        std::fs::create_dir(&root).unwrap();
        let root_id = crate::fs_identity::file_id_io(&root).unwrap();
        let broken = |path: &Path| {
            if path == root {
                Ok(root_id)
            } else {
                Err(std::io::Error::other("the disk went away"))
            }
        };
        assert!(reaches_by(directory.path(), &root, &broken).is_err());
    }

    #[test]
    fn empty_default_keeps_existing_callers_unrestricted() {
        assert!(
            ProtectedPaths::default()
                .check(Path::new("anything/score.gp"))
                .is_ok()
        );
    }

    #[cfg(windows)]
    #[test]
    fn denies_a_loopback_share_spelling_of_a_protected_folder() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path())
            .unwrap()
            .join("library");
        std::fs::create_dir(&root).unwrap();
        let protected = ProtectedPaths::new(vec![root.clone()]).unwrap();
        let plain = root
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        let (drive, rest) = plain.split_at(2);
        let mut tried = 0;
        for host in ["localhost", "127.0.0.1"] {
            let share = format!(r"\\{host}\{}${rest}", &drive[..1]);
            if std::fs::metadata(&share).is_err() {
                continue;
            }
            tried += 1;
            assert!(
                protected.check(&Path::new(&share).join("song.gp")).is_err(),
                "{share}"
            );
            assert!(
                protected
                    .check(&Path::new(&share).join("new/deeper/song.gp"))
                    .is_err(),
                "{share}"
            );
        }
        eprintln!("protected share spellings exercised: {tried}");
    }
}

#[cfg(all(test, windows))]
mod unreadable_ancestor_tests {
    use super::*;
    use std::process::Command;

    fn who() -> String {
        let out = Command::new("whoami").output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Denies list and attribute reads of one folder to this user, as an ACL on a synced or shared folder can.
    #[test]
    fn a_folder_above_the_target_with_unreadable_attributes_does_not_refuse_it() {
        let directory = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(directory.path()).unwrap();
        let root = base.join("library");
        std::fs::create_dir(&root).unwrap();
        let locked = base.join("g").join("p");
        std::fs::create_dir_all(locked.join("c")).unwrap();
        let protected = ProtectedPaths::new(vec![root.clone()]).unwrap();
        let (me, target) = (who(), locked.join("c").join("song.gp"));
        // Attribute reads of a folder are implied by listing rights on its parent, so both are denied.
        let parent = locked.parent().unwrap().to_path_buf();
        let deny = |folder: &Path, rights: &str| {
            Command::new("icacls")
                .arg(folder)
                .args(["/deny", &format!("{me}:({rights})")])
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        };
        let restore = |folder: &Path| {
            let _ = Command::new("icacls")
                .arg(folder)
                .args(["/remove:d", &me])
                .output();
        };
        if !(deny(&parent, "RD") && deny(&locked, "RD,RA,REA")) {
            restore(&parent);
            restore(&locked);
            eprintln!("icacls unavailable; skipped");
            return;
        }
        let blocked = file_id_io(&locked).err().map(|error| error.kind());
        let outcome = (
            protected.check(&target),
            protected.check(&root.join("x.gp")),
        );
        restore(&locked);
        restore(&parent);
        // Setup proof: the identity of the locked folder really was unreadable.
        assert_eq!(blocked, Some(ErrorKind::PermissionDenied), "{blocked:?}");
        assert!(outcome.0.is_ok(), "{:?}", outcome.0);
        // Nothing that was protected becomes writable.
        assert!(outcome.1.is_err());
    }
}
