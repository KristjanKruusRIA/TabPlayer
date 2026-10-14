//! Device ownership and bounded controls. Only the stream callback owns the renderer;
//! resource work, stream creation, status events and retired allocations run elsewhere.
use super::{
    backing::BackingMap,
    decode::{DecodedAudio, decode_audio},
    plan::PlaybackPlan,
    renderer::{PreparedMix, Renderer},
    resources::AudioResources,
    voices::{resource_requests, voice_id_for_track},
};
use crate::settings::{ChannelMix, DocumentSettings};
use cpal::{
    FromSample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use ringbuf::{HeapCons, HeapProd, HeapRb, traits::*};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

const CONTROL_CAPACITY: usize = 64;
const BLOCK: usize = 512;
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeSettings {
    pub speed: f64,
    pub metronome: bool,
}
impl Default for PracticeSettings {
    fn default() -> Self {
        Self {
            speed: 1.0,
            metronome: false,
        }
    }
}
impl PracticeSettings {
    fn validate(self) -> Result<(), String> {
        if !self.speed.is_finite() || !(0.25..=2.0).contains(&self.speed) {
            return Err("Speed must be between 25% and 200%.".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStatus {
    pub generation: u64,
    pub desired_generation: u64,
    pub ready: bool,
    pub playing: bool,
    pub tick: f64,
    pub seconds: f64,
    pub duration_seconds: f64,
    pub speed: f64,
    pub metronome: bool,
    pub error: Option<String>,
    pub device_id: Option<String>,
    pub rendered_frames: u64,
    pub output_peak: f64,
    pub backing_duration_seconds: Option<f64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TransportCommand {
    Play {
        generation: u64,
    },
    Pause {
        generation: u64,
    },
    Stop {
        generation: u64,
    },
    Invalidate {
        generation: u64,
    },
    SeekTick {
        generation: u64,
        tick: f64,
    },
    SetSpeed {
        generation: u64,
        speed: f64,
    },
    SetLoop {
        generation: u64,
        start_tick: f64,
        end_tick: f64,
    },
    ClearLoop {
        generation: u64,
    },
    SetMetronome {
        generation: u64,
        enabled: bool,
    },
    SelectDevice {
        generation: u64,
        device_id: Option<String>,
    },
}
impl TransportCommand {
    fn generation(&self) -> u64 {
        match self {
            Self::Play { generation }
            | Self::Pause { generation }
            | Self::Stop { generation }
            | Self::Invalidate { generation }
            | Self::SeekTick { generation, .. }
            | Self::SetSpeed { generation, .. }
            | Self::SetLoop { generation, .. }
            | Self::ClearLoop { generation }
            | Self::SetMetronome { generation, .. }
            | Self::SelectDevice { generation, .. } => *generation,
        }
    }
    fn validate(&self, duration: f64) -> Result<(), &'static str> {
        match self {
            Self::SeekTick { tick, .. } if !tick.is_finite() || *tick < 0.0 || *tick > duration => {
                Err("Seek position is outside the score.")
            }
            Self::SetSpeed { speed, .. } if !speed.is_finite() || !(0.25..=2.0).contains(speed) => {
                Err("Speed must be between 25% and 200%.")
            }
            Self::SetLoop {
                start_tick,
                end_tick,
                ..
            } if !start_tick.is_finite()
                || !end_tick.is_finite()
                || *start_tick < 0.0
                || end_tick <= start_tick
                || *end_tick > duration =>
            {
                Err("Select a valid inclusive measure loop.")
            }
            _ => Ok(()),
        }
    }
}
struct SharedStatus {
    sequence: AtomicU64,
    generation: AtomicU64,
    desired: AtomicU64,
    invalidated: AtomicU64,
    epoch: AtomicU64,
    ready: AtomicBool,
    playing: AtomicBool,
    tick: AtomicU64,
    seconds: AtomicU64,
    duration: AtomicU64,
    speed: AtomicU64,
    metronome: AtomicBool,
    fault: AtomicU8,
    frames: AtomicU64,
    peak: AtomicU64,
    shutdown: AtomicBool,
    device: Mutex<Option<String>>,
    backing_duration: AtomicU64,
}
impl SharedStatus {
    fn new() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            desired: AtomicU64::new(0),
            invalidated: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            ready: AtomicBool::new(false),
            playing: AtomicBool::new(false),
            tick: AtomicU64::new(0f64.to_bits()),
            seconds: AtomicU64::new(0f64.to_bits()),
            duration: AtomicU64::new(0f64.to_bits()),
            speed: AtomicU64::new(1f64.to_bits()),
            metronome: AtomicBool::new(false),
            fault: AtomicU8::new(0),
            frames: AtomicU64::new(0),
            peak: AtomicU64::new(0f64.to_bits()),
            shutdown: AtomicBool::new(false),
            device: Mutex::new(None),
            backing_duration: AtomicU64::new(f64::NAN.to_bits()),
        }
    }
    fn read(&self) -> NativeAudioStatus {
        loop {
            let version = self.sequence.load(Ordering::Acquire);
            if version & 1 != 0 {
                thread::yield_now();
                continue;
            }
            let fault = self.fault.load(Ordering::Acquire);
            let backing = f64::from_bits(self.backing_duration.load(Ordering::Relaxed));
            let status = NativeAudioStatus {
                generation: self.generation.load(Ordering::Relaxed),
                desired_generation: self.desired.load(Ordering::Acquire),
                ready: self.ready.load(Ordering::Relaxed) && fault == 0,
                playing: self.playing.load(Ordering::Relaxed) && fault == 0,
                tick: f64::from_bits(self.tick.load(Ordering::Relaxed)),
                seconds: f64::from_bits(self.seconds.load(Ordering::Relaxed)),
                duration_seconds: f64::from_bits(self.duration.load(Ordering::Relaxed)),
                speed: f64::from_bits(self.speed.load(Ordering::Relaxed)),
                metronome: self.metronome.load(Ordering::Relaxed),
                error: if fault != 0 {
                    Some(
                        "Audio output stopped. Select an available output device to recover."
                            .into(),
                    )
                } else {
                    None
                },
                device_id: self.device.lock().unwrap().clone(),
                rendered_frames: self.frames.load(Ordering::Relaxed),
                output_peak: f64::from_bits(self.peak.load(Ordering::Relaxed)),
                backing_duration_seconds: backing.is_finite().then_some(backing),
            };
            if self.sequence.load(Ordering::Acquire) == version {
                return status;
            }
        }
    }
}

/// The same callback transport is exercisable without an audio device.
pub struct CallbackTransport {
    renderer: Option<Box<Renderer>>,
    generation: u64,
    ready: bool,
    playing: bool,
    tick: f64,
    seconds: f64,
    duration: f64,
    speed: f64,
    metronome: bool,
    loop_range: Option<(f64, f64)>,
    rate: u32,
    shared: Arc<SharedStatus>,
    epoch: u64,
}
impl CallbackTransport {
    pub fn headless(rate: u32) -> Self {
        Self::new(rate, Arc::new(SharedStatus::new()))
    }
    fn new(rate: u32, shared: Arc<SharedStatus>) -> Self {
        let epoch = shared.epoch.load(Ordering::Acquire);
        Self {
            renderer: None,
            generation: 0,
            ready: false,
            playing: false,
            tick: 0.0,
            seconds: 0.0,
            duration: 0.0,
            speed: 1.0,
            metronome: false,
            loop_range: None,
            rate,
            shared,
            epoch,
        }
    }
    pub fn status(&self) -> NativeAudioStatus {
        self.shared.read()
    }
    fn publish(&self) {
        if self.shared.epoch.load(Ordering::Acquire) != self.epoch {
            return;
        }
        self.shared.sequence.fetch_add(1, Ordering::AcqRel);
        self.shared
            .generation
            .store(self.generation, Ordering::Relaxed);
        self.shared.ready.store(self.ready, Ordering::Relaxed);
        self.shared.playing.store(self.playing, Ordering::Relaxed);
        self.shared
            .tick
            .store(self.tick.to_bits(), Ordering::Relaxed);
        self.shared
            .seconds
            .store(self.seconds.to_bits(), Ordering::Relaxed);
        self.shared
            .duration
            .store(self.duration.to_bits(), Ordering::Relaxed);
        self.shared
            .speed
            .store(self.speed.to_bits(), Ordering::Relaxed);
        self.shared
            .metronome
            .store(self.metronome, Ordering::Relaxed);
        self.shared.sequence.fetch_add(1, Ordering::Release);
    }
    /// Returns allocations to the caller; live callers retire them off the callback.
    pub fn install(
        &mut self,
        renderer: Box<Renderer>,
        generation: u64,
        preserve: bool,
    ) -> Option<Box<Renderer>> {
        self.install_with_practice(renderer, generation, preserve, PracticeSettings::default())
    }
    pub fn install_with_practice(
        &mut self,
        mut renderer: Box<Renderer>,
        generation: u64,
        preserve: bool,
        practice: PracticeSettings,
    ) -> Option<Box<Renderer>> {
        if generation < self.generation || generation < self.shared.desired.load(Ordering::Acquire)
        {
            return Some(renderer);
        }
        if preserve && generation == self.generation {
            let _ = renderer.set_speed(self.speed);
            renderer.seek_tick(self.tick);
            renderer.set_metronome(self.metronome);
        } else {
            self.playing = false;
            self.tick = 0.0;
            self.seconds = 0.0;
            self.loop_range = None;
            self.speed = practice.speed;
            self.metronome = practice.metronome;
            let _ = renderer.set_speed(self.speed);
            renderer.set_metronome(self.metronome);
            self.shared.frames.store(0, Ordering::Relaxed);
            self.shared.peak.store(0f64.to_bits(), Ordering::Relaxed);
        }
        self.generation = generation;
        self.duration = renderer.duration_seconds();
        self.ready = true;
        self.shared.fault.store(0, Ordering::Release);
        let previous = self.renderer.replace(renderer);
        self.publish();
        previous
    }
    pub fn command(&mut self, command: TransportCommand) -> Result<(), &'static str> {
        if matches!(command, TransportCommand::Invalidate { .. }) {
            if command.generation() < self.generation {
                return Err("Stale transport generation.");
            }
            self.generation = command.generation();
            self.ready = false;
            self.playing = false;
            self.tick = 0.0;
            self.seconds = 0.0;
            self.loop_range = None;
            if let Some(renderer) = &mut self.renderer {
                renderer.seek_tick(0.0);
            }
            self.publish();
            return Ok(());
        }
        if command.generation() != self.generation {
            return Err("Stale transport generation.");
        }
        let duration = self.renderer.as_ref().map_or(0.0, |r| r.duration_tick());
        command.validate(duration)?;
        if !self.ready || self.shared.fault.load(Ordering::Acquire) != 0 {
            return Err("Audio output is not ready. Select an output device to recover.");
        }
        match command {
            TransportCommand::Play { .. } => {
                if self.tick >= duration {
                    self.seek(0.0);
                }
                self.playing = true;
            }
            TransportCommand::Pause { .. } => self.playing = false,
            TransportCommand::Stop { .. } => {
                self.playing = false;
                self.seek(0.0);
            }
            TransportCommand::SeekTick { tick, .. } => self.seek(tick),
            TransportCommand::SetSpeed { speed, .. } => {
                if let Some(renderer) = &mut self.renderer {
                    let _ = renderer.set_speed(speed);
                }
                self.speed = speed;
            }
            TransportCommand::SetLoop {
                start_tick,
                end_tick,
                ..
            } => {
                self.loop_range = Some((start_tick, end_tick));
                if self.tick < start_tick || self.tick >= end_tick {
                    self.seek(start_tick);
                }
            }
            TransportCommand::ClearLoop { .. } => self.loop_range = None,
            TransportCommand::SetMetronome { enabled, .. } => {
                self.metronome = enabled;
                if let Some(renderer) = &mut self.renderer {
                    renderer.set_metronome(enabled);
                }
            }
            TransportCommand::SelectDevice { .. } => {
                return Err("Device selection must run outside the audio callback.");
            }
            TransportCommand::Invalidate { .. } => unreachable!(),
        }
        self.publish();
        Ok(())
    }
    fn seek(&mut self, tick: f64) {
        if let Some(renderer) = &mut self.renderer {
            renderer.seek_tick(tick);
            self.seconds = renderer.tick_to_seconds(tick);
        }
        self.tick = tick;
    }
    pub fn device_error(&mut self) {
        self.shared.fault.store(1, Ordering::Release);
        self.ready = false;
        self.playing = false;
        self.publish();
    }
    pub fn render_into(&mut self, output: &mut [[f32; 2]]) {
        output.fill([0.0; 2]);
        let invalidated = self.shared.invalidated.load(Ordering::Acquire);
        if invalidated > self.generation {
            let _ = self.command(TransportCommand::Invalidate {
                generation: invalidated,
            });
        }
        if self.shared.fault.load(Ordering::Acquire) != 0 {
            self.ready = false;
            self.playing = false;
            self.publish();
            return;
        }
        let mut offset = 0;
        while self.playing && offset < output.len() {
            if let Some((start, end)) = self.loop_range {
                if self.tick >= end - 1e-7 {
                    self.seek(start);
                }
            }
            let mut count = (output.len() - offset).min(BLOCK);
            if let (Some((_, end)), Some(renderer)) = (self.loop_range, &self.renderer) {
                let frames = ((renderer.tick_to_seconds(end) - self.seconds) * self.rate as f64
                    / self.speed
                    - 1e-7)
                    .ceil()
                    .max(1.0) as usize;
                count = count.min(frames);
            }
            let Some(renderer) = &mut self.renderer else {
                self.playing = false;
                break;
            };
            let status = renderer.render_into(&mut output[offset..offset + count]);
            self.tick = status.tick;
            self.seconds = status.seconds;
            offset += count;
            if status.ended {
                if let Some((start, _)) = self.loop_range {
                    self.seek(start);
                } else {
                    self.playing = false;
                }
            }
        }
        if let Some((start, end)) = self.loop_range {
            if self.playing && self.tick >= end - 1e-7 {
                self.seek(start);
            }
        }
        if offset > 0 {
            self.shared
                .frames
                .fetch_add(offset as u64, Ordering::Relaxed);
            let peak = output[..offset]
                .iter()
                .flat_map(|f| f.iter())
                .fold(0.0f64, |p, x| p.max(x.abs() as f64));
            let previous = f64::from_bits(self.shared.peak.load(Ordering::Relaxed));
            if peak > previous {
                self.shared.peak.store(peak.to_bits(), Ordering::Relaxed);
            }
        }
        self.publish();
    }
}
enum CallbackCommand {
    Install {
        renderer: Box<Renderer>,
        generation: u64,
        preserve: bool,
        practice: PracticeSettings,
    },
    Mix {
        mix: PreparedMix,
        generation: u64,
    },
    Transport(TransportCommand),
}
#[allow(dead_code)]
enum Retired {
    Renderer(Box<Renderer>),
    Mix(PreparedMix),
}
struct OutputCallback {
    transport: CallbackTransport,
    controls: HeapCons<CallbackCommand>,
    retired: HeapProd<Retired>,
    scratch: [[f32; 2]; BLOCK],
    epoch: u64,
}
impl OutputCallback {
    fn render<T: SizedSample + FromSample<f32>>(&mut self, output: &mut [T], channels: usize) {
        if self.transport.shared.epoch.load(Ordering::Acquire) != self.epoch {
            output.fill(T::from_sample(0.0));
            return;
        }
        // Reserve a retirement slot before consuming an owning command.
        for _ in 0..CONTROL_CAPACITY {
            if self.retired.is_full() {
                break;
            }
            let Some(command) = self.controls.try_pop() else {
                break;
            };
            match command {
                CallbackCommand::Install {
                    renderer,
                    generation,
                    preserve,
                    practice,
                } => {
                    if let Some(old) = self
                        .transport
                        .install_with_practice(renderer, generation, preserve, practice)
                    {
                        let _ = self.retired.try_push(Retired::Renderer(old));
                    }
                }
                CallbackCommand::Mix { mix, generation } => {
                    let old = if generation == self.transport.generation {
                        if let Some(renderer) = &mut self.transport.renderer {
                            renderer.replace_mix(mix)
                        } else {
                            mix
                        }
                    } else {
                        mix
                    };
                    let _ = self.retired.try_push(Retired::Mix(old));
                }
                CallbackCommand::Transport(command) => {
                    let _ = self.transport.command(command);
                }
            }
        }
        for chunk in output.chunks_mut(BLOCK * channels) {
            let frames = chunk.len() / channels;
            self.transport.render_into(&mut self.scratch[..frames]);
            for (frame, source) in chunk.chunks_mut(channels).zip(&self.scratch[..frames]) {
                for (channel, sample) in frame.iter_mut().enumerate() {
                    let value = if channels == 1 {
                        (source[0] + source[1]) * 0.5
                    } else {
                        source.get(channel).copied().unwrap_or(0.0)
                    };
                    *sample = T::from_sample(if value.is_finite() {
                        value.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    });
                }
            }
        }
    }
}

#[derive(Clone)]
struct PreparedDocument {
    plan: Arc<PlaybackPlan>,
    settings: DocumentSettings,
    resources: Arc<AudioResources>,
    backing: Option<Arc<DecodedAudio>>,
    practice: PracticeSettings,
}
struct ControlState {
    producer: Option<HeapProd<CallbackCommand>>,
    document: Option<PreparedDocument>,
    rate: u32,
    device: Option<String>,
}
struct OpenRequest {
    device: cpal::Device,
    config: cpal::SupportedStreamConfig,
    callback: OutputCallback,
    retired: HeapCons<Retired>,
    reply: mpsc::Sender<Result<(), String>>,
}
enum ManagerRequest {
    Open(OpenRequest),
    Shutdown,
}
pub struct AudioService {
    root: PathBuf,
    shared: Arc<SharedStatus>,
    control: Mutex<ControlState>,
    manager: mpsc::Sender<ManagerRequest>,
}
impl AudioService {
    pub fn new(
        resource_root: PathBuf,
        publish: Arc<dyn Fn(NativeAudioStatus) + Send + Sync>,
    ) -> Self {
        let shared = Arc::new(SharedStatus::new());
        let (manager, requests) = mpsc::channel();
        let manager_shared = shared.clone();
        thread::Builder::new()
            .name("native-audio-device".into())
            .spawn(move || device_manager(requests, manager_shared))
            .expect("Audio device manager thread");
        let status_shared = shared.clone();
        thread::Builder::new()
            .name("native-audio-status".into())
            .spawn(move || {
                while !status_shared.shutdown.load(Ordering::Acquire) {
                    publish(status_shared.read());
                    thread::sleep(Duration::from_millis(33));
                }
            })
            .expect("Audio status thread");
        Self {
            root: resource_root,
            shared,
            control: Mutex::new(ControlState {
                producer: None,
                document: None,
                rate: 48_000,
                device: None,
            }),
            manager,
        }
    }
    pub fn status(&self) -> NativeAudioStatus {
        self.shared.read()
    }
    pub fn devices(&self) -> Result<Vec<AudioDeviceInfo>, String> {
        let host = cpal::default_host();
        let default = host.default_output_device();
        host.output_devices()
            .map_err(|e| format!("Could not enumerate audio outputs: {e}"))?
            .map(|device| {
                Ok(AudioDeviceInfo {
                    id: device.id().map_err(|e| e.to_string())?.to_string(),
                    name: device.to_string(),
                    is_default: default.as_ref() == Some(&device),
                })
            })
            .collect()
    }
    /// Includes a validated document retained after an output-device failure.
    pub fn prepared_generation(&self) -> Option<u64> {
        self.control
            .lock()
            .unwrap()
            .document
            .as_ref()
            .map(|document| document.plan.generation)
    }
    pub fn prepare(
        &self,
        plan: PlaybackPlan,
        settings: DocumentSettings,
        backing_bytes: Option<Vec<u8>>,
    ) -> Result<(), String> {
        self.prepare_with_practice(plan, settings, backing_bytes, PracticeSettings::default())
    }
    pub fn prepare_with_practice(
        &self,
        plan: PlaybackPlan,
        settings: DocumentSettings,
        backing_bytes: Option<Vec<u8>>,
        practice: PracticeSettings,
    ) -> Result<(), String> {
        practice.validate()?;
        plan.validate()?;
        let generation = plan.generation;
        let previous = self.shared.desired.fetch_max(generation, Ordering::AcqRel);
        let result = self.prepare_current(plan, settings, backing_bytes, practice);
        if result.is_err() {
            let live = self
                .control
                .lock()
                .unwrap()
                .document
                .as_ref()
                .map_or(previous, |document| document.plan.generation);
            let _ = self.shared.desired.compare_exchange(
                generation,
                live,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        result
    }
    fn prepare_current(
        &self,
        plan: PlaybackPlan,
        settings: DocumentSettings,
        backing_bytes: Option<Vec<u8>>,
        practice: PracticeSettings,
    ) -> Result<(), String> {
        let generation = plan.generation;
        let mut state = self.control.lock().unwrap();
        if generation != self.shared.desired.load(Ordering::Acquire) {
            return Err("A newer score preparation superseded this request.".into());
        }
        let resources = Arc::new(AudioResources::load_for_requests(
            &self.root,
            &resource_requests(&plan, &settings),
        )?);
        let backing = backing_bytes
            .map(|bytes| decode_audio(&bytes, None).map(Arc::new))
            .transpose()?;
        let document = PreparedDocument {
            plan: Arc::new(plan),
            settings,
            resources,
            backing,
            practice,
        };
        if state.producer.is_none() || self.shared.fault.load(Ordering::Acquire) != 0 {
            // Validate music independently of the available device. Retain it after
            // an output failure so selecting a working device can recover it.
            let _ = Self::renderer(&document, state.rate)?;
            if let Err(error) = self.open(&mut state, document.clone(), false) {
                if self.shared.desired.load(Ordering::Acquire) == generation
                    && self.shared.fault.load(Ordering::Acquire) != 0
                {
                    state.document = Some(document);
                }
                return Err(error);
            }
        } else {
            let renderer = Self::renderer(&document, state.rate)?;
            if generation != self.shared.desired.load(Ordering::Acquire) {
                return Err("A newer score preparation superseded this request.".into());
            }
            Self::enqueue(
                &mut state,
                CallbackCommand::Install {
                    renderer,
                    generation,
                    preserve: false,
                    practice,
                },
            )?;
            self.set_backing_duration(&document);
            state.document = Some(document);
        }
        Ok(())
    }
    fn set_backing_duration(&self, document: &PreparedDocument) {
        let value = document
            .backing
            .as_ref()
            .map_or(f64::NAN, |a| a.frames.len() as f64 / a.sample_rate as f64);
        self.shared
            .backing_duration
            .store(value.to_bits(), Ordering::Relaxed);
    }
    fn renderer(document: &PreparedDocument, rate: u32) -> Result<Box<Renderer>, String> {
        let mut renderer = Renderer::new(
            document.plan.clone(),
            document.resources.clone(),
            document.settings.clone(),
            rate,
        )?;
        if let Some(audio) = &document.backing {
            let (anchors, offset, mix) = document
                .settings
                .backing
                .as_ref()
                .map_or((&[][..], 0.0, ChannelMix::default()), |b| {
                    (b.anchors.as_slice(), b.offset_ms, b.mix.clone())
                });
            renderer.install_backing(
                audio.clone(),
                BackingMap::new(anchors, offset, &document.plan)?,
                mix,
            )?;
        }
        Ok(Box::new(renderer))
    }
    fn enqueue(state: &mut ControlState, command: CallbackCommand) -> Result<(), String> {
        state
            .producer
            .as_mut()
            .ok_or("Audio output is not ready.")?
            .try_push(command)
            .map_err(|_| "Audio control queue is full; retry the control.".to_string())
    }
    pub fn set_mix(&self, settings: DocumentSettings, generation: u64) -> Result<(), String> {
        self.set_mix_inner(settings, generation, None)
    }
    pub fn set_mix_with_backing(
        &self,
        settings: DocumentSettings,
        generation: u64,
        backing_bytes: Option<Vec<u8>>,
    ) -> Result<(), String> {
        self.set_mix_inner(settings, generation, Some(backing_bytes))
    }
    fn set_mix_inner(
        &self,
        settings: DocumentSettings,
        generation: u64,
        backing_bytes: Option<Option<Vec<u8>>>,
    ) -> Result<(), String> {
        let mut state = self.control.lock().unwrap();
        let old = state
            .document
            .as_ref()
            .ok_or("Prepare a score before setting sound.")?;
        if old.plan.generation != generation
            || self.shared.desired.load(Ordering::Acquire) != generation
        {
            return Err("Stale sound configuration.".into());
        }
        let voice_changed = old.plan.tracks.iter().any(|track| {
            voice_id_for_track(track, &settings) != voice_id_for_track(track, &old.settings)
        });
        let map_changed = match (&old.settings.backing, &settings.backing) {
            (Some(a), Some(b)) => {
                a.asset_id != b.asset_id || a.offset_ms != b.offset_ms || a.anchors != b.anchors
            }
            (None, None) => false,
            _ => true,
        };
        let presence_changed = backing_bytes
            .as_ref()
            .is_some_and(|bytes| bytes.is_some() != old.backing.is_some());
        if voice_changed || map_changed || presence_changed {
            let resources = if voice_changed {
                Arc::new(AudioResources::load_for_requests(
                    &self.root,
                    &resource_requests(&old.plan, &settings),
                )?)
            } else {
                old.resources.clone()
            };
            let backing = if (map_changed || presence_changed) && backing_bytes.is_some() {
                let bytes = backing_bytes.unwrap();
                bytes
                    .map(|bytes| decode_audio(&bytes, None).map(Arc::new))
                    .transpose()?
            } else {
                old.backing.clone()
            };
            let document = PreparedDocument {
                plan: old.plan.clone(),
                backing,
                resources,
                settings,
                practice: old.practice,
            };
            let renderer = Self::renderer(&document, state.rate)?;
            Self::enqueue(
                &mut state,
                CallbackCommand::Install {
                    renderer,
                    generation,
                    preserve: true,
                    practice: document.practice,
                },
            )?;
            self.set_backing_duration(&document);
            state.document = Some(document);
        } else {
            let mix = PreparedMix::prepare(&settings, &old.plan, state.rate)?;
            Self::enqueue(&mut state, CallbackCommand::Mix { mix, generation })?;
            state.document.as_mut().unwrap().settings = settings;
        }
        Ok(())
    }
    pub fn command(&self, command: TransportCommand) -> Result<(), String> {
        if let TransportCommand::Invalidate { generation } = command {
            self.shared.desired.fetch_max(generation, Ordering::AcqRel);
            self.shared
                .invalidated
                .fetch_max(generation, Ordering::AcqRel);
            return Ok(());
        }
        let mut state = self.control.lock().unwrap();
        let document = state
            .document
            .as_ref()
            .ok_or("Prepare a score before playback.")?;
        if command.generation() != document.plan.generation
            || command.generation() != self.shared.desired.load(Ordering::Acquire)
        {
            return Err("Stale transport generation.".into());
        }
        command
            .validate(document.plan.duration_tick)
            .map_err(str::to_string)?;
        if let TransportCommand::SelectDevice { device_id, .. } = command {
            let saved = PreparedDocument {
                plan: document.plan.clone(),
                settings: document.settings.clone(),
                resources: document.resources.clone(),
                backing: document.backing.clone(),
                practice: document.practice,
            };
            state.device = device_id;
            return self.open(&mut state, saved, true);
        }
        if self.shared.fault.load(Ordering::Acquire) != 0 {
            return Err("Audio output stopped. Select an output device to recover.".into());
        }
        let accepted = command.clone();
        Self::enqueue(&mut state, CallbackCommand::Transport(command))?;
        match accepted {
            TransportCommand::SetSpeed { speed, .. } => {
                state.document.as_mut().unwrap().practice.speed = speed
            }
            TransportCommand::SetMetronome { enabled, .. } => {
                state.document.as_mut().unwrap().practice.metronome = enabled
            }
            _ => {}
        }
        Ok(())
    }
    fn open(
        &self,
        state: &mut ControlState,
        document: PreparedDocument,
        preserve: bool,
    ) -> Result<(), String> {
        let (device, config) = choose_output(state.device.as_deref()).map_err(|error| {
            self.shared.fault.store(1, Ordering::Release);
            error
        })?;
        let rate = config.sample_rate();
        let mut renderer = Self::renderer(&document, rate)?;
        let snapshot = self.status();
        let preserve_position = preserve && snapshot.generation == document.plan.generation;
        renderer.set_speed(document.practice.speed)?;
        renderer.set_metronome(document.practice.metronome);
        if preserve_position {
            renderer.seek_tick(snapshot.tick);
        }
        if document.plan.generation != self.shared.desired.load(Ordering::Acquire) {
            return Err("A newer score preparation superseded this request.".into());
        }
        let (producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired_out, retired) = HeapRb::new(CONTROL_CAPACITY).split();
        let epoch = self.shared.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let mut transport = CallbackTransport::new(rate, self.shared.clone());
        transport.duration = renderer.duration_seconds();
        transport.renderer = Some(renderer);
        transport.generation = document.plan.generation;
        transport.ready = true;
        transport.speed = document.practice.speed;
        transport.metronome = document.practice.metronome;
        if preserve_position {
            transport.tick = snapshot.tick;
            transport.seconds = snapshot.seconds;
            transport.playing = snapshot.playing;
        } else {
            self.shared.frames.store(0, Ordering::Relaxed);
            self.shared.peak.store(0f64.to_bits(), Ordering::Relaxed);
        }
        let actual_id = device.id().map_err(|e| e.to_string())?.to_string();
        let (reply, answer) = mpsc::channel();
        let callback = OutputCallback {
            transport,
            controls,
            retired: retired_out,
            scratch: [[0.0; 2]; BLOCK],
            epoch,
        };
        self.manager
            .send(ManagerRequest::Open(OpenRequest {
                device,
                config,
                callback,
                retired,
                reply,
            }))
            .map_err(|_| "Audio device manager stopped.")?;
        answer
            .recv()
            .map_err(|_| "Audio device manager stopped.")??;
        *self.shared.device.lock().unwrap() = Some(actual_id);
        self.set_backing_duration(&document);
        state.rate = rate;
        state.producer = Some(producer);
        state.document = Some(document);
        Ok(())
    }
}
impl Drop for AudioService {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Release);
        let _ = self.manager.send(ManagerRequest::Shutdown);
    }
}
fn choose_output(id: Option<&str>) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let host = cpal::default_host();
    let device = if let Some(id) = id {
        host.output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.id().is_ok_and(|x| x.to_string() == id))
            .ok_or("Selected audio output is unavailable.")?
    } else {
        host.default_output_device()
            .ok_or("No audio output device is available.")?
    };
    let config = device
        .default_output_config()
        .map_err(|e| format!("Could not configure audio output: {e}"))?;
    if config.channels() == 0 || !(8000..=192_000).contains(&config.sample_rate()) {
        return Err("Audio output requires a sample rate from 8 to 192 kHz.".into());
    }
    Ok((device, config))
}
fn build_stream<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    mut callback: OutputCallback,
) -> Result<cpal::Stream, String> {
    let channels = config.channels() as usize;
    let shared = callback.transport.shared.clone();
    let epoch = callback.epoch;
    device
        .build_output_stream(
            config.clone().into(),
            move |data: &mut [T], _| callback.render(data, channels),
            move |error| {
                // Backend notifications about rerouting/xruns do not mean playback has failed.
                if !matches!(
                    error.kind(),
                    cpal::ErrorKind::DeviceChanged
                        | cpal::ErrorKind::Xrun
                        | cpal::ErrorKind::RealtimeDenied
                ) && shared.epoch.load(Ordering::Acquire) == epoch
                {
                    shared.fault.store(1, Ordering::Release);
                }
            },
            None,
        )
        .map_err(|e| format!("Could not open audio output: {e}"))
}
fn device_manager(requests: mpsc::Receiver<ManagerRequest>, shared: Arc<SharedStatus>) {
    let mut stream: Option<cpal::Stream> = None;
    let mut retired: Option<HeapCons<Retired>> = None;
    loop {
        if let Some(queue) = &mut retired {
            while let Some(old) = queue.try_pop() {
                drop(old);
            }
        }
        match requests.recv_timeout(Duration::from_millis(8)) {
            Ok(ManagerRequest::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Ok(ManagerRequest::Open(request)) => {
                let OpenRequest {
                    device,
                    config,
                    callback,
                    retired: next_retired,
                    reply,
                } = request;
                let next = match config.sample_format() {
                    SampleFormat::F32 => build_stream::<f32>(&device, &config, callback),
                    SampleFormat::F64 => build_stream::<f64>(&device, &config, callback),
                    SampleFormat::I8 => build_stream::<i8>(&device, &config, callback),
                    SampleFormat::I16 => build_stream::<i16>(&device, &config, callback),
                    SampleFormat::I24 => build_stream::<cpal::I24>(&device, &config, callback),
                    SampleFormat::I32 => build_stream::<i32>(&device, &config, callback),
                    SampleFormat::I64 => build_stream::<i64>(&device, &config, callback),
                    SampleFormat::U8 => build_stream::<u8>(&device, &config, callback),
                    SampleFormat::U16 => build_stream::<u16>(&device, &config, callback),
                    SampleFormat::U32 => build_stream::<u32>(&device, &config, callback),
                    SampleFormat::U64 => build_stream::<u64>(&device, &config, callback),
                    _ => Err("This audio output sample format is unsupported.".into()),
                }
                .and_then(|candidate| {
                    shared.fault.store(0, Ordering::Release);
                    candidate
                        .play()
                        .map_err(|e| format!("Could not start audio output: {e}"))?;
                    Ok(candidate)
                });
                match next {
                    Ok(next) => {
                        stream = Some(next);
                        retired = Some(next_retired);
                        let _ = reply.send(Ok(()));
                    }
                    Err(error) => {
                        shared.fault.store(1, Ordering::Release);
                        let _ = reply.send(Err(error));
                    }
                }
            }
        }
    }
    drop(stream);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unavailable_device_with_practice() -> AudioService {
        let service = AudioService::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            Arc::new(|_| {}),
        );
        service.control.lock().unwrap().device = Some("unavailable-test-device".into());
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap();
        assert!(
            service
                .prepare_with_practice(
                    plan,
                    DocumentSettings::default(),
                    None,
                    PracticeSettings {
                        speed: 0.5,
                        metronome: true
                    }
                )
                .is_err()
        );
        assert_eq!(service.prepared_generation(), Some(1));
        service
    }
    #[test]
    fn initial_device_failure_retains_prepared_practice_for_recovery() {
        let service = unavailable_device_with_practice();
        let document = service.control.lock().unwrap().document.clone().unwrap();
        assert_eq!(document.practice.speed, 0.5);
        assert!(document.practice.metronome);
        let mut transport = CallbackTransport::headless(48_000);
        transport.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            true,
            document.practice,
        );
        assert_eq!(transport.status().speed, 0.5);
        assert!(transport.status().metronome);
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        transport.render_into(&mut [[0.0; 2]; 512]);
        assert!(transport.status().tick > 10.0 && transport.status().tick < 11.0);
        assert!(transport.status().output_peak > 0.001);
    }
    #[test]
    #[ignore = "Requires an available native audio output device."]
    fn actual_initial_device_recovery_keeps_prepared_practice() {
        let service = unavailable_device_with_practice();
        service
            .command(TransportCommand::SelectDevice {
                generation: 1,
                device_id: None,
            })
            .unwrap();
        service
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let status = service.status();
            if status.ready && status.playing && status.rendered_frames > 512 {
                assert_eq!(status.speed, 0.5);
                assert!(status.metronome);
                assert!(status.output_peak > 0.001);
                break;
            }
            assert!(std::time::Instant::now() < until, "{status:?}");
            thread::sleep(Duration::from_millis(10));
        }
        service
            .command(TransportCommand::Stop { generation: 1 })
            .unwrap();
    }
    #[test]
    fn invalid_practice_does_not_replace_a_retained_document() {
        let service = unavailable_device_with_practice();
        let plan = service
            .control
            .lock()
            .unwrap()
            .document
            .as_ref()
            .unwrap()
            .plan
            .as_ref()
            .clone();
        for speed in [f64::NAN, 0.24, 2.01] {
            assert!(
                service
                    .prepare_with_practice(
                        plan.clone(),
                        DocumentSettings::default(),
                        None,
                        PracticeSettings {
                            speed,
                            metronome: false
                        }
                    )
                    .is_err()
            );
            assert_eq!(service.prepared_generation(), Some(1));
            assert_eq!(service.shared.desired.load(Ordering::Acquire), 1);
        }
    }
    #[test]
    fn invalidate_does_not_wait_for_preparation_mutex() {
        let service = Arc::new(AudioService::new(PathBuf::new(), Arc::new(|_| {})));
        let preparation = service.control.lock().unwrap();
        let (sender, received) = mpsc::channel();
        let worker = service.clone();
        let thread = thread::spawn(move || {
            let result = worker.command(TransportCommand::Invalidate { generation: 7 });
            sender.send(result).unwrap();
        });
        let immediate = received.recv_timeout(Duration::from_millis(100));
        drop(preparation);
        thread.join().unwrap();
        assert!(
            immediate.is_ok(),
            "Invalidation must interrupt preparation without waiting on its control mutex."
        );
    }
}
