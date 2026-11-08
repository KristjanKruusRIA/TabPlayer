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
//! Three environment variables, read inside the process that hosts the plug-in, add the rest:
//! `TABPLAYER_TEST_PLUGIN_HANG_FACTORY=1` blocks `GetPluginFactory` forever,
//! `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1` stops the editor from reporting an edit when it attaches, and
//! `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=<n>` blocks the editor's thread for `n` milliseconds after it attaches.
//!
//! It is a single class that is both the component and the edit controller, which VST3 allows. The probe therefore
//! sees exactly one class, [`TEST_CLASS_ID`].
//!
//! Everything a unit test needs is plain Rust: [`process_block`], [`DelayLine`], the state codec and the parameter
//! mapping. The COM part below them is only exercised by loading the built library.
#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
// The COM traits declare their methods `unsafe`, and every body in this file is one thin layer over raw pointers.
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::{c_char, c_void};
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

/// The editor's size.
pub const EDITOR_WIDTH: i32 = 300;
pub const EDITOR_HEIGHT: i32 = 200;

const ENV_HANG_FACTORY: &str = "TABPLAYER_TEST_PLUGIN_HANG_FACTORY";
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
/// is not finite, a latency over [`MAX_LATENCY`], an unknown mode, or trailing bytes that are not all zero. The trailing
/// bytes are the `padding`.
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
    if !gain.is_finite() || latency > MAX_LATENCY {
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
    if tail.iter().any(|&b| b != 0) {
        return None;
    }
    let padding = u32::try_from(tail.len()).ok()?;
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

/// The host's component handler, which the host guarantees may be called from the thread that calls the controller.
struct Handler(ComPtr<IComponentHandler>);

// SAFETY: a VST3 host's handler is called from its UI thread, which is the only thread the plug-in calls it from (the
// controller methods and the editor). The wrapper only lets the pointer sit in a `Mutex` inside an `Arc`.
unsafe impl Send for Handler {}
unsafe impl Sync for Handler {}

pub(crate) struct Shared {
    inner: Mutex<Inner>,
    handler: Mutex<Option<Handler>>,
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
        }
    }

    fn handler(&self) -> Option<ComPtr<IComponentHandler>> {
        lock(&self.handler).as_ref().map(|h| h.0.clone())
    }

    /// One edit from the editor: counts it, then tells the host with `beginEdit`, `performEdit` and `endEdit`.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn report_edit(&self) {
        let normalized = {
            let mut inner = lock(&self.inner);
            inner.state.edits = (inner.state.edits + 1).min(MAX_EDITS);
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
        kResultOk
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        let bytes = encode_test_state(&lock(&self.shared.inner).state);
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
        lock(&self.shared.inner).state.latency.min(MAX_LATENCY)
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
        let process_data = &*data;

        // Take the last value of each parameter queue, then read the mode they leave.
        let mode = {
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
            inner.state.mode
        };
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
        let input_bus = &*process_data.inputs;
        let output_bus = &mut *process_data.outputs;
        if input_bus.numChannels != 2 || output_bus.numChannels != 2 {
            return kResultOk;
        }
        let input_channels = input_bus.__field0.channelBuffers32;
        let output_channels = output_bus.__field0.channelBuffers32;
        if input_channels.is_null() || output_channels.is_null() {
            return kResultOk;
        }
        let (in_l, in_r) = (*input_channels, *input_channels.add(1));
        let (out_l, out_r) = (*output_channels, *output_channels.add(1));
        if in_l.is_null() || in_r.is_null() || out_l.is_null() || out_r.is_null() {
            return kResultOk;
        }
        let input_l = slice::from_raw_parts(in_l, frames);
        let input_r = slice::from_raw_parts(in_r, frames);

        let mut guard = lock(&self.shared.inner);
        let inner = &mut *guard;
        inner.scratch_in.clear();
        inner
            .scratch_in
            .extend(input_l.iter().zip(input_r).map(|(&l, &r)| [l, r]));
        inner.scratch_out.clear();
        inner.scratch_out.resize(frames, [0.0; 2]);
        process_block(
            &inner.state,
            &mut inner.delay,
            &inner.scratch_in,
            &mut inner.scratch_out,
        );

        // The host may pass the same buffers for input and output, so the output is written only after the input is read.
        let output_l = slice::from_raw_parts_mut(out_l, frames);
        let output_r = slice::from_raw_parts_mut(out_r, frames);
        for (index, frame) in inner.scratch_out.iter().enumerate() {
            output_l[index] = frame[0];
            output_r[index] = frame[1];
        }
        output_bus.silenceFlags = 0;
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
        // The component and the controller share their values, so this only repeats what the component already holds.
        match read_stream(state).as_deref().and_then(decode_test_state) {
            Some(new) => {
                lock(&self.shared.inner).state = new;
                kResultOk
            }
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
        let latency_changed = {
            let mut inner = lock(&self.shared.inner);
            let before = inner.state.latency;
            if !apply_parameter(&mut inner.state, id, value) {
                return kInvalidArgument;
            }
            inner.state.latency != before
        };
        // The lock is released first: the host reads the latency from inside this call.
        if latency_changed && let Some(handler) = self.shared.handler() {
            handler.restartComponent(RestartFlags_::kLatencyChanged);
        }
        kResultOk
    }

    unsafe fn setComponentHandler(&self, handler: *mut IComponentHandler) -> tresult {
        *lock(&self.shared.handler) =
            ComRef::from_raw(handler).map(|handler| Handler(handler.to_com_ptr()));
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
    type Interfaces = (IPluginFactory,);
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
        info.flags = PFactoryInfo_::FactoryFlags_::kUnicode as int32;
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
        if cid.is_null() || iid.is_null() || obj.is_null() {
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
}
