//! File identity and handle-level helpers for the places that must tell two names of one folder
//! apart, such as `\\localhost\C$\x`, `\\?\UNC\127.0.0.1\C$\x` and `C:\x`, which no string
//! comparison can. Every function refuses when the system cannot answer.
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};

/// A volume and a file index: equal exactly when two paths reach the same file or folder.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FileId {
    volume: u64,
    index: u64,
}

impl FileId {
    /// A zero or all-ones index is what a file system returns when it has no real identity to give.
    fn checked(volume: u64, index: u64) -> io::Result<Self> {
        if index == 0 || index == u64::MAX {
            return Err(io::Error::other(
                "The file system gave no usable file identity.",
            ));
        }
        Ok(Self { volume, index })
    }
}

#[cfg(windows)]
mod sys {
    use super::*;
    use std::{
        ffi::{OsString, c_void},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
    };

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct ByHandle {
        attributes: u32,
        created: FileTime,
        accessed: FileTime,
        written: FileTime,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut c_void, information: *mut ByHandle) -> i32;
        fn GetFinalPathNameByHandleW(
            handle: *mut c_void,
            buffer: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }

    const READ_ATTRIBUTES: u32 = 0x80;
    /// FILE_LIST_DIRECTORY with READ_ATTRIBUTES. Attribute-only access skips the share checks,
    /// so a handle that must hold a folder in place needs a real access right too.
    const LIST_AND_READ_ATTRIBUTES: u32 = 0x81;
    const SHARE_READ_WRITE: u32 = 3;
    const SHARE_ALL: u32 = 7;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const SHARING_VIOLATION: i32 = 32;

    pub fn handle_id(file: &File) -> io::Result<FileId> {
        let mut information = std::mem::MaybeUninit::<ByHandle>::zeroed();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let information = unsafe { information.assume_init() };
        FileId::checked(
            u64::from(information.volume),
            u64::from(information.index_high) << 32 | u64::from(information.index_low),
        )
    }

    pub fn file_id(path: &Path) -> io::Result<FileId> {
        let file = std::fs::OpenOptions::new()
            .access_mode(READ_ATTRIBUTES)
            .share_mode(SHARE_ALL)
            .custom_flags(BACKUP_SEMANTICS)
            .open(path)?;
        handle_id(&file)
    }

    /// Opens a folder itself, never what a link in its place would lead to, and keeps it from being
    /// renamed, deleted or replaced until the handle is dropped. Callers pin every folder of a chain.
    pub fn pin_folder(path: &Path) -> io::Result<File> {
        let file = std::fs::OpenOptions::new()
            .access_mode(LIST_AND_READ_ATTRIBUTES)
            .share_mode(SHARE_READ_WRITE)
            .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
            .open(path)?;
        let metadata = file.metadata()?;
        // 0x400 is a reparse point: a link or junction, not the folder itself.
        if metadata.file_attributes() & 0x400 != 0 || !metadata.is_dir() {
            return Err(io::Error::other("a link or not a folder"));
        }
        Ok(file)
    }

    pub fn final_path(file: &File, _path: &Path) -> Result<PathBuf, String> {
        let handle = file.as_raw_handle();
        let mut buffer = vec![0u16; 1024];
        loop {
            let length = unsafe {
                GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
            } as usize;
            if length == 0 {
                return Err(format!(
                    "Could not locate the created file: {}",
                    io::Error::last_os_error()
                ));
            }
            if length < buffer.len() {
                return Ok(PathBuf::from(OsString::from_wide(&buffer[..length])));
            }
            buffer.resize(length + 1, 0);
        }
    }

    /// Renames without replacing: an existing target fails with `AlreadyExists`. A scanner holding
    /// the file for a moment (sharing violation) is waited for briefly.
    pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<u16>>()
        };
        let (from, to) = (wide(from), wide(to));
        let mut attempt = 0;
        loop {
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            attempt += 1;
            if error.raw_os_error() != Some(SHARING_VIOLATION) || attempt >= 6 {
                return Err(error);
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
}

#[cfg(not(windows))]
mod sys {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    pub fn handle_id(file: &File) -> io::Result<FileId> {
        let metadata = file.metadata()?;
        FileId::checked(metadata.dev(), metadata.ino())
    }

    pub fn file_id(path: &Path) -> io::Result<FileId> {
        let metadata = std::fs::metadata(path)?;
        FileId::checked(metadata.dev(), metadata.ino())
    }

    /// There is no way here to hold a folder in place, so this opens the folder, refuses a link, and
    /// checks that the open handle is the entry that was inspected. A swap after that is caught by the
    /// callers' check of where the new file landed, which removes it; it is not prevented.
    pub fn pin_folder(path: &Path) -> io::Result<File> {
        let entry = std::fs::symlink_metadata(path)?;
        if entry.file_type().is_symlink() || !entry.is_dir() {
            return Err(io::Error::other("a link or not a folder"));
        }
        let file = File::open(path)?;
        let opened = file.metadata()?;
        if !opened.is_dir() || opened.dev() != entry.dev() || opened.ino() != entry.ino() {
            return Err(io::Error::other("a link or not a folder"));
        }
        Ok(file)
    }

    pub fn final_path(_file: &File, path: &Path) -> Result<PathBuf, String> {
        std::fs::canonicalize(path).map_err(|error| error.to_string())
    }

    /// Hard-links the file into place, which fails if the target exists, and removes the old name. On a
    /// file system without hard links the target is reserved with `create_new` and filled by copying, so
    /// nothing is replaced either way. A name that cannot be removed afterwards is the caller's to sweep.
    pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
        match std::fs::hard_link(from, to) {
            Ok(()) => {
                let _ = std::fs::remove_file(from);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(error),
            Err(_) => {
                let mut target = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(to)?;
                let copied = File::open(from)
                    .and_then(|mut source| io::copy(&mut source, &mut target))
                    .and_then(|_| target.sync_all());
                match copied {
                    Ok(()) => {
                        let _ = std::fs::remove_file(from);
                        Ok(())
                    }
                    Err(error) => {
                        drop(target);
                        let _ = std::fs::remove_file(to);
                        Err(error)
                    }
                }
            }
        }
    }
}

/// Identity of the file or folder `path` reaches, following links, with the system's own error.
pub fn file_id_io(path: &Path) -> io::Result<FileId> {
    sys::file_id(path)
}

/// Identity of the file or folder `path` reaches, following links.
pub fn file_id(path: &Path) -> Result<FileId, String> {
    sys::file_id(path).map_err(|error| format!("Could not identify {}: {error}", path.display()))
}

/// Identity of an open file or folder.
pub fn handle_id(file: &File) -> Result<FileId, String> {
    sys::handle_id(file).map_err(|error| format!("Could not identify an open folder: {error}"))
}

/// The identity of `path` and of every folder above it. Fails if any cannot be read.
pub fn ancestor_ids(path: &Path) -> Result<Vec<FileId>, String> {
    path.ancestors().map(file_id).collect()
}

/// Opens the folder itself, refusing a link, and holds it in place while the handle lives (see `sys`).
pub fn pin_folder(path: &Path) -> io::Result<File> {
    sys::pin_folder(path)
}

/// Where an open file really is, as the system reports for the handle.
pub fn final_path(file: &File, path: &Path) -> Result<PathBuf, String> {
    sys::final_path(file, path)
}

/// Moves `from` to `to` and never replaces an existing `to`.
pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    sys::rename_new(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_folder_has_one_identity_and_two_folders_differ() {
        let directory = tempfile::tempdir().unwrap();
        let (a, b) = (directory.path().join("a"), directory.path().join("b"));
        std::fs::create_dir_all(a.join("inner")).unwrap();
        std::fs::create_dir(&b).unwrap();
        assert_eq!(
            file_id(&a).unwrap(),
            file_id(&a.join("inner").join("..")).unwrap()
        );
        assert_ne!(file_id(&a).unwrap(), file_id(&b).unwrap());
        assert!(
            ancestor_ids(&a.join("inner"))
                .unwrap()
                .contains(&file_id(&a).unwrap())
        );
        assert!(file_id(&directory.path().join("missing")).is_err());
    }

    #[test]
    fn a_zero_or_all_ones_index_is_not_an_identity() {
        assert!(FileId::checked(1, 0).is_err());
        assert!(FileId::checked(1, u64::MAX).is_err());
        assert!(FileId::checked(1, 7).is_ok());
    }

    #[test]
    fn rename_never_replaces_and_reports_the_clash() {
        let directory = tempfile::tempdir().unwrap();
        let (from, to) = (
            directory.path().join("from.tmp"),
            directory.path().join("to.gp"),
        );
        std::fs::write(&from, "new").unwrap();
        std::fs::write(&to, "mine").unwrap();
        let error = rename_new(&from, &to).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&to).unwrap(), b"mine");
        std::fs::remove_file(&to).unwrap();
        rename_new(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"new");
        assert!(!from.exists());
    }

    #[test]
    fn a_pinned_folder_is_the_folder_itself_and_cannot_be_moved_or_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let outer = directory.path().join("outer");
        let inner = outer.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(
            pin_folder(&directory.path().join("missing"))
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        );
        let file = directory.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(pin_folder(&file).is_err());
        let pins = [pin_folder(&outer).unwrap(), pin_folder(&inner).unwrap()];
        assert_eq!(handle_id(&pins[1]).unwrap(), file_id(&inner).unwrap());
        #[cfg(windows)]
        {
            // While held: no rename of the folder or of the folder above it, and no delete.
            assert!(std::fs::rename(&inner, directory.path().join("moved")).is_err());
            assert!(std::fs::rename(&outer, directory.path().join("moved")).is_err());
            assert!(std::fs::remove_dir(&inner).is_err());
        }
        drop(pins);
        std::fs::rename(&inner, directory.path().join("moved")).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_pinned_link_is_refused_not_followed() {
        let directory = tempfile::tempdir().unwrap();
        let (real, link) = (directory.path().join("real"), directory.path().join("link"));
        std::fs::create_dir(&real).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(made.status.success());
        assert!(pin_folder(&link).is_err());
        // Identity follows the link to the folder, which is what the separation check needs.
        assert_eq!(file_id(&link).unwrap(), file_id(&real).unwrap());
    }
}
