//! MIDI input (THE-70, tracker rows U16 and U17), slice 1: a session-scoped input service that reaches the page as
//! chords, and does not touch the score.
//!
//! A MIDI device is untrusted. The driver callback does almost nothing: it keeps a well-formed note-on, stamps it and
//! pushes it into a bounded channel without blocking. One worker thread groups notes into chords, rate-limits them and
//! emits Tauri events. Nothing here runs on, or shares a lock with, the audio callback. Nothing about the notes played
//! is logged or persisted.
use crate::midi_out::MidiPortInfo;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

/// Messages that can wait between the driver callback and the worker. A full channel drops the newest note.
pub const CHANNEL_CAPACITY: usize = 256;
/// Notes in one chord. A chord that reaches it closes at once.
pub const MAX_CHORD_NOTES: usize = 8;
/// A chord also closes when its first note is this many windows old, so a held-open stream cannot grow one chord forever.
pub const SPAN_WINDOWS: u64 = 4;
pub const WINDOW_MIN_MS: u32 = 10;
pub const WINDOW_MAX_MS: u32 = 500;
pub const VELOCITY_MIN: u8 = 1;
pub const VELOCITY_MAX: u8 = 127;
/// Chords the page can be sent per second, with a burst of `CHORD_BURST`.
pub const CHORDS_PER_SECOND: u64 = 32;
pub const CHORD_BURST: u64 = 8;
/// Opens the system has not answered, at most, before every new Start is refused.
pub const MAX_PENDING_OPENS: usize = 4;
/// How long a player's Refresh waits for a listing already in progress before saying so.
const LISTING_WAIT: Duration = Duration::from_millis(500);
/// An open unanswered for this long is not coming back; the message then says the app has to be restarted.
const OPEN_STUCK_AFTER: Duration = Duration::from_secs(30);
/// The longest the worker sleeps without looking at its stop flag and settings.
const WORKER_WAKE: Duration = Duration::from_millis(250);
/// How often the watchdog asks the system for its ports, and how many misses in a row mean the device is gone.
const LOSS_POLL: Duration = Duration::from_secs(1);
const LOSS_MISSES: u32 = 2;
/// How long a port may take to open before the start fails.
const OPEN_TIMEOUT: Duration = Duration::from_secs(3);
/// How long closing a port may take before it is left to finish on its own thread.
const CLOSE_TIMEOUT: Duration = Duration::from_millis(1500);
const PORT_NAME_MAX: usize = 256;
#[cfg(any(test, feature = "desktop-test"))]
pub const TEST_PORT_NAME: &str = "Test MIDI input";
/// The most bytes one test injection may carry.
#[cfg(any(test, feature = "desktop-test"))]
const TEST_INJECT_MAX_BYTES: usize = 4 << 20;

/// Per-user capture sensitivity. Native keeps it only for the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSettings {
    /// The longest gap between two notes that still counts as one chord (10 to 500).
    pub chord_window_ms: u32,
    /// Notes softer than this are ignored (1 to 127).
    pub min_velocity: u8,
}
impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            chord_window_ms: 60,
            min_velocity: 1,
        }
    }
}
impl CaptureSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !(WINDOW_MIN_MS..=WINDOW_MAX_MS).contains(&self.chord_window_ms) {
            return Err(format!(
                "The chord window must be {WINDOW_MIN_MS} to {WINDOW_MAX_MS} ms."
            ));
        }
        if !(VELOCITY_MIN..=VELOCITY_MAX).contains(&self.min_velocity) {
            return Err(format!(
                "The velocity floor must be {VELOCITY_MIN} to {VELOCITY_MAX}."
            ));
        }
        Ok(())
    }
    fn window_us(&self) -> u64 {
        u64::from(self.chord_window_ms) * 1000
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ChordNote {
    pub key: u8,
    pub velocity: u8,
    pub channel: u8,
}
/// Notes played together. At most `MAX_CHORD_NOTES`, in the order they arrived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub seq: u64,
    /// When the first note arrived, in microseconds since the session started.
    pub at_us: u64,
    pub notes: Vec<ChordNote>,
}

/// The note, channel and velocity of a well-formed note-on, which is the only message input keeps. Everything else
/// (note-off, a note-on with velocity 0, controllers, bends, sysex, clock, short or long messages, data bytes with the
/// high bit set) is ignored.
pub fn parse_note_on(bytes: &[u8]) -> Option<(u8, u8, u8)> {
    let [status, key, velocity] = *bytes else {
        return None;
    };
    // Status 0x9n is a note-on; a data byte has its high bit clear; velocity 0 is a note-off.
    if status & 0xF0 != 0x90 || key > 127 || velocity == 0 || velocity > 127 {
        return None;
    }
    Some((status & 0x0F, key, velocity))
}

/// Groups note-ons into chords. Pure: the caller supplies every time, in microseconds on one clock.
pub struct ChordGrouper {
    settings: CaptureSettings,
    notes: [ChordNote; MAX_CHORD_NOTES],
    len: usize,
    first_us: u64,
    last_us: u64,
    next_seq: u64,
    below_floor: u64,
}
impl ChordGrouper {
    pub fn new(settings: CaptureSettings) -> Self {
        Self {
            settings,
            notes: [ChordNote {
                key: 0,
                velocity: 0,
                channel: 0,
            }; MAX_CHORD_NOTES],
            len: 0,
            first_us: 0,
            last_us: 0,
            next_seq: 1,
            below_floor: 0,
        }
    }
    pub fn configure(&mut self, settings: CaptureSettings) {
        self.settings = settings;
    }
    /// Notes dropped for being softer than the velocity floor.
    pub fn below_floor(&self) -> u64 {
        self.below_floor
    }
    /// Adds a note. Returns the chord this note closed: the one already open when the note came after its window or span,
    /// or the one this note filled to `MAX_CHORD_NOTES`.
    pub fn push(&mut self, at_us: u64, channel: u8, key: u8, velocity: u8) -> Option<Chord> {
        // A note-on with velocity 0 is a note-off, which is never forwarded.
        if velocity == 0 {
            return None;
        }
        if velocity < self.settings.min_velocity {
            self.below_floor += 1;
            return None;
        }
        let closed = self.poll(at_us);
        let note = ChordNote {
            key,
            velocity,
            channel,
        };
        if self.len == 0 {
            self.first_us = at_us;
            self.last_us = at_us;
        } else {
            self.last_us = self.last_us.max(at_us);
        }
        match self.notes[..self.len]
            .iter_mut()
            .find(|held| held.key == key && held.channel == channel)
        {
            Some(held) => held.velocity = held.velocity.max(velocity),
            None => {
                self.notes[self.len] = note;
                self.len += 1;
            }
        }
        if self.len == MAX_CHORD_NOTES {
            return self.close();
        }
        closed
    }
    fn close(&mut self) -> Option<Chord> {
        if self.len == 0 {
            return None;
        }
        let chord = Chord {
            seq: self.next_seq,
            at_us: self.first_us,
            notes: self.notes[..self.len].to_vec(),
        };
        self.next_seq += 1;
        self.len = 0;
        Some(chord)
    }
    /// Closes the open chord when its window or span has run out by `now_us`.
    pub fn poll(&mut self, now_us: u64) -> Option<Chord> {
        let due = self.next_deadline_us()?;
        if now_us >= due { self.close() } else { None }
    }
    /// When `poll` will next have something to close, if a chord is open.
    pub fn next_deadline_us(&self) -> Option<u64> {
        if self.len == 0 {
            return None;
        }
        let window = self.settings.window_us();
        Some(
            self.last_us
                .saturating_add(window)
                .min(self.first_us.saturating_add(window * SPAN_WINDOWS)),
        )
    }
}

/// One chord costs this many token units.
const TOKEN: u64 = 1_000_000;
/// A token bucket for chords sent to the page.
pub struct RateBucket {
    tokens: u64,
    last_us: u64,
}
impl RateBucket {
    pub fn new() -> Self {
        Self {
            tokens: CHORD_BURST * TOKEN,
            last_us: 0,
        }
    }
    pub fn allow(&mut self, now_us: u64) -> bool {
        let elapsed = now_us.saturating_sub(self.last_us);
        self.last_us = self.last_us.max(now_us);
        // One microsecond earns `CHORDS_PER_SECOND` units, so a second earns that many tokens.
        self.tokens = self
            .tokens
            .saturating_add(elapsed.saturating_mul(CHORDS_PER_SECOND))
            .min(CHORD_BURST * TOKEN);
        if self.tokens >= TOKEN {
            self.tokens -= TOKEN;
            true
        } else {
            false
        }
    }
}
impl Default for RateBucket {
    fn default() -> Self {
        Self::new()
    }
}

/// The bytes the driver delivers, one message at a time. Called on the driver's thread.
pub type RawSink = Box<dyn FnMut(&[u8]) + Send>;
/// An open port. Dropping it closes the port.
pub trait InputLink: Send {}
pub trait MidiInBackend: Send + Sync + 'static {
    /// Lists ports. Opens nothing.
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String>;
    /// The listing the watchdog asks for: the same, but never waits for one already in progress.
    fn ports_quick(&self) -> Result<Vec<MidiPortInfo>, String> {
        self.ports()
    }
    /// Lets go of anything kept for listing, as the app exits.
    fn release(&self) {}
    /// Opens the first port called `name` and delivers its messages to `sink`.
    fn open(&self, name: &str, sink: RawSink) -> Result<Box<dyn InputLink>, String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InputState {
    Running,
    Stopped,
    Lost,
    Error,
}
/// The `midi-in-chord` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordEvent {
    pub session: u64,
    pub seq: u64,
    pub at_ms: u64,
    /// Notes lost so far this session: to a full channel, or in a chord over the rate limit.
    pub dropped: u64,
    pub notes: Vec<ChordNote>,
}
/// The `midi-in-status` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    /// Rises with every notice, across sessions, so the page can drop one that arrives after a newer one.
    pub seq: u64,
    pub session: u64,
    pub state: InputState,
    pub port: String,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MidiInEvent {
    Chord(ChordEvent),
    Status(StatusEvent),
}
pub type EventSink = Arc<dyn Fn(MidiInEvent) + Send + Sync>;

/// What `midi_in_status` returns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiInStatus {
    /// The latest session, 0 before the first start.
    pub session: u64,
    pub state: InputState,
    pub port: String,
    pub message: String,
    /// Chords sent to the page.
    pub chords: u64,
    /// Notes lost to a full channel or the rate limit.
    pub dropped: u64,
    /// Notes ignored for being softer than the velocity floor.
    pub below_floor: u64,
}

/// The operating system's MIDI input ports through `midir`.
#[derive(Default)]
pub struct SystemMidiIn {
    /// The one client that lists ports, made the first time something lists and kept, so the watchdog does not create
    /// a system MIDI client every second.
    lister: Mutex<Option<midir::MidiInput>>,
    /// Also lists and opens the port the desktop tests inject into.
    #[cfg(any(test, feature = "desktop-test"))]
    test_port: bool,
    #[cfg(any(test, feature = "desktop-test"))]
    test_sink: TestSlot,
}
#[cfg(any(test, feature = "desktop-test"))]
type TestSlot = Arc<Mutex<Option<RawSink>>>;
/// Lists the inputs through the client in `slot`, making it with `create` when there is none. A client that cannot be made
/// is an error, never an empty list, and is tried again next time. A listing already in progress is waited for for up to
/// `wait`, polling, and then reported; it is never waited for without end, so a listing the driver never finishes cannot
/// queue up every later Refresh behind it.
fn list_inputs(
    slot: &Mutex<Option<midir::MidiInput>>,
    create: &dyn Fn() -> Result<midir::MidiInput, String>,
    wait: Duration,
) -> Result<Vec<MidiPortInfo>, String> {
    list_inputs_typed(slot, create, wait).map_err(|failure| match failure {
        ListFailure::Busy(message) | ListFailure::NoClient(message) => message,
    })
}
/// Why a listing failed, so a caller can treat a system without MIDI differently from a listing that is merely busy.
enum ListFailure {
    /// Another listing is still in progress.
    Busy(String),
    /// The system's MIDI client could not be made.
    NoClient(String),
}
fn list_inputs_typed(
    slot: &Mutex<Option<midir::MidiInput>>,
    create: &dyn Fn() -> Result<midir::MidiInput, String>,
    wait: Duration,
) -> Result<Vec<MidiPortInfo>, ListFailure> {
    let deadline = Instant::now() + wait;
    let mut client = loop {
        match slot.try_lock() {
            Ok(client) => break client,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(ListFailure::Busy(
                        "A MIDI listing is still in progress. Try again in a moment.".into(),
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    };
    if client.is_none() {
        *client = Some(create().map_err(ListFailure::NoClient)?);
    }
    let input = client.as_ref().expect("the client was just made");
    let mut found = Vec::new();
    for port in input.ports() {
        if let Ok(name) = input.port_name(&port) {
            found.push(MidiPortInfo {
                id: port.id(),
                name,
            });
        }
    }
    Ok(found)
}
impl SystemMidiIn {
    /// Lists the inputs, waiting up to `wait` for a listing in progress.
    fn list(&self, wait: Duration) -> Result<Vec<MidiPortInfo>, String> {
        self.list_with(wait, &Self::input)
    }

    /// `list` with the way of making the listing client given, so a system without MIDI can be stood in for.
    fn list_with(
        &self,
        wait: Duration,
        create: &dyn Fn() -> Result<midir::MidiInput, String>,
    ) -> Result<Vec<MidiPortInfo>, String> {
        // Listing opens no port. A system whose MIDI client cannot be made is an error the page can show.
        let system = list_inputs_typed(&self.lister, create, wait);
        // The injection port needs no system client (a CI machine has no sequencer), so a test build that asks for it
        // still lists it when that client cannot be made. A busy listing stays an error (the watchdog must not count a
        // miss for it), and without the test port a failed client stays an error too.
        #[cfg(any(test, feature = "desktop-test"))]
        if self.test_port {
            let mut found = match system {
                Ok(found) => found,
                Err(ListFailure::NoClient(_)) => Vec::new(),
                Err(ListFailure::Busy(message)) => return Err(message),
            };
            found.push(MidiPortInfo {
                id: format!("test:{TEST_PORT_NAME}"),
                name: TEST_PORT_NAME.into(),
            });
            return Ok(found);
        }
        system.map_err(|failure| match failure {
            ListFailure::Busy(message) | ListFailure::NoClient(message) => message,
        })
    }

    fn input() -> Result<midir::MidiInput, String> {
        let mut input = midir::MidiInput::new("TabPlayer input").map_err(|e| e.to_string())?;
        // Sysex, timing clock and active sensing never reach the callback.
        input.ignore(midir::Ignore::All);
        Ok(input)
    }
}
struct MidirLink(#[allow(dead_code)] midir::MidiInputConnection<RawSink>);
impl InputLink for MidirLink {}
/// Emptying the slot is what closes the test port.
#[cfg(any(test, feature = "desktop-test"))]
struct TestLink(TestSlot);
#[cfg(any(test, feature = "desktop-test"))]
impl InputLink for TestLink {}
#[cfg(any(test, feature = "desktop-test"))]
impl Drop for TestLink {
    fn drop(&mut self) {
        *lock(&self.0) = None;
    }
}
impl MidiInBackend for SystemMidiIn {
    fn ports_quick(&self) -> Result<Vec<MidiPortInfo>, String> {
        self.list(Duration::ZERO)
    }
    fn release(&self) {
        // A listing stuck in the driver keeps its client; the process is ending anyway.
        if let Ok(mut client) = self.lister.try_lock() {
            *client = None;
        }
    }
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        self.list(LISTING_WAIT)
    }
    fn open(&self, name: &str, sink: RawSink) -> Result<Box<dyn InputLink>, String> {
        #[cfg(any(test, feature = "desktop-test"))]
        if self.test_port && name == TEST_PORT_NAME {
            *lock(&self.test_sink) = Some(sink);
            return Ok(Box::new(TestLink(self.test_sink.clone())));
        }
        let input = Self::input()?;
        let port = input
            .ports()
            .into_iter()
            .find(|port| input.port_name(port).is_ok_and(|n| n == name))
            .ok_or_else(|| format!("The MIDI input \"{name}\" is not available."))?;
        // The driver's callback only hands the bytes to the sink.
        input
            .connect(
                &port,
                "TabPlayer input",
                |_driver_time, bytes, sink: &mut RawSink| sink(bytes),
                sink,
            )
            .map(|connection| Box::new(MidirLink(connection)) as Box<dyn InputLink>)
            .map_err(|e| e.to_string())
    }
}

/// A note-on as it crosses from the driver's thread to the worker.
struct RawNote {
    at_us: u64,
    channel: u8,
    key: u8,
    velocity: u8,
}
/// What the driver's callback, the worker and the commands share for one session.
struct Live {
    running: AtomicBool,
    window_ms: AtomicU32,
    min_velocity: AtomicU32,
    chords: AtomicU64,
    lost_to_channel: AtomicU64,
    lost_to_rate: AtomicU64,
    below_floor: AtomicU64,
}
impl Live {
    fn new(settings: CaptureSettings) -> Self {
        Self {
            running: AtomicBool::new(true),
            window_ms: AtomicU32::new(settings.chord_window_ms),
            min_velocity: AtomicU32::new(u32::from(settings.min_velocity)),
            chords: AtomicU64::new(0),
            lost_to_channel: AtomicU64::new(0),
            lost_to_rate: AtomicU64::new(0),
            below_floor: AtomicU64::new(0),
        }
    }
    fn set(&self, settings: CaptureSettings) {
        self.window_ms
            .store(settings.chord_window_ms, Ordering::Relaxed);
        self.min_velocity
            .store(u32::from(settings.min_velocity), Ordering::Relaxed);
    }
    fn settings(&self) -> CaptureSettings {
        CaptureSettings {
            chord_window_ms: self.window_ms.load(Ordering::Relaxed),
            min_velocity: self.min_velocity.load(Ordering::Relaxed) as u8,
        }
    }
    fn dropped(&self) -> u64 {
        self.lost_to_channel.load(Ordering::Relaxed) + self.lost_to_rate.load(Ordering::Relaxed)
    }
}
fn micros_since(epoch: Instant) -> u64 {
    u64::try_from(epoch.elapsed().as_micros()).unwrap_or(u64::MAX)
}
/// The session's time in microseconds: real time since it started, or a clock a test moves by hand.
#[derive(Clone)]
struct Clock {
    epoch: Instant,
    manual: Option<Arc<AtomicU64>>,
}
impl Clock {
    fn now_us(&self) -> u64 {
        match &self.manual {
            Some(manual) => manual.load(Ordering::SeqCst),
            None => micros_since(self.epoch),
        }
    }
}
/// What the driver's callback runs: validate, stamp, and hand over without ever blocking or allocating.
fn make_sink(tx: mpsc::SyncSender<RawNote>, live: Arc<Live>, clock: Clock) -> RawSink {
    Box::new(move |bytes: &[u8]| {
        let Some((channel, key, velocity)) = parse_note_on(bytes) else {
            return;
        };
        let note = RawNote {
            at_us: clock.now_us(),
            channel,
            key,
            velocity,
        };
        if tx.try_send(note).is_err() {
            live.lost_to_channel.fetch_add(1, Ordering::Relaxed);
        }
    })
}

struct Active {
    session: u64,
    port: String,
    link: Box<dyn InputLink>,
    live: Arc<Live>,
    emit: EventSink,
}
struct Snapshot {
    session: u64,
    state: InputState,
    port: String,
    message: String,
    chords: u64,
    dropped: u64,
    below_floor: u64,
}
impl Snapshot {
    fn idle(session: u64, state: InputState, port: &str, message: String) -> Self {
        Self {
            session,
            state,
            port: port.into(),
            message,
            chords: 0,
            dropped: 0,
            below_floor: 0,
        }
    }
    fn status(&self) -> MidiInStatus {
        MidiInStatus {
            session: self.session,
            state: self.state,
            port: self.port.clone(),
            message: self.message.clone(),
            chords: self.chords,
            dropped: self.dropped,
            below_floor: self.below_floor,
        }
    }
}
/// An open handed to the driver that has not come back.
struct PendingOpen {
    id: u64,
    port: String,
    since: Instant,
}
struct Inner {
    backend: Arc<dyn MidiInBackend>,
    /// The latest session number. A stop with no session number bumps it, which cancels a start still opening.
    counter: AtomicU64,
    active: Mutex<Option<Active>>,
    /// What the latest session ended as, until the next start.
    last: Mutex<Snapshot>,
    open_timeout: Duration,
    loss_poll: Duration,
    /// Opens that have not come back yet, including ones the start gave up waiting for.
    pending_opens: Arc<Mutex<Vec<PendingOpen>>>,
    next_open: AtomicU64,
    stuck_after: Duration,
    /// The last notice number. Held only while a notice is numbered and recorded, never while it is sent.
    notices: Mutex<u64>,
    /// Time moved by hand, for tests.
    manual_clock: Option<Arc<AtomicU64>>,
    /// Runs between a session being installed and its Running notice (tests only).
    #[cfg(test)]
    after_install: Mutex<Option<Box<dyn Fn(&MidiInState) + Send>>>,
    #[cfg(any(test, feature = "desktop-test"))]
    test_sink: TestSlot,
}

/// The managed input state. Cloning shares it, so blocking work can move to another thread.
#[derive(Clone)]
pub struct MidiInState {
    inner: Arc<Inner>,
}
impl Default for MidiInState {
    fn default() -> Self {
        let backend = SystemMidiIn::from_environment();
        #[cfg(any(test, feature = "desktop-test"))]
        let test_sink = backend.test_sink.clone();
        Self::build(
            Arc::new(backend),
            #[cfg(any(test, feature = "desktop-test"))]
            test_sink,
        )
    }
}
impl SystemMidiIn {
    /// The system's ports, plus the injection port when the desktop test build is run with `TABPLAYER_MIDI_IN_TEST=1`.
    pub fn from_environment() -> Self {
        Self {
            lister: Mutex::new(None),
            #[cfg(any(test, feature = "desktop-test"))]
            test_port: std::env::var("TABPLAYER_MIDI_IN_TEST").is_ok_and(|v| v == "1"),
            #[cfg(any(test, feature = "desktop-test"))]
            test_sink: Arc::default(),
        }
    }
}
impl MidiInState {
    pub fn new(backend: Arc<dyn MidiInBackend>) -> Self {
        Self::build(
            backend,
            #[cfg(any(test, feature = "desktop-test"))]
            Arc::default(),
        )
    }
    fn build(
        backend: Arc<dyn MidiInBackend>,
        #[cfg(any(test, feature = "desktop-test"))] test_sink: TestSlot,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                backend,
                counter: AtomicU64::new(0),
                active: Mutex::new(None),
                last: Mutex::new(Snapshot::idle(0, InputState::Stopped, "", String::new())),
                open_timeout: OPEN_TIMEOUT,
                loss_poll: LOSS_POLL,
                pending_opens: Arc::default(),
                next_open: AtomicU64::new(0),
                stuck_after: OPEN_STUCK_AFTER,
                notices: Mutex::new(0),
                manual_clock: None,
                #[cfg(test)]
                after_install: Mutex::new(None),
                #[cfg(any(test, feature = "desktop-test"))]
                test_sink,
            }),
        }
    }
    /// Shorter timeouts for tests. Call before the state is cloned.
    pub fn with_timings(mut self, open_timeout: Duration, loss_poll: Duration) -> Self {
        let inner =
            Arc::get_mut(&mut self.inner).expect("timings are set before the state is shared");
        inner.open_timeout = open_timeout;
        inner.loss_poll = loss_poll;
        self
    }
    /// Time that only moves when the caller says so, in microseconds. For tests, so grouping does not depend on
    /// scheduling. Call before the state is cloned.
    pub fn with_clock(mut self, clock: Arc<AtomicU64>) -> Self {
        let inner =
            Arc::get_mut(&mut self.inner).expect("the clock is set before the state is shared");
        inner.manual_clock = Some(clock);
        self
    }
    /// How long an unanswered open may be before the refusal says the app has to be restarted. For tests.
    pub fn with_stuck_after(mut self, stuck_after: Duration) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("set before the state is shared");
        inner.stuck_after = stuck_after;
        self
    }
    /// Refuses a Start for a port whose open has not come back, and any Start while too many opens are outstanding.
    /// With `reserve` the open is also recorded, under the same lock, so racing Starts cannot exceed the cap.
    fn admit(&self, port: &str, reserve: bool) -> Result<u64, String> {
        let mut pending = lock(&self.inner.pending_opens);
        let seconds = self.inner.stuck_after.as_secs();
        if let Some(open) = pending.iter().find(|open| open.port == port) {
            return Err(if open.since.elapsed() >= self.inner.stuck_after {
                format!(
                    "open_stuck: The MIDI input \"{port}\" has not answered the system for over {seconds} seconds. Restart TabPlayer to use it again."
                )
            } else {
                format!(
                    "open_pending: The MIDI input \"{port}\" is still being opened by the system. Wait a moment, then press Start again."
                )
            });
        }
        if pending.len() >= MAX_PENDING_OPENS {
            let stuck = pending
                .iter()
                .any(|open| open.since.elapsed() >= self.inner.stuck_after);
            return Err(if stuck {
                format!(
                    "open_busy_stuck: Several MIDI inputs have not answered the system for over {seconds} seconds. Restart TabPlayer to use MIDI input again."
                )
            } else {
                "open_busy: Several MIDI inputs are still being opened by the system. Wait a moment, then press Start again.".into()
            });
        }
        let id = self.inner.next_open.fetch_add(1, Ordering::SeqCst);
        if reserve {
            pending.push(PendingOpen {
                id,
                port: port.to_string(),
                since: Instant::now(),
            });
        }
        Ok(id)
    }
    /// Lists the ports. Opens none.
    pub fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        self.inner.backend.ports()
    }

    /// Opens `port` and starts delivering chords to `emit`. Returns the session number, which every event carries and
    /// which a later `stop` or `configure` must name. Starting while a session runs ends that one first. This blocks
    /// for at most the open timeout, so call it from a blocking thread.
    pub fn start(
        &self,
        port: &str,
        settings: CaptureSettings,
        emit: EventSink,
    ) -> Result<u64, String> {
        settings.validate()?;
        if port.is_empty() || port.len() > PORT_NAME_MAX {
            return Err("Choose a MIDI input first.".into());
        }
        let inner = &self.inner;
        // An open the system has not answered is still holding a thread and a sink; do not stack more on it.
        self.admit(port, false)?;
        let (session, replaced) = {
            let mut slot = lock(&inner.active);
            let session = inner.counter.fetch_add(1, Ordering::SeqCst) + 1;
            (session, slot.take())
        };
        if let Some(old) = replaced {
            self.finish(old, InputState::Stopped, String::new());
        }
        let live = Arc::new(Live::new(settings));
        let (tx, rx) = mpsc::sync_channel(CHANNEL_CAPACITY);
        let clock = Clock {
            epoch: Instant::now(),
            manual: inner.manual_clock.clone(),
        };
        let link = match self.open_within_timeout(port, make_sink(tx, live.clone(), clock.clone()))
        {
            Ok(link) => link,
            Err(message) => {
                if inner.counter.load(Ordering::SeqCst) == session {
                    self.record(
                        Snapshot::idle(session, InputState::Error, port, message.clone()),
                        &emit,
                    );
                }
                return Err(message);
            }
        };
        // Threads first: if one cannot be made the port is closed again and nothing was ever installed.
        let spawned = {
            let (worker_live, worker_emit, worker_clock) = (live.clone(), emit.clone(), clock);
            let worker = thread::Builder::new()
                .name("midi-in-worker".into())
                .spawn(move || run_worker(session, rx, worker_live, worker_clock, worker_emit));
            let (state, live, port) = (self.clone(), live.clone(), port.to_string());
            worker.and(
                thread::Builder::new()
                    .name("midi-in-watch".into())
                    .spawn(move || state.watch(session, &port, &live)),
            )
        };
        if let Err(error) = spawned {
            live.running.store(false, Ordering::Release);
            close_link(link);
            let message = format!("The MIDI input could not be started: {error}");
            self.record(
                Snapshot::idle(session, InputState::Error, port, message.clone()),
                &emit,
            );
            return Err(message);
        }
        {
            let mut slot = lock(&inner.active);
            if inner.counter.load(Ordering::SeqCst) != session {
                drop(slot);
                live.running.store(false, Ordering::Release);
                close_link(link);
                // A stop or a newer start came while this one was opening.
                if inner.counter.load(Ordering::SeqCst) == session + 1 {
                    let mut last = lock(&inner.last);
                    if last.session < session {
                        *last = Snapshot::idle(session, InputState::Stopped, port, String::new());
                    }
                }
                return Err("The start was cancelled before the MIDI input opened.".into());
            }
            *slot = Some(Active {
                session,
                port: port.into(),
                link,
                live: live.clone(),
                emit: emit.clone(),
            });
        }
        #[cfg(test)]
        if let Some(hook) = lock(&inner.after_install).as_ref() {
            hook(self);
        }
        // Whether the session is still the running one is decided while the notice is numbered, so a Running that
        // follows a Stopped always has the lower number and the page drops it. The send itself holds no lock.
        let notice = {
            let mut numbered = lock(&inner.notices);
            let still_running = lock(&inner.active)
                .as_ref()
                .is_some_and(|active| active.session == session);
            if !still_running {
                return Err("The start was cancelled before the MIDI input opened.".into());
            }
            *numbered += 1;
            StatusEvent {
                seq: *numbered,
                session,
                state: InputState::Running,
                port: port.into(),
                message: String::new(),
            }
        };
        emit(MidiInEvent::Status(notice));
        Ok(session)
    }

    /// Changes the sensitivity of the running session `session`.
    pub fn configure(&self, session: u64, settings: CaptureSettings) -> Result<(), String> {
        settings.validate()?;
        match lock(&self.inner.active).as_ref() {
            Some(active) if active.session == session => {
                active.live.set(settings);
                Ok(())
            }
            _ => Err("That MIDI input is not running any more.".into()),
        }
    }

    /// Stops the session `session`, or whatever is running (and any start still opening) when it is `None`. A number
    /// that is not the running session's, such as a stale panel's, changes nothing. Idempotent. The port is closed
    /// when this returns, unless the driver takes longer than a second and a half to let go.
    pub fn stop(&self, session: Option<u64>) {
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
            self.finish(active, InputState::Stopped, String::new());
        }
    }
    /// Closes the input when the app exits.
    pub fn shutdown(&self) {
        self.stop(None);
        self.inner.backend.release();
    }

    pub fn status(&self) -> MidiInStatus {
        let slot = lock(&self.inner.active);
        match slot.as_ref() {
            Some(active) => MidiInStatus {
                session: active.session,
                state: InputState::Running,
                port: active.port.clone(),
                message: String::new(),
                chords: active.live.chords.load(Ordering::Relaxed),
                dropped: active.live.dropped(),
                below_floor: active.live.below_floor.load(Ordering::Relaxed),
            },
            None => lock(&self.inner.last).status(),
        }
    }

    /// Feeds bytes to the open test port as if a device had sent them (desktop test builds only).
    #[cfg(any(test, feature = "desktop-test"))]
    pub fn test_inject(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > TEST_INJECT_MAX_BYTES {
            return Err("Too many bytes to inject.".into());
        }
        let mut slot = lock(&self.inner.test_sink);
        let sink = slot
            .as_mut()
            .ok_or_else(|| "The test MIDI input is not open.".to_string())?;
        for message in split_messages(bytes) {
            sink(message);
        }
        Ok(())
    }
    /// A state whose backend also offers the injection port, as the desktop test build does.
    #[cfg(any(test, feature = "desktop-test"))]
    pub fn with_test_port() -> Self {
        let backend = SystemMidiIn {
            lister: Mutex::new(None),
            test_port: true,
            test_sink: Arc::default(),
        };
        let test_sink = backend.test_sink.clone();
        Self::build(Arc::new(backend), test_sink)
    }

    /// Opens on its own thread so a driver that never answers delays nothing. A port that opens after the wait is over
    /// is closed again by that thread.
    fn open_within_timeout(&self, port: &str, sink: RawSink) -> Result<Box<dyn InputLink>, String> {
        let (tx, rx) = mpsc::channel();
        let (backend, name) = (self.inner.backend.clone(), port.to_string());
        let pending = self.inner.pending_opens.clone();
        let id = self.admit(port, true)?;
        let counted = pending.clone();
        let forget =
            move |pending: &Mutex<Vec<PendingOpen>>| lock(pending).retain(|open| open.id != id);
        thread::Builder::new()
            .name("midi-in-open".into())
            .spawn(move || {
                let opened = backend.open(&name, sink);
                // Stops counting before the answer is sent, so an answer that arrives never meets a refusal.
                forget(&counted);
                // Nobody waiting any more means the link drops here.
                let _ = tx.send(opened);
            })
            .map_err(|e| {
                lock(&pending).retain(|open| open.id != id);
                format!("The MIDI input \"{port}\" could not be opened: {e}")
            })?;
        match rx.recv_timeout(self.inner.open_timeout) {
            Ok(Ok(link)) => Ok(link),
            Ok(Err(error)) => Err(format!(
                "The MIDI input \"{port}\" could not be opened: {error}"
            )),
            Err(_) => Err(format!("The MIDI input \"{port}\" did not open in time.")),
        }
    }

    /// Ends a session that has been taken out of `active`: no more events from it, port closed, outcome remembered and
    /// announced.
    fn finish(&self, active: Active, state: InputState, message: String) {
        active.live.running.store(false, Ordering::Release);
        close_link(active.link);
        let snapshot = Snapshot {
            session: active.session,
            state,
            port: active.port,
            message,
            chords: active.live.chords.load(Ordering::Relaxed),
            dropped: active.live.dropped(),
            below_floor: active.live.below_floor.load(Ordering::Relaxed),
        };
        self.record(snapshot, &active.emit);
    }
    fn record(&self, snapshot: Snapshot, emit: &EventSink) {
        let event = {
            let mut numbered = lock(&self.inner.notices);
            *numbered += 1;
            let event = StatusEvent {
                seq: *numbered,
                session: snapshot.session,
                state: snapshot.state,
                port: snapshot.port.clone(),
                message: snapshot.message.clone(),
            };
            *lock(&self.inner.last) = snapshot;
            event
        };
        emit(MidiInEvent::Status(event));
    }

    /// midir reports no unplug, so ask the system for its ports once in a while. Two misses in a row mean the device
    /// is gone. Runs on its own thread, so a slow listing delays no chord.
    fn watch(&self, session: u64, port: &str, live: &Live) {
        let mut misses = 0;
        loop {
            let due = Instant::now() + self.inner.loss_poll;
            while Instant::now() < due {
                if !live.running.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(Duration::from_millis(25).min(self.inner.loss_poll));
            }
            if !live.running.load(Ordering::Acquire) {
                return;
            }
            // A listing that fails says nothing about this port.
            if let Ok(ports) = self.inner.backend.ports_quick() {
                if ports.iter().any(|p| p.name == port) {
                    misses = 0;
                } else {
                    misses += 1;
                }
            }
            if misses >= LOSS_MISSES {
                let taken = {
                    let mut slot = lock(&self.inner.active);
                    match slot.as_ref() {
                        Some(active) if active.session == session => slot.take(),
                        _ => None,
                    }
                };
                if let Some(active) = taken {
                    self.finish(
                        active,
                        InputState::Lost,
                        format!("The MIDI input \"{port}\" was disconnected."),
                    );
                }
                return;
            }
        }
    }
}

/// Closes a port without letting a driver that will not answer hold the caller for more than `CLOSE_TIMEOUT`.
fn close_link(link: Box<dyn InputLink>) {
    let (done, finished) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("midi-in-close".into())
        .spawn(move || {
            drop(link);
            let _ = done.send(());
        });
    if spawned.is_ok() {
        let _ = finished.recv_timeout(CLOSE_TIMEOUT);
    }
}

/// The session's worker: groups what the driver delivered into chords, rate-limits them and emits them. It checks its
/// stop flag at least every `WORKER_WAKE` and after every batch of at most `CHANNEL_CAPACITY` notes, so a flood cannot
/// keep it from stopping or from seeing a settings change.
fn run_worker(
    session: u64,
    rx: mpsc::Receiver<RawNote>,
    live: Arc<Live>,
    clock: Clock,
    emit: EventSink,
) {
    let mut grouper = ChordGrouper::new(live.settings());
    let mut bucket = RateBucket::new();
    let mut deliver = |chord: Chord, below_floor: u64| {
        live.below_floor.store(below_floor, Ordering::Relaxed);
        if !bucket.allow(clock.now_us()) {
            live.lost_to_rate
                .fetch_add(chord.notes.len() as u64, Ordering::Relaxed);
            return;
        }
        if !live.running.load(Ordering::Acquire) {
            return;
        }
        live.chords.fetch_add(1, Ordering::Relaxed);
        emit(MidiInEvent::Chord(ChordEvent {
            session,
            seq: chord.seq,
            at_ms: chord.at_us / 1000,
            dropped: live.dropped(),
            notes: chord.notes,
        }));
    };
    while live.running.load(Ordering::Acquire) {
        grouper.configure(live.settings());
        // The time is read before the queue is, so a note stamped after it is never judged by it.
        let now = clock.now_us();
        let queued = std::iter::from_fn(|| rx.try_recv().ok()).take(CHANNEL_CAPACITY);
        for chord in drain_then_poll(&mut grouper, queued, now, &|| live.settings()) {
            deliver(chord, grouper.below_floor());
        }
        live.below_floor
            .store(grouper.below_floor(), Ordering::Relaxed);
        let wait = grouper.next_deadline_us().map_or(WORKER_WAKE, |due| {
            Duration::from_micros(due.saturating_sub(now)).min(WORKER_WAKE)
        });
        // Sleeps until a note comes, the chord is due, or the wake. The note is handled at the top of the next pass.
        match rx.recv_timeout(wait) {
            Ok(note) => {
                grouper.configure(live.settings());
                if let Some(chord) = grouper.push(note.at_us, note.channel, note.key, note.velocity)
                {
                    deliver(chord, grouper.below_floor());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}
/// Takes every queued note into the grouper first and only then closes what is overdue at `now_us`, so a worker that was
/// descheduled does not close a chord that notes already waiting in the queue belong to.
fn drain_then_poll(
    grouper: &mut ChordGrouper,
    queued: impl Iterator<Item = RawNote>,
    now_us: u64,
    settings: &dyn Fn() -> CaptureSettings,
) -> Vec<Chord> {
    let mut closed = Vec::new();
    for note in queued {
        // Read for every note, so a configure applies to each note queued after it however long the drain takes.
        grouper.configure(settings());
        closed.extend(grouper.push(note.at_us, note.channel, note.key, note.velocity));
    }
    closed.extend(grouper.poll(now_us));
    closed
}

/// Splits injected bytes into messages at each status byte (high bit set).
#[cfg(any(test, feature = "desktop-test"))]
pub fn split_messages(bytes: &[u8]) -> Vec<&[u8]> {
    let mut messages = Vec::new();
    let mut start = 0;
    for (i, byte) in bytes.iter().enumerate() {
        if i > start && byte & 0x80 != 0 {
            messages.push(&bytes[start..i]);
            start = i;
        }
    }
    if start < bytes.len() {
        messages.push(&bytes[start..]);
    }
    messages
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn app_events(app: AppHandle) -> EventSink {
    Arc::new(move |event| match event {
        MidiInEvent::Chord(chord) => {
            let _ = app.emit("midi-in-chord", chord);
        }
        MidiInEvent::Status(status) => {
            let _ = app.emit("midi-in-status", status);
        }
    })
}

/// The system's MIDI input ports. Listing opens none.
#[tauri::command]
pub async fn midi_in_ports(state: State<'_, MidiInState>) -> Result<Vec<MidiPortInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.ports())
        .await
        .map_err(|e| e.to_string())?
}
/// Opens `port` and starts sending `midi-in-chord` and `midi-in-status` events. The only command that opens a port.
#[tauri::command]
pub async fn midi_in_start(
    state: State<'_, MidiInState>,
    app: AppHandle,
    port: String,
    settings: CaptureSettings,
) -> Result<u64, String> {
    let state = state.inner().clone();
    let emit = app_events(app);
    tauri::async_runtime::spawn_blocking(move || state.start(&port, settings, emit))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn midi_in_configure(
    state: State<'_, MidiInState>,
    session: u64,
    settings: CaptureSettings,
) -> Result<(), String> {
    state.configure(session, settings)
}
/// Stops the named session, or whatever is running when none is named.
#[tauri::command]
pub async fn midi_in_stop(
    state: State<'_, MidiInState>,
    session: Option<u64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.stop(session))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn midi_in_status(state: State<'_, MidiInState>) -> MidiInStatus {
    state.status()
}
/// Feeds bytes to the "Test MIDI input" port (desktop test builds only).
#[cfg(feature = "desktop-test")]
#[tauri::command]
pub fn midi_in_test_inject(state: State<'_, MidiInState>, bytes: Vec<u8>) -> Result<(), String> {
    state.test_inject(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(window: u32, floor: u8) -> CaptureSettings {
        CaptureSettings {
            chord_window_ms: window,
            min_velocity: floor,
        }
    }
    fn keys(chord: &Chord) -> Vec<u8> {
        chord.notes.iter().map(|n| n.key).collect()
    }

    #[test]
    fn settings_are_validated_to_the_documented_ranges() {
        assert!(settings(60, 1).validate().is_ok());
        assert!(settings(10, 127).validate().is_ok());
        assert!(settings(500, 1).validate().is_ok());
        assert!(settings(9, 1).validate().is_err());
        assert!(settings(501, 1).validate().is_err());
        assert!(settings(60, 0).validate().is_err());
        assert!(settings(60, 128).validate().is_err());
    }

    #[test]
    fn only_well_formed_note_ons_are_kept() {
        assert_eq!(parse_note_on(&[0x90, 60, 100]), Some((0, 60, 100)));
        assert_eq!(parse_note_on(&[0x9F, 0, 1]), Some((15, 0, 1)));
        assert_eq!(parse_note_on(&[0x93, 127, 127]), Some((3, 127, 127)));
        // A note-on with velocity 0 is a note-off.
        assert_eq!(parse_note_on(&[0x90, 60, 0]), None);
        for hostile in [
            &[][..],
            &[0x90][..],
            &[0x90, 60][..],
            &[0x90, 60, 100, 1][..],
            &[0x80, 60, 100][..],
            &[0xA0, 60, 100][..],
            &[0xB0, 7, 100][..],
            &[0xE0, 0, 64][..],
            &[0xF8][..],
            &[0xF0, 1, 2][..],
            &[0xFF, 60, 100][..],
            &[0x60, 60, 100][..],
            &[0x90, 128, 100][..],
            &[0x90, 60, 128][..],
            &[0x90, 255, 255][..],
        ] {
            assert_eq!(parse_note_on(hostile), None, "{hostile:?}");
        }
    }

    #[test]
    fn notes_inside_the_window_form_one_chord_that_closes_when_the_window_passes() {
        let mut g = ChordGrouper::new(settings(60, 1));
        assert!(g.push(1_000, 0, 60, 90).is_none());
        assert!(g.push(21_000, 0, 64, 90).is_none());
        assert!(g.push(41_000, 0, 67, 80).is_none());
        // 59.999 ms after the last note: still open.
        assert!(g.poll(100_999).is_none());
        let chord = g.poll(101_000).expect("the window has passed");
        assert_eq!(keys(&chord), [60, 64, 67]);
        assert_eq!(chord.at_us, 1_000);
        assert_eq!(chord.seq, 1);
        assert!(
            g.poll(1_000_000).is_none(),
            "a closed chord is not closed twice"
        );
    }

    #[test]
    fn a_note_after_the_window_closes_the_open_chord_and_starts_the_next() {
        let mut g = ChordGrouper::new(settings(60, 1));
        g.push(0, 0, 60, 90);
        g.push(10_000, 0, 64, 90);
        let first = g
            .push(70_000, 0, 72, 90)
            .expect("70 ms after the last note closes it");
        assert_eq!(keys(&first), [60, 64]);
        let second = g.poll(130_000).unwrap();
        assert_eq!(keys(&second), [72]);
        assert_eq!(second.at_us, 70_000);
        assert_eq!((first.seq, second.seq), (1, 2));
    }

    #[test]
    fn each_new_note_extends_the_chord_until_the_span_cap() {
        let mut g = ChordGrouper::new(settings(60, 1));
        // A note every 50 ms never leaves a 60 ms gap, so only the span (4 windows = 240 ms) ends the chord.
        for (i, key) in [60u8, 61, 62, 63, 64].into_iter().enumerate() {
            assert!(g.push(i as u64 * 50_000, 0, key, 90).is_none(), "note {i}");
        }
        assert_eq!(
            g.next_deadline_us(),
            Some(240_000),
            "the span cap, not the window, is next"
        );
        let closed = g
            .push(250_000, 0, 65, 90)
            .expect("the first note is 250 ms old");
        assert_eq!(keys(&closed), [60, 61, 62, 63, 64]);
        assert_eq!(keys(&g.poll(1_000_000).unwrap()), [65]);
    }

    #[test]
    fn the_span_cap_also_closes_a_chord_by_polling() {
        let mut g = ChordGrouper::new(settings(60, 1));
        for i in 0..5u64 {
            g.push(i * 50_000, 0, 60 + i as u8, 90);
        }
        assert!(g.poll(239_999).is_none());
        assert!(g.poll(240_000).is_some());
    }

    #[test]
    fn a_chord_closes_at_eight_notes_and_the_ninth_starts_another() {
        let mut g = ChordGrouper::new(settings(500, 1));
        for key in 40..47 {
            assert!(g.push(0, 0, key, 90).is_none());
        }
        let full = g
            .push(1, 0, 47, 90)
            .expect("the eighth note closes the chord");
        assert_eq!(full.notes.len(), MAX_CHORD_NOTES);
        assert!(g.push(2, 0, 48, 90).is_none());
        assert_eq!(keys(&g.poll(10_000_000).unwrap()), [48]);
    }

    #[test]
    fn the_same_channel_and_key_twice_keeps_the_louder_note_once() {
        let mut g = ChordGrouper::new(settings(60, 1));
        g.push(0, 0, 60, 50);
        g.push(1_000, 0, 60, 100);
        g.push(2_000, 0, 60, 70);
        g.push(3_000, 1, 60, 30);
        let chord = g.poll(1_000_000).unwrap();
        assert_eq!(
            chord.notes,
            [
                ChordNote {
                    key: 60,
                    velocity: 100,
                    channel: 0
                },
                ChordNote {
                    key: 60,
                    velocity: 30,
                    channel: 1
                },
            ]
        );
    }

    #[test]
    fn duplicates_do_not_use_up_the_eight_note_cap() {
        let mut g = ChordGrouper::new(settings(500, 1));
        for _ in 0..50 {
            assert!(g.push(0, 0, 60, 90).is_none());
        }
        assert_eq!(g.poll(10_000_000).unwrap().notes.len(), 1);
    }

    #[test]
    fn soft_notes_are_dropped_counted_and_do_not_extend_a_chord() {
        let mut g = ChordGrouper::new(settings(60, 40));
        g.push(0, 0, 60, 90);
        assert!(g.push(50_000, 0, 62, 39).is_none());
        assert_eq!(g.below_floor(), 1);
        // The soft note at 50 ms did not extend the chord: it closes 60 ms after the loud one.
        assert_eq!(g.next_deadline_us(), Some(60_000));
        g.push(59_000, 0, 64, 40);
        assert_eq!(keys(&g.poll(1_000_000).unwrap()), [60, 64]);
        assert_eq!(g.below_floor(), 1);
    }

    #[test]
    fn a_velocity_of_zero_is_never_a_note() {
        let mut g = ChordGrouper::new(settings(60, 1));
        assert!(g.push(0, 0, 60, 0).is_none());
        assert!(g.poll(1_000_000).is_none());
        assert_eq!(g.below_floor(), 0, "a note-off is not a soft note");
    }

    #[test]
    fn configure_changes_the_window_of_the_next_decision() {
        let mut g = ChordGrouper::new(settings(60, 1));
        g.push(0, 0, 60, 90);
        g.configure(settings(10, 1));
        assert!(g.poll(10_000).is_some());
    }

    #[test]
    fn times_that_go_backwards_do_not_panic_or_underflow() {
        let mut g = ChordGrouper::new(settings(60, 1));
        g.push(100_000, 0, 60, 90);
        assert!(g.push(5, 0, 62, 90).is_none());
        assert!(g.poll(0).is_none());
        assert!(g.poll(u64::MAX).is_some());
    }

    #[test]
    fn the_rate_bucket_allows_a_burst_then_refills_at_32_a_second() {
        let mut bucket = RateBucket::new();
        for i in 0..CHORD_BURST {
            assert!(bucket.allow(0), "burst chord {i}");
        }
        assert!(!bucket.allow(0));
        assert!(!bucket.allow(31_000), "31 ms is not yet one token");
        assert!(bucket.allow(31_250));
        assert!(!bucket.allow(31_250));
        // A long quiet time refills to the burst and no further.
        let later = 60_000_000;
        for _ in 0..CHORD_BURST {
            assert!(bucket.allow(later));
        }
        assert!(!bucket.allow(later));
        assert!(!bucket.allow(0), "an earlier time grants nothing");
    }

    // ----- The session state, with a fake backend -----

    #[derive(Clone)]
    enum OpenMode {
        Works,
        Fails(&'static str),
        /// Says it has been called, waits until released, then works.
        Gate(Arc<Gate>),
        /// As `Gate`, but only for the named port; others open at once.
        GateFor(String, Arc<Gate>),
    }
    /// Sequencing for an open that has to be caught mid-flight, without any sleeping.
    struct Gate {
        entered: Mutex<mpsc::Sender<()>>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    fn gate() -> (Arc<Gate>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let gate = Arc::new(Gate {
            entered: Mutex::new(entered_tx),
            release: Mutex::new(release_rx),
        });
        (gate, entered_rx, release_tx)
    }
    /// Longer than any test needs: only a guard against a hang.
    const GUARD: Duration = Duration::from_secs(10);
    struct FakeBackend {
        names: Mutex<Vec<String>>,
        sink: Arc<Mutex<Option<RawSink>>>,
        opens: AtomicU64,
        closed: Arc<AtomicU64>,
        mode: Mutex<OpenMode>,
        fail_listing: std::sync::atomic::AtomicBool,
        released: AtomicU64,
    }
    struct FakeLink {
        closed: Arc<AtomicU64>,
        sink: Arc<Mutex<Option<RawSink>>>,
    }
    impl InputLink for FakeLink {}
    impl Drop for FakeLink {
        fn drop(&mut self) {
            *lock(&self.sink) = None;
            self.closed.fetch_add(1, Ordering::SeqCst);
        }
    }
    impl FakeBackend {
        fn new(names: &[&str]) -> Arc<Self> {
            Arc::new(Self {
                names: Mutex::new(names.iter().map(|n| n.to_string()).collect()),
                sink: Arc::default(),
                opens: AtomicU64::new(0),
                closed: Arc::default(),
                mode: Mutex::new(OpenMode::Works),
                fail_listing: std::sync::atomic::AtomicBool::new(false),
                released: AtomicU64::new(0),
            })
        }
        /// What the driver would deliver.
        fn feed(&self, bytes: &[u8]) {
            if let Some(sink) = lock(&self.sink).as_mut() {
                sink(bytes);
            }
        }
        fn note_on(&self, key: u8, velocity: u8) {
            self.feed(&[0x90, key, velocity]);
        }
        fn closed(&self) -> u64 {
            self.closed.load(Ordering::SeqCst)
        }
    }
    impl MidiInBackend for FakeBackend {
        fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
            if self.fail_listing.load(Ordering::SeqCst) {
                return Err("The MIDI system could not be reached.".into());
            }
            Ok(lock(&self.names)
                .iter()
                .enumerate()
                .map(|(i, name)| MidiPortInfo {
                    id: i.to_string(),
                    name: name.clone(),
                })
                .collect())
        }
        fn release(&self) {
            self.released.fetch_add(1, Ordering::SeqCst);
        }
        fn open(&self, name: &str, sink: RawSink) -> Result<Box<dyn InputLink>, String> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            let mode = lock(&self.mode).clone();
            match mode {
                OpenMode::Fails(why) => return Err(why.to_string()),
                OpenMode::Gate(gate) => {
                    let _ = lock(&gate.entered).send(());
                    let _ = lock(&gate.release).recv_timeout(GUARD);
                }
                OpenMode::GateFor(only, gate) if only == name => {
                    let _ = lock(&gate.entered).send(());
                    let _ = lock(&gate.release).recv_timeout(GUARD);
                }
                OpenMode::GateFor(..) => {}
                OpenMode::Works => {}
            }
            if !lock(&self.names).iter().any(|n| n == name) {
                return Err(format!("The MIDI input \"{name}\" is not available."));
            }
            *lock(&self.sink) = Some(sink);
            Ok(Box::new(FakeLink {
                closed: self.closed.clone(),
                sink: self.sink.clone(),
            }))
        }
    }
    fn collector() -> (EventSink, mpsc::Receiver<MidiInEvent>) {
        let (tx, rx) = mpsc::channel();
        (
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
            rx,
        )
    }
    fn next_chord(rx: &mpsc::Receiver<MidiInEvent>) -> ChordEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left).expect("a chord arrives") {
                MidiInEvent::Chord(chord) => return chord,
                MidiInEvent::Status(_) => {}
            }
        }
    }
    fn next_status(rx: &mpsc::Receiver<MidiInEvent>) -> StatusEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left).expect("a status arrives") {
                MidiInEvent::Status(status) => return status,
                MidiInEvent::Chord(_) => {}
            }
        }
    }
    fn quiet(rx: &mpsc::Receiver<MidiInEvent>, wait: Duration) -> bool {
        rx.recv_timeout(wait).is_err()
    }
    fn state_with(backend: &Arc<FakeBackend>) -> MidiInState {
        MidiInState::new(backend.clone())
            .with_timings(Duration::from_millis(150), Duration::from_millis(20))
    }
    const PORT: &str = "USB MIDI";
    fn fast() -> CaptureSettings {
        settings(10, 1)
    }

    #[test]
    fn listing_ports_opens_nothing() {
        let backend = FakeBackend::new(&[PORT, "Other"]);
        let state = state_with(&backend);
        let names: Vec<_> = state.ports().unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, [PORT, "Other"]);
        assert_eq!(backend.opens.load(Ordering::SeqCst), 0);
        assert_eq!(state.status().state, InputState::Stopped);
        assert_eq!(state.status().session, 0);
    }

    #[test]
    fn start_opens_the_port_and_a_played_chord_reaches_the_page_with_its_session() {
        let backend = FakeBackend::new(&[PORT]);
        // Notes are stamped by a clock the test moves, so no scheduling delay can split or join chords.
        let clock = Arc::new(AtomicU64::new(0));
        let state = state_with(&backend).with_clock(clock.clone());
        let (emit, rx) = collector();
        let session = state.start(PORT, fast(), emit).unwrap();
        assert_eq!(session, 1);
        let running = next_status(&rx);
        assert_eq!(
            running,
            StatusEvent {
                seq: 1,
                session: 1,
                state: InputState::Running,
                port: PORT.into(),
                message: String::new(),
            }
        );
        backend.feed(&[0x91, 60, 100]);
        clock.store(1_000, Ordering::SeqCst);
        backend.feed(&[0x91, 64, 90]);
        backend.feed(&[0x80, 64, 0]);
        clock.store(2_000, Ordering::SeqCst);
        backend.feed(&[0x91, 67, 80]);
        // Ten milliseconds after the last note the window has passed.
        clock.store(12_000, Ordering::SeqCst);
        let chord = next_chord(&rx);
        assert_eq!((chord.session, chord.seq, chord.dropped), (1, 1, 0));
        assert_eq!(
            chord.notes,
            [
                ChordNote {
                    key: 60,
                    velocity: 100,
                    channel: 1
                },
                ChordNote {
                    key: 64,
                    velocity: 90,
                    channel: 1
                },
                ChordNote {
                    key: 67,
                    velocity: 80,
                    channel: 1
                },
            ]
        );
        clock.store(100_000, Ordering::SeqCst);
        backend.note_on(72, 70);
        clock.store(110_000, Ordering::SeqCst);
        let second = next_chord(&rx);
        assert_eq!((second.seq, second.notes.len()), (2, 1));
        assert!(second.at_ms >= chord.at_ms);
        let status = state.status();
        assert_eq!(
            (status.state, status.session, status.chords),
            (InputState::Running, 1, 2)
        );
        assert_eq!(status.port, PORT);
    }

    #[test]
    fn events_serialize_with_the_names_the_page_reads() {
        let event = ChordEvent {
            session: 3,
            seq: 9,
            at_ms: 120,
            dropped: 2,
            notes: vec![ChordNote {
                key: 60,
                velocity: 90,
                channel: 0,
            }],
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({"session":3,"seq":9,"atMs":120,"dropped":2,"notes":[{"key":60,"velocity":90,"channel":0}]})
        );
        let status = StatusEvent {
            seq: 4,
            session: 3,
            state: InputState::Lost,
            port: "p".into(),
            message: "m".into(),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"seq":4,"session":3,"state":"lost","port":"p","message":"m"})
        );
    }

    #[test]
    fn stop_closes_the_port_says_so_once_and_is_idempotent() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, rx) = collector();
        let session = state.start(PORT, fast(), emit).unwrap();
        next_status(&rx);
        state.stop(Some(session));
        assert_eq!(backend.closed(), 1);
        let stopped = next_status(&rx);
        assert_eq!((stopped.state, stopped.session), (InputState::Stopped, 1));
        state.stop(None);
        state.stop(Some(session));
        assert_eq!(backend.closed(), 1);
        assert!(quiet(&rx, Duration::from_millis(100)), "no second notice");
        assert_eq!(state.status().state, InputState::Stopped);
        // The device is closed, so nothing it sends can arrive.
        backend.note_on(60, 90);
        assert!(quiet(&rx, Duration::from_millis(100)));
    }

    #[test]
    fn a_stale_stop_leaves_a_newer_session_running() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (first_emit, _first_rx) = collector();
        let first = state.start(PORT, fast(), first_emit).unwrap();
        let (emit, rx) = collector();
        let second = state.start(PORT, fast(), emit).unwrap();
        assert_eq!((first, second), (1, 2));
        assert_eq!(backend.closed(), 1, "starting again closes the first port");
        state.stop(Some(first));
        assert_eq!(state.status().state, InputState::Running);
        assert_eq!(state.status().session, 2);
        backend.note_on(60, 90);
        assert_eq!(next_chord(&rx).session, 2);
        state.stop(Some(second));
        assert_eq!(state.status().state, InputState::Stopped);
    }

    #[test]
    fn a_failed_open_reports_an_error_and_leaves_nothing_running() {
        let backend = FakeBackend::new(&[PORT]);
        *lock(&backend.mode) = OpenMode::Fails("Access denied");
        let state = state_with(&backend);
        let (emit, rx) = collector();
        let error = state.start(PORT, fast(), emit).unwrap_err();
        assert!(error.contains("Access denied"), "{error}");
        let status = next_status(&rx);
        assert_eq!(status.state, InputState::Error);
        assert!(status.message.contains("Access denied"));
        assert_eq!(status.port, PORT);
        assert_eq!(state.status().state, InputState::Error);
        state.stop(None);
        assert_eq!(
            state.status().state,
            InputState::Error,
            "stopping what is not running changes nothing"
        );
    }

    #[test]
    fn an_open_that_never_returns_fails_after_the_timeout_and_the_late_port_is_closed() {
        let backend = FakeBackend::new(&[PORT]);
        let (held, entered, release) = gate();
        *lock(&backend.mode) = OpenMode::Gate(held);
        let state = state_with(&backend);
        let (emit, rx) = collector();
        // The open is held until released, so the timeout is what ends the start.
        let error = state.start(PORT, fast(), emit.clone()).unwrap_err();
        entered.recv_timeout(GUARD).unwrap();
        assert!(error.contains("did not open"), "{error}");
        assert_eq!(next_status(&rx).state, InputState::Error);
        // While that open is still outstanding another Start is refused, so presses cannot pile up threads.
        let refused = state.start(PORT, fast(), emit.clone()).unwrap_err();
        assert!(refused.starts_with("open_pending:"), "{refused}");
        assert_eq!(backend.opens.load(Ordering::SeqCst), 1);
        // The open finishes later; nobody wants that port any more.
        release.send(()).unwrap();
        let deadline = Instant::now() + GUARD;
        while backend.closed() == 0 && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(backend.closed(), 1);
        assert_eq!(state.status().state, InputState::Error);
        // With nothing outstanding a new Start is allowed again.
        *lock(&backend.mode) = OpenMode::Works;
        let again = Instant::now() + GUARD;
        let session = loop {
            match state.start(PORT, fast(), emit.clone()) {
                Ok(session) => break session,
                Err(error) if Instant::now() < again && error.starts_with("open_pending:") => {
                    thread::yield_now()
                }
                Err(error) => panic!("{error}"),
            }
        };
        state.stop(Some(session));
    }

    #[test]
    fn a_stop_during_a_slow_open_cancels_it() {
        let backend = FakeBackend::new(&[PORT]);
        let (held, entered, release) = gate();
        *lock(&backend.mode) = OpenMode::Gate(held);
        let state =
            MidiInState::new(backend.clone()).with_timings(GUARD, Duration::from_millis(20));
        let (emit, _rx) = collector();
        let starting = {
            let state = state.clone();
            thread::spawn(move || state.start(PORT, fast(), emit))
        };
        // The stop comes only once the start is inside the open.
        entered.recv_timeout(GUARD).unwrap();
        state.stop(None);
        release.send(()).unwrap();
        assert!(starting.join().unwrap().is_err(), "the start was overtaken");
        assert_eq!(backend.closed(), 1);
        assert_eq!(state.status().state, InputState::Stopped);
    }

    #[test]
    fn a_failed_listing_says_so_and_never_counts_as_a_lost_device() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, rx) = collector();
        state.start(PORT, fast(), emit).unwrap();
        next_status(&rx);
        backend.fail_listing.store(true, Ordering::SeqCst);
        assert!(
            state.ports().is_err(),
            "the page is told, not shown an empty list"
        );
        // Many watchdog rounds (20 ms each) with listings failing: still running.
        assert!(quiet(&rx, Duration::from_millis(300)));
        assert_eq!(state.status().state, InputState::Running);
        backend.fail_listing.store(false, Ordering::SeqCst);
        lock(&backend.names).clear();
        assert_eq!(next_status(&rx).state, InputState::Lost);
    }

    #[test]
    fn a_listing_client_that_cannot_be_made_is_an_error_and_is_tried_again() {
        let slot = Mutex::new(None);
        let tries = AtomicU64::new(0);
        let failing = || {
            tries.fetch_add(1, Ordering::SeqCst);
            Err::<midir::MidiInput, String>("no MIDI service".into())
        };
        assert_eq!(
            list_inputs(&slot, &failing, Duration::ZERO).unwrap_err(),
            "no MIDI service"
        );
        assert!(list_inputs(&slot, &failing, Duration::ZERO).is_err());
        assert_eq!(tries.load(Ordering::SeqCst), 2);
        assert!(lock(&slot).is_none());
    }

    #[test]
    fn a_stop_between_the_install_and_the_running_notice_leaves_only_stopped() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, rx) = collector();
        // The stop lands exactly in the gap the review found.
        *lock(&state.inner.after_install) = Some(Box::new(|state: &MidiInState| state.stop(None)));
        let error = state.start(PORT, fast(), emit).unwrap_err();
        assert!(error.contains("cancelled"), "{error}");
        let events: Vec<_> = rx.try_iter().collect();
        let states: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                MidiInEvent::Status(s) => Some(s.state),
                _ => None,
            })
            .collect();
        assert_eq!(states, [InputState::Stopped], "{events:?}");
        assert_eq!(state.status().state, InputState::Stopped);
        assert_eq!(backend.closed(), 1);
    }

    #[test]
    fn queued_notes_that_extend_an_open_chord_are_taken_before_it_is_closed() {
        let mut grouper = ChordGrouper::new(settings(60, 1));
        grouper.push(0, 0, 60, 90);
        let queued = [(50_000, 62), (100_000, 64)].map(|(at_us, key)| RawNote {
            at_us,
            channel: 0,
            key,
            velocity: 90,
        });
        // A worker that slept for a second finds the chord overdue and two notes waiting that belong to it.
        let chords = drain_then_poll(&mut grouper, queued.into_iter(), 1_000_000, &|| {
            settings(60, 1)
        });
        assert_eq!(chords.len(), 1, "{chords:?}");
        assert_eq!(keys(&chords[0]), [60, 62, 64]);
    }

    #[test]
    fn a_port_that_disappears_is_reported_lost_after_two_misses_and_closed() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, rx) = collector();
        state.start(PORT, fast(), emit).unwrap();
        next_status(&rx);
        // Still listed: nothing happens.
        assert!(quiet(&rx, Duration::from_millis(120)));
        lock(&backend.names).clear();
        let lost = next_status(&rx);
        assert_eq!((lost.state, lost.session), (InputState::Lost, 1));
        assert!(lost.message.contains(PORT));
        assert_eq!(backend.closed(), 1);
        assert_eq!(state.status().state, InputState::Lost);
        // Stopping a lost session is harmless and keeps what happened until the next start.
        state.stop(Some(1));
        assert_eq!(state.status().state, InputState::Lost);
    }

    #[test]
    fn settings_can_change_while_running_and_a_stale_session_cannot_change_them() {
        let backend = FakeBackend::new(&[PORT]);
        let clock = Arc::new(AtomicU64::new(0));
        let state = state_with(&backend).with_clock(clock.clone());
        let (emit, rx) = collector();
        let session = state.start(PORT, settings(500, 1), emit).unwrap();
        // Loud notes pass the old floor and the new one alike, so it does not matter which the worker sees first.
        backend.note_on(60, 90);
        backend.note_on(62, 90);
        state.configure(session, settings(10, 50)).unwrap();
        // The floor was raised before this note was sent, so it is dropped however the worker is scheduled.
        backend.note_on(64, 20);
        clock.store(100_000, Ordering::SeqCst);
        backend.note_on(65, 90);
        let chord = next_chord(&rx);
        assert_eq!(
            chord.notes.iter().map(|n| n.key).collect::<Vec<_>>(),
            [60, 62]
        );
        clock.store(200_000, Ordering::SeqCst);
        let after = next_chord(&rx);
        assert_eq!(after.notes.iter().map(|n| n.key).collect::<Vec<_>>(), [65]);
        assert!(state.status().below_floor >= 1);
        assert!(state.configure(session + 1, fast()).is_err());
        assert!(state.configure(session, settings(5, 1)).is_err());
        assert!(state.configure(session, settings(60, 0)).is_err());
    }

    #[test]
    fn a_hung_open_of_one_port_blocks_that_port_and_a_few_in_all_but_not_the_rest() {
        let backend = FakeBackend::new(&["A", "B", "C", "D", "E", "F"]);
        let (held, entered, release) = gate();
        *lock(&backend.mode) = OpenMode::GateFor("A".into(), held);
        let state = state_with(&backend);
        let (emit, _rx) = collector();
        let error = state.start("A", fast(), emit.clone()).unwrap_err();
        entered.recv_timeout(GUARD).unwrap();
        assert!(error.contains("did not open"), "{error}");
        // The same port is refused with the plain wait message; another port is not affected.
        assert!(
            state
                .start("A", fast(), emit.clone())
                .unwrap_err()
                .starts_with("open_pending:")
        );
        let session = state.start("B", fast(), emit.clone()).unwrap();
        assert_eq!(state.status().port, "B");
        state.stop(Some(session));
        release.send(()).unwrap();
        state.stop(None);
    }

    #[test]
    fn the_number_of_outstanding_opens_is_capped_whatever_the_ports() {
        let backend = FakeBackend::new(&["A", "B", "C", "D", "E"]);
        let (held, _entered, release) = gate();
        *lock(&backend.mode) = OpenMode::Gate(held);
        let state = state_with(&backend);
        let (emit, _rx) = collector();
        for port in ["A", "B", "C", "D"] {
            let error = state.start(port, fast(), emit.clone()).unwrap_err();
            assert!(error.contains("did not open"), "{port}: {error}");
        }
        assert_eq!(
            backend.opens.load(Ordering::SeqCst),
            MAX_PENDING_OPENS as u64
        );
        let refused = state.start("E", fast(), emit).unwrap_err();
        assert!(refused.starts_with("open_busy:"), "{refused}");
        assert_eq!(
            backend.opens.load(Ordering::SeqCst),
            MAX_PENDING_OPENS as u64
        );
        for _ in 0..MAX_PENDING_OPENS {
            let _ = release.send(());
        }
    }

    #[test]
    fn an_open_that_is_long_overdue_says_the_app_has_to_be_restarted() {
        let backend = FakeBackend::new(&[PORT]);
        let (held, entered, release) = gate();
        *lock(&backend.mode) = OpenMode::Gate(held);
        let state = state_with(&backend).with_stuck_after(Duration::ZERO);
        let (emit, _rx) = collector();
        assert!(state.start(PORT, fast(), emit.clone()).is_err());
        entered.recv_timeout(GUARD).unwrap();
        let refused = state.start(PORT, fast(), emit).unwrap_err();
        assert!(refused.starts_with("open_stuck:"), "{refused}");
        let _ = release.send(());
    }

    #[test]
    fn a_listing_that_is_still_in_progress_is_reported_at_once_not_waited_for() {
        let slot = Mutex::new(None);
        let create = || Err::<midir::MidiInput, String>("not reached".into());
        let held = slot.lock().unwrap();
        let began = Instant::now();
        let error = list_inputs(&slot, &create, Duration::ZERO).unwrap_err();
        assert!(error.contains("still in progress"), "{error}");
        assert!(began.elapsed() < GUARD);
        drop(held);
        assert_eq!(
            list_inputs(&slot, &create, Duration::ZERO).unwrap_err(),
            "not reached"
        );
    }

    #[test]
    fn a_configure_applies_to_every_note_queued_after_it_even_in_the_middle_of_a_drain() {
        let floor = AtomicU32::new(1);
        let current = || CaptureSettings {
            chord_window_ms: 60,
            min_velocity: floor.load(Ordering::SeqCst) as u8,
        };
        let mut grouper = ChordGrouper::new(current());
        // The queue is read lazily, as the worker reads it. The floor rises just before the third note is taken, as a
        // configure sent between the second and third note does, whatever the worker was doing at that moment.
        let notes = [(0, 60, 90), (1_000, 62, 90), (2_000, 64, 20)];
        let mut index = 0;
        let queued = std::iter::from_fn(|| {
            let (at_us, key, velocity) = *notes.get(index)?;
            if index == 2 {
                floor.store(50, Ordering::SeqCst);
            }
            index += 1;
            Some(RawNote {
                at_us,
                channel: 0,
                key,
                velocity,
            })
        });
        let chords = drain_then_poll(&mut grouper, queued, 1_000_000, &current);
        assert_eq!(chords.len(), 1, "{chords:?}");
        assert_eq!(keys(&chords[0]), [60, 62]);
        assert_eq!(grouper.below_floor(), 1);
    }

    #[test]
    fn a_players_refresh_waits_a_moment_for_a_listing_in_progress_and_the_watchdog_does_not() {
        let slot = Arc::new(Mutex::new(None));
        let (held_tx, held_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let holder = {
            let slot = slot.clone();
            thread::spawn(move || {
                let _listing = lock(&slot);
                held_tx.send(()).unwrap();
                let _ = go_rx.recv_timeout(GUARD);
            })
        };
        held_rx.recv_timeout(GUARD).unwrap();
        let create = || Err::<midir::MidiInput, String>("not reached".into());
        let quick = list_inputs(&slot, &create, Duration::ZERO).unwrap_err();
        assert!(quick.contains("still in progress"), "{quick}");
        let refresh = {
            let slot = slot.clone();
            thread::spawn(move || {
                list_inputs(
                    &slot,
                    &|| Err("not reached".into()),
                    LISTING_WAIT.max(GUARD),
                )
            })
        };
        // The listing in progress finishes; the waiting Refresh then gets its turn instead of failing.
        go_tx.send(()).unwrap();
        assert_eq!(refresh.join().unwrap().unwrap_err(), "not reached");
        holder.join().unwrap();
    }

    #[test]
    fn with_every_slot_hung_and_overdue_the_busy_refusal_says_to_restart() {
        let backend = FakeBackend::new(&["A", "B", "C", "D", "E"]);
        let (held, _entered, release) = gate();
        *lock(&backend.mode) = OpenMode::Gate(held);
        let state = state_with(&backend).with_stuck_after(Duration::ZERO);
        let (emit, _rx) = collector();
        for port in ["A", "B", "C", "D"] {
            assert!(state.start(port, fast(), emit.clone()).is_err());
        }
        let refused = state.start("E", fast(), emit).unwrap_err();
        assert!(refused.starts_with("open_busy_stuck:"), "{refused}");
        for _ in 0..MAX_PENDING_OPENS {
            let _ = release.send(());
        }
    }

    #[test]
    fn starts_that_race_cannot_take_more_open_slots_than_the_cap() {
        let names: Vec<String> = (0..12).map(|i| format!("P{i}")).collect();
        let backend = FakeBackend::new(&names.iter().map(String::as_str).collect::<Vec<_>>());
        let (held, _entered, release) = gate();
        *lock(&backend.mode) = OpenMode::Gate(held);
        let state = state_with(&backend);
        let (emit, _rx) = collector();
        let racers: Vec<_> = names
            .iter()
            .map(|name| {
                let (state, emit, name) = (state.clone(), emit.clone(), name.clone());
                thread::spawn(move || state.start(&name, fast(), emit))
            })
            .collect();
        for racer in racers {
            let _ = racer.join().unwrap();
        }
        assert!(backend.opens.load(Ordering::SeqCst) <= MAX_PENDING_OPENS as u64);
        for _ in 0..names.len() {
            let _ = release.send(());
        }
    }

    #[test]
    fn status_notices_carry_a_rising_sequence_number_and_are_sent_without_holding_the_order_lock() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let emit: EventSink = {
            let (seen, state) = (seen.clone(), state.clone());
            Arc::new(move |event| {
                if let MidiInEvent::Status(status) = event {
                    // Even a sink that calls back into the state (as the app's can, via the main thread) cannot deadlock.
                    let _ = state.status();
                    assert!(
                        state.inner.notices.try_lock().is_ok(),
                        "the order lock is held across a send"
                    );
                    lock(&seen).push(status.seq);
                }
            })
        };
        let session = state.start(PORT, fast(), emit.clone()).unwrap();
        state.stop(Some(session));
        let session = state.start(PORT, fast(), emit).unwrap();
        state.stop(Some(session));
        let seqs = lock(&seen).clone();
        assert_eq!(seqs.len(), 4);
        assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "{seqs:?}");
    }

    #[test]
    fn shutdown_stops_the_session_and_lets_go_of_the_listing_client() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, _rx) = collector();
        state.start(PORT, fast(), emit).unwrap();
        state.shutdown();
        assert_eq!(state.status().state, InputState::Stopped);
        assert_eq!(backend.closed(), 1);
        assert_eq!(backend.released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hostile_starts_are_refused_before_any_port_is_opened() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, _rx) = collector();
        assert!(state.start(PORT, settings(5, 1), emit.clone()).is_err());
        assert!(state.start(PORT, settings(60, 0), emit.clone()).is_err());
        assert!(state.start("", fast(), emit.clone()).is_err());
        assert!(
            state
                .start(&"x".repeat(PORT_NAME_MAX + 1), fast(), emit)
                .is_err()
        );
        assert_eq!(backend.opens.load(Ordering::SeqCst), 0);
        assert_eq!(state.status().state, InputState::Stopped);
    }

    #[test]
    fn malformed_and_non_note_messages_make_no_chord() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, rx) = collector();
        state.start(PORT, fast(), emit).unwrap();
        next_status(&rx);
        for bytes in [
            &[0x90, 60][..],
            &[0x90, 60, 0][..],
            &[0x80, 60, 90][..],
            &[0x90, 200, 90][..],
            &[0x90, 60, 200][..],
            &[0xB0, 64, 127][..],
            &[0xF0, 1, 2, 3, 0xF7][..],
            &[0xF8][..],
            &[][..],
            &[0x90, 60, 90, 1][..],
        ] {
            backend.feed(bytes);
        }
        assert!(quiet(&rx, Duration::from_millis(150)));
        assert_eq!(state.status().chords, 0);
    }

    #[test]
    fn a_flood_stays_bounded_drops_are_counted_and_the_worker_stays_responsive() {
        let backend = FakeBackend::new(&[PORT]);
        let state = state_with(&backend);
        let (emit, rx) = collector();
        let session = state.start(PORT, fast(), emit).unwrap();
        next_status(&rx);
        let began = Instant::now();
        for i in 0..1_000_000u32 {
            // Distinct keys, so chords fill up and close as fast as they can.
            backend.feed(&[0x90 | (i % 16) as u8, (i % 128) as u8, 1 + (i % 127) as u8]);
        }
        let flooded = began.elapsed();
        assert!(
            flooded < Duration::from_secs(30),
            "a million messages took {flooded:?}"
        );
        thread::sleep(Duration::from_millis(300));
        let status = state.status();
        assert!(status.dropped > 0, "{status:?}");
        // Chords sent are bounded by the burst plus the steady rate over the time taken.
        let allowed = CHORD_BURST + CHORDS_PER_SECOND * (began.elapsed().as_secs() + 1);
        assert!(
            status.chords <= allowed,
            "{} chords in {:?}",
            status.chords,
            began.elapsed()
        );
        assert_eq!(
            rx.try_iter()
                .filter(|e| matches!(e, MidiInEvent::Chord(_)))
                .count() as u64,
            status.chords
        );
        // Still alive: settings change, and a lone chord arrives once the bucket has refilled.
        state.configure(session, settings(10, 1)).unwrap();
        thread::sleep(Duration::from_millis(400));
        backend.note_on(60, 90);
        assert!(
            next_chord(&rx).dropped > 0,
            "the page is told notes were lost"
        );
        let stopping = Instant::now();
        state.stop(Some(session));
        assert!(
            stopping.elapsed() < Duration::from_secs(2),
            "{:?}",
            stopping.elapsed()
        );
    }

    #[test]
    fn the_test_port_is_listed_and_fed_only_when_asked_for() {
        let state = MidiInState::with_test_port();
        let names: Vec<_> = state.ports().unwrap().into_iter().map(|p| p.name).collect();
        assert!(names.iter().any(|n| n == TEST_PORT_NAME), "{names:?}");
        assert!(
            state.test_inject(&[0x90, 60, 90]).is_err(),
            "nothing is open yet"
        );
        let (emit, rx) = collector();
        let session = state.start(TEST_PORT_NAME, fast(), emit).unwrap();
        // Messages are split at each status byte: three note-ons, a note-off and a malformed one.
        state
            .test_inject(&[
                0x90, 60, 90, 0x90, 64, 80, 0x92, 67, 70, 0x80, 60, 0, 0x90, 70,
            ])
            .unwrap();
        let chord = next_chord(&rx);
        assert_eq!(
            chord
                .notes
                .iter()
                .map(|n| (n.key, n.channel))
                .collect::<Vec<_>>(),
            [(60, 0), (64, 0), (67, 2)]
        );
        state.stop(Some(session));
        assert!(state.test_inject(&[0x90, 60, 90]).is_err(), "closed again");
        // The ordinary build offers no such port, whatever the system says: a listing either leaves it out or fails.
        let plain = SystemMidiIn::default();
        match plain.ports_quick() {
            Ok(ports) => assert!(ports.iter().all(|p| p.name != TEST_PORT_NAME), "{ports:?}"),
            Err(error) => assert!(!error.is_empty(), "a failed listing says why"),
        }
    }

    #[test]
    fn the_test_port_needs_no_system_midi_client_but_a_plain_listing_still_does() {
        let no_midi =
            || Err::<midir::MidiInput, String>("MIDI support could not be initialized".into());
        // As on a CI machine without a sequencer: the injection port is listed and can be opened.
        let testing = SystemMidiIn {
            test_port: true,
            ..SystemMidiIn::default()
        };
        let found = testing.list_with(Duration::ZERO, &no_midi).unwrap();
        assert_eq!(
            found.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            [TEST_PORT_NAME]
        );
        assert!(testing.open(TEST_PORT_NAME, Box::new(|_| {})).is_ok());
        // Real use is unchanged: without the test port, a client that cannot be made is an error, not an empty list.
        let plain = SystemMidiIn::default();
        assert_eq!(
            plain.list_with(Duration::ZERO, &no_midi).unwrap_err(),
            "MIDI support could not be initialized"
        );
    }

    #[test]
    fn a_busy_listing_stays_an_error_in_test_mode_and_the_watchdog_counts_nothing() {
        let backend = Arc::new(SystemMidiIn {
            test_port: true,
            ..SystemMidiIn::default()
        });
        let no_midi = || Err::<midir::MidiInput, String>("not reached".into());
        let busy = lock(&backend.lister);
        let error = backend.list_with(Duration::ZERO, &no_midi).unwrap_err();
        assert!(error.contains("still in progress"), "{error}");
        // A session on the test port whose listings are all busy is never reported lost.
        let state = MidiInState::new(backend.clone())
            .with_timings(Duration::from_millis(150), Duration::from_millis(20));
        let (emit, rx) = collector();
        state.start(TEST_PORT_NAME, fast(), emit).unwrap();
        next_status(&rx);
        assert!(quiet(&rx, Duration::from_millis(400)));
        assert_eq!(state.status().state, InputState::Running);
        drop(busy);
    }

    #[test]
    fn injected_bytes_split_at_status_bytes() {
        assert_eq!(
            split_messages(&[0x90, 60, 90, 0xF8, 0x80, 60]),
            [&[0x90u8, 60, 90][..], &[0xF8][..], &[0x80, 60][..]]
        );
        // Data bytes before any status byte are a message of their own.
        assert_eq!(
            split_messages(&[1, 2, 0x90, 3]),
            [&[1u8, 2][..], &[0x90, 3][..]]
        );
        assert!(split_messages(&[]).is_empty());
    }
}
