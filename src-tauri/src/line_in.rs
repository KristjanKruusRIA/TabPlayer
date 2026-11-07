//! Line-In monitoring, control side: the capture thread, the session rules and the commands.
//!
//! A guitar on an audio input is heard live through the application's output, processed by its
//! own sound chain (see `audio::line_in` for the signal path). This module owns the input stream
//! (on a thread of its own, since cpal streams are not `Send` on Windows), starts and stops it
//! with the same session rules as the tuner, and reports its status. The sound and level live in
//! `AudioService`, not here, and never belong to a score.
use crate::{
    audio::line_in::{LineInMeter, LineInOutput, LineInSettings, MonitorRing, monitor_channel},
    audio_input::{
        AudioInput, CAPTURE_POLL, CaptureHandle, STOP_TIMEOUT, StreamFault, build_stream,
        choose_input, list_devices,
    },
    runtime::NativeAudio,
};
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
use tauri::{AppHandle, Manager};

/// How long a device may take to open (a permission prompt, a slow driver) before giving up.
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a start in progress checks that it has not been overtaken by a stop.
const START_POLL: Duration = Duration::from_millis(50);
/// The most `stop` takes in all, including waiting for a start in progress to let go.
const STOP_BUDGET: Duration = Duration::from_millis(500);
const UNEXPECTED_STOP_MESSAGE: &str = "Line-In stopped unexpectedly.";
const SILENT_DBFS: f32 = -120.0;
#[cfg(feature = "desktop-test")]
const TEST_TONE_ID: &str = "test-tone";
#[cfg(any(test, feature = "desktop-test"))]
const TEST_TONE_RATE: f64 = 48_000.0;
#[cfg(any(test, feature = "desktop-test"))]
const TEST_TONE_AMPLITUDE: f64 = 0.35;

/// What the interface shows. The levels are dBFS of the peak since the previous status call.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineInStatus {
    pub running: bool,
    pub error: Option<String>,
    /// Peak of the captured input, -120 when silent or not running.
    pub input_level: f32,
    /// Peak of the Line-In as it enters the output (after its sound and level), -120 when silent.
    pub output_level: f32,
    /// Delay from the input to the output in milliseconds: the buffered input, the resampler,
    /// the decimation filter of a fast device and the output stream's buffer. The input
    /// device's own buffer is not reported by the audio backend and is not included. None
    /// while the buffer is still filling.
    pub latency_ms: Option<f64>,
    /// The input device's sample rate.
    pub input_rate: Option<u32>,
    /// The output stream's sample rate, once one is open.
    pub output_rate: Option<u32>,
    /// Times the buffer ran dry and the sound faded out to refill.
    pub underruns: u32,
    /// Times the buffer overran and the monitor skipped ahead.
    pub skips: u32,
    /// Input samples dropped because the buffer was full.
    pub dropped: u32,
    /// Times the sound chain went bad (a non-finite value in its state) and was replaced.
    pub resets: u32,
}

struct Capture {
    device_rate: f64,
    ring: Arc<MonitorRing>,
    meter: Arc<LineInMeter>,
}

struct Shared {
    /// Bumped by every start and stop. A thread publishes only while its own generation is
    /// current, so a capture that was replaced (or is hung and was abandoned) cannot overwrite
    /// the new one's state.
    generation: u64,
    starting: bool,
    running: bool,
    error: Option<String>,
    capture: Option<Capture>,
}

impl Shared {
    fn fresh(generation: u64, starting: bool) -> Self {
        Self {
            generation,
            starting,
            running: false,
            error: None,
            capture: None,
        }
    }
}

type SharedRef = Arc<Mutex<Shared>>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn publish(shared: &SharedRef, generation: u64, change: impl FnOnce(&mut Shared)) -> bool {
    let mut state = lock(shared);
    if state.generation != generation {
        return false;
    }
    change(&mut state);
    true
}

/// Clears the running flag however a capture thread ends, and reports an end nobody asked for.
struct ThreadGuard {
    shared: SharedRef,
    generation: u64,
    clean: bool,
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

enum Source {
    Device(Option<String>),
    /// A pure sine at `frequency` Hz, paced in real time.
    #[cfg(any(test, feature = "desktop-test"))]
    Tone(f64),
    /// Opens after `delay`, then never delivers a sample.
    #[cfg(test)]
    Silent {
        delay: Duration,
    },
}

#[cfg(any(test, feature = "desktop-test"))]
struct ToneSynth {
    phase: f64,
    step: f64,
}

#[cfg(any(test, feature = "desktop-test"))]
impl ToneSynth {
    fn fill(&mut self, out: &mut [f32]) {
        for slot in out {
            *slot = (TEST_TONE_AMPLITUDE * (std::f64::consts::TAU * self.phase).sin()) as f32;
            self.phase = (self.phase + self.step).fract();
        }
    }
}

enum Live {
    /// Held only so the stream keeps running until it is dropped.
    #[allow(dead_code)]
    Stream(cpal::Stream),
    #[cfg(any(test, feature = "desktop-test"))]
    Tone(ToneSynth, crate::audio::line_in::LineInProducer),
    #[cfg(test)]
    #[allow(dead_code)]
    Idle(crate::audio::line_in::LineInProducer),
}

type Ready = Result<(Arc<MonitorRing>, Arc<LineInMeter>), String>;

fn capture_main(
    source: Source,
    shared: SharedRef,
    generation: u64,
    stop: mpsc::Receiver<()>,
    ready: mpsc::Sender<Ready>,
    // Dropped when the thread ends, which is how `CaptureHandle` learns it has finished.
    _finished: mpsc::Sender<()>,
) {
    let mut guard = ThreadGuard {
        shared: shared.clone(),
        generation,
        clean: false,
    };
    let fault = Arc::new(StreamFault::default());
    let opened = match &source {
        Source::Device(id) => choose_input(id.as_deref()).map(|(device, config)| {
            (
                Some((device, config.clone())),
                f64::from(config.sample_rate()),
            )
        }),
        #[cfg(any(test, feature = "desktop-test"))]
        Source::Tone(_) => Ok((None, TEST_TONE_RATE)),
        #[cfg(test)]
        Source::Silent { delay } => {
            thread::sleep(*delay);
            Ok((None, TEST_TONE_RATE))
        }
    };
    let (device_config, device_rate) = match opened {
        Ok(opened) => opened,
        Err(message) => {
            guard.clean = true;
            let _ = ready.send(Err(message));
            return;
        }
    };
    let (producer, ring, meter) = monitor_channel(device_rate);
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
        (Source::Tone(frequency), _) => Live::Tone(
            ToneSynth {
                phase: 0.0,
                step: frequency / TEST_TONE_RATE,
            },
            producer,
        ),
        #[cfg(test)]
        (Source::Silent { .. }, _) => Live::Idle(producer),
        (Source::Device(_), None) => unreachable!("a device source always opens a device"),
    };
    // A stop (or a newer start) that arrived while the device was opening wins.
    let current = publish(&shared, generation, |state| {
        state.running = true;
        state.starting = false;
        state.error = None;
        state.capture = Some(Capture {
            device_rate,
            ring: ring.clone(),
            meter: meter.clone(),
        });
    });
    let mut asked_to_stop = !current;
    if current {
        let _ = ready.send(Ok((ring, meter)));
        asked_to_stop = run_capture(live, &fault, &stop);
    } else {
        let _ = ready.send(Err("Line-In was stopped.".into()));
    }
    if let Some(message) = fault.message() {
        publish(&shared, generation, |state| {
            state.error = Some(message.into());
        });
        asked_to_stop = true;
    }
    guard.clean = asked_to_stop;
}

/// Holds the stream (or feeds the test source) until told to stop or the stream fails. True when
/// it was told to stop.
fn run_capture(live: Live, fault: &StreamFault, stop: &mpsc::Receiver<()>) -> bool {
    let mut stopped = false;
    #[cfg_attr(not(any(test, feature = "desktop-test")), allow(unused_mut))]
    let mut live = live;
    #[cfg(any(test, feature = "desktop-test"))]
    let started = Instant::now();
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
        if fault.message().is_some() {
            break;
        }
        #[cfg(any(test, feature = "desktop-test"))]
        if let Live::Tone(synth, producer) = &mut live {
            use crate::audio_input::SampleSink;
            // Real-time pacing: generate whatever the elapsed time says is due.
            let due = (started.elapsed().as_secs_f64() * TEST_TONE_RATE) as u64;
            let mut chunk = [0.0f32; 256];
            while produced < due {
                let count = ((due - produced) as usize).min(chunk.len());
                synth.fill(&mut chunk[..count]);
                producer.push_samples(&chunk[..count]);
                produced += count as u64;
            }
        }
    }
    // Stop the stream first so nothing writes while the rest winds down.
    drop(live);
    stopped
}

/// The Line-In's managed state. Cloning shares it, so blocking work can move to another thread.
#[derive(Clone)]
pub struct LineInState {
    shared: SharedRef,
    capture: Arc<Mutex<Option<CaptureHandle>>>,
    /// The session number of the latest successful or pending start.
    session: Arc<AtomicU64>,
    start_timeout: Duration,
}

impl Default for LineInState {
    fn default() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared::fresh(0, false))),
            capture: Arc::new(Mutex::new(None)),
            session: Arc::new(AtomicU64::new(0)),
            start_timeout: START_TIMEOUT,
        }
    }
}

fn dbfs(peak: f32) -> f32 {
    if peak > 1e-6 {
        (20.0 * peak.log10()).max(SILENT_DBFS)
    } else {
        SILENT_DBFS
    }
}

impl LineInState {
    /// Starts capturing into `output` and returns the session number to pass to `stop_session`.
    /// Opens the output stream if no score has yet. Any Line-In already running is replaced.
    fn start_source(&self, output: &dyn LineInOutput, source: Source) -> Result<u64, String> {
        let mut slot = lock(&self.capture);
        let generation = {
            let mut state = lock(&self.shared);
            let generation = state.generation + 1;
            *state = Shared::fresh(generation, true);
            generation
        };
        self.session.store(generation, Ordering::Release);
        if let Some(old) = slot.take() {
            old.shutdown(STOP_TIMEOUT);
        }
        output.detach();
        let fail = |message: &str| {
            let mut state = lock(&self.shared);
            if state.generation == generation {
                // Whatever this start left behind can no longer publish.
                *state = Shared::fresh(generation + 1, false);
            }
            message.to_string()
        };
        if let Err(message) = output.prepare_output() {
            return Err(fail(&message));
        }
        // Opening the output can take a while; a stop that came meanwhile must not open the input.
        if lock(&self.shared).generation != generation {
            return Err(fail("Line-In was stopped."));
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let shared = self.shared.clone();
        let thread: JoinHandle<()> = match thread::Builder::new()
            .name("line-in-capture".into())
            .spawn(move || capture_main(source, shared, generation, stop_rx, ready_tx, finished_tx))
        {
            Ok(thread) => thread,
            Err(_) => return Err(fail("Could not start Line-In.")),
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
            Some(Ok((ring, meter))) if lock(&self.shared).generation == generation => {
                if let Err(message) = output.attach(ring, meter) {
                    let message = fail(&message);
                    handle.shutdown(STOP_TIMEOUT);
                    return Err(message);
                }
                // A stop that landed between the check and the attach.
                if lock(&self.shared).generation != generation {
                    output.detach();
                    handle.shutdown(STOP_TIMEOUT);
                    return Err("Line-In was stopped.".into());
                }
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
                Err("Line-In was stopped.".into())
            }
        }
    }

    pub fn start(
        &self,
        output: &dyn LineInOutput,
        input_id: Option<String>,
    ) -> Result<u64, String> {
        #[cfg(feature = "desktop-test")]
        if input_id.as_deref() == Some(TEST_TONE_ID) {
            return match test_tone_frequency() {
                Some(frequency) => self.start_source(output, Source::Tone(frequency)),
                None => Err("The selected audio input is unavailable.".into()),
            };
        }
        self.start_source(output, Source::Device(input_id))
    }

    pub fn stop(&self, output: &dyn LineInOutput) {
        self.stop_session(output, None);
    }

    /// Stops whatever is running, if `session` is `None` or is the session of the latest start,
    /// so a stale panel cannot stop a capture it did not start. Idempotent, and it returns within
    /// about half a second whatever the audio driver is doing.
    pub fn stop_session(&self, output: &dyn LineInOutput, session: Option<u64>) {
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
        if reset(generation).is_some() {
            output.detach();
        }
    }

    pub fn status(&self, output: &dyn LineInOutput) -> LineInStatus {
        // Anything the output could not take earlier, and a sound chain that went bad.
        output.resync();
        let (running, error, capture, generation) = {
            let state = lock(&self.shared);
            let running = state.running || state.starting;
            let capture = state.capture.as_ref().map(|capture| {
                (
                    capture.device_rate,
                    capture.ring.clone(),
                    capture.meter.clone(),
                )
            });
            (running, state.error.clone(), capture, state.generation)
        };
        let output_rate = output.output_rate();
        let Some((device_rate, ring, meter)) = capture else {
            return LineInStatus {
                running,
                error,
                input_level: SILENT_DBFS,
                output_level: SILENT_DBFS,
                latency_ms: None,
                input_rate: None,
                output_rate,
                underruns: 0,
                skips: 0,
                dropped: 0,
                resets: 0,
            };
        };
        if !running {
            // The capture ended by itself (the device went away): let the output let go of it. A
            // start holds the capture slot from beginning to end, so with the slot in hand and
            // the generation unchanged nothing newer can be attached and let go by mistake; if a
            // start or stop is under way the next status call does it.
            if let Ok(_slot) = self.capture.try_lock() {
                let mut state = lock(&self.shared);
                if state.generation == generation {
                    state.capture = None;
                    drop(state);
                    output.detach();
                }
            }
        }
        let (input_peak, output_peak) = meter.take_peaks();
        let latency_ms = meter.fill().filter(|_| running).map(|fill| {
            let ring_rate = ring.rate();
            // The fill, the interpolator's two samples, and the decimation filter.
            let mut seconds = (f64::from(fill) + 2.0) / ring_rate + meter.producer_delay();
            if let (Some(frames), Some(rate)) = (output.buffer_frames(), output_rate) {
                seconds += f64::from(frames) / f64::from(rate);
            }
            (seconds * 10_000.0).round() / 10.0
        });
        LineInStatus {
            running,
            error,
            input_level: dbfs(input_peak),
            output_level: dbfs(output_peak),
            latency_ms,
            input_rate: Some(device_rate.round() as u32),
            output_rate,
            underruns: meter.underruns(),
            skips: meter.skips(),
            dropped: ring.dropped(),
            resets: meter.resets(),
        }
    }
}

/// Test-tone frequency from `TABPLAYER_LINE_IN_TEST_TONE`, only in a desktop-test run.
#[cfg(feature = "desktop-test")]
fn test_tone_frequency() -> Option<f64> {
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() != Ok("1") {
        return None;
    }
    let frequency: f64 = std::env::var("TABPLAYER_LINE_IN_TEST_TONE")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    (20.0..=5_000.0).contains(&frequency).then_some(frequency)
}

/// The system's audio inputs (the same list the tuner shows).
pub fn list_inputs() -> Result<Vec<AudioInput>, String> {
    #[cfg_attr(not(feature = "desktop-test"), allow(unused_mut))]
    let mut inputs = list_devices()?;
    #[cfg(feature = "desktop-test")]
    if test_tone_frequency().is_some() {
        inputs.push(AudioInput {
            id: TEST_TONE_ID.into(),
            name: "Test tone".into(),
            default: false,
        });
    }
    Ok(inputs)
}

#[tauri::command]
pub async fn line_in_inputs() -> Result<Vec<AudioInput>, String> {
    tauri::async_runtime::spawn_blocking(list_inputs)
        .await
        .map_err(|_| "Could not list audio inputs.".to_string())?
}

#[tauri::command]
pub async fn line_in_start(
    app: AppHandle,
    state: tauri::State<'_, LineInState>,
    input_id: Option<String>,
) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.start(&app.state::<NativeAudio>().service, input_id)
    })
    .await
    .map_err(|_| "Could not start Line-In.".to_string())?
}

#[tauri::command]
pub async fn line_in_stop(
    app: AppHandle,
    state: tauri::State<'_, LineInState>,
    session: Option<u64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.stop_session(&app.state::<NativeAudio>().service, session)
    })
    .await
    .map_err(|_| "Could not stop Line-In.".to_string())
}

/// Sets the Line-In's sound, level and monitor switch. Works whether or not it is running.
///
/// Changes are ordered by a ticket taken here, when the runtime first polls the handler and
/// before the work moves to another thread. That is normally the order the calls were made, but
/// the runtime does not promise it for calls made close together; the interface keeps one change
/// in flight, so it does not arise. Changes apply in ticket order, a stale one never overwrites
/// a newer one, and rapid changes are coalesced (only the latest has its sound chain built).
#[tauri::command]
pub async fn line_in_set(app: AppHandle, settings: LineInSettings) -> Result<(), String> {
    let ticket = app
        .state::<NativeAudio>()
        .service
        .line_in_ticket(&settings)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeAudio>()
            .service
            .line_in_apply(settings, ticket)
    })
    .await
    .map_err(|_| "Could not change Line-In.".to_string())?
}

#[tauri::command]
pub fn line_in_status(
    app: AppHandle,
    state: tauri::State<'_, LineInState>,
) -> Result<LineInStatus, String> {
    Ok(state.status(&app.state::<NativeAudio>().service))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{
        device::CallbackTransport,
        line_in::{LineInControl, LineInMonitor},
    };
    use std::sync::atomic::AtomicU32;

    /// An output that does what `AudioService` does for the Line-In, onto a headless transport.
    struct FakeOutput {
        rate: u32,
        control: Mutex<Option<LineInControl>>,
        settings: Mutex<LineInSettings>,
        refuse: bool,
        prepares: AtomicU32,
        attaches: AtomicU32,
        detaches: AtomicU32,
    }

    impl FakeOutput {
        fn build(rate: u32, refuse: bool, control: Option<LineInControl>) -> Arc<Self> {
            Arc::new(Self {
                rate,
                control: Mutex::new(control),
                settings: Mutex::new(LineInSettings::default()),
                refuse,
                prepares: AtomicU32::new(0),
                attaches: AtomicU32::new(0),
                detaches: AtomicU32::new(0),
            })
        }
        fn new(rate: u32) -> (Arc<Self>, CallbackTransport) {
            let (transport, control) = CallbackTransport::headless_with_line_in(rate);
            (Self::build(rate, false, Some(control)), transport)
        }
        fn refusing() -> Arc<Self> {
            Self::build(48_000, true, None)
        }
    }

    impl LineInOutput for FakeOutput {
        fn prepare_output(&self) -> Result<u32, String> {
            self.prepares.fetch_add(1, Ordering::Relaxed);
            if self.refuse {
                Err("No audio output device is available.".into())
            } else {
                Ok(self.rate)
            }
        }
        fn attach(&self, ring: Arc<MonitorRing>, meter: Arc<LineInMeter>) -> Result<(), String> {
            self.attaches.fetch_add(1, Ordering::Relaxed);
            let monitor =
                LineInMonitor::new(ring, meter, &self.settings.lock().unwrap(), self.rate)?;
            self.control
                .lock()
                .unwrap()
                .as_mut()
                .ok_or("Audio output is not ready.")?
                .attach(monitor)
        }
        fn detach(&self) {
            self.detaches.fetch_add(1, Ordering::Relaxed);
            if let Some(control) = self.control.lock().unwrap().as_mut() {
                let _ = control.detach();
            }
        }
        fn output_rate(&self) -> Option<u32> {
            Some(self.rate)
        }
        fn buffer_frames(&self) -> Option<u32> {
            Some(480)
        }
    }

    fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(value) = probe() {
                return value;
            }
            assert!(Instant::now() < deadline, "timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn zero_crossing_frequency(samples: &[f32], rate: f64) -> f64 {
        let mut first = None;
        let mut last = 0.0;
        let mut count = 0usize;
        for i in 1..samples.len() {
            if samples[i - 1] < 0.0 && samples[i] >= 0.0 {
                let at = i as f64 - 1.0 + (-samples[i - 1] / (samples[i] - samples[i - 1])) as f64;
                if first.is_none() {
                    first = Some(at);
                } else {
                    count += 1;
                }
                last = at;
            }
        }
        count as f64 * rate / (last - first.unwrap())
    }

    #[test]
    fn status_before_start_is_idle() {
        let (output, _transport) = FakeOutput::new(48_000);
        let status = LineInState::default().status(&*output);
        assert!(!status.running);
        assert_eq!(status.error, None);
        assert_eq!(status.input_level, SILENT_DBFS);
        assert_eq!(status.latency_ms, None);
        assert_eq!(status.input_rate, None);
        assert_eq!(status.output_rate, Some(48_000));
    }

    #[test]
    fn stop_is_idempotent() {
        let (output, _transport) = FakeOutput::new(48_000);
        let state = LineInState::default();
        state.stop(&*output);
        state.stop(&*output);
    }

    /// One run of the whole path against the wall clock: a capture thread paces a tone in real
    /// time, and this thread pulls the output as a stream would. Scheduling hiccups on a busy
    /// machine can starve it once, so `Err` carries what was wrong for a retry to report.
    fn tone_round_trip() -> Result<(), String> {
        macro_rules! ensure {
            ($condition:expr, $($message:tt)+) => {
                if !$condition {
                    return Err(format!($($message)+));
                }
            };
        }
        let (output, mut transport) = FakeOutput::new(44_100);
        let state = LineInState::default();
        state.start_source(&*output, Source::Tone(220.0))?;
        let mut captured = Vec::new();
        let started = Instant::now();
        let mut block = vec![[0.0f32; 2]; 441];
        let mut rendered = 0u64;
        while started.elapsed() < Duration::from_millis(3000) {
            // As many frames as the clock says the device has asked for by now.
            let due = (started.elapsed().as_secs_f64() * 44_100.0) as u64;
            while rendered < due {
                let count = ((due - rendered) as usize).min(block.len());
                transport.render_into(&mut block[..count]);
                captured.extend(block[..count].iter().map(|f| f[0]));
                rendered += count as u64;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let status = state.status(&*output);
        ensure!(status.running && status.error.is_none(), "{status:?}");
        ensure!(status.input_rate == Some(48_000), "{status:?}");
        ensure!(status.output_rate == Some(44_100), "{status:?}");
        // The default sound chain is flat, so the tone leaves at input amplitude times level.
        let tail = &captured[captured.len() - 44_100..];
        let peak = tail.iter().fold(0.0f32, |p, x| p.max(x.abs()));
        let expected: f32 = 0.35 * 0.8;
        ensure!((peak - expected).abs() < 0.02, "peak {peak}");
        let measured = zero_crossing_frequency(tail, 44_100.0);
        ensure!(
            (1200.0 * (measured / 220.0).log2()).abs() < 3.0,
            "frequency {measured}"
        );
        ensure!(
            (status.input_level - 20.0 * 0.35f32.log10()).abs() < 1.0,
            "{status:?}"
        );
        ensure!(
            (status.output_level - 20.0 * expected.log10()).abs() < 1.5,
            "{status:?}"
        );
        let latency = status.latency_ms.ok_or("no latency")?;
        ensure!((8.0..80.0).contains(&latency), "latency {latency}");
        state.stop(&*output);
        ensure!(!state.status(&*output).running, "still running");
        ensure!(output.detaches.load(Ordering::Relaxed) >= 1, "not detached");
        Ok(())
    }

    #[test]
    fn a_tone_flows_from_capture_to_the_output_at_the_expected_level() {
        // Up to three tries: the run depends on this machine's scheduler.
        let mut last = Ok(());
        for _ in 0..3 {
            last = tone_round_trip();
            if last.is_ok() {
                break;
            }
        }
        last.unwrap();
    }

    #[test]
    fn a_failed_start_leaves_line_in_stopped() {
        let (output, _transport) = FakeOutput::new(48_000);
        let state = LineInState::default();
        let error = state
            .start_source(&*output, Source::Device(Some("no-such-input".into())))
            .unwrap_err();
        assert!(!error.is_empty());
        assert!(!state.status(&*output).running);
        state.stop_session(&*output, Some(999));
        state.stop_session(&*output, None);
        assert_eq!(output.attaches.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn no_output_is_a_clear_error_and_starts_no_capture() {
        let output = FakeOutput::refusing();
        let state = LineInState::default();
        let error = state
            .start_source(&*output, Source::Tone(110.0))
            .unwrap_err();
        assert!(error.contains("output"), "{error}");
        assert!(!state.status(&*output).running);
        assert!(lock(&state.capture).is_none());
    }

    #[test]
    fn stop_with_a_stale_session_leaves_the_new_capture_running() {
        let (output, _transport) = FakeOutput::new(48_000);
        let state = LineInState::default();
        let first = state.start_source(&*output, Source::Tone(110.0)).unwrap();
        let second = state.start_source(&*output, Source::Tone(196.0)).unwrap();
        assert_ne!(first, second);
        state.stop_session(&*output, Some(first));
        assert!(state.status(&*output).running);
        assert!(lock(&state.capture).is_some());
        state.stop_session(&*output, Some(second));
        assert!(!state.status(&*output).running);
        assert!(lock(&state.capture).is_none());
        // None always stops.
        let third = state.start_source(&*output, Source::Tone(110.0)).unwrap();
        assert!(third > second);
        state.stop_session(&*output, None);
        assert!(!state.status(&*output).running);
    }

    #[test]
    fn a_restart_replaces_the_capture() {
        let (output, _transport) = FakeOutput::new(48_000);
        let state = LineInState::default();
        state.start_source(&*output, Source::Tone(110.0)).unwrap();
        state.start_source(&*output, Source::Tone(196.0)).unwrap();
        assert!(state.status(&*output).running);
        assert_eq!(output.attaches.load(Ordering::Relaxed), 2);
        state.stop(&*output);
    }

    #[test]
    fn a_hung_start_times_out_and_stop_does_not_block() {
        let (output, _transport) = FakeOutput::new(48_000);
        let state = LineInState {
            start_timeout: Duration::from_millis(150),
            ..LineInState::default()
        };
        let began = Instant::now();
        let error = state
            .start_source(
                &*output,
                Source::Silent {
                    delay: Duration::from_secs(30),
                },
            )
            .unwrap_err();
        assert!(error.contains("did not start"), "{error}");
        assert!(began.elapsed() < STOP_TIMEOUT + Duration::from_secs(2));
        assert!(!state.status(&*output).running);
        let began = Instant::now();
        state.stop(&*output);
        assert!(began.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn stop_does_not_wait_for_a_start_in_progress() {
        let (output, _transport) = FakeOutput::new(48_000);
        let state = LineInState::default();
        let starter = {
            let state = state.clone();
            let output = output.clone();
            thread::spawn(move || {
                state.start_source(
                    &*output,
                    Source::Silent {
                        delay: Duration::from_secs(20),
                    },
                )
            })
        };
        wait_for(|| lock(&state.shared).starting.then_some(()));
        thread::sleep(Duration::from_millis(100));
        let began = Instant::now();
        state.stop(&*output);
        assert!(began.elapsed() < Duration::from_millis(900));
        assert!(!state.status(&*output).running);
        assert!(starter.join().unwrap().is_err());
        assert!(began.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_thread_that_panics_reports_stopped_with_an_error() {
        let shared: SharedRef = Arc::new(Mutex::new(Shared::fresh(7, false)));
        lock(&shared).running = true;
        let moved = shared.clone();
        let result = thread::spawn(move || {
            let _guard = ThreadGuard {
                shared: moved,
                generation: 7,
                clean: false,
            };
            panic!("capture failure");
        })
        .join();
        assert!(result.is_err());
        let state = lock(&shared);
        assert!(!state.running);
        assert_eq!(state.error.as_deref(), Some(UNEXPECTED_STOP_MESSAGE));
    }

    #[test]
    fn a_capture_that_ended_by_itself_lets_the_output_go() {
        let (output, _transport) = FakeOutput::new(48_000);
        let state = LineInState::default();
        state.start_source(&*output, Source::Tone(110.0)).unwrap();
        let before = output.detaches.load(Ordering::Relaxed);
        // The thread ends without being asked.
        let generation = lock(&state.shared).generation;
        publish(&state.shared, generation, |s| {
            s.running = false;
            s.error = Some("The audio input was disconnected or became unavailable.".into());
        });
        let status = state.status(&*output);
        assert!(!status.running);
        assert!(status.error.is_some());
        assert_eq!(output.detaches.load(Ordering::Relaxed), before + 1);
        state.stop(&*output);
    }
}
