use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Viewer files are retained in the app cache while the app runs, because asynchronous viewers must be able to reopen
/// them. They hold the whole printed score in plain form, so they are removed when the app starts and when it exits.
pub fn prepare_pdf(bytes: &[u8], directory: &Path) -> Result<PathBuf, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Print requires a prepared PDF document.".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let directory = std::fs::canonicalize(directory).map_err(|e| e.to_string())?;
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = directory.join(format!(
        "TabPlayer-print-{time}-{}.pdf",
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    crate::files::write_bytes(&path, bytes)?;
    Ok(path)
}
/// Whether a name is one this module made: `TabPlayer-print-<digits>-<digits>.pdf`.
fn is_viewer_file(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix("TabPlayer-print-")
        .and_then(|rest| rest.strip_suffix(".pdf"))
    else {
        return false;
    };
    let mut parts = rest.split('-');
    let digits = |part: Option<&str>| {
        part.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    digits(parts.next()) && digits(parts.next()) && parts.next().is_none()
}
/// Removes the viewer files left in `directory`, and nothing else. A file a viewer still holds open is left for the next
/// start. Returns how many were removed.
pub fn remove_viewer_files(directory: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_str().is_some_and(is_viewer_file)
                && std::fs::remove_file(entry.path()).is_ok()
        })
        .count()
}
pub fn prepare_and_open(bytes: &[u8], directory: &Path) -> Result<PathBuf, String> {
    let path = prepare_pdf(bytes, directory)?;
    open_pdf(&path).map_err(|e| {
        format!(
            "Could not open the PDF viewer: {e}. Your printable PDF is saved at {}",
            path.display()
        )
    })?;
    Ok(path)
}
#[cfg(target_os = "windows")]
pub fn open_pdf(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    let file: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err(format!("Windows viewer error {result}"))
    } else {
        Ok(())
    }
}
#[cfg(not(target_os = "windows"))]
pub fn open_pdf(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = "xdg-open";
    let status = std::process::Command::new(program)
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("PDF viewer exited with {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepared_pdf_path_with_unicode_survives_for_external_viewer() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("print path Ä");
        let path = prepare_pdf(b"%PDF-1.7\nviewer fixture", &root).unwrap();
        assert!(path.is_absolute());
        assert_eq!(std::fs::read(path).unwrap(), b"%PDF-1.7\nviewer fixture");
        assert!(prepare_pdf(b"invalid", &root).is_err());
    }
    #[test]
    fn leftover_viewer_files_are_removed_and_nothing_else_is() {
        let d = tempfile::tempdir().unwrap();
        let first = prepare_pdf(
            b"%PDF-1.7
one",
            d.path(),
        )
        .unwrap();
        let second = prepare_pdf(
            b"%PDF-1.7
two",
            d.path(),
        )
        .unwrap();
        let others = [
            "notes.pdf",
            "TabPlayer-print-x-1.pdf",
            "TabPlayer-print-1-2-3.pdf",
            "TabPlayer-print-1-2.txt",
        ];
        for name in others {
            std::fs::write(d.path().join(name), b"keep").unwrap();
        }
        std::fs::create_dir(d.path().join("TabPlayer-print-1-2.pdf")).unwrap();
        assert_eq!(remove_viewer_files(d.path()), 2);
        assert!(!first.exists() && !second.exists());
        for name in others {
            assert!(d.path().join(name).exists(), "{name}");
        }
        assert!(d.path().join("TabPlayer-print-1-2.pdf").is_dir());
        assert_eq!(remove_viewer_files(&d.path().join("missing")), 0);
    }
}
