//! Guitar tuner. A capture thread owns the input stream (cpal streams are not `Send` on Windows)
//! and its callback only downmixes into a lock-free ring. A worker thread drains the ring about
//! every 50 ms, analyses it and publishes the latest reading for `tuner_read`.
pub mod decimate;
pub mod detect;

use crate::audio_input::{
    AudioInput, CAPTURE_POLL, CaptureHandle, STOP_TIMEOUT, StreamFault, build_stream, choose_input,
};
use decimate::Decimator;
use detect::{
    MAX_TARGET_HZ, MAX_TARGETS, MIN_TARGET_HZ, PolyAnalyzer, SILENT_DBFS, TunerPitch, detect_pitch,
    rms_dbfs, yin_frame_len,
};
#[cfg(any(test, feature = "desktop-test"))]
use ringbuf::HeapProd;
use ringbuf::{HeapCons, HeapRb, traits::*};
use serde::Serialize;
use std::{
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const ANALYSIS_INTERVAL: Duration = Duration::from_millis(50);
/// After this many analysis passes without new samples the buffer is dropped, so a stalled device
/// does not keep reporting its last note.
const STALL_PASSES: u32 = 10;
/// About three seconds without a sample: the input is open but nothing arrives.
const NO_SOUND_PASSES: u32 = 60;
const NO_SOUND_MESSAGE: &str = "No sound is arriving from this input.";
const UNEXPECTED_STOP_MESSAGE: &str = "The tuner stopped unexpectedly.";
/// How long a device may take to open (a permission prompt, a slow driver) before giving up.
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a start in progress checks that it has not been overtaken by a stop.
const START_POLL: Duration = Duration::from_millis(50);
/// The most `stop` takes in all, including waiting for a start in progress to let go.
const STOP_BUDGET: Duration = Duration::from_millis(500);
/// Analysis passes (50 ms each) a string that just dropped out of the analysis is still shown.
const HOLD_PASSES: u32 = 20;
#[cfg(feature = "desktop-test")]
const TEST_TONE_ID: &str = "test-tone";
#[cfg(any(test, feature = "desktop-test"))]
const TEST_TONE_RATE: f64 = 48_000.0;

pub type TunerInput = AudioInput;

pub fn list_inputs() -> Result<Vec<TunerInput>, String> {
    #[cfg_attr(not(feature = "desktop-test"), allow(unused_mut))]
    let mut inputs = crate::audio_input::list_devices()?;
    #[cfg(feature = "desktop-test")]
    if test_tone_frequencies().is_some() {
        inputs.push(TunerInput {
            id: TEST_TONE_ID.into(),
            name: "Test tone".into(),
            default: false,
        });
    }
    Ok(inputs)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunerReading {
    pub running: bool,
    pub error: Option<String>,
    /// RMS in dBFS of the latest window; -120 when silent.
    pub level: f32,
    pub pitch: Option<TunerPitch>,
    /// Measured Hz per requested target, in the same order.
    pub strings: Vec<Option<f64>>,
}

struct Shared {
    /// Bumped by every start and stop. A thread publishes only while its own generation is
    /// current, so a capture that was replaced (or is hung and was abandoned) cannot overwrite
    /// the new one's state.
    generation: u64,
    /// A start or restart is in progress; the tuner reads as running throughout.
    starting: bool,
    running: bool,
    error: Option<String>,
    level: f32,
    pitch: Option<TunerPitch>,
    /// Targets the next analysis pass should measure; set by `tuner_read`.
    wanted: Vec<f64>,
    /// Targets `strings` was measured for.
    analysed: Vec<f64>,
    strings: Vec<Option<f64>>,
}

impl Shared {
    fn fresh(generation: u64, starting: bool) -> Self {
        Self {
            generation,
            starting,
            running: false,
            error: None,
            level: SILENT_DBFS,
            pitch: None,
            wanted: Vec::new(),
            analysed: Vec::new(),
            strings: Vec::new(),
        }
    }
}

type SharedRef = Arc<Mutex<Shared>>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Applies `change` if `generation` is still current; says whether it was.
fn publish(shared: &SharedRef, generation: u64, change: impl FnOnce(&mut Shared)) -> bool {
    let mut state = lock(shared);
    if state.generation != generation {
        return false;
    }
    change(&mut state);
    true
}

/// Clears the running flag however a tuner thread ends, and reports an end nobody asked for
/// (a panic, or the thread returning while the tuner was meant to run).
struct ThreadGuard {
    shared: SharedRef,
    generation: u64,
    /// Set once the thread is leaving because it was told to.
    clean: bool,
}

impl ThreadGuard {
    fn new(shared: &SharedRef, generation: u64) -> Self {
        Self {
            shared: shared.clone(),
            generation,
            clean: false,
        }
    }
}

impl Drop for ThreadGuard {
    fn drop(&mut self) {
        let clean = self.clean && !thread::panicking();
        publish(&self.shared, self.generation, |state| {
            state.running = false;
            if !clean && state.error.is_none() {
                state.error = Some(UNEXPECTED_STOP_MESSAGE.into());
            }
        });
    }
}

/// Drains the ring, decimates input above 48 kHz and publishes a reading every analysis interval
/// until the stop channel closes.
fn analysis_worker(
    mut consumer: HeapCons<f32>,
    device_rate: f64,
    shared: SharedRef,
    generation: u64,
    stop: mpsc::Receiver<()>,
) {
    let mut guard = ThreadGuard::new(&shared, generation);
    let mut decimator = Decimator::new(decimate::factor_for(device_rate));
    let rate = device_rate / decimator.factor() as f64;
    let frame_len = yin_frame_len(rate);
    let mut poly = PolyAnalyzer::new(rate);
    let keep = frame_len.max(poly.window_len());
    let mut buffer: Vec<f32> = Vec::with_capacity(keep * 2);
    let mut scratch = vec![0.0f32; 4096];
    let mut idle = 0u32;
    let mut hold = StringHold::new();
    while let Err(mpsc::RecvTimeoutError::Timeout) = stop.recv_timeout(ANALYSIS_INTERVAL) {
        let mut received = 0usize;
        loop {
            let count = consumer.pop_slice(&mut scratch);
            if count == 0 {
                break;
            }
            received += count;
            decimator.process(&scratch[..count], &mut buffer);
        }
        if buffer.len() > keep {
            buffer.drain(..buffer.len() - keep);
        }
        idle = if received == 0 {
            idle.saturating_add(1)
        } else {
            0
        };
        if idle >= STALL_PASSES {
            buffer.clear();
            decimator.reset();
            hold.clear();
        }
        let window = &buffer[buffer.len().saturating_sub(frame_len)..];
        let level = if window.len() >= 256 {
            rms_dbfs(window)
        } else {
            SILENT_DBFS
        };
        let wanted = lock(&shared).wanted.clone();
        // The two modes are never shown together, so only the one in use is computed.
        let (pitch, strings) = if wanted.is_empty() {
            // Held strings from before a switch to chromatic must not come back afterwards.
            hold.clear();
            (detect_pitch(&buffer, rate), Vec::new())
        } else {
            (None, hold.apply(&wanted, poly.analyze(&buffer, &wanted)))
        };
        let stalled = idle >= NO_SOUND_PASSES;
        publish(&shared, generation, |state| {
            state.level = level;
            state.pitch = pitch;
            state.analysed = wanted;
            state.strings = strings;
            if stalled {
                state.error = Some(NO_SOUND_MESSAGE.into());
            } else if state.error.as_deref() == Some(NO_SOUND_MESSAGE) {
                state.error = None;
            }
        });
    }
    guard.clean = true;
}

enum Source {
    Device(Option<String>),
    #[cfg(any(test, feature = "desktop-test"))]
    Tone(Vec<f64>),
    /// Opens after `delay`, then never delivers a sample.
    #[cfg(test)]
    Silent {
        delay: Duration,
    },
}

/// Harmonic-rich tones at equal level, for the desktop test.
#[cfg(any(test, feature = "desktop-test"))]
struct ToneSynth {
    phases: Vec<f64>,
    steps: Vec<f64>,
    gain: f64,
}

#[cfg(any(test, feature = "desktop-test"))]
impl ToneSynth {
    const HARMONICS: [f64; 4] = [1.0, 0.5, 0.33, 0.25];

    fn new(frequencies: &[f64], rate: f64) -> Self {
        Self {
            phases: vec![0.0; frequencies.len()],
            steps: frequencies.iter().map(|f| f / rate).collect(),
            gain: 0.6 / (2.1 * frequencies.len().max(1) as f64),
        }
    }

    fn fill(&mut self, out: &mut [f32]) {
        for slot in out {
            let mut value = 0.0;
            for (phase, step) in self.phases.iter_mut().zip(&self.steps) {
                for (h, amplitude) in Self::HARMONICS.iter().enumerate() {
                    value += amplitude * (std::f64::consts::TAU * *phase * (h + 1) as f64).sin();
                }
                *phase = (*phase + step).fract();
            }
            *slot = (value * self.gain) as f32;
        }
    }
}

/// What the capture thread keeps alive while capturing.
enum Live {
    /// Held only so the stream keeps running until it is dropped.
    #[allow(dead_code)]
    Stream(cpal::Stream),
    #[cfg(any(test, feature = "desktop-test"))]
    Tone(ToneSynth, HeapProd<f32>),
    #[cfg(test)]
    #[allow(dead_code)]
    Idle(HeapProd<f32>),
}

fn capture_main(
    source: Source,
    shared: SharedRef,
    generation: u64,
    stop: mpsc::Receiver<()>,
    ready: mpsc::Sender<Result<(), String>>,
    // Dropped when the thread ends, which is how `CaptureHandle` learns it has finished.
    _finished: mpsc::Sender<()>,
) {
    let mut guard = ThreadGuard::new(&shared, generation);
    let fault = Arc::new(StreamFault::default());
    let opened = match &source {
        Source::Device(id) => choose_input(id.as_deref())
            .map(|(d, c)| (Some((d, c.clone())), f64::from(c.sample_rate()))),
        #[cfg(any(test, feature = "desktop-test"))]
        Source::Tone(_) => Ok((None, TEST_TONE_RATE)),
        #[cfg(test)]
        Source::Silent { delay } => {
            thread::sleep(*delay);
            Ok((None, TEST_TONE_RATE))
        }
    };
    let (device_config, rate) = match opened {
        Ok(opened) => opened,
        Err(message) => {
            guard.clean = true;
            let _ = ready.send(Err(message));
            return;
        }
    };
    // The ring holds one second of mono samples; the callback drops what does not fit.
    let (producer, consumer) = HeapRb::<f32>::new(rate as usize).split();
    let live = match (source, device_config) {
        (Source::Device(_), Some((device, config))) => {
            match build_stream(&device, &config, producer, fault.clone()) {
                Ok(stream) => Live::Stream(stream),
                Err(message) => {
                    guard.clean = true;
                    let _ = ready.send(Err(message));
                    return;
                }
            }
        }
        #[cfg(any(test, feature = "desktop-test"))]
        (Source::Tone(frequencies), _) => {
            Live::Tone(ToneSynth::new(&frequencies, TEST_TONE_RATE), producer)
        }
        #[cfg(test)]
        (Source::Silent { .. }, _) => Live::Idle(producer),
        (Source::Device(_), None) => unreachable!("a device source always opens a device"),
    };
    let (worker_stop, worker_stopped) = mpsc::channel::<()>();
    let worker = {
        let shared = shared.clone();
        match thread::Builder::new()
            .name("tuner-analysis".into())
            .spawn(move || analysis_worker(consumer, rate, shared, generation, worker_stopped))
        {
            Ok(worker) => worker,
            Err(_) => {
                guard.clean = true;
                let _ = ready.send(Err("Could not start the tuner.".into()));
                return;
            }
        }
    };
    // A stop (or a newer start) that arrived while the device was opening wins.
    let current = publish(&shared, generation, |state| {
        state.running = true;
        state.starting = false;
        state.error = None;
    });
    let mut asked_to_stop = !current;
    if current {
        let _ = ready.send(Ok(()));
        asked_to_stop = run_capture(live, &fault, &stop, &worker);
    } else {
        let _ = ready.send(Err("The tuner was stopped.".into()));
    }
    drop(worker_stop);
    let _ = worker.join();
    if let Some(message) = fault.message() {
        publish(&shared, generation, |state| {
            state.error = Some(message.into());
        });
        asked_to_stop = true;
    }
    guard.clean = asked_to_stop;
}

/// Holds the stream (or feeds the test source) until told to stop, the stream fails or the
/// analysis worker ends. True when it was told to stop.
fn run_capture(
    live: Live,
    fault: &StreamFault,
    stop: &mpsc::Receiver<()>,
    worker: &JoinHandle<()>,
) -> bool {
    let mut stopped = false;
    #[cfg_attr(not(any(test, feature = "desktop-test")), allow(unused_mut))]
    let mut live = live;
    #[cfg(any(test, feature = "desktop-test"))]
    let started = std::time::Instant::now();
    #[cfg(any(test, feature = "desktop-test"))]
    let mut produced = 0u64;
    loop {
        let wait = match live {
            #[cfg(any(test, feature = "desktop-test"))]
            Live::Tone(..) => Duration::from_millis(10),
            _ => CAPTURE_POLL,
        };
        if !matches!(
            stop.recv_timeout(wait),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            stopped = true;
            break;
        }
        if fault.message().is_some() || worker.is_finished() {
            break;
        }
        #[cfg(any(test, feature = "desktop-test"))]
        if let Live::Tone(synth, producer) = &mut live {
            // Real-time pacing: generate whatever the elapsed time says is due.
            let due = (started.elapsed().as_secs_f64() * TEST_TONE_RATE) as u64;
            let mut chunk = [0.0f32; 256];
            while produced < due {
                let count = ((due - produced) as usize).min(chunk.len());
                synth.fill(&mut chunk[..count]);
                producer.push_slice(&chunk[..count]);
                produced += count as u64;
            }
        }
    }
    // Stop the stream first so nothing writes while the worker winds down.
    drop(live);
    stopped
}

/// Keeps a string that was just heard for a moment after it drops out of the analysis. Two
/// partials that coincide can cancel for a while, and a string being tuned should not flicker;
/// a string that really stopped sounding is shown for at most `HOLD_PASSES` passes longer.
struct StringHold {
    wanted: Vec<f64>,
    held: Vec<Option<(f64, u32)>>,
}

impl StringHold {
    fn new() -> Self {
        Self {
            wanted: Vec::new(),
            held: Vec::new(),
        }
    }

    fn apply(&mut self, wanted: &[f64], found: Vec<Option<f64>>) -> Vec<Option<f64>> {
        if self.wanted != wanted {
            self.wanted = wanted.to_vec();
            self.held = vec![None; wanted.len()];
        }
        found
            .into_iter()
            .zip(self.held.iter_mut())
            .map(|(now, held)| match (now, *held) {
                (Some(frequency), _) => {
                    *held = Some((frequency, 0));
                    Some(frequency)
                }
                (None, Some((frequency, age))) if age < HOLD_PASSES => {
                    *held = Some((frequency, age + 1));
                    Some(frequency)
                }
                (None, _) => {
                    *held = None;
                    None
                }
            })
            .collect()
    }

    fn clear(&mut self) {
        self.held.iter_mut().for_each(|held| *held = None);
    }
}

/// The tuner's managed state. Cloning shares it, so blocking work can move to another thread.
#[derive(Clone)]
pub struct TunerState {
    shared: SharedRef,
    capture: Arc<Mutex<Option<CaptureHandle>>>,
    /// The session number of the latest successful or pending start.
    session: Arc<AtomicU64>,
    start_timeout: Duration,
}

impl Default for TunerState {
    fn default() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared::fresh(0, false))),
            capture: Arc::new(Mutex::new(None)),
            session: Arc::new(AtomicU64::new(0)),
            start_timeout: START_TIMEOUT,
        }
    }
}

impl TunerState {
    /// Starts capturing and returns the session number to pass to `stop_session`.
    fn start_source(&self, source: Source) -> Result<u64, String> {
        let mut slot = lock(&self.capture);
        // The tuner reads as running from here until the new capture is up or has failed, so a
        // restart never shows a stopped gap. The last level stays so the display does not flash
        // its silence hint.
        let generation = {
            let mut state = lock(&self.shared);
            let generation = state.generation + 1;
            let level = state.level;
            *state = Shared::fresh(generation, true);
            state.level = level;
            generation
        };
        self.session.store(generation, Ordering::Release);
        if let Some(old) = slot.take() {
            old.shutdown(STOP_TIMEOUT);
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let shared = self.shared.clone();
        let fail = |message: &str| {
            let mut state = lock(&self.shared);
            if state.generation == generation {
                // Whatever this start left behind can no longer publish.
                *state = Shared::fresh(generation + 1, false);
            }
            message.to_string()
        };
        let thread = match thread::Builder::new()
            .name("tuner-capture".into())
            .spawn(move || capture_main(source, shared, generation, stop_rx, ready_tx, finished_tx))
        {
            Ok(thread) => thread,
            Err(_) => return Err(fail("Could not start the tuner.")),
        };
        let handle = CaptureHandle {
            stop: Some(stop_tx),
            finished: finished_rx,
            thread: Some(thread),
        };
        // Wait in short slices so a stop that overtakes this start is noticed at once.
        let deadline = Instant::now() + self.start_timeout;
        let outcome = loop {
            match ready_rx.recv_timeout(START_POLL) {
                Ok(outcome) => break Some(outcome),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Some(Err("Could not start the audio input.".to_string()));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if lock(&self.shared).generation != generation {
                        break None;
                    }
                    if Instant::now() >= deadline {
                        let message = fail(
                            "The audio input did not start. Check that it is connected and not in use.",
                        );
                        handle.shutdown(STOP_TIMEOUT);
                        return Err(message);
                    }
                }
            }
        };
        match outcome {
            Some(Ok(())) if lock(&self.shared).generation == generation => {
                *slot = Some(handle);
                Ok(generation)
            }
            Some(Err(message)) => {
                let message = fail(&message);
                handle.shutdown(STOP_TIMEOUT);
                Err(message)
            }
            _ => {
                handle.shutdown(STOP_TIMEOUT);
                Err("The tuner was stopped.".into())
            }
        }
    }

    pub fn start(&self, input_id: Option<String>) -> Result<u64, String> {
        #[cfg(feature = "desktop-test")]
        if input_id.as_deref() == Some(TEST_TONE_ID) {
            return match test_tone_frequencies() {
                Some(frequencies) => self.start_source(Source::Tone(frequencies)),
                None => Err("The selected audio input is unavailable.".into()),
            };
        }
        self.start_source(Source::Device(input_id))
    }

    /// Stops whatever is running. Idempotent, and it returns within about half a second whatever
    /// the audio driver is doing: it never waits behind a start in progress (which notices and
    /// gives up), and a capture thread that will not finish in time is left to end by itself.
    pub fn stop(&self) {
        self.stop_session(None);
    }

    /// Like `stop`, but only if `session` is `None` or is the session of the latest start, so a
    /// stale panel cannot stop a capture it did not start.
    pub fn stop_session(&self, session: Option<u64>) {
        if session.is_some_and(|s| s != self.session.load(Ordering::Acquire)) {
            return;
        }
        let deadline = Instant::now() + STOP_BUDGET;
        let reset = |generation: Option<u64>| {
            let mut state = lock(&self.shared);
            if generation.is_none_or(|g| state.generation == g) {
                let next = state.generation + 1;
                *state = Shared::fresh(next, false);
                Some(next)
            } else {
                None
            }
        };
        // First, so a start in progress notices it was overtaken and stale threads go quiet.
        let generation = reset(None);
        let handle = loop {
            match self.capture.try_lock() {
                Ok(mut slot) => break slot.take(),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    break poisoned.into_inner().take();
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        break None;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        };
        if let Some(handle) = handle {
            handle.shutdown(deadline.saturating_duration_since(Instant::now()));
        }
        // Unless a newer start has begun in the meantime.
        reset(generation);
    }

    /// One entry per requested target. At most 12 are measured; a target that is not finite or
    /// is outside 20 to 5000 Hz, or lies past the twelfth, reads as `None`.
    pub fn read(&self, strings: Vec<f64>) -> Result<TunerReading, String> {
        let wanted: Vec<f64> = strings
            .iter()
            .take(MAX_TARGETS)
            .map(|&f| {
                if (MIN_TARGET_HZ..=MAX_TARGET_HZ).contains(&f) {
                    f
                } else {
                    0.0
                }
            })
            .collect();
        let mut state = lock(&self.shared);
        if state.wanted != wanted {
            state.wanted = wanted.clone();
        }
        // Measurements made for other targets are not valid answers; they arrive next pass.
        let mut measured = if state.analysed == wanted {
            state.strings.clone()
        } else {
            vec![None; wanted.len()]
        };
        measured.resize(strings.len(), None);
        Ok(TunerReading {
            running: state.running || state.starting,
            error: state.error.clone(),
            level: state.level,
            pitch: state.pitch,
            strings: measured,
        })
    }
}
/// Test-tone frequencies from `TABPLAYER_TUNER_TEST_TONE`, only in a desktop-test run.
#[cfg(feature = "desktop-test")]
fn test_tone_frequencies() -> Option<Vec<f64>> {
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() != Ok("1") {
        return None;
    }
    parse_tone_list(&std::env::var("TABPLAYER_TUNER_TEST_TONE").ok()?)
}

#[cfg(any(test, feature = "desktop-test"))]
fn parse_tone_list(list: &str) -> Option<Vec<f64>> {
    let frequencies = list
        .split(',')
        .map(|part| part.trim().parse::<f64>().ok())
        .collect::<Option<Vec<f64>>>()?;
    (!frequencies.is_empty() && detect::validate_targets(&frequencies).is_ok())
        .then_some(frequencies)
}

#[tauri::command]
pub async fn tuner_inputs() -> Result<Vec<TunerInput>, String> {
    tauri::async_runtime::spawn_blocking(list_inputs)
        .await
        .map_err(|_| "Could not list audio inputs.".to_string())?
}

#[tauri::command]
pub async fn tuner_start(
    state: tauri::State<'_, TunerState>,
    input_id: Option<String>,
) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.start(input_id))
        .await
        .map_err(|_| "Could not start the tuner.".to_string())?
}

#[tauri::command]
pub async fn tuner_stop(
    state: tauri::State<'_, TunerState>,
    session: Option<u64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.stop_session(session))
        .await
        .map_err(|_| "Could not stop the tuner.".to_string())
}

#[tauri::command]
pub fn tuner_read(
    state: tauri::State<'_, TunerState>,
    strings: Vec<f64>,
) -> Result<TunerReading, String> {
    state.read(strings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_input::capture_block;

    fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(value) = probe() {
                return value;
            }
            assert!(Instant::now() < deadline, "timed out");
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn cents(measured: f64, expected: f64) -> f64 {
        1200.0 * (measured / expected).log2()
    }

    fn capture(data: &[f32], channels: usize, chosen: &mut usize) -> Vec<f32> {
        let (mut producer, mut consumer) = HeapRb::<f32>::new(4096).split();
        capture_block(data, channels, &mut producer, chosen);
        let mut out = vec![0.0f32; 4096];
        let count = consumer.pop_slice(&mut out);
        out.truncate(count);
        out
    }

    #[test]
    fn reading_before_start_is_idle() {
        let state = TunerState::default();
        let reading = state.read(vec![110.0, 82.41]).unwrap();
        assert!(!reading.running);
        assert_eq!(reading.error, None);
        assert_eq!(reading.level, SILENT_DBFS);
        assert_eq!(reading.pitch, None);
        assert_eq!(reading.strings, vec![None, None]);
    }

    #[test]
    fn a_bad_target_does_not_fail_the_reading() {
        let state = TunerState::default();
        for strings in [
            vec![f64::NAN, 110.0],
            vec![10.0, 6000.0, f64::INFINITY, f64::NEG_INFINITY],
            vec![100.0; 13],
            vec![100.0; 40],
            vec![],
        ] {
            let reading = state.read(strings.clone()).unwrap();
            assert_eq!(reading.strings.len(), strings.len());
        }
    }

    #[test]
    fn only_the_first_twelve_targets_are_used() {
        let state = TunerState::default();
        state.read(vec![110.0; 20]).unwrap();
        assert_eq!(lock(&state.shared).wanted.len(), 12);
        let reading = state
            .read([vec![f64::NAN], vec![110.0; 14]].concat())
            .unwrap();
        assert_eq!(reading.strings.len(), 15);
        assert_eq!(lock(&state.shared).wanted[0], 0.0);
    }

    #[test]
    fn stop_is_idempotent() {
        let state = TunerState::default();
        state.stop();
        state.stop();
    }

    #[test]
    fn capture_takes_the_loudest_channel_and_drops_when_full() {
        let mut chosen = 0;
        // Channel 1 carries the signal; channel 0 is nearly silent.
        let block = [0.001, 0.5, 0.0, -0.25, 0.001, 0.125];
        assert_eq!(capture(&block, 2, &mut chosen), vec![0.5, -0.25, 0.125]);
        assert_eq!(chosen, 1);
        let (mut producer, mut consumer) = HeapRb::<f32>::new(2).split();
        capture_block(&[0.1f32, 0.2, 0.3, 0.4], 1, &mut producer, &mut 0);
        let mut out = [0.0f32; 8];
        assert_eq!(consumer.pop_slice(&mut out), 2);
    }

    #[test]
    fn capture_keeps_a_channel_until_another_is_clearly_louder() {
        let mut chosen = 1;
        // Channel 0 is 3 dB louder: not enough to switch.
        assert_eq!(
            capture(&[0.7, 0.5, 0.7, 0.5], 2, &mut chosen),
            vec![0.5, 0.5]
        );
        assert_eq!(chosen, 1);
        // Channel 0 is now 12 dB louder.
        assert_eq!(
            capture(&[0.8, 0.2, 0.8, 0.2], 2, &mut chosen),
            vec![0.8, 0.8]
        );
        assert_eq!(chosen, 0);
    }

    #[test]
    fn one_guitar_on_a_many_channel_interface_keeps_its_level() {
        for channels in [8usize, 32, 64, 80] {
            let mut data = vec![0.0f32; channels * 100];
            for frame in 0..100 {
                data[frame * channels + 3] = 0.4;
            }
            let mut chosen = 0;
            let out = capture(&data, channels, &mut chosen);
            assert_eq!(out, vec![0.4; 100], "{channels} channels");
        }
        // Past the 64 examined channels the first is used.
        let mut data = vec![0.0f32; 80 * 4];
        for frame in 0..4 {
            data[frame * 80 + 70] = 0.9;
            data[frame * 80] = 0.1;
        }
        assert_eq!(capture(&data, 80, &mut 0), vec![0.1; 4]);
    }

    #[test]
    fn capture_converts_integers_and_sanitizes() {
        let (mut producer, mut consumer) = HeapRb::<f32>::new(16).split();
        capture_block(&[i16::MAX, i16::MIN, 0], 1, &mut producer, &mut 0);
        capture_block(&[f32::NAN, f32::INFINITY], 1, &mut producer, &mut 0);
        let mut out = [9.0f32; 8];
        assert_eq!(consumer.pop_slice(&mut out), 5);
        assert!(out[0] > 0.999 && out[1] <= -0.999 && out[2] == 0.0);
        assert_eq!(&out[3..5], &[0.0, 0.0]);
    }

    #[test]
    fn stream_fault_ignores_benign_kinds() {
        let fault = StreamFault::default();
        for kind in [
            cpal::ErrorKind::DeviceChanged,
            cpal::ErrorKind::Xrun,
            cpal::ErrorKind::RealtimeDenied,
            cpal::ErrorKind::DeviceBusy,
        ] {
            fault.note(kind);
            assert_eq!(fault.message(), None);
        }
        fault.note(cpal::ErrorKind::PermissionDenied);
        assert!(fault.message().unwrap().contains("denied"));
        // The first failure wins.
        fault.note(cpal::ErrorKind::DeviceNotAvailable);
        assert!(fault.message().unwrap().contains("denied"));
    }

    #[test]
    fn tone_list_parsing() {
        assert_eq!(parse_tone_list("110"), Some(vec![110.0]));
        assert_eq!(
            parse_tone_list(" 82.41, 110 ,196"),
            Some(vec![82.41, 110.0, 196.0])
        );
        assert_eq!(parse_tone_list(""), None);
        assert_eq!(parse_tone_list("110,,196"), None);
        assert_eq!(parse_tone_list("abc"), None);
        assert_eq!(parse_tone_list("10"), None);
        assert_eq!(parse_tone_list("NaN"), None);
        assert_eq!(parse_tone_list(&["100"; 13].join(",")), None);
    }

    #[test]
    fn test_tone_flows_through_ring_worker_and_read() {
        let state = TunerState::default();
        state.start_source(Source::Tone(vec![110.0])).unwrap();
        let reading = wait_for(|| {
            let reading = state.read(vec![]).unwrap();
            reading.pitch.is_some().then_some(reading)
        });
        assert!(reading.running && reading.error.is_none());
        assert!(reading.level > -40.0 && reading.level < 0.0);
        assert!(cents(reading.pitch.unwrap().frequency, 110.0).abs() <= 1.0);
        // Polyphonic mode switches YIN off but reports the strings.
        let reading = wait_for(|| {
            let reading = state.read(vec![110.0, 196.0]).unwrap();
            reading.strings[0].is_some().then_some(reading)
        });
        assert_eq!(reading.pitch, None);
        assert!(cents(reading.strings[0].unwrap(), 110.0).abs() <= 3.0);
        assert_eq!(reading.strings[1], None);
        // Restarting replaces the capture; stopping clears the reading.
        state.start_source(Source::Tone(vec![196.0])).unwrap();
        let reading = wait_for(|| {
            let reading = state.read(vec![]).unwrap();
            reading
                .pitch
                .filter(|p| cents(p.frequency, 196.0).abs() <= 1.0)
        });
        assert!(reading.clarity > 0.8);
        state.stop();
        let reading = state.read(vec![]).unwrap();
        assert!(!reading.running);
        assert_eq!(reading.pitch, None);
        assert_eq!(reading.level, SILENT_DBFS);
    }

    #[test]
    fn test_tone_chord_reports_each_string() {
        let state = TunerState::default();
        let targets = [82.4069, 110.0, 146.8324];
        state.start_source(Source::Tone(targets.to_vec())).unwrap();
        let strings = wait_for(|| {
            let reading = state.read(targets.to_vec()).unwrap();
            reading
                .strings
                .iter()
                .all(Option::is_some)
                .then_some(reading.strings)
        });
        for (measured, target) in strings.iter().zip(targets) {
            assert!(cents(measured.unwrap(), target).abs() <= 3.0);
        }
        state.stop();
    }

    #[test]
    fn a_failed_start_leaves_the_tuner_stopped() {
        let state = TunerState::default();
        let error = state
            .start_source(Source::Device(Some("no-such-input".into())))
            .unwrap_err();
        assert!(!error.is_empty());
        let reading = state.read(vec![]).unwrap();
        assert!(!reading.running);
    }

    #[test]
    fn a_restart_never_reads_as_stopped() {
        let state = TunerState::default();
        state.start_source(Source::Tone(vec![110.0])).unwrap();
        assert!(state.read(vec![]).unwrap().running);
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watcher = {
            let state = state.clone();
            let flag = done.clone();
            thread::spawn(move || {
                let mut polls = 0u32;
                while !flag.load(Ordering::Acquire) {
                    assert!(state.read(vec![]).unwrap().running, "poll {polls}");
                    polls += 1;
                    thread::sleep(Duration::from_millis(2));
                }
                polls
            })
        };
        // The new input takes a while to open.
        state
            .start_source(Source::Silent {
                delay: Duration::from_millis(400),
            })
            .unwrap();
        done.store(true, Ordering::Release);
        assert!(watcher.join().unwrap() > 20);
        state.stop();
        assert!(!state.read(vec![]).unwrap().running);
    }

    #[test]
    fn a_failed_restart_reports_stopped() {
        let state = TunerState::default();
        state.start_source(Source::Tone(vec![110.0])).unwrap();
        assert!(
            state
                .start_source(Source::Device(Some("no-such-input".into())))
                .is_err()
        );
        assert!(!state.read(vec![]).unwrap().running);
    }

    #[test]
    fn a_hung_start_times_out_and_stop_does_not_block() {
        let state = TunerState {
            start_timeout: Duration::from_millis(150),
            ..TunerState::default()
        };
        let began = Instant::now();
        let error = state
            .start_source(Source::Silent {
                delay: Duration::from_secs(30),
            })
            .unwrap_err();
        assert!(error.contains("did not start"), "{error}");
        // The hung thread is abandoned after the stop timeout, not waited for.
        assert!(began.elapsed() < STOP_TIMEOUT + Duration::from_secs(2));
        let reading = state.read(vec![]).unwrap();
        assert!(!reading.running);
        let began = Instant::now();
        state.stop();
        assert!(began.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn a_stalled_input_reports_no_sound() {
        let state = TunerState::default();
        state
            .start_source(Source::Silent {
                delay: Duration::ZERO,
            })
            .unwrap();
        let reading = state.read(vec![]).unwrap();
        assert!(reading.running && reading.error.is_none());
        let reading = wait_for(|| {
            let reading = state.read(vec![]).unwrap();
            reading.error.is_some().then_some(reading)
        });
        assert_eq!(reading.error.as_deref(), Some(NO_SOUND_MESSAGE));
        assert!(reading.running);
        state.stop();
    }

    #[test]
    fn a_thread_that_panics_reports_stopped_with_an_error() {
        let shared: SharedRef = Arc::new(Mutex::new(Shared::fresh(7, false)));
        lock(&shared).running = true;
        let moved = shared.clone();
        let result = thread::spawn(move || {
            let _guard = ThreadGuard::new(&moved, 7);
            panic!("worker failure");
        })
        .join();
        assert!(result.is_err());
        let state = lock(&shared);
        assert!(!state.running);
        assert_eq!(state.error.as_deref(), Some(UNEXPECTED_STOP_MESSAGE));
    }

    #[test]
    fn a_stale_thread_cannot_change_the_current_state() {
        let shared: SharedRef = Arc::new(Mutex::new(Shared::fresh(8, true)));
        drop(ThreadGuard::new(&shared, 7));
        let state = lock(&shared);
        assert!(state.starting && state.error.is_none());
    }

    #[test]
    fn a_string_that_drops_out_is_held_briefly() {
        let mut hold = StringHold::new();
        let wanted = [110.0, 196.0];
        assert_eq!(
            hold.apply(&wanted, vec![Some(110.2), None]),
            vec![Some(110.2), None]
        );
        // 110 vanishes for a while: shown for HOLD_PASSES more passes, then gone.
        for pass in 0..HOLD_PASSES {
            let shown = hold.apply(&wanted, vec![None, None]);
            assert_eq!(shown, vec![Some(110.2), None], "pass {pass}");
        }
        assert_eq!(hold.apply(&wanted, vec![None, None]), vec![None, None]);
        // A fresh measurement replaces and restarts the hold.
        assert_eq!(
            hold.apply(&wanted, vec![Some(109.9), Some(196.1)]),
            vec![Some(109.9), Some(196.1)]
        );
        assert_eq!(
            hold.apply(&wanted, vec![None, None]),
            vec![Some(109.9), Some(196.1)]
        );
        // Other targets, or a stalled input, drop everything held.
        assert_eq!(hold.apply(&[110.0], vec![None]), vec![None]);
        hold.apply(&[110.0], vec![Some(110.0)]);
        hold.clear();
        assert_eq!(hold.apply(&[110.0], vec![None]), vec![None]);
    }

    #[test]
    fn stop_with_a_stale_session_leaves_the_new_capture_running() {
        let state = TunerState::default();
        let first = state.start_source(Source::Tone(vec![110.0])).unwrap();
        let second = state.start_source(Source::Tone(vec![196.0])).unwrap();
        assert_ne!(first, second);
        state.stop_session(Some(first));
        assert!(state.read(vec![]).unwrap().running);
        assert!(lock(&state.capture).is_some());
        state.stop_session(Some(second));
        assert!(!state.read(vec![]).unwrap().running);
        assert!(lock(&state.capture).is_none());
        // None always stops.
        let third = state.start_source(Source::Tone(vec![110.0])).unwrap();
        assert!(third > second);
        state.stop_session(None);
        assert!(!state.read(vec![]).unwrap().running);
    }

    #[test]
    fn a_failed_start_gives_no_session_and_stop_by_it_is_harmless() {
        let state = TunerState::default();
        assert!(
            state
                .start_source(Source::Device(Some("no-such-input".into())))
                .is_err()
        );
        state.stop_session(Some(999));
        state.stop_session(None);
    }

    #[test]
    fn stop_does_not_wait_for_a_start_in_progress() {
        let state = TunerState::default();
        let starter = {
            let state = state.clone();
            thread::spawn(move || {
                state.start_source(Source::Silent {
                    delay: Duration::from_secs(20),
                })
            })
        };
        // Let the start get under way and hold the capture lock.
        wait_for(|| lock(&state.shared).starting.then_some(()));
        thread::sleep(Duration::from_millis(100));
        let began = Instant::now();
        state.stop();
        assert!(
            began.elapsed() < Duration::from_millis(900),
            "{:?}",
            began.elapsed()
        );
        assert!(!state.read(vec![]).unwrap().running);
        // The overtaken start gives up on its own, and without the 5 s timeout.
        let result = starter.join().unwrap();
        assert!(result.is_err());
        assert!(began.elapsed() < Duration::from_secs(3));
        assert!(!state.read(vec![]).unwrap().running);
    }

    #[test]
    fn a_restart_keeps_the_last_level() {
        let state = TunerState::default();
        state.start_source(Source::Tone(vec![110.0])).unwrap();
        let level = wait_for(|| {
            let level = state.read(vec![]).unwrap().level;
            (level > SILENT_DBFS).then_some(level)
        });
        // The new input is slow to open; meanwhile the display keeps the old level.
        let slow = {
            let state = state.clone();
            thread::spawn(move || {
                state.start_source(Source::Silent {
                    delay: Duration::from_millis(500),
                })
            })
        };
        wait_for(|| {
            let shared = lock(&state.shared);
            (shared.starting && shared.generation > 1).then_some(())
        });
        let reading = state.read(vec![]).unwrap();
        assert!(reading.running);
        assert_eq!(reading.level, level);
        slow.join().unwrap().unwrap();
        state.stop();
        assert_eq!(state.read(vec![]).unwrap().level, SILENT_DBFS);
    }
}
