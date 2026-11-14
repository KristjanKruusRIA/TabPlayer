//! Fretlight guitar LEDs over wired USB HID (THE-77, tracker row U19). Experimental and untested on hardware: nobody on
//! this project has owned a Fretlight, and the byte layout comes from one community write-up (see
//! `docs/validation/2026-11-14-gp8-fretlight.md`).
//!
//! The page sends the set of LEDs to light as a fixed-size frame. This module encodes it to the three 7-byte packets of
//! the documented wired protocol and writes them from one worker thread that owns the device. Nothing is enumerated or
//! opened until the user presses Connect; nothing here runs on, or shares a lock with, the audio callback.

/// Strings on the device, numbered 1 to 6 with 1 the high E.
pub const STRINGS: usize = 6;
/// Frets on the device, 0 to 21.
pub const FRETS: usize = 22;
/// LEDs on the device, and the length of a frame.
pub const LEDS: usize = STRINGS * FRETS;
/// A packet is six bytes of LED bits and a packet number.
pub const PACKET_LEN: usize = 7;
/// The frets one packet covers (the last covers six).
const FRETS_PER_PACKET: usize = 8;
const PACKETS: usize = 3;

/// Which LEDs are lit. The index of an LED is `(string - 1) * FRETS + fret`, with string 1 the high E.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    leds: [bool; LEDS],
}
impl Frame {
    pub const OFF: Frame = Frame {
        leds: [false; LEDS],
    };
    pub fn from_leds(leds: [bool; LEDS]) -> Self {
        Self { leds }
    }
    pub fn lit(&self, string: usize, fret: usize) -> bool {
        self.leds[(string - 1) * FRETS + fret]
    }
    pub fn with(mut self, string: usize, fret: usize) -> Self {
        self.leds[(string - 1) * FRETS + fret] = true;
        self
    }
    pub fn is_off(&self) -> bool {
        self.leds.iter().all(|led| !led)
    }
}

/// The three packets that set every LED. Packet `p` (1 to 3) covers frets `8 * (p - 1)` to `8 * (p - 1) + 7` (frets 16
/// to 21 in the third). Within a packet the LED of `(string, fret)` is number `k = (fret - first) * 6 + (string - 1)`,
/// which is bit `7 - (k mod 8)` of byte `5 - k / 8`; byte 6 is the packet number.
pub fn encode(frame: &Frame) -> [[u8; PACKET_LEN]; PACKETS] {
    let mut packets = [[0u8; PACKET_LEN]; PACKETS];
    for (index, packet) in packets.iter_mut().enumerate() {
        packet[PACKET_LEN - 1] = index as u8 + 1;
    }
    for string in 1..=STRINGS {
        for fret in 0..FRETS {
            if frame.lit(string, fret) {
                let k = (fret % FRETS_PER_PACKET) * STRINGS + (string - 1);
                packets[fret / FRETS_PER_PACKET][5 - k / 8] |= 1 << (7 - k % 8);
            }
        }
    }
    packets
}
// ---------------------------------------------------------------------------------------------------------------------
// The device service
// ---------------------------------------------------------------------------------------------------------------------
use serde::{Deserialize, Deserializer, Serialize, de};
use std::{
    ffi::CString,
    fmt,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

/// USB vendor and product id of the wired Fretlight guitars, as documented. The vendor id is assigned to another company
/// and may be shared, so a device is matched by its product name as well.
pub const VENDOR_ID: u16 = 0x0925;
pub const PRODUCT_ID: u16 = 0x2000;
/// The product name must contain this, in any case. The name a real guitar reports was not documented, so this is a guess.
const PRODUCT_NAME_PART: &str = "fretlight";
/// At most this many frames reach the device each second, whatever the page sends. A frame is three 8-byte writes.
pub const FRAMES_PER_SECOND: u64 = 25;
const MIN_INTERVAL: Duration = Duration::from_millis(1000 / FRAMES_PER_SECOND);
/// How long Connect waits for the listing and the open together.
const OPEN_TIMEOUT: Duration = Duration::from_secs(3);
/// How long Disconnect and exit wait for the all-off frame to be written.
const CLOSE_TIMEOUT: Duration = Duration::from_millis(1500);
/// How often an idle worker looks at its stop flag.
const WORKER_WAKE: Duration = Duration::from_millis(250);
const MESSAGE_MAX: usize = 300;
#[cfg(any(test, feature = "desktop-test"))]
const TEST_LOG_MAX: usize = 4096;

/// What a frame looks like on the wire: exactly `LEDS` booleans, index `(string - 1) * 22 + fret`. Decoding rejects any other
/// length or kind of element and stops reading after one element too many. Tauri has already parsed the request body by
/// then, so this bounds what is kept and written, not what the page may send.
impl<'de> Deserialize<'de> for Frame {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FrameVisitor;
        impl<'de> de::Visitor<'de> for FrameVisitor {
            type Value = Frame;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "exactly {LEDS} booleans")
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Frame, A::Error> {
                let mut leds = [false; LEDS];
                for (index, led) in leds.iter_mut().enumerate() {
                    *led = seq
                        .next_element::<bool>()?
                        .ok_or_else(|| de::Error::invalid_length(index, &self))?;
                }
                if seq.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::invalid_length(LEDS + 1, &self));
                }
                Ok(Frame { leds })
            }
        }
        deserializer.deserialize_seq(FrameVisitor)
    }
}

/// A HID device as the listing describes it.
#[derive(Clone, Debug)]
pub struct HidInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub product: Option<String>,
    pub path: CString,
}
impl HidInfo {
    #[cfg(any(test, feature = "desktop-test"))]
    pub fn new(vendor_id: u16, product_id: u16, product: Option<&str>) -> Self {
        Self {
            vendor_id,
            product_id,
            product: product.map(str::to_owned),
            path: CString::new("fake").expect("no NUL"),
        }
    }
    /// A Fretlight: the documented ids and a product name that says so.
    pub fn is_fretlight(&self) -> bool {
        self.vendor_id == VENDOR_ID
            && self.product_id == PRODUCT_ID
            && self
                .product
                .as_ref()
                .is_some_and(|name| name.to_lowercase().contains(PRODUCT_NAME_PART))
    }
}
/// An open device. Dropping it closes it.
pub trait LedDevice: Send {
    /// Writes one HID output report: the report id (0) and the 7-byte packet.
    fn write(&mut self, report: &[u8]) -> Result<(), String>;
}
pub trait HidBackend: Send + Sync + 'static {
    /// Lists the HID devices with the documented ids. Called only when the player presses Connect.
    fn list(&self) -> Result<Vec<HidInfo>, String>;
    fn open(&self, info: &HidInfo) -> Result<Box<dyn LedDevice>, String>;
    /// Lets go of anything kept for listing, as the app exits.
    fn release(&self) {}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceState {
    Disconnected,
    Connecting,
    Connected,
    Lost,
    Error,
}
/// The `fretlight-status` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    /// Rises with every notice, across sessions, so the page can drop one that arrives after a newer one.
    pub seq: u64,
    pub session: u64,
    pub state: DeviceState,
    pub device: String,
    pub message: String,
    /// Frames written this session.
    pub sent: u64,
    /// Frames replaced by a newer one before they were written.
    pub coalesced: u64,
}
/// What `fretlight_status` returns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FretlightStatus {
    pub session: u64,
    pub state: DeviceState,
    pub device: String,
    pub message: String,
    pub sent: u64,
    pub coalesced: u64,
}
pub type EventSink = Arc<dyn Fn(StatusEvent) + Send + Sync>;

/// What the page and the worker share for one session. The mailbox holds the newest frame only, so there is never a queue.
struct Live {
    stop: AtomicBool,
    mailbox: Mutex<Option<Frame>>,
    wake: Condvar,
    sent: AtomicU64,
    coalesced: AtomicU64,
    /// Raised when the worker thread has ended, however it ended.
    ended: AtomicBool,
}
impl Live {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            mailbox: Mutex::new(None),
            wake: Condvar::new(),
            sent: AtomicU64::new(0),
            coalesced: AtomicU64::new(0),
            ended: AtomicBool::new(false),
        }
    }
    /// Asks the worker to write the all-off frame and end. The mailbox is locked while the flag is raised, so a worker
    /// about to wait cannot miss it.
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        drop(lock(&self.mailbox));
        self.wake.notify_all();
    }
}
struct Active {
    session: u64,
    device: String,
    live: Arc<Live>,
    /// Answered by the worker once it has written the all-off frame (or given up).
    done: Mutex<mpsc::Receiver<()>>,
    emit: EventSink,
}
struct Snapshot {
    session: u64,
    state: DeviceState,
    device: String,
    message: String,
    sent: u64,
    coalesced: u64,
}
impl Snapshot {
    fn idle(session: u64, state: DeviceState, device: &str, message: String) -> Self {
        Self {
            session,
            state,
            device: device.into(),
            message,
            sent: 0,
            coalesced: 0,
        }
    }
}
struct Inner {
    backend: Arc<dyn HidBackend>,
    /// The latest session. A disconnect with no session number bumps it, which cancels a connect still opening.
    counter: AtomicU64,
    active: Mutex<Option<Active>>,
    last: Mutex<Snapshot>,
    open_timeout: Duration,
    min_interval: Duration,
    close_timeout: Duration,
    /// Workers that did not end within the close timeout: their write has not come back.
    stuck: Mutex<Vec<Arc<Live>>>,
    /// An open handed to the driver that has not come back.
    pending_open: AtomicBool,
    notices: Mutex<u64>,
    #[cfg(any(test, feature = "desktop-test"))]
    test: Option<Arc<FakeBackend>>,
}

/// The managed Fretlight state. Cloning shares it.
#[derive(Clone)]
pub struct FretlightState {
    inner: Arc<Inner>,
}
impl Default for FretlightState {
    /// The real backend, which touches nothing until Connect. The desktop test build run with `TABPLAYER_FRETLIGHT_TEST=1`
    /// uses a fake guitar instead and keeps what it was sent.
    fn default() -> Self {
        #[cfg(any(test, feature = "desktop-test"))]
        if std::env::var("TABPLAYER_FRETLIGHT_TEST").is_ok_and(|v| v == "1") {
            let fake = Arc::new(FakeBackend::new(vec![HidInfo::new(
                VENDOR_ID,
                PRODUCT_ID,
                Some("Fretlight (test)"),
            )]));
            return Self::build(fake.clone(), Some(fake));
        }
        Self::build(
            Arc::new(HidApiBackend::default()),
            #[cfg(any(test, feature = "desktop-test"))]
            None,
        )
    }
}
impl FretlightState {
    pub fn new(backend: Arc<dyn HidBackend>) -> Self {
        Self::build(
            backend,
            #[cfg(any(test, feature = "desktop-test"))]
            None,
        )
    }
    fn build(
        backend: Arc<dyn HidBackend>,
        #[cfg(any(test, feature = "desktop-test"))] test: Option<Arc<FakeBackend>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                backend,
                counter: AtomicU64::new(0),
                active: Mutex::new(None),
                last: Mutex::new(Snapshot::idle(
                    0,
                    DeviceState::Disconnected,
                    "",
                    String::new(),
                )),
                open_timeout: OPEN_TIMEOUT,
                min_interval: MIN_INTERVAL,
                close_timeout: CLOSE_TIMEOUT,
                stuck: Mutex::new(Vec::new()),
                pending_open: AtomicBool::new(false),
                notices: Mutex::new(0),
                #[cfg(any(test, feature = "desktop-test"))]
                test,
            }),
        }
    }
    /// Shorter timings for tests. Call before the state is cloned.
    pub fn with_timings(mut self, open_timeout: Duration, min_interval: Duration) -> Self {
        let inner =
            Arc::get_mut(&mut self.inner).expect("timings are set before the state is shared");
        inner.open_timeout = open_timeout;
        inner.min_interval = min_interval;
        self
    }

    /// A shorter wait for the all-off frame, for tests. Call before the state is cloned.
    pub fn with_close_timeout(mut self, close_timeout: Duration) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("set before the state is shared");
        inner.close_timeout = close_timeout;
        self
    }

    /// Lists the USB devices, opens the Fretlight and starts the worker. The only call that lists or opens anything.
    /// Returns the session number, which every notice carries and which a later `send_frame` or `disconnect` must name.
    /// Connecting while connected ends that session first. Blocks for at most the open timeout, so call it from a
    /// blocking thread. A failure is a message that starts with a code the page can translate.
    pub fn connect(&self, emit: EventSink) -> Result<u64, String> {
        let inner = &self.inner;
        if inner.pending_open.load(Ordering::SeqCst) {
            return Err(OPEN_PENDING.into());
        }
        {
            // A worker whose write has not come back still owns the old handle; do not start a second beside it.
            let mut stuck = lock(&inner.stuck);
            stuck.retain(|live| !live.ended.load(Ordering::SeqCst));
            if !stuck.is_empty() {
                return Err(WORKER_STUCK.into());
            }
        }
        let (session, replaced) = {
            let mut slot = lock(&inner.active);
            let session = inner.counter.fetch_add(1, Ordering::SeqCst) + 1;
            (session, slot.take())
        };
        if let Some(old) = replaced {
            self.end(old, DeviceState::Disconnected, String::new());
        }
        self.record(
            Snapshot::idle(session, DeviceState::Connecting, "", String::new()),
            &emit,
        );
        let (device, name) = match self.open_within_timeout() {
            Ok(opened) => opened,
            Err(message) => {
                if inner.counter.load(Ordering::SeqCst) == session {
                    self.record(
                        Snapshot::idle(session, DeviceState::Error, "", message.clone()),
                        &emit,
                    );
                }
                return Err(message);
            }
        };
        let live = Arc::new(Live::new());
        let (done_tx, done_rx) = mpsc::channel();
        let spawned = {
            let (state, live, name) = (self.clone(), live.clone(), name.clone());
            thread::Builder::new()
                .name("fretlight-worker".into())
                .spawn(move || run_worker(state, session, device, live, done_tx, name))
        };
        if let Err(error) = spawned {
            let message = format!("open_failed: The Fretlight could not be started: {error}");
            self.record(
                Snapshot::idle(session, DeviceState::Error, &name, message.clone()),
                &emit,
            );
            return Err(message);
        }
        {
            let mut slot = lock(&inner.active);
            if inner.counter.load(Ordering::SeqCst) != session {
                drop(slot);
                live.stop();
                return Err(
                    "cancelled: The connection was cancelled before the Fretlight opened.".into(),
                );
            }
            *slot = Some(Active {
                session,
                device: name.clone(),
                live,
                done: Mutex::new(done_rx),
                emit: emit.clone(),
            });
        }
        self.record(
            Snapshot::idle(session, DeviceState::Connected, &name, String::new()),
            &emit,
        );
        Ok(session)
    }

    /// Hands the newest frame to the worker, which writes it as soon as the rate limit allows. A frame still waiting is
    /// replaced. A session that is not the running one is refused.
    pub fn send_frame(&self, session: u64, frame: Frame) -> Result<(), String> {
        let slot = lock(&self.inner.active);
        let active = slot
            .as_ref()
            .filter(|active| active.session == session)
            .ok_or("not_connected: The Fretlight is not connected.")?;
        let mut mailbox = lock(&active.live.mailbox);
        if mailbox.replace(frame).is_some() {
            active.live.coalesced.fetch_add(1, Ordering::Relaxed);
        }
        drop(mailbox);
        active.live.wake.notify_one();
        Ok(())
    }

    /// Ends the session `session`, or whatever is running (and any connect still opening) when it is `None`. The all-off
    /// frame is written first, for at most the close timeout. A number that is not the running session's changes nothing.
    pub fn disconnect(&self, session: Option<u64>) {
        let taken = {
            let mut slot = lock(&self.inner.active);
            match session {
                Some(wanted) => match slot.as_ref() {
                    Some(active) if active.session == wanted => slot.take(),
                    _ => None,
                },
                None => {
                    self.inner.counter.fetch_add(1, Ordering::SeqCst);
                    slot.take()
                }
            }
        };
        if let Some(active) = taken {
            self.end(active, DeviceState::Disconnected, String::new());
        }
    }
    /// Turns the LEDs off and lets go of the USB stack when the app exits.
    pub fn shutdown(&self) {
        self.disconnect(None);
        self.inner.backend.release();
    }

    pub fn status(&self) -> FretlightStatus {
        let slot = lock(&self.inner.active);
        match slot.as_ref() {
            Some(active) => FretlightStatus {
                session: active.session,
                state: DeviceState::Connected,
                device: active.device.clone(),
                message: String::new(),
                sent: active.live.sent.load(Ordering::Relaxed),
                coalesced: active.live.coalesced.load(Ordering::Relaxed),
            },
            None => {
                let last = lock(&self.inner.last);
                FretlightStatus {
                    session: last.session,
                    state: last.state,
                    device: last.device.clone(),
                    message: last.message.clone(),
                    sent: last.sent,
                    coalesced: last.coalesced,
                }
            }
        }
    }

    /// Lists and opens on its own thread so a driver that never answers delays nothing. A device that opens after the
    /// wait is over is closed again by that thread, and until then another Connect is refused.
    fn open_within_timeout(&self) -> Result<(Box<dyn LedDevice>, String), String> {
        let inner = self.inner.clone();
        if inner.pending_open.swap(true, Ordering::SeqCst) {
            return Err(OPEN_PENDING.into());
        }
        let (tx, rx) = mpsc::channel();
        let thread_inner = inner.clone();
        thread::Builder::new()
            .name("fretlight-open".into())
            .spawn(move || {
                let opened = find_and_open(&*thread_inner.backend);
                // Stops counting before the answer is sent, so an answer that arrives never meets a refusal.
                thread_inner.pending_open.store(false, Ordering::SeqCst);
                // Nobody waiting any more means the device drops here.
                let _ = tx.send(opened);
            })
            .map_err(|error| {
                inner.pending_open.store(false, Ordering::SeqCst);
                format!("open_failed: The Fretlight could not be opened: {error}")
            })?;
        match rx.recv_timeout(inner.open_timeout) {
            Ok(opened) => opened,
            Err(_) => Err("open_timeout: The system did not answer in time. Unplug the Fretlight, plug it in again and press Connect.".into()),
        }
    }

    /// Ends a session already taken out of `active`: the worker writes the all-off frame, and this waits for it for at
    /// most the close timeout.
    fn end(&self, active: Active, state: DeviceState, message: String) {
        active.live.stop();
        if let Err(mpsc::RecvTimeoutError::Timeout) =
            lock(&active.done).recv_timeout(self.inner.close_timeout)
        {
            lock(&self.inner.stuck).push(active.live.clone());
        }
        self.record(
            Snapshot {
                session: active.session,
                state,
                device: active.device.clone(),
                message,
                sent: active.live.sent.load(Ordering::Relaxed),
                coalesced: active.live.coalesced.load(Ordering::Relaxed),
            },
            &active.emit,
        );
    }
    /// A write failed. The LEDs stay as they are: nothing more is written to a device that is gone.
    fn worker_lost(&self, session: u64, error: &str) {
        let taken = {
            let mut slot = lock(&self.inner.active);
            match slot.as_ref() {
                Some(active) if active.session == session => slot.take(),
                _ => None,
            }
        };
        if let Some(active) = taken {
            active.live.stop.store(true, Ordering::Release);
            let message = format!(
                "The Fretlight stopped answering ({}). Its lights stay as they were. Press Connect to try again.",
                truncated(error)
            );
            self.record(
                Snapshot {
                    session,
                    state: DeviceState::Lost,
                    device: active.device.clone(),
                    message,
                    sent: active.live.sent.load(Ordering::Relaxed),
                    coalesced: active.live.coalesced.load(Ordering::Relaxed),
                },
                &active.emit,
            );
        }
    }
    fn record(&self, snapshot: Snapshot, emit: &EventSink) {
        let event = {
            let mut numbered = lock(&self.inner.notices);
            *numbered += 1;
            let event = StatusEvent {
                seq: *numbered,
                session: snapshot.session,
                state: snapshot.state,
                device: snapshot.device.clone(),
                message: snapshot.message.clone(),
                sent: snapshot.sent,
                coalesced: snapshot.coalesced,
            };
            *lock(&self.inner.last) = snapshot;
            event
        };
        emit(event);
    }
}
const WORKER_STUCK: &str = "worker_stuck: The Fretlight has not finished its last write. Wait a moment, or unplug it and plug it in again, then press Connect.";
const OPEN_PENDING: &str = "open_pending: The system is still opening the Fretlight. Wait a moment, then press Connect again.";

fn truncated(text: &str) -> String {
    text.chars().take(MESSAGE_MAX).collect()
}
/// A product name as it is shown and carried in an error: no control characters or separators, at most 40 characters.
fn display_name(name: Option<&str>) -> String {
    let clean: String = name
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() && *c != '|')
        .take(40)
        .collect();
    clean.trim().to_string()
}
/// The listing and the open, run on the open thread: only a device with the documented ids and a Fretlight name is opened.
/// A device with the ids and another name is never opened, but its name is reported (up to three) so a tester whose guitar
/// reports a different one can say what it is.
fn find_and_open(backend: &dyn HidBackend) -> Result<(Box<dyn LedDevice>, String), String> {
    let listed = backend.list().map_err(|error| {
        format!(
            "list_failed: The USB devices could not be listed: {}",
            truncated(&error)
        )
    })?;
    if let Some(info) = listed.iter().find(|info| info.is_fretlight()) {
        let name = info.product.clone().unwrap_or_default();
        let device = backend.open(info).map_err(|error| {
            format!(
                "open_failed: The Fretlight could not be opened: {}",
                truncated(&error)
            )
        })?;
        return Ok((device, name));
    }
    let mut rejected: Vec<String> = Vec::new();
    for info in listed
        .iter()
        .filter(|info| info.vendor_id == VENDOR_ID && info.product_id == PRODUCT_ID)
    {
        let name = display_name(info.product.as_deref());
        if rejected.len() < 3 && !rejected.contains(&name) {
            rejected.push(name);
        }
    }
    if rejected.is_empty() {
        Err(
            "not_found: No wired Fretlight guitar was found. Plug one in and press Connect again."
                .into(),
        )
    } else {
        Err(format!("name_mismatch: {}", rejected.join(" | ")))
    }
}

/// How much of the minimum interval is left after `elapsed`. Read the clock once and pass it in: two reads can straddle
/// the interval, and a plain subtraction then panics.
fn remaining(elapsed: Duration, min_interval: Duration) -> Duration {
    min_interval.saturating_sub(elapsed)
}
/// The next frame to write: the newest one, no sooner than the minimum interval after the last write, or `None` when the
/// session is ending. Frames that arrive while waiting replace the one waiting.
fn next_frame(live: &Live, last_write: Option<Instant>, min_interval: Duration) -> Option<Frame> {
    let mut slot = lock(&live.mailbox);
    loop {
        if live.stop.load(Ordering::Acquire) {
            return None;
        }
        let wait = if slot.is_some() {
            let left =
                last_write.map_or(Duration::ZERO, |at| remaining(at.elapsed(), min_interval));
            if left.is_zero() {
                return slot.take();
            }
            left
        } else {
            WORKER_WAKE
        };
        slot = live
            .wake
            .wait_timeout(slot, wait)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
    }
}
/// Writes the three reports of a frame: report id 0, then the 7-byte packet.
fn write_frame(device: &mut dyn LedDevice, frame: &Frame) -> Result<(), String> {
    for packet in encode(frame) {
        let mut report = [0u8; PACKET_LEN + 1];
        report[1..].copy_from_slice(&packet);
        device.write(&report)?;
    }
    Ok(())
}
/// Reports the end of a worker, however it came about. A worker that ends without having been asked to (a panic in a
/// driver, say) leaves the session lost, so the page is told and no frame is accepted into a mailbox nobody reads.
struct WorkerEnd {
    state: FretlightState,
    session: u64,
    live: Arc<Live>,
    done: mpsc::Sender<()>,
}
impl Drop for WorkerEnd {
    fn drop(&mut self) {
        self.live.ended.store(true, Ordering::SeqCst);
        if !self.live.stop.load(Ordering::Acquire) {
            self.state
                .worker_lost(self.session, "the device thread ended unexpectedly");
        }
        let _ = self.done.send(());
    }
}
/// The session's worker. It owns the device, so nothing else writes to it. It writes the newest frame at the rate limit,
/// and on a stop request writes the all-off frame and ends. A failed write ends the session as lost without writing again.
/// A worker that was told to stop but is replaced by a newer session meanwhile leaves the newer lights alone.
fn run_worker(
    state: FretlightState,
    session: u64,
    mut device: Box<dyn LedDevice>,
    live: Arc<Live>,
    done: mpsc::Sender<()>,
    _name: String,
) {
    let _end = WorkerEnd {
        state: state.clone(),
        session,
        live: live.clone(),
        done,
    };
    let mut last_write = None;
    while let Some(frame) = next_frame(&live, last_write, state.inner.min_interval) {
        if let Err(error) = write_frame(&mut *device, &frame) {
            state.worker_lost(session, &error);
            return;
        }
        live.sent.fetch_add(1, Ordering::Relaxed);
        last_write = Some(Instant::now());
    }
    let newer = lock(&state.inner.active)
        .as_ref()
        .is_some_and(|active| active.session != session);
    // Whatever was waiting is replaced by the all-off frame; a failure here changes nothing the player can fix.
    if !newer {
        let _ = write_frame(&mut *device, &Frame::OFF);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------------------------------------------------
// The real backend
// ---------------------------------------------------------------------------------------------------------------------

/// The system's HID devices through `hidapi`. The library is started on the first listing, which only Connect asks for.
#[derive(Default)]
pub struct HidApiBackend {
    api: Mutex<Option<hidapi::HidApi>>,
}
struct HidLink(hidapi::HidDevice);
impl LedDevice for HidLink {
    fn write(&mut self, report: &[u8]) -> Result<(), String> {
        self.0
            .write(report)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}
impl HidBackend for HidApiBackend {
    fn list(&self) -> Result<Vec<HidInfo>, String> {
        let mut api = lock(&self.api);
        // `HidApi::new` walks the system's HID devices once (hidapi 2.6.7 does that whatever the discovery setting says), so
        // the list is cut to the Fretlight ids at once and refreshed with those ids alone; nothing else is read or kept.
        if api.is_none() {
            *api = Some(hidapi::HidApi::new().map_err(|error| error.to_string())?);
        }
        let api = api.as_mut().expect("the library was just started");
        api.reset_devices().map_err(|error| error.to_string())?;
        api.add_devices(VENDOR_ID, PRODUCT_ID)
            .map_err(|error| error.to_string())?;
        Ok(api
            .device_list()
            .filter(|device| device.vendor_id() == VENDOR_ID && device.product_id() == PRODUCT_ID)
            .map(|device| HidInfo {
                vendor_id: device.vendor_id(),
                product_id: device.product_id(),
                product: device.product_string().map(str::to_owned),
                path: device.path().to_owned(),
            })
            .collect())
    }
    fn open(&self, info: &HidInfo) -> Result<Box<dyn LedDevice>, String> {
        let api = lock(&self.api);
        let api = api.as_ref().ok_or("The USB library is not started.")?;
        let device = api
            .open_path(&info.path)
            .map_err(|error| error.to_string())?;
        Ok(Box::new(HidLink(device)))
    }
    fn release(&self) {
        // A listing stuck in the driver keeps its handle; the process is ending anyway.
        if let Ok(mut api) = self.api.try_lock() {
            *api = None;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The fake backend, for tests and the desktop test build
// ---------------------------------------------------------------------------------------------------------------------

/// A pretend USB stack that lists the devices it was given and keeps every report written to its devices.
#[cfg(any(test, feature = "desktop-test"))]
pub struct FakeBackend {
    devices: Vec<HidInfo>,
    log: Arc<Mutex<Vec<Vec<u8>>>>,
    lists: std::sync::atomic::AtomicUsize,
    opens: std::sync::atomic::AtomicUsize,
    opened: Mutex<Vec<String>>,
    writes: Arc<std::sync::atomic::AtomicUsize>,
    fail_from: Arc<std::sync::atomic::AtomicUsize>,
    open_delay: Duration,
    list_error: Option<String>,
    panic_writes: Arc<AtomicBool>,
    write_delay_ms: Arc<AtomicU64>,
}
#[cfg(any(test, feature = "desktop-test"))]
impl FakeBackend {
    pub fn new(devices: Vec<HidInfo>) -> Self {
        Self {
            devices,
            log: Arc::default(),
            lists: Default::default(),
            opens: Default::default(),
            opened: Mutex::default(),
            writes: Arc::default(),
            fail_from: Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX)),
            open_delay: Duration::ZERO,
            list_error: None,
            panic_writes: Arc::default(),
            write_delay_ms: Arc::default(),
        }
    }
    /// Every open waits this long first, as a driver that is slow to answer.
    pub fn with_open_delay(mut self, delay: Duration) -> Self {
        self.open_delay = delay;
        self
    }
    pub fn with_list_error(mut self, message: &str) -> Self {
        self.list_error = Some(message.into());
        self
    }
    /// Every report written, oldest first.
    pub fn log(&self) -> Arc<Mutex<Vec<Vec<u8>>>> {
        self.log.clone()
    }
    pub fn lists(&self) -> usize {
        self.lists.load(Ordering::SeqCst)
    }
    pub fn opens(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }
    pub fn opened_names(&self) -> Vec<String> {
        lock(&self.opened).clone()
    }
    /// Writes numbered `n` and after (counting from the first write ever made) fail, as an unplugged device.
    /// Every write panics, as a driver that crashes inside the call.
    pub fn panic_on_writes(&self, panic: bool) {
        self.panic_writes.store(panic, Ordering::SeqCst);
    }
    /// Every write takes this long, as a driver that is slow to answer.
    pub fn set_write_delay(&self, delay: Duration) {
        self.write_delay_ms
            .store(delay.as_millis() as u64, Ordering::SeqCst);
    }
    pub fn fail_writes_from(&self, n: usize) {
        self.fail_from.store(n, Ordering::SeqCst);
    }
}
#[cfg(any(test, feature = "desktop-test"))]
struct FakeDevice {
    log: Arc<Mutex<Vec<Vec<u8>>>>,
    writes: Arc<std::sync::atomic::AtomicUsize>,
    fail_from: Arc<std::sync::atomic::AtomicUsize>,
    panic_writes: Arc<AtomicBool>,
    write_delay_ms: Arc<AtomicU64>,
}
#[cfg(any(test, feature = "desktop-test"))]
impl LedDevice for FakeDevice {
    fn write(&mut self, report: &[u8]) -> Result<(), String> {
        assert!(
            !self.panic_writes.load(Ordering::SeqCst),
            "the fake driver crashed"
        );
        thread::sleep(Duration::from_millis(
            self.write_delay_ms.load(Ordering::SeqCst),
        ));
        let number = self.writes.fetch_add(1, Ordering::SeqCst);
        if number >= self.fail_from.load(Ordering::SeqCst) {
            return Err("The device was unplugged.".into());
        }
        let mut log = lock(&self.log);
        if log.len() >= TEST_LOG_MAX {
            log.remove(0);
        }
        log.push(report.to_vec());
        Ok(())
    }
}
#[cfg(any(test, feature = "desktop-test"))]
impl HidBackend for FakeBackend {
    fn list(&self) -> Result<Vec<HidInfo>, String> {
        self.lists.fetch_add(1, Ordering::SeqCst);
        match &self.list_error {
            Some(message) => Err(message.clone()),
            None => Ok(self.devices.clone()),
        }
    }
    fn open(&self, info: &HidInfo) -> Result<Box<dyn LedDevice>, String> {
        thread::sleep(self.open_delay);
        self.opens.fetch_add(1, Ordering::SeqCst);
        lock(&self.opened).push(info.product.clone().unwrap_or_default());
        Ok(Box::new(FakeDevice {
            log: self.log.clone(),
            writes: self.writes.clone(),
            fail_from: self.fail_from.clone(),
            panic_writes: self.panic_writes.clone(),
            write_delay_ms: self.write_delay_ms.clone(),
        }))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------

fn app_events(app: AppHandle) -> EventSink {
    Arc::new(move |event| {
        let _ = app.emit("fretlight-status", event);
    })
}
/// Looks for a wired Fretlight and opens it. The only command that lists or opens a device.
#[tauri::command]
pub async fn fretlight_connect(
    state: State<'_, FretlightState>,
    app: AppHandle,
) -> Result<u64, String> {
    let state = state.inner().clone();
    let emit = app_events(app);
    tauri::async_runtime::spawn_blocking(move || state.connect(emit))
        .await
        .map_err(|error| error.to_string())?
}
/// Sets which LEDs are lit. Never blocks: the frame is handed to the worker and replaces one still waiting.
#[tauri::command]
pub fn fretlight_frame(
    state: State<'_, FretlightState>,
    session: u64,
    leds: Frame,
) -> Result<(), String> {
    state.send_frame(session, leds)
}
/// Turns the LEDs off and ends the named session, or whatever is running when none is named.
#[tauri::command]
pub async fn fretlight_disconnect(
    state: State<'_, FretlightState>,
    session: Option<u64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.disconnect(session))
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub fn fretlight_status(state: State<'_, FretlightState>) -> FretlightStatus {
    state.status()
}
/// What the fake guitar of the desktop test build was asked for.
#[cfg(feature = "desktop-test")]
#[derive(Serialize)]
pub struct TestLog {
    pub reports: Vec<Vec<u8>>,
    pub lists: usize,
    pub opens: usize,
}
/// The reports the fake guitar received, and how often the fake USB stack was listed and opened (desktop test builds only).
#[cfg(feature = "desktop-test")]
#[tauri::command]
pub fn fretlight_test_log(
    state: State<'_, FretlightState>,
    clear: bool,
) -> Result<TestLog, String> {
    let fake =
        state.inner.test.as_ref().ok_or(
            "The test Fretlight is not on; start the app with TABPLAYER_FRETLIGHT_TEST=1.",
        )?;
    let log = fake.log();
    let mut log = lock(&log);
    let reports = log.clone();
    if clear {
        log.clear();
    }
    Ok(TestLog {
        reports,
        lists: fake.lists(),
        opens: fake.opens(),
    })
}

#[cfg(test)]
mod service_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn one(string: usize, fret: usize) -> [[u8; PACKET_LEN]; PACKETS] {
        encode(&Frame::OFF.with(string, fret))
    }
    const NONE: [u8; PACKET_LEN] = [0, 0, 0, 0, 0, 0, 0];
    /// An all-zero packet with its number.
    const fn blank(id: u8) -> [u8; PACKET_LEN] {
        [0, 0, 0, 0, 0, 0, id]
    }

    #[test]
    fn all_off_is_three_blank_packets_with_their_numbers() {
        assert_eq!(encode(&Frame::OFF), [blank(1), blank(2), blank(3)]);
        let _ = NONE;
    }

    #[test]
    fn hand_computed_positions() {
        // String 1 (high E) at fret 0 is LED 0 of packet 1: bit 7 of byte 5.
        assert_eq!(one(1, 0), [[0, 0, 0, 0, 0, 0x80, 1], blank(2), blank(3)]);
        // String 6 (low E) at fret 0 is LED 5: bit 2 of byte 5.
        assert_eq!(one(6, 0), [[0, 0, 0, 0, 0, 0x04, 1], blank(2), blank(3)]);
        // String 3, fret 3: k = 3 * 6 + 2 = 20, byte 5 - 2 = 3, bit 7 - 4 = 3.
        assert_eq!(one(3, 3), [[0, 0, 0, 0x08, 0, 0, 1], blank(2), blank(3)]);
        // Fret 7 is the last fret of packet 1: string 1 is k = 42, byte 0, bit 5; string 6 is k = 47, byte 0, bit 0.
        assert_eq!(one(1, 7), [[0x20, 0, 0, 0, 0, 0, 1], blank(2), blank(3)]);
        assert_eq!(one(6, 7), [[0x01, 0, 0, 0, 0, 0, 1], blank(2), blank(3)]);
        // Fret 8 starts packet 2 over again.
        assert_eq!(one(1, 8), [blank(1), [0, 0, 0, 0, 0, 0x80, 2], blank(3)]);
        assert_eq!(one(6, 8), [blank(1), [0, 0, 0, 0, 0, 0x04, 2], blank(3)]);
        assert_eq!(one(1, 15), [blank(1), [0x20, 0, 0, 0, 0, 0, 2], blank(3)]);
        assert_eq!(one(6, 15), [blank(1), [0x01, 0, 0, 0, 0, 0, 2], blank(3)]);
        // Fret 16 starts packet 3; fret 21 string 1 is k = 30, byte 2, bit 1, and string 6 is k = 35, byte 1, bit 4 (byte 0 and the low nibble of byte 1 stay unused).
        assert_eq!(one(1, 16), [blank(1), blank(2), [0, 0, 0, 0, 0, 0x80, 3]]);
        assert_eq!(one(6, 16), [blank(1), blank(2), [0, 0, 0, 0, 0, 0x04, 3]]);
        assert_eq!(one(1, 21), [blank(1), blank(2), [0, 0, 0x02, 0, 0, 0, 3]]);
        assert_eq!(one(6, 21), [blank(1), blank(2), [0, 0x10, 0, 0, 0, 0, 3]]);
    }

    #[test]
    fn all_on_fills_every_used_bit_and_no_unused_one() {
        let all = Frame::from_leds([true; LEDS]);
        assert_eq!(
            encode(&all),
            [
                [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 1],
                [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 2],
                [0x00, 0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 3],
            ]
        );
    }

    #[test]
    fn every_position_sets_exactly_its_own_bit() {
        let mut seen = std::collections::HashSet::new();
        for string in 1..=STRINGS {
            for fret in 0..FRETS {
                let packets = one(string, fret);
                let set: u32 = packets
                    .iter()
                    .flat_map(|packet| packet[..6].iter())
                    .map(|byte| byte.count_ones())
                    .sum();
                assert_eq!(set, 1, "string {string} fret {fret}");
                // The bit lies in the packet of its fret group.
                let group = fret / 8;
                assert!(packets[group][..6].iter().any(|byte| *byte != 0));
                assert!(seen.insert(packets), "string {string} fret {fret} repeats");
            }
        }
        assert_eq!(seen.len(), LEDS);
    }

    /// The three packet tables of the source post, copied cell for cell: Rick Regan, "My Fretlight Guitar as a Binary
    /// Clock", Exploring Binary, section "The Fretlight Interface", tables "Packet ID 1", "Packet ID 2" and "Packet ID 3"
    /// (page read 2026-11-14). Row `n` is byte `n`, the cells run from Bit 7 to Bit 0, `fFsS` is fret F on string S (string
    /// 1 is the high E, as the post says), and `xxxxx` marks the bits the post says are unused. This does not use the
    /// encoder's own formula, so a mirrored string or bit order would fail it.
    const SOURCE_TABLES: [[[&str; 8]; 6]; 3] = [
        [
            [
                "f6s5", "f6s6", "f7s1", "f7s2", "f7s3", "f7s4", "f7s5", "f7s6",
            ],
            [
                "f5s3", "f5s4", "f5s5", "f5s6", "f6s1", "f6s2", "f6s3", "f6s4",
            ],
            [
                "f4s1", "f4s2", "f4s3", "f4s4", "f4s5", "f4s6", "f5s1", "f5s2",
            ],
            [
                "f2s5", "f2s6", "f3s1", "f3s2", "f3s3", "f3s4", "f3s5", "f3s6",
            ],
            [
                "f1s3", "f1s4", "f1s5", "f1s6", "f2s1", "f2s2", "f2s3", "f2s4",
            ],
            [
                "f0s1", "f0s2", "f0s3", "f0s4", "f0s5", "f0s6", "f1s1", "f1s2",
            ],
        ],
        [
            [
                "f14s5", "f14s6", "f15s1", "f15s2", "f15s3", "f15s4", "f15s5", "f15s6",
            ],
            [
                "f13s3", "f13s4", "f13s5", "f13s6", "f14s1", "f14s2", "f14s3", "f14s4",
            ],
            [
                "f12s1", "f12s2", "f12s3", "f12s4", "f12s5", "f12s6", "f13s1", "f13s2",
            ],
            [
                "f10s5", "f10s6", "f11s1", "f11s2", "f11s3", "f11s4", "f11s5", "f11s6",
            ],
            [
                "f9s3", "f9s4", "f9s5", "f9s6", "f10s1", "f10s2", "f10s3", "f10s4",
            ],
            [
                "f8s1", "f8s2", "f8s3", "f8s4", "f8s5", "f8s6", "f9s1", "f9s2",
            ],
        ],
        [
            [
                "xxxxx", "xxxxx", "xxxxx", "xxxxx", "xxxxx", "xxxxx", "xxxxx", "xxxxx",
            ],
            [
                "f21s3", "f21s4", "f21s5", "f21s6", "xxxxx", "xxxxx", "xxxxx", "xxxxx",
            ],
            [
                "f20s1", "f20s2", "f20s3", "f20s4", "f20s5", "f20s6", "f21s1", "f21s2",
            ],
            [
                "f18s5", "f18s6", "f19s1", "f19s2", "f19s3", "f19s4", "f19s5", "f19s6",
            ],
            [
                "f17s3", "f17s4", "f17s5", "f17s6", "f18s1", "f18s2", "f18s3", "f18s4",
            ],
            [
                "f16s1", "f16s2", "f16s3", "f16s4", "f16s5", "f16s6", "f17s1", "f17s2",
            ],
        ],
    ];

    fn cell(name: &str) -> (usize, usize) {
        let (fret, string) = name[1..].split_once('s').expect("fFsS");
        (string.parse().unwrap(), fret.parse().unwrap())
    }

    #[test]
    fn every_cell_of_the_source_tables_lights_exactly_that_bit() {
        let mut named = 0;
        for (packet, table) in SOURCE_TABLES.iter().enumerate() {
            for (byte, row) in table.iter().enumerate() {
                for (column, name) in row.iter().enumerate() {
                    let bit = 7 - column;
                    if *name == "xxxxx" {
                        continue;
                    }
                    let (string, fret) = cell(name);
                    let mut want = [[0u8; PACKET_LEN]; PACKETS];
                    for (index, p) in want.iter_mut().enumerate() {
                        p[6] = index as u8 + 1;
                    }
                    want[packet][byte] = 1 << bit;
                    assert_eq!(encode(&Frame::OFF.with(string, fret)), want, "{name}");
                    named += 1;
                }
            }
        }
        assert_eq!(named, 132, "every LED is named once in the source tables");
    }

    #[test]
    fn the_unused_bits_of_the_source_tables_are_never_set() {
        let all = encode(&Frame::from_leds([true; LEDS]));
        for (packet, table) in SOURCE_TABLES.iter().enumerate() {
            for (byte, row) in table.iter().enumerate() {
                for (column, name) in row.iter().enumerate() {
                    let set = all[packet][byte] & (1 << (7 - column)) != 0;
                    assert_eq!(
                        set,
                        *name != "xxxxx",
                        "packet {} byte {byte} bit {}",
                        packet + 1,
                        7 - column
                    );
                }
            }
        }
    }

    /// The post names f21s6 among the 19 LEDs of its clock, all in packet ID 3 (section "Overview of My Windows Code"): in the
    /// Packet ID 3 table that cell is byte 1, bit 4 (0x10).
    #[test]
    fn a_clock_led_the_post_names_is_where_its_table_puts_it() {
        assert_eq!(one(6, 21)[2], [0, 0x10, 0, 0, 0, 0, 3]);
        // f21s1 is byte 2, bit 1; f18s1 is byte 4, bit 3; f19s5 is byte 3, bit 1.
        assert_eq!(one(1, 21)[2], [0, 0, 0x02, 0, 0, 0, 3]);
        assert_eq!(one(1, 18)[2], [0, 0, 0, 0, 0x08, 0, 3]);
        assert_eq!(one(5, 19)[2], [0, 0, 0, 0x02, 0, 0, 3]);
    }

    #[test]
    fn two_leds_combine() {
        let frame = Frame::OFF.with(1, 0).with(6, 21).with(2, 9);
        // String 2 fret 9: packet 2, k = 6 + 1 = 7, byte 5, bit 0.
        assert_eq!(
            encode(&frame),
            [
                [0, 0, 0, 0, 0, 0x80, 1],
                [0, 0, 0, 0, 0, 0x01, 2],
                [0, 0x10, 0, 0, 0, 0, 3]
            ]
        );
    }
}
