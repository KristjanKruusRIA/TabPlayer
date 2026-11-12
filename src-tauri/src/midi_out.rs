//! External MIDI output, control side: the ports, the opener and sender threads, the routing and the commands.
//!
//! A track whose mix names a system MIDI port plays there instead of through the internal sound (see
//! `audio::midi_out` for what the audio thread does). This module owns everything that may block:
//!
//! - listing ports (`midir`), on the command's own blocking thread;
//! - opening ports, on a helper thread of their own, so a slow driver never delays a message to a port that is open;
//! - the sender thread, which reads the audio thread's ring, waits until each message is due and writes it;
//! - turning a document's mixes into routes: which port, which channels, what falls back;
//! - the status the interface shows.
//!
//! Routing is not a separate command. It is the `midiPort` of a track's `ChannelMix`, so it is saved with the score,
//! undone with the mix, and reaches the audio thread with every `audio_prepare` and `audio_set_mix`.
use crate::{
    audio::{
        midi_out::{
            LATE_MS, MAX_DELAY_MS, MAX_SLOTS, MidiOutShared, MidiRecord, MidiTap,
            PERCUSSION_CHANNEL, RouteSpec, Scheduler,
        },
        plan::PlaybackPlan,
    },
    runtime::NativeAudio,
    settings::DocumentSettings,
    workspace::{AudioOwner, DocumentWorkspace},
};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

/// How long a port may take to open before it counts as failed.
const OPEN_TIMEOUT: Duration = Duration::from_secs(3);
/// How long closing the threads takes at most.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1500);
/// The least time between two attempts to open one port.
const RETRY_INTERVAL: Duration = Duration::from_secs(2);
/// The sender sleeps while the next message is further off than this, and spins nearer.
const SPIN_NS: u64 = 1_500_000;
/// The longest the sender sleeps without looking at its control messages.
const SLEEP_SLICE: Duration = Duration::from_millis(10);
/// How long the sender keeps looking for new records after the last activity, and how often it looks when idle.
const HOT_NS: u64 = 1_000_000_000;
const COLD_POLL: Duration = Duration::from_millis(50);
#[cfg(any(test, feature = "desktop-test"))]
pub const TEST_PORT_NAME: &str = "Test MIDI output";
#[cfg(any(test, feature = "desktop-test"))]
const TEST_LOG_CAPACITY: usize = 20_000;

/// A port the system offers.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidiPortInfo {
    /// Stable for the session. The name, not the id, is what a score stores.
    pub id: String,
    pub name: String,
}

/// One port in use by the open document.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MidiPortStatus {
    pub name: String,
    pub open: bool,
    pub error: Option<String>,
    /// The identities of the tracks sent to this port that are playing there (or would, if it worked).
    pub tracks: Vec<String>,
    /// Tracks that asked for this port but found no free channels and play on the internal sound.
    pub overflow_tracks: Vec<String>,
    /// Percussion tracks on this port when there are several: they all play on channel 10, so one drum kit serves them.
    pub shared_percussion: Vec<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MidiOutStatus {
    pub ports: Vec<MidiPortStatus>,
    /// Messages written to a port.
    pub sent: u64,
    /// Messages not delivered: the queue was full, or the port had failed.
    pub dropped: u64,
    /// Messages written more than 5 ms after they were due.
    pub late: u64,
    /// The worst lateness in milliseconds.
    pub max_late_ms: f64,
}

/// Where a port's messages are written.
pub trait MidiSink: Send {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String>;
}
/// The system's MIDI ports.
pub trait MidiBackend: Send + Sync + 'static {
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String>;
    /// Opens the first port called `name`.
    fn open(&self, name: &str) -> Result<Box<dyn MidiSink>, String>;
}

struct MidirSink(midir::MidiOutputConnection);
impl MidiSink for MidirSink {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.send(bytes).map_err(|e| e.to_string())
    }
}
/// The operating system's MIDI ports through `midir`.
#[derive(Default)]
pub struct SystemMidi {
    /// Also lists and opens the recording port the desktop tests use.
    #[cfg(any(test, feature = "desktop-test"))]
    pub test_port: bool,
}
impl SystemMidi {
    /// The system's ports, plus the test port when the desktop test build is run with `TABPLAYER_MIDI_OUT_TEST=1`.
    pub fn from_environment() -> Self {
        Self {
            #[cfg(any(test, feature = "desktop-test"))]
            test_port: std::env::var("TABPLAYER_MIDI_OUT_TEST").is_ok_and(|v| v == "1"),
        }
    }
    fn output() -> Result<midir::MidiOutput, String> {
        midir::MidiOutput::new("TabPlayer").map_err(|e| e.to_string())
    }
}
impl MidiBackend for SystemMidi {
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        let mut found = Vec::new();
        // A system with no MIDI support at all lists nothing rather than failing the interface.
        if let Ok(output) = Self::output() {
            for port in output.ports() {
                if let Ok(name) = output.port_name(&port) {
                    found.push(MidiPortInfo {
                        id: port.id(),
                        name,
                    });
                }
            }
        }
        #[cfg(any(test, feature = "desktop-test"))]
        if self.test_port {
            found.push(MidiPortInfo {
                id: "test:Test MIDI output".into(),
                name: TEST_PORT_NAME.into(),
            });
        }
        Ok(found)
    }
    fn open(&self, name: &str) -> Result<Box<dyn MidiSink>, String> {
        #[cfg(any(test, feature = "desktop-test"))]
        if self.test_port && name == TEST_PORT_NAME {
            return Ok(Box::new(TestSink));
        }
        let output = Self::output()?;
        let port = output
            .ports()
            .into_iter()
            .find(|port| output.port_name(port).is_ok_and(|n| n == name))
            .ok_or_else(|| format!("The MIDI output \"{name}\" is not available."))?;
        output
            .connect(&port, "TabPlayer output")
            .map(|connection| Box::new(MidirSink(connection)) as Box<dyn MidiSink>)
            .map_err(|e| e.to_string())
    }
}

/// One message a test port received.
#[cfg(any(test, feature = "desktop-test"))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestLogEntry {
    /// Milliseconds since the first message since the log was last taken.
    pub ms: f64,
    /// The same moment on the wall clock (milliseconds since 1970), to line up with a page's `Date.now()`.
    pub unix_ms: f64,
    pub bytes: Vec<u8>,
}
#[cfg(any(test, feature = "desktop-test"))]
#[derive(Default)]
struct TestLog {
    first: Option<Instant>,
    entries: Vec<TestLogEntry>,
}
#[cfg(any(test, feature = "desktop-test"))]
static TEST_LOG: Mutex<TestLog> = Mutex::new(TestLog {
    first: None,
    entries: Vec::new(),
});
#[cfg(any(test, feature = "desktop-test"))]
struct TestSink;
#[cfg(any(test, feature = "desktop-test"))]
impl MidiSink for TestSink {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        let mut log = lock(&TEST_LOG);
        let now = Instant::now();
        let first = *log.first.get_or_insert(now);
        if log.entries.len() < TEST_LOG_CAPACITY {
            let unix_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            log.entries.push(TestLogEntry {
                ms: now.duration_since(first).as_secs_f64() * 1000.0,
                unix_ms,
                bytes: bytes.to_vec(),
            });
        }
        Ok(())
    }
}
/// Returns what the test port has received since the last call, and starts a new log.
#[cfg(any(test, feature = "desktop-test"))]
pub fn take_test_log() -> Vec<TestLogEntry> {
    let mut log = lock(&TEST_LOG);
    log.first = None;
    std::mem::take(&mut log.entries)
}

/// Ports that exist while their name is in the list, which they can be added to and removed from. For tests of the
/// service that sit above the backend.
#[cfg(test)]
pub(crate) struct ListedPorts(pub Mutex<Vec<String>>);
#[cfg(test)]
struct NullSink;
#[cfg(test)]
impl MidiSink for NullSink {
    fn send(&mut self, _: &[u8]) -> Result<(), String> {
        Ok(())
    }
}
#[cfg(test)]
impl MidiBackend for ListedPorts {
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        Ok(lock(&self.0)
            .iter()
            .map(|name| MidiPortInfo {
                id: name.clone(),
                name: name.clone(),
            })
            .collect())
    }
    fn open(&self, name: &str) -> Result<Box<dyn MidiSink>, String> {
        if lock(&self.0).iter().any(|n| n == name) {
            Ok(Box::new(NullSink))
        } else {
            Err(format!("The MIDI output \"{name}\" is not available."))
        }
    }
}

/// Ports where "Hang" never finishes opening and every other name opens at once.
#[cfg(test)]
pub(crate) struct HangingPorts;
#[cfg(test)]
impl MidiBackend for HangingPorts {
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        Ok(Vec::new())
    }
    fn open(&self, name: &str) -> Result<Box<dyn MidiSink>, String> {
        if name == "Hang" {
            thread::sleep(Duration::from_secs(600));
        }
        Ok(Box::new(NullSink))
    }
}
/// Ports that record every message they are sent, for tests of the service that sit above the backend.
#[cfg(test)]
pub(crate) struct RecordingPorts {
    pub names: Vec<String>,
    pub log: Arc<Mutex<Vec<Vec<u8>>>>,
}
#[cfg(test)]
struct RecordingSink(Arc<Mutex<Vec<Vec<u8>>>>);
#[cfg(test)]
impl MidiSink for RecordingSink {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        lock(&self.0).push(bytes.to_vec());
        Ok(())
    }
}
#[cfg(test)]
impl MidiBackend for RecordingPorts {
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        Ok(self
            .names
            .iter()
            .map(|name| MidiPortInfo {
                id: name.clone(),
                name: name.clone(),
            })
            .collect())
    }
    fn open(&self, name: &str) -> Result<Box<dyn MidiSink>, String> {
        if self.names.iter().any(|n| n == name) {
            Ok(Box::new(RecordingSink(self.log.clone())))
        } else {
            Err(format!("The MIDI output \"{name}\" is not available."))
        }
    }
}
/// The `(channel, key)` notes a port would still be sounding after `log`: a note-on sounds, a note-off or an all notes
/// off ends it.
#[cfg(test)]
pub(crate) fn sounding(log: &[Vec<u8>]) -> Vec<(u8, u8)> {
    let mut held = BTreeSet::new();
    for bytes in log {
        let (status, channel) = (bytes[0] & 0xf0, bytes[0] & 15);
        match status {
            0x90 if bytes[2] > 0 => {
                held.insert((channel, bytes[1]));
            }
            0x80 | 0x90 => {
                held.remove(&(channel, bytes[1]));
            }
            0xb0 if bytes[1] == 123 || bytes[1] == 120 => held.retain(|(c, _)| *c != channel),
            _ => {}
        }
    }
    held.into_iter().collect()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the control side knows of one port slot. A slot is a port name's number for the session; one that nothing uses
/// is handed to the next name that needs a slot, with a new `generation`.
struct PortSlot {
    name: String,
    generation: u32,
    open: bool,
    error: Option<String>,
    /// An attempt to open it has been made since it was given its name.
    attempted: bool,
    last_attempt: Option<Instant>,
    /// Changes whenever the port is asked to open or close, so an open that finishes late can tell it is not wanted.
    token: u64,
    /// An open is running on a thread of its own: its token, and since when. Cleared by the open itself when it ends,
    /// however late, so a driver call that never returns is never joined by a second one.
    opening: Option<(u64, Instant)>,
}
type Ports = Arc<Mutex<Vec<PortSlot>>>;

/// Marks slot `index` open or not, in the list and in the bit the audio thread reads. The one place either changes.
fn set_open(
    shared: &MidiOutShared,
    ports: &mut [PortSlot],
    index: usize,
    open: bool,
    error: Option<String>,
) {
    let bit = 1u32 << index;
    ports[index].open = open;
    ports[index].error = error;
    if open {
        shared.faulted.fetch_and(!bit, Ordering::AcqRel);
    } else {
        shared.faulted.fetch_or(bit, Ordering::AcqRel);
    }
}

enum Message {
    /// A port opened: its connection, for the slot that asked for it. The sender silences it before using it.
    Install {
        slot: u8,
        sink: Box<dyn MidiSink>,
    },
    Close {
        slot: u8,
    },
    /// Something is about to play: look for new records at once.
    Wake,
    Shutdown,
}
struct Threads {
    sender: mpsc::Sender<Message>,
    sender_handle: JoinHandle<()>,
}

/// The ports one document's routing uses, and which tracks play on each.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PortUse {
    pub name: String,
    pub tracks: Vec<String>,
    pub overflow: Vec<String>,
    pub shared_percussion: Vec<String>,
    pub error: Option<String>,
}

/// How the tracks asking for one port share its channels.
#[derive(Debug, PartialEq, Eq)]
pub struct Allocation {
    /// Each track's `(plan channel, port channel)` pairs, for the tracks that got channels.
    pub channels: Vec<(usize, Vec<(u8, u8)>)>,
    /// The tracks left over: their channels did not fit in the fifteen the port has.
    pub overflow: Vec<usize>,
}
/// What a track asks of a port: its plan channels in use (a bit each), and whether it is percussion.
pub struct Want {
    pub track: usize,
    pub percussion: bool,
    pub plan_channels: u16,
    /// A melodic track whose plan channel 9 holds only golpe knocks (left out of `plan_channels`): they play on the
    /// percussion channel the drum tracks share, and take none of the fifteen melodic ones.
    pub knock: bool,
}
/// The plan channel a melodic track's golpe knocks are on: General MIDI's percussion channel.
pub const KNOCK_PLAN_CHANNEL: u8 = 9;
/// Percussion goes to channel 10 (9, counting from zero), which every percussion track shares; the other fifteen are
/// taken one for each `(track, plan channel)` pair a melodic track uses. A melodic track's golpe knocks (`knock`) go
/// to channel 10 too and take none of the fifteen. A pair keeps the channel it had (`kept`) so
/// that adding or taking away a route never moves another track's notes; the others take the lowest free channel. A
/// melodic track whose pairs do not all fit is left out whole.
pub fn allocate_channels(wants: &[Want], kept: &dyn Fn(usize, u8) -> Option<u8>) -> Allocation {
    let mut used = [false; 16];
    used[usize::from(PERCUSSION_CHANNEL)] = true;
    // A track that has no events at all still gets its first plan channel, so it is routed (and silent here) as asked.
    let pairs = |want: &Want| -> Vec<u8> {
        let found: Vec<u8> = (0..16u8)
            .filter(|c| want.plan_channels & (1 << c) != 0)
            .collect();
        if found.is_empty() { vec![0] } else { found }
    };
    let mut keep: HashMap<(usize, u8), u8> = HashMap::new();
    for want in wants.iter().filter(|w| !w.percussion) {
        for plan in pairs(want) {
            if let Some(chan) = kept(want.track, plan) {
                if chan < 16 && !used[usize::from(chan)] {
                    used[usize::from(chan)] = true;
                    keep.insert((want.track, plan), chan);
                }
            }
        }
    }
    let mut channels = Vec::new();
    let mut overflow = Vec::new();
    for want in wants {
        let plans = pairs(want);
        if want.percussion {
            channels.push((
                want.track,
                plans.iter().map(|&p| (p, PERCUSSION_CHANNEL)).collect(),
            ));
            continue;
        }
        let mut assigned = Vec::new();
        let mut taken = Vec::new();
        let mut fits = true;
        for &plan in &plans {
            if let Some(&chan) = keep.get(&(want.track, plan)) {
                assigned.push((plan, chan));
            } else if let Some(chan) = (0..16u8).find(|&c| !used[usize::from(c)]) {
                used[usize::from(chan)] = true;
                taken.push(chan);
                assigned.push((plan, chan));
            } else {
                fits = false;
                break;
            }
        }
        if fits {
            if want.knock {
                assigned.push((KNOCK_PLAN_CHANNEL, PERCUSSION_CHANNEL));
            }
            channels.push((want.track, assigned));
        } else {
            for chan in taken {
                used[usize::from(chan)] = false;
            }
            for &plan in &plans {
                if let Some(&chan) = keep.get(&(want.track, plan)) {
                    used[usize::from(chan)] = false;
                }
            }
            overflow.push(want.track);
        }
    }
    Allocation { channels, overflow }
}

type Assignments = HashMap<(String, String, u8), u8>;
struct Committed {
    summary: Vec<PortUse>,
    assignments: Assignments,
}
/// A routing built but not yet in force: the tap for the audio thread, and what to remember once it is accepted.
pub struct PendingRoute {
    /// The routing for the renderer, or None when nothing is routed and nothing was before.
    pub tap: Option<Box<MidiTap>>,
    summary: Vec<PortUse>,
    assignments: Assignments,
    routed: bool,
}

/// Why ports are being asked to open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ensure {
    /// A score is being prepared.
    Prepare,
    /// The interface asked for the port list again.
    Refresh,
    /// A mix changed. A port that is not working is tried again only if this is its first try or the set of ports in
    /// use has changed, never for a fader.
    Mix,
}

/// External MIDI output for the session.
pub struct MidiOut {
    shared: Arc<MidiOutShared>,
    backend: Arc<dyn MidiBackend>,
    ports: Ports,
    threads: Mutex<Option<Threads>>,
    committed: Mutex<Committed>,
    last_names: Mutex<BTreeSet<String>>,
    channel_cache: Mutex<Option<(u64, usize, Arc<Vec<(u16, bool)>>)>>,
    /// Whether the renderer in use has any track routed, so removing the last route still reaches it.
    routed: AtomicBool,
    retry_interval: Duration,
    open_timeout: Duration,
}
impl Default for MidiOut {
    fn default() -> Self {
        Self::with_backend(Arc::new(SystemMidi::from_environment()))
    }
}
impl MidiOut {
    pub fn with_backend(backend: Arc<dyn MidiBackend>) -> Self {
        Self {
            shared: MidiOutShared::new(),
            backend,
            ports: Arc::new(Mutex::new(Vec::new())),
            threads: Mutex::new(None),
            committed: Mutex::new(Committed {
                summary: Vec::new(),
                assignments: HashMap::new(),
            }),
            last_names: Mutex::new(BTreeSet::new()),
            channel_cache: Mutex::new(None),
            routed: AtomicBool::new(false),
            retry_interval: RETRY_INTERVAL,
            open_timeout: OPEN_TIMEOUT,
        }
    }
    /// The same with another least time between attempts to open one port.
    pub fn with_retry_interval(mut self, interval: Duration) -> Self {
        self.retry_interval = interval;
        self
    }
    /// The same with another longest wait for a port to open.
    pub fn with_open_timeout(mut self, timeout: Duration) -> Self {
        self.open_timeout = timeout;
        self
    }
    /// What every output stream shares with the sender.
    pub fn shared(&self) -> Arc<MidiOutShared> {
        self.shared.clone()
    }
    pub fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        self.backend.ports()
    }
    pub fn routed(&self) -> bool {
        self.routed.load(Ordering::Acquire)
    }
    /// Whether any of the ports `names` is not open and working.
    pub fn any_unavailable(&self, names: &BTreeSet<String>) -> bool {
        let ports = lock(&self.ports);
        names
            .iter()
            .any(|name| !ports.iter().any(|p| &p.name == name && p.open))
    }
    pub fn set_delay(&self, ms: u32) -> Result<(), String> {
        if ms > MAX_DELAY_MS {
            return Err(format!("The MIDI delay is 0 to {MAX_DELAY_MS} ms."));
        }
        self.shared.delay_ms.store(ms, Ordering::Relaxed);
        Ok(())
    }
    pub fn delay(&self) -> u32 {
        self.shared.delay_ms.load(Ordering::Relaxed)
    }
    /// The sender's channel, starting its thread if it is not running. A sender that died took its connections with it,
    /// so every port is marked not open and free to be tried again.
    fn start(&self) -> Result<mpsc::Sender<Message>, String> {
        let mut guard = lock(&self.threads);
        if let Some(threads) = guard.as_ref() {
            if !threads.sender_handle.is_finished() {
                return Ok(threads.sender.clone());
            }
        }
        if let Some(old) = guard.take() {
            let _ = old.sender.send(Message::Shutdown);
            let mut ports = lock(&self.ports);
            for index in 0..ports.len() {
                ports[index].last_attempt = None;
                ports[index].token += 1;
                set_open(&self.shared, &mut ports, index, false, None);
            }
        }
        let (tx, rx) = mpsc::channel();
        let engine = Engine::new(self.shared.clone(), self.ports.clone()).with_inbox(rx);
        let handle = thread::Builder::new()
            .name("midi-out-sender".into())
            .spawn(move || run_sender(engine))
            .map_err(|e| e.to_string())?;
        *guard = Some(Threads {
            sender: tx.clone(),
            sender_handle: handle,
        });
        Ok(tx)
    }
    /// Gives `name` a slot, reusing one that holds no open port and is not in `protected`, else a fresh one. A new
    /// or reused slot starts not working. None when all of them are in use.
    fn slot_for(
        &self,
        ports: &mut Vec<PortSlot>,
        name: &str,
        protected: &HashSet<String>,
    ) -> Option<usize> {
        if let Some(index) = ports.iter().position(|p| p.name == name) {
            return Some(index);
        }
        let fresh = |name: &str, generation: u32| PortSlot {
            name: name.to_string(),
            generation,
            open: false,
            error: None,
            attempted: false,
            last_attempt: None,
            token: 0,
            opening: None,
        };
        let index = match ports
            .iter()
            .position(|p| !p.open && p.opening.is_none() && !protected.contains(&p.name))
        {
            Some(index) => {
                let generation = ports[index].generation + 1;
                let token = ports[index].token + 1;
                ports[index] = fresh(name, generation);
                ports[index].token = token;
                index
            }
            None if ports.len() < MAX_SLOTS => {
                ports.push(fresh(name, 1));
                ports.len() - 1
            }
            None => return None,
        };
        self.shared.faulted.fetch_or(1 << index, Ordering::AcqRel);
        self.shared.slot_generation[index].store(ports[index].generation, Ordering::Release);
        Some(index)
    }
    /// A sender that died (a panic in a driver call, say) took its connections with it, whatever the list says: every
    /// port is marked not open and free to be tried again.
    fn revive_if_dead(&self) {
        let mut guard = lock(&self.threads);
        if guard
            .as_ref()
            .is_some_and(|t| t.sender_handle.is_finished())
        {
            *guard = None;
            let mut ports = lock(&self.ports);
            for index in 0..ports.len() {
                // An open that is still running stays recorded as running: it is not joined by a second one.
                ports[index].last_attempt = None;
                ports[index].token += 1;
                set_open(&self.shared, &mut ports, index, false, None);
            }
        }
    }
    /// Marks as failed the opens that have run longer than the timeout. They stay recorded as running, so no second
    /// open of that port is started behind them, but whatever connection they finally return is dropped.
    fn reap(&self) {
        self.revive_if_dead();
        let mut ports = lock(&self.ports);
        let now = Instant::now();
        for index in 0..ports.len() {
            let overdue = ports[index]
                .opening
                .is_some_and(|(_, since)| now.duration_since(since) >= self.open_timeout);
            if overdue && !ports[index].open && ports[index].error.is_none() {
                ports[index].token += 1;
                set_open(
                    &self.shared,
                    &mut ports,
                    index,
                    false,
                    Some("The MIDI port did not open in time.".into()),
                );
            }
        }
    }
    /// Starts opening the ports `names` that are not working, and closes the ones nothing uses any more, and returns
    /// at once: an open runs on a thread of its own, and the tracks move to the port by themselves when it is
    /// done (the audio thread reads the port's bit each block), so nothing here waits for a driver or holds a lock
    /// across it. A port that will not open is recorded as failed and its tracks play on the internal sound. A port
    /// that is not working is tried again only as `reason` allows, and at most once per interval.
    pub fn ensure_ports(&self, names: &BTreeSet<String>, reason: Ensure) {
        self.reap();
        let changed = {
            let mut last = lock(&self.last_names);
            let changed = *last != *names;
            *last = names.clone();
            changed
        };
        let mut protected: HashSet<String> = names.iter().cloned().collect();
        protected.extend(lock(&self.committed).summary.iter().map(|u| u.name.clone()));
        let mut jobs = Vec::new();
        let mut closes = Vec::new();
        {
            let mut ports = lock(&self.ports);
            let now = Instant::now();
            for name in names {
                let Some(index) = self.slot_for(&mut ports, name, &protected) else {
                    continue;
                };
                let slot = &mut ports[index];
                if slot.open || slot.opening.is_some() {
                    continue;
                }
                let allowed = match reason {
                    Ensure::Prepare | Ensure::Refresh => true,
                    Ensure::Mix => !slot.attempted || changed,
                };
                let spaced = slot
                    .last_attempt
                    .is_none_or(|t| now.duration_since(t) >= self.retry_interval);
                if allowed && spaced {
                    slot.token += 1;
                    slot.attempted = true;
                    slot.last_attempt = Some(now);
                    slot.opening = Some((slot.token, now));
                    // The failure of an earlier try is not this one's; a try that hangs gets its own.
                    slot.error = None;
                    jobs.push((index as u8, name.clone(), slot.token));
                }
            }
            for index in 0..ports.len() {
                if ports[index].open && !names.contains(&ports[index].name) {
                    ports[index].token += 1;
                    // Closed on purpose: coming back to it at once is not a retry of a failure.
                    ports[index].last_attempt = None;
                    ports[index].attempted = false;
                    set_open(&self.shared, &mut ports, index, false, None);
                    closes.push(index as u8);
                }
            }
        }
        if jobs.is_empty() && closes.is_empty() {
            return;
        }
        let Ok(sender) = self.start() else {
            let mut ports = lock(&self.ports);
            for (slot, _, _) in jobs {
                ports[usize::from(slot)].opening = None;
            }
            return;
        };
        for slot in closes {
            let _ = sender.send(Message::Close { slot });
        }
        for (slot, name, token) in jobs {
            let (shared, ports, backend, install) = (
                self.shared.clone(),
                self.ports.clone(),
                self.backend.clone(),
                sender.clone(),
            );
            let spawned = thread::Builder::new()
                .name("midi-out-open".into())
                .spawn(move || open_job(slot, name, token, shared, ports, backend, install));
            if spawned.is_err() {
                lock(&self.ports)[usize::from(slot)].opening = None;
            }
        }
    }
    /// Waits until no port is being opened (tests; real callers never wait).
    #[cfg(test)]
    pub(crate) fn settle(&self) {
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until && lock(&self.ports).iter().any(|p| p.opening.is_some()) {
            thread::sleep(Duration::from_millis(2));
        }
    }
    /// Asks the sender to discard what is queued and silence every open port: the stream that fed them is gone,
    /// frozen or failed. The audio thread of a new stream states its position again when the sender has finished.
    pub fn reset(&self) {
        self.shared.request_reset();
        self.wake();
    }
    /// Something is about to play: the sender looks for new records at once instead of at its idle pace.
    pub fn wake(&self) {
        if let Some(threads) = lock(&self.threads).as_ref() {
            let _ = threads.sender.send(Message::Wake);
        }
    }
    /// Silences and closes every port and ends the threads. Safe to call twice.
    pub fn shutdown(&self) {
        let Some(threads) = lock(&self.threads).take() else {
            return;
        };
        let _ = threads.sender.send(Message::Shutdown);
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        while !threads.sender_handle.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        if threads.sender_handle.is_finished() {
            let _ = threads.sender_handle.join();
        }
    }
    /// The ports `settings` sends tracks to, whether or not they exist.
    pub fn port_names(settings: &DocumentSettings) -> BTreeSet<String> {
        settings
            .mixes
            .values()
            .filter_map(|mix| mix.midi_port.clone())
            .collect()
    }
    /// The plan channels each track uses, found once for a plan and kept, and whether a melodic track's plan channel 9
    /// holds only golpe knocks: hits that no plan note of that track owns. A knock is not a channel of its own, so it is
    /// left out of the channels; a melodic track that has notes on channel 9 keeps it as one.
    fn plan_channels(&self, plan: &PlaybackPlan) -> Arc<Vec<(u16, bool)>> {
        let mut cache = lock(&self.channel_cache);
        if let Some((generation, events, found)) = cache.as_ref() {
            if *generation == plan.generation
                && *events == plan.midi.len()
                && found.len() == plan.tracks.len()
            {
                return found.clone();
            }
        }
        let index: HashMap<&str, usize> = plan
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id.as_str(), i))
            .collect();
        let mut masks = vec![0u16; plan.tracks.len()];
        for event in &plan.midi {
            if let Some(&track) = index.get(event.track_id()) {
                masks[track] |= 1 << (event.channel() & 15);
            }
        }
        let mut owned = vec![false; plan.tracks.len()];
        for note in plan
            .notes
            .iter()
            .filter(|n| n.channel == Some(KNOCK_PLAN_CHANNEL))
        {
            if let Some(&track) = index.get(note.track_id.as_str()) {
                owned[track] = true;
            }
        }
        let found: Arc<Vec<(u16, bool)>> = Arc::new(
            masks
                .into_iter()
                .zip(owned)
                .zip(&plan.tracks)
                .map(|((mask, owned), track)| {
                    let knock =
                        !track.percussion && !owned && mask & (1 << KNOCK_PLAN_CHANNEL) != 0;
                    (
                        if knock {
                            mask & !(1 << KNOCK_PLAN_CHANNEL)
                        } else {
                            mask
                        },
                        knock,
                    )
                })
                .collect(),
        );
        *cache = Some((plan.generation, plan.midi.len(), found.clone()));
        found
    }
    /// Routes `settings`' tracks to their ports for `plan`. A track whose port is not working, or whose channels do
    /// not fit, is not routed. Nothing is remembered until `commit` says the routing took effect.
    pub fn build_route(
        &self,
        plan: &PlaybackPlan,
        settings: &DocumentSettings,
        replacing: bool,
    ) -> PendingRoute {
        let any_solo = plan
            .tracks
            .iter()
            .any(|t| settings.mixes.get(&t.id).is_some_and(|m| m.solo))
            || settings.backing.as_ref().is_some_and(|b| b.mix.solo);
        let used = self.plan_channels(plan);
        let mut order: Vec<(String, Vec<Want>)> = Vec::new();
        for (index, track) in plan.tracks.iter().enumerate() {
            let Some(name) = settings
                .mixes
                .get(&track.id)
                .and_then(|m| m.midi_port.as_ref())
            else {
                continue;
            };
            let want = Want {
                track: index,
                percussion: track.percussion,
                plan_channels: used[index].0,
                knock: used[index].1,
            };
            match order.iter_mut().find(|(port, _)| port == name) {
                Some((_, wants)) => wants.push(want),
                None => order.push((name.clone(), vec![want])),
            }
        }
        // Channels stay where they were whatever the plan, as long as the port, the track and the plan channel are
        // the same: a rebuilt plan after an edit does not re-pack the tracks.
        let previous = Some(lock(&self.committed).assignments.clone());
        let mut routes = Vec::new();
        let mut summary = Vec::new();
        let mut remembered = HashMap::new();
        for (name, wants) in &order {
            let kept = |track: usize, plan_channel: u8| -> Option<u8> {
                previous
                    .as_ref()?
                    .get(&(name.clone(), plan.tracks[track].id.clone(), plan_channel))
                    .copied()
            };
            let allocation = allocate_channels(wants, &kept);
            let (slot, port_gen, error) = {
                let ports = lock(&self.ports);
                match ports.iter().position(|p| &p.name == name) {
                    None => (
                        None,
                        0,
                        Some("Too many MIDI outputs are in use at once.".to_string()),
                    ),
                    Some(index) => {
                        let port = &ports[index];
                        let error = (!port.open).then(|| {
                            port.error.clone().unwrap_or_else(|| {
                                format!("The MIDI output \"{name}\" is not available.")
                            })
                        });
                        (Some(index as u8), port.generation, error)
                    }
                }
            };
            for (track, pairs) in &allocation.channels {
                let id = &plan.tracks[*track].id;
                if !plan.tracks[*track].percussion {
                    let knock = wants.iter().any(|w| w.track == *track && w.knock);
                    for &(plan_channel, chan) in pairs {
                        if knock && plan_channel == KNOCK_PLAN_CHANNEL && chan == PERCUSSION_CHANNEL
                        {
                            continue;
                        }
                        remembered.insert((name.clone(), id.clone(), plan_channel), chan);
                    }
                }
                // The tap follows the slot's bit: a track on a port that is not open yet plays on the internal sound
                // until it is, with no new routing needed.
                if let Some(slot) = slot {
                    let mix = settings.mixes.get(id).cloned().unwrap_or_default();
                    let mut spec = RouteSpec::lanes(slot, port_gen, pairs);
                    spec.knock = wants.iter().any(|w| w.track == *track && w.knock);
                    spec.audible = !mix.mute && (!any_solo || mix.solo);
                    spec.gain = mix.gain;
                    spec.pan = mix.pan;
                    routes.push((*track, spec));
                }
            }
            let percussion: Vec<String> = allocation
                .channels
                .iter()
                .filter(|(track, _)| plan.tracks[*track].percussion)
                .map(|(track, _)| plan.tracks[*track].id.clone())
                .collect();
            summary.push(PortUse {
                name: name.clone(),
                tracks: allocation
                    .channels
                    .iter()
                    .map(|(track, _)| plan.tracks[*track].id.clone())
                    .collect(),
                overflow: allocation
                    .overflow
                    .iter()
                    .map(|&track| plan.tracks[track].id.clone())
                    .collect(),
                shared_percussion: if percussion.len() > 1 {
                    percussion
                } else {
                    Vec::new()
                },
                error,
            });
        }
        let routed = !routes.is_empty();
        let tap = (routed || replacing).then(|| {
            let programs: Vec<u8> = plan.tracks.iter().map(|t| t.program).collect();
            let mut tap = MidiTap::new(&programs, &routes);
            tap.set_fault_mask(self.shared.faulted.load(Ordering::Acquire));
            tap
        });
        PendingRoute {
            tap,
            summary,
            assignments: remembered,
            routed,
        }
    }
    /// Records a routing as in force, once the audio side has accepted it.
    pub fn commit(&self, pending: PendingRoute) {
        let mut committed = lock(&self.committed);
        committed.summary = pending.summary;
        committed.assignments = pending.assignments;
        self.routed.store(pending.routed, Ordering::Release);
    }
    pub fn status(&self) -> MidiOutStatus {
        self.reap();
        let summary = lock(&self.committed).summary.clone();
        let ports = lock(&self.ports);
        MidiOutStatus {
            ports: summary
                .into_iter()
                .map(|used| {
                    let slot = ports.iter().find(|p| p.name == used.name);
                    let open = slot.is_some_and(|p| p.open);
                    let error = if open {
                        None
                    } else {
                        slot.and_then(|p| p.error.clone()).or(used.error)
                    };
                    MidiPortStatus {
                        name: used.name,
                        open,
                        error,
                        tracks: used.tracks,
                        overflow_tracks: used.overflow,
                        shared_percussion: used.shared_percussion,
                    }
                })
                .collect(),
            sent: self.shared.sent.load(Ordering::Relaxed),
            dropped: self.shared.dropped.load(Ordering::Relaxed),
            late: self.shared.late.load(Ordering::Relaxed),
            max_late_ms: self.shared.max_late_us.load(Ordering::Relaxed) as f64 / 1000.0,
        }
    }
}
impl Drop for MidiOut {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// One open, on a thread of its own so that a slow or stuck driver call delays nothing else.
fn open_job(
    slot: u8,
    name: String,
    token: u64,
    shared: Arc<MidiOutShared>,
    ports: Ports,
    backend: Arc<dyn MidiBackend>,
    install: mpsc::Sender<Message>,
) {
    let result = backend.open(&name);
    // A connection that is not used is dropped here, after the lock is released: closing a driver handle can take time.
    let unused = record_open(slot, &name, token, result, &shared, &ports, &install);
    drop(unused);
}
/// Records how an open ended and hands the connection to the sender. Returns the connection if nobody took it.
fn record_open(
    slot: u8,
    name: &str,
    token: u64,
    result: Result<Box<dyn MidiSink>, String>,
    shared: &MidiOutShared,
    ports: &Ports,
    install: &mpsc::Sender<Message>,
) -> Option<Box<dyn MidiSink>> {
    let mut list = lock(ports);
    let index = usize::from(slot);
    let Some(port) = list.get_mut(index) else {
        return result.ok();
    };
    if port.opening.is_some_and(|(job, _)| job == token) {
        port.opening = None;
    }
    if port.token != token || port.name != name {
        // Not wanted any more (closed, timed out, the slot given to another port).
        return result.ok();
    }
    match result {
        // Open means the sender holds the connection: the Install is queued before anything sees the port as open,
        // and if the sender has gone the port is not open.
        Ok(sink) => match install.send(Message::Install { slot, sink }) {
            Ok(()) => {
                set_open(shared, &mut list, index, true, None);
                None
            }
            Err(mpsc::SendError(message)) => {
                set_open(
                    shared,
                    &mut list,
                    index,
                    false,
                    Some("The MIDI sender stopped.".into()),
                );
                match message {
                    Message::Install { sink, .. } => Some(sink),
                    _ => None,
                }
            }
        },
        Err(error) => {
            set_open(shared, &mut list, index, false, Some(error));
            None
        }
    }
}

struct Pending {
    due: u64,
    slot: u8,
    len: u8,
    bytes: [u8; 3],
}
/// All notes off, all sound off, reset all controllers, sustain up and the wheel centred on every channel of a port:
/// the synthesizer is left silent, in tune and unpedalled.
fn silence(sink: &mut dyn MidiSink) -> Result<(), String> {
    for channel in 0..16u8 {
        sink.send(&[0xb0 | channel, 64, 0])?;
        sink.send(&[0xb0 | channel, 123, 0])?;
        sink.send(&[0xb0 | channel, 120, 0])?;
        sink.send(&[0xb0 | channel, 121, 0])?;
        sink.send(&[0xe0 | channel, 0, 64])?;
    }
    Ok(())
}
/// What the sender should do next.
#[derive(Debug, PartialEq, Eq)]
enum Poll {
    /// The next message is due in this many nanoseconds.
    Wait(u64),
    Idle,
}
/// The sender's work without its thread or its clock: the connections, the queue and the timing.
struct Engine {
    shared: Arc<MidiOutShared>,
    ports: Ports,
    sinks: Vec<Option<Box<dyn MidiSink>>>,
    scheduler: Scheduler,
    pending: Option<Pending>,
    handled_reset: u64,
    last_activity: Option<u64>,
    /// Where connections, closes, wakes and the end arrive. Drained before every record is taken, so a port that has
    /// been announced as open has its connection in place before anything is written to it.
    inbox: Option<mpsc::Receiver<Message>>,
    shutdown: bool,
}
impl Engine {
    fn new(shared: Arc<MidiOutShared>, ports: Ports) -> Self {
        let handled_reset = shared.reset_done.load(Ordering::Acquire);
        Self {
            shared,
            ports,
            sinks: (0..MAX_SLOTS).map(|_| None).collect(),
            scheduler: Scheduler::default(),
            pending: None,
            handled_reset,
            last_activity: None,
            inbox: None,
            shutdown: false,
        }
    }
    fn with_inbox(mut self, inbox: mpsc::Receiver<Message>) -> Self {
        self.inbox = Some(inbox);
        self
    }
    fn handle(&mut self, message: Message) {
        match message {
            Message::Install { slot, sink } => self.install(slot, sink),
            Message::Close { slot } => self.close(slot),
            Message::Wake => {
                let now = self.shared.now_ns();
                self.touch(now);
            }
            Message::Shutdown => self.shutdown = true,
        }
    }
    /// Takes in every control message that has arrived.
    fn drain(&mut self) {
        loop {
            let message = match self.inbox.as_ref().map(|inbox| inbox.try_recv()) {
                Some(Ok(message)) => message,
                Some(Err(mpsc::TryRecvError::Disconnected)) => {
                    self.shutdown = true;
                    return;
                }
                _ => return,
            };
            self.handle(message);
        }
    }
    /// Rests up to `pause` waiting for a control message.
    fn wait_for_message(&mut self, pause: Duration) {
        let message = match self.inbox.as_ref().map(|inbox| inbox.recv_timeout(pause)) {
            Some(Ok(message)) => message,
            Some(Err(mpsc::RecvTimeoutError::Disconnected)) => {
                self.shutdown = true;
                return;
            }
            _ => return,
        };
        self.handle(message);
    }
    fn install(&mut self, slot: u8, mut sink: Box<dyn MidiSink>) {
        // A connection that was made again may find a synthesizer still holding what an earlier one left (after a
        // failed send on CoreMIDI or ALSA, say): it is silenced before the position is stated to it.
        let _ = silence(sink.as_mut());
        self.sinks[usize::from(slot) % MAX_SLOTS] = Some(sink);
        // A port that has just opened is about to be played to (a route added during playback, with nothing routed
        // before and so a sender at its idle pace): look for its records at the quick pace from now.
        let now = self.shared.now_ns();
        self.touch(now);
    }
    /// Silences and drops the connection in `slot`; its queued messages are dropped.
    fn close(&mut self, slot: u8) {
        if let Some(mut sink) = self.sinks[usize::from(slot) % MAX_SLOTS].take() {
            let _ = silence(sink.as_mut());
        }
        if self.pending.as_ref().is_some_and(|p| p.slot == slot) {
            self.pending = None;
        }
    }
    fn touch(&mut self, now: u64) {
        self.last_activity = Some(now);
    }
    /// Whether records may arrive at any moment: the score is rendering, or something played or was about to a moment
    /// ago. Time with nothing to write does not make the sender less ready while the score plays: a rest, a whole
    /// note or half-speed practice leaves seconds between messages, and the next one is due a buffer after it is queued.
    fn hot(&self, now: u64) -> bool {
        self.shared.rendering.load(Ordering::Relaxed)
            || self
                .last_activity
                .is_some_and(|at| now.saturating_sub(at) < HOT_NS)
    }
    fn buffer_ns(&self) -> u64 {
        self.scheduler.buffer_ns()
    }
    /// Throws away what is queued, silences every connection and forgets the clock's anchor, then says so.
    fn reset(&mut self, requested: u64) {
        self.pending = None;
        self.shared.ring.discard();
        for sink in self.sinks.iter_mut().flatten() {
            let _ = silence(sink.as_mut());
        }
        self.scheduler = Scheduler::default();
        self.handled_reset = requested;
        self.shared.reset_done.store(requested, Ordering::Release);
    }
    fn fail(&mut self, slot: u8, error: String) {
        self.sinks[usize::from(slot) % MAX_SLOTS] = None;
        let mut ports = lock(&self.ports);
        if usize::from(slot) < ports.len() {
            set_open(
                &self.shared,
                &mut ports,
                usize::from(slot),
                false,
                Some(error),
            );
        }
    }
    /// Takes in what the audio thread has queued and writes every message that is due at `now` (nanoseconds on the
    /// session clock).
    fn poll(&mut self, now: u64) -> Poll {
        loop {
            self.drain();
            let requested = self.shared.reset_requested.load(Ordering::Acquire);
            if requested != self.handled_reset {
                self.reset(requested);
                self.touch(now);
            }
            if self.pending.is_none() {
                match self.shared.ring.pop() {
                    Some(MidiRecord::Anchor {
                        frame,
                        ns,
                        buffer_frames,
                        rate,
                    }) => {
                        // Anchors flow from every callback of a routed score, idle or not: they are not activity.
                        self.scheduler.anchor(frame, ns, buffer_frames, rate);
                        continue;
                    }
                    Some(MidiRecord::Message {
                        frame,
                        slot,
                        generation,
                        len,
                        bytes,
                    }) => {
                        // Queued for a port the slot has since been given up by: not this one's.
                        let current = self.shared.slot_generation[usize::from(slot) % MAX_SLOTS]
                            .load(Ordering::Acquire) as u16;
                        if current != generation {
                            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        let due = self.scheduler.due_ns(
                            frame,
                            self.shared.delay_ms.load(Ordering::Relaxed),
                            now,
                        );
                        self.pending = Some(Pending {
                            due,
                            slot,
                            len,
                            bytes,
                        });
                        self.touch(now);
                    }
                    None => return Poll::Idle,
                }
            }
            let Some(message) = self.pending.as_ref() else {
                continue;
            };
            if now < message.due {
                return Poll::Wait(message.due - now);
            }
            let Pending {
                due,
                slot,
                len,
                bytes,
            } = self.pending.take().unwrap();
            let late_ns = now - due;
            match self.sinks[usize::from(slot) % MAX_SLOTS].as_mut() {
                None => {
                    self.shared.dropped.fetch_add(1, Ordering::Relaxed);
                }
                Some(sink) => match sink.send(&bytes[..usize::from(len).min(3)]) {
                    Ok(()) => {
                        self.shared.sent.fetch_add(1, Ordering::Relaxed);
                        if late_ns > LATE_MS * 1_000_000 {
                            self.shared.late.fetch_add(1, Ordering::Relaxed);
                        }
                        self.shared
                            .max_late_us
                            .fetch_max(late_ns / 1000, Ordering::Relaxed);
                    }
                    Err(error) => {
                        self.fail(slot, error);
                        self.shared.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                },
            }
        }
    }
    /// Silences every connection and closes it.
    fn finish(&mut self) {
        for (slot, sink) in self.sinks.iter_mut().enumerate() {
            if let Some(mut sink) = sink.take() {
                let _ = silence(sink.as_mut());
            }
            let mut ports = lock(&self.ports);
            if slot < ports.len() {
                set_open(&self.shared, &mut ports, slot, false, None);
            }
        }
    }
}

/// How long the sender rests before it looks again. With a message pending it sleeps until about 1.5 ms before the
/// message is due (at most ten milliseconds, to hear its control messages) and then spins, because a sleep alone is
/// only as exact as the system timer. With nothing pending, a score that is rendering keeps it looking at a pace that
/// follows the audio buffer (1 to 4 ms, since a record is due a buffer after it is queued), and when nothing renders
/// it looks twenty times a second.
fn pause_for(poll: &Poll, hot: bool, buffer_ns: u64) -> Duration {
    match poll {
        Poll::Wait(ns) if *ns > SPIN_NS => Duration::from_nanos(ns - SPIN_NS).min(SLEEP_SLICE),
        Poll::Wait(_) => Duration::ZERO,
        Poll::Idle if hot => Duration::from_nanos((buffer_ns / 2).clamp(1_000_000, 4_000_000)),
        Poll::Idle => COLD_POLL,
    }
}
/// The sender thread: writes each message when it is due, resting as `pause_for` says.
fn run_sender(mut engine: Engine) {
    while !engine.shutdown {
        let now = engine.shared.now_ns();
        let poll = engine.poll(now);
        if engine.shutdown {
            break;
        }
        let hot = engine.hot(now);
        let pause = pause_for(&poll, hot, engine.buffer_ns());
        if pause.is_zero() {
            std::hint::spin_loop();
        } else if matches!(poll, Poll::Idle) && !hot {
            engine.wait_for_message(pause);
        } else {
            thread::sleep(pause);
        }
    }
    engine.finish();
}

fn midi(app: &AppHandle) -> Result<tauri::State<'_, NativeAudio>, String> {
    app.try_state::<NativeAudio>()
        .ok_or_else(|| "Native audio is not ready.".to_string())
}

/// The system's MIDI output ports. Given the owner of the open score, asking also tries again any port the score
/// sends tracks to that was not working, so a device plugged in since is picked up and its tracks move over to it.
#[tauri::command]
pub async fn midi_out_ports(
    owner: Option<AudioOwner>,
    app: AppHandle,
) -> Result<Vec<MidiPortInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let audio = midi(&app)?;
        if let Some(owner) = owner {
            audio.midi_refresh(&app.state::<Arc<Mutex<DocumentWorkspace>>>(), &owner)?;
        }
        audio.service.midi_out().ports()
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Sets the delay, in milliseconds (0 to 500), added to every message so a port's sound can line up with the internal
/// output. It is the interface's to remember; the native side keeps it for the session.
#[tauri::command]
pub fn midi_out_set_delay(app: AppHandle, ms: u32) -> Result<(), String> {
    midi(&app)?.service.midi_out().set_delay(ms)
}
#[tauri::command]
pub fn midi_out_status(app: AppHandle) -> Result<MidiOutStatus, String> {
    Ok(midi(&app)?.service.midi_out().status())
}
/// What the test port received since the last call (desktop test builds only).
#[cfg(feature = "desktop-test")]
#[tauri::command]
pub fn midi_out_test_log() -> Vec<TestLogEntry> {
    take_test_log()
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{
        device::{CallbackTransport, TransportCommand},
        midi_out::MidiOutPort,
        renderer::Renderer,
        resources::AudioResources,
    };
    use crate::settings::{ChannelMix, TrackSound};
    use std::sync::atomic::{AtomicU64, AtomicUsize};

    type Log = Arc<Mutex<Vec<(Instant, String, Vec<u8>)>>>;
    /// A backend whose ports log what they are sent, with switches for failing to send and for slow opens.
    struct Fake {
        names: Vec<String>,
        log: Log,
        fail_send: Arc<AtomicBool>,
        panic_send: Arc<AtomicBool>,
        opens: Arc<Mutex<Vec<String>>>,
        slow: HashMap<String, Duration>,
        closed: Arc<AtomicUsize>,
    }
    struct FakeSink {
        name: String,
        log: Log,
        fail: Arc<AtomicBool>,
        panic: Arc<AtomicBool>,
        closed: Arc<AtomicUsize>,
    }
    impl MidiSink for FakeSink {
        fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
            if self.panic.load(Ordering::Relaxed) {
                panic!("a driver fault (expected in this test)");
            }
            if self.fail.load(Ordering::Relaxed) {
                return Err("The device was unplugged.".into());
            }
            lock(&self.log).push((Instant::now(), self.name.clone(), bytes.to_vec()));
            Ok(())
        }
    }
    impl Drop for FakeSink {
        fn drop(&mut self) {
            self.closed.fetch_add(1, Ordering::Relaxed);
        }
    }
    impl MidiBackend for Fake {
        fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
            Ok(self
                .names
                .iter()
                .map(|name| MidiPortInfo {
                    id: format!("id-{name}"),
                    name: name.clone(),
                })
                .collect())
        }
        fn open(&self, name: &str) -> Result<Box<dyn MidiSink>, String> {
            lock(&self.opens).push(name.to_string());
            if let Some(delay) = self.slow.get(name) {
                thread::sleep(*delay);
            }
            if !self.names.iter().any(|n| n == name) {
                return Err(format!("The MIDI output \"{name}\" is not available."));
            }
            Ok(Box::new(FakeSink {
                name: name.to_string(),
                log: self.log.clone(),
                fail: self.fail_send.clone(),
                panic: self.panic_send.clone(),
                closed: self.closed.clone(),
            }))
        }
    }
    struct Rig {
        out: MidiOut,
        log: Log,
        fail_send: Arc<AtomicBool>,
        panic_send: Arc<AtomicBool>,
        opens: Arc<Mutex<Vec<String>>>,
        closed: Arc<AtomicUsize>,
    }
    fn rig_with(names: &[&str], slow: &[(&str, u64)]) -> Rig {
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let fail_send = Arc::new(AtomicBool::new(false));
        let panic_send = Arc::new(AtomicBool::new(false));
        let opens = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(AtomicUsize::new(0));
        let out = MidiOut::with_backend(Arc::new(Fake {
            names: names.iter().map(|n| n.to_string()).collect(),
            log: log.clone(),
            fail_send: fail_send.clone(),
            panic_send: panic_send.clone(),
            opens: opens.clone(),
            slow: slow
                .iter()
                .map(|(n, ms)| (n.to_string(), Duration::from_millis(*ms)))
                .collect(),
            closed: closed.clone(),
        }));
        Rig {
            out,
            log,
            fail_send,
            panic_send,
            opens,
            closed,
        }
    }
    fn rig(names: &[&str]) -> Rig {
        rig_with(names, &[])
    }
    fn names(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|n| n.to_string()).collect()
    }
    /// A plan of tracks `(id, percussion)` with a note on each `(track, plan channel)` pair given.
    fn plan_using(tracks: &[(&str, bool)], used: &[(&str, u8)]) -> PlaybackPlan {
        let midi: Vec<_> = used
            .iter()
            .map(|(track, channel)| {
                serde_json::json!({"type": "noteOn", "trackId": track, "tick": 0, "channel": channel, "key": 60, "velocity": 90})
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 3840, "durationMs": 4000,
            "tracks": tracks.iter().map(|(id, percussion)| serde_json::json!({"id": id, "program": 0, "percussion": percussion})).collect::<Vec<_>>(),
            "tempos": [{"tick": 0, "bpm": 60}], "occurrences": [], "notes": [], "midi": midi
        }))
        .unwrap()
    }
    fn plan(tracks: &[(&str, bool)]) -> PlaybackPlan {
        plan_using(tracks, &[])
    }
    fn settings(routes: &[(&str, &str)]) -> DocumentSettings {
        let mut settings = DocumentSettings::default();
        for (track, port) in routes {
            settings.mixes.insert(
                track.to_string(),
                ChannelMix {
                    midi_port: Some(port.to_string()),
                    ..ChannelMix::default()
                },
            );
        }
        settings
    }
    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn faulted(out: &MidiOut, name: &str) -> bool {
        let ports = lock(&out.ports);
        let index = ports.iter().position(|p| p.name == name).unwrap();
        out.shared.faulted.load(Ordering::Acquire) & (1 << index) != 0
    }
    fn open_of(out: &MidiOut, name: &str) -> bool {
        lock(&out.ports).iter().any(|p| p.name == name && p.open)
    }
    fn want(track: usize, plan_channels: u16) -> Want {
        Want {
            track,
            percussion: false,
            plan_channels,
            knock: false,
        }
    }

    #[test]
    fn percussion_shares_channel_ten_and_each_melodic_pair_takes_its_own_of_the_other_fifteen() {
        let mut wants: Vec<Want> = (0..20).map(|i| want(i, 0b1)).collect();
        wants[3].percussion = true;
        wants[7].percussion = true;
        wants[7].plan_channels = 0b11;
        let allocation = allocate_channels(&wants, &|_, _| None);
        let channels = |track: usize| {
            allocation
                .channels
                .iter()
                .find(|(t, _)| *t == track)
                .map(|(_, pairs)| pairs.clone())
        };
        assert_eq!(channels(3), Some(vec![(0, 9)]));
        assert_eq!(
            channels(7),
            Some(vec![(0, 9), (1, 9)]),
            "all of a drum track's channels are channel 10"
        );
        let melodic: Vec<u8> = allocation
            .channels
            .iter()
            .filter(|(t, _)| *t != 3 && *t != 7)
            .flat_map(|(_, pairs)| pairs.iter().map(|&(_, c)| c))
            .collect();
        assert_eq!(
            melodic,
            vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]
        );
        // 18 melodic tracks: the first fifteen are placed, the last three fall back.
        assert_eq!(allocation.overflow, vec![17, 18, 19]);
        let drums: Vec<Want> = (0..40)
            .map(|i| Want {
                track: i,
                percussion: true,
                plan_channels: 1,
                knock: false,
            })
            .collect();
        assert!(allocate_channels(&drums, &|_, _| None).overflow.is_empty());
    }

    #[test]
    fn a_track_counts_once_for_every_plan_channel_it_uses_and_falls_back_whole_when_they_do_not_fit()
     {
        // Track 0 uses two plan channels (a bent line on the secondary one), twelve more use one each: fourteen of
        // the fifteen channels are taken.
        let mut wants = vec![want(0, 0b11)];
        wants.extend((1..=12).map(|i| want(i, 0b1)));
        // Track 13 needs two and only one is left: it falls back whole and does not hold the one.
        wants.push(want(13, 0b11));
        // Track 14 needs one and takes the free channel.
        wants.push(want(14, 0b1));
        let allocation = allocate_channels(&wants, &|_, _| None);
        assert_eq!(allocation.channels[0], (0, vec![(0, 0), (1, 1)]));
        assert_eq!(allocation.overflow, vec![13]);
        assert_eq!(allocation.channels.last().unwrap(), &(14, vec![(0, 15)]));
    }

    #[test]
    fn a_golpe_knock_shares_the_percussion_channel_and_takes_no_melodic_channel() {
        let knock = |track| Want {
            track,
            percussion: false,
            plan_channels: 0b1,
            knock: true,
        };
        let drum = Want {
            track: 2,
            percussion: true,
            plan_channels: 1 << 9,
            knock: false,
        };
        let allocation = allocate_channels(&[knock(0), knock(1), drum], &|_, _| None);
        assert_eq!(
            allocation.channels,
            vec![
                (0, vec![(0, 0), (9, 9)]),
                (1, vec![(0, 1), (9, 9)]),
                (2, vec![(9, 9)]),
            ]
        );
        // Fifteen guitars with a golpe fit as fifteen without one do, and the sixteenth falls back either way.
        let melodic = |knocks: bool| {
            let wants: Vec<Want> = (0..16)
                .map(|i| Want {
                    knock: knocks,
                    ..want(i, 0b1)
                })
                .collect();
            let allocation = allocate_channels(&wants, &|_, _| None);
            let own: Vec<(usize, Vec<(u8, u8)>)> = allocation
                .channels
                .iter()
                .map(|(t, pairs)| (*t, pairs.iter().filter(|p| p.0 != 9).copied().collect()))
                .collect();
            (own, allocation.overflow)
        };
        assert_eq!(melodic(true), melodic(false));
        assert_eq!(melodic(true).1, vec![15]);
    }

    #[test]
    fn a_knock_pair_is_not_remembered_as_a_melodic_channel() {
        // The knock pair is the shared channel, so a track keeps its own channel when its golpe is added or removed.
        let with = allocate_channels(
            &[Want {
                knock: true,
                ..want(0, 0b1)
            }],
            &|_, _| None,
        );
        assert_eq!(with.channels, vec![(0, vec![(0, 0), (9, 9)])]);
    }

    #[test]
    fn channels_stay_where_they_were_when_a_route_is_added_or_removed() {
        let wants = vec![want(0, 0b11), want(1, 0b1), want(2, 0b1)];
        let first = allocate_channels(&wants, &|_, _| None);
        assert_eq!(first.channels[1], (1, vec![(0, 2)]));
        assert_eq!(first.channels[2], (2, vec![(0, 3)]));
        let kept: HashMap<(usize, u8), u8> = first
            .channels
            .iter()
            .flat_map(|(t, pairs)| pairs.iter().map(|&(p, c)| ((*t, p), c)))
            .collect();
        let find = |t: usize, p: u8| kept.get(&(t, p)).copied();
        // Track 0 is taken away: the others keep their channels (a fresh allocation would have moved them down).
        let without = allocate_channels(&[want(1, 0b1), want(2, 0b1)], &find);
        assert_eq!(without.channels, vec![(1, vec![(0, 2)]), (2, vec![(0, 3)])]);
        // Track 3 is added: it takes the lowest free channel, 0, and nobody else moves.
        let with = allocate_channels(&[want(1, 0b1), want(2, 0b1), want(3, 0b1)], &find);
        assert_eq!(with.channels[2], (3, vec![(0, 0)]));
        assert_eq!(with.channels[0], (1, vec![(0, 2)]));
    }

    #[test]
    fn routing_follows_the_mixes_and_reports_overflow_and_a_missing_port() {
        let rig = rig(&["Synth A", "Synth B"]);
        let ids: Vec<String> = (0..20).map(|i| format!("t{i}")).collect();
        let tracks: Vec<(&str, bool)> = ids.iter().map(|id| (id.as_str(), id == "t2")).collect();
        let plan = plan(&tracks);
        let mut routes: Vec<(&str, &str)> = ids.iter().map(|id| (id.as_str(), "Synth A")).collect();
        routes.push(("t0", "Synth B"));
        let mut document = settings(&routes);
        // The last track asks for a port the system does not have.
        document.mixes.get_mut("t17").unwrap().midi_port = Some("Missing".into());
        rig.out
            .ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        rig.out.settle();
        let mut route = rig.out.build_route(&plan, &document, false);
        let tap = route.tap.take().unwrap();
        // t0 went to B, alone on channel 0; t2 is the drum on channel 9.
        assert_eq!(tap.destination(0).map(|(_, c)| c), Some(0));
        assert_eq!(tap.destination(2).map(|(_, c)| c), Some(9));
        assert_ne!(tap.destination(0).unwrap().0, tap.destination(1).unwrap().0);
        // t1 and t3 are the first two melodic tracks on A.
        assert_eq!(tap.destination(1).map(|(_, c)| c), Some(0));
        assert_eq!(tap.destination(3).map(|(_, c)| c), Some(1));
        // Its port is missing, but the track is routed to it all the same: it plays on the internal sound (nothing
        // sent, nothing silenced) until the port is there.
        assert!(tap.destination(17).is_some());
        assert!(!tap.is_live(17) && !tap.silences(17), "its port is missing");
        rig.out.commit(route);
        let status = rig.out.status();
        let a = status.ports.iter().find(|p| p.name == "Synth A").unwrap();
        assert!(a.open && a.error.is_none());
        // Eighteen tracks asked for A: sixteen fit (fifteen melodic and the drum); the last two play on the internal sound.
        assert_eq!(
            a.overflow_tracks,
            vec!["t18".to_string(), "t19".to_string()]
        );
        assert_eq!(a.tracks.len(), 16);
        assert!(tap.destination(16).is_some());
        assert!(
            tap.destination(18).is_none() && !tap.silences(18),
            "overflow plays on the internal sound"
        );
        let missing = status.ports.iter().find(|p| p.name == "Missing").unwrap();
        assert!(!missing.open);
        assert!(missing.error.as_deref().unwrap().contains("Missing"));
        assert_eq!(missing.tracks, vec!["t17".to_string()]);
        // Nothing routed and nothing before: no tap; something before: an empty one that clears it.
        let none = settings(&[]);
        assert!(rig.out.build_route(&plan, &none, false).tap.is_none());
        let cleared = rig.out.build_route(&plan, &none, true).tap.unwrap();
        assert!(!cleared.has_routes());
    }

    /// `plan_using`, with an owned note on plan channel 9 for each track in `own9`.
    fn plan_owning(tracks: &[(&str, bool)], used: &[(&str, u8)], own9: &[&str]) -> PlaybackPlan {
        let mut value = serde_json::to_value(plan_using(tracks, used)).unwrap();
        value["notes"] = own9
            .iter()
            .enumerate()
            .map(|(i, track)| {
                let target = tracks.iter().position(|t| t.0 == *track).unwrap();
                serde_json::json!({"id": format!("n{i}"), "trackId": track, "source": {"target": {"track": target, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "string": 0}, "occurrence": 0, "channel": 9, "startTick": 0, "endTick": 480, "key": 60, "velocity": 90, "articulation": "picked", "legatoFrom": null, "pitch": [{"tick": 0, "semitones": 0}]})
            })
            .collect();
        serde_json::from_value(value).unwrap()
    }
    fn routed(rig: &Rig, plan: &PlaybackPlan, tracks: &[&str]) -> Box<MidiTap> {
        let routes: Vec<(&str, &str)> = tracks.iter().map(|t| (*t, "Synth")).collect();
        let document = settings(&routes);
        rig.out
            .ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        rig.out.settle();
        rig.out.build_route(plan, &document, false).tap.unwrap()
    }
    fn channels_of(tap: &MidiTap, track: usize) -> Vec<(u8, u8)> {
        tap.destinations(track)
            .into_iter()
            .map(|(_, plan, port)| (plan, port))
            .collect()
    }

    #[test]
    fn a_routed_guitars_golpe_goes_to_the_percussion_channel_and_its_notes_stay_on_its_own() {
        let rig = rig(&["Synth"]);
        let tracks = [("a", false), ("b", false), ("kit", true)];
        let plan = plan_using(
            &tracks,
            &[("a", 0), ("a", 9), ("b", 0), ("b", 9), ("kit", 9)],
        );
        let tap = routed(&rig, &plan, &["a", "b", "kit"]);
        assert_eq!(channels_of(&tap, 0), vec![(0, 0), (9, 9)]);
        assert_eq!(channels_of(&tap, 1), vec![(0, 1), (9, 9)]);
        assert_eq!(channels_of(&tap, 2), vec![(9, 9)]);
    }

    #[test]
    fn golpe_changes_neither_how_many_melodic_channels_a_port_hands_out_nor_who_overflows() {
        let rig = rig(&["Synth"]);
        let ids: Vec<String> = (0..16).map(|i| format!("g{i}")).collect();
        let tracks: Vec<(&str, bool)> = ids.iter().map(|id| (id.as_str(), false)).collect();
        let names: Vec<&str> = ids.iter().map(String::as_str).collect();
        let plain: Vec<(&str, u8)> = names.iter().map(|id| (*id, 0)).collect();
        let marked: Vec<(&str, u8)> = names.iter().flat_map(|id| [(*id, 0), (*id, 9)]).collect();
        let one = routed(&rig, &plan_using(&tracks, &plain), &names);
        let two = routed(&rig, &plan_using(&tracks, &marked), &names);
        for track in 0..15 {
            assert_eq!(channels_of(&two, track)[0], channels_of(&one, track)[0]);
            assert_eq!(channels_of(&two, track)[1], (9, 9));
            assert_eq!(channels_of(&one, track).len(), 1);
        }
        // The sixteenth guitar does not fit in either: it plays on the internal sound.
        assert!(one.destination(15).is_none() && two.destination(15).is_none());
    }

    #[test]
    fn a_routed_track_without_golpe_or_with_its_own_channel_nine_is_allocated_as_before() {
        let rig = rig(&["Synth"]);
        let tracks = [("a", false), ("b", false)];
        let plain = routed(
            &rig,
            &plan_using(&tracks, &[("a", 0), ("b", 0)]),
            &["a", "b"],
        );
        assert_eq!(channels_of(&plain, 0), vec![(0, 0)]);
        assert_eq!(channels_of(&plain, 1), vec![(0, 1)]);
        // A melodic track with a note of its own on plan channel 9 keeps taking a melodic channel for it.
        let own = plan_owning(&tracks, &[("a", 0), ("a", 9), ("b", 0)], &["a"]);
        let tap = routed(&rig, &own, &["a", "b"]);
        assert_eq!(channels_of(&tap, 0), vec![(0, 0), (9, 1)]);
        assert_eq!(channels_of(&tap, 1), vec![(0, 2)]);
    }

    #[test]
    fn a_track_with_a_secondary_channel_gets_a_port_channel_for_each_and_two_drum_tracks_are_reported_as_sharing()
     {
        let rig = rig(&["Synth"]);
        let tracks = [
            ("lead", false),
            ("bass", false),
            ("kit", true),
            ("toms", true),
        ];
        let plan = plan_using(
            &tracks,
            &[
                ("lead", 0),
                ("lead", 1),
                ("bass", 2),
                ("kit", 9),
                ("toms", 9),
                ("toms", 4),
            ],
        );
        let document = settings(&[
            ("lead", "Synth"),
            ("bass", "Synth"),
            ("kit", "Synth"),
            ("toms", "Synth"),
        ]);
        rig.out
            .ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        rig.out.settle();
        let mut route = rig.out.build_route(&plan, &document, false);
        let tap = route.tap.take().unwrap();
        assert_eq!(tap.destinations(0), vec![(0, 0, 0), (0, 1, 1)]);
        assert_eq!(tap.destinations(1), vec![(0, 2, 2)]);
        assert_eq!(tap.destinations(2), vec![(0, 9, 9)]);
        assert_eq!(tap.destinations(3), vec![(0, 4, 9), (0, 9, 9)]);
        rig.out.commit(route);
        let status = rig.out.status();
        assert_eq!(
            status.ports[0].shared_percussion,
            vec!["kit".to_string(), "toms".to_string()]
        );
        // A second build keeps the melodic channels where they were even though bass is now first to be listed.
        let reordered = settings(&[("bass", "Synth"), ("lead", "Synth")]);
        let mut again = rig.out.build_route(&plan, &reordered, true);
        let tap = again.tap.take().unwrap();
        assert_eq!(tap.destinations(0), vec![(0, 0, 0), (0, 1, 1)]);
        assert_eq!(tap.destinations(1), vec![(0, 2, 2)]);
    }

    #[test]
    fn nothing_is_remembered_until_the_route_is_committed() {
        let rig = rig(&["Synth"]);
        let plan = plan(&[("a", false)]);
        let document = settings(&[("a", "Synth")]);
        rig.out
            .ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        rig.out.settle();
        let pending = rig.out.build_route(&plan, &document, false);
        assert!(pending.tap.is_some());
        // The audio side refused it: the summary and the flag are as they were.
        drop(pending);
        assert!(rig.out.status().ports.is_empty());
        assert!(!rig.out.routed());
        let mut pending = rig.out.build_route(&plan, &document, false);
        pending.tap.take();
        rig.out.commit(pending);
        assert_eq!(rig.out.status().ports.len(), 1);
        assert!(rig.out.routed());
    }

    #[test]
    fn mute_and_solo_apply_to_the_port_as_they_do_to_the_speakers() {
        let rig = rig(&["Synth"]);
        let plan = plan(&[("a", false), ("b", false), ("c", false)]);
        let mut document = settings(&[("a", "Synth"), ("b", "Synth"), ("c", "Synth")]);
        document.mixes.get_mut("a").unwrap().mute = true;
        rig.out
            .ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        rig.out.settle();
        let tap = rig.out.build_route(&plan, &document, false).tap.unwrap();
        assert!(!tap.is_live(0) && tap.is_live(1) && tap.is_live(2));
        assert!(
            tap.silences(0),
            "a muted routed track is silent on the speakers too"
        );
        // A solo anywhere silences the others.
        let mut solo = document.clone();
        solo.mixes.get_mut("a").unwrap().mute = false;
        solo.mixes.insert(
            "c".into(),
            ChannelMix {
                solo: true,
                midi_port: Some("Synth".into()),
                ..ChannelMix::default()
            },
        );
        let tap = rig.out.build_route(&plan, &solo, false).tap.unwrap();
        assert!(!tap.is_live(0) && !tap.is_live(1) && tap.is_live(2));
    }

    // ---- the sender's work, with a clock the test turns by hand ----

    struct Clocked {
        now: Arc<AtomicU64>,
        log: Arc<Mutex<Vec<(u64, Vec<u8>)>>>,
    }
    struct ClockSink(Arc<AtomicU64>, Arc<Mutex<Vec<(u64, Vec<u8>)>>>);
    impl MidiSink for ClockSink {
        fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
            lock(&self.1).push((self.0.load(Ordering::Relaxed), bytes.to_vec()));
            Ok(())
        }
    }
    fn engine() -> (Engine, Arc<MidiOutShared>, Clocked) {
        let shared = MidiOutShared::new();
        let ports: Ports = Arc::new(Mutex::new(vec![PortSlot {
            name: "Synth".into(),
            generation: 1,
            open: true,
            error: None,
            attempted: true,
            last_attempt: None,
            token: 1,
            opening: None,
        }]));
        let clock = Clocked {
            now: Arc::new(AtomicU64::new(0)),
            log: Arc::new(Mutex::new(Vec::new())),
        };
        let mut engine = Engine::new(shared.clone(), ports);
        engine.install(0, Box::new(ClockSink(clock.now.clone(), clock.log.clone())));
        // The silence written when a connection is installed is not what these tests look at.
        lock(&clock.log).clear();
        (engine, shared, clock)
    }
    fn at(clock: &Clocked, engine: &mut Engine, now: u64) -> Poll {
        clock.now.store(now, Ordering::Relaxed);
        engine.poll(now)
    }
    fn msg(frame: u64, bytes: [u8; 3]) -> MidiRecord {
        MidiRecord::Message {
            frame,
            slot: 0,
            generation: 0,
            len: 3,
            bytes,
        }
    }

    #[test]
    fn each_message_is_written_when_its_time_comes_and_not_before() {
        let (mut engine, shared, clock) = engine();
        // The callback starts at frame 0 at 5 s, with a 480 frame (10 ms) buffer: messages at 0, 480 and 4800 frames.
        shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: 5_000_000_000,
                buffer_frames: 480,
                rate: 48_000,
            },
            0,
        );
        for (frame, key) in [(0u64, 60u8), (480, 62), (4800, 64)] {
            shared.ring.push(msg(frame, [0x90, key, 90]), 0);
        }
        // Nothing before the first is due, at 5.010 s.
        assert_eq!(
            at(&clock, &mut engine, 5_000_000_000),
            Poll::Wait(10_000_000)
        );
        assert_eq!(at(&clock, &mut engine, 5_009_999_999), Poll::Wait(1));
        assert!(lock(&clock.log).is_empty());
        // At the instant it is due the first goes; the second (10 ms later) waits.
        assert_eq!(
            at(&clock, &mut engine, 5_010_000_000),
            Poll::Wait(10_000_000)
        );
        assert_eq!(*lock(&clock.log), vec![(5_010_000_000, vec![0x90, 60, 90])]);
        assert_eq!(
            at(&clock, &mut engine, 5_020_000_000),
            Poll::Wait(90_000_000)
        );
        // A poll that comes late (3 ms) writes it at once; the third is 100 ms after the first.
        assert_eq!(at(&clock, &mut engine, 5_110_000_000), Poll::Idle);
        let log = lock(&clock.log).clone();
        assert_eq!(
            log.iter().map(|(t, b)| (*t, b[1])).collect::<Vec<_>>(),
            vec![
                (5_010_000_000, 60),
                (5_020_000_000, 62),
                (5_110_000_000, 64)
            ]
        );
        assert_eq!(shared.sent.load(Ordering::Relaxed), 3);
        assert_eq!(shared.late.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_message_written_more_than_five_milliseconds_after_it_was_due_is_counted_late() {
        let (mut engine, shared, clock) = engine();
        shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: 1_000_000_000,
                buffer_frames: 0,
                rate: 48_000,
            },
            0,
        );
        shared.ring.push(msg(0, [0x90, 60, 90]), 0);
        shared.ring.push(msg(48_000, [0x90, 61, 90]), 0);
        // The first is written 4 ms late, the second 6 ms late.
        at(&clock, &mut engine, 1_004_000_000);
        at(&clock, &mut engine, 2_006_000_000);
        assert_eq!(shared.sent.load(Ordering::Relaxed), 2);
        assert_eq!(shared.late.load(Ordering::Relaxed), 1);
        assert_eq!(shared.max_late_us.load(Ordering::Relaxed), 6_000);
    }

    #[test]
    fn lowering_the_delay_while_playing_never_writes_a_burst() {
        let (mut engine, shared, clock) = engine();
        shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: 0,
                buffer_frames: 0,
                rate: 48_000,
            },
            0,
        );
        shared.delay_ms.store(400, Ordering::Relaxed);
        for n in 0..50u64 {
            shared.ring.push(msg(n * 480, [0x90, 60, 90]), 0);
        }
        at(&clock, &mut engine, 0);
        shared.delay_ms.store(0, Ordering::Relaxed);
        for n in 50..200u64 {
            shared.ring.push(msg(n * 480, [0x90, 61, 90]), 0);
        }
        // Run the clock past everything and look at when each was written.
        for t in (0..3_000_000_000u64).step_by(100_000) {
            at(&clock, &mut engine, t);
        }
        let log = lock(&clock.log).clone();
        assert_eq!(log.len(), 200);
        let times: Vec<u64> = log.iter().map(|(t, _)| *t).collect();
        // 10 ms apart before the change; after it never closer than 9 ms: no two writes in a burst.
        assert!(
            times.windows(2).all(|w| w[1] - w[0] >= 8_900_000),
            "{:?}",
            times.windows(2).map(|w| w[1] - w[0]).min()
        );
    }

    #[test]
    fn a_reset_discards_the_queue_silences_every_port_and_forgets_the_clock() {
        let (mut engine, shared, clock) = engine();
        shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: 1_000_000_000,
                buffer_frames: 480,
                rate: 48_000,
            },
            0,
        );
        shared.ring.push(msg(0, [0x90, 60, 90]), 0);
        shared.ring.push(msg(100, [0x90, 62, 90]), 0);
        // The first is pending, not yet due, when the stream is replaced.
        assert!(matches!(
            at(&clock, &mut engine, 1_000_000_000),
            Poll::Wait(_)
        ));
        shared.request_reset();
        assert_eq!(at(&clock, &mut engine, 1_000_000_001), Poll::Idle);
        assert_eq!(shared.reset_done.load(Ordering::Acquire), 1);
        let log = lock(&clock.log).clone();
        assert_eq!(
            log.len(),
            16 * 5,
            "five messages on each channel, and no note"
        );
        assert!(log.iter().all(|(_, b)| b[0] & 0xf0 != 0x90));
        // The wheel is centred and the pedal is up on every channel.
        for channel in 0..16u8 {
            assert!(log.iter().any(|(_, b)| *b == vec![0xe0 | channel, 0, 64]));
            assert!(log.iter().any(|(_, b)| *b == vec![0xb0 | channel, 64, 0]));
            assert!(log.iter().any(|(_, b)| *b == vec![0xb0 | channel, 121, 0]));
        }
        // The clock's anchor and ordering are forgotten: a message from the new stream is timed from now.
        shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: 100,
                buffer_frames: 0,
                rate: 48_000,
            },
            0,
        );
        shared.ring.push(msg(0, [0x90, 70, 90]), 0);
        at(&clock, &mut engine, 1_000_000_100);
        assert_eq!(
            lock(&clock.log).last().unwrap().1,
            vec![0x90, 70, 90],
            "not held back behind the old due times"
        );
    }

    #[test]
    fn the_sender_looks_for_records_often_only_while_something_is_playing() {
        let (mut engine, shared, clock) = engine();
        // (Installing the test connection counted as activity; start from a sender that has done nothing.)
        engine.last_activity = None;
        assert!(!engine.hot(0));
        engine.touch(1_000_000);
        assert!(engine.hot(500_000_000));
        assert!(!engine.hot(2_000_000_000));
        // While the score renders the sender is ready however long ago anything was written.
        shared.rendering.store(true, Ordering::Relaxed);
        assert!(engine.hot(60_000_000_000));
        shared.rendering.store(false, Ordering::Relaxed);
        assert!(!engine.hot(60_000_000_000));
        assert_eq!(at(&clock, &mut engine, 0), Poll::Idle);
    }

    // ---- ports ----

    #[test]
    fn a_port_that_errors_is_marked_failed_its_error_is_reported_and_routing_again_reopens_it() {
        let rig = rig(&["Synth"]);
        let out = rig.out.with_retry_interval(Duration::ZERO);
        let document = settings(&[("t", "Synth")]);
        let plan = plan(&[("t", false)]);
        out.ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        out.settle();
        let tap = out.build_route(&plan, &document, false).tap.unwrap();
        assert!(tap.silences(0));
        rig.fail_send.store(true, Ordering::Relaxed);
        let shared = out.shared();
        let mut port = MidiOutPort::attached(shared.clone(), 48_000);
        let mut audio = MidiTap::new(&[0], &[(0, RouteSpec::lanes(0, 1, &[(0, 0)]))]);
        port.begin_callback(480);
        audio.event(0, &note(true, 60));
        port.flush(&mut audio);
        wait_for("the fault", || faulted(&out, "Synth"));
        // The audio thread sees the bit and hands the track back; the status says why.
        audio.set_fault_mask(shared.faulted.load(Ordering::Acquire));
        assert!(!audio.silences(0));
        assert!(!open_of(&out, "Synth"));
        let status = out.status();
        assert!(status.dropped >= 1);
        // Routing again opens the port afresh (here the device is back), and the track returns to it.
        rig.fail_send.store(false, Ordering::Relaxed);
        out.ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        out.settle();
        assert!(open_of(&out, "Synth") && !faulted(&out, "Synth"));
        let again = out.build_route(&plan, &document, true).tap.unwrap();
        assert!(again.silences(0), "the track plays on the port again");
        out.shutdown();
    }

    #[test]
    fn the_fault_bit_says_whether_the_port_is_really_open() {
        // A port that was never opened, was closed, or timed out has its bit set; only a real connection clears it.
        let rig = rig_with(&["Slow", "Fast"], &[("Slow", 400)]);
        let out = rig.out.with_open_timeout(Duration::from_millis(100));
        out.ensure_ports(&names(&["Fast"]), Ensure::Prepare);
        out.settle();
        assert!(open_of(&out, "Fast") && !faulted(&out, "Fast"));
        // Closing sets the bit.
        out.ensure_ports(&names(&[]), Ensure::Prepare);
        out.settle();
        assert!(!open_of(&out, "Fast") && faulted(&out, "Fast"));
        // A timed-out open sets it, and the open that finishes late changes nothing and keeps no connection.
        let started = Instant::now();
        out.ensure_ports(&names(&["Slow"]), Ensure::Prepare);
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "asking does not wait"
        );
        assert!(
            !open_of(&out, "Slow") && faulted(&out, "Slow"),
            "not open while it opens"
        );
        thread::sleep(Duration::from_millis(150));
        let status = out.status();
        let _ = status;
        assert!(!open_of(&out, "Slow") && faulted(&out, "Slow"));
        assert!(
            lock(&out.ports)
                .iter()
                .any(|p| p.name == "Slow"
                    && p.error.as_deref().is_some_and(|e| e.contains("in time")))
        );
        thread::sleep(Duration::from_millis(500));
        assert!(
            !open_of(&out, "Slow") && faulted(&out, "Slow"),
            "the late open did not clear it"
        );
        wait_for("the late connection to be dropped", || {
            rig.closed.load(Ordering::Relaxed) >= 1
        });
        out.shutdown();
    }

    #[test]
    fn a_missing_port_is_not_tried_again_for_a_fader_and_at_most_once_per_interval_otherwise() {
        let rig = rig(&[]);
        let out = rig.out;
        let wanted = names(&["Gone"]);
        out.ensure_ports(&wanted, Ensure::Prepare);
        out.settle();
        assert_eq!(lock(&rig.opens).len(), 1);
        // A hundred mix changes (a fader drag) with the same ports in use open nothing.
        for _ in 0..100 {
            out.ensure_ports(&wanted, Ensure::Mix);
            out.settle();
        }
        assert_eq!(lock(&rig.opens).len(), 1);
        // A refresh or a prepare soon after the last attempt waits for the interval.
        out.ensure_ports(&wanted, Ensure::Refresh);
        out.settle();
        out.ensure_ports(&wanted, Ensure::Prepare);
        out.settle();
        assert_eq!(lock(&rig.opens).len(), 1);
        out.shutdown();
        // With no interval, a refresh or a prepare tries again, and a mix change that changes the ports in use does too.
        let rig = rig_with(&[], &[]);
        let out = rig.out.with_retry_interval(Duration::ZERO);
        out.ensure_ports(&wanted, Ensure::Prepare);
        out.settle();
        out.ensure_ports(&wanted, Ensure::Mix);
        out.settle();
        assert_eq!(lock(&rig.opens).len(), 1);
        out.ensure_ports(&wanted, Ensure::Refresh);
        out.settle();
        assert_eq!(lock(&rig.opens).len(), 2);
        out.ensure_ports(&wanted, Ensure::Prepare);
        out.settle();
        assert_eq!(lock(&rig.opens).len(), 3);
        out.ensure_ports(&names(&["Gone", "Other"]), Ensure::Mix);
        out.settle();
        assert_eq!(
            lock(&rig.opens).len(),
            5,
            "the new port is tried, and so is the one that was missing"
        );
        out.shutdown();
    }

    #[test]
    fn ports_that_nothing_uses_any_more_give_their_slots_to_new_names() {
        let names_used: Vec<String> = (0..40).map(|i| format!("Port {i}")).collect();
        let refs: Vec<&str> = names_used.iter().map(String::as_str).collect();
        let rig = rig(&refs);
        let out = rig.out.with_retry_interval(Duration::ZERO);
        let plan = plan(&[("t", false)]);
        let mut places = Vec::new();
        for name in &names_used {
            let document = settings(&[("t", name)]);
            out.ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
            out.settle();
            let mut route = out.build_route(&plan, &document, true);
            let tap = route.tap.take().unwrap();
            assert!(tap.silences(0), "{name} is routed");
            places.push((
                tap.destination(0).unwrap().0,
                tap.route_generation(0).unwrap(),
            ));
            out.commit(route);
        }
        assert!(lock(&out.ports).len() <= MAX_SLOTS);
        // More names than slots were served, so slots were reused; and a reused slot is told apart from its old self
        // by its generation, which only ever goes up, so no two ports were ever the same (slot, generation).
        let slots: HashSet<u8> = places.iter().map(|&(slot, _)| slot).collect();
        let distinct: HashSet<(u8, u32)> = places.iter().copied().collect();
        assert!(slots.len() < 40, "slots were reused: {} slots", slots.len());
        assert_eq!(distinct.len(), 40, "every port had a place of its own");
        for slot in slots {
            let generations: Vec<u32> =
                places.iter().filter(|p| p.0 == slot).map(|p| p.1).collect();
            assert!(
                generations.windows(2).all(|w| w[0] < w[1]),
                "slot {slot}: {generations:?}"
            );
        }
        out.shutdown();
    }

    #[test]
    fn a_slow_port_opening_does_not_delay_the_messages_to_a_port_that_is_open() {
        let rig = rig_with(&["Fast", "Slow"], &[("Slow", 400)]);
        let out = rig.out;
        out.ensure_ports(&names(&["Fast"]), Ensure::Prepare);
        out.settle();
        let shared = out.shared();
        // The slow port starts opening, and the call returns at once.
        let asked = Instant::now();
        out.ensure_ports(&names(&["Fast", "Slow"]), Ensure::Prepare);
        assert!(
            asked.elapsed() < Duration::from_millis(100),
            "{:?}",
            asked.elapsed()
        );
        assert!(!open_of(&out, "Slow"));
        // While it opens, a note arrives for the fast one every 20 ms.
        out.wake();
        let started = shared.now_ns();
        assert!(shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: started,
                buffer_frames: 0,
                rate: 48_000
            },
            0
        ));
        let begin = Instant::now();
        let (slot, generation) = {
            let ports = lock(&out.ports);
            let index = ports.iter().position(|p| p.name == "Fast").unwrap();
            (index as u8, ports[index].generation as u16)
        };
        for n in 0..10u64 {
            assert!(shared.ring.push(
                MidiRecord::Message {
                    frame: n * 960,
                    slot,
                    generation,
                    len: 3,
                    bytes: [0x90, 60 + n as u8, 90]
                },
                0
            ));
        }
        let notes = || {
            lock(&rig.log)
                .iter()
                .filter(|(_, _, b)| b[0] == 0x90)
                .cloned()
                .collect::<Vec<_>>()
        };
        wait_for("the ten notes", || notes().len() >= 10);
        // Never early, and never as late as the 400 ms open. The upper bound is not a timing budget: a shared CI runner
        // wrote a note 21 ms after it was due, while the slow open still had more than 200 ms to run.
        for (n, (at, port, bytes)) in notes().iter().enumerate() {
            assert_eq!(port, "Fast");
            let due = Duration::from_millis(20 * n as u64);
            let took = at.duration_since(begin);
            assert!(
                took + Duration::from_millis(2) >= due && took < due + Duration::from_millis(100),
                "note {n} ({bytes:?}) written {took:?} in, due {due:?}"
            );
        }
        assert!(
            !open_of(&out, "Slow"),
            "all ten went out while the slow open was still running"
        );
        out.settle();
        assert!(open_of(&out, "Slow"));
        out.shutdown();
    }

    #[test]
    fn closing_a_port_and_shutting_down_silence_every_channel() {
        let rig = rig(&["Synth", "Other"]);
        rig.out
            .ensure_ports(&names(&["Synth", "Other"]), Ensure::Prepare);
        rig.out.settle();
        // Nothing uses "Other" any more: it is silenced and closed.
        rig.out.ensure_ports(&names(&["Synth"]), Ensure::Prepare);
        rig.out.settle();
        wait_for("the close", || {
            lock(&rig.log)
                .iter()
                .filter(|(_, port, bytes)| port == "Other" && bytes[1] == 123)
                .count()
                == 32
        });
        rig.out.shutdown();
        let log = lock(&rig.log);
        for channel in 0..16u8 {
            for expected in [
                vec![0xb0 | channel, 64, 0],
                vec![0xb0 | channel, 123, 0],
                vec![0xb0 | channel, 120, 0],
                vec![0xb0 | channel, 121, 0],
                vec![0xe0 | channel, 0, 64],
            ] {
                assert!(
                    log.iter()
                        .any(|(_, port, bytes)| port == "Synth" && *bytes == expected),
                    "{expected:?}"
                );
            }
        }
        assert_eq!(lock(&rig.opens).len(), 2);
    }

    #[test]
    fn the_delay_is_bounded() {
        let rig = rig(&[]);
        assert!(rig.out.set_delay(500).is_ok());
        assert_eq!(rig.out.delay(), 500);
        assert!(rig.out.set_delay(501).is_err());
        assert_eq!(rig.out.delay(), 500);
    }

    #[test]
    fn the_test_port_is_listed_and_records_when_asked_for_and_not_otherwise() {
        let plain = SystemMidi::default();
        assert!(
            !plain
                .ports()
                .unwrap()
                .iter()
                .any(|p| p.name == TEST_PORT_NAME)
        );
        let testing = SystemMidi { test_port: true };
        assert!(
            testing
                .ports()
                .unwrap()
                .iter()
                .any(|p| p.name == TEST_PORT_NAME)
        );
        take_test_log();
        let mut sink = testing.open(TEST_PORT_NAME).unwrap();
        sink.send(&[0x90, 60, 100]).unwrap();
        thread::sleep(Duration::from_millis(20));
        sink.send(&[0x80, 60, 0]).unwrap();
        let log = take_test_log();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].ms, 0.0);
        assert!(log[1].ms >= 19.0 && log[1].ms < 500.0);
        assert_eq!(log[1].bytes, vec![0x80, 60, 0]);
        assert!(take_test_log().is_empty(), "taking the log clears it");
    }

    // ---- the reset race (a new stream's first state is not lost) ----

    fn resources() -> Arc<AudioResources> {
        Arc::new(
            AudioResources::load_for_requests(
                &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &[],
            )
            .unwrap(),
        )
    }
    fn playing_plan() -> PlaybackPlan {
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 7680, "durationMs": 8000,
            "tracks": [{"id": "gm", "program": 24, "percussion": false}],
            "tempos": [{"tick": 0, "bpm": 60}],
            "occurrences": [
                {"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":4000},
                {"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":4000,"endMs":8000}
            ],
            "notes": [],
            "midi": [
                {"type":"program","trackId":"gm","tick":0,"channel":0,"program":40},
                {"type":"noteOn","trackId":"gm","tick":0,"channel":0,"key":60,"velocity":90},
                {"type":"noteOff","trackId":"gm","tick":6000,"channel":0,"key":60,"velocity":0}
            ]
        }))
        .unwrap()
    }
    fn routed_transport(shared: Arc<MidiOutShared>) -> CallbackTransport {
        let mut transport = CallbackTransport::headless_with_midi_shared(48_000, shared);
        let mut settings = DocumentSettings::default();
        settings.sounds.insert(
            "gm".into(),
            TrackSound {
                voice_id: Some("gm".into()),
                ..TrackSound::default()
            },
        );
        let mut renderer = Box::new(
            Renderer::new(Arc::new(playing_plan()), resources(), settings, 48_000).unwrap(),
        );
        renderer.replace_midi(MidiTap::new(&[24], &[(0, RouteSpec::single(0, 3))]));
        transport.install(renderer, 1, false);
        transport
    }

    #[test]
    fn a_reset_that_lands_after_the_new_stream_has_stated_its_position_does_not_lose_the_state() {
        let (mut engine, shared, clock) = engine();
        let mut transport = routed_transport(shared.clone());
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let mut block = vec![[0.0f32; 2]; 480];
        // The new stream renders its first callback: its program, controllers and held notes are queued.
        transport.render_callback(&mut block);
        assert!(shared.ring.len() > 5, "the position was stated");
        // The reset (asked for before the stream opened) is only now handled by the sender: it throws the statement away.
        shared.request_reset();
        at(&clock, &mut engine, 10_000_000_000);
        assert_eq!(shared.ring.len(), 0);
        lock(&clock.log).clear();
        // The stream's next callback sees the reset was finished and states its position again.
        transport.render_callback(&mut block);
        transport.render_callback(&mut block);
        at(&clock, &mut engine, 20_000_000_000);
        let log: Vec<Vec<u8>> = lock(&clock.log).iter().map(|(_, b)| b.clone()).collect();
        assert!(
            log.contains(&vec![0xc3, 40]),
            "the program is stated again: {log:?}"
        );
        assert!(log.contains(&vec![0xb3, 121, 0]));
        // The note held at this position is struck again, after the release of the one the reset cut.
        let off = log
            .iter()
            .position(|b| *b == vec![0x83, 60, 0])
            .expect("released");
        let on = log
            .iter()
            .rposition(|b| *b == vec![0x93, 60, 90])
            .expect("struck again");
        assert!(off < on, "{log:?}");
    }

    // ---- cost ----

    /// A 100 bar, four track score at the end of its length: the events a resync scans. Run in a release build with
    /// `cargo test --release --lib resync_cost -- --ignored --nocapture`.
    #[test]
    #[ignore = "a timing measurement; run in a release build"]
    fn resync_cost() {
        let mut midi = Vec::new();
        for bar in 0..100u32 {
            for step in 0..16u32 {
                let tick = f64::from(bar * 3840 + step * 240);
                for track in 0..4 {
                    let id = format!("t{track}");
                    let key = 40 + ((step + track) % 24) as u8;
                    midi.push(crate::audio::plan::PlanMidiEvent::NoteOn {
                        track_id: id.clone(),
                        tick,
                        channel: (track % 2) as u8,
                        key,
                        velocity: 90,
                        kit_element: None,
                    });
                    if step % 4 == 0 {
                        midi.push(crate::audio::plan::PlanMidiEvent::Bend {
                            track_id: id.clone(),
                            tick: tick + 60.0,
                            channel: (track % 2) as u8,
                            value: 1.0,
                        });
                        midi.push(crate::audio::plan::PlanMidiEvent::Controller {
                            track_id: id.clone(),
                            tick: tick + 90.0,
                            channel: (track % 2) as u8,
                            controller: 11,
                            value: (step * 7 % 128) as u8,
                        });
                    }
                    midi.push(crate::audio::plan::PlanMidiEvent::NoteOff {
                        track_id: id,
                        tick: tick + 230.0,
                        channel: (track % 2) as u8,
                        key,
                        velocity: 0,
                        kit_element: None,
                    });
                }
            }
        }
        midi.sort_by(|a, b| a.tick().total_cmp(&b.tick()));
        let event_tracks: Vec<u16> = midi
            .iter()
            .map(|e| e.track_id()[1..].parse::<u16>().unwrap())
            .collect();
        let routes: Vec<(usize, RouteSpec)> = (0..4)
            .map(|t| {
                (
                    t,
                    RouteSpec::lanes(0, 1, &[(0, (t * 2) as u8), (1, (t * 2 + 1) as u8)]),
                )
            })
            .collect();
        let mut tap = MidiTap::new(&[24, 25, 26, 27], &routes);
        let mut worst = Duration::ZERO;
        let mut total = Duration::ZERO;
        const RUNS: u32 = 200;
        for _ in 0..RUNS {
            tap.on_seek();
            tap.clear_staged();
            let started = Instant::now();
            tap.resync(&midi, &event_tracks, midi.len());
            let took = started.elapsed();
            worst = worst.max(took);
            total += took;
        }
        eprintln!(
            "resync over {} events, 4 tracks, 8 lanes: mean {:?}, worst {:?}",
            midi.len(),
            total / RUNS,
            worst
        );
        assert!(worst < Duration::from_millis(5));
    }

    /// Plays a note on the Windows wavetable synthesizer, or whichever port is named by TABPLAYER_MIDI_OUT_PORT.
    /// Run with `cargo test --lib -- --ignored real_port`.
    #[test]
    #[ignore = "needs a MIDI output port and makes a sound"]
    fn real_port_smoke_plays_a_note() {
        let name = std::env::var("TABPLAYER_MIDI_OUT_PORT")
            .unwrap_or_else(|_| "Microsoft GS Wavetable Synth".into());
        let ports = SystemMidi::default().ports().unwrap();
        let Some(port) = ports.iter().find(|p| p.name == name) else {
            eprintln!("no port called {name}; found {ports:?}");
            return;
        };
        let mut sink = SystemMidi::default().open(&port.name).unwrap();
        sink.send(&[0xc0, 0]).unwrap();
        sink.send(&[0x90, 60, 100]).unwrap();
        thread::sleep(Duration::from_millis(400));
        sink.send(&[0x80, 60, 0]).unwrap();
        thread::sleep(Duration::from_millis(100));
        silence(sink.as_mut()).unwrap();
    }

    fn note(on: bool, key: u8) -> crate::audio::plan::PlanMidiEvent {
        use crate::audio::plan::PlanMidiEvent;
        if on {
            PlanMidiEvent::NoteOn {
                track_id: "t".into(),
                tick: 0.0,
                channel: 0,
                key,
                velocity: 100,
                kit_element: None,
            }
        } else {
            PlanMidiEvent::NoteOff {
                track_id: "t".into(),
                tick: 0.0,
                channel: 0,
                key,
                velocity: 0,
                kit_element: None,
            }
        }
    }

    /// The start of playback on a fast device: the first callback's messages (the position stated for every lane, then
    /// the first chord) are written when they are due, not after the first block's work or the sender's own pacing.
    /// Reproduces the desktop run (four tracks routed, 192 kHz output, 60 bpm).
    #[test]
    #[ignore = "a wall-clock measurement; run by hand in a release build"]
    fn the_first_chord_at_play_start_is_written_on_time_on_a_192_khz_device() {
        const RATE: u32 = 192_000;
        const CALLBACK: usize = 1920;
        let period = Duration::from_secs_f64(CALLBACK as f64 / f64::from(RATE));
        let tracks = [
            ("keys", false),
            ("guitar", false),
            ("bass", false),
            ("kit", true),
        ];
        let mut midi = Vec::new();
        for (track, channel, keys) in [
            ("keys", 0, [60, 64, 67]),
            ("guitar", 0, [25, 32, 60]),
            ("guitar", 1, [64, 66, 68]),
            ("bass", 0, [48, 40, 23]),
            ("kit", 9, [36, 49, 38]),
        ] {
            midi.push(serde_json::json!({"type":"program","trackId":track,"tick":0,"channel":channel,"program":25}));
            midi.push(serde_json::json!({"type":"controller","trackId":track,"tick":0,"channel":channel,"controller":7,"value":100}));
            for key in keys {
                midi.push(serde_json::json!({"type":"noteOn","trackId":track,"tick":0,"channel":channel,"key":key,"velocity":95}));
                midi.push(serde_json::json!({"type":"noteOff","trackId":track,"tick":3840,"channel":channel,"key":key,"velocity":0}));
            }
        }
        midi.sort_by_key(|e| e["tick"].as_u64().unwrap());
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 7680, "durationMs": 8000,
            "tracks": tracks.iter().map(|(id, p)| serde_json::json!({"id": id, "program": 25, "percussion": p})).collect::<Vec<_>>(),
            "tempos": [{"tick": 0, "bpm": 60}],
            "occurrences": [
                {"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":4000},
                {"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":4000,"endMs":8000}
            ],
            "notes": [], "midi": midi
        }))
        .unwrap();
        let rig = rig(&["Synth"]);
        let routes: Vec<(&str, &str)> = tracks.iter().map(|(id, _)| (*id, "Synth")).collect();
        let mut document = settings(&routes);
        for (id, _) in tracks {
            document.sounds.insert(
                id.into(),
                TrackSound {
                    voice_id: Some("gm".into()),
                    ..TrackSound::default()
                },
            );
        }
        rig.out
            .ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        rig.out.settle();
        let mut route = rig.out.build_route(&plan, &document, false);
        let mut renderer =
            Box::new(Renderer::new(Arc::new(plan), resources(), document, RATE).unwrap());
        renderer.replace_midi(route.tap.take().unwrap());
        rig.out.commit(route);
        let mut transport = CallbackTransport::headless_with_midi_shared(RATE, rig.out.shared());
        transport.install(renderer, 1, false);
        let mut block = vec![[0.0f32; 2]; CALLBACK];
        // The device asks for a callback every 10 ms. The score is idle for a while, as before a press of Play.
        let mut deadline = Instant::now();
        let mut tick = |transport: &mut CallbackTransport, block: &mut Vec<[f32; 2]>| {
            deadline += period;
            while Instant::now() < deadline {
                thread::sleep(Duration::from_micros(200));
            }
            let started = Instant::now();
            transport.render_callback(block);
            started
        };
        for _ in 0..60 {
            tick(&mut transport, &mut block);
        }
        // Play is pressed: the command wakes the sender and reaches the audio thread before the next callback.
        rig.out.wake();
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let started = tick(&mut transport, &mut block);
        for _ in 0..30 {
            tick(&mut transport, &mut block);
        }
        thread::sleep(Duration::from_millis(50));
        // Everything of the first callback is due one buffer after it began.
        let due = started + period;
        let log = lock(&rig.log).clone();
        assert!(
            log.len() >= 70,
            "the position and the chord were written: {}",
            log.len()
        );
        let notes: Vec<_> = log
            .iter()
            .filter(|(_, _, b)| b[0] & 0xf0 == 0x90)
            .take(15)
            .collect();
        assert_eq!(notes.len(), 15);
        let late = |at: Instant| at.saturating_duration_since(due).as_secs_f64() * 1000.0;
        let worst_message = log
            .iter()
            .take(80)
            .map(|(at, _, _)| late(*at))
            .fold(0.0, f64::max);
        let worst_note = notes.iter().map(|(at, _, _)| late(*at)).fold(0.0, f64::max);
        let early = notes
            .iter()
            .map(|(at, _, _)| due.saturating_duration_since(*at).as_secs_f64() * 1000.0)
            .fold(0.0, f64::max);
        eprintln!(
            "first callback begins -> due +{:?}; worst message late {worst_message:.2} ms, first chord late {worst_note:.2} ms, early {early:.2} ms",
            period
        );
        eprintln!("sender status: {:?}", rig.out.status());
        assert!(
            worst_note < 2.5,
            "the first chord is written {worst_note:.2} ms after it was due"
        );
        assert!(
            worst_message < 2.5,
            "a message is written {worst_message:.2} ms after it was due"
        );
        assert_eq!(rig.out.status().late, 0);
        rig.out.shutdown();
    }

    // ---- readiness, generations, silence on install ----

    /// Runs the sender's decisions on a clock turned by hand: the audio side pushes a callback's anchor every 10 ms,
    /// and the note at `note_at` ns (stamped with that callback's first frame); returns when the note was written.
    fn written_after_a_rest(rendering: bool, note_at: u64) -> (u64, u64) {
        let (mut engine, shared, clock) = engine();
        shared.rendering.store(rendering, Ordering::Relaxed);
        let mut now = 0u64;
        let mut callback = 0u64;
        let end = note_at + 100_000_000;
        while now < end {
            while callback * 10_000_000 <= now {
                let start = callback * 10_000_000;
                shared.ring.push(
                    MidiRecord::Anchor {
                        frame: callback * 1920,
                        ns: start,
                        buffer_frames: 1920,
                        rate: 192_000,
                    },
                    0,
                );
                if start == note_at {
                    shared.ring.push(msg(callback * 1920, [0x90, 60, 90]), 0);
                }
                callback += 1;
            }
            let poll = at(&clock, &mut engine, now);
            let hot = engine.hot(now);
            let pause = pause_for(&poll, hot, engine.buffer_ns());
            // A spin is a short step; a sleep is exact on this clock.
            now += (pause.as_nanos() as u64).max(50_000);
        }
        let written = lock(&clock.log)
            .iter()
            .find(|(_, b)| b[0] == 0x90)
            .map(|(t, _)| *t)
            .expect("the note was written");
        (written, note_at + 10_000_000)
    }

    #[test]
    fn the_note_after_a_rest_of_two_seconds_is_written_on_time_while_the_score_renders() {
        let (written, due) = written_after_a_rest(true, 2_010_000_000);
        assert!(written >= due, "never early: {written} < {due}");
        assert!(
            written - due <= 1_000_000,
            "written {} ns after it was due",
            written - due
        );
        // Half-speed practice and whole notes leave longer rests than that.
        let (written, due) = written_after_a_rest(true, 9_010_000_000);
        assert!(
            written - due <= 1_000_000,
            "written {} ns after it was due",
            written - due
        );
    }

    #[test]
    fn a_sender_that_is_not_told_the_score_is_rendering_misses_the_note_after_a_rest() {
        // What the sender did before it knew: after a second with nothing to write it looked only every 50 ms.
        let (written, due) = written_after_a_rest(false, 2_010_000_000);
        assert!(written - due > 5_000_000, "{} ns", written - due);
    }

    #[test]
    fn a_message_queued_for_a_port_the_slot_has_since_given_up_is_not_written_to_the_next_one() {
        let (mut engine, shared, clock) = engine();
        shared.slot_generation[0].store(2, Ordering::Release);
        shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: 0,
                buffer_frames: 0,
                rate: 48_000,
            },
            0,
        );
        for generation in [1u16, 2, 1] {
            shared.ring.push(
                MidiRecord::Message {
                    frame: 0,
                    slot: 0,
                    generation,
                    len: 3,
                    bytes: [0x80, 60 + generation as u8, 0],
                },
                0,
            );
        }
        at(&clock, &mut engine, 1_000_000);
        // Only the message made for generation 2 is written; the two for the earlier port are dropped.
        assert_eq!(*lock(&clock.log), vec![(1_000_000, vec![0x80, 62, 0])]);
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn a_connection_that_is_installed_is_silenced_before_anything_is_stated_to_it() {
        let shared = MidiOutShared::new();
        let ports: Ports = Arc::new(Mutex::new(Vec::new()));
        let mut engine = Engine::new(shared, ports);
        let clock = Clocked {
            now: Arc::new(AtomicU64::new(0)),
            log: Arc::new(Mutex::new(Vec::new())),
        };
        engine.install(0, Box::new(ClockSink(clock.now.clone(), clock.log.clone())));
        let log = lock(&clock.log).clone();
        assert_eq!(log.len(), 16 * 5);
        assert!(log.iter().any(|(_, b)| *b == vec![0xb0, 123, 0]));
        assert!(log.iter().any(|(_, b)| *b == vec![0xe9, 0, 64]));
    }

    // ---- opens never wait ----

    #[test]
    fn an_open_that_never_returns_delays_nothing_and_a_second_port_still_opens() {
        let rig = rig_with(&["Hang", "Other"], &[("Hang", 600_000)]);
        let out = rig
            .out
            .with_retry_interval(Duration::ZERO)
            .with_open_timeout(Duration::from_millis(100));
        let asked = Instant::now();
        out.ensure_ports(&names(&["Hang", "Other"]), Ensure::Prepare);
        assert!(
            asked.elapsed() < Duration::from_millis(100),
            "asking does not wait: {:?}",
            asked.elapsed()
        );
        wait_for("the other port", || open_of(&out, "Other"));
        // Later asks (a prepare, a refresh, a mix) return at once too, and do not start a second open behind the first.
        for reason in [
            Ensure::Prepare,
            Ensure::Refresh,
            Ensure::Mix,
            Ensure::Prepare,
        ] {
            let asked = Instant::now();
            out.ensure_ports(&names(&["Hang", "Other"]), reason);
            assert!(asked.elapsed() < Duration::from_millis(100));
        }
        assert_eq!(lock(&rig.opens).iter().filter(|n| *n == "Hang").count(), 1);
        // The overdue one is reported as failed, and its track is on the internal sound meanwhile.
        thread::sleep(Duration::from_millis(150));
        let status = {
            let plan = plan(&[("a", false), ("b", false)]);
            let document = settings(&[("a", "Hang"), ("b", "Other")]);
            let mut route = out.build_route(&plan, &document, false);
            let tap = route.tap.take().unwrap();
            assert!(
                !tap.is_live(0) && !tap.silences(0),
                "Hang plays on the internal sound"
            );
            assert!(tap.is_live(1) && tap.silences(1), "Other plays on its port");
            out.commit(route);
            out.status()
        };
        let hang = status.ports.iter().find(|p| p.name == "Hang").unwrap();
        assert!(
            !hang.open && hang.error.as_deref().is_some_and(|e| e.contains("in time")),
            "{hang:?}"
        );
        assert!(
            status
                .ports
                .iter()
                .find(|p| p.name == "Other")
                .unwrap()
                .open
        );
        out.shutdown();
    }

    #[test]
    fn a_port_opened_after_the_route_was_built_takes_its_track_without_a_new_route() {
        let rig = rig_with(&["Late"], &[("Late", 200)]);
        let out = rig.out;
        let plan = plan(&[("a", false)]);
        let document = settings(&[("a", "Late")]);
        out.ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        let mut route = out.build_route(&plan, &document, false);
        let mut tap = route.tap.take().unwrap();
        assert!(!tap.silences(0), "internal sound while it opens");
        wait_for("the late port", || open_of(&out, "Late"));
        // The audio thread reads the port's bit each block.
        tap.set_fault_mask(out.shared().faulted.load(Ordering::Acquire));
        assert!(tap.silences(0) && tap.is_live(0) && tap.resync_due());
        out.shutdown();
    }

    #[test]
    fn closing_a_port_on_purpose_does_not_stop_it_from_being_opened_again_at_once() {
        let rig = rig(&["A", "B"]);
        let out = rig.out; // the default two second spacing between attempts
        out.ensure_ports(&names(&["A"]), Ensure::Prepare);
        out.settle();
        assert!(open_of(&out, "A"));
        out.ensure_ports(&names(&["B"]), Ensure::Prepare);
        out.settle();
        assert!(!open_of(&out, "A") && open_of(&out, "B"));
        // Back to the first document within the spacing: not a retry of a failure.
        out.ensure_ports(&names(&["A"]), Ensure::Prepare);
        out.settle();
        assert!(open_of(&out, "A"), "A is open again");
        assert_eq!(lock(&rig.opens).iter().filter(|n| *n == "A").count(), 2);
        out.shutdown();
    }

    #[test]
    fn a_dead_sender_leaves_no_port_marked_open_and_the_next_ask_opens_it_again() {
        let rig = rig(&["Synth"]);
        let out = rig.out.with_retry_interval(Duration::ZERO);
        out.ensure_ports(&names(&["Synth"]), Ensure::Prepare);
        out.settle();
        assert!(open_of(&out, "Synth"));
        // The driver faults inside the sender thread, which dies with its connection.
        rig.panic_send.store(true, Ordering::Relaxed);
        let shared = out.shared();
        let generation = lock(&out.ports)[0].generation as u16;
        out.wake();
        shared.ring.push(
            MidiRecord::Message {
                frame: 0,
                slot: 0,
                generation,
                len: 3,
                bytes: [0x90, 60, 90],
            },
            0,
        );
        wait_for("the sender to die", || {
            lock(&out.threads)
                .as_ref()
                .is_some_and(|t| t.sender_handle.is_finished())
        });
        rig.panic_send.store(false, Ordering::Relaxed);
        out.ensure_ports(&names(&["Synth"]), Ensure::Prepare);
        out.settle();
        assert!(open_of(&out, "Synth") && !faulted(&out, "Synth"));
        assert_eq!(lock(&rig.opens).len(), 2);
        // And it works: a note goes through the new sender.
        out.wake();
        shared.ring.push(
            MidiRecord::Message {
                frame: 0,
                slot: 0,
                generation,
                len: 3,
                bytes: [0x90, 61, 90],
            },
            0,
        );
        wait_for("the note", || {
            lock(&rig.log)
                .iter()
                .any(|(_, _, b)| *b == vec![0x90, 61, 90])
        });
        out.shutdown();
    }

    #[test]
    fn a_connection_the_sender_cannot_take_is_not_a_port_that_is_open() {
        let shared = MidiOutShared::new();
        let ports: Ports = Arc::new(Mutex::new(vec![PortSlot {
            name: "Synth".into(),
            generation: 1,
            open: false,
            error: None,
            attempted: true,
            last_attempt: None,
            token: 5,
            opening: Some((5, Instant::now())),
        }]));
        let (tx, rx) = mpsc::channel();
        drop(rx);
        let backend = Arc::new(ListedPorts(Mutex::new(vec!["Synth".into()])));
        open_job(
            0,
            "Synth".into(),
            5,
            shared.clone(),
            ports.clone(),
            backend,
            tx,
        );
        let list = lock(&ports);
        assert!(!list[0].open && list[0].opening.is_none());
        assert!(
            list[0]
                .error
                .as_deref()
                .is_some_and(|e| e.contains("sender stopped"))
        );
        assert_eq!(shared.faulted.load(Ordering::Acquire) & 1, 1);
    }

    #[test]
    fn channels_survive_a_new_plan_of_the_same_score() {
        let rig = rig(&["Synth"]);
        let tracks = [("a", false), ("b", false), ("c", false)];
        let first = plan(&tracks);
        let document = settings(&[("a", "Synth"), ("b", "Synth"), ("c", "Synth")]);
        rig.out
            .ensure_ports(&MidiOut::port_names(&document), Ensure::Prepare);
        rig.out.settle();
        let mut route = rig.out.build_route(&first, &document, false);
        let tap = route.tap.take().unwrap();
        assert_eq!(tap.destination(1).map(|(_, c)| c), Some(1));
        rig.out.commit(route);
        // An edit prepares a new plan (a new generation) without the first track: the others keep their channels.
        let mut second = plan(&[("b", false), ("c", false)]);
        second.generation = 2;
        let mut route = rig.out.build_route(&second, &document, true);
        let tap = route.tap.take().unwrap();
        assert_eq!(tap.destination(0).map(|(_, c)| c), Some(1));
        assert_eq!(tap.destination(1).map(|(_, c)| c), Some(2));
        rig.out.shutdown();
    }

    // ---- a count-in, control messages before records, and opens that hang ----

    fn engine_with_inbox() -> (Engine, Arc<MidiOutShared>, Clocked, mpsc::Sender<Message>) {
        let shared = MidiOutShared::new();
        let ports: Ports = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let engine = Engine::new(shared.clone(), ports).with_inbox(rx);
        let clock = Clocked {
            now: Arc::new(AtomicU64::new(0)),
            log: Arc::new(Mutex::new(Vec::new())),
        };
        (engine, shared, clock, tx)
    }

    /// Play is pressed at 2 s after two idle seconds, a one bar count-in follows (no frames are rendered), and the
    /// first chord is due at 6 s. `during_count_in` is whether the audio side reports the transport as playing then.
    fn first_chord_after_a_count_in(during_count_in: bool) -> (u64, u64) {
        let (mut engine, shared, clock, tx) = engine_with_inbox();
        engine.install(0, Box::new(ClockSink(clock.now.clone(), clock.log.clone())));
        lock(&clock.log).clear();
        let (play, chord) = (2_000_000_000u64, 6_020_000_000u64);
        let mut now = 0u64;
        let mut callback = 0u64;
        let mut woken = false;
        while now < chord + 100_000_000 {
            while callback * 10_000_000 <= now {
                let start = callback * 10_000_000;
                shared.ring.push(
                    MidiRecord::Anchor {
                        frame: callback * 1920,
                        ns: start,
                        buffer_frames: 1920,
                        rate: 192_000,
                    },
                    0,
                );
                if start >= play && !woken {
                    woken = true;
                    tx.send(Message::Wake).unwrap();
                    shared.rendering.store(during_count_in, Ordering::Relaxed);
                }
                if start == chord {
                    shared.rendering.store(true, Ordering::Relaxed);
                    shared.ring.push(msg(callback * 1920, [0x90, 60, 90]), 0);
                }
                callback += 1;
            }
            let poll = at(&clock, &mut engine, now);
            let hot = engine.hot(now);
            now += (pause_for(&poll, hot, engine.buffer_ns()).as_nanos() as u64).max(50_000);
        }
        let written = lock(&clock.log)
            .iter()
            .find(|(_, b)| b[0] == 0x90)
            .map(|(t, _)| *t)
            .expect("the chord was written");
        (written, chord + 10_000_000)
    }

    #[test]
    fn the_first_chord_after_a_count_in_is_written_on_time_because_the_transport_is_playing() {
        let (written, due) = first_chord_after_a_count_in(true);
        assert!(
            written >= due && written - due <= 1_000_000,
            "{} ns late",
            written.saturating_sub(due)
        );
    }

    #[test]
    fn a_sender_told_only_about_rendered_frames_goes_cold_during_a_count_in() {
        // The earlier behaviour, for the record: nothing renders during the count-in, so the sender went idle one
        // second after Play and the chord was found up to a poll late.
        let (written, due) = first_chord_after_a_count_in(false);
        assert!(written - due > 5_000_000, "{} ns late", written - due);
    }

    #[test]
    fn a_connection_announced_as_open_is_in_place_before_the_next_record_is_taken() {
        let (mut engine, shared, clock, tx) = engine_with_inbox();
        shared.ring.push(
            MidiRecord::Anchor {
                frame: 0,
                ns: 0,
                buffer_frames: 0,
                rate: 48_000,
            },
            0,
        );
        shared.ring.push(msg(0, [0x90, 60, 90]), 0);
        // The Install is waiting in the channel when the sender is about to write: one pass takes it first.
        tx.send(Message::Install {
            slot: 0,
            sink: Box::new(ClockSink(clock.now.clone(), clock.log.clone())),
        })
        .unwrap();
        at(&clock, &mut engine, 1_000_000);
        let log = lock(&clock.log).clone();
        assert!(log.iter().any(|(_, b)| *b == vec![0x90, 60, 90]), "written");
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 0);
    }

    /// Opens that fail at once the first time and never return after that.
    struct Flaky {
        calls: AtomicUsize,
    }
    impl MidiBackend for Flaky {
        fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
            Ok(Vec::new())
        }
        fn open(&self, name: &str) -> Result<Box<dyn MidiSink>, String> {
            if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
                return Err(format!("The MIDI output \"{name}\" is not available."));
            }
            thread::sleep(Duration::from_secs(600));
            Err("unreachable".into())
        }
    }

    #[test]
    fn a_retry_that_hangs_is_timed_out_even_though_the_try_before_it_failed() {
        let out = MidiOut::with_backend(Arc::new(Flaky {
            calls: AtomicUsize::new(0),
        }))
        .with_retry_interval(Duration::ZERO)
        .with_open_timeout(Duration::from_millis(100));
        out.ensure_ports(&names(&["A"]), Ensure::Prepare);
        out.settle();
        assert!(
            lock(&out.ports)[0]
                .error
                .as_deref()
                .is_some_and(|e| e.contains("not available"))
        );
        // The retry hangs. It starts clean, and the overdue check reports it as the failure it is.
        out.ensure_ports(&names(&["A"]), Ensure::Refresh);
        assert!(lock(&out.ports)[0].error.is_none());
        thread::sleep(Duration::from_millis(150));
        let status = out.status();
        let error = lock(&out.ports)[0].error.clone();
        assert!(
            error.as_deref().is_some_and(|e| e.contains("in time")),
            "{error:?} {status:?}"
        );
        assert!(faulted(&out, "A"));
    }

    #[test]
    fn a_slot_whose_open_is_still_running_is_not_given_to_another_name() {
        let rig = rig_with(&["A", "B"], &[("A", 600_000)]);
        let out = rig.out.with_retry_interval(Duration::ZERO);
        out.ensure_ports(&names(&["A"]), Ensure::Prepare);
        // The document no longer uses A, but its open has not returned: B must not take the slot and open alongside it.
        out.ensure_ports(&names(&["B"]), Ensure::Prepare);
        let places: Vec<(String, bool)> = lock(&out.ports)
            .iter()
            .map(|p| (p.name.clone(), p.opening.is_some()))
            .collect();
        assert_eq!(places[0].0, "A");
        assert!(places[0].1, "A is still opening: {places:?}");
        assert_eq!(places[1].0, "B");
    }

    #[test]
    fn a_dead_sender_does_not_forget_an_open_that_is_still_running() {
        let rig = rig_with(&["A"], &[("A", 600_000)]);
        let out = rig.out.with_retry_interval(Duration::ZERO);
        out.ensure_ports(&names(&["A"]), Ensure::Prepare);
        assert!(lock(&out.ports)[0].opening.is_some());
        // The sender dies.
        {
            let mut threads = lock(&out.threads);
            let t = threads.take().unwrap();
            let _ = t.sender.send(Message::Shutdown);
            let _ = t.sender_handle.join();
            let dead = thread::spawn(|| {});
            while !dead.is_finished() {
                thread::sleep(Duration::from_millis(1));
            }
            *threads = Some(Threads {
                sender: t.sender,
                sender_handle: dead,
            });
        }
        out.ensure_ports(&names(&["A"]), Ensure::Prepare);
        assert!(
            lock(&out.ports)[0].opening.is_some(),
            "still recorded as running"
        );
        // Give a second open, if one were started, time to reach the driver.
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            lock(&rig.opens).iter().filter(|n| *n == "A").count(),
            1,
            "no second open of the same port"
        );
    }

    #[test]
    fn a_port_that_opens_during_playback_wakes_a_sender_that_was_idle() {
        // Nothing was routed, so nothing was rendering for the sender's purposes, and it has done nothing so far.
        let (mut engine, shared, clock, tx) = engine_with_inbox();
        shared.rendering.store(false, Ordering::Relaxed);
        assert!(!engine.hot(shared.now_ns()));
        // The port opens: its connection arrives, and the sender looks for records at the quick pace at once, so the
        // position stated to it a moment later is not found up to a poll late.
        tx.send(Message::Install {
            slot: 0,
            sink: Box::new(ClockSink(clock.now.clone(), clock.log.clone())),
        })
        .unwrap();
        engine.poll(shared.now_ns());
        assert!(
            engine.hot(shared.now_ns()),
            "the sender is hot after an install"
        );
    }
}
