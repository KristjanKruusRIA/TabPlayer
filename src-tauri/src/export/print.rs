use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Viewer files are retained in the app cache; asynchronous viewers must be able to reopen them.
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
}
