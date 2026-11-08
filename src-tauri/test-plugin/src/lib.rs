// A VST3 test plug-in for TabPlayer's plug-in hosting tests (THE-71).
//
// The COM plumbing (the class, the factory, the entry points and the bus code) is derived from `examples/gain.rs` of the
// `vst3` 0.3.0 crate (https://github.com/coupler-rs/vst3-rs, MIT OR Apache-2.0), used here under the MIT licence. Its
// licence text, which has no copyright line of its own, follows. The rest is TabPlayer's, under the licence in this
// crate's Cargo.toml.
//
//   Permission is hereby granted, free of charge, to any
//   person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the
//   Software without restriction, including without
//   limitation the rights to use, copy, modify, merge,
//   publish, distribute, sublicense, and/or sell copies of
//   the Software, and to permit persons to whom the Software
//   is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice
//   shall be included in all copies or substantial portions
//   of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
//   ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
//   TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//   SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
//   CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
//   IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.

//! "TabPlayer Test Gain": a stereo gain with an exact delay, a bounded plug-in state and switchable faults.
//!
//! The helper, the client and the end-to-end tests drive it through ordinary VST3 means only: four parameters
//! (see [`PARAM_GAIN`] and its siblings), the component state ([`encode_test_state`]) and, on Windows, an editor.
//! Six environment variables, read inside the process that hosts the plug-in, add the rest:
//! `TABPLAYER_TEST_PLUGIN_PRINT=1` makes it print to the console (Rust's and the C runtime's) when it loads and on every
//! block, to show that a host keeps plug-in output off its control pipe,
//! `TABPLAYER_TEST_PLUGIN_VIEW_MODAL_MS=<n>` makes the editor run a nested message loop for `n` milliseconds after it
//! attaches, as a licence dialog would,
//! `TABPLAYER_TEST_PLUGIN_HANG_FACTORY=1` blocks `GetPluginFactory` forever,
//! `TABPLAYER_TEST_PLUGIN_STATE_PADDING=<bytes>` makes `getState` pad the state to at least that many bytes of padding
//! (at most [`MAX_ENV_STATE_PADDING`]), `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1` stops the editor from reporting an edit
//! when it attaches, and `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=<n>` blocks the editor's thread for `n` milliseconds after
//! it attaches.
//!
//! It is a single class that is both the component and the edit controller, which VST3 allows. The probe therefore
//! sees exactly one class, [`TEST_CLASS_ID`].
//!
//! Latency changes are announced with `restartComponent(kLatencyChanged)` whichever way they arrive: the controller's
//! `setParamNormalized`, the processor's parameter queue in `process`, or `setState`. The decision is
//! [`needs_latency_restart`]: the plug-in remembers the latency the host last read (or was last told) and restarts
//! when the new one differs. The call comes from the thread that changed the latency, with no lock held, so a host
//! that re-reads `getLatencySamples` from inside it sees the new value.
//!
//! Everything a unit test needs is plain Rust: [`process_block`], [`DelayLine`], the state codec and the parameter
//! mapping. The COM part is tested in process by `com_tests`, which drives the factory, a Rust `IBStream` and a Rust
//! `IComponentHandler`.
#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
// The COM traits declare their methods `unsafe`, and every body in this file is one thin layer over raw pointers.
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use std::{ptr, slice};

use vst3::{Class, ComPtr, ComRef, ComWrapper, Steinberg::Vst::*, Steinberg::*};

#[cfg(windows)]
mod view;

/// The class ID of the plug-in: 32 uppercase hexadecimal characters, which are the 16 bytes of its `TUID` in order.
pub const TEST_CLASS_ID: &str = "7ABB1A7E57E5701C8E5700000000A001";

/// The name the plug-in registers under.
pub const TEST_PLUGIN_NAME: &str = "TabPlayer Test Gain";

/// The version the factory reports.
pub const TEST_PLUGIN_VERSION: &str = "0.1.0";

/// The largest latency, in frames: one second at 48 kHz. A bigger value in a state or a parameter is refused or clamped.
pub const MAX_LATENCY: u32 = 48_000;

/// The number of steps of the `edits` parameter. The count saturates there.
pub const MAX_EDITS: u32 = 1024;

/// The length of `Slow` when the mode parameter selects it. A state can carry any length.
pub const DEFAULT_SLOW_MS: u32 = 50;

/// Parameter 0: the gain, 0 to 1, shown as is.
pub const PARAM_GAIN: u32 = 0;
/// Parameter 1: the latency in frames, 0 to [`MAX_LATENCY`], one step per frame.
pub const PARAM_LATENCY: u32 = 1;
/// Parameter 2: the mode, one step per [`TestMode`] variant in declaration order. `Slow` takes [`DEFAULT_SLOW_MS`].
pub const PARAM_MODE: u32 = 2;
/// Parameter 3: how many times the editor has reported an edit, 0 to [`MAX_EDITS`].
pub const PARAM_EDITS: u32 = 3;
/// The number of parameters.
pub const PARAM_COUNT: u32 = 4;

/// The number of steps of the mode parameter: seven modes, so six steps.
const MODE_STEPS: u32 = 6;

/// How much state a `setState` reads before giving up on the stream. The helper's cap is 8 MiB; this leaves room for
/// the oversize tests and bounds a stream that never ends.
const MAX_STATE_READ: usize = 32 * 1024 * 1024;

/// The most padding `TABPLAYER_TEST_PLUGIN_STATE_PADDING` can ask for: 16 MiB, twice the helper's state cap.
pub const MAX_ENV_STATE_PADDING: u32 = 16 * 1024 * 1024;

/// The editor's size.
pub const EDITOR_WIDTH: i32 = 300;
pub const EDITOR_HEIGHT: i32 = 200;

const ENV_HANG_FACTORY: &str = "TABPLAYER_TEST_PLUGIN_HANG_FACTORY";
const ENV_PRINT: &str = "TABPLAYER_TEST_PLUGIN_PRINT";
#[cfg_attr(not(windows), allow(dead_code))]
const ENV_VIEW_MODAL_MS: &str = "TABPLAYER_TEST_PLUGIN_VIEW_MODAL_MS";
const ENV_STATE_PADDING: &str = "TABPLAYER_TEST_PLUGIN_STATE_PADDING";
#[cfg_attr(not(windows), allow(dead_code))]
const ENV_VIEW_NO_EDIT: &str = "TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT";
#[cfg_attr(not(windows), allow(dead_code))]
const ENV_VIEW_HANG_MS: &str = "TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS";

// ---------------------------------------------------------------------------------------------------------------
// State and the pure signal path
// ---------------------------------------------------------------------------------------------------------------

/// What the plug-in does on top of the gain and the delay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestMode {
    /// Gain and delay only.
    Normal,
    /// The next `process` call aborts the process.
    Crash,
    /// The next `process` call never returns.
    Hang,
    /// Every output sample is NaN.
    Nan,
    /// Every `process` call takes at least `ms` milliseconds.
    Slow { ms: u32 },
    /// `setState` never returns once it has read this mode, so a load hangs.
    HangOnLoad,
    /// `setState` returns `kResultFalse`.
    RejectState,
}

impl TestMode {
    /// The step of this mode on the mode parameter.
    fn index(self) -> u32 {
        match self {
            TestMode::Normal => 0,
            TestMode::Crash => 1,
            TestMode::Hang => 2,
            TestMode::Nan => 3,
            TestMode::Slow { .. } => 4,
            TestMode::HangOnLoad => 5,
            TestMode::RejectState => 6,
        }
    }

    fn name(self) -> &'static str {
        match self {
            TestMode::Normal => "Normal",
            TestMode::Crash => "Crash",
            TestMode::Hang => "Hang",
            TestMode::Nan => "NaN",
            TestMode::Slow { .. } => "Slow",
            TestMode::HangOnLoad => "Hang on load",
            TestMode::RejectState => "Reject state",
        }
    }

    /// The mode at a step of the mode parameter. `Slow` keeps the length of `current` when `current` is already `Slow`.
    fn from_index(index: u32, current: TestMode) -> TestMode {
        match index {
            0 => TestMode::Normal,
            1 => TestMode::Crash,
            2 => TestMode::Hang,
            3 => TestMode::Nan,
            4 => match current {
                TestMode::Slow { ms } => TestMode::Slow { ms },
                _ => TestMode::Slow {
                    ms: DEFAULT_SLOW_MS,
                },
            },
            5 => TestMode::HangOnLoad,
            _ => TestMode::RejectState,
        }
    }
}

/// Everything the plug-in remembers. This is also its component state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TestState {
    /// The output is the input times this.
    pub gain: f32,
    /// The delay in frames, at most [`MAX_LATENCY`]. `getLatencySamples` reports it.
    pub latency: u32,
    pub mode: TestMode,
    /// Zero bytes appended to the encoded state, to make it any size.
    pub padding: u32,
    /// How many edits the editor has reported.
    pub edits: u32,
}

impl Default for TestState {
    fn default() -> Self {
        TestState {
            gain: 1.0,
            latency: 0,
            mode: TestMode::Normal,
            padding: 0,
            edits: 0,
        }
    }
}

const STATE_MAGIC: [u8; 4] = *b"TPTS";
const STATE_VERSION: u16 = 1;
/// The length of an encoded state without padding: magic, version, gain, latency, mode tag, slow length, edits.
pub const STATE_BASE_LEN: usize = 4 + 2 + 4 + 4 + 1 + 4 + 4;

/// The component state: a fixed [`STATE_BASE_LEN`]-byte record followed by `state.padding` zero bytes, so the whole
/// state is `STATE_BASE_LEN + padding` bytes long. All numbers are little-endian.
pub fn encode_test_state(state: &TestState) -> Vec<u8> {
    let (tag, ms) = match state.mode {
        TestMode::Normal => (0u8, 0u32),
        TestMode::Crash => (1, 0),
        TestMode::Hang => (2, 0),
        TestMode::Nan => (3, 0),
        TestMode::Slow { ms } => (4, ms),
        TestMode::HangOnLoad => (5, 0),
        TestMode::RejectState => (6, 0),
    };
    let mut out = Vec::with_capacity(STATE_BASE_LEN + state.padding as usize);
    out.extend_from_slice(&STATE_MAGIC);
    out.extend_from_slice(&STATE_VERSION.to_le_bytes());
    out.extend_from_slice(&state.gain.to_le_bytes());
    out.extend_from_slice(&state.latency.to_le_bytes());
    out.push(tag);
    out.extend_from_slice(&ms.to_le_bytes());
    out.extend_from_slice(&state.edits.to_le_bytes());
    out.resize(STATE_BASE_LEN + state.padding as usize, 0);
    out
}

/// The inverse of [`encode_test_state`]. `None` for anything else: a wrong magic or version, a short record, a gain that
/// is not finite, a latency over [`MAX_LATENCY`], an edit count over [`MAX_EDITS`], an unknown mode, or trailing bytes
/// that are not all zero. The trailing bytes are the `padding`.
pub fn decode_test_state(bytes: &[u8]) -> Option<TestState> {
    if bytes.len() < STATE_BASE_LEN || bytes[..4] != STATE_MAGIC {
        return None;
    }
    let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let u32_at =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    if u16_at(4) != STATE_VERSION {
        return None;
    }
    let gain = f32::from_bits(u32_at(6));
    let latency = u32_at(10);
    let tag = bytes[14];
    let ms = u32_at(15);
    let edits = u32_at(19);
    if !gain.is_finite() || latency > MAX_LATENCY || edits > MAX_EDITS {
        return None;
    }
    let mode = match tag {
        0 => TestMode::Normal,
        1 => TestMode::Crash,
        2 => TestMode::Hang,
        3 => TestMode::Nan,
        4 => TestMode::Slow { ms },
        5 => TestMode::HangOnLoad,
        6 => TestMode::RejectState,
        _ => return None,
    };
    let tail = &bytes[STATE_BASE_LEN..];
    let padding = u32::try_from(tail.len()).ok()?;
    if tail.iter().any(|&b| b != 0) {
        return None;
    }
    Some(TestState {
        gain,
        latency,
        mode,
        padding,
        edits,
    })
}

/// The delay memory. It holds [`MAX_LATENCY`] + 1 stereo frames so any allowed latency fits, and it keeps its history
/// when the latency changes.
#[derive(Debug, Clone)]
pub struct DelayLine {
    frames: Vec<[f32; 2]>,
    write: usize,
}

impl DelayLine {
    pub fn new() -> DelayLine {
        DelayLine {
            frames: vec![[0.0; 2]; MAX_LATENCY as usize + 1],
            write: 0,
        }
    }

    /// Forgets everything: the next frames out are silence.
    pub fn clear(&mut self) {
        self.frames.fill([0.0; 2]);
        self.write = 0;
    }
}

impl Default for DelayLine {
    fn default() -> Self {
        DelayLine::new()
    }
}

/// Runs the plug-in over one block: the output is the input times `state.gain`, delayed by exactly `state.latency` frames.
/// In `Nan` mode every output sample is NaN instead. `input` and `output` should be the same length; if they differ, the
/// shorter one decides. The faults of the other modes are not here: they belong to the COM layer, so this stays pure.
pub fn process_block(
    state: &TestState,
    delay: &mut DelayLine,
    input: &[[f32; 2]],
    output: &mut [[f32; 2]],
) {
    let capacity = delay.frames.len();
    let latency = (state.latency.min(MAX_LATENCY)) as usize;
    for (out, frame) in output.iter_mut().zip(input) {
        delay.frames[delay.write] = *frame;
        let read = (delay.write + capacity - latency) % capacity;
        let delayed = delay.frames[read];
        *out = if state.mode == TestMode::Nan {
            [f32::NAN; 2]
        } else {
            [delayed[0] * state.gain, delayed[1] * state.gain]
        };
        delay.write = (delay.write + 1) % capacity;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Parameters, as pure functions
// ---------------------------------------------------------------------------------------------------------------

fn sanitize(normalized: f64) -> f64 {
    if normalized.is_finite() {
        normalized.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Sets the field a parameter stands for from its normalized value. `false` for an unknown parameter.
pub fn apply_parameter(state: &mut TestState, id: u32, normalized: f64) -> bool {
    let value = sanitize(normalized);
    match id {
        PARAM_GAIN => state.gain = value as f32,
        PARAM_LATENCY => state.latency = (value * f64::from(MAX_LATENCY)).round() as u32,
        PARAM_MODE => {
            state.mode =
                TestMode::from_index((value * f64::from(MODE_STEPS)).round() as u32, state.mode)
        }
        PARAM_EDITS => state.edits = (value * f64::from(MAX_EDITS)).round() as u32,
        _ => return false,
    }
    true
}

/// The normalized value of a parameter. 0 for an unknown one.
pub fn parameter_normalized(state: &TestState, id: u32) -> f64 {
    match id {
        PARAM_GAIN => f64::from(state.gain).clamp(0.0, 1.0),
        PARAM_LATENCY => f64::from(state.latency.min(MAX_LATENCY)) / f64::from(MAX_LATENCY),
        PARAM_MODE => f64::from(state.mode.index()) / f64::from(MODE_STEPS),
        PARAM_EDITS => f64::from(state.edits.min(MAX_EDITS)) / f64::from(MAX_EDITS),
        _ => 0.0,
    }
}

/// The plain value of a parameter for a normalized one: the gain as is, the latency in frames, the mode step, the count.
pub fn parameter_plain(id: u32, normalized: f64) -> f64 {
    let value = sanitize(normalized);
    match id {
        PARAM_GAIN => value,
        PARAM_LATENCY => (value * f64::from(MAX_LATENCY)).round(),
        PARAM_MODE => (value * f64::from(MODE_STEPS)).round(),
        PARAM_EDITS => (value * f64::from(MAX_EDITS)).round(),
        _ => 0.0,
    }
}

/// The inverse of [`parameter_plain`].
pub fn parameter_from_plain(id: u32, plain: f64) -> f64 {
    if !plain.is_finite() {
        return 0.0;
    }
    match id {
        PARAM_GAIN => plain.clamp(0.0, 1.0),
        PARAM_LATENCY => (plain / f64::from(MAX_LATENCY)).clamp(0.0, 1.0),
        PARAM_MODE => (plain / f64::from(MODE_STEPS)).clamp(0.0, 1.0),
        PARAM_EDITS => (plain / f64::from(MAX_EDITS)).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

/// The text a host shows for a normalized value.
pub fn parameter_to_string(id: u32, normalized: f64) -> Option<String> {
    let plain = parameter_plain(id, normalized);
    match id {
        PARAM_GAIN => Some(format!("{plain:.2}")),
        PARAM_LATENCY => Some(format!("{plain:.0} frames")),
        PARAM_MODE => Some(
            TestMode::from_index(plain as u32, TestMode::Normal)
                .name()
                .to_string(),
        ),
        PARAM_EDITS => Some(format!("{plain:.0}")),
        _ => None,
    }
}

/// The normalized value for text a user typed. `None` when it does not parse.
pub fn parameter_from_string(id: u32, text: &str) -> Option<f64> {
    let text = text.trim();
    match id {
        PARAM_GAIN | PARAM_LATENCY | PARAM_EDITS => {
            let number: f64 = text.split_whitespace().next()?.parse().ok()?;
            number.is_finite().then(|| parameter_from_plain(id, number))
        }
        PARAM_MODE => (0..=MODE_STEPS)
            .find(|&i| {
                TestMode::from_index(i, TestMode::Normal)
                    .name()
                    .eq_ignore_ascii_case(text)
            })
            .map(|i| parameter_from_plain(id, f64::from(i))),
        _ => None,
    }
}

/// Whether a change of latency has to be announced: the latency the host last read or was told differs from the new one.
pub fn needs_latency_restart(reported: u32, latency: u32) -> bool {
    reported.min(MAX_LATENCY) != latency.min(MAX_LATENCY)
}

/// The padding `TABPLAYER_TEST_PLUGIN_STATE_PADDING` asks for: a decimal number of bytes, held to
/// [`MAX_ENV_STATE_PADDING`]. Anything that is not a number is 0.
pub fn parse_state_padding(text: &str) -> u32 {
    match text.trim().parse::<u64>() {
        Ok(bytes) => bytes.min(u64::from(MAX_ENV_STATE_PADDING)) as u32,
        Err(error) if *error.kind() == std::num::IntErrorKind::PosOverflow => MAX_ENV_STATE_PADDING,
        Err(_) => 0,
    }
}

/// The padding `getState` writes: the state's own, or what `TABPLAYER_TEST_PLUGIN_STATE_PADDING` asks for (`env`, the
/// variable's text if it is set), whichever is larger.
pub fn effective_padding(state_padding: u32, env: Option<&str>) -> u32 {
    state_padding.max(env.map_or(0, parse_state_padding))
}

// ---------------------------------------------------------------------------------------------------------------
// The shared part of the component and the controller
// ---------------------------------------------------------------------------------------------------------------

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Blocks the calling thread for good.
fn hang_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Acts out the fault of a mode at the top of `process`. Called with no lock held.
fn act_on_mode(mode: TestMode) {
    match mode {
        TestMode::Crash => std::process::abort(),
        TestMode::Hang => hang_forever(),
        TestMode::Slow { ms } => std::thread::sleep(Duration::from_millis(u64::from(ms))),
        _ => {}
    }
}

struct Inner {
    state: TestState,
    delay: DelayLine,
    scratch_in: Vec<[f32; 2]>,
    scratch_out: Vec<[f32; 2]>,
}

pub(crate) struct Shared {
    inner: Mutex<Inner>,
    handler: Mutex<Option<ComPtr<IComponentHandler>>>,
    /// The latency the host last read through `getLatencySamples` or was last told about with a restart.
    reported_latency: AtomicU32,
}

impl Shared {
    fn new() -> Shared {
        Shared {
            inner: Mutex::new(Inner {
                state: TestState::default(),
                delay: DelayLine::new(),
                scratch_in: Vec::new(),
                scratch_out: Vec::new(),
            }),
            handler: Mutex::new(None),
            reported_latency: AtomicU32::new(0),
        }
    }

    fn handler(&self) -> Option<ComPtr<IComponentHandler>> {
        lock(&self.handler).clone()
    }

    /// The latency, as `getLatencySamples` reports it. The host now knows this value.
    fn read_latency(&self) -> u32 {
        // Recorded while the lock is held, so a read is ordered with the writes of the state.
        let inner = lock(&self.inner);
        let latency = inner.state.latency.min(MAX_LATENCY);
        self.reported_latency.store(latency, Ordering::Relaxed);
        latency
    }

    /// Announces `latency` with `restartComponent(kLatencyChanged)` if the host does not know it yet. Called with no
    /// lock held, after whatever changed the latency (a parameter, the processor's queue or a state). Without a
    /// handler it does nothing and the change stays unannounced.
    fn announce_latency(&self, latency: u32) {
        if !needs_latency_restart(self.reported_latency.load(Ordering::Relaxed), latency) {
            return;
        }
        let Some(handler) = self.handler() else {
            return;
        };
        let told = self
            .reported_latency
            .swap(latency.min(MAX_LATENCY), Ordering::Relaxed);
        if needs_latency_restart(told, latency) {
            // SAFETY: the handler is a live host object that this plug-in holds a reference to.
            unsafe { handler.restartComponent(RestartFlags_::kLatencyChanged) };
        }
    }

    /// One edit from the editor: counts it, then tells the host with `beginEdit`, `performEdit` and `endEdit`.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn report_edit(&self) {
        let normalized = {
            let mut inner = lock(&self.inner);
            inner.state.edits = inner.state.edits.saturating_add(1).min(MAX_EDITS);
            parameter_normalized(&inner.state, PARAM_EDITS)
        };
        if let Some(handler) = self.handler() {
            // SAFETY: the handler is a live host object that this plug-in holds a reference to.
            unsafe {
                handler.beginEdit(PARAM_EDITS);
                handler.performEdit(PARAM_EDITS, normalized);
                handler.endEdit(PARAM_EDITS);
            }
        }
    }
}

/// Reads a stream to its end, or `None` past [`MAX_STATE_READ`].
unsafe fn read_stream(stream: *mut IBStream) -> Option<Vec<u8>> {
    let stream = ComRef::from_raw(stream)?;
    let mut out = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let mut read: i32 = 0;
        stream.read(
            chunk.as_mut_ptr() as *mut c_void,
            chunk.len() as i32,
            &mut read,
        );
        if read <= 0 {
            return Some(out);
        }
        out.extend_from_slice(&chunk[..(read as usize).min(chunk.len())]);
        if out.len() > MAX_STATE_READ {
            return None;
        }
    }
}

/// Writes all of `bytes`, or `false` if the stream stops taking them.
unsafe fn write_stream(stream: *mut IBStream, bytes: &[u8]) -> bool {
    let Some(stream) = ComRef::from_raw(stream) else {
        return false;
    };
    let mut done = 0;
    while done < bytes.len() {
        let rest = &bytes[done..];
        let count = rest.len().min(i32::MAX as usize) as i32;
        let mut written: i32 = 0;
        stream.write(rest.as_ptr() as *mut c_void, count, &mut written);
        if written <= 0 {
            return false;
        }
        done += written as usize;
    }
    true
}

fn copy_cstring(src: &str, dst: &mut [c_char]) {
    let bytes = src.as_bytes();
    let len = bytes.len().min(dst.len().saturating_sub(1));
    for (dst, src) in dst.iter_mut().zip(&bytes[..len]) {
        *dst = *src as c_char;
    }
    if let Some(end) = dst.get_mut(len) {
        *end = 0;
    }
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut len = 0;
    for (src, dst) in src.encode_utf16().zip(dst.iter_mut()) {
        *dst = src as TChar;
        len += 1;
    }
    if len < dst.len() {
        dst[len] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

unsafe fn len_wstring(string: *const TChar) -> usize {
    let mut len = 0;
    while *string.add(len) != 0 {
        len += 1;
    }
    len
}

// ---------------------------------------------------------------------------------------------------------------
// The plug-in: one class that is both the component and the edit controller
// ---------------------------------------------------------------------------------------------------------------

/// The `TUID` of a class ID string: its bytes in order, on every platform (unlike `vst3::uid`, which swaps on Windows).
const fn tuid_from_hex(hex: &str) -> TUID {
    let digits = hex.as_bytes();
    let mut out = [0 as c_char; 16];
    let mut i = 0;
    while i < 16 {
        let high = hex_digit(digits[2 * i]);
        let low = hex_digit(digits[2 * i + 1]);
        out[i] = ((high << 4) | low) as c_char;
        i += 1;
    }
    out
}

const fn hex_digit(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'A'..=b'F' => byte - b'A' + 10,
        _ => panic!("TEST_CLASS_ID must be uppercase hexadecimal"),
    }
}

const CID: TUID = tuid_from_hex(TEST_CLASS_ID);

/// With `TABPLAYER_TEST_PLUGIN_PRINT=1`, writes a line through Rust's standard output and one through the C runtime's, the
/// two ways a plug-in's code usually prints. A host that keeps them off its control pipe is not disturbed; one that
/// does not has its frames corrupted.
fn print_noise(what: &str) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ON.get_or_init(|| std::env::var(ENV_PRINT).as_deref() == Ok("1")) {
        return;
    }
    println!("tabplayer test plug-in: {what}");
    eprintln!("tabplayer test plug-in: {what} (stderr)");
    unsafe extern "C" {
        fn puts(text: *const c_char) -> i32;
        fn fflush(stream: *mut c_void) -> i32;
    }
    if let Ok(line) = std::ffi::CString::new(format!("tabplayer test plug-in (C): {what}")) {
        // SAFETY: `puts` takes a NUL-terminated string, which `line` is; `fflush(NULL)` flushes every open stream.
        unsafe {
            puts(line.as_ptr());
            fflush(ptr::null_mut());
        }
    }
}

struct TestPlugin {
    shared: Arc<Shared>,
}

impl Class for TestPlugin {
    type Interfaces = (
        IComponent,
        IAudioProcessor,
        IProcessContextRequirements,
        IEditController,
    );
}

impl TestPlugin {
    fn new() -> TestPlugin {
        TestPlugin {
            shared: Arc::new(Shared::new()),
        }
    }
}

impl IPluginBaseTrait for TestPlugin {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        print_noise("initialize");
        kResultOk
    }

    unsafe fn terminate(&self) -> tresult {
        // The handler is the host's object; let go of it so it can be released.
        *lock(&self.shared.handler) = None;
        kResultOk
    }
}

impl IComponentTrait for TestPlugin {
    unsafe fn getControllerClassId(&self, _class_id: *mut TUID) -> tresult {
        // One class does both jobs: the host asks the component for `IEditController` itself.
        kNotImplemented
    }

    unsafe fn setIoMode(&self, _mode: IoMode) -> tresult {
        kResultOk
    }

    unsafe fn getBusCount(&self, media_type: MediaType, dir: BusDirection) -> i32 {
        match media_type as MediaTypes {
            MediaTypes_::kAudio => match dir as BusDirections {
                BusDirections_::kInput | BusDirections_::kOutput => 1,
                _ => 0,
            },
            _ => 0,
        }
    }

    unsafe fn getBusInfo(
        &self,
        media_type: MediaType,
        dir: BusDirection,
        index: i32,
        bus: *mut BusInfo,
    ) -> tresult {
        if media_type as MediaTypes != MediaTypes_::kAudio || index != 0 || bus.is_null() {
            return kInvalidArgument;
        }
        let (name, direction) = match dir as BusDirections {
            BusDirections_::kInput => ("Input", BusDirections_::kInput),
            BusDirections_::kOutput => ("Output", BusDirections_::kOutput),
            _ => return kInvalidArgument,
        };
        let bus = &mut *bus;
        bus.mediaType = MediaTypes_::kAudio as MediaType;
        bus.direction = direction as BusDirection;
        bus.channelCount = 2;
        copy_wstring(name, &mut bus.name);
        bus.busType = BusTypes_::kMain as BusType;
        bus.flags = BusInfo_::BusFlags_::kDefaultActive as u32;
        kResultOk
    }

    unsafe fn getRoutingInfo(
        &self,
        _in_info: *mut RoutingInfo,
        _out_info: *mut RoutingInfo,
    ) -> tresult {
        kNotImplemented
    }

    unsafe fn activateBus(
        &self,
        _media_type: MediaType,
        _dir: BusDirection,
        _index: i32,
        _state: TBool,
    ) -> tresult {
        kResultOk
    }

    unsafe fn setActive(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn setState(&self, state: *mut IBStream) -> tresult {
        let Some(bytes) = read_stream(state) else {
            return kResultFalse;
        };
        let Some(new) = decode_test_state(&bytes) else {
            return kResultFalse;
        };
        let current = lock(&self.shared.inner).state.mode;
        if new.mode == TestMode::HangOnLoad {
            hang_forever();
        }
        if new.mode == TestMode::RejectState || current == TestMode::RejectState {
            return kResultFalse;
        }
        lock(&self.shared.inner).state = new;
        self.shared.announce_latency(new.latency);
        kResultOk
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        // Copy the state out first: encoding up to 16 MiB of zeros must not hold the lock `process` takes.
        let mut current = lock(&self.shared.inner).state;
        current.padding = effective_padding(
            current.padding,
            std::env::var(ENV_STATE_PADDING).ok().as_deref(),
        );
        let bytes = encode_test_state(&current);
        if write_stream(state, &bytes) {
            kResultOk
        } else {
            kResultFalse
        }
    }
}

impl IAudioProcessorTrait for TestPlugin {
    unsafe fn setBusArrangements(
        &self,
        inputs: *mut SpeakerArrangement,
        num_ins: i32,
        outputs: *mut SpeakerArrangement,
        num_outs: i32,
    ) -> tresult {
        if num_ins != 1 || num_outs != 1 || inputs.is_null() || outputs.is_null() {
            return kResultFalse;
        }
        if *inputs != SpeakerArr::kStereo || *outputs != SpeakerArr::kStereo {
            return kResultFalse;
        }
        kResultTrue
    }

    unsafe fn getBusArrangement(
        &self,
        dir: BusDirection,
        index: i32,
        arr: *mut SpeakerArrangement,
    ) -> tresult {
        if index != 0 || arr.is_null() {
            return kInvalidArgument;
        }
        match dir as BusDirections {
            BusDirections_::kInput | BusDirections_::kOutput => {
                *arr = SpeakerArr::kStereo;
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn canProcessSampleSize(&self, symbolic_sample_size: i32) -> tresult {
        match symbolic_sample_size as SymbolicSampleSizes {
            SymbolicSampleSizes_::kSample32 => kResultOk,
            SymbolicSampleSizes_::kSample64 => kNotImplemented,
            _ => kInvalidArgument,
        }
    }

    unsafe fn getLatencySamples(&self) -> u32 {
        self.shared.read_latency()
    }

    unsafe fn setupProcessing(&self, setup: *mut ProcessSetup) -> tresult {
        if !setup.is_null() {
            let frames = (*setup).maxSamplesPerBlock.max(0) as usize;
            let mut inner = lock(&self.shared.inner);
            // Reserve now so `process` does not allocate for blocks up to the size the host announced.
            inner.scratch_in.reserve(frames);
            inner.scratch_out.reserve(frames);
        }
        kResultOk
    }

    unsafe fn setProcessing(&self, state: TBool) -> tresult {
        if state == 0 {
            lock(&self.shared.inner).delay.clear();
        }
        kResultOk
    }

    unsafe fn process(&self, data: *mut ProcessData) -> tresult {
        if data.is_null() {
            return kInvalidArgument;
        }
        print_noise("process");
        let process_data = &*data;

        // Take the last value of each parameter queue, then read the mode and latency they leave.
        let (mode, latency) = {
            let mut inner = lock(&self.shared.inner);
            if let Some(changes) = ComRef::from_raw(process_data.inputParameterChanges) {
                for index in 0..changes.getParameterCount() {
                    let Some(queue) = ComRef::from_raw(changes.getParameterData(index)) else {
                        continue;
                    };
                    let points = queue.getPointCount();
                    if points <= 0 {
                        continue;
                    }
                    let mut offset = 0;
                    let mut value = 0.0;
                    if queue.getPoint(points - 1, &mut offset, &mut value) == kResultTrue {
                        apply_parameter(&mut inner.state, queue.getParameterId(), value);
                    }
                }
            }
            (inner.state.mode, inner.state.latency)
        };
        self.shared.announce_latency(latency);
        act_on_mode(mode);

        let frames = process_data.numSamples.max(0) as usize;
        if frames == 0
            || process_data.numInputs != 1
            || process_data.numOutputs != 1
            || process_data.inputs.is_null()
            || process_data.outputs.is_null()
        {
            return kResultOk;
        }
        // Raw pointers throughout: a host may hand the same bus or the same buffer to more than one argument.
        let input_bus = process_data.inputs;
        let output_bus = process_data.outputs;
        if (*input_bus).numChannels != 2 || (*output_bus).numChannels != 2 {
            return kResultOk;
        }
        let input_channels = (*input_bus).__field0.channelBuffers32;
        let output_channels = (*output_bus).__field0.channelBuffers32;
        if input_channels.is_null() || output_channels.is_null() {
            return kResultOk;
        }
        let (in_l, in_r) = (*input_channels, *input_channels.add(1));
        let (out_l, out_r) = (*output_channels, *output_channels.add(1));
        if in_l.is_null() || in_r.is_null() || out_l.is_null() || out_r.is_null() {
            return kResultOk;
        }

        let mut guard = lock(&self.shared.inner);
        let inner = &mut *guard;
        inner.scratch_in.clear();
        inner
            .scratch_in
            .extend((0..frames).map(|i| [*in_l.add(i), *in_r.add(i)]));
        inner.scratch_out.clear();
        inner.scratch_out.resize(frames, [0.0; 2]);
        process_block(
            &inner.state,
            &mut inner.delay,
            &inner.scratch_in,
            &mut inner.scratch_out,
        );

        // The output is written only after the input is read, because the buffers may be the same ones.
        for (index, frame) in inner.scratch_out.iter().enumerate() {
            *out_l.add(index) = frame[0];
            *out_r.add(index) = frame[1];
        }
        (*output_bus).silenceFlags = 0;
        kResultOk
    }

    unsafe fn getTailSamples(&self) -> u32 {
        lock(&self.shared.inner).state.latency.min(MAX_LATENCY)
    }
}

impl IProcessContextRequirementsTrait for TestPlugin {
    unsafe fn getProcessContextRequirements(&self) -> u32 {
        0
    }
}

impl IEditControllerTrait for TestPlugin {
    unsafe fn setComponentState(&self, state: *mut IBStream) -> tresult {
        // The component and the controller share their values, so there is nothing to copy: this only checks that the
        // state is one this plug-in wrote. It never applies it, so a state that `setState` refused stays refused.
        match read_stream(state).as_deref().and_then(decode_test_state) {
            Some(_) => kResultOk,
            None => kResultFalse,
        }
    }

    unsafe fn setState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }

    unsafe fn getState(&self, _state: *mut IBStream) -> tresult {
        kResultOk
    }

    unsafe fn getParameterCount(&self) -> i32 {
        PARAM_COUNT as i32
    }

    unsafe fn getParameterInfo(&self, param_index: i32, info: *mut ParameterInfo) -> tresult {
        if info.is_null() {
            return kInvalidArgument;
        }
        let info = &mut *info;
        let (title, steps, default, flags) = match param_index as u32 {
            PARAM_GAIN => (
                "Gain",
                0,
                1.0,
                ParameterInfo_::ParameterFlags_::kCanAutomate,
            ),
            PARAM_LATENCY => (
                "Latency",
                MAX_LATENCY as i32,
                0.0,
                ParameterInfo_::ParameterFlags_::kCanAutomate,
            ),
            PARAM_MODE => (
                "Mode",
                MODE_STEPS as i32,
                0.0,
                ParameterInfo_::ParameterFlags_::kCanAutomate
                    | ParameterInfo_::ParameterFlags_::kIsList,
            ),
            PARAM_EDITS => (
                "Edits",
                MAX_EDITS as i32,
                0.0,
                ParameterInfo_::ParameterFlags_::kCanAutomate,
            ),
            _ => return kInvalidArgument,
        };
        info.id = param_index as u32;
        copy_wstring(title, &mut info.title);
        copy_wstring(title, &mut info.shortTitle);
        copy_wstring("", &mut info.units);
        info.stepCount = steps;
        info.defaultNormalizedValue = default;
        info.unitId = 0;
        info.flags = flags;
        kResultOk
    }

    unsafe fn getParamStringByValue(
        &self,
        id: u32,
        value_normalized: f64,
        string: *mut String128,
    ) -> tresult {
        match parameter_to_string(id, value_normalized) {
            Some(text) if !string.is_null() => {
                copy_wstring(&text, &mut *string);
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn getParamValueByString(
        &self,
        id: u32,
        string: *mut TChar,
        value_normalized: *mut f64,
    ) -> tresult {
        if string.is_null() || value_normalized.is_null() {
            return kInvalidArgument;
        }
        let units =
            slice::from_raw_parts(string as *const u16, len_wstring(string as *const TChar));
        match String::from_utf16(units)
            .ok()
            .and_then(|text| parameter_from_string(id, &text))
        {
            Some(value) => {
                *value_normalized = value;
                kResultOk
            }
            None => kInvalidArgument,
        }
    }

    unsafe fn normalizedParamToPlain(&self, id: u32, value_normalized: f64) -> f64 {
        parameter_plain(id, value_normalized)
    }

    unsafe fn plainParamToNormalized(&self, id: u32, plain_value: f64) -> f64 {
        parameter_from_plain(id, plain_value)
    }

    unsafe fn getParamNormalized(&self, id: u32) -> f64 {
        parameter_normalized(&lock(&self.shared.inner).state, id)
    }

    unsafe fn setParamNormalized(&self, id: u32, value: f64) -> tresult {
        let latency = {
            let mut inner = lock(&self.shared.inner);
            if !apply_parameter(&mut inner.state, id, value) {
                return kInvalidArgument;
            }
            inner.state.latency
        };
        // The lock is released first: the host reads the latency from inside the restart.
        self.shared.announce_latency(latency);
        kResultOk
    }

    unsafe fn setComponentHandler(&self, handler: *mut IComponentHandler) -> tresult {
        *lock(&self.shared.handler) = ComRef::from_raw(handler).map(|handler| handler.to_com_ptr());
        kResultOk
    }

    unsafe fn createView(&self, name: *const c_char) -> *mut IPlugView {
        #[cfg(windows)]
        {
            if !name.is_null() && std::ffi::CStr::from_ptr(name).to_bytes() == b"editor" {
                return ComWrapper::new(view::TestView::new(self.shared.clone()))
                    .to_com_ptr::<IPlugView>()
                    .map_or(ptr::null_mut(), |view| view.into_raw());
            }
        }
        let _ = name;
        ptr::null_mut()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The factory and the entry points
// ---------------------------------------------------------------------------------------------------------------

struct Factory {}

impl Class for Factory {
    type Interfaces = (IPluginFactory2,);
}

impl IPluginFactoryTrait for Factory {
    unsafe fn getFactoryInfo(&self, info: *mut PFactoryInfo) -> tresult {
        if info.is_null() {
            return kInvalidArgument;
        }
        let info = &mut *info;
        copy_cstring("TabPlayer", &mut info.vendor);
        copy_cstring("", &mut info.url);
        copy_cstring("", &mut info.email);
        // Not `kUnicode`: that flag promises `IPluginFactory3`, which this factory does not implement.
        info.flags = 0;
        kResultOk
    }

    unsafe fn countClasses(&self) -> i32 {
        1
    }

    unsafe fn getClassInfo(&self, index: i32, info: *mut PClassInfo) -> tresult {
        if index != 0 || info.is_null() {
            return kInvalidArgument;
        }
        let info = &mut *info;
        info.cid = CID;
        info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
        copy_cstring("Audio Module Class", &mut info.category);
        copy_cstring(TEST_PLUGIN_NAME, &mut info.name);
        kResultOk
    }

    unsafe fn createInstance(
        &self,
        cid: FIDString,
        iid: FIDString,
        obj: *mut *mut c_void,
    ) -> tresult {
        if obj.is_null() {
            return kInvalidArgument;
        }
        *obj = ptr::null_mut();
        if cid.is_null() || iid.is_null() {
            return kInvalidArgument;
        }
        if *(cid as *const TUID) != CID {
            return kInvalidArgument;
        }
        let Some(instance) = ComWrapper::new(TestPlugin::new()).to_com_ptr::<FUnknown>() else {
            return kOutOfMemory;
        };
        let raw = instance.as_ptr();
        ((*(*raw).vtbl).queryInterface)(raw, iid as *mut TUID, obj)
    }
}

impl IPluginFactory2Trait for Factory {
    unsafe fn getClassInfo2(&self, index: i32, info: *mut PClassInfo2) -> tresult {
        if index != 0 || info.is_null() {
            return kInvalidArgument;
        }
        let info = &mut *info;
        info.cid = CID;
        info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
        copy_cstring("Audio Module Class", &mut info.category);
        copy_cstring(TEST_PLUGIN_NAME, &mut info.name);
        info.classFlags = 0;
        copy_cstring("Fx", &mut info.subCategories);
        copy_cstring("TabPlayer", &mut info.vendor);
        copy_cstring(TEST_PLUGIN_VERSION, &mut info.version);
        copy_cstring("VST 3.8.0", &mut info.sdkVersion);
        kResultOk
    }
}

#[cfg(target_os = "windows")]
#[unsafe(no_mangle)]
extern "system" fn InitDll() -> bool {
    true
}

#[cfg(target_os = "windows")]
#[unsafe(no_mangle)]
extern "system" fn ExitDll() -> bool {
    true
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
extern "system" fn BundleEntry(_bundle_ref: *mut c_void) -> bool {
    true
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
extern "system" fn BundleExit() -> bool {
    true
}

#[cfg(target_os = "linux")]
#[unsafe(no_mangle)]
extern "system" fn ModuleEntry(_library_handle: *mut c_void) -> bool {
    true
}

#[cfg(target_os = "linux")]
#[unsafe(no_mangle)]
extern "system" fn ModuleExit() -> bool {
    true
}

#[unsafe(no_mangle)]
extern "system" fn GetPluginFactory() -> *mut IPluginFactory {
    if std::env::var(ENV_HANG_FACTORY).as_deref() == Ok("1") {
        hang_forever();
    }
    ComWrapper::new(Factory {})
        .to_com_ptr::<IPluginFactory>()
        .map_or(ptr::null_mut(), |factory| factory.into_raw())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        state: &TestState,
        delay: &mut DelayLine,
        input: &[[f32; 2]],
        block: usize,
    ) -> Vec<[f32; 2]> {
        let mut out = vec![[0.0; 2]; input.len()];
        for (i, o) in input.chunks(block).zip(out.chunks_mut(block)) {
            process_block(state, delay, i, o);
        }
        out
    }

    #[test]
    fn test_state_round_trips() {
        for state in [
            TestState::default(),
            TestState {
                gain: 0.25,
                latency: 480,
                mode: TestMode::Slow { ms: 120 },
                padding: 17,
                edits: 3,
            },
            TestState {
                gain: -2.5,
                latency: MAX_LATENCY,
                mode: TestMode::RejectState,
                padding: 0,
                edits: MAX_EDITS,
            },
        ] {
            assert_eq!(decode_test_state(&encode_test_state(&state)), Some(state));
        }
        for mode in [
            TestMode::Normal,
            TestMode::Crash,
            TestMode::Hang,
            TestMode::Nan,
            TestMode::Slow { ms: 0 },
            TestMode::HangOnLoad,
            TestMode::RejectState,
        ] {
            let state = TestState {
                mode,
                ..TestState::default()
            };
            assert_eq!(
                decode_test_state(&encode_test_state(&state)),
                Some(state),
                "{mode:?}"
            );
        }
    }

    #[test]
    fn decode_refuses_anything_else() {
        let good = encode_test_state(&TestState {
            padding: 4,
            ..TestState::default()
        });
        assert!(decode_test_state(&good).is_some());
        assert_eq!(decode_test_state(&[]), None);
        assert_eq!(decode_test_state(&good[..STATE_BASE_LEN - 1]), None);
        let mut bad = good.clone();
        bad[0] ^= 1;
        assert_eq!(decode_test_state(&bad), None, "magic");
        let mut bad = good.clone();
        bad[4] = 2;
        assert_eq!(decode_test_state(&bad), None, "version");
        let mut bad = good.clone();
        bad[14] = 7;
        assert_eq!(decode_test_state(&bad), None, "mode tag");
        let mut bad = good.clone();
        bad[6..10].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(decode_test_state(&bad), None, "gain");
        let mut bad = good.clone();
        bad[10..14].copy_from_slice(&(MAX_LATENCY + 1).to_le_bytes());
        assert_eq!(decode_test_state(&bad), None, "latency");
        let mut bad = good.clone();
        *bad.last_mut().unwrap() = 1;
        assert_eq!(decode_test_state(&bad), None, "padding must be zero");
    }

    #[test]
    fn padding_sets_state_size() {
        for padding in [0u32, 1, 1000, 9 * 1024 * 1024] {
            let bytes = encode_test_state(&TestState {
                padding,
                ..TestState::default()
            });
            assert_eq!(bytes.len(), STATE_BASE_LEN + padding as usize);
            assert!(bytes[STATE_BASE_LEN..].iter().all(|&b| b == 0));
            assert_eq!(decode_test_state(&bytes).map(|s| s.padding), Some(padding));
        }
    }

    #[test]
    fn delay_and_gain_are_exact() {
        let state = TestState {
            gain: 0.5,
            latency: 480,
            ..TestState::default()
        };
        let mut input = vec![[0.0f32; 2]; 2000];
        input[0] = [1.0, 1.0];
        // Blocks of 128 do not divide 480, so the delay crosses block boundaries.
        for block in [128, 1, 2000] {
            let out = run(&state, &mut DelayLine::new(), &input, block);
            for (frame, value) in out.iter().enumerate() {
                let expected = if frame == 480 { [0.5, 0.5] } else { [0.0, 0.0] };
                assert_eq!(*value, expected, "frame {frame}, block {block}");
            }
        }
    }

    #[test]
    fn channels_are_independent_and_gain_scales_them() {
        let state = TestState {
            gain: 0.5,
            latency: 3,
            ..TestState::default()
        };
        let input: Vec<[f32; 2]> = (0..8).map(|i| [i as f32, -(i as f32)]).collect();
        let out = run(&state, &mut DelayLine::new(), &input, 8);
        for (frame, value) in out.iter().enumerate() {
            let expected = if frame >= 3 {
                [(frame - 3) as f32 * 0.5, -((frame - 3) as f32) * 0.5]
            } else {
                [0.0; 2]
            };
            assert_eq!(*value, expected, "frame {frame}");
        }
    }

    #[test]
    fn zero_latency_is_just_gain() {
        let state = TestState {
            gain: 0.5,
            ..TestState::default()
        };
        let out = run(&state, &mut DelayLine::new(), &[[1.0, 0.5], [0.25, 0.0]], 2);
        assert_eq!(out, vec![[0.5, 0.25], [0.125, 0.0]]);
    }

    #[test]
    fn the_longest_latency_fits() {
        let state = TestState {
            latency: MAX_LATENCY,
            ..TestState::default()
        };
        let mut input = vec![[0.0f32; 2]; MAX_LATENCY as usize + 5];
        input[0] = [1.0, 1.0];
        let out = run(&state, &mut DelayLine::new(), &input, 512);
        assert_eq!(out[MAX_LATENCY as usize], [1.0, 1.0]);
        assert_eq!(out.iter().filter(|f| **f != [0.0; 2]).count(), 1);
    }

    #[test]
    fn a_latency_over_the_maximum_is_held_to_it() {
        let state = TestState {
            latency: u32::MAX,
            ..TestState::default()
        };
        let mut delay = DelayLine::new();
        let mut out = [[0.0; 2]; 4];
        process_block(&state, &mut delay, &[[1.0; 2]; 4], &mut out);
        assert_eq!(out, [[0.0; 2]; 4]);
    }

    #[test]
    fn clear_forgets_the_delayed_audio() {
        let state = TestState {
            latency: 4,
            ..TestState::default()
        };
        let mut delay = DelayLine::new();
        let mut out = [[0.0; 2]; 2];
        process_block(&state, &mut delay, &[[1.0; 2]; 2], &mut out);
        delay.clear();
        let mut out = [[0.0; 2]; 8];
        process_block(&state, &mut delay, &[[0.0; 2]; 8], &mut out);
        assert_eq!(out, [[0.0; 2]; 8]);
    }

    #[test]
    fn a_latency_change_keeps_the_history() {
        let mut state = TestState {
            latency: 4,
            ..TestState::default()
        };
        let mut delay = DelayLine::new();
        let input: Vec<[f32; 2]> = (1..=4).map(|i| [i as f32; 2]).collect();
        let mut out = [[0.0; 2]; 4];
        process_block(&state, &mut delay, &input, &mut out);
        state.latency = 2;
        let mut out = [[0.0; 2]; 2];
        process_block(&state, &mut delay, &[[0.0; 2]; 2], &mut out);
        // Frame 4 is read 2 frames back: the samples 3 and 4.
        assert_eq!(out, [[3.0; 2], [4.0; 2]]);
    }

    #[test]
    fn nan_mode_poisons_every_output_sample() {
        let state = TestState {
            mode: TestMode::Nan,
            ..TestState::default()
        };
        let out = run(&state, &mut DelayLine::new(), &[[1.0; 2]; 5], 5);
        assert!(out.iter().flatten().all(|v| v.is_nan()));
    }

    #[test]
    fn mismatched_lengths_use_the_shorter() {
        let state = TestState::default();
        let mut out = [[9.0; 2]; 4];
        process_block(&state, &mut DelayLine::new(), &[[1.0; 2]; 2], &mut out);
        assert_eq!(out, [[1.0; 2], [1.0; 2], [9.0; 2], [9.0; 2]]);
    }

    #[test]
    fn parameters_map_to_state_and_back() {
        let mut state = TestState::default();
        assert!(apply_parameter(&mut state, PARAM_GAIN, 0.5));
        assert!(apply_parameter(
            &mut state,
            PARAM_LATENCY,
            480.0 / f64::from(MAX_LATENCY)
        ));
        assert!(apply_parameter(&mut state, PARAM_MODE, 3.0 / 6.0));
        assert!(apply_parameter(
            &mut state,
            PARAM_EDITS,
            5.0 / f64::from(MAX_EDITS)
        ));
        assert_eq!(
            state,
            TestState {
                gain: 0.5,
                latency: 480,
                mode: TestMode::Nan,
                padding: 0,
                edits: 5
            }
        );
        for id in 0..PARAM_COUNT {
            let value = parameter_normalized(&state, id);
            let mut again = TestState::default();
            apply_parameter(&mut again, id, value);
            assert_eq!(parameter_normalized(&again, id), value, "parameter {id}");
        }
        assert!(!apply_parameter(&mut state, PARAM_COUNT, 0.5));
        assert_eq!(parameter_normalized(&state, PARAM_COUNT), 0.0);
    }

    #[test]
    fn every_latency_survives_the_parameter() {
        for latency in [0, 1, 479, 480, 481, 47_999, MAX_LATENCY] {
            let mut state = TestState::default();
            let normalized = parameter_normalized(&TestState { latency, ..state }, PARAM_LATENCY);
            apply_parameter(&mut state, PARAM_LATENCY, normalized);
            assert_eq!(state.latency, latency);
        }
    }

    #[test]
    fn the_mode_parameter_covers_every_mode_and_slow_keeps_its_length() {
        let mut state = TestState::default();
        for (step, name) in [
            "Normal",
            "Crash",
            "Hang",
            "NaN",
            "Slow",
            "Hang on load",
            "Reject state",
        ]
        .iter()
        .enumerate()
        {
            apply_parameter(&mut state, PARAM_MODE, step as f64 / 6.0);
            assert_eq!(state.mode.index(), step as u32);
            assert_eq!(
                parameter_to_string(PARAM_MODE, step as f64 / 6.0).as_deref(),
                Some(*name)
            );
        }
        assert_eq!(
            TestMode::from_index(4, TestMode::Normal),
            TestMode::Slow {
                ms: DEFAULT_SLOW_MS
            }
        );
        let mut slow = TestState {
            mode: TestMode::Slow { ms: 200 },
            ..TestState::default()
        };
        apply_parameter(&mut slow, PARAM_MODE, 4.0 / 6.0);
        assert_eq!(slow.mode, TestMode::Slow { ms: 200 });
    }

    #[test]
    fn parameters_refuse_bad_values() {
        let mut state = TestState::default();
        apply_parameter(&mut state, PARAM_GAIN, f64::NAN);
        assert_eq!(state.gain, 0.0);
        apply_parameter(&mut state, PARAM_GAIN, 7.0);
        assert_eq!(state.gain, 1.0);
        apply_parameter(&mut state, PARAM_LATENCY, -1.0);
        assert_eq!(state.latency, 0);
        apply_parameter(&mut state, PARAM_LATENCY, 2.0);
        assert_eq!(state.latency, MAX_LATENCY);
    }

    #[test]
    fn parameter_text_round_trips() {
        for (id, text, normalized) in [
            (PARAM_GAIN, "0.50", 0.5),
            (PARAM_LATENCY, "480 frames", 480.0 / f64::from(MAX_LATENCY)),
            (PARAM_MODE, "nan", 0.5),
            (PARAM_EDITS, "512", 0.5),
        ] {
            assert_eq!(parameter_from_string(id, text), Some(normalized), "{text}");
            assert!(parameter_to_string(id, normalized).is_some());
        }
        assert_eq!(
            parameter_to_string(PARAM_LATENCY, 480.0 / f64::from(MAX_LATENCY)).as_deref(),
            Some("480 frames")
        );
        assert_eq!(parameter_from_string(PARAM_GAIN, "loud"), None);
        assert_eq!(parameter_from_string(PARAM_MODE, "sideways"), None);
        assert_eq!(parameter_from_string(PARAM_COUNT, "1"), None);
        assert_eq!(parameter_to_string(PARAM_COUNT, 0.5), None);
    }

    #[test]
    fn the_class_id_is_the_tuid_in_order() {
        assert_eq!(TEST_CLASS_ID.len(), 32);
        assert!(
            TEST_CLASS_ID
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        );
        let hex: String = CID.iter().map(|b| format!("{:02X}", *b as u8)).collect();
        assert_eq!(hex, TEST_CLASS_ID);
    }

    #[test]
    fn the_name_and_the_base_length_are_fixed() {
        assert_eq!(TEST_PLUGIN_NAME, "TabPlayer Test Gain");
        assert_eq!(
            STATE_BASE_LEN,
            encode_test_state(&TestState::default()).len()
        );
    }

    #[test]
    fn the_decoder_refuses_an_edit_count_it_could_not_have_written() {
        let good = encode_test_state(&TestState {
            edits: MAX_EDITS,
            ..TestState::default()
        });
        assert!(decode_test_state(&good).is_some());
        for edits in [MAX_EDITS + 1, u32::MAX] {
            let mut bad = good.clone();
            bad[19..23].copy_from_slice(&edits.to_le_bytes());
            assert_eq!(decode_test_state(&bad), None, "edits {edits}");
        }
    }

    #[test]
    fn a_latency_restart_is_needed_exactly_when_the_host_does_not_know_it() {
        assert!(!needs_latency_restart(0, 0));
        assert!(!needs_latency_restart(480, 480));
        assert!(needs_latency_restart(0, 480));
        assert!(needs_latency_restart(480, 0));
        assert!(needs_latency_restart(480, 481));
        // Both sides are held to the maximum, as `getLatencySamples` reports it.
        assert!(!needs_latency_restart(MAX_LATENCY, u32::MAX));
        assert!(needs_latency_restart(0, u32::MAX));
    }

    #[test]
    fn the_padding_written_is_the_larger_of_the_state_and_the_variable() {
        assert_eq!(effective_padding(0, None), 0);
        assert_eq!(effective_padding(500, None), 500);
        assert_eq!(effective_padding(0, Some("9437184")), 9 * 1024 * 1024);
        assert_eq!(effective_padding(2000, Some("1000")), 2000);
        assert_eq!(effective_padding(1000, Some("2000")), 2000);
        assert_eq!(effective_padding(7, Some("junk")), 7);
        assert_eq!(
            effective_padding(0, Some("4294967295")),
            MAX_ENV_STATE_PADDING
        );
        assert_eq!(effective_padding(u32::MAX, Some("1")), u32::MAX);
    }

    #[test]
    fn the_state_padding_variable_is_a_number_held_to_16_mib() {
        assert_eq!(MAX_ENV_STATE_PADDING, 16 * 1024 * 1024);
        assert_eq!(parse_state_padding("0"), 0);
        assert_eq!(parse_state_padding("1000"), 1000);
        assert_eq!(parse_state_padding(" 9437184 "), 9 * 1024 * 1024);
        assert_eq!(parse_state_padding("16777216"), MAX_ENV_STATE_PADDING);
        assert_eq!(parse_state_padding("16777217"), MAX_ENV_STATE_PADDING);
        assert_eq!(
            parse_state_padding("4294967296"),
            MAX_ENV_STATE_PADDING,
            "over u32"
        );
        assert_eq!(
            parse_state_padding("99999999999999999999999"),
            MAX_ENV_STATE_PADDING,
            "over u64"
        );
        for bad in ["", "-1", "nine", "1.5", "0x10", "10 MiB"] {
            assert_eq!(parse_state_padding(bad), 0, "{bad:?}");
        }
        // The largest padding it allows is a state the plug-in still reads back.
        let state = TestState {
            padding: MAX_ENV_STATE_PADDING,
            ..TestState::default()
        };
        let bytes = encode_test_state(&state);
        assert!(bytes.len() < MAX_STATE_READ);
        assert_eq!(decode_test_state(&bytes), Some(state));
    }
}

/// The COM layer, in process: the factory, a plug-in instance and the host's side of the conversation, all built on
/// `ComWrapper` here. No library is loaded, so it runs wherever the unit tests do.
#[cfg(test)]
mod com_tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use vst3::Interface;

    /// A growable `IBStream` over a byte vector.
    struct MemStream {
        data: RefCell<Vec<u8>>,
        pos: Cell<usize>,
    }

    impl Class for MemStream {
        type Interfaces = (IBStream,);
    }

    impl IBStreamTrait for MemStream {
        unsafe fn read(&self, buffer: *mut c_void, num_bytes: i32, num_read: *mut i32) -> tresult {
            let data = self.data.borrow();
            let pos = self.pos.get().min(data.len());
            let count = (num_bytes.max(0) as usize).min(data.len() - pos);
            ptr::copy_nonoverlapping(data.as_ptr().add(pos), buffer as *mut u8, count);
            self.pos.set(pos + count);
            if !num_read.is_null() {
                *num_read = count as i32;
            }
            kResultOk
        }

        unsafe fn write(
            &self,
            buffer: *mut c_void,
            num_bytes: i32,
            num_written: *mut i32,
        ) -> tresult {
            let bytes = slice::from_raw_parts(buffer as *const u8, num_bytes.max(0) as usize);
            let mut data = self.data.borrow_mut();
            let pos = self.pos.get();
            if data.len() < pos + bytes.len() {
                data.resize(pos + bytes.len(), 0);
            }
            data[pos..pos + bytes.len()].copy_from_slice(bytes);
            self.pos.set(pos + bytes.len());
            if !num_written.is_null() {
                *num_written = bytes.len() as i32;
            }
            kResultOk
        }

        unsafe fn seek(&self, pos: i64, mode: i32, result: *mut i64) -> tresult {
            let len = self.data.borrow().len() as i64;
            // The seek modes are `DefaultEnumType`, which is `i32` on Windows and `u32` elsewhere.
            let base = match mode as IBStream_::IStreamSeekMode {
                IBStream_::IStreamSeekMode_::kIBSeekSet => 0,
                IBStream_::IStreamSeekMode_::kIBSeekCur => self.pos.get() as i64,
                _ => len,
            };
            let at = (base + pos).clamp(0, len);
            self.pos.set(at as usize);
            if !result.is_null() {
                *result = at;
            }
            kResultOk
        }

        unsafe fn tell(&self, pos: *mut i64) -> tresult {
            if !pos.is_null() {
                *pos = self.pos.get() as i64;
            }
            kResultOk
        }
    }

    fn stream(bytes: Vec<u8>) -> ComWrapper<MemStream> {
        ComWrapper::new(MemStream {
            data: RefCell::new(bytes),
            pos: Cell::new(0),
        })
    }

    /// A counted reference to the stream, which the caller keeps alive for the call and passes with `.as_ptr()`.
    fn ibstream(stream: &ComWrapper<MemStream>) -> ComPtr<IBStream> {
        stream.to_com_ptr::<IBStream>().unwrap()
    }

    /// What the plug-in told the host.
    #[derive(Debug, Clone, PartialEq)]
    enum Event {
        Begin(u32),
        Perform(u32, f64),
        End(u32),
        /// A restart, with the latency the host reads from inside the call.
        Restart {
            flags: i32,
            latency: Option<u32>,
        },
    }

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<Event>>,
        processor: Mutex<Option<ComPtr<IAudioProcessor>>>,
    }

    impl Recorder {
        fn take(&self) -> Vec<Event> {
            std::mem::take(&mut *self.events.lock().unwrap())
        }
    }

    impl Class for Recorder {
        type Interfaces = (IComponentHandler,);
    }

    impl IComponentHandlerTrait for Recorder {
        unsafe fn beginEdit(&self, id: ParamID) -> tresult {
            self.events.lock().unwrap().push(Event::Begin(id));
            kResultOk
        }

        unsafe fn performEdit(&self, id: ParamID, value: ParamValue) -> tresult {
            self.events.lock().unwrap().push(Event::Perform(id, value));
            kResultOk
        }

        unsafe fn endEdit(&self, id: ParamID) -> tresult {
            self.events.lock().unwrap().push(Event::End(id));
            kResultOk
        }

        unsafe fn restartComponent(&self, flags: int32) -> tresult {
            let latency = self
                .processor
                .lock()
                .unwrap()
                .as_ref()
                .map(|processor| processor.getLatencySamples());
            self.events
                .lock()
                .unwrap()
                .push(Event::Restart { flags, latency });
            kResultOk
        }
    }

    struct Queue {
        id: u32,
        points: Vec<(i32, f64)>,
    }

    impl Class for Queue {
        type Interfaces = (IParamValueQueue,);
    }

    impl IParamValueQueueTrait for Queue {
        unsafe fn getParameterId(&self) -> ParamID {
            self.id
        }

        unsafe fn getPointCount(&self) -> int32 {
            self.points.len() as i32
        }

        unsafe fn getPoint(
            &self,
            index: int32,
            sample_offset: *mut int32,
            value: *mut ParamValue,
        ) -> tresult {
            match self.points.get(index as usize) {
                Some(&(offset, v)) => {
                    *sample_offset = offset;
                    *value = v;
                    kResultTrue
                }
                None => kResultFalse,
            }
        }

        unsafe fn addPoint(&self, _: int32, _: ParamValue, _: *mut int32) -> tresult {
            kNotImplemented
        }
    }

    struct Changes {
        queues: Vec<ComPtr<IParamValueQueue>>,
    }

    impl Class for Changes {
        type Interfaces = (IParameterChanges,);
    }

    impl IParameterChangesTrait for Changes {
        unsafe fn getParameterCount(&self) -> int32 {
            self.queues.len() as i32
        }

        unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
            self.queues
                .get(index as usize)
                .map_or(ptr::null_mut(), |queue| queue.as_ptr())
        }

        unsafe fn addParameterData(
            &self,
            _: *const ParamID,
            _: *mut int32,
        ) -> *mut IParamValueQueue {
            ptr::null_mut()
        }
    }

    /// One change of one parameter, as the host would queue it for `process`.
    fn change(id: u32, value: f64) -> ComPtr<IParameterChanges> {
        let queue = ComWrapper::new(Queue {
            id,
            points: vec![(0, value)],
        })
        .to_com_ptr::<IParamValueQueue>()
        .unwrap();
        ComWrapper::new(Changes {
            queues: vec![queue],
        })
        .to_com_ptr::<IParameterChanges>()
        .unwrap()
    }

    /// A plug-in instance created through the factory, with the host's handler attached.
    struct Rig {
        component: ComPtr<IComponent>,
        processor: ComPtr<IAudioProcessor>,
        controller: ComPtr<IEditController>,
        host: ComWrapper<Recorder>,
    }

    impl Rig {
        fn new() -> Rig {
            unsafe {
                let factory = ComPtr::from_raw(GetPluginFactory()).expect("a factory");
                let mut object = ptr::null_mut();
                let result = factory.createInstance(
                    CID.as_ptr(),
                    <IComponent as Interface>::IID.as_ptr() as FIDString,
                    &mut object,
                );
                assert_eq!(result, kResultOk);
                let component =
                    ComPtr::<IComponent>::from_raw(object as *mut IComponent).expect("a component");
                let processor = component
                    .cast::<IAudioProcessor>()
                    .expect("IAudioProcessor");
                let controller = component
                    .cast::<IEditController>()
                    .expect("IEditController");
                assert_eq!(component.initialize(ptr::null_mut()), kResultOk);
                let host = ComWrapper::new(Recorder::default());
                *host.processor.lock().unwrap() = Some(processor.clone());
                let handler = host.to_com_ptr::<IComponentHandler>().unwrap();
                assert_eq!(controller.setComponentHandler(handler.as_ptr()), kResultOk);
                let mut setup = ProcessSetup {
                    processMode: 0,
                    symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
                    maxSamplesPerBlock: 512,
                    sampleRate: 48_000.0,
                };
                assert_eq!(processor.setupProcessing(&mut setup), kResultOk);
                Rig {
                    component,
                    processor,
                    controller,
                    host,
                }
            }
        }

        fn set_state(&self, state: &TestState) -> tresult {
            let stream = stream(encode_test_state(state));
            unsafe { self.component.setState(ibstream(&stream).as_ptr()) }
        }

        fn get_state(&self) -> Vec<u8> {
            let stream = stream(Vec::new());
            assert_eq!(
                unsafe { self.component.getState(ibstream(&stream).as_ptr()) },
                kResultOk
            );
            let bytes = stream.data.borrow().clone();
            bytes
        }

        fn set_param(&self, id: u32, value: f64) {
            assert_eq!(
                unsafe { self.controller.setParamNormalized(id, value) },
                kResultOk
            );
        }

        /// Runs `process` over the given input, with an optional queue of parameter changes.
        fn process(
            &self,
            left: &[f32],
            right: &[f32],
            changes: Option<&ComPtr<IParameterChanges>>,
        ) -> [Vec<f32>; 2] {
            unsafe {
                let frames = left.len();
                let mut in_l = left.to_vec();
                let mut in_r = right.to_vec();
                let mut out_l = vec![f32::NAN; frames];
                let mut out_r = vec![f32::NAN; frames];
                let mut inputs = [in_l.as_mut_ptr(), in_r.as_mut_ptr()];
                let mut outputs = [out_l.as_mut_ptr(), out_r.as_mut_ptr()];
                let mut input_bus: AudioBusBuffers = std::mem::zeroed();
                input_bus.numChannels = 2;
                input_bus.__field0.channelBuffers32 = inputs.as_mut_ptr();
                let mut output_bus: AudioBusBuffers = std::mem::zeroed();
                output_bus.numChannels = 2;
                output_bus.__field0.channelBuffers32 = outputs.as_mut_ptr();
                let mut data: ProcessData = std::mem::zeroed();
                data.symbolicSampleSize = SymbolicSampleSizes_::kSample32 as i32;
                data.numSamples = frames as i32;
                data.numInputs = 1;
                data.numOutputs = 1;
                data.inputs = &mut input_bus;
                data.outputs = &mut output_bus;
                data.inputParameterChanges = changes.map_or(ptr::null_mut(), |c| c.as_ptr());
                assert_eq!(self.processor.process(&mut data), kResultOk);
                [out_l, out_r]
            }
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            // Break the cycle between the plug-in and the host's handler.
            unsafe { self.component.terminate() };
            *self.host.processor.lock().unwrap() = None;
        }
    }

    fn text(chars: &[c_char]) -> String {
        let bytes: Vec<u8> = chars
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| c as u8)
            .collect();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn the_factory_lists_one_effect_class() {
        unsafe {
            let factory = ComPtr::from_raw(GetPluginFactory()).expect("a factory");
            assert_eq!(factory.countClasses(), 1);

            let mut factory_info: PFactoryInfo = std::mem::zeroed();
            assert_eq!(factory.getFactoryInfo(&mut factory_info), kResultOk);
            assert_eq!(text(&factory_info.vendor), "TabPlayer");
            assert_eq!(
                factory_info.flags & PFactoryInfo_::FactoryFlags_::kUnicode as int32,
                0,
                "kUnicode promises IPluginFactory3"
            );

            let mut info: PClassInfo = std::mem::zeroed();
            assert_eq!(factory.getClassInfo(0, &mut info), kResultOk);
            let id: String = info
                .cid
                .iter()
                .map(|b| format!("{:02X}", *b as u8))
                .collect();
            assert_eq!(id, TEST_CLASS_ID);
            assert_eq!(text(&info.name), "TabPlayer Test Gain");
            assert_eq!(text(&info.category), "Audio Module Class");
            assert_eq!(factory.getClassInfo(1, &mut info), kInvalidArgument);

            let factory2 = factory.cast::<IPluginFactory2>().expect("IPluginFactory2");
            let mut info2: PClassInfo2 = std::mem::zeroed();
            assert_eq!(factory2.getClassInfo2(0, &mut info2), kResultOk);
            assert_eq!(text(&info2.subCategories), "Fx");
            assert_eq!(text(&info2.vendor), "TabPlayer");
            assert_eq!(text(&info2.version), TEST_PLUGIN_VERSION);
            assert_eq!(text(&info2.name), "TabPlayer Test Gain");
            assert_eq!(factory2.getClassInfo2(1, &mut info2), kInvalidArgument);
        }
    }

    #[test]
    fn create_instance_refuses_what_it_does_not_know_and_clears_the_result() {
        unsafe {
            let factory = ComPtr::from_raw(GetPluginFactory()).expect("a factory");
            let iid = <IComponent as Interface>::IID.as_ptr() as FIDString;

            let mut object = 1usize as *mut c_void;
            let other: [c_char; 16] = [1; 16];
            assert_eq!(
                factory.createInstance(other.as_ptr(), iid, &mut object),
                kInvalidArgument
            );
            assert!(object.is_null(), "unknown class");

            let mut object = 1usize as *mut c_void;
            let unknown_iid: [c_char; 16] = [7; 16];
            assert_eq!(
                factory.createInstance(CID.as_ptr(), unknown_iid.as_ptr(), &mut object),
                kNoInterface
            );
            assert!(object.is_null(), "unknown interface");

            assert_eq!(
                factory.createInstance(CID.as_ptr(), iid, ptr::null_mut()),
                kInvalidArgument
            );
        }
    }

    #[test]
    fn one_object_answers_for_all_four_interfaces() {
        let rig = Rig::new();
        let from_component = rig.component.cast::<FUnknown>().unwrap();
        let from_processor = rig.processor.cast::<FUnknown>().unwrap();
        let from_controller = rig.controller.cast::<FUnknown>().unwrap();
        assert_eq!(from_component.as_ptr(), from_processor.as_ptr());
        assert_eq!(from_component.as_ptr(), from_controller.as_ptr());
        assert!(
            rig.component
                .cast::<IProcessContextRequirements>()
                .is_some()
        );
        unsafe {
            assert_eq!(rig.controller.getParameterCount(), PARAM_COUNT as i32);
            let mut class_id: TUID = [0; 16];
            assert_eq!(
                rig.component.getControllerClassId(&mut class_id),
                kNotImplemented
            );
        }
    }

    #[test]
    fn a_latency_change_restarts_the_component_on_every_path_that_can_bring_it() {
        let rig = Rig::new();
        let restart = |latency| Event::Restart {
            flags: RestartFlags_::kLatencyChanged,
            latency: Some(latency),
        };
        let normalized = |frames: u32| f64::from(frames) / f64::from(MAX_LATENCY);

        // The controller's own parameter, and the host reads the new value from inside the restart.
        rig.set_param(PARAM_LATENCY, normalized(480));
        assert_eq!(rig.host.take(), vec![restart(480)]);
        assert_eq!(unsafe { rig.processor.getLatencySamples() }, 480);
        // The same value again is not a change.
        rig.set_param(PARAM_LATENCY, normalized(480));
        assert_eq!(rig.host.take(), vec![]);

        // The processor's queue first, then the controller (the order that raced before): one restart, not none.
        let queued = change(PARAM_LATENCY, normalized(960));
        rig.process(&[0.0; 4], &[0.0; 4], Some(&queued));
        assert_eq!(rig.host.take(), vec![restart(960)]);
        rig.set_param(PARAM_LATENCY, normalized(960));
        assert_eq!(rig.host.take(), vec![], "already announced");

        // A state that changes the latency.
        let state = TestState {
            latency: 100,
            ..TestState::default()
        };
        assert_eq!(rig.set_state(&state), kResultOk);
        assert_eq!(rig.host.take(), vec![restart(100)]);
        assert_eq!(rig.set_state(&state), kResultOk);
        assert_eq!(rig.host.take(), vec![], "same latency");

        // Back to the first value, announced although nobody read the one in between.
        rig.set_param(PARAM_LATENCY, normalized(480));
        rig.set_param(PARAM_LATENCY, normalized(100));
        assert_eq!(rig.host.take(), vec![restart(480), restart(100)]);
    }

    #[test]
    fn a_latency_the_host_has_read_is_known_and_one_it_has_not_is_announced_later() {
        let rig = Rig::new();
        let handler = rig.host.to_com_ptr::<IComponentHandler>().unwrap();
        let state = TestState {
            latency: 64,
            ..TestState::default()
        };
        let normalized = 64.0 / f64::from(MAX_LATENCY);

        // With no handler a change cannot be announced. If the host reads it, it is known afterwards.
        unsafe { rig.controller.setComponentHandler(ptr::null_mut()) };
        assert_eq!(rig.set_state(&state), kResultOk);
        assert_eq!(unsafe { rig.processor.getLatencySamples() }, 64);
        unsafe { rig.controller.setComponentHandler(handler.as_ptr()) };
        rig.set_param(PARAM_LATENCY, normalized);
        assert_eq!(rig.host.take(), vec![]);

        // If it never read it, the next time the plug-in is given that latency it announces it.
        let rig = Rig::new();
        let handler = rig.host.to_com_ptr::<IComponentHandler>().unwrap();
        unsafe { rig.controller.setComponentHandler(ptr::null_mut()) };
        assert_eq!(rig.set_state(&state), kResultOk);
        unsafe { rig.controller.setComponentHandler(handler.as_ptr()) };
        rig.set_param(PARAM_LATENCY, normalized);
        assert_eq!(
            rig.host.take(),
            vec![Event::Restart {
                flags: RestartFlags_::kLatencyChanged,
                latency: Some(64)
            }]
        );
    }

    #[test]
    fn reject_state_refuses_an_incoming_state_and_a_current_mode() {
        let rig = Rig::new();
        let good = TestState {
            gain: 0.25,
            ..TestState::default()
        };
        assert_eq!(rig.set_state(&good), kResultOk);

        // A state that carries the mode is refused, and the state stays as it was.
        let bad = TestState {
            mode: TestMode::RejectState,
            gain: 0.75,
            ..TestState::default()
        };
        assert_eq!(rig.set_state(&bad), kResultFalse);
        assert_eq!(decode_test_state(&rig.get_state()), Some(good));

        // A plug-in set to the mode by its parameter refuses everything until the mode is taken off.
        rig.set_param(PARAM_MODE, 6.0 / 6.0);
        assert_eq!(rig.set_state(&good), kResultFalse);
        rig.set_param(PARAM_MODE, 0.0);
        assert_eq!(rig.set_state(&good), kResultOk);

        // Something that is not a state of this plug-in is refused too.
        let junk = stream(vec![1, 2, 3]);
        assert_eq!(
            unsafe { rig.component.setState(ibstream(&junk).as_ptr()) },
            kResultFalse
        );
    }

    #[test]
    fn the_state_the_host_reads_is_the_encoded_state_with_its_padding() {
        let rig = Rig::new();
        assert_eq!(rig.get_state().len(), STATE_BASE_LEN);
        for padding in [1u32, 1000, 9 * 1024 * 1024] {
            let state = TestState {
                gain: 0.5,
                latency: 12,
                mode: TestMode::Slow { ms: 7 },
                padding,
                edits: 2,
            };
            assert_eq!(rig.set_state(&state), kResultOk);
            let bytes = rig.get_state();
            assert_eq!(bytes.len(), STATE_BASE_LEN + padding as usize);
            assert_eq!(bytes, encode_test_state(&state));
        }
    }

    #[test]
    fn stopping_processing_empties_the_delay_line() {
        let impulse = [1.0f32, 1.0];
        let silence = [0.0f32; 8];
        let state = TestState {
            latency: 4,
            ..TestState::default()
        };

        // Without the stop, the impulse arrives in the next block, at stream frame 4.
        let rig = Rig::new();
        assert_eq!(rig.set_state(&state), kResultOk);
        rig.process(&impulse, &impulse, None);
        let [left, right] = rig.process(&silence, &silence, None);
        assert_eq!((left[2], right[2]), (1.0, 1.0));

        // With it, nothing is left of the first block.
        let rig = Rig::new();
        assert_eq!(rig.set_state(&state), kResultOk);
        rig.process(&impulse, &impulse, None);
        assert_eq!(unsafe { rig.processor.setProcessing(0) }, kResultOk);
        let [left, right] = rig.process(&silence, &silence, None);
        assert!(left.iter().chain(&right).all(|&v| v == 0.0));
    }

    #[test]
    fn process_applies_the_gain_and_the_delay_to_both_channels() {
        let rig = Rig::new();
        assert_eq!(
            rig.set_state(&TestState {
                gain: 0.5,
                latency: 2,
                ..TestState::default()
            }),
            kResultOk
        );
        let [left, right] = rig.process(&[1.0, 2.0, 3.0, 4.0], &[-1.0, -2.0, -3.0, -4.0], None);
        assert_eq!(left, vec![0.0, 0.0, 0.5, 1.0]);
        assert_eq!(right, vec![0.0, 0.0, -0.5, -1.0]);
    }

    #[test]
    fn set_component_state_checks_a_state_and_never_applies_it() {
        let rig = Rig::new();
        let ours = TestState {
            gain: 0.25,
            latency: 8,
            ..TestState::default()
        };
        assert_eq!(rig.set_state(&ours), kResultOk);
        rig.host.take();

        let other = stream(encode_test_state(&TestState {
            gain: 0.9,
            latency: 300,
            ..TestState::default()
        }));
        assert_eq!(
            unsafe { rig.controller.setComponentState(ibstream(&other).as_ptr()) },
            kResultOk
        );
        // A state the component refused must not slip in through the controller either.
        let refused = stream(encode_test_state(&TestState {
            mode: TestMode::RejectState,
            ..TestState::default()
        }));
        assert_eq!(
            unsafe {
                rig.controller
                    .setComponentState(ibstream(&refused).as_ptr())
            },
            kResultOk
        );
        let junk = stream(vec![0; 5]);
        assert_eq!(
            unsafe { rig.controller.setComponentState(ibstream(&junk).as_ptr()) },
            kResultFalse
        );

        assert_eq!(decode_test_state(&rig.get_state()), Some(ours));
        assert_eq!(unsafe { rig.processor.getLatencySamples() }, 8);
        assert_eq!(
            rig.host.take(),
            vec![],
            "nothing changed, nothing announced"
        );
    }

    #[test]
    fn the_parameters_read_back_what_was_set() {
        let rig = Rig::new();
        rig.set_param(PARAM_GAIN, 0.5);
        rig.set_param(PARAM_MODE, 3.0 / 6.0);
        unsafe {
            assert_eq!(rig.controller.getParamNormalized(PARAM_GAIN), 0.5);
            assert_eq!(rig.controller.getParamNormalized(PARAM_MODE), 0.5);
            assert_eq!(
                rig.controller.setParamNormalized(PARAM_COUNT, 0.5),
                kInvalidArgument
            );
        }
        let state = decode_test_state(&rig.get_state()).unwrap();
        assert_eq!((state.gain, state.mode), (0.5, TestMode::Nan));
    }

    #[test]
    fn an_edit_is_reported_to_the_host_and_the_count_saturates() {
        let shared = Shared::new();
        let host = ComWrapper::new(Recorder::default());
        *lock(&shared.handler) = Some(host.to_com_ptr::<IComponentHandler>().unwrap());

        shared.report_edit();
        assert_eq!(
            host.take(),
            vec![
                Event::Begin(PARAM_EDITS),
                Event::Perform(PARAM_EDITS, 1.0 / f64::from(MAX_EDITS)),
                Event::End(PARAM_EDITS),
            ]
        );
        assert_eq!(lock(&shared.inner).state.edits, 1);

        // A count that could not overflow before it was bounded now saturates, in a build that checks arithmetic too.
        lock(&shared.inner).state.edits = u32::MAX;
        shared.report_edit();
        assert_eq!(lock(&shared.inner).state.edits, MAX_EDITS);
        assert_eq!(
            host.take()[1],
            Event::Perform(PARAM_EDITS, 1.0),
            "performEdit carries the saturated count"
        );
    }
}
