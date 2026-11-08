//! Watches the helpers: a thread that looks at every one of them every 50 ms and turns what it finds into a
//! [`PluginStatus`] (THE-71).
//!
//! For each watched helper, in this order:
//! - **A violation** (the helper broke the protocol, or reported more latency than the cap) is reported as the status it
//!   recorded.
//! - **An exit** the app did not ask for is `Crashed`, whatever the code. The helper's C++ and structured exceptions end it
//!   with the system's exception code, not the Rust panic code, so every nonzero exit counts, and so does a zero one the
//!   app did not ask for.
//! - **A stale heartbeat** while blocks are pending, for [`HANG_TIMEOUT`] (500 ms), is `Hung`: the helper is killed first
//!   and the report follows. The clock starts when blocks are pending and the heartbeat has not moved, so an idle helper
//!   is never hung, and a helper that stopped beating while idle gets the full 500 ms from its next block.
//! - **The audio thread's fault code** in [`InsertShared`] is `Underrun` or `NonFinite`. A fault is reported again only
//!   when the code changes.
//!
//! A terminal report (`Crashed`, `Hung` or a violation) ends the watch, and sets [`InsertShared::disconnected`] so the
//! insert falls back to the built-in sound at its next block. A helper the app killed or shut down is dropped from the
//! watch silently.
//!
//! The report callback runs on the supervisor's thread with no lock held, so it may call `unwatch`.
use super::{
    bridge::{InsertShared, fault},
    helper::HelperProcess,
    status::PluginStatus,
};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, atomic::Ordering};
use std::thread::JoinHandle;
use std::time::Instant;
use tabplayer_plugin_protocol::limits::{HANG_TIMEOUT, SUPERVISOR_TICK};

/// Which helper a report is about: one helper per document, track and plug-in class.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HelperKey {
    pub document_id: String,
    pub track_id: String,
    pub class_id: String,
}

type Report = Box<dyn Fn(HelperKey, PluginStatus) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Entry {
    key: HelperKey,
    helper: Arc<HelperProcess>,
    shared: Arc<InsertShared>,
    beat: u64,
    /// When the heartbeat last moved, or blocks were last not pending.
    still_since: Instant,
    reported_fault: u8,
}

enum Verdict {
    Keep,
    /// A status, and the watch goes on (an audio fault).
    Fault(PluginStatus),
    /// A status, and the watch ends.
    End(PluginStatus),
    /// The watch ends without a report.
    Drop,
}

impl Entry {
    fn check(&mut self, now: Instant) -> Verdict {
        if let Some(status) = self.helper.violation() {
            return self.end(status);
        }
        if self.helper.exited().is_some() {
            return if self.helper.was_killed() {
                self.disconnect();
                Verdict::Drop
            } else {
                self.end(PluginStatus::Crashed)
            };
        }
        if self.helper.was_killed() {
            self.disconnect();
            return Verdict::Drop;
        }
        let beat = self.helper.heartbeat();
        if beat != self.beat || !self.helper.blocks_pending() {
            self.beat = beat;
            self.still_since = now;
        } else if now.duration_since(self.still_since) >= HANG_TIMEOUT {
            self.helper.kill();
            return self.end(PluginStatus::Hung);
        }
        let code = self.shared.fault.load(Ordering::Acquire);
        if code == fault::NONE {
            self.reported_fault = fault::NONE;
        } else if code != self.reported_fault {
            self.reported_fault = code;
            match code {
                fault::UNDERRUN => return Verdict::Fault(PluginStatus::Underrun),
                fault::NON_FINITE => return Verdict::Fault(PluginStatus::NonFinite),
                _ => {}
            }
        }
        Verdict::Keep
    }

    fn disconnect(&self) {
        self.shared.disconnected.store(true, Ordering::Release);
    }

    fn end(&self, status: PluginStatus) -> Verdict {
        self.disconnect();
        Verdict::End(status)
    }
}

struct Inner {
    entries: Mutex<Vec<Entry>>,
    stopped: Mutex<bool>,
    wake: Condvar,
    report: Report,
}

impl Inner {
    fn tick(&self) {
        let now = Instant::now();
        let mut reports = Vec::new();
        lock(&self.entries).retain_mut(|entry| match entry.check(now) {
            Verdict::Keep => true,
            Verdict::Fault(status) => {
                reports.push((entry.key.clone(), status));
                true
            }
            Verdict::End(status) => {
                reports.push((entry.key.clone(), status));
                false
            }
            Verdict::Drop => false,
        });
        for (key, status) in reports {
            (self.report)(key, status);
        }
    }

    fn run(&self) {
        let mut stopped = lock(&self.stopped);
        while !*stopped {
            let (guard, _) = self
                .wake
                .wait_timeout(stopped, SUPERVISOR_TICK)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            stopped = guard;
            if *stopped {
                break;
            }
            drop(stopped);
            self.tick();
            stopped = lock(&self.stopped);
        }
    }
}

/// The supervisor thread. Dropping it stops the thread; the helpers it watched are left as they are.
pub struct Supervisor {
    inner: Arc<Inner>,
    thread: Option<JoinHandle<()>>,
}

impl Supervisor {
    /// Starts the thread. `report` is told about every status change of a watched helper.
    pub fn new(report: impl Fn(HelperKey, PluginStatus) + Send + Sync + 'static) -> Supervisor {
        let inner = Arc::new(Inner {
            entries: Mutex::new(Vec::new()),
            stopped: Mutex::new(false),
            wake: Condvar::new(),
            report: Box::new(report),
        });
        let running = inner.clone();
        let thread = std::thread::Builder::new()
            .name("plugin-supervisor".into())
            .spawn(move || running.run())
            .expect("the supervisor thread");
        Supervisor {
            inner,
            thread: Some(thread),
        }
    }

    /// Starts watching `helper`, replacing any watch under the same key. `shared` is the insert's word with the audio
    /// thread. Unwatch before the helper is replaced.
    pub fn watch(&self, key: HelperKey, helper: Arc<HelperProcess>, shared: Arc<InsertShared>) {
        let entry = Entry {
            beat: helper.heartbeat(),
            still_since: Instant::now(),
            reported_fault: fault::NONE,
            key,
            helper,
            shared,
        };
        let mut entries = lock(&self.inner.entries);
        entries.retain(|existing| existing.key != entry.key);
        entries.push(entry);
    }

    /// Stops watching. True when the key was watched.
    pub fn unwatch(&self, key: &HelperKey) -> bool {
        let mut entries = lock(&self.inner.entries);
        let before = entries.len();
        entries.retain(|entry| &entry.key != key);
        entries.len() != before
    }

    pub fn watched(&self) -> usize {
        lock(&self.inner.entries).len()
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        *lock(&self.inner.stopped) = true;
        self.inner.wake.notify_all();
        if let Some(thread) = self.thread.take() {
            // A report callback that drops the supervisor from its own thread must not join itself.
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}
