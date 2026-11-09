//! The editor: an `IPlugView` that holds one child static window, `EDITOR_WIDTH` x `EDITOR_HEIGHT`.
//!
//! On `attached` it reports one edit to the host through `beginEdit`, `performEdit` and `endEdit` on the `edits`
//! parameter, so a test can see that the editor opened without clicking anything. `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1`
//! turns that off. `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=<n>` then blocks the calling thread (the host's UI thread) for `n`
//! milliseconds, to show a slow or stuck editor. `TABPLAYER_TEST_PLUGIN_VIEW_MODAL_MS=<n>` instead runs a nested message
//! loop on that thread for `n` milliseconds, as a modal licence dialog does: the thread keeps dispatching window
//! messages, and drops thread messages.
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::{CStr, c_void};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicPtr, AtomicU32, Ordering};
use std::time::Duration;

use vst3::{Class, Steinberg::*};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, SWP_NOMOVE,
    SWP_NOZORDER, SetWindowPos, TranslateMessage, WS_CHILD, WS_VISIBLE,
};

use crate::{
    EDITOR_HEIGHT, EDITOR_WIDTH, ENV_VIEW_HANG_MS, ENV_VIEW_MODAL_MS, ENV_VIEW_NO_EDIT, Shared,
    TEST_PLUGIN_NAME,
};

/// The static control style that centres its text; `windows-sys` does not define the `SS_*` styles.
const SS_CENTER: u32 = 1;

pub(crate) struct TestView {
    shared: Arc<Shared>,
    window: AtomicPtr<c_void>,
    /// The content scale factor the host set (`f32` bits). The editor is `EDITOR_WIDTH` x `EDITOR_HEIGHT` times it, so a
    /// test can see that the host told the view about a DPI change.
    scale: AtomicU32,
}

impl TestView {
    pub(crate) fn new(shared: Arc<Shared>) -> TestView {
        TestView {
            shared,
            window: AtomicPtr::new(ptr::null_mut()),
            scale: AtomicU32::new(1.0f32.to_bits()),
        }
    }

    /// The editor's size in pixels at the current scale.
    fn size(&self) -> (i32, i32) {
        let scale = f32::from_bits(self.scale.load(Ordering::Relaxed));
        (
            (EDITOR_WIDTH as f32 * scale).round() as i32,
            (EDITOR_HEIGHT as f32 * scale).round() as i32,
        )
    }

    fn destroy_window(&self) {
        let window = self.window.swap(ptr::null_mut(), Ordering::AcqRel);
        if !window.is_null() {
            // SAFETY: the window is the child this view created in `attached` and has not destroyed yet.
            unsafe { DestroyWindow(window as HWND) };
        }
    }
}

impl Drop for TestView {
    fn drop(&mut self) {
        // A host that forgot `removed` still must not leak the window. Destroying it from another thread fails harmlessly.
        self.destroy_window();
    }
}

impl Class for TestView {
    type Interfaces = (IPlugView, IPlugViewContentScaleSupport);
}

impl IPlugViewContentScaleSupportTrait for TestView {
    unsafe fn setContentScaleFactor(&self, factor: f32) -> tresult {
        if !factor.is_finite() || factor <= 0.0 {
            return kInvalidArgument;
        }
        self.scale.store(factor.to_bits(), Ordering::Relaxed);
        let window = self.window.load(Ordering::Acquire);
        if !window.is_null() {
            let (width, height) = self.size();
            SetWindowPos(
                window as HWND,
                ptr::null_mut(),
                0,
                0,
                width,
                height,
                SWP_NOMOVE | SWP_NOZORDER,
            );
        }
        kResultOk
    }
}

/// A nested message loop for `ms` milliseconds: window messages are dispatched, thread messages (no window) are dropped.
fn modal_loop(ms: u64) {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    // SAFETY: the standard peek-dispatch loop on the calling thread; `msg` is writable.
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while std::time::Instant::now() < end {
            if PeekMessageW(&mut msg, ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            } else {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

impl IPlugViewTrait for TestView {
    unsafe fn isPlatformTypeSupported(&self, r#type: FIDString) -> tresult {
        if !r#type.is_null() && CStr::from_ptr(r#type).to_bytes() == b"HWND" {
            kResultTrue
        } else {
            kResultFalse
        }
    }

    unsafe fn attached(&self, parent: *mut c_void, r#type: FIDString) -> tresult {
        if parent.is_null() || self.isPlatformTypeSupported(r#type) != kResultTrue {
            return kInvalidArgument;
        }
        self.destroy_window();
        let class = wide("STATIC");
        let title = wide(TEST_PLUGIN_NAME);
        let window = CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            WS_CHILD | WS_VISIBLE | SS_CENTER,
            0,
            0,
            self.size().0,
            self.size().1,
            parent as HWND,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if window.is_null() {
            return kInternalError;
        }
        self.window.store(window as *mut c_void, Ordering::Release);

        if std::env::var(ENV_VIEW_NO_EDIT).as_deref() != Ok("1") {
            self.shared.report_edit();
        }
        if let Some(ms) = std::env::var(ENV_VIEW_HANG_MS)
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok())
        {
            std::thread::sleep(Duration::from_millis(ms));
        }
        if let Some(ms) = std::env::var(ENV_VIEW_MODAL_MS)
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok())
        {
            modal_loop(ms);
        }
        kResultOk
    }

    unsafe fn removed(&self) -> tresult {
        self.destroy_window();
        kResultOk
    }

    unsafe fn onWheel(&self, _distance: f32) -> tresult {
        kResultFalse
    }

    unsafe fn onKeyDown(&self, _key: char16, _key_code: int16, _modifiers: int16) -> tresult {
        kResultFalse
    }

    unsafe fn onKeyUp(&self, _key: char16, _key_code: int16, _modifiers: int16) -> tresult {
        kResultFalse
    }

    unsafe fn getSize(&self, size: *mut ViewRect) -> tresult {
        if size.is_null() {
            return kInvalidArgument;
        }
        let (width, height) = self.size();
        *size = ViewRect {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        kResultOk
    }

    unsafe fn onSize(&self, _new_size: *mut ViewRect) -> tresult {
        kResultOk
    }

    unsafe fn onFocus(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn setFrame(&self, _frame: *mut IPlugFrame) -> tresult {
        kResultOk
    }

    unsafe fn canResize(&self) -> tresult {
        kResultFalse
    }

    unsafe fn checkSizeConstraint(&self, rect: *mut ViewRect) -> tresult {
        if rect.is_null() {
            return kInvalidArgument;
        }
        *rect = ViewRect {
            left: 0,
            top: 0,
            right: EDITOR_WIDTH,
            bottom: EDITOR_HEIGHT,
        };
        kResultOk
    }
}
