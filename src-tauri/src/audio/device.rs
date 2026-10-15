//! Device ownership and bounded controls. Only the stream callback owns the renderer;
//! resource work, stream creation, status events and retired allocations run elsewhere.
use super::{
    backing::BackingMap,
    decode::{DecodedAudio, decode_audio},
    plan::PlaybackPlan,
    playback::PlaybackSpan,
    practice::{
        ClickVoice, CountInClock, CountInSnapshot, MetronomeSettings, PracticeTempo, PulsePosition,
        RenderTempo, progressive_ratio,
    },
    reference_sync::ReferenceSyncMap,
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

fn reference_timing_changed(
    before: Option<&crate::settings::BackingSettings>,
    after: Option<&crate::settings::BackingSettings>,
) -> bool {
    if !before.is_some_and(|b| b.reference_sync.is_some())
        && !after.is_some_and(|b| b.reference_sync.is_some())
    {
        return false;
    }
    match (before, after) {
        (Some(a), Some(b)) => {
            a.asset_id != b.asset_id
                || a.offset_ms != b.offset_ms
                || a.anchors != b.anchors
                || a.reference_sync != b.reference_sync
        }
        _ => true,
    }
}

const CONTROL_CAPACITY: usize = 64;
const BLOCK: usize = 512;
pub use super::practice::PracticeSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PracticePhase {
    Idle,
    CountIn,
    Playing,
    Paused,
    Ended,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticePulse {
    pub serial: u64,
    pub beat: u32,
    pub beats_per_bar: u32,
    pub accent: bool,
    pub counting: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeStatus {
    pub settings: PracticeSettings,
    pub phase: PracticePhase,
    pub count_in_remaining: u32,
    pub completed_passes: u64,
    pub effective_ratio: f64,
    pub current_bpm: f64,
    pub pulse: Option<PracticePulse>,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeLoop {
    pub start_tick: f64,
    pub end_tick: f64,
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
    pub practice: PracticeStatus,
    pub r#loop: Option<PracticeLoop>,
    pub range: Option<PlaybackSpan>,
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
    PlayRange {
        generation: u64,
        start_tick: f64,
        #[serde(deserialize_with = "crate::edit_types::required_nullable")]
        end_tick: Option<f64>,
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
    SetPractice {
        generation: u64,
        settings: PracticeSettings,
    },
    SetLoop {
        generation: u64,
        start_tick: f64,
        end_tick: f64,
    },
    ClearLoop {
        generation: u64,
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
            | Self::PlayRange { generation, .. }
            | Self::Pause { generation }
            | Self::Stop { generation }
            | Self::Invalidate { generation }
            | Self::SeekTick { generation, .. }
            | Self::SetPractice { generation, .. }
            | Self::SetLoop { generation, .. }
            | Self::ClearLoop { generation }
            | Self::SelectDevice { generation, .. } => *generation,
        }
    }
    fn validate(&self, duration: f64) -> Result<(), &'static str> {
        match self {
            Self::PlayRange {
                start_tick,
                end_tick,
                ..
            } if !start_tick.is_finite()
                || *start_tick < 0.0
                || *start_tick >= duration
                || end_tick.is_some_and(|end| {
                    !end.is_finite() || end <= *start_tick || end > duration
                }) =>
            {
                Err("Select a valid playback passage within the score.")
            }
            Self::SeekTick { tick, .. } if !tick.is_finite() || *tick < 0.0 || *tick > duration => {
                Err("Seek position is outside the score.")
            }
            Self::SetPractice { settings, .. } => settings.validate(false),
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
#[cfg(test)]
mod selection_command_contract_tests {
    use super::TransportCommand;

    #[test]
    fn range_command_rejects_invalid_span_before_state_mutation() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/selection-playback-protocol.json"
        ))
        .unwrap();
        let duration = cases["durationTick"].as_f64().unwrap();
        for case in cases["commands"].as_array().unwrap() {
            if case["decode"] == false {
                continue;
            }
            let command: TransportCommand = serde_json::from_value(case["value"].clone()).unwrap();
            assert_eq!(
                command.validate(duration).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                TransportCommand::PlayRange {
                    generation: 7,
                    start_tick: value,
                    end_tick: None
                }
                .validate(duration)
                .is_err()
            );
            assert!(
                TransportCommand::PlayRange {
                    generation: 7,
                    start_tick: 0.0,
                    end_tick: Some(value)
                }
                .validate(duration)
                .is_err()
            );
        }
    }
}
// All callback runtime fields are scalar atomics, read together under sequence.
struct SharedPractice {
    kind: AtomicU8,
    a: AtomicU64,
    b: AtomicU64,
    step: AtomicU64,
    repetitions: AtomicU64,
    enabled: AtomicBool,
    volume: AtomicU64,
    visual: AtomicBool,
    bars: AtomicU8,
    between: AtomicBool,
}
impl SharedPractice {
    fn new() -> Self {
        Self {
            kind: AtomicU8::new(0),
            a: AtomicU64::new(1f64.to_bits()),
            b: AtomicU64::new(1f64.to_bits()),
            step: AtomicU64::new(0),
            repetitions: AtomicU64::new(1),
            enabled: AtomicBool::new(false),
            volume: AtomicU64::new(0.4f64.to_bits()),
            visual: AtomicBool::new(false),
            bars: AtomicU8::new(0),
            between: AtomicBool::new(false),
        }
    }
    fn store(&self, value: PracticeSettings) {
        let (kind, a, b, step, repetitions) = match value.tempo {
            PracticeTempo::Relative { ratio } => (0, ratio, 0.0, 0.0, 1),
            PracticeTempo::Fixed { bpm } => (1, bpm, 0.0, 0.0, 1),
            PracticeTempo::Progressive {
                start,
                end,
                step,
                repetitions,
            } => (2, start, end, step, repetitions),
        };
        self.kind.store(kind, Ordering::Relaxed);
        self.a.store(a.to_bits(), Ordering::Relaxed);
        self.b.store(b.to_bits(), Ordering::Relaxed);
        self.step.store(step.to_bits(), Ordering::Relaxed);
        self.repetitions
            .store(repetitions.into(), Ordering::Relaxed);
        self.enabled
            .store(value.metronome.enabled, Ordering::Relaxed);
        self.volume
            .store(value.metronome.volume.to_bits(), Ordering::Relaxed);
        self.visual.store(value.metronome.visual, Ordering::Relaxed);
        self.bars.store(value.count_in.bars, Ordering::Relaxed);
        self.between
            .store(value.count_in.between_loops, Ordering::Relaxed);
    }
    fn read(&self) -> PracticeSettings {
        let a = f64::from_bits(self.a.load(Ordering::Relaxed));
        PracticeSettings {
            tempo: match self.kind.load(Ordering::Relaxed) {
                1 => PracticeTempo::Fixed { bpm: a },
                2 => PracticeTempo::Progressive {
                    start: a,
                    end: f64::from_bits(self.b.load(Ordering::Relaxed)),
                    step: f64::from_bits(self.step.load(Ordering::Relaxed)),
                    repetitions: self.repetitions.load(Ordering::Relaxed) as u32,
                },
                _ => PracticeTempo::Relative { ratio: a },
            },
            metronome: MetronomeSettings {
                enabled: self.enabled.load(Ordering::Relaxed),
                volume: f64::from_bits(self.volume.load(Ordering::Relaxed)),
                visual: self.visual.load(Ordering::Relaxed),
            },
            count_in: super::practice::CountInSettings {
                bars: self.bars.load(Ordering::Relaxed),
                between_loops: self.between.load(Ordering::Relaxed),
            },
        }
    }
}
struct SharedCount {
    present: AtomicBool,
    bars: AtomicU8,
    numerator: AtomicU64,
    denominator: AtomicU64,
    bpm: AtomicU64,
    rate: AtomicU64,
    total: AtomicU64,
    elapsed: AtomicU64,
    emitted: AtomicU64,
}
impl SharedCount {
    fn new() -> Self {
        Self {
            present: AtomicBool::new(false),
            bars: AtomicU8::new(0),
            numerator: AtomicU64::new(0),
            denominator: AtomicU64::new(0),
            bpm: AtomicU64::new(0),
            rate: AtomicU64::new(0),
            total: AtomicU64::new(0),
            elapsed: AtomicU64::new(0),
            emitted: AtomicU64::new(0),
        }
    }
    fn store(&self, value: Option<CountInSnapshot>) {
        self.present.store(value.is_some(), Ordering::Relaxed);
        if let Some(v) = value {
            self.bars.store(v.bars, Ordering::Relaxed);
            self.numerator.store(v.numerator.into(), Ordering::Relaxed);
            self.denominator
                .store(v.denominator.into(), Ordering::Relaxed);
            self.bpm.store(v.bpm.to_bits(), Ordering::Relaxed);
            self.rate.store(v.rate.into(), Ordering::Relaxed);
            self.total.store(v.total_frames, Ordering::Relaxed);
            self.elapsed.store(v.elapsed_frames, Ordering::Relaxed);
            self.emitted
                .store(v.emitted_pulses.into(), Ordering::Relaxed);
        }
    }
    fn read(&self) -> Option<CountInSnapshot> {
        self.present
            .load(Ordering::Relaxed)
            .then(|| CountInSnapshot {
                bars: self.bars.load(Ordering::Relaxed),
                numerator: self.numerator.load(Ordering::Relaxed) as u32,
                denominator: self.denominator.load(Ordering::Relaxed) as u32,
                bpm: f64::from_bits(self.bpm.load(Ordering::Relaxed)),
                rate: self.rate.load(Ordering::Relaxed) as u32,
                total_frames: self.total.load(Ordering::Relaxed),
                elapsed_frames: self.elapsed.load(Ordering::Relaxed),
                emitted_pulses: self.emitted.load(Ordering::Relaxed) as u32,
            })
    }
}
#[derive(Clone, Copy)]
struct RuntimeSnapshot {
    generation: u64,
    tick: f64,
    seconds: f64,
    phase: PracticePhase,
    resume_count: bool,
    count: Option<CountInSnapshot>,
    passes: u64,
    pulse: Option<PracticePulse>,
    serial: u64,
    interrupted_count: bool,
    settings: PracticeSettings,
    loop_range: Option<(f64, f64)>,
    range: Option<PlaybackSpan>,
    fault: bool,
    frames: u64,
    peak: f64,
}
struct SharedStatus {
    sequence: AtomicU64,
    barrier: AtomicU64,
    barrier_request: AtomicU64,
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
    fault: AtomicU64,
    frames: AtomicU64,
    peak: AtomicU64,
    shutdown: AtomicBool,
    device: Mutex<Option<String>>,
    backing_duration: AtomicU64,
    settings: SharedPractice,
    phase: AtomicU8,
    resume_count: AtomicBool,
    count: SharedCount,
    passes: AtomicU64,
    serial: AtomicU64,
    pulse_present: AtomicBool,
    pulse_serial: AtomicU64,
    pulse_beat: AtomicU64,
    pulse_beats: AtomicU64,
    pulse_accent: AtomicBool,
    pulse_counting: AtomicBool,
    interrupted_count: AtomicBool,
    loop_start: AtomicU64,
    loop_end: AtomicU64,
    range_present: AtomicBool,
    range_start: AtomicU64,
    range_end: AtomicU64,
    current_bpm: AtomicU64,
}
impl SharedStatus {
    fn new() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            barrier: AtomicU64::new(0),
            barrier_request: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            desired: AtomicU64::new(0),
            invalidated: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            ready: AtomicBool::new(false),
            playing: AtomicBool::new(false),
            tick: AtomicU64::new(0),
            seconds: AtomicU64::new(0),
            duration: AtomicU64::new(0),
            speed: AtomicU64::new(1f64.to_bits()),
            metronome: AtomicBool::new(false),
            fault: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            shutdown: AtomicBool::new(false),
            device: Mutex::new(None),
            backing_duration: AtomicU64::new(f64::NAN.to_bits()),
            settings: SharedPractice::new(),
            phase: AtomicU8::new(0),
            resume_count: AtomicBool::new(false),
            count: SharedCount::new(),
            passes: AtomicU64::new(0),
            serial: AtomicU64::new(0),
            pulse_present: AtomicBool::new(false),
            pulse_serial: AtomicU64::new(0),
            pulse_beat: AtomicU64::new(0),
            pulse_beats: AtomicU64::new(0),
            pulse_accent: AtomicBool::new(false),
            pulse_counting: AtomicBool::new(false),
            interrupted_count: AtomicBool::new(false),
            loop_start: AtomicU64::new(f64::NAN.to_bits()),
            loop_end: AtomicU64::new(0),
            range_present: AtomicBool::new(false),
            range_start: AtomicU64::new(0),
            range_end: AtomicU64::new(0),
            current_bpm: AtomicU64::new(0),
        }
    }
    fn read(&self) -> NativeAudioStatus {
        self.snapshot().0
    }
    fn read_fields(&self) -> (NativeAudioStatus, RuntimeSnapshot) {
        let fault = self.is_faulted();
        let backing = f64::from_bits(self.backing_duration.load(Ordering::Relaxed));
        let settings = self.settings.read();
        let phase = match self.phase.load(Ordering::Relaxed) {
            1 => PracticePhase::CountIn,
            2 => PracticePhase::Playing,
            3 => PracticePhase::Paused,
            4 => PracticePhase::Ended,
            _ => PracticePhase::Idle,
        };
        let pulse = self
            .pulse_present
            .load(Ordering::Relaxed)
            .then(|| PracticePulse {
                serial: self.pulse_serial.load(Ordering::Relaxed),
                beat: self.pulse_beat.load(Ordering::Relaxed) as u32,
                beats_per_bar: self.pulse_beats.load(Ordering::Relaxed) as u32,
                accent: self.pulse_accent.load(Ordering::Relaxed),
                counting: self.pulse_counting.load(Ordering::Relaxed),
            });
        let count = self.count.read();
        let loop_start = f64::from_bits(self.loop_start.load(Ordering::Relaxed));
        let loop_range = loop_start.is_finite().then(|| {
            (
                loop_start,
                f64::from_bits(self.loop_end.load(Ordering::Relaxed)),
            )
        });
        let snapshot = RuntimeSnapshot {
            generation: self.generation.load(Ordering::Relaxed),
            tick: f64::from_bits(self.tick.load(Ordering::Relaxed)),
            seconds: f64::from_bits(self.seconds.load(Ordering::Relaxed)),
            phase,
            resume_count: self.resume_count.load(Ordering::Relaxed),
            count,
            passes: self.passes.load(Ordering::Relaxed),
            pulse,
            serial: self.serial.load(Ordering::Relaxed),
            interrupted_count: self.interrupted_count.load(Ordering::Relaxed),
            settings,
            loop_range,
            range: self
                .range_present
                .load(Ordering::Relaxed)
                .then(|| PlaybackSpan {
                    start_tick: f64::from_bits(self.range_start.load(Ordering::Relaxed)),
                    end_tick: f64::from_bits(self.range_end.load(Ordering::Relaxed)),
                }),
            fault,
            frames: self.frames.load(Ordering::Relaxed),
            peak: f64::from_bits(self.peak.load(Ordering::Relaxed)),
        };
        let status = NativeAudioStatus {
            range: snapshot.range,
            generation: snapshot.generation,
            desired_generation: self.desired.load(Ordering::Acquire),
            ready: self.ready.load(Ordering::Relaxed) && !fault,
            playing: self.playing.load(Ordering::Relaxed) && !fault,
            tick: snapshot.tick,
            seconds: snapshot.seconds,
            duration_seconds: f64::from_bits(self.duration.load(Ordering::Relaxed)),
            speed: f64::from_bits(self.speed.load(Ordering::Relaxed)),
            metronome: self.metronome.load(Ordering::Relaxed),
            error: fault.then(|| {
                "Audio output stopped. Select an available output device to recover.".into()
            }),
            device_id: self.device.lock().unwrap().clone(),
            rendered_frames: self.frames.load(Ordering::Relaxed),
            output_peak: f64::from_bits(self.peak.load(Ordering::Relaxed)),
            backing_duration_seconds: backing.is_finite().then_some(backing),
            practice: PracticeStatus {
                settings,
                phase: if fault { PracticePhase::Paused } else { phase },
                count_in_remaining: count_remaining(count),
                completed_passes: snapshot.passes,
                effective_ratio: f64::from_bits(self.speed.load(Ordering::Relaxed)),
                current_bpm: f64::from_bits(self.current_bpm.load(Ordering::Relaxed)),
                pulse,
            },
            r#loop: loop_range.map(|(start_tick, end_tick)| PracticeLoop {
                start_tick,
                end_tick,
            }),
        };
        (status, snapshot)
    }
    fn snapshot(&self) -> (NativeAudioStatus, RuntimeSnapshot) {
        loop {
            let version = self.sequence.load(Ordering::Acquire);
            if version & 1 != 0 {
                thread::yield_now();
                continue;
            }
            let result = self.read_fields();
            if self.sequence.load(Ordering::Acquire) == version {
                return result;
            }
        }
    }
    fn is_faulted(&self) -> bool {
        self.fault.load(Ordering::Acquire) == self.epoch.load(Ordering::Acquire).saturating_add(1)
    }
    fn mark_fault(&self) {
        self.mark_fault_for_epoch(self.epoch.load(Ordering::Acquire));
    }
    fn mark_fault_for_epoch(&self, epoch: u64) {
        self.fault
            .fetch_max(epoch.saturating_add(1), Ordering::AcqRel);
    }
    // Control-thread epoch changes serialize with publication. A retired callback
    // never overwrites fields belonging to its replacement stream.
    fn next_epoch_snapshot(&self) -> (u64, RuntimeSnapshot) {
        loop {
            let version = self.sequence.load(Ordering::Acquire);
            if version & 1 == 0
                && self
                    .sequence
                    .compare_exchange(version, version + 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                let snapshot = self.read_fields().1;
                let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
                self.sequence.store(version + 2, Ordering::Release);
                return (epoch, snapshot);
            }
            thread::yield_now();
        }
    }
}
fn count_remaining(count: Option<CountInSnapshot>) -> u32 {
    count.map_or(0, |s| {
        if s.elapsed_frames >= s.total_frames {
            0
        } else {
            (u32::from(s.bars) * s.numerator)
                .saturating_sub(s.emitted_pulses)
                .saturating_add(1)
                .min(u32::from(s.bars) * s.numerator)
        }
    })
}
fn validate_count(
    plan: &PlaybackPlan,
    settings: PracticeSettings,
    rate: u32,
) -> Result<(), String> {
    if settings.count_in.bars == 0 {
        return Ok(());
    }
    // Validate the slowest trainer coefficient and both ends: all intermediate
    // speeds have durations between these bounds. No constructor can fail live.
    let ratios = match settings.tempo {
        PracticeTempo::Relative { ratio } => [ratio, ratio],
        PracticeTempo::Progressive { start, end, .. } => [start, end],
        PracticeTempo::Fixed { .. } => [1.0, 1.0],
    };
    let minimum = plan
        .tempos
        .iter()
        .map(|t| t.bpm)
        .fold(f64::INFINITY, f64::min);
    let maximum = plan.tempos.iter().map(|t| t.bpm).fold(0.0, f64::max);
    for occurrence in &plan.occurrences {
        for authored in [minimum, maximum] {
            for ratio in ratios {
                let bpm = match settings.tempo {
                    PracticeTempo::Fixed { bpm } => bpm,
                    _ => authored * ratio,
                };
                CountInClock::new(
                    settings.count_in.bars,
                    occurrence.meter_numerator,
                    occurrence.meter_denominator,
                    bpm,
                    rate,
                )
                .map_err(str::to_string)?;
            }
        }
    }
    Ok(())
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
    practice: PracticeSettings,
    phase: PracticePhase,
    resume_count: bool,
    count: Option<CountInClock>,
    click: ClickVoice,
    passes: u64,
    pulse: Option<PracticePulse>,
    serial: u64,
    interrupted_count: bool,
    loop_range: Option<(f64, f64)>,
    range: Option<PlaybackSpan>,
    rate: u32,
    shared: Arc<SharedStatus>,
    epoch: u64,
    frames: u64,
    peak: f64,
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
            practice: PracticeSettings::default(),
            phase: PracticePhase::Idle,
            resume_count: false,
            count: None,
            click: ClickVoice::new(rate),
            passes: 0,
            pulse: None,
            serial: 0,
            interrupted_count: false,
            loop_range: None,
            range: None,
            rate,
            shared,
            epoch,
            frames: 0,
            peak: 0.0,
        }
    }
    pub fn status(&self) -> NativeAudioStatus {
        self.shared.read()
    }
    fn resolved_tempo(&self) -> RenderTempo {
        match self.practice.tempo {
            PracticeTempo::Fixed { bpm } => RenderTempo::Fixed { bpm },
            _ => RenderTempo::Relative {
                ratio: progressive_ratio(&self.practice.tempo, self.passes),
            },
        }
    }
    fn actual_bpm(&self) -> f64 {
        if let Some(count) = self.count {
            return count.snapshot().bpm;
        }
        match self.resolved_tempo() {
            RenderTempo::Fixed { bpm } => bpm,
            RenderTempo::Relative { ratio } => {
                self.renderer
                    .as_ref()
                    .map_or(0.0, |r| r.authored_bpm_at(self.tick))
                    * ratio
            }
        }
    }
    fn resolve_renderer(&mut self) {
        let tempo = self.resolved_tempo();
        if let Some(renderer) = &mut self.renderer {
            let _ = renderer.set_practice_tempo(tempo);
            renderer.set_metronome_settings(self.practice.metronome);
        }
    }
    fn publish(&self) {
        let version = self.shared.sequence.load(Ordering::Acquire);
        if version & 1 != 0
            || self
                .shared
                .sequence
                .compare_exchange(version, version + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        if self.shared.epoch.load(Ordering::Acquire) != self.epoch {
            self.shared.sequence.store(version + 2, Ordering::Release);
            return;
        }
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
        let bpm = self.actual_bpm();
        let authored = self
            .renderer
            .as_ref()
            .map_or(0.0, |r| r.authored_bpm_at(self.tick));
        self.shared.speed.store(
            if authored > 0.0 { bpm / authored } else { 1.0 }.to_bits(),
            Ordering::Relaxed,
        );
        self.shared
            .current_bpm
            .store(bpm.to_bits(), Ordering::Relaxed);
        self.shared
            .metronome
            .store(self.practice.metronome.enabled, Ordering::Relaxed);
        self.shared.settings.store(self.practice);
        self.shared.phase.store(
            match self.phase {
                PracticePhase::Idle => 0,
                PracticePhase::CountIn => 1,
                PracticePhase::Playing => 2,
                PracticePhase::Paused => 3,
                PracticePhase::Ended => 4,
            },
            Ordering::Relaxed,
        );
        self.shared
            .resume_count
            .store(self.resume_count, Ordering::Relaxed);
        self.shared.count.store(self.count.map(|c| c.snapshot()));
        self.shared.passes.store(self.passes, Ordering::Relaxed);
        self.shared.serial.store(self.serial, Ordering::Relaxed);
        self.shared
            .pulse_present
            .store(self.pulse.is_some(), Ordering::Relaxed);
        if let Some(p) = self.pulse {
            self.shared.pulse_serial.store(p.serial, Ordering::Relaxed);
            self.shared
                .pulse_beat
                .store(p.beat.into(), Ordering::Relaxed);
            self.shared
                .pulse_beats
                .store(p.beats_per_bar.into(), Ordering::Relaxed);
            self.shared.pulse_accent.store(p.accent, Ordering::Relaxed);
            self.shared
                .pulse_counting
                .store(p.counting, Ordering::Relaxed);
        }
        self.shared
            .interrupted_count
            .store(self.interrupted_count, Ordering::Relaxed);
        self.shared.loop_start.store(
            self.loop_range.map_or(f64::NAN, |r| r.0).to_bits(),
            Ordering::Relaxed,
        );
        self.shared.loop_end.store(
            self.loop_range.map_or(0.0, |r| r.1).to_bits(),
            Ordering::Relaxed,
        );
        self.shared
            .range_present
            .store(self.range.is_some(), Ordering::Relaxed);
        self.shared.range_start.store(
            self.range.map_or(0.0, |r| r.start_tick).to_bits(),
            Ordering::Relaxed,
        );
        self.shared.range_end.store(
            self.range.map_or(0.0, |r| r.end_tick).to_bits(),
            Ordering::Relaxed,
        );
        self.shared.frames.store(self.frames, Ordering::Relaxed);
        self.shared
            .peak
            .store(self.peak.to_bits(), Ordering::Relaxed);
        self.shared.sequence.store(version + 2, Ordering::Release);
    }
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
        let preserving = preserve && generation == self.generation;
        let accepted = if preserving { self.practice } else { practice };
        if self.shared.epoch.load(Ordering::Acquire) != self.epoch
            || generation < self.generation
            || generation < self.shared.desired.load(Ordering::Acquire)
            || accepted.validate(renderer.has_backing()).is_err()
        {
            return Some(renderer);
        }
        let tempo = match accepted.tempo {
            PracticeTempo::Fixed { bpm } => RenderTempo::Fixed { bpm },
            _ => RenderTempo::Relative {
                ratio: progressive_ratio(&accepted.tempo, if preserving { self.passes } else { 0 }),
            },
        };
        if renderer.set_practice_tempo(tempo).is_err() {
            return Some(renderer);
        }
        renderer.set_metronome_settings(accepted.metronome);
        if preserve && generation == self.generation {
            renderer.seek_tick(self.tick);
        } else {
            self.playing = false;
            self.tick = 0.0;
            self.seconds = 0.0;
            self.loop_range = None;
            self.range = None;
            self.practice = practice;
            self.phase = PracticePhase::Idle;
            self.cancel_count();
            self.passes = 0;
            self.pulse = None;
            self.serial = 0;
            self.frames = 0;
            self.peak = 0.0;
        }
        self.generation = generation;
        self.duration = renderer.duration_seconds();
        self.ready = true;
        self.shared.fault.store(0, Ordering::Release);
        let previous = self.renderer.replace(renderer);
        self.resolve_renderer();
        self.publish();
        previous
    }
    fn add_pulse(&mut self, pulse: PulsePosition, counting: bool, count: u32) {
        self.serial = self.serial.saturating_add(u64::from(count));
        self.pulse = Some(PracticePulse {
            serial: self.serial,
            beat: pulse.beat,
            beats_per_bar: pulse.beats_per_bar,
            accent: pulse.accent,
            counting,
        });
    }
    fn cancel_count(&mut self) {
        self.count = None;
        self.click = ClickVoice::new(self.rate);
        self.resume_count = false;
        self.interrupted_count = false;
    }
    fn start_count(&mut self) {
        if self.practice.count_in.bars == 0 {
            self.phase = PracticePhase::Playing;
            return;
        }
        if let Some(renderer) = &self.renderer {
            let (numerator, denominator) = renderer.meter_at(self.tick);
            self.count = CountInClock::new(
                self.practice.count_in.bars,
                numerator,
                denominator,
                self.actual_bpm(),
                self.rate,
            )
            .ok();
            self.click = ClickVoice::new(self.rate);
            if self.count.is_some() {
                self.phase = PracticePhase::CountIn;
                self.resume_count = true;
            } else {
                self.device_error();
            }
        }
    }
    fn reset_passes(&mut self) {
        self.passes = 0;
        self.resolve_renderer();
    }
    pub fn command(&mut self, command: TransportCommand) -> Result<(), &'static str> {
        if self.shared.epoch.load(Ordering::Acquire) != self.epoch {
            return Err("Stale audio output epoch.");
        }
        if matches!(command, TransportCommand::Invalidate { .. }) {
            if command.generation() < self.generation {
                return Err("Stale transport generation.");
            }
            self.generation = command.generation();
            self.ready = false;
            self.playing = false;
            self.loop_range = None;
            self.range = None;
            self.cancel_count();
            self.reset_passes();
            self.pulse = None;
            self.phase = PracticePhase::Idle;
            self.seek(0.0);
            self.publish();
            return Ok(());
        }
        if command.generation() != self.generation {
            return Err("Stale transport generation.");
        }
        let duration = self.renderer.as_ref().map_or(0.0, |r| r.duration_tick());
        let validation_duration = if matches!(command, TransportCommand::PlayRange { .. }) {
            self.renderer
                .as_ref()
                .map_or(0.0, |r| r.score_duration_tick())
        } else {
            duration
        };
        command.validate(validation_duration)?;
        if !self.ready || self.shared.is_faulted() {
            return Err("Audio output is not ready. Select an output device to recover.");
        }
        match command {
            TransportCommand::PlayRange {
                start_tick,
                end_tick,
                ..
            } => {
                // Validate the fresh count before changing any accepted transport state.
                if self.practice.count_in.bars > 0 {
                    let renderer = self.renderer.as_ref().unwrap();
                    let (numerator, denominator) = renderer.meter_at(start_tick);
                    let bpm = match self.practice.tempo {
                        PracticeTempo::Fixed { bpm } => bpm,
                        _ => {
                            renderer.authored_bpm_at(start_tick)
                                * progressive_ratio(&self.practice.tempo, 0)
                        }
                    };
                    CountInClock::new(
                        self.practice.count_in.bars,
                        numerator,
                        denominator,
                        bpm,
                        self.rate,
                    )?;
                }
                self.loop_range = None;
                self.range = end_tick.map(|end_tick| PlaybackSpan {
                    start_tick,
                    end_tick,
                });
                self.cancel_count();
                self.pulse = None;
                self.reset_passes();
                self.seek(start_tick);
                self.playing = true;
                self.phase = PracticePhase::Playing;
                self.start_count();
            }
            TransportCommand::Play { .. } => {
                if !self.playing {
                    if self.phase == PracticePhase::Paused {
                        self.playing = true;
                        if self.interrupted_count {
                            self.cancel_count();
                            self.phase = PracticePhase::Playing;
                            self.start_count();
                        } else {
                            self.phase = if self.resume_count {
                                PracticePhase::CountIn
                            } else {
                                PracticePhase::Playing
                            };
                        }
                    } else {
                        self.cancel_count();
                        self.reset_passes();
                        if let Some((start, end)) = self.loop_range {
                            if self.tick < start || self.tick >= end {
                                self.seek(start);
                            }
                        } else if let Some(range) = self.range {
                            self.seek(range.start_tick);
                        } else if self.tick >= duration {
                            self.seek(0.0);
                        }
                        self.playing = true;
                        self.phase = PracticePhase::Playing;
                        self.start_count();
                    }
                }
            }
            TransportCommand::Pause { .. } => {
                if self.playing {
                    self.resume_count = self.count.is_some();
                    self.playing = false;
                    self.phase = PracticePhase::Paused;
                }
            }
            TransportCommand::Stop { .. } => {
                self.range = None;
                self.playing = false;
                self.cancel_count();
                self.reset_passes();
                self.seek(0.0);
                self.pulse = None;
                self.phase = PracticePhase::Idle;
            }
            TransportCommand::SeekTick { tick, .. } => {
                self.range = None;
                self.cancel_count();
                self.reset_passes();
                self.seek(tick);
                self.pulse = None;
                self.phase = if self.playing {
                    PracticePhase::Playing
                } else if self.phase == PracticePhase::Paused {
                    PracticePhase::Paused
                } else {
                    PracticePhase::Idle
                };
            }
            TransportCommand::SetPractice { settings, .. } => {
                settings.validate(self.renderer.as_ref().is_some_and(|r| r.has_backing()))?;
                let tempo_changed = self.practice.tempo != settings.tempo;
                self.practice = settings;
                if tempo_changed {
                    self.reset_passes();
                } else {
                    self.resolve_renderer();
                }
            }
            TransportCommand::SetLoop {
                start_tick,
                end_tick,
                ..
            } => {
                self.range = None;
                self.cancel_count();
                self.reset_passes();
                self.loop_range = Some((start_tick, end_tick));
                if self.tick < start_tick || self.tick >= end_tick {
                    self.seek(start_tick);
                }
                self.pulse = None;
                self.phase = if self.playing {
                    PracticePhase::Playing
                } else if self.phase == PracticePhase::Paused {
                    PracticePhase::Paused
                } else {
                    PracticePhase::Idle
                };
            }
            TransportCommand::ClearLoop { .. } => {
                self.range = None;
                self.cancel_count();
                self.reset_passes();
                self.loop_range = None;
                self.pulse = None;
                self.phase = if self.playing {
                    PracticePhase::Playing
                } else if self.phase == PracticePhase::Paused {
                    PracticePhase::Paused
                } else {
                    PracticePhase::Idle
                };
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
    fn fault(&mut self) {
        self.interrupted_count =
            self.interrupted_count || self.count.is_some() || self.resume_count;
        self.cancel_count_after_fault();
        self.ready = false;
        self.playing = false;
        self.phase = PracticePhase::Paused;
    }
    fn cancel_count_after_fault(&mut self) {
        self.count = None;
        self.click = ClickVoice::new(self.rate);
        self.resume_count = false;
    }
    pub fn device_error(&mut self) {
        if self.shared.epoch.load(Ordering::Acquire) != self.epoch {
            return;
        }
        self.shared.mark_fault_for_epoch(self.epoch);
        self.fault();
        self.publish();
    }
    fn wrap(&mut self, start: f64) {
        self.passes = self.passes.saturating_add(1);
        self.resolve_renderer();
        self.seek(start);
        if self.practice.count_in.between_loops {
            self.start_count();
        }
    }
    pub fn render_into(&mut self, output: &mut [[f32; 2]]) {
        output.fill([0.0; 2]);
        if self.shared.epoch.load(Ordering::Acquire) != self.epoch {
            return;
        }
        let invalidated = self.shared.invalidated.load(Ordering::Acquire);
        if invalidated > self.generation {
            let _ = self.command(TransportCommand::Invalidate {
                generation: invalidated,
            });
        }
        if self.shared.is_faulted() {
            self.fault();
            self.publish();
            return;
        }
        let mut offset = 0;
        while self.playing && offset < output.len() {
            if let Some(clock) = &mut self.count {
                let frame = clock.next_frame();
                if frame.finished {
                    self.count = None;
                    self.resume_count = false;
                    self.phase = PracticePhase::Playing;
                    continue;
                }
                if let Some(pulse) = frame.pulse {
                    self.click.trigger(pulse.accent);
                    self.add_pulse(pulse, true, 1);
                }
                let click = self.click.frame(self.practice.metronome.volume);
                output[offset] = [click, click];
                offset += 1;
                continue;
            }
            if let Some((start, end)) = self.loop_range {
                if self.tick >= end {
                    self.wrap(start);
                    continue;
                }
            }
            let Some(renderer) = &mut self.renderer else {
                self.playing = false;
                break;
            };
            let ceiling = self
                .loop_range
                .map(|r| r.1)
                .or(self.range.map(|r| r.end_tick));
            let end = ceiling.unwrap_or_else(|| renderer.duration_tick());
            let remaining = renderer.output_frames_until(end);
            let count = (output.len() - offset).min(BLOCK).min(remaining);
            if count == 0 {
                self.seek(end);
                if let Some((start, _)) = self.loop_range {
                    self.wrap(start);
                    continue;
                }
                self.playing = false;
                self.phase = PracticePhase::Ended;
                self.cancel_count();
                self.pulse = None;
                break;
            }
            let status = if let Some(end) = ceiling {
                renderer.render_until(&mut output[offset..offset + count], end)
            } else {
                renderer.render_into(&mut output[offset..offset + count])
            };
            self.tick = status.tick;
            self.seconds = status.seconds;
            offset += count;
            if let Some(pulse) = status.last_pulse {
                self.add_pulse(pulse, false, status.pulse_count);
            }
            if count == remaining || (ceiling.is_none() && status.ended) {
                self.seek(end);
                if let Some((start, _)) = self.loop_range {
                    self.wrap(start);
                } else {
                    self.playing = false;
                    self.phase = PracticePhase::Ended;
                    self.cancel_count();
                    self.pulse = None;
                }
            }
        }
        if offset > 0 {
            self.frames = self.frames.saturating_add(offset as u64);
            let peak = output[..offset]
                .iter()
                .flat_map(|f| f.iter())
                .fold(0.0f64, |p, x| p.max(x.abs() as f64));
            self.peak = self.peak.max(peak);
        }
        self.publish();
    }
    fn restore(&mut self, snapshot: RuntimeSnapshot) -> Result<(), String> {
        self.frames = snapshot.frames;
        self.peak = snapshot.peak;
        self.tick = snapshot.tick;
        self.seconds = snapshot.seconds;
        self.practice = snapshot.settings;
        self.loop_range = snapshot.loop_range;
        self.range = snapshot.range;
        self.passes = snapshot.passes;
        self.pulse = snapshot.pulse;
        self.serial = snapshot.serial;
        self.resolve_renderer();
        self.seek(snapshot.tick);
        self.interrupted_count = snapshot.interrupted_count
            || snapshot.fault && (snapshot.count.is_some() || snapshot.resume_count);
        if snapshot.fault {
            self.phase = PracticePhase::Paused;
            self.playing = false;
            self.resume_count = false;
            self.count = None;
        } else {
            self.phase = snapshot.phase;
            self.playing = matches!(
                snapshot.phase,
                PracticePhase::CountIn | PracticePhase::Playing
            );
            self.resume_count = snapshot.resume_count;
            self.count = snapshot
                .count
                .map(|s| CountInClock::from_snapshot(s, self.rate))
                .transpose()
                .map_err(|error| {
                    self.shared.mark_fault_for_epoch(self.epoch);
                    error.to_string()
                })?;
            if let Some(count) = self.count {
                let s = count.snapshot();
                if s.emitted_pulses > 0 {
                    let boundary = (f64::from(s.emitted_pulses - 1) * 60.0 / s.bpm * 4.0
                        / f64::from(s.denominator)
                        * f64::from(self.rate))
                    .round() as u64;
                    let age = s.elapsed_frames.saturating_sub(boundary);
                    if age < (f64::from(self.rate) * 0.05) as u64 {
                        self.click
                            .trigger((s.emitted_pulses - 1) % s.numerator == 0);
                        for _ in 0..age {
                            self.click.frame(0.0);
                        }
                    }
                }
            }
        }
        Ok(())
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
    Barrier(u64),
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
    suspended: bool,
}
impl OutputCallback {
    fn render<T: SizedSample + FromSample<f32>>(&mut self, output: &mut [T], channels: usize) {
        if self.suspended || self.transport.shared.epoch.load(Ordering::Acquire) != self.epoch {
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
                CallbackCommand::Barrier(sequence) => {
                    // Freeze at an acknowledged boundary before the control
                    // thread snapshots and retires this stream's epoch.
                    if self
                        .transport
                        .shared
                        .barrier_request
                        .compare_exchange(sequence, 0, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        self.suspended = true;
                        self.transport.publish();
                        self.transport
                            .shared
                            .barrier
                            .store(sequence, Ordering::Release);
                        break;
                    }
                }
            }
        }
        if self.suspended {
            output.fill(T::from_sample(0.0));
            return;
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
    next_barrier: u64,
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
                next_barrier: 0,
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
        practice
            .validate(backing_bytes.is_some() || settings.backing.is_some())
            .map_err(str::to_string)?;
        plan.validate()?;
        validate_count(&plan, practice, 8_000)?;
        validate_count(&plan, practice, 192_000)?;
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
        if state.producer.is_none() || self.shared.is_faulted() {
            // Validate music independently of the available device. Retain it after
            // an output failure so selecting a working device can recover it.
            let _ = Self::renderer(&document, state.rate)?;
            if let Err(error) = self.open(&mut state, document.clone(), false) {
                if self.shared.desired.load(Ordering::Acquire) == generation
                    && self.shared.is_faulted()
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
        let reference = document
            .settings
            .backing
            .as_ref()
            .filter(|backing| backing.reference_sync.is_some());
        if reference.is_some() != document.plan.playback_end_tick.is_some() {
            return Err(
                "Reference playback requires matching source settings and an effective plan."
                    .into(),
            );
        }
        if let Some(settings) = reference {
            let audio = document
                .backing
                .as_ref()
                .ok_or("Reference playback requires decoded backing audio.")?;
            ReferenceSyncMap::new(settings, &document.plan)?.validate_audio(audio)?;
        }
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
            let map = if let Some(settings) = &document.settings.backing {
                BackingMap::from_settings(settings, &document.plan)?
            } else {
                BackingMap::new(anchors, offset, &document.plan)?
            };
            renderer.install_backing(audio.clone(), map, mix)?;
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
    fn synchronize_callback(
        &self,
        state: &mut ControlState,
        timeout: Duration,
    ) -> Result<(), String> {
        if state.producer.is_none() || self.shared.is_faulted() {
            return Ok(());
        }
        state.next_barrier = state
            .next_barrier
            .checked_add(1)
            .ok_or("Audio control sequence exceeds its supported range.")?;
        let sequence = state.next_barrier;
        self.shared
            .barrier_request
            .store(sequence, Ordering::Release);
        if let Err(error) = Self::enqueue(state, CallbackCommand::Barrier(sequence)) {
            let _ = self.shared.barrier_request.compare_exchange(
                sequence,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            return Err(error);
        }
        let deadline = std::time::Instant::now() + timeout;
        while self.shared.barrier.load(Ordering::Acquire) < sequence {
            if self.shared.is_faulted() {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline
                && self
                    .shared
                    .barrier_request
                    .compare_exchange(sequence, 0, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                return Err(
                    "Audio output did not acknowledge device selection; retry the control.".into(),
                );
            }
            thread::sleep(Duration::from_millis(1));
        }
        Ok(())
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
        old.practice
            .validate(
                settings.backing.is_some()
                    || backing_bytes
                        .as_ref()
                        .map_or(old.backing.is_some(), |bytes| bytes.is_some()),
            )
            .map_err(str::to_string)?;
        if old.plan.generation != generation
            || self.shared.desired.load(Ordering::Acquire) != generation
        {
            return Err("Stale sound configuration.".into());
        }
        if reference_timing_changed(old.settings.backing.as_ref(), settings.backing.as_ref()) {
            return Err("Reference timing changes require a newly prepared playback plan.".into());
        }
        let voice_changed = old.plan.tracks.iter().any(|track| {
            voice_id_for_track(track, &settings) != voice_id_for_track(track, &old.settings)
        });
        let map_changed = match (&old.settings.backing, &settings.backing) {
            (Some(a), Some(b)) => {
                a.asset_id != b.asset_id
                    || a.offset_ms != b.offset_ms
                    || a.anchors != b.anchors
                    || a.reference_sync != b.reference_sync
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
            .validate(
                document
                    .plan
                    .playback_end_tick
                    .unwrap_or(document.plan.duration_tick),
            )
            .map_err(str::to_string)?;
        if matches!(command, TransportCommand::PlayRange { .. }) {
            let status = self.shared.read();
            if !status.ready || status.generation != command.generation() {
                return Err(
                    "Audio output is not ready. Select an output device to recover.".into(),
                );
            }
            validate_count(&document.plan, document.practice, state.rate)?;
        }
        if let TransportCommand::SetPractice { settings, .. } = &command {
            settings
                .validate(document.backing.is_some() || document.settings.backing.is_some())
                .map_err(str::to_string)?;
            validate_count(&document.plan, *settings, state.rate)?;
        }
        if let TransportCommand::SelectDevice { device_id, .. } = command {
            let saved = PreparedDocument {
                plan: document.plan.clone(),
                settings: document.settings.clone(),
                resources: document.resources.clone(),
                backing: document.backing.clone(),
                practice: document.practice,
            };
            self.synchronize_callback(&mut state, Duration::from_secs(1))?;
            state.device = device_id;
            return self.open(&mut state, saved, true);
        }
        if self.shared.is_faulted() {
            return Err("Audio output stopped. Select an output device to recover.".into());
        }
        let accepted = command.clone();
        Self::enqueue(&mut state, CallbackCommand::Transport(command))?;
        match accepted {
            TransportCommand::SetPractice { settings, .. } => {
                state.document.as_mut().unwrap().practice = settings
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
        let result = self.open_current(state, document, preserve);
        if result.is_err() {
            self.shared.mark_fault();
        }
        result
    }
    fn open_current(
        &self,
        state: &mut ControlState,
        document: PreparedDocument,
        preserve: bool,
    ) -> Result<(), String> {
        let (device, config) = choose_output(state.device.as_deref())?;
        let rate = config.sample_rate();
        let renderer = Self::renderer(&document, rate)?;
        validate_count(&document.plan, document.practice, rate)?;
        if document.plan.generation != self.shared.desired.load(Ordering::Acquire) {
            return Err("A newer score preparation superseded this request.".into());
        }
        let (producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired_out, retired) = HeapRb::new(CONTROL_CAPACITY).split();
        let (epoch, snapshot) = self.shared.next_epoch_snapshot();
        let preserve_position = preserve && snapshot.generation == document.plan.generation;
        let mut transport = CallbackTransport::new(rate, self.shared.clone());
        transport.duration = renderer.duration_seconds();
        transport.renderer = Some(renderer);
        transport.generation = document.plan.generation;
        transport.ready = true;
        transport.practice = document.practice;
        if preserve_position {
            transport.restore(snapshot)?;
            // A fault may have prevented an already accepted Apply from reaching
            // its old callback. Keep the validated, queued settings on recovery.
            if snapshot.fault && transport.practice != document.practice {
                if transport.practice.tempo != document.practice.tempo {
                    transport.passes = 0;
                }
                transport.practice = document.practice;
            }
        }
        transport.resolve_renderer();
        let actual_id = device.id().map_err(|e| e.to_string())?.to_string();
        let (reply, answer) = mpsc::channel();
        let callback = OutputCallback {
            transport,
            controls,
            retired: retired_out,
            scratch: [[0.0; 2]; BLOCK],
            epoch,
            suspended: false,
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
                    shared.mark_fault_for_epoch(epoch);
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
                let epoch = callback.epoch;
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
                        shared.mark_fault_for_epoch(epoch);
                        let _ = reply.send(Err(error));
                    }
                }
            }
        }
    }
    drop(stream);
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    fn document() -> PreparedDocument {
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":4000,"playbackEndTick":3840,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap();
        let settings: DocumentSettings = {
            let mut settings = DocumentSettings::default();
            settings.backing=Some(serde_json::from_value(serde_json::json!({"assetId":"a","offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":1000,"exitAudioMs":3000},"mix":{"gain":1,"pan":0,"mute":false,"solo":false}})).unwrap());
            settings
        };
        PreparedDocument {
            plan: Arc::new(plan),
            settings,
            resources: Arc::new(
                AudioResources::load_for_requests(
                    &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                    &[],
                )
                .unwrap(),
            ),
            backing: Some(Arc::new(DecodedAudio {
                sample_rate: 48_000,
                channels: 2,
                frames: Arc::new(vec![[0.0; 2]; 192_000]),
            })),
            practice: PracticeSettings::default(),
        }
    }
    #[test]
    fn reference_admission_requires_real_pcm_effective_clock_and_settings_authority() {
        let original = document();
        assert!(AudioService::renderer(&original, 48_000).is_ok());
        let mut candidate = original.clone();
        candidate.backing = None;
        assert!(AudioService::renderer(&candidate, 48_000).is_err());
        let mut candidate = original.clone();
        candidate.settings.backing = None;
        assert!(AudioService::renderer(&candidate, 48_000).is_err());
        let mut candidate = original.clone();
        candidate.settings.backing.as_mut().unwrap().reference_sync = None;
        assert!(AudioService::renderer(&candidate, 48_000).is_err());
        let mut candidate = original.clone();
        candidate
            .settings
            .backing
            .as_mut()
            .unwrap()
            .reference_sync
            .as_mut()
            .unwrap()
            .exit_audio_ms = 4001.0;
        assert!(AudioService::renderer(&candidate, 48_000).is_err());
        let mut candidate = original;
        Arc::make_mut(&mut candidate.plan).playback_end_tick = None;
        assert!(AudioService::renderer(&candidate, 48_000).is_err());
    }
    #[test]
    fn same_plan_mix_rejects_reference_timing_before_queue_or_document_publication() {
        let original = document();
        let shared = Arc::new(SharedStatus::new());
        shared.desired.store(1, Ordering::Release);
        let (producer, mut commands) = HeapRb::new(CONTROL_CAPACITY).split();
        let (manager, _requests) = mpsc::channel();
        // A control-only service: no app, manager thread, stream or device access.
        let service = AudioService {
            root: PathBuf::new(),
            shared,
            control: Mutex::new(ControlState {
                producer: Some(producer),
                document: Some(original.clone()),
                rate: 48_000,
                device: None,
                next_barrier: 0,
            }),
            manager,
        };
        for change in 0..5 {
            let mut candidate = original.settings.clone();
            let backing = candidate.backing.as_mut().unwrap();
            match change {
                0 => backing.asset_id = "b".into(),
                1 => backing.offset_ms = 1.0,
                2 => backing.reference_sync.as_mut().unwrap().exit_audio_ms = 3001.0,
                3 => backing.anchors.push(crate::settings::SyncAnchor {
                    bar: 0,
                    occurrence: 0,
                    ratio: 0.5,
                    audio_ms: 2000.0,
                }),
                _ => backing.reference_sync = None,
            }
            assert!(service.set_mix(candidate, 1).is_err());
            assert!(commands.try_pop().is_none());
            assert_eq!(
                service
                    .control
                    .lock()
                    .unwrap()
                    .document
                    .as_ref()
                    .unwrap()
                    .settings,
                original.settings
            );
        }
        let mut candidate = original.settings.clone();
        candidate.backing.as_mut().unwrap().mix.gain = 0.25;
        service.set_mix(candidate.clone(), 1).unwrap();
        assert!(matches!(
            commands.try_pop(),
            Some(CallbackCommand::Mix { .. })
        ));
        assert_eq!(
            service
                .control
                .lock()
                .unwrap()
                .document
                .as_ref()
                .unwrap()
                .settings,
            candidate
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn practice(speed: f64, enabled: bool) -> PracticeSettings {
        PracticeSettings {
            tempo: super::super::practice::PracticeTempo::Relative { ratio: speed },
            metronome: super::super::practice::MetronomeSettings {
                enabled,
                volume: 0.4,
                visual: false,
            },
            count_in: super::super::practice::CountInSettings {
                bars: 0,
                between_loops: false,
            },
        }
    }

    fn unavailable_device_with_practice() -> AudioService {
        let service = AudioService::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            Arc::new(|_| {}),
        );
        service.control.lock().unwrap().device = Some("unavailable-test-device".into());
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap();
        assert!(
            service
                .prepare_with_practice(plan, DocumentSettings::default(), None, practice(0.5, true))
                .is_err()
        );
        assert_eq!(service.prepared_generation(), Some(1));
        service
    }
    #[test]
    fn initial_device_failure_retains_prepared_practice_for_recovery() {
        let service = unavailable_device_with_practice();
        let document = service.control.lock().unwrap().document.clone().unwrap();
        assert_eq!(
            document.practice.tempo,
            PracticeTempo::Relative { ratio: 0.5 }
        );
        assert!(document.practice.metronome.enabled);
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
        for speed in [f64::NAN, 0.099, 3.001] {
            assert!(
                service
                    .prepare_with_practice(
                        plan.clone(),
                        DocumentSettings::default(),
                        None,
                        practice(speed, false)
                    )
                    .is_err()
            );
            assert_eq!(service.prepared_generation(), Some(1));
            assert_eq!(service.shared.desired.load(Ordering::Acquire), 1);
        }
    }
    fn counted_document() -> PreparedDocument {
        let service = unavailable_device_with_practice();
        let mut document = service.control.lock().unwrap().document.clone().unwrap();
        document.practice.count_in.bars = 1;
        document
    }
    fn recreate(
        old: &mut CallbackTransport,
        document: &PreparedDocument,
        rate: u32,
    ) -> CallbackTransport {
        let (_, snapshot) = old.shared.next_epoch_snapshot();
        let mut next = CallbackTransport::new(rate, old.shared.clone());
        next.generation = document.plan.generation;
        next.renderer = Some(AudioService::renderer(document, rate).unwrap());
        next.ready = true;
        next.duration = old.duration;
        next.restore(snapshot).unwrap();
        next.shared.fault.store(0, Ordering::Release);
        next.publish();
        next
    }
    #[test]
    fn range_survives_quiescent_switch_and_fault() {
        let document = counted_document();
        let mut old = CallbackTransport::headless(48_000);
        old.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        old.command(TransportCommand::PlayRange {
            generation: 1,
            start_tick: 960.0,
            end_tick: Some(1920.0),
        })
        .unwrap();
        old.render_into(&mut [[0.0; 2]; 12345]);
        old.command(TransportCommand::Pause { generation: 1 })
            .unwrap();
        let before = old.status();
        let remaining = old.count.unwrap().remaining_wall_seconds();
        let (mut producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired, _retirement_queue) = HeapRb::new(CONTROL_CAPACITY).split();
        old.shared.barrier_request.store(1, Ordering::Release);
        assert!(producer.try_push(CallbackCommand::Barrier(1)).is_ok());
        let mut callback = OutputCallback {
            transport: old,
            controls,
            retired,
            scratch: [[0.0; 2]; BLOCK],
            epoch: 0,
            suspended: false,
        };
        callback.render(&mut [1.0f32; BLOCK * 2], 2);
        assert!(callback.suspended);
        assert_eq!(callback.transport.shared.barrier.load(Ordering::Acquire), 1);
        let mut next = recreate(&mut callback.transport, &document, 44_100);
        assert_eq!(next.status().range, before.range);
        assert_eq!(next.tick, before.tick);
        assert_eq!(next.phase, PracticePhase::Paused);
        assert_eq!(next.pulse, before.practice.pulse);
        assert!((next.count.unwrap().remaining_wall_seconds() - remaining).abs() <= 1.0 / 44_100.0);
        let stable = serde_json::to_value(next.status()).unwrap();
        callback.transport.publish();
        callback.transport.device_error();
        assert_eq!(serde_json::to_value(next.status()).unwrap(), stable);
        next.device_error();
        let mut recovered = recreate(&mut next, &document, 48_000);
        assert_eq!(recovered.status().range, before.range);
        assert_eq!(recovered.phase, PracticePhase::Paused);
        assert!(recovered.interrupted_count);
        recovered
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        assert_eq!(recovered.count.unwrap().snapshot().elapsed_frames, 0);
        recovered.render_into(&mut [[0.0; 2]; 123]);
        recovered
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        assert_eq!(recovered.count.unwrap().snapshot().elapsed_frames, 123);
        recovered.render_into(&mut vec![[0.0; 2]; 240_000]);
        assert_eq!(recovered.phase, PracticePhase::Ended);
        assert_eq!(recovered.tick, 1920.0);
        let ended = recreate(&mut recovered, &document, 44_100);
        assert_eq!(ended.phase, PracticePhase::Ended);
        assert_eq!(ended.status().range, before.range);
        assert!(!ended.playing);
        assert_eq!(ended.passes, 0);
    }

    #[test]
    fn range_validation_and_queue_failure_preserve_accepted_state() {
        let document = counted_document();
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        service.shared.desired.store(1, Ordering::Release);
        let (producer, mut controls) = HeapRb::new(CONTROL_CAPACITY).split();
        {
            let mut state = service.control.lock().unwrap();
            state.document = Some(document.clone());
            state.producer = Some(producer);
            state.rate = 48_000;
        }
        let request = TransportCommand::PlayRange {
            generation: 1,
            start_tick: 960.0,
            end_tick: Some(1920.0),
        };
        let before = serde_json::to_value(service.status()).unwrap();
        assert!(
            service.command(request.clone()).is_err(),
            "not-ready requests must reject before enqueue"
        );
        assert_eq!(serde_json::to_value(service.status()).unwrap(), before);
        assert!(controls.try_pop().is_none());
        let mut transport = CallbackTransport::new(48_000, service.shared.clone());
        transport.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        transport.command(request.clone()).unwrap();
        transport.render_into(&mut [[0.0; 2]; 123]);
        let before = serde_json::to_value(service.status()).unwrap();
        for command in [
            TransportCommand::PlayRange {
                generation: 1,
                start_tick: 3840.0,
                end_tick: None,
            },
            TransportCommand::PlayRange {
                generation: 1,
                start_tick: 960.0,
                end_tick: Some(3841.0),
            },
            TransportCommand::PlayRange {
                generation: 0,
                start_tick: 960.0,
                end_tick: None,
            },
        ] {
            assert!(service.command(command).is_err());
            assert_eq!(serde_json::to_value(service.status()).unwrap(), before);
            assert!(controls.try_pop().is_none());
        }
        for _ in 0..CONTROL_CAPACITY {
            service
                .command(TransportCommand::Pause { generation: 1 })
                .unwrap();
        }
        assert!(
            service
                .command(request.clone())
                .unwrap_err()
                .contains("queue is full")
        );
        assert_eq!(serde_json::to_value(service.status()).unwrap(), before);
        while let Some(command) = controls.try_pop() {
            assert!(matches!(
                command,
                CallbackCommand::Transport(TransportCommand::Pause { .. })
            ));
        }
        service.command(request).unwrap();
        // Queue acceptance alone cannot publish a new start or reset the count.
        assert_eq!(serde_json::to_value(service.status()).unwrap(), before);
        let CallbackCommand::Transport(command) = controls.try_pop().unwrap() else {
            panic!("expected transport command")
        };
        transport.command(command).unwrap();
        assert_eq!(transport.count.unwrap().snapshot().elapsed_frames, 0);
        let before_mix = serde_json::to_value(transport.status()).unwrap();
        let mix = PreparedMix::prepare(&document.settings, &document.plan, 48_000).unwrap();
        AudioService::enqueue(
            &mut service.control.lock().unwrap(),
            CallbackCommand::Mix { mix, generation: 1 },
        )
        .unwrap();
        let (retired, _retirement_queue) = HeapRb::new(CONTROL_CAPACITY).split();
        let mut callback = OutputCallback {
            transport,
            controls,
            retired,
            scratch: [[0.0; 2]; BLOCK],
            epoch: 0,
            suspended: false,
        };
        callback.render(&mut [] as &mut [f32], 2);
        assert_eq!(
            serde_json::to_value(callback.transport.status()).unwrap(),
            before_mix
        );
    }

    #[test]
    fn range_count_preflight_failure_leaves_complete_callback_state_unchanged() {
        let mut document = counted_document();
        let mut plan = document.plan.as_ref().clone();
        plan.occurrences[0].meter_numerator = u32::MAX;
        document.plan = Arc::new(plan);
        document.practice.count_in.bars = 16;
        let mut transport = CallbackTransport::headless(48_000);
        transport.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        transport
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 0.0,
                end_tick: 1920.0,
            })
            .unwrap();
        let before = serde_json::to_value(transport.status()).unwrap();
        assert!(
            transport
                .command(TransportCommand::PlayRange {
                    generation: 1,
                    start_tick: 960.0,
                    end_tick: Some(1920.0)
                })
                .is_err()
        );
        assert_eq!(serde_json::to_value(transport.status()).unwrap(), before);
    }
    #[test]
    fn device_snapshot_preserves_fractional_count_and_epoch() {
        let document = counted_document();
        let mut old = CallbackTransport::headless(48_000);
        old.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        old.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        old.render_into(&mut [[0.0; 2]; 12_345]);
        let before = old.count.unwrap().remaining_wall_seconds();
        let serial = old.serial;
        let mut next = recreate(&mut old, &document, 44_100);
        assert_eq!(next.phase, PracticePhase::CountIn);
        assert_eq!(next.serial, serial);
        assert!((next.count.unwrap().remaining_wall_seconds() - before).abs() <= 1.0 / 44_100.0);
        next.render_into(&mut [[0.0; 2]; 1]);
        assert_eq!(next.serial, serial);
        let stable = next.status();
        let mut silence = [[1.0; 2]; 511];
        old.render_into(&mut silence);
        old.device_error();
        assert!(silence.iter().all(|f| *f == [0.0; 2]));
        assert_eq!(next.status().practice, stable.practice);
        assert!(next.status().ready);
        assert!(
            old.command(TransportCommand::Stop { generation: 1 })
                .is_err()
        );
        assert!(
            old.install(AudioService::renderer(&document, 48_000).unwrap(), 2, false)
                .is_some()
        );
        assert_eq!(next.status().generation, 1);
    }
    #[test]
    fn paused_count_reselect_keeps_pulse_and_subbeat() {
        let document = counted_document();
        let mut old = CallbackTransport::headless(48_000);
        old.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        old.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        old.render_into(&mut [[0.0; 2]; 12_345]);
        old.command(TransportCommand::Pause { generation: 1 })
            .unwrap();
        let before = old.count.unwrap().remaining_wall_seconds();
        let serial = old.serial;
        let mut next = recreate(&mut old, &document, 44_100);
        assert_eq!(next.phase, PracticePhase::Paused);
        assert!(next.resume_count);
        next.render_into(&mut [[0.0; 2]; 511]);
        assert!((next.count.unwrap().remaining_wall_seconds() - before).abs() <= 1.0 / 44_100.0);
        next.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        next.render_into(&mut [[0.0; 2]; 1]);
        assert_eq!(next.serial, serial);
    }
    #[test]
    fn fault_count_restarts_full_and_score_recovers_paused() {
        let document = counted_document();
        let mut old = CallbackTransport::headless(48_000);
        old.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        old.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        old.render_into(&mut [[0.0; 2]; 12_345]);
        old.device_error();
        old.render_into(&mut [[0.0; 2]; 2]);
        let mut next = recreate(&mut old, &document, 44_100);
        assert_eq!(next.phase, PracticePhase::Paused);
        assert!(next.interrupted_count);
        assert!(next.count.is_none());
        next.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        assert_eq!(next.count.unwrap().snapshot().elapsed_frames, 0);
        assert!((next.count.unwrap().remaining_wall_seconds() - 4.0).abs() < 1e-12);
        next.command(TransportCommand::SeekTick {
            generation: 1,
            tick: 960.0,
        })
        .unwrap();
        next.render_into(&mut [[0.0; 2]; 511]);
        let tick = next.tick;
        next.device_error();
        let mut recovered = recreate(&mut next, &document, 48_000);
        assert_eq!(recovered.phase, PracticePhase::Paused);
        assert_eq!(recovered.tick, tick);
        assert!(!recovered.interrupted_count);
        recovered
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        assert!(recovered.count.is_none());
        recovered.render_into(&mut [[0.0; 2]; 1]);
        assert!(recovered.tick > tick);
    }
    #[test]
    fn count_overflow_rejected_before_prepared_document_mutates() {
        let service = unavailable_device_with_practice();
        let old = service.control.lock().unwrap().document.clone().unwrap();
        let mut plan = old.plan.as_ref().clone();
        plan.generation = 2;
        plan.occurrences[0].meter_numerator = u32::MAX;
        let mut settings = old.practice;
        settings.count_in.bars = 16;
        assert!(
            service
                .prepare_with_practice(plan, old.settings.clone(), None, settings)
                .is_err()
        );
        assert_eq!(service.prepared_generation(), Some(1));
        assert_eq!(service.shared.desired.load(Ordering::Acquire), 1);
    }
    #[test]
    fn count_fault_preserves_progressive_pass_on_full_count_restart() {
        let mut document = counted_document();
        document.practice.tempo = PracticeTempo::Progressive {
            start: 0.5,
            end: 1.0,
            step: 0.2,
            repetitions: 2,
        };
        document.practice.count_in.between_loops = true;
        let mut old = CallbackTransport::headless(48_000);
        old.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        old.command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 3840.0,
        })
        .unwrap();
        old.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        old.render_into(&mut vec![[0.0; 2]; 768_001]);
        assert_eq!(old.passes, 2);
        old.device_error();
        let mut next = recreate(&mut old, &document, 44_100);
        next.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        assert_eq!(next.passes, 2);
        assert!((next.count.unwrap().snapshot().bpm - 84.0).abs() < 1e-12);
        assert_eq!(next.count.unwrap().snapshot().elapsed_frames, 0);
    }
    #[test]
    fn healthy_device_barrier_acknowledges_queued_settings_and_freezes_clock() {
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        let document = counted_document();
        service.shared.desired.store(1, Ordering::Release);
        let mut transport = CallbackTransport::new(48_000, service.shared.clone());
        transport.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let (producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired, retirement_queue) = HeapRb::new(CONTROL_CAPACITY).split();
        {
            let mut state = service.control.lock().unwrap();
            state.producer = Some(producer);
            state.document = Some(document);
        }
        let mut applied = practice(0.7, true);
        applied.count_in.bars = 1;
        service
            .command(TransportCommand::SetPractice {
                generation: 1,
                settings: applied,
            })
            .unwrap();
        service
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 0.0,
                end_tick: 3840.0,
            })
            .unwrap();
        let mut callback = OutputCallback {
            transport,
            controls,
            retired,
            scratch: [[0.0; 2]; BLOCK],
            epoch: 0,
            suspended: false,
        };
        let worker = thread::spawn(move || {
            let _retirement_queue = retirement_queue;
            let until = std::time::Instant::now() + Duration::from_secs(1);
            let mut output = [1.0f32; BLOCK * 2];
            while !callback.suspended {
                callback.render(&mut output, 2);
                assert!(std::time::Instant::now() < until);
                thread::sleep(Duration::from_millis(1));
            }
            assert!(output.iter().all(|x| *x == 0.0));
            let tick = callback.transport.tick;
            callback.render(&mut output, 2);
            assert_eq!(callback.transport.tick, tick);
            callback.transport
        });
        service
            .synchronize_callback(&mut service.control.lock().unwrap(), Duration::from_secs(1))
            .unwrap();
        let snapshot = service.shared.snapshot().1;
        assert_eq!(snapshot.settings, applied);
        assert_eq!(snapshot.loop_range, Some((0.0, 3840.0)));
        assert_eq!(snapshot.phase, PracticePhase::Playing);
        let frozen = worker.join().unwrap();
        assert_eq!(snapshot.tick, frozen.tick);
        assert_eq!(snapshot.count, frozen.count.map(|c| c.snapshot()));
    }
    #[test]
    fn timed_out_device_barrier_cannot_suspend_a_later_callback() {
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        let mut document = counted_document();
        document.practice.count_in.bars = 0;
        let mut transport = CallbackTransport::new(48_000, service.shared.clone());
        transport.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let (producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired, _retirement_queue) = HeapRb::new(CONTROL_CAPACITY).split();
        let mut state = service.control.lock().unwrap();
        state.producer = Some(producer);
        assert!(
            service
                .synchronize_callback(&mut state, Duration::from_millis(1))
                .is_err()
        );
        let mut callback = OutputCallback {
            transport,
            controls,
            retired,
            scratch: [[0.0; 2]; BLOCK],
            epoch: 0,
            suspended: false,
        };
        callback.render(&mut [0.0f32; BLOCK * 2], 2);
        assert!(!callback.suspended);
        assert!(callback.transport.tick > 0.0);
    }
    #[test]
    fn unrepresentable_frozen_count_recovery_reports_fault_in_new_epoch() {
        let mut document = counted_document();
        let mut plan = document.plan.as_ref().clone();
        plan.tempos[0].bpm = 44_000.0;
        plan.occurrences[0].meter_denominator = 256;
        plan.duration_ms = 3840.0 * 60_000.0 / (44_000.0 * 960.0);
        plan.occurrences[0].end_ms = plan.duration_ms;
        document.plan = Arc::new(plan);
        document.practice = practice(1.0, true);
        document.practice.count_in.bars = 1;
        let mut old = CallbackTransport::headless(48_000);
        old.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        old.command(TransportCommand::Play { generation: 1 })
            .unwrap();
        old.render_into(&mut [[0.0; 2]; 1]);
        old.command(TransportCommand::SetPractice {
            generation: 1,
            settings: PracticeSettings {
                tempo: PracticeTempo::Relative { ratio: 0.1 },
                ..document.practice
            },
        })
        .unwrap();
        let (_, snapshot) = old.shared.next_epoch_snapshot();
        let mut next = CallbackTransport::new(44_100, old.shared.clone());
        next.renderer = Some(AudioService::renderer(&document, 44_100).unwrap());
        next.generation = 1;
        next.ready = true;
        assert!(next.restore(snapshot).is_err());
        assert!(!next.status().ready);
        assert!(!next.status().playing);
        assert_eq!(next.status().practice.phase, PracticePhase::Paused);
    }
    #[test]
    fn suspended_callback_cannot_acknowledge_later_installs_or_clear_fault() {
        let document = counted_document();
        let mut transport = CallbackTransport::headless(48_000);
        transport.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        transport.device_error();
        let (mut producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired, _retirement_queue) = HeapRb::new(CONTROL_CAPACITY).split();
        assert!(
            producer
                .try_push(CallbackCommand::Install {
                    renderer: AudioService::renderer(&document, 48_000).unwrap(),
                    generation: 2,
                    preserve: false,
                    practice: document.practice
                })
                .is_ok()
        );
        let mut callback = OutputCallback {
            transport,
            controls,
            retired,
            scratch: [[0.0; 2]; BLOCK],
            epoch: 0,
            suspended: true,
        };
        let mut output = [1.0f32; BLOCK * 2];
        callback.render(&mut output, 2);
        assert!(output.iter().all(|x| *x == 0.0));
        assert_eq!(callback.transport.status().generation, 1);
        assert!(!callback.transport.status().ready);
        assert!(!callback.controls.is_empty());
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
