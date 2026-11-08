//! What the audio thread holds of a helper: the shared ring, the event that wakes the helper, and the word the audio thread
//! and the supervisor use to talk to each other (THE-71).
//!
//! Nothing here starts a process. [`BridgeLink`] is built by `HelperProcess::load` for a real helper, and by
//! [`BridgeLink::in_process`] for the audio tests, which run a fake helper on a thread over an [`OwnedRing`].
//!
//! # Handles on the audio thread
//!
//! Dropping the last `Arc<MappedRing>` or `Arc<EventHandle>` unmaps the view or closes the handle, which is a system call
//! and may free memory. A user of [`BridgeLink`] that runs on the audio thread (the insert, Task 11) never drops one there:
//! it hands displaced links to its retire list.
use std::sync::{
    Arc, Mutex, TryLockError,
    atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering},
};
use std::time::Duration;
use tabplayer_plugin_protocol::ring::{HostControl, HostRing, OwnedRing, RingHeader};

// ---- events ------------------------------------------------------------------------------------------------------

/// An auto-reset event: [`signal`](Self::signal) wakes one [`wait`](Self::wait), and a signal with nobody waiting is
/// remembered until the next wait. On Windows it is a kernel event that can be duplicated into the helper; elsewhere it is
/// a condition variable, which is all the in-process tests need.
pub struct EventHandle {
    inner: event::Inner,
}

impl EventHandle {
    pub fn new() -> std::io::Result<EventHandle> {
        Ok(EventHandle {
            inner: event::Inner::new()?,
        })
    }

    /// Wakes the waiter. It does not block, allocate or lock: on Windows it is one `SetEvent`.
    pub fn signal(&self) {
        self.inner.signal();
    }

    /// Waits until the event is signalled, resetting it, or `timeout` passes. True when it was signalled.
    pub fn wait(&self, timeout: Duration) -> bool {
        self.inner.wait(timeout)
    }

    #[cfg(windows)]
    pub(crate) fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.inner.raw()
    }
}

#[cfg(windows)]
mod event {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, INFINITE, SetEvent, WaitForSingleObject,
    };

    pub struct Inner {
        // A handle is a pointer-sized number, not a pointer to anything this struct could race on.
        handle: usize,
    }

    impl Inner {
        pub fn new() -> std::io::Result<Inner> {
            // SAFETY: an unnamed, non-inheritable auto-reset event, not signalled.
            let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
            if handle.is_null() {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(Inner {
                    handle: handle as usize,
                })
            }
        }

        pub fn raw(&self) -> HANDLE {
            self.handle as HANDLE
        }

        pub fn signal(&self) {
            // SAFETY: signals an event this struct owns.
            unsafe { SetEvent(self.raw()) };
        }

        pub fn wait(&self, timeout: Duration) -> bool {
            // `INFINITE` is `u32::MAX`; stay clear of it so a long timeout is not a wait for ever.
            let millis = u32::try_from(timeout.as_millis())
                .unwrap_or(INFINITE - 1)
                .min(INFINITE - 1);
            // SAFETY: waits on an event this struct owns.
            unsafe { WaitForSingleObject(self.raw(), millis) == WAIT_OBJECT_0 }
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            // SAFETY: closes the handle once.
            unsafe { CloseHandle(self.raw()) };
        }
    }
}

#[cfg(not(windows))]
mod event {
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;

    pub struct Inner {
        signalled: Mutex<bool>,
        changed: Condvar,
    }

    impl Inner {
        pub fn new() -> std::io::Result<Inner> {
            Ok(Inner {
                signalled: Mutex::new(false),
                changed: Condvar::new(),
            })
        }

        pub fn signal(&self) {
            *self.signalled.lock().unwrap_or_else(|e| e.into_inner()) = true;
            self.changed.notify_one();
        }

        pub fn wait(&self, timeout: Duration) -> bool {
            let guard = self.signalled.lock().unwrap_or_else(|e| e.into_inner());
            let (mut guard, _) = self
                .changed
                .wait_timeout_while(guard, timeout, |signalled| !*signalled)
                .unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *guard)
        }
    }
}

// ---- the ring ----------------------------------------------------------------------------------------------------

/// The shared ring as the app holds it: the host end, and what the supervisor needs to watch the helper.
///
/// The host end ([`HostRing`]) is single-producer and takes `&mut self`, so it lives behind a lock that the audio thread
/// only ever *tries* ([`MappedRing::with_host`]): it never waits for it. Nothing can take the `HostRing` out, so it cannot
/// outlive the mapping it points into.
pub struct MappedRing {
    host: Mutex<HostRing>,
    control: HostControl,
    sample_rate: u32,
    /// Blocks the host has published, copied here after each [`with_host`](Self::with_host) so the supervisor can ask
    /// "is the helper owing me blocks" without touching the producer.
    published: AtomicU64,
    // Dropped last: the host end and the control point into this memory.
    owner: Owner,
}

enum Owner {
    /// A ring in ordinary memory, for tests and the in-process fake helper.
    Heap(OwnedRing),
    /// A page-file backed mapping shared with a helper.
    #[cfg(windows)]
    Shared(shared::Mapping),
}

impl MappedRing {
    /// A ring on the heap, with the same layout as the mapping.
    pub fn from_owned(ring: OwnedRing) -> MappedRing {
        let host = ring.host();
        MappedRing::wrap(host, Owner::Heap(ring))
    }

    fn wrap(host: HostRing, owner: Owner) -> MappedRing {
        MappedRing {
            control: host.control(),
            sample_rate: host.sample_rate(),
            host: Mutex::new(host),
            published: AtomicU64::new(0),
            owner,
        }
    }

    /// Creates a zeroed mapping and initializes the ring in it. The helper maps the same memory once it has a duplicate of
    /// [`mapping_handle`](Self::mapping_handle).
    #[cfg(windows)]
    pub(crate) fn create_shared(sample_rate: u32) -> Result<MappedRing, String> {
        let mapping = shared::Mapping::create()?;
        // SAFETY: a fresh, zeroed, unshared mapping of `RING_BYTES` bytes that the `Mapping` keeps for as long as the
        // ring (it is the last field), and the only `HostRing` on it.
        let host = unsafe {
            HostRing::initialize(
                mapping.base(),
                tabplayer_plugin_protocol::ring::RING_BYTES,
                sample_rate,
            )
        }
        .map_err(|error| error.to_string())?;
        Ok(MappedRing::wrap(host, Owner::Shared(mapping)))
    }

    #[cfg(windows)]
    pub(crate) fn mapping_handle(&self) -> Option<windows_sys::Win32::Foundation::HANDLE> {
        match &self.owner {
            Owner::Shared(mapping) => Some(mapping.handle()),
            Owner::Heap(_) => None,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// The supervisor's and the control thread's end: the heartbeat, and the flush epoch.
    pub fn control(&self) -> HostControl {
        self.control.clone()
    }

    /// Runs `f` on the host end, or returns none when another thread is using it. It never waits, so the audio thread can
    /// call it; the lock is held only for the closure.
    pub fn with_host<R>(&self, f: impl FnOnce(&mut HostRing) -> R) -> Option<R> {
        let mut host = match self.host.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return None,
        };
        let result = f(&mut host);
        self.published.store(host.next_input(), Ordering::Relaxed);
        Some(result)
    }

    /// The helper's heartbeat: the helper's word, meaningful only as "has it moved".
    pub fn heartbeat(&self) -> u64 {
        self.control.heartbeat()
    }

    /// Whether the host has published blocks the helper has not answered. The helper wrote its half of the answer, so a
    /// helper can lie about it; the supervisor uses this to decide whether a silent heartbeat matters, and a helper that
    /// hides a hang this way still produces no audio.
    pub fn blocks_pending(&self) -> bool {
        let published = self.published.load(Ordering::Relaxed);
        self.header().output_write.load(Ordering::Acquire) < published
    }

    fn header(&self) -> &RingHeader {
        let base: *const u8 = match &self.owner {
            Owner::Heap(ring) => ring.as_ptr(),
            #[cfg(windows)]
            Owner::Shared(mapping) => mapping.base(),
        };
        // SAFETY: both owners hold a valid ring (64-byte aligned, `RING_BYTES` long, header first) for as long as `self`.
        unsafe { &*base.cast::<RingHeader>() }
    }
}

// SAFETY: the pointers inside are to memory `owner` keeps alive, and all shared access goes through atomic cells or the
// mutex.
unsafe impl Send for MappedRing {}
unsafe impl Sync for MappedRing {}

#[cfg(windows)]
mod shared {
    use tabplayer_plugin_protocol::ring::RING_BYTES;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, FILE_MAP_READ, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS,
        MapViewOfFile, PAGE_READWRITE, UnmapViewOfFile,
    };

    /// An unnamed page-file mapping and this process's view of it. Nothing can open it by name: the helper gets a
    /// duplicate of the handle.
    pub struct Mapping {
        handle: usize,
        base: usize,
    }

    impl Mapping {
        pub fn create() -> Result<Mapping, String> {
            // SAFETY: plain calls. The mapping is backed by the page file, so it starts zeroed.
            unsafe {
                let handle = CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    std::ptr::null(),
                    PAGE_READWRITE,
                    0,
                    RING_BYTES as u32,
                    std::ptr::null(),
                );
                if handle.is_null() {
                    return Err(format!(
                        "could not create the audio ring: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let view = MapViewOfFile(handle, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, RING_BYTES);
                if view.Value.is_null() {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(handle);
                    return Err(format!("could not map the audio ring: {error}"));
                }
                Ok(Mapping {
                    handle: handle as usize,
                    base: view.Value as usize,
                })
            }
        }

        pub fn base(&self) -> *mut u8 {
            self.base as *mut u8
        }

        pub fn handle(&self) -> HANDLE {
            self.handle as HANDLE
        }
    }

    impl Drop for Mapping {
        fn drop(&mut self) {
            // SAFETY: the view and the handle `create` made, released once.
            unsafe {
                UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                    Value: self.base as *mut _,
                });
                CloseHandle(self.handle as HANDLE);
            }
        }
    }
}

// ---- the link ----------------------------------------------------------------------------------------------------

/// The audio thread's connection to one helper: the ring, and the event that wakes the helper after each block. Cloning
/// shares both. It is `Send + Sync`.
#[derive(Clone)]
pub struct BridgeLink {
    ring: Arc<MappedRing>,
    input_event: Arc<EventHandle>,
}

impl BridgeLink {
    pub(crate) fn new(ring: Arc<MappedRing>, input_event: Arc<EventHandle>) -> BridgeLink {
        BridgeLink { ring, input_event }
    }

    /// A link over a heap ring, with its own wake-up event, so the audio tests can run a fake helper thread without a
    /// process. Take the helper end (`ring.helper()`) before calling this, and wait for blocks on [`input_event`].
    ///
    /// [`input_event`]: Self::input_event
    pub fn in_process(ring: OwnedRing) -> BridgeLink {
        BridgeLink {
            ring: Arc::new(MappedRing::from_owned(ring)),
            input_event: Arc::new(EventHandle::new().expect("an event for the in-process link")),
        }
    }

    pub fn ring(&self) -> &Arc<MappedRing> {
        &self.ring
    }

    pub fn input_event(&self) -> &Arc<EventHandle> {
        &self.input_event
    }

    pub fn sample_rate(&self) -> u32 {
        self.ring.sample_rate()
    }

    /// See [`MappedRing::with_host`].
    pub fn with_host<R>(&self, f: impl FnOnce(&mut HostRing) -> R) -> Option<R> {
        self.ring.with_host(f)
    }

    /// Wakes the helper after a block has been published.
    pub fn signal_input(&self) {
        self.input_event.signal();
    }

    pub fn control(&self) -> HostControl {
        self.ring.control()
    }

    /// Whether `self` and `other` are the same connection.
    pub fn same_link(&self, other: &BridgeLink) -> bool {
        Arc::ptr_eq(&self.ring, &other.ring)
    }
}

// ---- audio thread to supervisor -----------------------------------------------------------------------------------

/// `InsertShared::fault` values. They are the numbers of Task 11's `FaultReason`.
pub mod fault {
    pub const NONE: u8 = 0;
    /// The helper did not return a block in time.
    pub const UNDERRUN: u8 = 1;
    /// The helper returned a NaN or an infinity (or a runaway value).
    pub const NON_FINITE: u8 = 2;
    /// The helper is gone. The supervisor writes this one, never the audio thread.
    pub const DISCONNECTED: u8 = 3;
}

/// What the audio thread and the supervisor tell each other about one insert, without a lock.
#[derive(Default)]
pub struct InsertShared {
    /// Written by the audio thread when the insert faults (one of the [`fault`] codes); the supervisor reads it and turns
    /// it into a status.
    pub fault: AtomicU8,
    /// The largest callback, in frames, the audio thread has seen, for sizing the pipeline. Preflight ruling P32 keeps
    /// the device-level maximum in the audio service; this is the insert's copy, written by the audio thread.
    pub max_callback_frames: AtomicU32,
    /// Set by the supervisor once the helper is gone (exited, hung or killed), so the insert faults as disconnected at the
    /// next block (preflight ruling P32).
    pub disconnected: AtomicBool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tabplayer_plugin_protocol::{
        limits::BLOCK_FRAMES,
        ring::{Block, BlockMeta},
    };

    #[test]
    fn in_process_link_carries_blocks_and_counts_pending() {
        let owned = OwnedRing::new(48_000);
        let mut helper = owned.helper();
        let link = BridgeLink::in_process(owned);
        assert_eq!(link.sample_rate(), 48_000);
        assert!(!link.ring().blocks_pending());

        let block: Block = [[0.25; 2]; BLOCK_FRAMES];
        let sent = link.with_host(|host| {
            let seq = host.next_input();
            host.send_input(seq, &block, &BlockMeta::default())
        });
        assert_eq!(sent, Some(true));
        link.signal_input();
        assert!(link.ring().blocks_pending(), "published, not yet answered");

        // The fake helper wakes, reads the block and answers it.
        assert!(link.input_event().wait(Duration::from_secs(1)));
        let mut scratch: Block = [[0.0; 2]; BLOCK_FRAMES];
        let input = helper.read_input(0, &mut scratch).block().expect("a block");
        assert_eq!(scratch[0], [0.25, 0.25]);
        assert!(helper.publish_output(0, input.epoch, &scratch, &input.meta));
        assert!(!link.ring().blocks_pending(), "answered");
    }

    #[test]
    fn host_end_is_never_waited_for() {
        let link = BridgeLink::in_process(OwnedRing::new(48_000));
        let inside = link.with_host(|_| link.with_host(|_| ()));
        assert_eq!(
            inside,
            Some(None),
            "a second user finds it taken and goes on"
        );
    }

    #[test]
    fn event_remembers_a_signal_and_resets() {
        let event = EventHandle::new().unwrap();
        assert!(!event.wait(Duration::from_millis(1)));
        event.signal();
        assert!(event.wait(Duration::from_millis(100)));
        assert!(!event.wait(Duration::from_millis(1)), "auto-reset");
    }

    #[test]
    fn link_and_ring_are_send_and_sync() {
        fn needs<T: Send + Sync>() {}
        needs::<BridgeLink>();
        needs::<MappedRing>();
        needs::<EventHandle>();
        needs::<InsertShared>();
    }
}
