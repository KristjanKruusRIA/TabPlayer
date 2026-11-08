// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in this folder.
// Changed for TabPlayer (THE-71): the Windows extract only. Changes are marked "TabPlayer:".

use super::module::tuid_bytes;
use super::queue::EditQueue;
use super::{
    AtomicBool, AtomicU32, Class, ComWrapper, EDIT_QUEUE_CAP, FUnknown, IComponentHandlerTrait,
    IHostApplicationTrait, Interface, Mutex, Ordering, PoisonError, c_void, sb, sv, write_c16,
};

// ---- host-side COM objects -----------------------------------------------------------------

/// The host context handed to `initialize` (`IHostApplication`) and to the controller (`IComponentHandler`).
///
/// TabPlayer: this object is called from whatever thread the plug-in picks. The test plug-in, like real ones, calls
/// `restartComponent` from its audio thread, so nothing here blocks, locks or allocates: a restart is recorded in an
/// atomic bit set and the main thread is woken with `notify` (one `PostMessageW`, only when no restart was pending).
/// Editor edits go into the lock-free [`EditQueue`] the audio thread drains once per block.
pub(crate) struct HostContext {
    /// `performEdit` values (normalized) on their way to the processor.
    pub edits: EditQueue,
    /// The `RestartFlags` the plug-in has asked for since the main thread last took them.
    restart_flags: AtomicU32,
    /// Whether the plug-in's state may have changed in its editor since the main thread last looked.
    dirty: AtomicBool,
    notify: fn(),
}

impl HostContext {
    pub fn new(notify: fn()) -> HostContext {
        HostContext {
            edits: EditQueue::new(EDIT_QUEUE_CAP),
            restart_flags: AtomicU32::new(0),
            dirty: AtomicBool::new(false),
            notify,
        }
    }

    /// The restart flags recorded since the last call, cleared.
    pub fn take_restart_flags(&self) -> u32 {
        self.restart_flags.swap(0, Ordering::AcqRel)
    }

    /// Whether an edit arrived since the last call, cleared.
    pub fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::AcqRel)
    }

    fn mark_dirty(&self) {
        if !self.dirty.swap(true, Ordering::AcqRel) {
            (self.notify)();
        }
    }
}

impl Class for HostContext {
    type Interfaces = (sv::IHostApplication, sv::IComponentHandler);
}

impl IHostApplicationTrait for HostContext {
    unsafe fn getName(&self, name: *mut sv::String128) -> sb::tresult {
        // SAFETY: the plugin passes a pointer to a writable String128 (or null, handled).
        match unsafe { name.as_mut() } {
            Some(n) => {
                write_c16("TabPlayer", n);
                sb::kResultOk
            }
            None => sb::kInvalidArgument,
        }
    }

    /// Creates the objects plugins may ask the host for: `IMessage` (what a controller and its
    /// processor send each other through `IConnectionPoint::notify`) and `IAttributeList`.
    /// Plugins that talk between their halves this way fail without them (Line 6 Helix
    /// reported "Failed to get content database recovery info (Out of memory condition)").
    unsafe fn createInstance(
        &self,
        cid: *mut sb::TUID,
        iid: *mut sb::TUID,
        obj: *mut *mut c_void,
    ) -> sb::tresult {
        // SAFETY: `obj` is the plugin's out-pointer (or null, handled).
        let Some(out) = (unsafe { obj.as_mut() }) else {
            return sb::kInvalidArgument;
        };
        *out = std::ptr::null_mut();
        // SAFETY: `cid` and `iid` point to 16-byte TUIDs (or are null, handled).
        let (Some(cid), Some(iid)) = (unsafe { cid.as_ref() }, unsafe { iid.as_ref() }) else {
            return sb::kInvalidArgument;
        };
        let (cid, iid) = (tuid_bytes(cid), tuid_bytes(iid));
        let wants = |class: [u8; 16]| cid == class && (iid == class || iid == FUnknown::IID);
        let made = if wants(sv::IMessage::IID) {
            ComWrapper::new(HostMessage::default())
                .to_com_ptr::<sv::IMessage>()
                .map(|p| p.into_raw().cast::<c_void>())
        } else if wants(sv::IAttributeList::IID) {
            ComWrapper::new(HostAttributes::default())
                .to_com_ptr::<sv::IAttributeList>()
                .map(|p| p.into_raw().cast::<c_void>())
        } else {
            None
        };
        match made {
            Some(p) => {
                *out = p;
                sb::kResultOk
            }
            None => sb::kResultFalse,
        }
    }
}

impl IComponentHandlerTrait for HostContext {
    unsafe fn beginEdit(&self, _id: sv::ParamID) -> sb::tresult {
        sb::kResultOk
    }
    unsafe fn performEdit(&self, id: sv::ParamID, value: sv::ParamValue) -> sb::tresult {
        if value.is_finite() {
            self.edits.push(id, value.clamp(0.0, 1.0));
            self.mark_dirty();
        }
        sb::kResultOk
    }
    unsafe fn endEdit(&self, _id: sv::ParamID) -> sb::tresult {
        self.mark_dirty();
        sb::kResultOk
    }
    /// Safe to call from any thread, the audio thread included: one atomic OR and, the first time, one `PostMessageW`.
    unsafe fn restartComponent(&self, flags: sb::int32) -> sb::tresult {
        if self.restart_flags.fetch_or(flags as u32, Ordering::AcqRel) == 0 {
            (self.notify)();
        }
        sb::kResultOk
    }
}

/// Longest string attribute kept, in UTF-16 units (longer ones are cut).
const ATTR_STRING_MAX: usize = 1 << 20;

/// Largest binary attribute kept.
const ATTR_BINARY_MAX: usize = 256 << 20;

/// One `IAttributeList` value. Strings and blobs live in their own allocation, so a pointer
/// handed out by `getBinary` stays valid while the list holds the value.
enum Attr {
    Int(i64),
    Float(f64),
    Str(Box<[u16]>),
    Bin(Box<[u8]>),
}

/// The host's `IAttributeList`: what a plugin puts in an `IMessage`.
#[derive(Default)]
pub(crate) struct HostAttributes {
    values: Mutex<std::collections::HashMap<Vec<u8>, Attr>>,
}

impl Class for HostAttributes {
    type Interfaces = (sv::IAttributeList,);
}

/// An attribute id's bytes (`None` for a null id).
fn attr_key(id: sv::IAttributeList_::AttrID) -> Option<Vec<u8>> {
    // SAFETY: a non-null AttrID is a NUL-terminated C string owned by the caller.
    (!id.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(id) }.to_bytes().to_vec())
}

impl HostAttributes {
    fn values(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<Vec<u8>, Attr>> {
        self.values.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, id: sv::IAttributeList_::AttrID, v: Attr) -> sb::tresult {
        let Some(k) = attr_key(id) else {
            return sb::kInvalidArgument;
        };
        self.values().insert(k, v);
        sb::kResultOk
    }
}

impl sv::IAttributeListTrait for HostAttributes {
    unsafe fn setInt(&self, id: sv::IAttributeList_::AttrID, value: sb::int64) -> sb::tresult {
        self.set(id, Attr::Int(value))
    }

    unsafe fn getInt(&self, id: sv::IAttributeList_::AttrID, value: *mut sb::int64) -> sb::tresult {
        // SAFETY: `value` is the caller's out-pointer (or null, handled).
        match (
            attr_key(id).and_then(|k| match self.values().get(&k) {
                Some(Attr::Int(v)) => Some(*v),
                _ => None,
            }),
            unsafe { value.as_mut() },
        ) {
            (Some(v), Some(out)) => {
                *out = v;
                sb::kResultOk
            }
            _ => sb::kResultFalse,
        }
    }

    unsafe fn setFloat(&self, id: sv::IAttributeList_::AttrID, value: f64) -> sb::tresult {
        self.set(id, Attr::Float(value))
    }

    unsafe fn getFloat(&self, id: sv::IAttributeList_::AttrID, value: *mut f64) -> sb::tresult {
        // SAFETY: `value` is the caller's out-pointer (or null, handled).
        match (
            attr_key(id).and_then(|k| match self.values().get(&k) {
                Some(Attr::Float(v)) => Some(*v),
                _ => None,
            }),
            unsafe { value.as_mut() },
        ) {
            (Some(v), Some(out)) => {
                *out = v;
                sb::kResultOk
            }
            _ => sb::kResultFalse,
        }
    }

    unsafe fn setString(
        &self,
        id: sv::IAttributeList_::AttrID,
        string: *const sv::TChar,
    ) -> sb::tresult {
        if string.is_null() {
            return sb::kInvalidArgument;
        }
        let mut s = Vec::new();
        // SAFETY: a non-null string is NUL-terminated UTF-16 owned by the caller; reading stops at
        // the NUL or at ATTR_STRING_MAX units.
        while s.len() < ATTR_STRING_MAX {
            let c = unsafe { *string.add(s.len()) };
            if c == 0 {
                break;
            }
            s.push(c);
        }
        self.set(id, Attr::Str(s.into_boxed_slice()))
    }

    unsafe fn getString(
        &self,
        id: sv::IAttributeList_::AttrID,
        string: *mut sv::TChar,
        size_in_bytes: sb::uint32,
    ) -> sb::tresult {
        let units = size_in_bytes as usize / 2;
        if string.is_null() || units == 0 {
            return sb::kInvalidArgument;
        }
        let Some(k) = attr_key(id) else {
            return sb::kInvalidArgument;
        };
        let values = self.values();
        let Some(Attr::Str(s)) = values.get(&k) else {
            return sb::kResultFalse;
        };
        let n = s.len().min(units - 1);
        // SAFETY: the caller's buffer holds `units` UTF-16 units; `n + 1 <= units` are written.
        unsafe {
            std::ptr::copy_nonoverlapping(s.as_ptr(), string, n);
            *string.add(n) = 0;
        }
        sb::kResultOk
    }

    unsafe fn setBinary(
        &self,
        id: sv::IAttributeList_::AttrID,
        data: *const c_void,
        size_in_bytes: sb::uint32,
    ) -> sb::tresult {
        let n = size_in_bytes as usize;
        if n > ATTR_BINARY_MAX {
            return sb::kOutOfMemory;
        }
        let bytes: Box<[u8]> = if n == 0 || data.is_null() {
            Box::new([])
        } else {
            // SAFETY: the caller's `data` holds `n` readable bytes.
            unsafe { std::slice::from_raw_parts(data.cast::<u8>(), n) }.into()
        };
        self.set(id, Attr::Bin(bytes))
    }

    unsafe fn getBinary(
        &self,
        id: sv::IAttributeList_::AttrID,
        data: *mut *const c_void,
        size_in_bytes: *mut sb::uint32,
    ) -> sb::tresult {
        let Some(k) = attr_key(id) else {
            return sb::kInvalidArgument;
        };
        let values = self.values();
        let Some(Attr::Bin(b)) = values.get(&k) else {
            return sb::kResultFalse;
        };
        // SAFETY: both are the caller's out-pointers (or null, handled). The pointer handed out
        // stays valid until this attribute is replaced or the list is released (VST3 contract).
        match (unsafe { data.as_mut() }, unsafe { size_in_bytes.as_mut() }) {
            (Some(d), Some(sz)) => {
                *d = b.as_ptr().cast::<c_void>();
                *sz = u32::try_from(b.len()).unwrap_or(u32::MAX);
                sb::kResultOk
            }
            _ => sb::kInvalidArgument,
        }
    }
}

/// The host's `IMessage`: an id and an attribute list, created for a plugin through
/// `IHostApplication::createInstance`.
pub(crate) struct HostMessage {
    id: Mutex<std::ffi::CString>,
    attributes: ComWrapper<HostAttributes>,
}

impl Default for HostMessage {
    fn default() -> Self {
        HostMessage {
            id: Mutex::new(std::ffi::CString::default()),
            attributes: ComWrapper::new(HostAttributes::default()),
        }
    }
}

impl Class for HostMessage {
    type Interfaces = (sv::IMessage,);
}

impl sv::IMessageTrait for HostMessage {
    unsafe fn getMessageID(&self) -> sb::FIDString {
        // The string's buffer lives until the next `setMessageID`, as the interface expects.
        self.id
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ptr()
    }

    unsafe fn setMessageID(&self, id: sb::FIDString) {
        // SAFETY: a non-null id is a NUL-terminated C string owned by the caller.
        let s = if id.is_null() {
            std::ffi::CString::default()
        } else {
            unsafe { std::ffi::CStr::from_ptr(id) }.to_owned()
        };
        *self.id.lock().unwrap_or_else(PoisonError::into_inner) = s;
    }

    unsafe fn getAttributes(&self) -> *mut sv::IAttributeList {
        // Not add-ref'ed: the list belongs to the message (VST3 contract).
        self.attributes
            .as_com_ref::<sv::IAttributeList>()
            .map_or(std::ptr::null_mut(), |r| r.as_ptr())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static WAKES: AtomicUsize = AtomicUsize::new(0);
    fn wake() {
        WAKES.fetch_add(1, Ordering::SeqCst);
    }

    /// One test, because the wake counter is shared.
    #[test]
    fn the_handler_is_safe_from_any_thread_and_wakes_the_main_thread_once() {
        let context = ComWrapper::new(HostContext::new(wake));
        // `restartComponent` from another thread, as the test plug-in does from its audio thread.
        std::thread::scope(|scope| {
            scope.spawn(|| {
                // SAFETY: the handler methods take plain numbers.
                unsafe {
                    context.restartComponent(sv::RestartFlags_::kLatencyChanged);
                    context.restartComponent(sv::RestartFlags_::kParamValuesChanged);
                    context.restartComponent(sv::RestartFlags_::kLatencyChanged);
                }
            });
        });
        assert_eq!(WAKES.load(Ordering::SeqCst), 1, "one wake for a burst");
        let flags = context.take_restart_flags();
        assert_eq!(
            flags,
            (sv::RestartFlags_::kLatencyChanged | sv::RestartFlags_::kParamValuesChanged) as u32
        );
        assert_eq!(context.take_restart_flags(), 0, "taken");
        // A new restart after the flags were taken wakes again.
        // SAFETY: as above.
        unsafe { context.restartComponent(sv::RestartFlags_::kIoChanged) };
        assert_eq!(WAKES.load(Ordering::SeqCst), 2);
        context.take_restart_flags();

        // Edits go into the lock-free queue, in order, clamped, and mark the state dirty with one wake.
        // SAFETY: as above.
        unsafe {
            context.beginEdit(5);
            context.performEdit(5, 0.25);
            context.performEdit(5, 7.0);
            context.performEdit(5, f64::NAN);
            context.endEdit(5);
        }
        assert_eq!(context.edits.pop(), Some((5, 0.25)));
        assert_eq!(context.edits.pop(), Some((5, 1.0)));
        assert_eq!(context.edits.pop(), None, "a NaN is dropped");
        assert!(context.take_dirty());
        assert!(!context.take_dirty());
        assert_eq!(WAKES.load(Ordering::SeqCst), 3);
    }
}
