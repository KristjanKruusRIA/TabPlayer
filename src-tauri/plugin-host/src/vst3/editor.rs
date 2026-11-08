// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in this folder.
// Changed for TabPlayer (THE-71): the Windows extract only. Changes are marked "TabPlayer:".

use super::instance::Instance;
use super::{
    Class, ComPtr, ComWrapper, IComponentTrait, IEditControllerTrait, IPlugFrameTrait,
    IPlugViewTrait, Mutex, Ordering, PoisonError, c_void, ok, sb, sv, window,
};
use vst3::Steinberg::IPlugViewContentScaleSupportTrait;

// ---- editor (IPlugView) --------------------------------------------------------------------

/// The `IPlugFrame` handed to a plugin view: `resizeView` resizes our host window.
pub(crate) struct PlugFrame {
    /// The host window, not owned; null when there is none.
    window: std::sync::atomic::AtomicPtr<c_void>,
}

impl Class for PlugFrame {
    type Interfaces = (sb::IPlugFrame,);
}

impl IPlugFrameTrait for PlugFrame {
    unsafe fn resizeView(
        &self,
        view: *mut sb::IPlugView,
        new_size: *mut sb::ViewRect,
    ) -> sb::tresult {
        // TabPlayer: the window belongs to the main thread, and resizing it from another thread sends messages to the main
        // thread synchronously, which can deadlock against a plugin worker the main thread waits for. A plugin that kept
        // the frame after the editor closed finds a null window.
        let window = self.window.load(Ordering::Relaxed);
        if !window::on_main_thread() || window.is_null() {
            return sb::kResultFalse;
        }
        // SAFETY: in-pointer from the plugin (or null, handled).
        let Some(r) = (unsafe { new_size.as_mut() }) else {
            return sb::kInvalidArgument;
        };
        let (w, h) = rect_size(r);
        window::resize(window, w, h);
        // SAFETY: the plugin passes its own live view (or null, handled).
        if let Some(v) = unsafe { vst3::ComRef::from_raw(view) } {
            // SAFETY: valid view; `r` is the plugin's own writable rect.
            unsafe { v.onSize(r) };
        }
        sb::kResultOk
    }
}

/// Width and height of a view rect, clamped to a sane window size.
fn rect_size(r: &sb::ViewRect) -> (f64, f64) {
    let w = r.right.saturating_sub(r.left).clamp(1, 16_384);
    let h = r.bottom.saturating_sub(r.top).clamp(1, 16_384);
    (f64::from(w), f64::from(h))
}

#[derive(Default)]
pub(super) struct EditorInner {
    /// `None` once the instance is gone.
    pub(super) component: Option<ComPtr<sv::IComponent>>,
    /// `None` once the instance is gone, or without an edit controller.
    pub(super) controller: Option<ComPtr<sv::IEditController>>,
    pub(super) view: Option<ComPtr<sb::IPlugView>>,
    pub(super) frame: Option<ComWrapper<PlugFrame>>,
    pub(super) window: Option<window::HostWindow>,
}

/// Why a state could not be read from the plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StateReadError {
    /// A part passes the state cap.
    TooLarge,
    /// The plugin failed to write its state, or the instance is gone.
    Failed,
}

/// What opening an editor produced.
#[derive(Debug, Clone, Copy)]
pub(crate) struct OpenedEditor {
    pub hwnd: usize,
}

/// The link between an instance and its editor and state handles. The instance may process on
/// the audio thread while the editor (the edit controller's `IPlugView`) is driven and the state
/// read from the main thread, which is VST3's own threading model (controller, views and
/// `getState` on the UI thread). All such calls happen under this lock, and the instance closes
/// the view and drops the component and controller references under the same lock before it
/// terminates, so a handle never calls into a dead plugin.
#[derive(Default)]
pub(crate) struct EditorLink {
    pub(super) inner: Mutex<EditorInner>,
}

impl EditorLink {
    fn lock(&self) -> std::sync::MutexGuard<'_, EditorInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn has_controller(&self) -> bool {
        self.lock().controller.is_some()
    }

    fn create_view(g: &EditorInner) -> Result<ComPtr<sb::IPlugView>, String> {
        let c = g
            .controller
            .as_ref()
            .ok_or_else(|| "the plugin is gone".to_string())?;
        // SAFETY: valid controller; the name is a static NUL-terminated string.
        let raw = unsafe { c.createView(c"editor".as_ptr()) };
        // SAFETY: a non-null view comes with one reference owned by the caller.
        unsafe { ComPtr::from_raw(raw) }.ok_or_else(|| "this plugin has no editor".to_string())
    }

    /// Opens (or raises) the editor in a host window. Main thread only.
    ///
    /// TabPlayer: the order is the one that worked at 150 % in Spike 4. The window is made first, to learn the DPI of the
    /// monitor it lands on (it is put at `near`'s centre, or the system's choice); the view is told the content scale if it
    /// can take it; the window is sized so its client area equals the view's size; and after `attached` the size is read
    /// again, because some views correct it then. The window is unowned, then shown, raised and given the focus.
    ///
    /// `near` is a screen rectangle in physical pixels to centre the window in.
    pub fn open(
        &self,
        title: &str,
        near: Option<(i32, i32, u32, u32)>,
    ) -> Result<OpenedEditor, String> {
        if !window::on_main_thread() {
            return Err("plugin editors must be opened on the main thread".into());
        }
        let platform = window::PLATFORM_TYPE
            .ok_or_else(|| "VST3 editors are not hosted on this platform yet".to_string())?;
        let mut g = self.lock();
        if let Some(w) = &g.window {
            if w.is_visible() {
                w.raise();
                return Ok(OpenedEditor {
                    hwnd: w.raw() as usize,
                });
            }
            // The user closed the window: start over.
            EditorLink::teardown(&mut g);
        }
        let view = EditorLink::create_view(&g)?;
        // SAFETY: valid view; `platform` is a static NUL-terminated string.
        if unsafe { view.isPlatformTypeSupported(platform) } != sb::kResultTrue {
            return Err("the editor does not support this platform's windows".into());
        }
        // A throwaway size first: the DPI is only known once the window exists on a monitor.
        let at = near.map(|(x, y, w, h)| {
            let cx = x.saturating_add(i32::try_from(w / 2).unwrap_or(0));
            let cy = y.saturating_add(i32::try_from(h / 2).unwrap_or(0));
            (cx.saturating_sub(50), cy.saturating_sub(50))
        });
        let win = window::HostWindow::new(title, 100.0, 100.0, at)?;
        let scale = win.dpi().max(96) as f32 / 96.0;
        if let Some(support) = view.cast::<sb::IPlugViewContentScaleSupport>() {
            // SAFETY: valid view interface.
            unsafe { support.setContentScaleFactor(scale) };
        }
        let mut r = sb::ViewRect {
            left: 0,
            top: 0,
            right: 400,
            bottom: 300,
        };
        // SAFETY: valid view; `r` is writable. On failure the default size stays.
        unsafe { view.getSize(&mut r) };
        let (w, h) = rect_size(&r);
        window::resize(win.raw(), w, h);
        let frame = ComWrapper::new(PlugFrame {
            window: std::sync::atomic::AtomicPtr::new(win.raw()),
        });
        if let Some(f) = frame.as_com_ref::<sb::IPlugFrame>() {
            // SAFETY: valid view; the frame outlives the view's attachment (kept in `g.frame`
            // and detached in `teardown`).
            unsafe { view.setFrame(f.as_ptr()) };
        }
        // SAFETY: valid view; the parent is the live content view of `win`, of the type named.
        if !ok(unsafe { view.attached(win.parent(), platform) }) {
            frame.window.store(std::ptr::null_mut(), Ordering::Relaxed);
            // SAFETY: valid view; detach our frame again.
            unsafe { view.setFrame(std::ptr::null_mut()) };
            win.close();
            return Err("the editor could not attach to its window".into());
        }
        // The plug-in may have changed its size while attaching (Spike 4: SLAMP does, and a host that reads once clips it).
        let mut after = sb::ViewRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: valid view; `after` is writable.
        if ok(unsafe { view.getSize(&mut after) }) {
            let (w2, h2) = rect_size(&after);
            if (w2, h2) != (w, h) {
                window::resize(win.raw(), w2, h2);
            }
        }
        if let Some(near) = near {
            win.place_near(near);
        }
        win.raise();
        win.focus_child();
        // SAFETY: valid, attached view. Plug-ins that track focus use it; most return not-implemented.
        unsafe { view.onFocus(1) };
        let hwnd = win.raw() as usize;
        g.view = Some(view);
        g.frame = Some(frame);
        g.window = Some(win);
        Ok(OpenedEditor { hwnd })
    }

    fn teardown(g: &mut EditorInner) {
        if let Some(view) = g.view.take() {
            // SAFETY: valid, attached view; main thread (callers check). `removed` before the
            // window goes, and the frame is detached before it is released.
            unsafe {
                view.removed();
                view.setFrame(std::ptr::null_mut());
            }
        }
        // TabPlayer: cut the frame off from the window before the window goes, so a late `resizeView` finds nothing.
        if let Some(frame) = g.frame.take() {
            frame.window.store(std::ptr::null_mut(), Ordering::Relaxed);
        }
        if let Some(w) = g.window.take() {
            w.close();
        }
    }

    /// Applies a DPI change that Windows reported for the editor's window (`WM_DPICHANGED`): tells the view the new scale,
    /// reads its size again, resizes the window to match and tells the view. Windows has already moved the window to
    /// the rectangle it suggests; the view's own size wins. Main thread only; does nothing without an open editor or a
    /// change.
    pub fn apply_dpi_change(&self) {
        if !window::on_main_thread() {
            return;
        }
        let dpi = window::DPI_CHANGED.swap(0, Ordering::AcqRel);
        if dpi == 0 {
            return;
        }
        let g = self.lock();
        let (Some(view), Some(win)) = (&g.view, &g.window) else {
            return;
        };
        if let Some(support) = view.cast::<sb::IPlugViewContentScaleSupport>() {
            // SAFETY: valid view interface.
            unsafe { support.setContentScaleFactor(dpi as f32 / 96.0) };
        }
        let mut r = sb::ViewRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: valid view; `r` is writable.
        if ok(unsafe { view.getSize(&mut r) }) {
            let (w, h) = rect_size(&r);
            window::resize(win.raw(), w, h);
            // SAFETY: valid, attached view; `r` is the rectangle it just reported.
            unsafe { view.onSize(&mut r) };
        }
    }

    /// The component state plus the controller state, as two parts. TabPlayer: SoundCraft joined them in its own container;
    /// the caller builds TabPlayer's from the parts.
    pub fn save_state(&self) -> Result<(Vec<u8>, Vec<u8>), StateReadError> {
        let g = self.lock();
        let component = g.component.as_ref().ok_or(StateReadError::Failed)?;
        let read = |result: Result<Vec<u8>, bool>| {
            result.map_err(|overflow| {
                if overflow {
                    StateReadError::TooLarge
                } else {
                    StateReadError::Failed
                }
            })
        };
        // SAFETY: valid component (the instance clears it under this lock before it terminates);
        // the stream lives in `read_state` for the whole call.
        let comp = read(Instance::read_state(|s| unsafe { component.getState(s) }))?;
        let ctrl = match &g.controller {
            // SAFETY: valid controller; as above. A controller without a state is normal (the test plug-in's is the
            // same object as its component); a controller state past the cap is not.
            Some(c) => match Instance::read_state(|s| unsafe { c.getState(s) }) {
                Ok(bytes) => bytes,
                Err(true) => return Err(StateReadError::TooLarge),
                Err(false) => Vec::new(),
            },
            None => Vec::new(),
        };
        Ok((comp, ctrl))
    }

    /// Closes the editor. Main thread only (no-op elsewhere).
    pub fn close(&self) {
        if window::on_main_thread() {
            EditorLink::teardown(&mut self.lock());
        }
    }

    /// Whether the user closed the window (its close button hides it) and the view is still attached. The caller then
    /// hands the foreground back and calls [`EditorLink::close`].
    pub fn closed_by_user(&self) -> bool {
        if !window::on_main_thread() {
            return false;
        }
        let g = self.lock();
        g.window.as_ref().is_some_and(|w| !w.is_visible())
    }

    /// Called by the instance before it terminates: closes the editor and cuts the handles off.
    /// Returns whether plugin objects had to be leaked.
    pub(super) fn kill(&self) -> bool {
        let mut g = self.lock();
        let mut leaked = false;
        if g.view.is_some() || g.window.is_some() {
            if window::on_main_thread() {
                EditorLink::teardown(&mut g);
            } else {
                // Window calls are main-thread only; leak the view and window rather than crash.
                log::warn!(
                    "vst3: editor still open while its plugin is destroyed off the main thread"
                );
                if let Some(v) = g.view.take() {
                    std::mem::forget(v);
                    leaked = true;
                }
                // `HostWindow` has no destructor: dropping it leaks its retain on purpose.
                g.window = None;
                if let Some(f) = g.frame.take() {
                    std::mem::forget(f);
                }
            }
        }
        g.component = None;
        g.controller = None;
        leaked
    }
}
