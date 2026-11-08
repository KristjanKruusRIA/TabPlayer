// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in this folder.
// Changed for TabPlayer (THE-71): the Windows extract only. Changes are marked "TabPlayer:".

// TabPlayer: SoundCraft's `Instance` was moved onto the audio thread whole. Here it is split in two, which is VST3's own
// threading model: `Instance` stays on the main thread (component, controller, editor, state) and `AudioPart` is the
// processor side that one audio thread owns.
use super::editor::EditorLink;
use super::host::HostContext;
use super::module::Bundle;
use super::process::{BusBuffers, EventList, MemoryStream, ParamChanges};
use super::{
    Arc, ComPtr, ComWrapper, EDITS_PER_BLOCK, EVENT_CAP, IAudioProcessorTrait, IComponentTrait,
    IConnectionPointTrait, IEditControllerTrait, IPluginBaseTrait, MAX_BUS_CHANNELS, MAX_BUSES,
    MAX_PARAMS, PARAM_QUEUE_CAP, Transport, Vst3Error, ok, sb, sv,
};

// ---- instances -----------------------------------------------------------------------------

/// One parameter as reported by `IEditController::getParameterInfo`.
#[derive(Debug, Clone)]
pub(crate) struct RawParam {
    pub id: u32,
}

/// The audio bus layout chosen by [`Instance::configure`].
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Layout {
    pub inputs: Vec<u32>,
    pub outputs: Vec<u32>,
    pub event_input: bool,
}

/// `"input"` or `"output"`, for error messages.
fn dir_name(dir: sv::BusDirections) -> &'static str {
    if dir == sv::BusDirections_::kInput {
        "input"
    } else {
        "output"
    }
}

pub(super) fn apply_transport(c: &mut sv::ProcessContext, t: &Transport) {
    use sv::ProcessContext_::StatesAndFlags_::{
        kBarPositionValid, kContTimeValid, kPlaying, kProjectTimeMusicValid, kRecording,
        kTempoValid, kTimeSigValid,
    };
    let mut state =
        kTempoValid | kTimeSigValid | kProjectTimeMusicValid | kBarPositionValid | kContTimeValid;
    if t.playing {
        state |= kPlaying;
    }
    if t.recording {
        state |= kRecording;
    }
    // The flag constants are the C default enum type: i32 on Windows, u32 elsewhere.
    #[allow(clippy::unnecessary_cast)]
    let state = state as u32;
    c.state = state;
    c.tempo = t.tempo;
    c.timeSigNumerator = i32::try_from(t.numerator).unwrap_or(4);
    c.timeSigDenominator = i32::try_from(t.denominator).unwrap_or(4);
    c.projectTimeSamples = t.samples;
    c.projectTimeMusic = t.quarters;
    c.barPositionMusic = t.bar_start;
}

/// A live plugin on the main thread: component + edit controller + the host objects. The processor side is
/// [`AudioPart`].
pub(crate) struct Instance {
    pub(super) processor: Option<ComPtr<sv::IAudioProcessor>>,
    pub(super) controller: Option<ComPtr<sv::IEditController>>,
    /// The controller is the component itself (single-component plugin).
    pub(super) single: bool,
    pub(super) connections: Option<(ComPtr<sv::IConnectionPoint>, ComPtr<sv::IConnectionPoint>)>,
    pub(super) component_initialized: bool,
    pub(super) controller_initialized: bool,
    pub(super) active: bool,
    /// `kRealtime` or `kOffline`, for `setupProcessing` and every `process` call.
    pub(super) process_mode: i32,
    pub(super) editor: Arc<EditorLink>,
    // Field order matters for drop: `Drop::drop` shuts the plugin down first; then the component
    // and host objects are released, and the bundle (which keeps the code mapped) goes last.
    pub(super) component: ComPtr<sv::IComponent>,
    pub(super) host: ComWrapper<HostContext>,
    pub(super) bundle: Arc<Bundle>,
}

impl Instance {
    fn processor(&self) -> Option<&ComPtr<sv::IAudioProcessor>> {
        self.processor.as_ref()
    }

    pub fn host(&self) -> &HostContext {
        &self.host
    }

    /// The editor link shared with editor handles (`None` without an edit controller).
    pub fn editor(&self) -> Option<Arc<EditorLink>> {
        self.editor
            .has_controller()
            .then(|| Arc::clone(&self.editor))
    }

    /// The same link, for state handles.
    pub fn state_link(&self) -> Arc<EditorLink> {
        Arc::clone(&self.editor)
    }

    /// Writes one state into a fresh memory stream. TabPlayer: `Err(true)` when the stream refused the write because the
    /// state passes the cap, `Err(false)` when the plugin failed some other way.
    pub(super) fn read_state(
        f: impl FnOnce(*mut sb::IBStream) -> sb::tresult,
    ) -> Result<Vec<u8>, bool> {
        let stream = MemoryStream::new(Vec::new());
        let Some(s) = stream.as_com_ref::<sb::IBStream>() else {
            return Err(false);
        };
        if ok(f(s.as_ptr())) {
            Ok(stream.take())
        } else {
            Err(stream.overflowed())
        }
    }

    /// Restores a component state and a controller state: component `setState`, then the controller's
    /// `setComponentState` and `setState`. `false` when the component refuses the state.
    ///
    /// TabPlayer: SoundCraft took one blob in its own container; TabPlayer's container is split by the caller.
    pub fn load_state(&self, component: &[u8], controller: &[u8]) -> bool {
        let stream = MemoryStream::new(component.to_vec());
        let Some(s) = stream.as_com_ref::<sb::IBStream>() else {
            return false;
        };
        // SAFETY: valid component; the stream lives on this frame for the call.
        if !ok(unsafe { self.component.setState(s.as_ptr()) }) {
            return false;
        }
        if let Some(c) = &self.controller {
            stream.lock().1 = 0;
            // SAFETY: valid controller; the same stream, rewound.
            unsafe { c.setComponentState(s.as_ptr()) };
            if !controller.is_empty() {
                let cs = MemoryStream::new(controller.to_vec());
                if let Some(r) = cs.as_com_ref::<sb::IBStream>() {
                    // SAFETY: valid controller; the stream lives on this frame for the call.
                    unsafe { c.setState(r.as_ptr()) };
                }
            }
        }
        true
    }

    /// Copies the component's state into the controller (`getState` → `setComponentState`).
    pub(super) fn sync_controller_state(&self) {
        let Some(c) = &self.controller else { return };
        let stream = MemoryStream::new(Vec::new());
        let Some(s) = stream.as_com_ref::<sb::IBStream>() else {
            return;
        };
        // SAFETY: valid component; the stream lives on this frame for the whole call.
        if ok(unsafe { self.component.getState(s.as_ptr()) }) {
            stream.lock().1 = 0;
            // SAFETY: valid controller; same stream, rewound.
            unsafe { c.setComponentState(s.as_ptr()) };
        }
    }

    pub fn params(&self) -> Vec<RawParam> {
        let Some(c) = &self.controller else {
            return Vec::new();
        };
        // SAFETY: valid controller.
        let n = unsafe { c.getParameterCount() }.clamp(0, MAX_PARAMS);
        let mut out = Vec::new();
        for i in 0..n {
            // SAFETY: `ParameterInfo` is plain data; all-zero is valid.
            let mut info: sv::ParameterInfo = unsafe { std::mem::zeroed() };
            // SAFETY: index below the count; `info` is writable.
            if !ok(unsafe { c.getParameterInfo(i, &mut info) }) {
                continue;
            }
            out.push(RawParam { id: info.id });
        }
        out
    }

    /// Shows a value change in the editor: `setParamNormalized` on the controller (main thread).
    pub fn set_normalized(&self, id: u32, value: f64) {
        if let Some(c) = &self.controller {
            // SAFETY: valid controller, main thread.
            unsafe { c.setParamNormalized(id, value.clamp(0.0, 1.0)) };
        }
    }

    pub fn latency(&self) -> u32 {
        // SAFETY: valid processor.
        self.processor()
            .map_or(0, |p| unsafe { p.getLatencySamples() })
    }

    /// Offline (`kOffline`: no realtime pressure, e.g. a bounce) or realtime processing, from the
    /// next [`Instance::configure`] on.
    pub fn set_offline(&mut self, offline: bool) {
        self.process_mode = if offline {
            sv::ProcessModes_::kOffline
        } else {
            sv::ProcessModes_::kRealtime
        } as i32;
    }

    fn bus_count(&self, media: sv::MediaTypes, dir: sv::BusDirections) -> i32 {
        // SAFETY: valid component.
        unsafe {
            self.component
                .getBusCount(media as sv::MediaType, dir as sv::BusDirection)
        }
        .max(0)
    }

    /// The plugin's audio buses in one direction. More than `MAX_BUSES` is an error: we never
    /// hand a plugin fewer buses than it advertised.
    fn audio_bus_count(&self, dir: sv::BusDirections) -> Result<i32, Vst3Error> {
        let n = self.bus_count(sv::MediaTypes_::kAudio, dir);
        if n > MAX_BUSES {
            return Err(Vst3Error::Process(format!(
                "{n} audio {} buses (at most {MAX_BUSES} supported)",
                dir_name(dir)
            )));
        }
        Ok(n)
    }

    fn arrangement(&self, dir: sv::BusDirections, index: i32) -> Option<sv::SpeakerArrangement> {
        let p = self.processor()?;
        let mut arr: sv::SpeakerArrangement = 0;
        // SAFETY: valid processor; `arr` is writable.
        ok(unsafe { p.getBusArrangement(dir as sv::BusDirection, index, &mut arr) }).then_some(arr)
    }

    /// Channels of one audio bus. More than `MAX_BUS_CHANNELS` is an error, as for the bus count.
    fn bus_channels(&self, dir: sv::BusDirections, index: i32) -> Result<u32, Vst3Error> {
        let channels = if let Some(arr) = self.arrangement(dir, index) {
            arr.count_ones()
        } else {
            // SAFETY: plain data; all-zero is valid.
            let mut info: sv::BusInfo = unsafe { std::mem::zeroed() };
            // SAFETY: valid component; index below the bus count; `info` is writable.
            if ok(unsafe {
                self.component.getBusInfo(
                    sv::MediaTypes_::kAudio as sv::MediaType,
                    dir as sv::BusDirection,
                    index,
                    &mut info,
                )
            }) {
                u32::try_from(info.channelCount).unwrap_or(0)
            } else {
                0
            }
        };
        if channels > MAX_BUS_CHANNELS {
            return Err(Vst3Error::Process(format!(
                "audio {} bus {index} has {channels} channels (at most {MAX_BUS_CHANNELS} supported)",
                dir_name(dir)
            )));
        }
        Ok(channels)
    }

    /// Deactivates, negotiates the bus layout (main buses mono or stereo as asked, falling back to stereo and then to the
    /// plugin's own choice), activates the main buses, sets up 32-bit processing and activates the component. A layout
    /// beyond `MAX_BUSES` buses or `MAX_BUS_CHANNELS` channels per bus is an error, and the component stays inactive.
    ///
    /// TabPlayer: the caller makes sure the processor is not processing (its `AudioPart` has called `setProcessing(0)`).
    pub fn configure(
        &mut self,
        sample_rate: f64,
        max_frames: usize,
        mono: bool,
    ) -> Result<Layout, Vst3Error> {
        self.shutdown();
        let audio = sv::MediaTypes_::kAudio;
        let event = sv::MediaTypes_::kEvent;
        let (din, dout) = (sv::BusDirections_::kInput, sv::BusDirections_::kOutput);
        let nin = self.audio_bus_count(din)?;
        let nout = self.audio_bus_count(dout)?;
        let current = |s: &Self, dir: sv::BusDirections, n: i32| -> Vec<sv::SpeakerArrangement> {
            (0..n)
                .map(|i| s.arrangement(dir, i).unwrap_or(sv::SpeakerArr::kStereo))
                .collect()
        };
        let want = if mono {
            sv::SpeakerArr::kMono
        } else {
            sv::SpeakerArr::kStereo
        };
        let p = self
            .processor()
            .ok_or_else(|| Vst3Error::Process("no audio processor".into()))?
            .clone();
        let mut tried_ok = false;
        for main in [want, sv::SpeakerArr::kStereo] {
            let mut ins = current(self, din, nin);
            let mut outs = current(self, dout, nout);
            if let Some(a) = ins.first_mut() {
                *a = main;
            }
            if let Some(a) = outs.first_mut() {
                *a = main;
            }
            // SAFETY: valid processor; the arrays hold exactly `nin`/`nout` arrangements and
            // outlive the call.
            if ok(unsafe { p.setBusArrangements(ins.as_mut_ptr(), nin, outs.as_mut_ptr(), nout) }) {
                tried_ok = true;
                break;
            }
            if main == sv::SpeakerArr::kStereo {
                break;
            }
        }
        if !tried_ok {
            log::debug!("vst3: plugin refused mono/stereo bus arrangements; using its own");
        }
        let layout = Layout {
            inputs: (0..nin)
                .map(|i| self.bus_channels(din, i))
                .collect::<Result<_, _>>()?,
            outputs: (0..nout)
                .map(|i| self.bus_channels(dout, i))
                .collect::<Result<_, _>>()?,
            event_input: self.bus_count(event, din) > 0,
        };
        // Main buses on, aux buses off (VST3 still gets buffers for every bus).
        for (dir, n) in [(din, nin), (dout, nout)] {
            for i in 0..n {
                // SAFETY: valid component; index below the bus count.
                unsafe {
                    self.component.activateBus(
                        audio as sv::MediaType,
                        dir as sv::BusDirection,
                        i,
                        u8::from(i == 0),
                    )
                };
            }
        }
        if layout.event_input {
            // SAFETY: valid component; event input bus 0 exists.
            unsafe {
                self.component
                    .activateBus(event as sv::MediaType, din as sv::BusDirection, 0, 1)
            };
        }
        let sample32 = sv::SymbolicSampleSizes_::kSample32 as i32;
        // SAFETY: valid processor.
        if !ok(unsafe { p.canProcessSampleSize(sample32) }) {
            return Err(Vst3Error::Process(
                "plugin cannot process 32-bit float".into(),
            ));
        }
        let max = i32::try_from(max_frames).unwrap_or(i32::MAX);
        let mut setup = sv::ProcessSetup {
            processMode: self.process_mode,
            symbolicSampleSize: sample32,
            maxSamplesPerBlock: max,
            sampleRate: sample_rate,
        };
        // SAFETY: valid processor, inactive; `setup` is a valid struct for the call.
        if !ok(unsafe { p.setupProcessing(&mut setup) }) {
            return Err(Vst3Error::Process("setupProcessing failed".into()));
        }
        // SAFETY: valid component, configured above.
        if !ok(unsafe { self.component.setActive(1) }) {
            return Err(Vst3Error::Process("setActive failed".into()));
        }
        self.active = true;
        Ok(layout)
    }

    /// `setActive(false)` when needed. TabPlayer: `setProcessing(false)` is the processor side's.
    pub fn shutdown(&mut self) {
        if self.active {
            // SAFETY: valid, active component.
            unsafe { self.component.setActive(0) };
            self.active = false;
        }
    }

    /// The processor side for a configured instance: the buffers, the parameter and event objects and the context.
    pub fn audio_part(
        &self,
        layout: &Layout,
        sample_rate: f64,
        max_frames: usize,
        mono: bool,
    ) -> Result<AudioPart, Vst3Error> {
        let processor = self
            .processor
            .clone()
            .ok_or_else(|| Vst3Error::Process("no audio processor".into()))?;
        // SAFETY: `ProcessContext` is plain data (numbers and small structs); all-zero is valid.
        let mut context: sv::ProcessContext = unsafe { std::mem::zeroed() };
        context.sampleRate = sample_rate;
        Ok(AudioPart {
            processor,
            in_params: ComWrapper::new(ParamChanges::new(PARAM_QUEUE_CAP)),
            out_params: ComWrapper::new(ParamChanges::new(PARAM_QUEUE_CAP)),
            in_events: ComWrapper::new(EventList::new(EVENT_CAP)),
            out_events: ComWrapper::new(EventList::new(EVENT_CAP)),
            context,
            inputs: BusBuffers::new(&layout.inputs, max_frames),
            outputs: BusBuffers::new(&layout.outputs, max_frames),
            process_mode: self.process_mode,
            max_frames,
            processing: false,
            mono,
            continuous: 0,
            host: self.host.clone(),
        })
    }
}

/// The processor side of a plugin, owned by the one thread that calls `process`.
pub(crate) struct AudioPart {
    processor: ComPtr<sv::IAudioProcessor>,
    in_params: ComWrapper<ParamChanges>,
    out_params: ComWrapper<ParamChanges>,
    in_events: ComWrapper<EventList>,
    out_events: ComWrapper<EventList>,
    context: sv::ProcessContext,
    inputs: BusBuffers,
    outputs: BusBuffers,
    process_mode: i32,
    max_frames: usize,
    processing: bool,
    /// The main bus is mono: the input is downmixed and the output duplicated.
    mono: bool,
    /// Samples processed since the part was made, never reset by a seek (`continousTimeSamples`).
    continuous: i64,
    host: ComWrapper<HostContext>,
}

// SAFETY: an `AudioPart` is used through `&mut self` by one thread at a time. It is built on the main thread and then
// moved to the audio thread, where every call into the plugin's processor happens; the main thread only calls the
// plugin's controller and component, which VST3 allows alongside `process`. The COM objects it owns are host objects of
// atomics and `try_lock` (a `process` call never blocks on them), and the raw pointers in the bus tables point into
// buffers this struct owns.
unsafe impl Send for AudioPart {}

impl AudioPart {
    /// `setProcessing(false)`. The next `process` call turns it on again. This is what a flush does: it clears the
    /// plugin's tails and delay lines.
    pub fn reset(&mut self) {
        if self.processing {
            // SAFETY: valid processor in the processing state.
            unsafe { self.processor.setProcessing(0) };
            self.processing = false;
        }
    }

    /// Runs one `process` call over `input.len()` frames (at most the configured maximum). The output is silence when the
    /// call fails.
    ///
    /// Parameter edits the main thread queued become points of this block, in order. Never allocates and never takes a
    /// lock.
    pub fn process(
        &mut self,
        input: &[[f32; 2]],
        output: &mut [[f32; 2]],
        transport: &Transport,
    ) -> Result<(), Vst3Error> {
        let frames = input.len();
        let silence = |output: &mut [[f32; 2]]| output.iter_mut().for_each(|f| *f = [0.0; 2]);
        if frames == 0 || frames > self.max_frames || output.len() != frames {
            silence(output);
            return Err(Vst3Error::Process(
                "block larger than the configured size".into(),
            ));
        }
        if !self.processing {
            // Many plugins return kNotImplemented here; that is not an error.
            // SAFETY: valid, active processor.
            unsafe { self.processor.setProcessing(1) };
            self.processing = true;
        }
        self.in_params.clear();
        let last_offset = i32::try_from(frames - 1).unwrap_or(0);
        for _ in 0..EDITS_PER_BLOCK {
            let Some((id, value)) = self.host.edits.pop() else {
                break;
            };
            self.in_params.add_point(id, value, last_offset);
        }
        self.out_params.clear();
        self.in_events.with(Vec::clear);
        self.out_events.with(Vec::clear);
        // The main buses carry the signal; aux buses stay silent (their buffers are zeroed once and never written).
        if let Some(left) = self.inputs.channel_mut(0, 0) {
            if self.mono {
                for (dst, src) in left.iter_mut().zip(input) {
                    *dst = 0.5 * (src[0] + src[1]);
                }
            } else {
                for (dst, src) in left.iter_mut().zip(input) {
                    *dst = src[0];
                }
            }
        }
        if !self.mono
            && let Some(right) = self.inputs.channel_mut(0, 1)
        {
            for (dst, src) in right.iter_mut().zip(input) {
                *dst = src[1];
            }
        }
        for ch in 0..self.outputs.channels(0) {
            if let Some(out) = self.outputs.channel_mut(0, ch) {
                out.fill(0.0);
            }
        }
        self.inputs.refresh();
        self.outputs.refresh();
        self.context.continousTimeSamples = self.continuous;
        self.continuous = self.continuous.saturating_add(frames as i64);
        apply_transport(&mut self.context, transport);
        let mut data = sv::ProcessData {
            processMode: self.process_mode,
            symbolicSampleSize: sv::SymbolicSampleSizes_::kSample32 as i32,
            numSamples: i32::try_from(frames).unwrap_or(0),
            numInputs: i32::try_from(self.inputs.bufs.len()).unwrap_or(0),
            numOutputs: i32::try_from(self.outputs.bufs.len()).unwrap_or(0),
            inputs: if self.inputs.bufs.is_empty() {
                std::ptr::null_mut()
            } else {
                self.inputs.bufs.as_mut_ptr()
            },
            outputs: if self.outputs.bufs.is_empty() {
                std::ptr::null_mut()
            } else {
                self.outputs.bufs.as_mut_ptr()
            },
            inputParameterChanges: self
                .in_params
                .as_com_ref::<sv::IParameterChanges>()
                .map_or(std::ptr::null_mut(), |r| r.as_ptr()),
            outputParameterChanges: self
                .out_params
                .as_com_ref::<sv::IParameterChanges>()
                .map_or(std::ptr::null_mut(), |r| r.as_ptr()),
            inputEvents: self
                .in_events
                .as_com_ref::<sv::IEventList>()
                .map_or(std::ptr::null_mut(), |r| r.as_ptr()),
            outputEvents: self
                .out_events
                .as_com_ref::<sv::IEventList>()
                .map_or(std::ptr::null_mut(), |r| r.as_ptr()),
            processContext: &mut self.context,
        };
        // SAFETY: valid, active processor. Every channel pointer refers to `frames` (or more) valid
        // f32s owned by `self.inputs`/`self.outputs`, borrowed for the whole call; the bus tables, the
        // parameter/event objects and the context are owned by `self` and untouched until the
        // call returns.
        let r = unsafe { self.processor.process(&mut data) };
        if !ok(r) {
            silence(output);
            return Err(Vst3Error::Process(format!("process returned {r}")));
        }
        let (Some(left), right) = (self.outputs.channel(0, 0), self.outputs.channel(0, 1)) else {
            silence(output);
            return Err(Vst3Error::Process("the plugin has no main output".into()));
        };
        match right {
            Some(right) if !self.mono => {
                for ((dst, l), r) in output.iter_mut().zip(left).zip(right) {
                    *dst = [*l, *r];
                }
            }
            _ => {
                for (dst, l) in output.iter_mut().zip(left) {
                    *dst = [*l, *l];
                }
            }
        }
        Ok(())
    }
}

impl Drop for AudioPart {
    fn drop(&mut self) {
        self.reset();
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        // Close any editor and cut its handles off before the controller goes away.
        if self.editor.kill() {
            self.bundle.mark_leaked();
        }
        self.shutdown();
        if let Some((a, b)) = self.connections.take() {
            // SAFETY: the pair was connected in `instantiate`; disconnect before terminating.
            unsafe {
                a.disconnect(b.as_ptr());
                b.disconnect(a.as_ptr());
            }
        }
        if let Some(c) = self.controller.take() {
            // SAFETY: valid controller; detach our handler before it goes away.
            unsafe { c.setComponentHandler(std::ptr::null_mut()) };
            if self.controller_initialized {
                // SAFETY: separately created controller, initialised once; terminated once.
                unsafe { c.terminate() };
            }
        }
        self.processor = None;
        if self.component_initialized {
            // SAFETY: valid component, inactive; terminated exactly once.
            unsafe { self.component.terminate() };
            self.component_initialized = false;
        }
    }
}
