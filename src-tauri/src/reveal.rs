use std::path::Path;

/// The caller resolves a current saved-document path and releases workspace locks first.
pub fn reveal_saved(path: &Path) -> Result<(), String> {
    reveal_with(path, launch)
}

fn reveal_with(
    path: &Path,
    launch: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("The saved file must have an absolute path.".into());
    }
    let path =
        std::fs::canonicalize(path).map_err(|e| format!("Could not locate the saved file: {e}"))?;
    if !std::fs::metadata(&path)
        .map_err(|e| format!("Could not read the saved file: {e}"))?
        .is_file()
    {
        return Err("The saved path is not a regular file.".into());
    }
    let parent = path
        .parent()
        .ok_or("The saved file has no containing directory.")?;
    let parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Could not locate the containing directory: {e}"))?;
    if !std::fs::metadata(&parent)
        .map_err(|e| format!("Could not read the containing directory: {e}"))?
        .is_dir()
    {
        return Err("The saved file's containing path is not a directory.".into());
    }
    launch(&path, &parent)
}

#[cfg(windows)]
fn launch(path: &Path, _parent: &Path) -> Result<(), String> {
    windows::open(path)
}

#[cfg(not(windows))]
fn launch(path: &Path, parent: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = macos_command(path).status();
    #[cfg(not(target_os = "macos"))]
    let status = {
        let _ = path;
        linux_command(parent).status()
    };
    #[cfg(target_os = "macos")]
    let _ = parent;
    let status = status.map_err(|e| format!("Could not open the containing directory: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "The containing-directory launcher exited with {status}."
        ))
    }
}

#[cfg(any(test, target_os = "macos"))]
fn macos_command(path: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("/usr/bin/open");
    command.arg("-R").arg(path);
    command
}

#[cfg(any(test, target_os = "linux"))]
fn linux_command(parent: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("xdg-open");
    command.arg(parent);
    command
}

#[cfg(windows)]
mod windows {
    use std::{
        ffi::c_void,
        os::windows::ffi::OsStrExt,
        path::{Component, Path, Prefix},
    };

    const RPC_E_CHANGED_MODE: i32 = 0x80010106u32 as i32;

    trait Shell {
        fn initialize(&self) -> i32;
        fn parse(&self, path: &[u16]) -> (i32, *mut c_void);
        fn select(&self, pidl: *mut c_void) -> i32;
        fn free(&self, pidl: *mut c_void);
        fn uninitialize(&self);
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(memory: *mut c_void);
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHParseDisplayName(
            name: *const u16,
            context: *mut c_void,
            pidl: *mut *mut c_void,
            attributes: u32,
            attributes_out: *mut u32,
        ) -> i32;
        fn SHOpenFolderAndSelectItems(
            folder: *const c_void,
            count: u32,
            children: *const *const c_void,
            flags: u32,
        ) -> i32;
    }

    struct SystemShell;

    impl Shell for SystemShell {
        fn initialize(&self) -> i32 {
            unsafe { CoInitializeEx(std::ptr::null_mut(), 0) }
        }
        fn parse(&self, path: &[u16]) -> (i32, *mut c_void) {
            let mut pidl = std::ptr::null_mut();
            let result = unsafe {
                SHParseDisplayName(
                    path.as_ptr(),
                    std::ptr::null_mut(),
                    &mut pidl,
                    0,
                    std::ptr::null_mut(),
                )
            };
            (result, pidl)
        }
        fn select(&self, pidl: *mut c_void) -> i32 {
            unsafe { SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0) }
        }
        fn free(&self, pidl: *mut c_void) {
            unsafe { CoTaskMemFree(pidl) }
        }
        fn uninitialize(&self) {
            unsafe { CoUninitialize() }
        }
    }

    struct Com<'a, S: Shell>(&'a S, bool);
    impl<S: Shell> Drop for Com<'_, S> {
        fn drop(&mut self) {
            if self.1 {
                self.0.uninitialize();
            }
        }
    }

    struct Pidl<'a, S: Shell>(&'a S, *mut c_void);
    impl<S: Shell> Drop for Pidl<'_, S> {
        fn drop(&mut self) {
            if !self.1.is_null() {
                self.0.free(self.1);
            }
        }
    }

    fn wide_path(path: &Path) -> Result<Vec<u16>, String> {
        let mut units = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if units.contains(&0) {
            return Err("The saved file path contains a NUL character.".into());
        }
        // Shell syntax differs from canonical filesystem syntax. Retain prefixes if
        // removing one could normalize a component or interpret a DOS device name.
        let trailing_dot_or_space = units
            .split(|unit| *unit == b'\\' as u16 || *unit == b'/' as u16)
            .any(|component| matches!(component.last(), Some(0x20 | 0x2e)));
        let device_component = path.components().any(|component| match component {
            Component::Normal(name) => {
                let mut stem = name
                    .encode_wide()
                    .take_while(|unit| *unit != b'.' as u16)
                    .map(|unit| {
                        if (b'a' as u16..=b'z' as u16).contains(&unit) {
                            unit - 32
                        } else {
                            unit
                        }
                    })
                    .collect::<Vec<_>>();
                while stem.last() == Some(&(b' ' as u16)) {
                    stem.pop();
                }
                ["CON", "PRN", "AUX", "NUL"]
                    .iter()
                    .any(|name| stem.iter().copied().eq(name.encode_utf16()))
                    || (stem.len() == 4
                        && ["COM", "LPT"]
                            .iter()
                            .any(|name| stem[..3].iter().copied().eq(name.encode_utf16()))
                        && matches!(stem[3], 0x31..=0x39 | 0xb9 | 0xb2 | 0xb3))
            }
            _ => false,
        });
        if !trailing_dot_or_space && !device_component {
            match path.components().next() {
                Some(Component::Prefix(prefix)) => match prefix.kind() {
                    Prefix::VerbatimDisk(_) => {
                        units.drain(..4);
                    }
                    Prefix::VerbatimUNC(_, _) => {
                        units.drain(..8);
                        units.splice(..0, [b'\\' as u16, b'\\' as u16]);
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        units.push(0);
        Ok(units)
    }

    fn result(code: i32, operation: &str) -> Result<(), String> {
        if code >= 0 {
            Ok(())
        } else {
            Err(format!(
                "{operation} failed (Windows error {:08X}).",
                code as u32
            ))
        }
    }

    fn open_with(path: &Path, shell: &impl Shell) -> Result<(), String> {
        let path = wide_path(path)?;
        let initialized = shell.initialize();
        if initialized != RPC_E_CHANGED_MODE {
            result(initialized, "Preparing the containing-directory request")?;
        }
        let _com = Com(shell, initialized >= 0);
        let (parsed, pidl) = shell.parse(&path);
        let pidl = Pidl(shell, pidl);
        result(parsed, "Locating the saved file in Windows Shell")?;
        if pidl.1.is_null() {
            return Err("Windows Shell returned no saved-file item.".into());
        }
        result(shell.select(pidl.1), "Opening the containing directory")
    }

    pub(super) fn open(path: &Path) -> Result<(), String> {
        open_with(path, &SystemShell)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;

        struct FakeShell {
            initialize: i32,
            parse: i32,
            select: i32,
            null_pidl: bool,
            events: RefCell<Vec<String>>,
            parsed: RefCell<Vec<u16>>,
        }

        impl Default for FakeShell {
            fn default() -> Self {
                Self {
                    initialize: 0,
                    parse: 0,
                    select: 0,
                    null_pidl: false,
                    events: RefCell::new(Vec::new()),
                    parsed: RefCell::new(Vec::new()),
                }
            }
        }

        impl Shell for FakeShell {
            fn initialize(&self) -> i32 {
                self.events.borrow_mut().push("initialize".into());
                self.initialize
            }
            fn parse(&self, path: &[u16]) -> (i32, *mut c_void) {
                self.events.borrow_mut().push("parse".into());
                *self.parsed.borrow_mut() = path.to_vec();
                let pidl = if self.null_pidl || self.parse < 0 {
                    std::ptr::null_mut()
                } else {
                    std::ptr::NonNull::<c_void>::dangling().as_ptr()
                };
                (self.parse, pidl)
            }
            fn select(&self, _pidl: *mut c_void) -> i32 {
                self.events.borrow_mut().push("select".into());
                self.select
            }
            fn free(&self, _pidl: *mut c_void) {
                self.events.borrow_mut().push("free".into());
            }
            fn uninitialize(&self) {
                self.events.borrow_mut().push("uninitialize".into());
            }
        }

        #[test]
        fn windows_shell_receives_one_utf16_path_and_balances_success() {
            let path = Path::new(r"C:\A folder, one\Björk 東京.tabplayer");
            let shell = FakeShell::default();
            open_with(path, &shell).unwrap();
            assert_eq!(
                &*shell.parsed.borrow(),
                &path
                    .to_str()
                    .unwrap()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                *shell.events.borrow(),
                ["initialize", "parse", "select", "free", "uninitialize"]
            );
        }

        #[test]
        fn windows_shell_converts_extended_disk_and_unc_without_splitting() {
            for (input, expected) in [
                (
                    r"\\?\C:\A folder, one\Björk 東京.tabplayer",
                    r"C:\A folder, one\Björk 東京.tabplayer",
                ),
                (
                    r"\\server\share\A folder, one\Björk 東京.tabplayer",
                    r"\\server\share\A folder, one\Björk 東京.tabplayer",
                ),
                (
                    r"\\?\UNC\server\share\A folder, one\Björk 東京.tabplayer",
                    r"\\server\share\A folder, one\Björk 東京.tabplayer",
                ),
                (
                    r"\\?\C:\console\COM10.tabplayer",
                    r"C:\console\COM10.tabplayer",
                ),
                (
                    r"\\?\UNC\CON\NUL\score.tabplayer",
                    r"\\CON\NUL\score.tabplayer",
                ),
            ] {
                let shell = FakeShell::default();
                open_with(Path::new(input), &shell).unwrap();
                assert_eq!(
                    *shell.parsed.borrow(),
                    expected.encode_utf16().chain(Some(0)).collect::<Vec<_>>()
                );
            }
        }

        #[test]
        fn windows_shell_preserves_non_unicode_os_path_units() {
            use std::os::windows::ffi::OsStringExt;
            let mut units = r"C:\saved\".encode_utf16().collect::<Vec<_>>();
            units.extend([0xd800, b',' as u16, b' ' as u16]);
            units.extend("score.tabplayer".encode_utf16());
            let path = std::ffi::OsString::from_wide(&units);
            units.push(0);
            assert_eq!(wide_path(Path::new(&path)).unwrap(), units);
        }

        #[test]
        fn windows_shell_retains_prefix_when_normalization_would_change_identity() {
            for input in [
                r"\\?\C:\saved\score .tabplayer.",
                r"\\?\UNC\server\share\saved \score.tabplayer",
                r"\\?\Volume{00000000-0000-0000-0000-000000000000}\score.tabplayer",
            ] {
                assert_eq!(
                    wide_path(Path::new(input)).unwrap(),
                    input.encode_utf16().chain(Some(0)).collect::<Vec<_>>()
                );
            }
        }

        #[test]
        fn windows_shell_retains_prefix_for_dos_device_components() {
            for input in [
                r"\\?\C:\saved\NUL.tabplayer",
                r"\\?\C:\con.tabplayer\score.tabplayer",
                r"\\?\C:\saved\cOm1.tabplayer",
                r"\\?\C:\saved\LPT².tabplayer",
                r"\\?\UNC\server\share\AUX\score.tabplayer",
            ] {
                assert_eq!(
                    wide_path(Path::new(input)).unwrap(),
                    input.encode_utf16().chain(Some(0)).collect::<Vec<_>>()
                );
            }
        }

        #[test]
        fn windows_shell_rejects_embedded_nul_before_any_call() {
            let shell = FakeShell::default();
            assert!(open_with(Path::new("C:\\saved\\bad\0name.tabplayer"), &shell).is_err());
            assert!(shell.events.borrow().is_empty());
        }

        #[test]
        fn windows_shell_balances_s_false_but_not_changed_apartment() {
            for (initialize, balanced) in [(1, true), (RPC_E_CHANGED_MODE, false)] {
                let shell = FakeShell {
                    initialize,
                    ..Default::default()
                };
                open_with(Path::new(r"C:\saved\score.tabplayer"), &shell).unwrap();
                let mut expected = vec!["initialize", "parse", "select", "free"];
                if balanced {
                    expected.push("uninitialize");
                }
                assert_eq!(*shell.events.borrow(), expected);
            }
        }

        #[test]
        fn windows_shell_initialization_failure_never_parses_or_uninitializes() {
            let shell = FakeShell {
                initialize: 0x80004005u32 as i32,
                ..Default::default()
            };
            let error = open_with(Path::new(r"C:\saved\score.tabplayer"), &shell).unwrap_err();
            assert!(error.contains("80004005"), "{error}");
            assert_eq!(*shell.events.borrow(), ["initialize"]);
        }

        #[test]
        fn windows_shell_parse_failure_uninitializes_without_selection() {
            let shell = FakeShell {
                parse: 0x80070002u32 as i32,
                ..Default::default()
            };
            let error = open_with(Path::new(r"C:\saved\score.tabplayer"), &shell).unwrap_err();
            assert!(error.contains("80070002"), "{error}");
            assert_eq!(
                *shell.events.borrow(),
                ["initialize", "parse", "uninitialize"]
            );
        }

        #[test]
        fn windows_shell_selection_failure_frees_and_uninitializes() {
            let shell = FakeShell {
                select: 0x80004005u32 as i32,
                ..Default::default()
            };
            let error = open_with(Path::new(r"C:\saved\score.tabplayer"), &shell).unwrap_err();
            assert!(error.contains("80004005"), "{error}");
            assert_eq!(
                *shell.events.borrow(),
                ["initialize", "parse", "select", "free", "uninitialize"]
            );
        }

        #[test]
        fn windows_shell_empty_successful_pidl_rejects_without_selection() {
            let shell = FakeShell {
                null_pidl: true,
                ..Default::default()
            };
            assert!(open_with(Path::new(r"C:\saved\score.tabplayer"), &shell).is_err());
            assert_eq!(
                *shell.events.borrow(),
                ["initialize", "parse", "uninitialize"]
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_launcher_has_exact_program_and_literal_file_argument() {
        for path in [
            Path::new("/Volumes/Scores, Björk/東京 Song.tabplayer"),
            Path::new(r"\\server\share\Scores, Björk\東京 Song.tabplayer"),
        ] {
            let command = macos_command(path);
            assert_eq!(command.get_program(), "/usr/bin/open");
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                [std::ffi::OsStr::new("-R"), path.as_os_str()]
            );
        }
    }

    #[test]
    fn linux_launcher_has_exact_program_and_literal_parent_argument() {
        for parent in [
            Path::new("/mnt/Scores, Björk/東京 Music"),
            Path::new(r"\\server\share\Scores, Björk\東京 Music"),
        ] {
            let command = linux_command(parent);
            assert_eq!(command.get_program(), "xdg-open");
            assert_eq!(command.get_args().collect::<Vec<_>>(), [parent.as_os_str()]);
        }
    }

    #[test]
    fn saved_unicode_file_and_real_parent_reach_launcher_intact() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("A folder, one Björk 東京");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("Score, take 2.tabplayer");
        std::fs::write(&path, b"saved file").unwrap();
        let expected = std::fs::canonicalize(&path).unwrap();
        let expected_parent = std::fs::canonicalize(&directory).unwrap();
        let mut called = false;
        reveal_with(&path, |file, parent| {
            called = true;
            assert_eq!(file, expected);
            assert_eq!(parent, expected_parent);
            Ok(())
        })
        .unwrap();
        assert!(called);
        assert_eq!(std::fs::read(&path).unwrap(), b"saved file");
    }

    #[test]
    fn launcher_failure_is_reported_without_changing_saved_file() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("Saved.tabplayer");
        std::fs::write(&path, b"saved file").unwrap();
        let mut called = false;
        let error = reveal_with(&path, |_, _| {
            called = true;
            Err("test operating-system launcher failure".into())
        })
        .unwrap_err();
        assert!(called);
        assert_eq!(error, "test operating-system launcher failure");
        assert_eq!(std::fs::read(&path).unwrap(), b"saved file");
    }

    #[test]
    fn relative_missing_and_directory_targets_never_launch() {
        let temporary = tempfile::tempdir().unwrap();
        for path in [
            Path::new("relative.tabplayer").to_path_buf(),
            temporary.path().join("Missing.tabplayer"),
            temporary.path().to_path_buf(),
        ] {
            let error = reveal_with(&path, |_, _| {
                panic!("Invalid saved-file target must not reach the OS launcher")
            })
            .unwrap_err();
            assert!(!error.is_empty());
        }
    }

    #[test]
    fn saved_path_is_canonicalized_before_launch() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("child")).unwrap();
        let path = temporary.path().join("Saved.tabplayer");
        std::fs::write(&path, b"saved file").unwrap();
        let input = temporary
            .path()
            .join("child")
            .join("..")
            .join("Saved.tabplayer");
        let expected = std::fs::canonicalize(&path).unwrap();
        reveal_with(&input, |file, parent| {
            assert_eq!(file, expected);
            assert_eq!(Some(parent), file.parent());
            Ok(())
        })
        .unwrap();
    }
}
