// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in this folder.
// Changed for TabPlayer (THE-71): the Windows extract only. Changes are marked "TabPlayer:".

// TabPlayer: the editor window follows Spike 4 (`docs/validation/2026-11-08-vst-spikes.md`).
// - It is an unowned, unparented top-level window. SoundCraft took the active window as its owner; a cross-process
//   owner lets a hung helper stall the app's UI thread (8 s in the spike), so the owner is always null.
// - The process is per-monitor DPI aware v2 (set in `main`), and sizes are physical pixels: the window is sized with
//   `AdjustWindowRectExForDpi` so its client area equals the plug-in view.
// - It keeps its taskbar button (no `WS_EX_TOOLWINDOW`), so a buried editor stays findable.
use std::ffi::{c_char, c_void};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow,
    GW_CHILD, GWL_EXSTYLE, GWL_STYLE, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IDC_ARROW, IsWindow, IsWindowVisible, LoadCursorW, RegisterClassExW,
    SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetForegroundWindow,
    SetWindowPos, ShowWindow, WM_CLOSE, WM_DPICHANGED, WNDCLASSEXW, WS_CAPTION, WS_CLIPCHILDREN,
    WS_OVERLAPPED, WS_SYSMENU,
};

pub const PLATFORM_TYPE: Option<*const c_char> = Some(vst3::Steinberg::kPlatformTypeHWND);

/// The DPI Windows last reported for an editor window (`WM_DPICHANGED`), 0 once the editor has dealt with it. The window
/// procedure only records it: it can run inside a plugin call that holds the editor's lock, so the view is told later,
/// from `EditorLink::apply_dpi_change`.
pub static DPI_CHANGED: AtomicU32 = AtomicU32::new(0);

/// The OS id of the helper's main thread, recorded at start (0 until then).
static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);

/// TabPlayer: records the calling thread as the main thread. The helper's `main` calls it first thing. SoundCraft
/// compared the Rust thread name with "main", which names whichever thread Rust started first.
pub fn set_main_thread() {
    // SAFETY: `GetCurrentThreadId` takes no arguments and cannot fail.
    MAIN_THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
}

/// Whether this is the thread that owns the editor windows and the controller.
pub fn on_main_thread() -> bool {
    let main = MAIN_THREAD.load(Ordering::Acquire);
    // SAFETY: `GetCurrentThreadId` takes no arguments and cannot fail.
    main != 0 && main == unsafe { GetCurrentThreadId() }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16()
        .filter(|&c| c != 0)
        .chain(Some(0))
        .collect()
}

const STYLE: u32 = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_CLOSE {
        // SAFETY: `hwnd` is the window this procedure was called for.
        unsafe { ShowWindow(hwnd, SW_HIDE) };
        return 0;
    }
    if msg == WM_DPICHANGED {
        // The standard reaction: take the rectangle Windows suggests for the new monitor's DPI (lparam is null in a
        // message that was posted, not sent by Windows), then have the view told (see `DPI_CHANGED`).
        if lparam != 0 {
            // SAFETY: for WM_DPICHANGED sent by Windows, lparam points at the suggested RECT.
            let r = unsafe { &*(lparam as *const RECT) };
            // SAFETY: our own window.
            unsafe {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                )
            };
        }
        DPI_CHANGED.store((wparam & 0xffff) as u32, Ordering::Release);
        return 0;
    }
    // SAFETY: default handling of a message for the window it was sent to.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Registers the window class once; the name lives for the whole process.
fn class_name() -> Option<&'static [u16]> {
    static CLASS: OnceLock<Option<Vec<u16>>> = OnceLock::new();
    CLASS
        .get_or_init(|| {
            let name = wide("TabPlayerPluginEditor");
            // SAFETY: null asks for this process's module handle.
            let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                // SAFETY: a system cursor (null instance + predefined id).
                hCursor: unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW) },
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: name.as_ptr(),
                hIconSm: std::ptr::null_mut(),
            };
            // SAFETY: a fully initialised class description whose strings outlive the call
            // (the name is kept for the process lifetime in this `OnceLock`).
            (unsafe { RegisterClassExW(&wc) } != 0).then_some(name)
        })
        .as_deref()
}

/// Outer window size for a client area of `w`×`h`, at `dpi`.
fn outer_size(style: u32, ex_style: u32, w: f64, h: f64, dpi: u32) -> (i32, i32) {
    let mut r = RECT {
        left: 0,
        top: 0,
        right: w as i32,
        bottom: h as i32,
    };
    // SAFETY: `r` is a valid, writable rect.
    unsafe { AdjustWindowRectExForDpi(&mut r, style, 0, ex_style, dpi.max(96)) };
    (
        r.right.saturating_sub(r.left),
        r.bottom.saturating_sub(r.top),
    )
}

pub fn dpi_of(window: *mut c_void) -> u32 {
    // SAFETY: accepts any value; 0 on failure.
    unsafe { GetDpiForWindow(window) }
}

/// The process ID that owns `window`, 0 when it is not a window.
pub fn window_pid(window: *mut c_void) -> u32 {
    let mut pid = 0u32;
    // SAFETY: accepts any value; `pid` is writable.
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    pid
}

/// Owns the window handle; destroyed in `close` (main thread only).
pub struct HostWindow {
    hwnd: HWND,
}

// SAFETY: the handle is only used on the main thread (every method checks); the struct
// merely carries it between threads' locks.
unsafe impl Send for HostWindow {}

impl HostWindow {
    fn live(&self) -> Option<HWND> {
        // SAFETY: `IsWindow` accepts any value and only reports whether it names a window.
        (on_main_thread() && unsafe { IsWindow(self.hwnd) } != 0).then_some(self.hwnd)
    }

    /// Creates the window, hidden, with a client area of `w`×`h` physical pixels at the system DPI. `at` is the top-left
    /// corner, or the system's choice. TabPlayer: the owner is always null.
    pub fn new(title: &str, w: f64, h: f64, at: Option<(i32, i32)>) -> Result<HostWindow, String> {
        if !on_main_thread() {
            return Err("not on the main thread".into());
        }
        let class =
            class_name().ok_or_else(|| "cannot register the editor window class".to_string())?;
        let title = wide(title);
        // SAFETY: plain call.
        let system_dpi = unsafe { windows_sys::Win32::UI::HiDpi::GetDpiForSystem() };
        let (ow, oh) = outer_size(STYLE, 0, w, h, system_dpi);
        let (x, y) = at.unwrap_or((CW_USEDEFAULT, CW_USEDEFAULT));
        // SAFETY: registered class and NUL-terminated strings that outlive the call; no owner, no parent.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                STYLE,
                x,
                y,
                ow,
                oh,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            return Err("cannot create the editor window".into());
        }
        Ok(HostWindow { hwnd })
    }

    /// The DPI of the monitor the window is on.
    pub fn dpi(&self) -> u32 {
        dpi_of(self.hwnd)
    }

    /// The window handle (for the plug frame's resizes).
    pub fn raw(&self) -> *mut c_void {
        self.hwnd
    }

    /// The `HWND` the plugin view creates its child window in.
    pub fn parent(&self) -> *mut c_void {
        self.live().unwrap_or(std::ptr::null_mut())
    }

    /// Shows the window and asks for the foreground. Returns whether `SetForegroundWindow` succeeded.
    pub fn raise(&self) -> bool {
        match self.live() {
            Some(h) => {
                // SAFETY: a live window of this thread.
                unsafe {
                    ShowWindow(h, SW_SHOW);
                    SetForegroundWindow(h) != 0
                }
            }
            None => false,
        }
    }

    /// Gives the keyboard focus to the plug-in's first child window, so typing works before a click. Spike 4: the focus
    /// otherwise stays on the host window and a key typed before any click is dropped.
    pub fn focus_child(&self) {
        if let Some(h) = self.live() {
            // SAFETY: a live window of this thread; `SetFocus` accepts a null child.
            unsafe {
                let child = GetWindow(h, GW_CHILD);
                if !child.is_null() {
                    SetFocus(child);
                }
            }
        }
    }

    pub fn is_visible(&self) -> bool {
        // SAFETY: a live window of this thread.
        self.live()
            .is_some_and(|h| unsafe { IsWindowVisible(h) } != 0)
    }

    /// Centres the window in `near` (a rectangle in screen pixels), kept inside the work area of the monitor nearest to
    /// it. The size must be final: call it after sizing.
    pub fn place_near(&self, near: (i32, i32, u32, u32)) {
        let Some(h) = self.live() else { return };
        let mut own = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: a live window; `own` is writable.
        if unsafe { GetWindowRect(h, &mut own) } == 0 {
            return;
        }
        let (own_w, own_h) = (own.right - own.left, own.bottom - own.top);
        let (x, y, w, hgt) = near;
        let target = RECT {
            left: x,
            top: y,
            right: x.saturating_add(i32::try_from(w).unwrap_or(i32::MAX)),
            bottom: y.saturating_add(i32::try_from(hgt).unwrap_or(i32::MAX)),
        };
        // SAFETY: plain data; all-zero is valid, then `cbSize` is set.
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        // SAFETY: `target` is a valid rect; `info` is writable with its size set.
        let have_work = unsafe {
            GetMonitorInfoW(
                MonitorFromRect(&target, MONITOR_DEFAULTTONEAREST),
                &mut info,
            )
        } != 0;
        let mut left = target.left + ((target.right - target.left) - own_w) / 2;
        let mut top = target.top + ((target.bottom - target.top) - own_h) / 2;
        if have_work {
            let work = info.rcWork;
            left = left.min(work.right - own_w).max(work.left);
            top = top.min(work.bottom - own_h).max(work.top);
        }
        // SAFETY: a live window of this thread; only the position changes.
        unsafe {
            SetWindowPos(
                h,
                std::ptr::null_mut(),
                left,
                top,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
    }

    pub fn close(self) {
        if let Some(h) = self.live() {
            // SAFETY: our own live window; the view was detached before (see `teardown`).
            unsafe { DestroyWindow(h) };
        }
    }
}

/// Resizes a host window's client area (`window` from [`HostWindow::raw`]) in physical pixels; main thread only.
pub fn resize(window: *mut c_void, w: f64, h: f64) {
    // SAFETY: `IsWindow` accepts any value.
    if !on_main_thread() || window.is_null() || unsafe { IsWindow(window) } == 0 {
        return;
    }
    // SAFETY: a live window of this thread; style values are read, not changed.
    let (style, ex) = unsafe {
        (
            GetWindowLongPtrW(window, GWL_STYLE) as u32,
            GetWindowLongPtrW(window, GWL_EXSTYLE) as u32,
        )
    };
    let (ow, oh) = outer_size(style, ex, w, h, dpi_of(window));
    // SAFETY: as above; only the size changes.
    unsafe {
        SetWindowPos(
            window,
            std::ptr::null_mut(),
            0,
            0,
            ow,
            oh,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
}
