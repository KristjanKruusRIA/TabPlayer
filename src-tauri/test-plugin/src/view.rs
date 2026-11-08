//! The editor: an `IPlugView` that holds one child static window, `EDITOR_WIDTH` x `EDITOR_HEIGHT`.
//!
//! On `attached` it reports one edit to the host through `beginEdit`, `performEdit` and `endEdit` on the `edits`
//! parameter, so a test can see that the editor opened without clicking anything. `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1`
//! turns that off. `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=<n>` then blocks the calling thread (the host's UI thread) for `n`
//! milliseconds, to show a slow or stuck editor.
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::{CStr, c_void};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::time::Duration;

use vst3::{Class, Steinberg::*};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, WS_CHILD, WS_VISIBLE,
};

use crate::{
    EDITOR_HEIGHT, EDITOR_WIDTH, ENV_VIEW_HANG_MS, ENV_VIEW_NO_EDIT, Shared, TEST_PLUGIN_NAME,
};

/// The static control style that centres its text; `windows-sys` does not define the `SS_*` styles.
const SS_CENTER: u32 = 1;

pub(crate) struct TestView {
    shared: Arc<Shared>,
    window: AtomicPtr<c_void>,
}

impl TestView {
    pub(crate) fn new(shared: Arc<Shared>) -> TestView {
        TestView {
            shared,
            window: AtomicPtr::new(ptr::null_mut()),
        }
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
    type Interfaces = (IPlugView,);
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
            EDITOR_WIDTH,
            EDITOR_HEIGHT,
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
        *size = ViewRect {
            left: 0,
            top: 0,
            right: EDITOR_WIDTH,
            bottom: EDITOR_HEIGHT,
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
