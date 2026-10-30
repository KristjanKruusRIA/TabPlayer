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
    /// The error kind says so, so a caller can tell this from a folder it failed to reach.
    fn checked(volume: u64, index: u64) -> io::Result<Self> {
        if index == 0 || index == u64::MAX {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
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
    /// A scanner that holds the folder for a moment (sharing violation) is waited for briefly.
    pub fn pin_folder(path: &Path) -> io::Result<File> {
        let mut attempt = 0;
        let file = loop {
            let opened = std::fs::OpenOptions::new()
                .access_mode(LIST_AND_READ_ATTRIBUTES)
                .share_mode(SHARE_READ_WRITE)
                .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
                .open(path);
            match opened {
                Err(error) if is_in_use(&error) && attempt < 5 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                other => break other?,
            }
        };
        let metadata = file.metadata()?;
        // 0x400 is a reparse point: a link or junction, not the folder itself.
        if metadata.file_attributes() & 0x400 != 0 || !metadata.is_dir() {
            return Err(io::Error::other("a link or not a folder"));
        }
        Ok(file)
    }

    pub fn is_in_use(error: &io::Error) -> bool {
        error.raw_os_error() == Some(SHARING_VIOLATION)
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

    /// The pinned chain keeps `directory` where it is, so its path is as good as its handle here.
    pub fn create_in(_folder: &File, directory: &Path, name: &str) -> io::Result<File> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(name))
    }

    pub fn remove_in(_folder: &File, directory: &Path, name: &str) -> io::Result<()> {
        std::fs::remove_file(directory.join(name))
    }

    /// Renames without replacing: an existing target fails with `AlreadyExists`. A scanner holding
    /// the file for a moment (sharing violation) is waited for briefly.
    pub fn rename_new_in(_folder: &File, directory: &Path, from: &str, to: &str) -> io::Result<()> {
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<u16>>()
        };
        let (from, to) = (wide(&directory.join(from)), wide(&directory.join(to)));
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
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        },
    };

    pub fn handle_id(file: &File) -> io::Result<FileId> {
        let metadata = file.metadata()?;
        FileId::checked(metadata.dev(), metadata.ino())
    }

    pub fn file_id(path: &Path) -> io::Result<FileId> {
        let metadata = std::fs::metadata(path)?;
        FileId::checked(metadata.dev(), metadata.ino())
    }

    /// There is no way here to hold a folder in place, so this opens the folder, refuses a link, and
    /// checks that the open handle is the entry that was inspected. A swap after that is seen by the
    /// callers' check of where the new file is. The file itself goes through this handle (see
    /// `create_in`), so a swap can move it but never send it, or its removal, to another folder.
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

    pub fn is_in_use(_error: &io::Error) -> bool {
        false
    }

    /// No system call here reports a file's path from its handle. The name the caller used is what
    /// the check of the chain above it needs; nothing may be removed through this path, since a
    /// folder swapped in meanwhile makes it another file (`remove_in` goes through the handle).
    pub fn final_path(_file: &File, path: &Path) -> Result<PathBuf, String> {
        Ok(path.to_path_buf())
    }

    fn c_name(name: &str) -> io::Result<CString> {
        CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }

    fn open_at(folder: &File, name: &str, flags: libc::c_int) -> io::Result<File> {
        let name = c_name(name)?;
        let mode: libc::c_uint = 0o666;
        let flags = flags | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: `name` is a valid C string for the call, and a descriptor it returns is owned by nothing else.
        let descriptor = unsafe { libc::openat(folder.as_raw_fd(), name.as_ptr(), flags, mode) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: as above.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    /// Creates the file in the folder the handle is, wherever that folder has moved to.
    pub fn create_in(folder: &File, _directory: &Path, name: &str) -> io::Result<File> {
        open_at(folder, name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)
    }

    pub fn remove_in(folder: &File, _directory: &Path, name: &str) -> io::Result<()> {
        let name = c_name(name)?;
        // SAFETY: `name` is a valid C string for the call.
        if unsafe { libc::unlinkat(folder.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Hard-links the file into place, which fails if the target exists, and removes the old name. On a
    /// file system without hard links the target is reserved with `create_in` and filled by copying, so
    /// nothing is replaced either way. A name that cannot be removed afterwards is the caller's to sweep.
    pub fn rename_new_in(folder: &File, directory: &Path, from: &str, to: &str) -> io::Result<()> {
        let (source, target) = (c_name(from)?, c_name(to)?);
        let handle = folder.as_raw_fd();
        // SAFETY: both names are valid C strings for the call.
        let linked = unsafe { libc::linkat(handle, source.as_ptr(), handle, target.as_ptr(), 0) };
        if linked == 0 {
            let _ = remove_in(folder, directory, from);
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::AlreadyExists {
            return Err(error);
        }
        let mut written = create_in(folder, directory, to)?;
        let copied = open_at(folder, from, libc::O_RDONLY)
            .and_then(|mut reader| io::copy(&mut reader, &mut written))
            .and_then(|_| written.sync_all());
        match copied {
            Ok(()) => {
                let _ = remove_in(folder, directory, from);
                Ok(())
            }
            Err(error) => {
                drop(written);
                let _ = remove_in(folder, directory, to);
                Err(error)
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

/// Whether a file or folder could not be opened only because something else holds it open.
pub fn is_in_use(error: &io::Error) -> bool {
    sys::is_in_use(error)
}

/// Creates a new file in the pinned `folder`, whose path is `directory`. On Windows the pin holds the
/// folder at that path. Elsewhere the handle is used and the path ignored, so a folder swapped in
/// after the pin receives nothing.
pub fn create_in(folder: &File, directory: &Path, name: &str) -> io::Result<File> {
    sys::create_in(folder, directory, name)
}

/// Moves `from` to `to` inside the pinned `folder` and never replaces an existing `to`.
pub fn rename_new_in(folder: &File, directory: &Path, from: &str, to: &str) -> io::Result<()> {
    sys::rename_new_in(folder, directory, from, to)
}

/// Removes `name` from the pinned `folder`, by the same rules as `create_in`.
pub fn remove_in(folder: &File, directory: &Path, name: &str) -> io::Result<()> {
    sys::remove_in(folder, directory, name)
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
        for index in [0, u64::MAX] {
            let error = FileId::checked(1, index).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        }
        assert!(FileId::checked(1, 7).is_ok());
    }

    #[test]
    fn rename_never_replaces_and_reports_the_clash() {
        let directory = tempfile::tempdir().unwrap();
        let (path, pin) = (directory.path(), pin_folder(directory.path()).unwrap());
        let (from, to) = ("from.tmp", "to.gp");
        std::fs::write(path.join(from), "new").unwrap();
        std::fs::write(path.join(to), "mine").unwrap();
        let error = rename_new_in(&pin, path, from, to).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(path.join(to)).unwrap(), b"mine");
        std::fs::remove_file(path.join(to)).unwrap();
        rename_new_in(&pin, path, from, to).unwrap();
        assert_eq!(std::fs::read(path.join(to)).unwrap(), b"new");
        assert!(!path.join(from).exists());
    }

    #[test]
    fn create_refuses_a_taken_name_and_remove_takes_only_the_named_file() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let (path, pin) = (directory.path(), pin_folder(directory.path()).unwrap());
        let mut file = create_in(&pin, path, "new.tmp").unwrap();
        file.write_all(b"data").unwrap();
        drop(file);
        assert_eq!(
            create_in(&pin, path, "new.tmp").unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(path.join("new.tmp")).unwrap(), b"data");
        std::fs::write(path.join("other.gp"), "mine").unwrap();
        remove_in(&pin, path, "new.tmp").unwrap();
        assert!(!path.join("new.tmp").exists() && path.join("other.gp").exists());
        assert_eq!(
            remove_in(&pin, path, "new.tmp").unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    /// The case the undo must survive: the folder moves after the pin, and a same-named file of
    /// someone else's now sits at the old path.
    #[cfg(unix)]
    #[test]
    fn a_pin_follows_its_folder_when_another_is_swapped_into_the_path() {
        let directory = tempfile::tempdir().unwrap();
        let (slot, moved) = (
            directory.path().join("slot"),
            directory.path().join("moved"),
        );
        std::fs::create_dir(&slot).unwrap();
        let pin = pin_folder(&slot).unwrap();
        drop(create_in(&pin, &slot, "song.gp").unwrap());
        std::fs::rename(&slot, &moved).unwrap();
        std::fs::create_dir(&slot).unwrap();
        std::fs::write(slot.join("song.gp"), "theirs").unwrap();
        // A new file and a removal both reach the moved folder, and the file at the path is untouched.
        drop(create_in(&pin, &slot, "next.tmp").unwrap());
        assert!(moved.join("next.tmp").exists() && !slot.join("next.tmp").exists());
        remove_in(&pin, &slot, "song.gp").unwrap();
        assert!(!moved.join("song.gp").exists());
        assert_eq!(std::fs::read(slot.join("song.gp")).unwrap(), b"theirs");
        // Nor does a rename leave the pinned folder.
        rename_new_in(&pin, &slot, "next.tmp", "landed.gp").unwrap();
        assert!(moved.join("landed.gp").exists() && !slot.join("landed.gp").exists());
    }

    /// A symbolic link in the name is not followed, whatever it points at.
    #[cfg(unix)]
    #[test]
    fn creating_over_a_link_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let (path, pin) = (directory.path(), pin_folder(directory.path()).unwrap());
        let target = path.join("target.gp");
        std::fs::write(&target, "mine").unwrap();
        std::os::unix::fs::symlink(&target, path.join("link.tmp")).unwrap();
        assert!(create_in(&pin, path, "link.tmp").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"mine");
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

    /// A folder a scanner has open without sharing delete is busy, not a link, and is waited for.
    #[cfg(windows)]
    #[test]
    fn a_folder_held_for_a_moment_is_waited_for_and_a_held_one_is_reported_as_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let holder = || {
            std::fs::OpenOptions::new()
                .access_mode(0x0001_0000)
                .share_mode(3)
                .custom_flags(0x0200_0000)
                .open(directory.path())
                .unwrap()
        };
        let held = holder();
        let error = pin_folder(directory.path()).unwrap_err();
        assert!(is_in_use(&error), "{error:?}");
        drop(held);
        let held = holder();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(40));
                drop(held);
            });
            assert!(pin_folder(directory.path()).is_ok());
        });
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
