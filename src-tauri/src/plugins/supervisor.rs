//! Watches the helpers: a thread that looks at every one of them every 50 ms and turns what it finds into a
//! [`PluginStatus`] (THE-71).
//!
//! For each watched helper, in this order:
//! - **A violation** (the helper broke the protocol, or reported more latency than the cap) is reported as the status it
//!   recorded.
//! - **A fatal error** (an `Error` that answered no request: the helper cannot run its plug-in and is about to exit with
//!   code 4) is `Crashed`, reported at once. The helper is left to finish its own orderly exit, which can take seconds.
//! - **An exit** the app did not ask for is `Crashed`, whatever the code. The helper's C++ and structured exceptions end it
//!   with the system's exception code, not the Rust panic code, so every nonzero exit counts, and so does a zero one the
//!   app did not ask for. Only `kill`, `shutdown` and dropping the process count as asked.
//! - **A stale heartbeat** while blocks are pending, for [`HANG_TIMEOUT`] (500 ms), is `Hung`: the helper is killed first
//!   and the report follows. The clock starts when blocks are pending and the heartbeat has not moved, so an idle helper
//!   is never hung, and a helper that stopped beating while idle gets the full 500 ms from its next block. The clock is the
//!   monotonic `Instant`. If the supervisor's own tick came more than 250 ms late (a stall of this thread, or of the
//!   machine), the helper's clock is moved forward by the length of the stall instead: a stall is excused, since the
//!   helper may have been stalled too and the kill cannot be undone, but the time before and after it still counts, so
//!   recurring stalls cannot hide a hang for ever.
//! - **The audio thread's fault code** in [`InsertShared`] is `Underrun` or `NonFinite`. A fault is reported again only
//!   when the code changes.
//!
//! A terminal report (`Crashed`, `Hung` or a violation) ends the watch, and sets [`InsertShared::disconnected`] so the
//! insert falls back to the built-in sound at its next block. A helper the app killed or shut down is dropped from the
//! watch silently.
//!
//! The report callback runs on the supervisor's thread with no lock held, so it may call `unwatch`. **It must return
//! quickly** (send to a channel, say): while it runs no helper is watched, and the time it takes is excused from every
//! hang clock. A panic in it is caught and does not end the supervisor. Helpers that leave the watch are dropped after the lock is released, since
//! dropping one waits a moment for the process.
use super::{
    bridge::{InsertShared, fault},
    helper::HelperProcess,
    status::PluginStatus,
};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, atomic::Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::limits::{HANG_TIMEOUT, SUPERVISOR_TICK};

/// A tick this much later than its predecessor says the supervisor itself was stalled.
const STALL_GAP: Duration = Duration::from_millis(250);

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
    /// `stall` is how late this tick is beyond its due time, zero when it is not late enough to count.
    fn check(&mut self, now: Instant, stall: Duration) -> Verdict {
        if let Some(status) = self.helper.violation() {
            return self.end(status);
        }
        if self.helper.fatal_error().is_some() {
            return self.end(PluginStatus::Crashed);
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
        } else {
            // Excuse the stall, but never move the start of the wait into the future.
            self.still_since = (self.still_since + stall).min(now);
            if now.duration_since(self.still_since) >= HANG_TIMEOUT {
                self.helper.kill();
                return self.end(PluginStatus::Hung);
            }
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
    /// One look at every helper. `gap` is the time since the previous tick began.
    fn tick(&self, gap: Duration) {
        let now = Instant::now();
        // The ticks are due `SUPERVISOR_TICK` apart; a gap beyond `STALL_GAP` is a stall, and what exceeds the tick is excused.
        let stall = if gap > STALL_GAP {
            gap - SUPERVISOR_TICK
        } else {
            Duration::ZERO
        };
        let mut reports = Vec::new();
        let mut left = Vec::new();
        {
            let mut entries = lock(&self.entries);
            for mut entry in std::mem::take(&mut *entries) {
                match entry.check(now, stall) {
                    Verdict::Keep => entries.push(entry),
                    Verdict::Fault(status) => {
                        reports.push((entry.key.clone(), status));
                        entries.push(entry);
                    }
                    Verdict::End(status) => {
                        reports.push((entry.key.clone(), status));
                        left.push(entry);
                    }
                    Verdict::Drop => left.push(entry),
                }
            }
        }
        for (key, status) in reports {
            // A callback that panics must not end the supervision of every other helper.
            let _ = catch_unwind(AssertUnwindSafe(|| (self.report)(key, status)));
        }
        drop(left);
    }

    fn run(&self) {
        let mut stopped = lock(&self.stopped);
        let mut last = Instant::now();
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
            let began = Instant::now();
            self.tick(began.duration_since(last));
            last = began;
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
        let replaced = {
            let mut entries = lock(&self.inner.entries);
            let (replaced, mut kept): (Vec<_>, Vec<_>) = std::mem::take(&mut *entries)
                .into_iter()
                .partition(|existing| existing.key == entry.key);
            kept.push(entry);
            *entries = kept;
            replaced
        };
        drop(replaced);
    }

    /// Stops watching. True when the key was watched.
    pub fn unwatch(&self, key: &HelperKey) -> bool {
        let removed = {
            let mut entries = lock(&self.inner.entries);
            let (removed, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut *entries)
                .into_iter()
                .partition(|entry| &entry.key == key);
            *entries = kept;
            removed
        };
        !removed.is_empty()
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
