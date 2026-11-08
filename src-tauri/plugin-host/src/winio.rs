//! The Win32 plumbing of the helper: the private control pipe, the shared mapping and the events the app duplicated into
//! this process, and the audio thread's priority class.
//!
//! Handles arrive as numbers in the `Load` message: the app duplicated them into this process (never named kernel
//! objects, so no other process can open them). Everything here treats those numbers as untrusted: they are checked
//! before use, and a bad one is a `BadRequest`, not a crash.
use crate::audio::Wake;
use crate::core::CoreError;
use std::ffi::c_void;
use std::fs::File;
use std::os::windows::io::FromRawHandle;
use std::time::Duration;
use tabplayer_plugin_protocol::{
    control::ErrorCode,
    ring::{HelperRing, RING_BYTES},
};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
    INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX, SetErrorMode,
};
use windows_sys::Win32::System::ErrorReporting::{WER_FAULT_REPORTING_NO_UI, WerSetFlags};
use windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW;
use windows_sys::Win32::System::Memory::{
    FILE_MAP_READ, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile, UnmapViewOfFile,
};
use windows_sys::Win32::System::Threading::{
    AvSetMmThreadCharacteristicsW, GetCurrentProcess, SetEvent, WaitForSingleObject,
};
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const DUPLICATE_SAME_ACCESS: u32 = 0x0000_0002;

unsafe extern "C" {
    // The C runtime's descriptor calls. Plug-ins built against the C runtime print through descriptors 0, 1 and 2, which
    // do not follow `SetStdHandle`.
    fn _open_osfhandle(handle: isize, flags: i32) -> i32;
    fn _dup2(from: i32, to: i32) -> i32;
    fn _close(fd: i32) -> i32;
}

/// Process-wide settings that keep a misbehaving plug-in from stalling or leaking out of the helper:
/// - no error dialogs and no Windows Error Reporting UI, so a crashing plug-in ends the helper at once with its exception
///   code (the app then sees a crash, not a hang while a dump is collected);
/// - the current directory is taken off the DLL search path (`SetDllDirectoryW("")`), because it is inherited from the
///   app and could be any folder; a plug-in's own flag-less `LoadLibrary` calls would search it.
pub fn harden_process() {
    let empty = [0u16];
    // SAFETY: plain calls; the string is NUL-terminated and outlives the call.
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
        WerSetFlags(WER_FAULT_REPORTING_NO_UI);
        SetDllDirectoryW(empty.as_ptr());
    }
}

/// Takes `HANDLE_FLAG_INHERIT` off a handle, so a plug-in that starts a child process with `bInheritHandles` (a licence
/// or updater tool, say) does not pass it on. A grandchild holding the control pipe would also hide the helper's death
/// from the app.
fn not_inheritable(handle: HANDLE) {
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        // SAFETY: a plain call; it fails harmlessly for a value that is not a handle.
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
    }
}

/// Per-monitor DPI awareness v2, so editor windows are sized in physical pixels (Spike 4). It has to run before the first
/// window exists.
pub fn set_dpi_awareness() {
    // SAFETY: a plain call; it fails harmlessly if the process already has an awareness set.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn duplicate_own(handle: HANDLE) -> std::io::Result<HANDLE> {
    let mut copy: HANDLE = std::ptr::null_mut();
    // SAFETY: duplicates a handle of this process into this process, not inheritable; `copy` is writable.
    let done = unsafe {
        let me = GetCurrentProcess();
        DuplicateHandle(me, handle, me, &mut copy, 0, 0, DUPLICATE_SAME_ACCESS)
    };
    if done == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(copy)
    }
}

fn open_nul(write: bool) -> std::io::Result<HANDLE> {
    let name = wide("NUL");
    // SAFETY: a NUL-terminated path that outlives the call; no security attributes, no template.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            if write { GENERIC_WRITE } else { GENERIC_READ },
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(handle)
    }
}

/// The control pipe, on handles nothing else knows about.
pub struct PrivateStdio {
    pub input: File,
    pub output: File,
}

/// Preflight ruling P4. Plug-ins and their DLLs print (debug output, licence code), and one stray byte on the control
/// pipe breaks the framing. So, before any module loads (the probe path included):
/// - the stdin and stdout pipe handles are duplicated to private handles;
/// - the process's standard input, output and error handles point at `NUL`;
/// - the C runtime's descriptors 0, 1 and 2 are `_dup2`'d onto `NUL` as well.
///
/// Control frames use only the private handles.
pub fn take_stdio() -> std::io::Result<PrivateStdio> {
    // SAFETY: plain calls.
    let (stdin, stdout) = unsafe {
        (
            GetStdHandle(STD_INPUT_HANDLE),
            GetStdHandle(STD_OUTPUT_HANDLE),
        )
    };
    let missing = |h: HANDLE| h.is_null() || h == INVALID_HANDLE_VALUE;
    if missing(stdin) || missing(stdout) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "the helper needs its standard input and output as pipes",
        ));
    }
    let (private_in, private_out) = (duplicate_own(stdin)?, duplicate_own(stdout)?);
    // The originals may have been inherited. They are no longer used, and must not be passed on.
    not_inheritable(stdin);
    not_inheritable(stdout);
    // SAFETY: a plain call.
    not_inheritable(unsafe { GetStdHandle(STD_ERROR_HANDLE) });
    let (nul_in, nul_out) = (open_nul(false)?, open_nul(true)?);
    // SAFETY: the NUL handles are valid and stay open for the process's life.
    unsafe {
        SetStdHandle(STD_INPUT_HANDLE, nul_in);
        SetStdHandle(STD_OUTPUT_HANDLE, nul_out);
        SetStdHandle(STD_ERROR_HANDLE, nul_out);
    }
    for (target, writable) in [(0, false), (1, true), (2, true)] {
        let Ok(handle) = open_nul(writable) else {
            continue;
        };
        // SAFETY: `_open_osfhandle` takes ownership of the NUL handle just opened; `_dup2` copies the descriptor onto the
        // standard one and `_close` drops the temporary. A failure leaves that descriptor as it was.
        unsafe {
            let fd = _open_osfhandle(handle as isize, if writable { 1 } else { 0 });
            if fd >= 0 {
                _dup2(fd, target);
                _close(fd);
            } else {
                CloseHandle(handle);
            }
        }
    }
    // SAFETY: both are fresh handles that nothing else owns; the `File`s now do.
    unsafe {
        Ok(PrivateStdio {
            input: File::from_raw_handle(private_in as *mut c_void),
            output: File::from_raw_handle(private_out as *mut c_void),
        })
    }
}

/// A handle number from the app, checked for being a handle of this process.
fn checked_handle(value: u64) -> Option<HANDLE> {
    let handle = usize::try_from(value).ok()? as HANDLE;
    let mut flags = 0u32;
    // SAFETY: accepts any value and only reports whether it names an open handle.
    let open = unsafe { GetHandleInformation(handle, &mut flags) } != 0;
    if open {
        not_inheritable(handle);
    }
    open.then_some(handle)
}

/// A mapped view of the ring, unmapped on drop.
pub struct Mapping {
    view: MEMORY_MAPPED_VIEW_ADDRESS,
}

// SAFETY: the view is plain memory of this process; the ring accesses it through atomic cells.
unsafe impl Send for Mapping {}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: the address `MapViewOfFile` returned, unmapped once.
        unsafe { UnmapViewOfFile(self.view) };
    }
}

/// Maps the app's ring and opens it. The handle is the duplicated file mapping; it is closed once the view exists.
///
/// The ring must be dropped before the mapping: the ring points into the view.
pub fn open_ring(handle: u64, sample_rate: u32) -> Result<(HelperRing, Mapping), CoreError> {
    let bad = |detail: &str| CoreError::new(ErrorCode::BadRequest, detail);
    let handle = checked_handle(handle).ok_or_else(|| bad("The ring handle is not valid."))?;
    // SAFETY: a mapping handle of this process; the whole ring is asked for, and a smaller mapping makes this fail.
    let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, RING_BYTES) };
    // SAFETY: the app handed this handle over; the view keeps the memory alive without it.
    unsafe { CloseHandle(handle) };
    if view.Value.is_null() {
        return Err(bad("The ring could not be mapped."));
    }
    let mapping = Mapping { view };
    // SAFETY: `RING_BYTES` bytes are mapped read-write for as long as `mapping` lives, which the caller keeps longer
    // than the ring; this is the only `HelperRing` on it.
    let ring = unsafe { HelperRing::from_raw(view.Value.cast::<u8>(), RING_BYTES) }
        .map_err(|error| bad(&error.to_string()))?;
    if ring.sample_rate() != sample_rate {
        return Err(bad("The ring's sample rate differs from the request's."));
    }
    Ok((ring, mapping))
}

/// A duplicated auto-reset event.
pub struct Event {
    handle: usize,
}

impl Event {
    pub fn from_value(value: u64) -> Result<Event, CoreError> {
        let handle = checked_handle(value).ok_or_else(|| {
            CoreError::new(ErrorCode::BadRequest, "An event handle is not valid.")
        })?;
        Ok(Event {
            handle: handle as usize,
        })
    }
}

impl Wake for Event {
    fn wait(&self, timeout: Duration) -> bool {
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: waits on an event handle this struct owns.
        let result = unsafe { WaitForSingleObject(self.handle as HANDLE, millis) };
        if result == WAIT_OBJECT_0 {
            return true;
        }
        if result != 0x102 {
            // Not a timeout: the handle is not something that can be waited on. Do not spin.
            std::thread::sleep(timeout);
        }
        false
    }

    fn signal(&self) {
        // SAFETY: signals an event handle this struct owns; a failure (a handle that is not an event) is not fatal.
        unsafe { SetEvent(self.handle as HANDLE) };
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: closes the handle once.
        unsafe { CloseHandle(self.handle as HANDLE) };
    }
}

/// Joins the MMCSS "Pro Audio" task on the calling thread. A failure is not fatal: the thread keeps its priority.
pub fn join_pro_audio() {
    let task = wide("Pro Audio");
    let mut index = 0u32;
    // SAFETY: a NUL-terminated task name that outlives the call; `index` is writable.
    unsafe { AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut index) };
}

/// Lets `pid` take the foreground, so the app can take it back when an editor closes (Spike 4). Zero is "no process".
pub fn allow_foreground(pid: u32) {
    if pid != 0 {
        // SAFETY: a plain call; it fails harmlessly for a process that is gone.
        unsafe { AllowSetForegroundWindow(pid) };
    }
}
