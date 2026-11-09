//! The focus rules for the editor window, from Spike 4 (`docs/validation/2026-11-08-vst-spikes.md`).
//!
//! - **Open.** The app calls `AllowSetForegroundWindow(helper pid)` just before it sends `OpenEditor`. The helper creates
//!   the window unowned and unparented, shows it, takes the foreground and the keyboard focus (all in the vendored
//!   `vst3/editor.rs`), and replies `EditorOpened` only if the window belongs to its own process (preflight ruling P29).
//! - **Close.** The helper calls `AllowSetForegroundWindow(app pid)` (the pid came in `Load`) before it tears the view
//!   down, whether the app asked for the close or the user pressed the window's close button. The app then takes its
//!   own window back.
//! - **Never** an owner or parent link to the app's window (a hung helper would stall the app's UI thread), and never
//!   `PostThreadMessageW` (a modal loop drops it; the requests use a message-only window instead).
use crate::{vst3::window_pid, winio::allow_foreground};
use std::ffi::c_void;
use windows_sys::Win32::System::Threading::GetCurrentProcessId;

/// Whether `hwnd` is a window of this process.
pub fn is_own_window(hwnd: usize) -> bool {
    // SAFETY: a plain call.
    hwnd != 0 && window_pid(hwnd as *mut c_void) == unsafe { GetCurrentProcessId() }
}

/// Lets the app take the foreground. A zero pid (none was given) does nothing.
pub fn allow_app_foreground(app_pid: u32) {
    allow_foreground(app_pid);
}
