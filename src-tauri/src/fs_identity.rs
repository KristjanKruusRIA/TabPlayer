//! File identity and handle-level helpers for the places that must tell two names of one folder
//! apart, such as `\\localhost\C$\x`, `\\?\UNC\127.0.0.1\C$\x` and `C:\x`, which no string
//! comparison can. Every function refuses when the system cannot answer.
use std::{fs::File, path::Path, path::PathBuf};

/// A volume and a file index: equal exactly when two paths reach the same file or folder.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FileId {
    volume: u64,
    index: u64,
}

#[cfg(windows)]
mod sys {
    use super::*;
    use std::{
        ffi::{OsString, c_void},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            fs::OpenOptionsExt,
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
    const SHARE_ALL: u32 = 7;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;

    pub fn file_id(path: &Path) -> Result<FileId, String> {
        let file = std::fs::OpenOptions::new()
            .access_mode(READ_ATTRIBUTES)
            .share_mode(SHARE_ALL)
            .custom_flags(BACKUP_SEMANTICS)
            .open(path)
            .map_err(|error| format!("Could not identify {}: {error}", path.display()))?;
        let mut information = std::mem::MaybeUninit::<ByHandle>::zeroed();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return Err(format!(
                "Could not identify {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        let information = unsafe { information.assume_init() };
        Ok(FileId {
            volume: u64::from(information.volume),
            index: u64::from(information.index_high) << 32 | u64::from(information.index_low),
        })
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
                    std::io::Error::last_os_error()
                ));
            }
            if length < buffer.len() {
                return Ok(PathBuf::from(OsString::from_wide(&buffer[..length])));
            }
            buffer.resize(length + 1, 0);
        }
    }

    /// Renames without replacing: an existing target fails with `AlreadyExists`.
    pub fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<u16>>()
        };
        if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), 0) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod sys {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    pub fn file_id(path: &Path) -> Result<FileId, String> {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("Could not identify {}: {error}", path.display()))?;
        Ok(FileId {
            volume: metadata.dev(),
            index: metadata.ino(),
        })
    }
    pub fn final_path(_file: &File, path: &Path) -> Result<PathBuf, String> {
        std::fs::canonicalize(path).map_err(|error| error.to_string())
    }
    pub fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::hard_link(from, to)?;
        std::fs::remove_file(from)
    }
}

/// Identity of the file or folder `path` reaches, following links.
pub fn file_id(path: &Path) -> Result<FileId, String> {
    sys::file_id(path)
}

/// The identity of `path` and of every folder above it. Fails if any cannot be read.
pub fn ancestor_ids(path: &Path) -> Result<Vec<FileId>, String> {
    path.ancestors().map(file_id).collect()
}

/// Where an open file really is, as the system reports for the handle.
pub fn final_path(file: &File, path: &Path) -> Result<PathBuf, String> {
    sys::final_path(file, path)
}

/// Moves `from` to `to` and never replaces an existing `to`.
pub fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
    sys::rename_new(from, to)
}
