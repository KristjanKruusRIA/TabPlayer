//! Device ownership and bounded controls. Only the stream callback owns the renderer;
//! resource work, stream creation, status events and retired allocations run elsewhere.
use super::{
    audition::{AuditionClip, AuditionConsumer, AuditionMixer, AuditionProducer, audition_channel},
    backing::BackingMap,
    decode::{DecodedAudio, decode_audio},
    dsp::TrackDsp,
    line_in::{
        FALLBACK_BPM, LineInControl, LineInMeter, LineInMonitor, LineInOutput, LineInPort,
        LineInRetired, LineInSettings, MESSAGE_CAPACITY, MonitorRing, build_chain, line_in_channel,
    },
    midi_out::{MidiOutPort, MidiOutShared, MidiTap},
    plan::PlaybackPlan,
    playback::PlaybackSpan,
    practice::{
        ClickVoice, CountInClock, CountInSnapshot, MetronomeSettings, PracticeTempo, PulsePosition,
        RenderTempo, progressive_ratio,
    },
    reference_sync::ReferenceSyncMap,
    renderer::{PreparedMix, Renderer},
    resources::AudioResources,
    voices::{drum_kit_for_track, resource_requests, track_locked, voice_id_for_track},
};
use crate::{
    midi_out::{Ensure, MidiOut, PendingRoute},
    settings::{ChannelMix, DocumentSettings},
};
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
        atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering},
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
    /// None when the backend cannot name the device; the interface words it.
    pub name: Option<String>,
    pub is_default: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagnostics {
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub buffer_size: Option<u32>,
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
    /// Clips that began sounding in the callback since the process started.
    pub audition_serial: u64,
    /// Peak absolute sample of the latest clip's own samples, before summing with
    /// playback, clamping or downmix.
    pub audition_peak: f64,
    pub plugin_delay_frames: usize,
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
    sound: AtomicU8,
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
            sound: AtomicU8::new(0),
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
        self.sound
            .store(value.metronome.sound.code(), Ordering::Relaxed);
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
                sound: super::practice::ClickSound::from_code(self.sound.load(Ordering::Relaxed)),
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
    audition_serial: AtomicU64,
    audition_peak: AtomicU64,
    /// Sample rate of the open output stream; zero until one has been opened.
    audition_rate: AtomicU32,
    /// Frames per callback of the open stream; zero until its first callback.
    buffer_size: AtomicU32,
    /// The largest callback, in frames, the open stream has asked for; zero until its first callback. A plug-in's
    /// pipeline is sized from it, not from the steady period: a shared-mode stream's first callback can be twice the
    /// period (preflight ruling P32).
    max_callback_frames: AtomicU32,
    /// Name of the device the open stream was built on; set when the stream opens,
    /// so diagnostics never probe the backend.
    stream_name: Mutex<Option<String>>,
    /// The system rerouted the live stream (`DeviceChanged`), so the cached name may
    /// be wrong until the next open. A plain flag: the stream's error callback sets it.
    name_stale: AtomicU64,
    plugin_delay_frames: AtomicU64,
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
            audition_serial: AtomicU64::new(0),
            audition_peak: AtomicU64::new(0),
            audition_rate: AtomicU32::new(0),
            buffer_size: AtomicU32::new(0),
            max_callback_frames: AtomicU32::new(0),
            stream_name: Mutex::new(None),
            name_stale: AtomicU64::new(0),
            plugin_delay_frames: AtomicU64::new(0),
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
        // Acquire pairs with the Release increment, so a new serial never shows a stale peak.
        let audition_serial = self.audition_serial.load(Ordering::Acquire);
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
            audition_serial,
            audition_peak: f64::from_bits(self.audition_peak.load(Ordering::Relaxed)),
            plugin_delay_frames: self.plugin_delay_frames.load(Ordering::Relaxed) as usize,
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
    /// Epoch-tagged like `fault`: stale only for the stream it was raised on, so an
    /// open (which bumps the epoch) clears it and a late notice cannot mark a new stream.
    fn name_stale(&self) -> bool {
        self.name_stale.load(Ordering::Acquire)
            == self.epoch.load(Ordering::Acquire).saturating_add(1)
    }
    fn mark_name_stale_for_epoch(&self, epoch: u64) {
        self.name_stale
            .fetch_max(epoch.saturating_add(1), Ordering::AcqRel);
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
    audition: AuditionMixer,
    line_in: LineInPort,
    /// The MIDI output: counts the stream's output frames and carries routed tracks' messages to the sender.
    midi: MidiOutPort,
    /// The output frame the transport is at, on the stream's count, for stamping MIDI messages.
    midi_cursor: u64,
    /// Frames of the device callback being rendered (0 when unknown: each call is a callback).
    device_frames: usize,
    /// Frames of it already rendered.
    callback_pos: usize,
    draining: usize,
}
impl CallbackTransport {
    pub fn headless(rate: u32) -> Self {
        Self::new(rate, Arc::new(SharedStatus::new()))
    }
    /// A headless transport with its own audition queue, for tests.
    pub fn headless_with_audition(rate: u32) -> (Self, AuditionProducer) {
        let (producer, consumer) = audition_channel();
        let mut transport = Self::headless(rate);
        transport.audition.attach(consumer);
        (transport, producer)
    }
    /// A headless transport with a Line-In queue, for tests. The control end sends what the
    /// service would: a monitor, a new chain, a level.
    pub fn headless_with_line_in(rate: u32) -> (Self, LineInControl) {
        let (control, port) = line_in_channel();
        let mut transport = Self::headless(rate);
        transport.line_in = port;
        (transport, control)
    }
    /// A headless transport with both queues, for tests.
    pub fn headless_with_audition_and_line_in(
        rate: u32,
    ) -> (Self, AuditionProducer, LineInControl) {
        let (mut transport, producer) = Self::headless_with_audition(rate);
        let (control, port) = line_in_channel();
        transport.line_in = port;
        (transport, producer, control)
    }
    /// A headless transport whose MIDI messages go to the returned ring, for tests.
    pub fn headless_with_midi(rate: u32) -> (Self, Arc<MidiOutShared>) {
        let shared = MidiOutShared::new();
        let mut transport = Self::headless(rate);
        transport.midi = MidiOutPort::attached(shared.clone(), rate);
        (transport, shared)
    }
    /// A headless transport whose MIDI messages go to `shared`, for tests that run the sender's side too.
    pub fn headless_with_midi_shared(rate: u32, shared: Arc<MidiOutShared>) -> Self {
        let mut transport = Self::headless(rate);
        transport.midi = MidiOutPort::attached(shared, rate);
        transport
    }
    /// Hand what the Line-In has replaced to `retire` so it is freed off the audio thread.
    pub fn retire_line_in(&mut self, retire: impl FnMut(LineInRetired) -> Option<LineInRetired>) {
        self.line_in.retire(retire);
    }
    /// Says how big the device callback is that the next `render_into` calls belong to. The
    /// Line-In needs the whole callback's worth buffered before it starts, not just the part
    /// being rendered.
    pub fn set_device_frames(&mut self, frames: usize) {
        self.device_frames = frames;
        self.callback_pos = 0;
    }
    /// Renders one device callback of any size the way the output stream does: in blocks of at
    /// most `BLOCK` frames with the callback size known throughout.
    pub fn render_callback(&mut self, output: &mut [[f32; 2]]) {
        self.set_device_frames(output.len());
        for block in output.chunks_mut(BLOCK) {
            self.render_into(block);
        }
    }
    /// Whether a Line-In is attached and sounding through this transport.
    pub fn line_in_active(&self) -> bool {
        self.line_in.active()
    }
    /// Hand finished audition clips to `retire` so they are freed off the audio thread.
    pub fn retire_auditions(
        &mut self,
        retire: impl FnMut(Box<AuditionClip>) -> Option<Box<AuditionClip>>,
    ) {
        self.audition.retire(retire);
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
            audition: AuditionMixer::new(rate),
            line_in: LineInPort::empty(),
            midi: MidiOutPort::empty(rate),
            midi_cursor: 0,
            device_frames: 0,
            callback_pos: 0,
            draining: 0,
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
        self.shared.plugin_delay_frames.store(
            self.renderer
                .as_ref()
                .map_or(0, |r| r.plugin_delay_frames() as u64),
            Ordering::Relaxed,
        );
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
            renderer.wrap_to_tick(self.tick);
        } else {
            self.draining = 0;
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
        // Whatever the replaced renderer left sounding on a MIDI port is released before the new one speaks.
        if let Some(old) = self.renderer.as_mut() {
            old.midi_set_cursor(self.midi.frames());
            if let Some(tap) = old.midi_tap() {
                tap.release_all();
                self.midi.flush(tap);
            }
        }
        renderer.midi_set_cursor(self.midi.frames());
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
    /// Takes a mix for the playing document; what comes back is retired off the audio thread. A transport that is not
    /// playing renders nothing to carry a level change through, so the change is complete when playing resumes.
    pub fn replace_mix(&mut self, mix: PreparedMix, generation: u64) -> Option<PreparedMix> {
        if generation != self.generation {
            return Some(mix);
        }
        let playing = self.playing;
        let Some(renderer) = self.renderer.as_mut() else {
            return Some(mix);
        };
        let old = renderer.replace_mix(mix);
        if !playing {
            renderer.settle_idle_kit();
        }
        old
    }
    /// Takes new MIDI routing for the playing document; what comes back is retired off the audio thread.
    pub fn replace_midi(&mut self, tap: Box<MidiTap>, generation: u64) -> Option<Box<MidiTap>> {
        if generation != self.generation {
            return Some(tap);
        }
        let Some(renderer) = self.renderer.as_mut() else {
            return Some(tap);
        };
        renderer.midi_set_cursor(self.midi_cursor);
        let old = renderer.replace_midi(tap);
        if let Some(tap) = renderer.midi_tap() {
            self.midi.flush(tap);
        }
        old
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
                    if let Some(renderer) = &mut self.renderer {
                        renderer.pause();
                    }
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
                self.draining = 0;
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
        self.draining = 0;
        if let Some(renderer) = &mut self.renderer {
            renderer.midi_set_cursor(self.midi_cursor);
            renderer.seek_tick(tick);
            self.seconds = renderer.tick_to_seconds(tick);
        }
        self.tick = tick;
    }
    fn wrap_to_tick(&mut self, tick: f64) {
        if let Some(renderer) = &mut self.renderer {
            renderer.midi_set_cursor(self.midi_cursor);
            renderer.wrap_to_tick(tick);
            self.seconds = renderer.tick_to_seconds(tick);
        }
        self.tick = tick;
    }
    fn fault(&mut self) {
        self.draining = 0;
        if let Some(renderer) = &mut self.renderer {
            renderer.pause();
        }
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
        self.wrap_to_tick(start);
        if self.practice.count_in.between_loops {
            self.start_count();
        }
    }
    /// Renders the next block of the device callback (see `set_device_frames`). Blocks of one
    /// callback follow each other; with no callback size set, every call is a whole callback.
    pub fn render_into(&mut self, output: &mut [[f32; 2]]) {
        let left = self.device_frames.saturating_sub(self.callback_pos);
        if self.callback_pos == 0 {
            self.midi.begin_callback(if self.device_frames > 0 {
                self.device_frames
            } else {
                output.len()
            });
        }
        self.render_block(output, left);
        if self.device_frames > 0 {
            self.callback_pos += output.len();
            if self.callback_pos >= self.device_frames {
                self.callback_pos = 0;
            }
        }
    }
    fn render_block(&mut self, output: &mut [[f32; 2]], left_in_callback: usize) {
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
            self.midi_end_block(false, 0, 0, output.len());
            return;
        }
        let mut offset = 0;
        let mut rendered = 0;
        let was_playing = self.playing;
        while self.playing && offset < output.len() {
            if self.draining > 0 {
                let Some(renderer) = &mut self.renderer else {
                    self.draining = 0;
                    self.playing = false;
                    self.phase = PracticePhase::Ended;
                    break;
                };
                let count = (output.len() - offset).min(self.draining);
                for frame in 0..count {
                    output[offset + frame] = renderer.drain_frame();
                }
                offset += count;
                self.draining -= count;
                if self.draining == 0 {
                    let ceiling = self
                        .loop_range
                        .map(|r| r.1)
                        .or(self.range.map(|r| r.end_tick));
                    let end = ceiling.unwrap_or_else(|| renderer.duration_tick());
                    self.seek(end);
                    self.playing = false;
                    self.phase = PracticePhase::Ended;
                    self.cancel_count();
                    self.pulse = None;
                    break;
                }
                continue;
            }
            self.midi_cursor = self.midi.frames() + offset as u64;
            if let Some(clock) = &mut self.count {
                let frame = clock.next_frame();
                if frame.finished {
                    self.count = None;
                    self.resume_count = false;
                    self.phase = PracticePhase::Playing;
                    continue;
                }
                if let Some(pulse) = frame.pulse {
                    self.click
                        .trigger(pulse.accent, self.practice.metronome.sound);
                    self.add_pulse(pulse, true, 1);
                }
                let click = self.click.frame(self.practice.metronome.volume);
                output[offset] = if let Some(renderer) = &mut self.renderer {
                    renderer.count_in_frame(click)
                } else {
                    [click, click]
                };
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
            let d_max = renderer.plugin_delay_frames();
            if count == 0 {
                if let Some((start, _)) = self.loop_range {
                    self.wrap(start);
                    continue;
                }
                if d_max > 0 {
                    self.draining = d_max;
                    continue;
                }
                self.seek(end);
                self.playing = false;
                self.phase = PracticePhase::Ended;
                self.cancel_count();
                self.pulse = None;
                break;
            }
            renderer.midi_set_cursor(self.midi_cursor);
            let status = if let Some(end) = ceiling {
                renderer.render_until(&mut output[offset..offset + count], end)
            } else {
                renderer.render_into(&mut output[offset..offset + count])
            };
            self.tick = status.tick;
            self.seconds = status.seconds;
            offset += count;
            rendered += count;
            // A seek, a wrap or the end that follows is at the frame the rendering reached, not where it began.
            self.midi_cursor = self.midi.frames() + offset as u64;
            if let Some(pulse) = status.last_pulse {
                self.add_pulse(pulse, false, status.pulse_count);
            }
            if count == remaining || (ceiling.is_none() && status.ended) {
                if let Some((start, _)) = self.loop_range {
                    self.wrap(start);
                } else if d_max > 0 {
                    self.draining = d_max;
                } else {
                    self.seek(end);
                    self.playing = false;
                    self.phase = PracticePhase::Ended;
                    self.cancel_count();
                    self.pulse = None;
                }
            }
        }
        self.midi_end_block(was_playing || self.playing, rendered, offset, output.len());
        if offset > 0 {
            self.frames = self.frames.saturating_add(offset as u64);
            let peak = output[..offset]
                .iter()
                .flat_map(|f| f.iter())
                .fold(0.0f64, |p, x| p.max(x.abs() as f64));
            self.peak = self.peak.max(peak);
        }
        // Audition clips ride on top of normal playback and never touch its counters.
        // The device test tone is the exception: it yields to playback and count-in.
        self.audition.cut_tones(was_playing || self.playing);
        let report = self.audition.mix(output);
        if let Some(peak) = report.peak {
            self.shared
                .audition_peak
                .store(peak.to_bits(), Ordering::Relaxed);
        }
        if report.started {
            self.shared.audition_serial.fetch_add(1, Ordering::Release);
        }
        // The Line-In comes last so that what it adds to the score and any audition is held below
        // full scale. It follows the score's tempo for tempo-synced effects, playing or not, and
        // 120 bpm when the score has none to give.
        let bpm = if self.line_in.active() {
            let bpm = self.actual_bpm();
            if bpm.is_finite() && (20.0..=400.0).contains(&bpm) {
                bpm
            } else {
                FALLBACK_BPM
            }
        } else {
            FALLBACK_BPM
        };
        self.line_in
            .mix(output, bpm, self.device_frames, left_in_callback);
        self.publish();
    }
    /// The end of a block: applies a port failure the sender found, lets go of every note once the score stops
    /// rendering, and hands the messages the block staged to the sender. `playing` is the transport playing (counting in
    /// or not), `rendered` of the block's `len` frames came from the renderer; the block's counting frames end at `offset`.
    fn midi_end_block(&mut self, playing: bool, rendered: usize, offset: usize, len: usize) {
        let mask = self.midi.fault_mask();
        let at = self.midi.frames() + offset as u64;
        let mut routed = false;
        if let Some(renderer) = &mut self.renderer {
            if let Some(tap) = renderer.midi_tap() {
                tap.set_cursor(at);
                if self.midi.take_reset() {
                    // The sender threw away what had been queued: let go of the notes, and state the position again.
                    tap.on_seek();
                }
                tap.set_fault_mask(mask);
                if rendered == 0 {
                    tap.idle();
                }
                tap.service();
                self.midi.flush(tap);
                if tap.has_routes() {
                    routed = true;
                    // Every callback of a routed score gives the sender its clock, not only the ones with notes.
                    self.midi.keep_clock();
                }
            }
        }
        // The sender stays ready for as long as the score plays (a count-in is playing too: nothing renders, and the
        // first chord follows its last click), and only if something is routed.
        self.midi.set_rendering(playing && routed);
        self.midi.advance(len);
        self.midi_cursor = self.midi.frames();
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
                    if age < (f64::from(self.rate) * self.practice.metronome.sound.seconds()) as u64
                    {
                        self.click.trigger(
                            (s.emitted_pulses - 1) % s.numerator == 0,
                            self.practice.metronome.sound,
                        );
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
    /// New MIDI routing for the document of `generation`.
    MidiRoute {
        tap: Box<MidiTap>,
        generation: u64,
    },
    Transport(TransportCommand),
    Barrier(u64),
}
#[allow(dead_code)]
enum Retired {
    Renderer(Box<Renderer>),
    Mix(PreparedMix),
    Clip(Box<AuditionClip>),
    LineIn(LineInRetired),
    MidiTap(Box<MidiTap>),
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
        // Only the live stream reports its size; a retired callback must not
        // overwrite the replacement's field.
        if channels > 0 {
            let frames = (output.len() / channels) as u32;
            self.transport
                .shared
                .buffer_size
                .store(frames, Ordering::Relaxed);
            self.transport
                .shared
                .max_callback_frames
                .fetch_max(frames, Ordering::Relaxed);
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
                    let old = self.transport.replace_mix(mix, generation);
                    if let Some(old) = old {
                        let _ = self.retired.try_push(Retired::Mix(old));
                    }
                }
                CallbackCommand::MidiRoute { tap, generation } => {
                    if let Some(old) = self.transport.replace_midi(tap, generation) {
                        let _ = self.retired.try_push(Retired::MidiTap(old));
                    }
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
            // A frozen stream renders nothing, whatever it was doing when it was frozen.
            self.transport.midi.set_rendering(false);
            output.fill(T::from_sample(0.0));
            return;
        }
        self.transport
            .set_device_frames(output.len() / channels.max(1));
        for chunk in output.chunks_mut(BLOCK * channels) {
            let frames = chunk.len() / channels;
            // A mix parked during a crossfade takes over between blocks, once there is room to retire the one it replaces.
            if !self.retired.is_full() {
                if let Some(old) = self
                    .transport
                    .renderer
                    .as_mut()
                    .and_then(|r| r.settle_mix())
                {
                    let _ = self.retired.try_push(Retired::Mix(old));
                }
            }
            self.transport.render_into(&mut self.scratch[..frames]);
            let retired = &mut self.retired;
            self.transport
                .retire_auditions(|clip| match retired.try_push(Retired::Clip(clip)) {
                    Ok(()) => None,
                    Err(Retired::Clip(clip)) => Some(clip),
                    Err(other) => {
                        std::mem::forget(other);
                        None
                    }
                });
            let retired = &mut self.retired;
            self.transport
                .retire_line_in(|item| match retired.try_push(Retired::LineIn(item)) {
                    Ok(()) => None,
                    Err(Retired::LineIn(item)) => Some(item),
                    Err(other) => {
                        std::mem::forget(other);
                        None
                    }
                });
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

/// The output callback itself without a device, for tests that count what it allocates: the
/// command queue, the retirement queue, the channel mapping and the Line-In, as a stream runs them.
#[doc(hidden)]
pub struct HeadlessOutput {
    callback: OutputCallback,
    retired: HeapCons<Retired>,
    control: LineInControl,
}
#[doc(hidden)]
impl HeadlessOutput {
    pub fn new(rate: u32) -> Self {
        let shared = Arc::new(SharedStatus::new());
        let (_commands, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired_in, retired) = HeapRb::new(CONTROL_CAPACITY).split();
        let epoch = shared.epoch.load(Ordering::Acquire);
        let mut transport = CallbackTransport::new(rate, shared);
        let (control, port) = line_in_channel();
        transport.line_in = port;
        Self {
            callback: OutputCallback {
                transport,
                controls,
                retired: retired_in,
                scratch: [[0.0; 2]; BLOCK],
                epoch,
                suspended: false,
            },
            retired,
            control,
        }
    }
    pub fn control(&mut self) -> &mut LineInControl {
        &mut self.control
    }
    /// One device callback of `output.len() / channels` frames.
    pub fn render(&mut self, output: &mut [f32], channels: usize) {
        self.callback.render(output, channels);
    }
    /// Frees what the callback retired, as the device manager thread does.
    pub fn free_retired(&mut self) -> usize {
        let mut freed = 0;
        while self.retired.try_pop().is_some() {
            freed += 1;
        }
        freed
    }
}
#[derive(Clone)]
struct PreparedDocument {
    plan: Arc<PlaybackPlan>,
    settings: DocumentSettings,
    resources: Arc<AudioResources>,
    backing: Option<Arc<DecodedAudio>>,
    practice: PracticeSettings,
    plugin_plans: Vec<(
        String,
        Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
    )>,
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
    /// An open with no score (for the Line-In): its failure is the caller's error to report, not a
    /// fault of the output.
    idle: bool,
}
enum ManagerRequest {
    Open(OpenRequest),
    Shutdown,
}
/// The audition producer with the stream (epoch and rate) it feeds.
struct AuditionSlot {
    producer: AuditionProducer,
    epoch: u64,
    rate: u32,
}
/// The Line-In state the service keeps across prepares, scores and output devices. Its own leaf
/// lock, taken after `control` when both are needed and never held while waiting on the audio
/// thread. Nothing here belongs to a score.
#[derive(Default)]
struct LineInSlot {
    /// What the Line-In should sound like, whether or not it is running.
    settings: LineInSettings,
    /// The capture currently feeding the output, if any.
    active: Option<ActiveLineIn>,
    /// The queue to the open stream's transport, and that stream's sample rate.
    control: Option<LineInControl>,
    rate: u32,
    /// The ticket of the latest `line_in_set` applied.
    applied: u64,
    /// What the stream's Line-In has been told so far. It trails `settings` while the stream is not
    /// listening (failed, reopening) or its queue is full, and is brought up to date later.
    sent: LineInSettings,
}
/// What a stream's Line-In was built from, to find out afterwards what changed while it opened.
struct LineInBuilt {
    settings: LineInSettings,
    ring: Option<Arc<MonitorRing>>,
}
struct ActiveLineIn {
    ring: Arc<MonitorRing>,
    meter: Arc<LineInMeter>,
}
pub struct AudioService {
    root: PathBuf,
    shared: Arc<SharedStatus>,
    control: Mutex<ControlState>,
    /// Producer for the audition queue. Its own leaf lock, never held with `control`
    /// by anything that waits, so an audition never queues behind a prepare.
    audition: Mutex<Option<AuditionSlot>>,
    line_in: Mutex<LineInSlot>,
    /// The latest `line_in_set` ticket handed out.
    line_in_issued: AtomicU64,
    /// External MIDI output: its ports, sender thread and routing. Its own leaf locks; nothing here is held across a
    /// wait on the audio thread.
    midi: MidiOut,
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
            audition: Mutex::new(None),
            line_in: Mutex::new(LineInSlot::default()),
            line_in_issued: AtomicU64::new(0),
            midi: MidiOut::default(),
            manager,
        }
    }
    /// External MIDI output.
    pub fn midi_out(&self) -> &MidiOut {
        &self.midi
    }
    /// Called when the interface refreshes the port list: tries again the ports the open document sends tracks to that
    /// are not working. Does nothing while every port works, and never waits for a port to open.
    pub fn midi_refresh(&self) {
        let Some(settings) = self
            .control
            .lock()
            .unwrap()
            .document
            .as_ref()
            .map(|d| d.settings.clone())
        else {
            return;
        };
        let names = MidiOut::port_names(&settings);
        if self.midi.any_unavailable(&names) {
            // The tracks are routed already: the port's bit moves them over when it opens. Nothing waits here.
            self.midi.ensure_ports(&names, Ensure::Refresh);
        }
    }
    /// A renderer for `document` with its tracks routed to the MIDI ports its mixes name, and the routing to record
    /// once the renderer has been accepted. The ports were started opening before the control lock was taken (see
    /// `MidiOut::ensure_ports`), and the tracks are routed to them whether or not they have opened: a track plays on
    /// the internal sound until its port's bit says the port works, so nothing here waits.
    fn routed_renderer(
        &self,
        document: &PreparedDocument,
        rate: u32,
    ) -> Result<(Box<Renderer>, PendingRoute), String> {
        let callback_frames = self.max_callback_frames().unwrap_or(512) as usize;
        let mut renderer = Self::renderer_with_callback_frames(document, rate, callback_frames)?;
        let mut pending = self
            .midi
            .build_route(&document.plan, &document.settings, false);
        if let Some(tap) = pending.tap.take() {
            renderer.replace_midi(tap);
        }
        Ok((renderer, pending))
    }
    /// Sample rate to render an audition for, or None when no output stream has ever
    /// opened or the device has failed. Reads atomics only.
    pub fn audition_rate(&self) -> Option<u32> {
        let rate = self.shared.audition_rate.load(Ordering::Acquire);
        (rate != 0 && !self.shared.is_faulted()).then_some(rate)
    }
    /// Queue a finished clip for the callback. False when no stream exists or the queue is full.
    /// Refuses clips the live stream could not sound: a replaced stream (epoch), a
    /// faulted device, or a clip rendered for another sample rate.
    ///
    /// Not handled: during `SelectDevice`, while the old callback is suspended and
    /// before `open_current` bumps the epoch, a clip is still accepted (true) and is
    /// lost with the old stream.
    pub fn submit_audition(&self, clip: Box<AuditionClip>) -> bool {
        match self.audition.lock().unwrap().as_mut() {
            Some(slot)
                if slot.epoch == self.shared.epoch.load(Ordering::Acquire)
                    && !self.shared.is_faulted()
                    && clip.rate == slot.rate =>
            {
                slot.producer.try_push(clip).is_ok()
            }
            _ => false,
        }
    }
    /// Test hook: attach an audition queue as if a stream at `rate` had opened.
    #[cfg(test)]
    pub(crate) fn attach_test_audition(&self, rate: u32) -> AuditionConsumer {
        let (producer, consumer) = audition_channel();
        *self.audition.lock().unwrap() = Some(AuditionSlot {
            producer,
            epoch: self.shared.epoch.load(Ordering::Acquire),
            rate,
        });
        self.shared.audition_rate.store(rate, Ordering::Release);
        consumer
    }
    pub fn status(&self) -> NativeAudioStatus {
        self.shared.read()
    }
    /// Makes sure an output stream exists for the Line-In and returns its rate. With a score
    /// prepared the stream is already open. Without one (the application has not prepared its
    /// first score yet) the stream is opened with nothing to play, and the first prepare installs
    /// into it. An output that has failed stays failed until the player selects a device.
    fn line_in_output(&self) -> Result<u32, String> {
        let mut state = self.control.lock().unwrap();
        if state.producer.is_none() && state.document.is_none() {
            self.open_idle(&mut state)?;
        } else if state.producer.is_none() || self.shared.is_faulted() {
            return Err("Audio output stopped. Select an output device to recover.".into());
        }
        Ok(state.rate)
    }
    /// The Line-In is not part of any score: a running one is rebuilt for a new stream's rate (off
    /// the audio thread, here) from the settings the service keeps, and installed in `transport`
    /// before its stream starts. Returns the queue for the stream's lifetime and what the
    /// monitor was built from. The queue replaces the old stream's only when `line_in_commit`
    /// says the stream opened.
    fn line_in_prepare(
        &self,
        transport: &mut CallbackTransport,
        rate: u32,
    ) -> (LineInControl, LineInBuilt) {
        let (control, port) = line_in_channel();
        transport.line_in = port;
        let mut slot = self.line_in.lock().unwrap();
        let settings = slot.settings.clone();
        let monitor = slot.active.as_ref().and_then(|active| {
            LineInMonitor::new(active.ring.clone(), active.meter.clone(), &settings, rate).ok()
        });
        if monitor.is_none() {
            slot.active = None;
        }
        let ring = slot.active.as_ref().map(|active| active.ring.clone());
        if let Some(monitor) = monitor {
            transport.line_in.install(monitor);
        }
        (control, LineInBuilt { settings, ring })
    }
    /// Makes `control` the Line-In queue of the stream that just opened at `rate`. Whatever
    /// happened while the stream was opening went to the old stream's queue, so the difference
    /// is sent again: a capture attached or detached in the meantime, and any change of sound.
    fn line_in_commit(&self, mut control: LineInControl, rate: u32, built: LineInBuilt) {
        let mut slot = self.line_in.lock().unwrap();
        let wanted = slot.active.as_ref().map(|active| active.ring.clone());
        let same = match (&built.ring, &wanted) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            _ => false,
        };
        let mut sent = built.settings.clone();
        if !same {
            let handed = match slot.active.as_ref() {
                Some(active) => LineInMonitor::new(
                    active.ring.clone(),
                    active.meter.clone(),
                    &slot.settings,
                    rate,
                )
                .and_then(|monitor| control.attach(monitor)),
                None => control.detach(),
            };
            match handed {
                Ok(()) => sent = slot.settings.clone(),
                // Nothing can be heard from a capture that could not be handed over.
                Err(_) => slot.active = None,
            }
        } else if slot.active.is_some() && built.settings != slot.settings {
            let wanted = slot.settings.clone();
            let _ = Self::line_in_send(&mut control, rate, &mut sent, &wanted, None);
        }
        slot.sent = sent;
        slot.control = Some(control);
        slot.rate = rate;
    }
    /// Sends what differs between `sent` (what a stream has been told) and `wanted`, bringing
    /// `sent` up as far as it gets. `prebuilt` is a chain already made for `wanted.sound`, at
    /// its rate.
    fn line_in_send(
        control: &mut LineInControl,
        rate: u32,
        sent: &mut LineInSettings,
        wanted: &LineInSettings,
        prebuilt: Option<(u32, Box<TrackDsp>)>,
    ) -> Result<(), String> {
        if sent.sound != wanted.sound {
            let chain = match prebuilt {
                Some((made_for, chain)) if made_for == rate => chain,
                _ => build_chain(&wanted.sound, rate)?,
            };
            control.chain(chain)?;
            sent.sound = wanted.sound.clone();
        }
        if sent.level != wanted.level || sent.monitor != wanted.monitor {
            control.level(wanted.level as f32, wanted.monitor)?;
            sent.level = wanted.level;
            sent.monitor = wanted.monitor;
        }
        Ok(())
    }
    /// Brings the running stream up to the stored settings, if it can take them: it is neither
    /// failed nor behind on its queue. What cannot be sent now stays recorded as unsent and goes
    /// out on a later call, or with the next stream. A sound chain the audio thread gave up on
    /// is replaced by a fresh one, built here.
    fn line_in_flush(&self, slot: &mut LineInSlot, prebuilt: Option<(u32, Box<TrackDsp>)>) {
        let Some(meter) = slot.active.as_ref().map(|active| active.meter.clone()) else {
            return;
        };
        let rate = slot.rate;
        let dead = self.shared.is_faulted();
        let wanted = slot.settings.clone();
        let mut sent = slot.sent.clone();
        let Some(control) = slot.control.as_mut() else {
            return;
        };
        if dead || control.pending() >= MESSAGE_CAPACITY / 2 {
            return;
        }
        if sent != wanted {
            let _ = Self::line_in_send(control, rate, &mut sent, &wanted, prebuilt);
        }
        if meter.take_broken() {
            let sent_fresh = build_chain(&wanted.sound, rate)
                .and_then(|chain| control.fresh(chain))
                .is_ok();
            if !sent_fresh {
                meter.mark_broken();
            }
        }
        slot.sent = sent;
    }
    /// Attaches a capture's ring to the output stream, with the service's Line-In settings.
    fn line_in_attach(
        &self,
        ring: Arc<MonitorRing>,
        meter: Arc<LineInMeter>,
    ) -> Result<(), String> {
        let mut slot = self.line_in.lock().unwrap();
        let rate = slot.rate;
        let monitor = LineInMonitor::new(ring.clone(), meter.clone(), &slot.settings, rate)?;
        slot.control
            .as_mut()
            .ok_or("Audio output is not ready.")?
            .attach(monitor)?;
        slot.active = Some(ActiveLineIn { ring, meter });
        slot.sent = slot.settings.clone();
        Ok(())
    }
    fn line_in_detach(&self) {
        let mut slot = self.line_in.lock().unwrap();
        slot.active = None;
        if let Some(control) = slot.control.as_mut() {
            let _ = control.detach();
        }
    }
    /// Checks `wanted` and takes the next ticket. Changes apply in ticket order and a change
    /// whose ticket has been overtaken is dropped, so changes that run on different threads can
    /// never leave an older one in place of a newer one. Take the ticket where the change is
    /// received (the order of tickets is the order in which callers asked, which is the order of
    /// arrival only as far as the caller keeps its own calls in order), and apply it wherever
    /// the work is done.
    pub fn line_in_ticket(&self, wanted: &LineInSettings) -> Result<u64, String> {
        wanted.validate()?;
        Ok(self.line_in_issued.fetch_add(1, Ordering::AcqRel) + 1)
    }
    /// Applies a change that has its ticket. The settings are always recorded. If a Line-In is
    /// running and its stream can take the change, the sound chain is built (off the audio
    /// thread, outside every lock) and crossfades in, and a level change glides; if the stream
    /// is failed, reopening or behind on its queue, nothing is sent now and the difference goes
    /// out when it can (`line_in_resync`, or the next stream). A change with an overtaken ticket
    /// is skipped (a newer one is on its way and covers it). Choosing what is already set sends
    /// nothing. Valid whether or not a Line-In is running: it applies to the next one too. Never
    /// touches the score.
    pub fn line_in_apply(&self, wanted: LineInSettings, ticket: u64) -> Result<(), String> {
        if ticket < self.line_in_issued.load(Ordering::Acquire) {
            return Ok(());
        }
        let (rate, rebuild) = {
            let slot = self.line_in.lock().unwrap();
            if ticket <= slot.applied {
                return Ok(());
            }
            (
                slot.rate,
                slot.active.is_some()
                    && slot.sent.sound != wanted.sound
                    && !self.shared.is_faulted(),
            )
        };
        let prebuilt = if rebuild && rate != 0 {
            Some((rate, build_chain(&wanted.sound, rate)?))
        } else {
            None
        };
        let mut slot = self.line_in.lock().unwrap();
        if ticket <= slot.applied {
            return Ok(());
        }
        slot.settings = wanted;
        slot.applied = ticket;
        self.line_in_flush(&mut slot, prebuilt);
        Ok(())
    }
    /// Takes a ticket and applies the change at once.
    pub fn line_in_set(&self, wanted: LineInSettings) -> Result<(), String> {
        let ticket = self.line_in_ticket(&wanted)?;
        self.line_in_apply(wanted, ticket)
    }
    /// Sends whatever the stream could not take earlier, and replaces a sound chain that went
    /// bad. Cheap when there is nothing to do.
    pub fn line_in_resync(&self) {
        let mut slot = self.line_in.lock().unwrap();
        self.line_in_flush(&mut slot, None);
    }
    /// The settings the Line-In has now.
    pub fn line_in_settings(&self) -> LineInSettings {
        self.line_in.lock().unwrap().settings.clone()
    }
    /// What the open stream reported when it opened, plus the live callback size.
    /// Reads cached values only: it never probes the audio backend, so it cannot
    /// disturb a running stream. Anything not known reads `None`, never a default.
    pub fn diagnostics(&self) -> Result<AudioDiagnostics, String> {
        if self.shared.is_faulted() {
            return Err(AUDIO_ERROR_FAILED.into());
        }
        let rate = self.shared.audition_rate.load(Ordering::Acquire);
        let buffer = self.shared.buffer_size.load(Ordering::Relaxed);
        Ok(AudioDiagnostics {
            device_name: if self.shared.name_stale() {
                None
            } else {
                self.shared.stream_name.lock().unwrap().clone()
            },
            sample_rate: (rate != 0).then_some(rate),
            buffer_size: (buffer != 0).then_some(buffer),
        })
    }
    /// The largest callback, in frames, the open stream has asked for so far, or `None` before its first callback. A
    /// plug-in insert's pipeline is `limits::pipeline_frames` of it.
    pub fn max_callback_frames(&self) -> Option<u32> {
        let frames = self.shared.max_callback_frames.load(Ordering::Relaxed);
        (frames != 0).then_some(frames)
    }
    /// Plays a quiet 440 Hz tone through the open stream. The refusal is a stable
    /// code (`AUDIO_ERROR_*`); the interface words it.
    pub fn test_tone(&self) -> Result<(), String> {
        if self.shared.is_faulted() {
            return Err(AUDIO_ERROR_FAILED.into());
        }
        if self.shared.playing.load(Ordering::Acquire) {
            return Err(AUDIO_ERROR_TONE_PLAYBACK.into());
        }
        let rate = self
            .audition_rate()
            .ok_or_else(|| AUDIO_ERROR_UNAVAILABLE.to_string())?;
        let clip = Box::new(tone_clip(rate));
        if !self.submit_audition(clip) {
            return Err(AUDIO_ERROR_UNAVAILABLE.into());
        }
        // Playback may have started between the check and the submit; the callback
        // cuts the tone either way, so report the refusal the player will hear.
        if self.shared.playing.load(Ordering::Acquire) {
            return Err(AUDIO_ERROR_TONE_PLAYBACK.into());
        }
        Ok(())
    }
    pub fn devices(&self) -> Result<Vec<AudioDeviceInfo>, String> {
        let host = cpal::default_host();
        let default = host.default_output_device();
        host.output_devices()
            .map_err(|e| format!("Could not enumerate audio outputs: {e}"))?
            .map(|device| {
                Ok(AudioDeviceInfo {
                    id: device.id().map_err(|e| e.to_string())?.to_string(),
                    name: device_label(&device),
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
    /// Track IDs of the prepared document in track order.
    pub fn prepared_track_ids(&self) -> Option<Vec<String>> {
        self.control
            .lock()
            .unwrap()
            .document
            .as_ref()
            .map(|document| document.plan.tracks.iter().map(|t| t.id.clone()).collect())
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
        self.prepare_with_practice_and_plugins(plan, settings, backing_bytes, practice, Vec::new())
    }

    pub fn prepare_with_practice_and_plugins(
        &self,
        plan: PlaybackPlan,
        settings: DocumentSettings,
        backing_bytes: Option<Vec<u8>>,
        practice: PracticeSettings,
        plugin_plans: Vec<(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )>,
    ) -> Result<(), String> {
        practice
            .validate(backing_bytes.is_some() || settings.backing.is_some())
            .map_err(str::to_string)?;
        plan.validate()?;
        validate_count(&plan, practice, 8_000)?;
        validate_count(&plan, practice, 192_000)?;
        let generation = plan.generation;
        let previous = self.shared.desired.fetch_max(generation, Ordering::AcqRel);
        let result = self.prepare_current(plan, settings, backing_bytes, practice, plugin_plans);
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
        plugin_plans: Vec<(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )>,
    ) -> Result<(), String> {
        let generation = plan.generation;
        self.midi
            .ensure_ports(&MidiOut::port_names(&settings), Ensure::Prepare);
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
            plugin_plans,
        };
        if state.producer.is_none() || self.shared.is_faulted() {
            // Validate music independently of the available device. Retain it after
            // an output failure so selecting a working device can recover it.
            let callback_frames = self.max_callback_frames().unwrap_or(512) as usize;
            let _ = Self::renderer_with_callback_frames(&document, state.rate, callback_frames)?;
            if let Err(error) = self.open(&mut state, document.clone(), false) {
                if self.shared.desired.load(Ordering::Acquire) == generation
                    && self.shared.is_faulted()
                {
                    state.document = Some(document);
                }
                return Err(error);
            }
        } else {
            let (renderer, route) = self.routed_renderer(&document, state.rate)?;
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
            self.midi.commit(route);
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

    #[allow(dead_code)]
    fn renderer(document: &PreparedDocument, rate: u32) -> Result<Box<Renderer>, String> {
        Self::renderer_with_callback_frames(document, rate, 512)
    }

    fn renderer_with_callback_frames(
        document: &PreparedDocument,
        rate: u32,
        callback_frames: usize,
    ) -> Result<Box<Renderer>, String> {
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
        let mut renderer = Renderer::new_with_plugins(
            document.plan.clone(),
            document.resources.clone(),
            document.settings.clone(),
            rate,
            &document.plugin_plans,
            callback_frames,
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
            let processing = document
                .settings
                .backing
                .as_ref()
                .and_then(|backing| backing.processing.clone())
                .unwrap_or_default();
            renderer.install_processed_backing(audio.clone(), map, mix, processing)?;
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
        self.set_mix_with_plugins(settings, generation, Vec::new())
    }

    pub fn set_mix_with_plugins(
        &self,
        settings: DocumentSettings,
        generation: u64,
        plugin_plans: Vec<(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )>,
    ) -> Result<(), String> {
        self.set_mix_inner(settings, generation, None, plugin_plans)
    }
    pub fn set_mix_with_backing(
        &self,
        settings: DocumentSettings,
        generation: u64,
        backing_bytes: Option<Vec<u8>>,
    ) -> Result<(), String> {
        self.set_mix_inner(settings, generation, Some(backing_bytes), Vec::new())
    }

    pub fn set_mix_with_backing_and_plugins(
        &self,
        settings: DocumentSettings,
        generation: u64,
        backing_bytes: Option<Vec<u8>>,
        plugin_plans: Vec<(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )>,
    ) -> Result<(), String> {
        self.set_mix_inner(settings, generation, Some(backing_bytes), plugin_plans)
    }
    fn set_mix_inner(
        &self,
        settings: DocumentSettings,
        generation: u64,
        backing_bytes: Option<Option<Vec<u8>>>,
        plugin_plans: Vec<(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )>,
    ) -> Result<(), String> {
        self.midi
            .ensure_ports(&MidiOut::port_names(&settings), Ensure::Mix);
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
        let voice_changed = sound_source_changed(&old.plan, &old.settings, &settings);
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
        let processing_changed = old
            .settings
            .backing
            .as_ref()
            .and_then(|backing| backing.processing.clone())
            .unwrap_or_default()
            != settings
                .backing
                .as_ref()
                .and_then(|backing| backing.processing.clone())
                .unwrap_or_default();
        let presence_changed = backing_bytes
            .as_ref()
            .is_some_and(|bytes| bytes.is_some() != old.backing.is_some());
        if voice_changed || map_changed || presence_changed || processing_changed {
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
                plugin_plans,
            };
            let (renderer, route) = self.routed_renderer(&document, state.rate)?;
            Self::enqueue(
                &mut state,
                CallbackCommand::Install {
                    renderer,
                    generation,
                    preserve: true,
                    practice: document.practice,
                },
            )?;
            self.midi.commit(route);
            self.set_backing_duration(&document);
            state.document = Some(document);
        } else {
            let callback_frames = self.max_callback_frames().unwrap_or(512) as usize;
            let mix = PreparedMix::prepare_with_plugins(
                &settings,
                &old.plan,
                state.rate,
                &plugin_plans,
                callback_frames,
            )?;
            let mut route = self
                .midi
                .build_route(&old.plan, &settings, self.midi.routed());
            Self::enqueue(&mut state, CallbackCommand::Mix { mix, generation })?;
            if let Some(tap) = route.tap.take() {
                Self::enqueue(&mut state, CallbackCommand::MidiRoute { tap, generation })?;
                // A new routing is about to be stated to its ports.
                self.midi.wake();
            }
            self.midi.commit(route);
            let doc = state.document.as_mut().unwrap();
            doc.settings = settings;
            doc.plugin_plans = plugin_plans;
        }
        Ok(())
    }
    pub fn command(&self, command: TransportCommand) -> Result<(), String> {
        // The sender looks for new records at once, whatever this turns out to start.
        self.midi.wake();
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
                plugin_plans: document.plugin_plans.clone(),
            };
            let frozen = self.synchronize_callback(&mut state, Duration::from_secs(1));
            // The old callback is frozen (or did not answer, and is not to be trusted) and will never release what it
            // holds on a port, whether or not the new device opens.
            self.midi.reset();
            frozen?;
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
        let result = self.open_current(state, Some(document), preserve);
        if result.is_err() {
            self.shared.mark_fault();
            // Nothing is playing any more: whatever a stream left sounding on a port is silenced.
            self.midi.reset();
        }
        result
    }
    /// Opens the output with no score: the stream plays nothing but audition clips and the
    /// Line-In until a score is prepared, which then installs into it. A failure is returned
    /// without marking the device faulted (neither here nor in the device manager), so it shows
    /// only as the Line-In start's error and the next prepare simply tries again.
    fn open_idle(&self, state: &mut ControlState) -> Result<(), String> {
        self.open_current(state, None, false)
    }
    fn open_current(
        &self,
        state: &mut ControlState,
        document: Option<PreparedDocument>,
        preserve: bool,
    ) -> Result<(), String> {
        let (device, config) = choose_output(state.device.as_deref())?;
        let rate = config.sample_rate();
        let (renderer, route) = match &document {
            Some(document) => {
                let (renderer, route) = self.routed_renderer(document, rate)?;
                validate_count(&document.plan, document.practice, rate)?;
                if document.plan.generation != self.shared.desired.load(Ordering::Acquire) {
                    return Err("A newer score preparation superseded this request.".into());
                }
                (Some(renderer), Some(route))
            }
            None => (None, None),
        };
        let (producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired_out, retired) = HeapRb::new(CONTROL_CAPACITY).split();
        let (epoch, snapshot) = self.shared.next_epoch_snapshot();
        // The replacement stream reports its own size on its first callback.
        self.shared.buffer_size.store(0, Ordering::Relaxed);
        self.shared.max_callback_frames.store(0, Ordering::Relaxed);
        let preserve_position = preserve
            && document
                .as_ref()
                .is_some_and(|document| snapshot.generation == document.plan.generation);
        let mut transport = CallbackTransport::new(rate, self.shared.clone());
        transport.midi = MidiOutPort::attached(self.midi.shared(), rate);
        let (audition_producer, audition_consumer): (AuditionProducer, AuditionConsumer) =
            audition_channel();
        transport.audition.attach(audition_consumer);
        if let (Some(renderer), Some(document)) = (renderer, &document) {
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
        }
        let (line_in_control, line_in_built) = self.line_in_prepare(&mut transport, rate);
        let actual_id = device.id().map_err(|e| e.to_string())?.to_string();
        // Cached for diagnostics. `Display` for a device can panic in a backend.
        let name = device_label(&device);
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
                idle: document.is_none(),
            }))
            .map_err(|_| "Audio device manager stopped.")?;
        answer
            .recv()
            .map_err(|_| "Audio device manager stopped.")??;
        // The stream that fed the ports is gone: whatever it left queued or sounding is dropped, and the new stream
        // states its position afresh once the sender says it has finished.
        self.midi.reset();
        if let Some(route) = route {
            self.midi.commit(route);
        }
        *self.shared.device.lock().unwrap() = Some(actual_id);
        *self.shared.stream_name.lock().unwrap() = name;
        if let Some(document) = &document {
            self.set_backing_duration(document);
        }
        *self.audition.lock().unwrap() = Some(AuditionSlot {
            producer: audition_producer,
            epoch,
            rate,
        });
        self.shared.audition_rate.store(rate, Ordering::Release);
        self.line_in_commit(line_in_control, rate, line_in_built);
        state.rate = rate;
        state.producer = Some(producer);
        if let Some(document) = document {
            state.document = Some(document);
        }
        Ok(())
    }
}
impl Drop for AudioService {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Release);
        let _ = self.manager.send(ManagerRequest::Shutdown);
    }
}
/// Stable refusal codes for the audio diagnostics commands. The interface maps
/// them to words (`audio.error.*` in `src/i18n`).
pub const AUDIO_ERROR_FAILED: &str = "audio_output_failed";
pub const AUDIO_ERROR_UNAVAILABLE: &str = "audio_output_unavailable";
pub const AUDIO_ERROR_TONE_PLAYBACK: &str = "audio_test_tone_playback";
const TONE_HZ: f64 = 440.0;
const TONE_AMPLITUDE: f32 = 0.08;
const TONE_SECONDS: f64 = 0.5;
const TONE_FADE_SECONDS: f64 = 0.02;
/// The 500 ms test tone at `rate`, with 20 ms linear fades at both ends.
fn tone_clip(rate: u32) -> AuditionClip {
    let total = (f64::from(rate) * TONE_SECONDS).round() as usize;
    let fade = (f64::from(rate) * TONE_FADE_SECONDS).round() as usize;
    let frames = (0..total)
        .map(|i| {
            let sine =
                (2.0 * std::f64::consts::PI * TONE_HZ * i as f64 / f64::from(rate)).sin() as f32;
            let mut gain = 1.0f32;
            if fade > 0 {
                if i < fade {
                    gain = i as f32 / fade as f32;
                } else if i + fade > total {
                    gain = (total - 1 - i) as f32 / fade as f32;
                }
            }
            let value = sine * TONE_AMPLITUDE * gain;
            [value, value]
        })
        .collect();
    AuditionClip {
        rate,
        frames,
        tone: true,
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
/// A device's display name. `Display` can panic inside a backend, so a panic reads as no name.
fn device_label(device: &cpal::Device) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| device.to_string())).ok()
}
/// Handles a backend notification for the stream of `epoch`. Allocation- and lock-free.
/// Rerouting and xruns do not mean playback has failed; a reroute only makes the cached
/// device name unreliable until the next open.
fn stream_notice(
    shared: &SharedStatus,
    midi: Option<&MidiOutShared>,
    epoch: u64,
    kind: cpal::ErrorKind,
) {
    if shared.epoch.load(Ordering::Acquire) != epoch {
        return;
    }
    match kind {
        cpal::ErrorKind::DeviceChanged => shared.mark_name_stale_for_epoch(epoch),
        cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied => {}
        _ => {
            shared.mark_fault_for_epoch(epoch);
            // The stream may never call back again to release its notes: the sender silences the ports.
            if let Some(midi) = midi {
                midi.request_reset();
            }
        }
    }
}
fn build_stream<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    mut callback: OutputCallback,
) -> Result<cpal::Stream, String> {
    let channels = config.channels() as usize;
    let shared = callback.transport.shared.clone();
    let midi = callback.transport.midi.shared().cloned();
    let epoch = callback.epoch;
    device
        .build_output_stream(
            config.clone().into(),
            move |data: &mut [T], _| callback.render(data, channels),
            move |error| {
                stream_notice(&shared, midi.as_deref(), epoch, error.kind());
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
                    idle,
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
                        if !idle {
                            shared.mark_fault_for_epoch(epoch);
                        }
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
            plugin_plans: Vec::new(),
        }
    }
    #[test]
    fn processing_mix_reuses_source_and_resources_and_queues_preserved_install() {
        let mut original = document();
        original.backing = Some(Arc::new(DecodedAudio {
            sample_rate: 48_000,
            channels: 2,
            frames: Arc::new(
                (0..192_000)
                    .map(|n| {
                        let x = (std::f64::consts::TAU * 440.0 * n as f64 / 48_000.0).sin() as f32
                            * 0.05;
                        [x, -x]
                    })
                    .collect(),
            ),
        }));
        original.practice.tempo = PracticeTempo::Relative { ratio: 0.5 };
        let mut transport = CallbackTransport::headless(48_000);
        transport.install_with_practice(
            AudioService::renderer(&original, 48_000).unwrap(),
            1,
            false,
            original.practice,
        );
        transport
            .command(TransportCommand::PlayRange {
                generation: 1,
                start_tick: 480.0,
                end_tick: Some(3360.0),
            })
            .unwrap();
        transport
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 480.0,
                end_tick: 3360.0,
            })
            .unwrap();
        transport.render_into(&mut [[0.0; 2]; 512]);
        let before = transport.status();
        let shared = Arc::new(SharedStatus::new());
        shared.desired.store(1, Ordering::Release);
        let (producer, mut commands) = HeapRb::new(CONTROL_CAPACITY).split();
        let (manager, _requests) = mpsc::channel();
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
            audition: Mutex::new(None),
            line_in: Mutex::new(LineInSlot::default()),
            line_in_issued: AtomicU64::new(0),
            midi: MidiOut::default(),
            manager,
        };
        let mut candidate = original.settings.clone();
        candidate.backing.as_mut().unwrap().processing = Some(crate::settings::BackingProcessing {
            semitones: 12.0,
            cents: 0.0,
            filter: crate::settings::BackingFilter::BassEnhance,
        });
        service.set_mix(candidate.clone(), 1).unwrap();
        let Some(CallbackCommand::Install {
            renderer,
            generation,
            preserve,
            practice,
        }) = commands.try_pop()
        else {
            panic!("processing must install a prepared renderer")
        };
        assert_eq!(generation, 1);
        assert!(preserve);
        transport.install_with_practice(renderer, generation, preserve, practice);
        let after = transport.status();
        assert_eq!(after.tick, before.tick);
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.practice, before.practice);
        assert_eq!(after.range, before.range);
        assert_eq!(after.r#loop, before.r#loop);
        let mut pcm = vec![[0.0; 2]; 48_000];
        transport.render_into(&mut pcm);
        let crossings: Vec<_> = pcm[4800..]
            .windows(2)
            .enumerate()
            .filter_map(|(i, w)| {
                (w[0][0] <= 0.0 && w[1][0] > 0.0)
                    .then(|| i as f64 - w[0][0] as f64 / (w[1][0] - w[0][0]) as f64)
            })
            .collect();
        let hz =
            (crossings.len() - 1) as f64 * 48_000.0 / (crossings.last().unwrap() - crossings[0]);
        assert!(
            (hz - 880.0).abs() <= 2.64,
            "installed processing frequency {hz}"
        );
        {
            let state = service.control.lock().unwrap();
            let next = state.document.as_ref().unwrap();
            assert!(Arc::ptr_eq(
                next.backing.as_ref().unwrap(),
                original.backing.as_ref().unwrap()
            ));
            assert!(Arc::ptr_eq(&next.resources, &original.resources));
            assert!(Arc::ptr_eq(&next.plan, &original.plan));
            assert_eq!(next.practice, original.practice);
        }
        candidate.backing.as_mut().unwrap().mix.gain = 0.25;
        service.set_mix(candidate.clone(), 1).unwrap();
        assert!(matches!(
            commands.try_pop(),
            Some(CallbackCommand::Mix { generation: 1, .. })
        ));
        candidate
            .backing
            .as_mut()
            .unwrap()
            .processing
            .as_mut()
            .unwrap()
            .cents = 0.5;
        assert!(service.set_mix(candidate, 1).is_err());
        assert!(commands.try_pop().is_none());
    }
    #[test]
    fn processed_device_rate_reconstruction_uses_frozen_settings() {
        let mut original = document();
        original.backing = Some(Arc::new(DecodedAudio {
            sample_rate: 48_000,
            channels: 2,
            frames: Arc::new(
                (0..192_000)
                    .map(|n| {
                        let x = (std::f64::consts::TAU * 440.0 * n as f64 / 48_000.0).sin() as f32
                            * 0.05;
                        [x, x]
                    })
                    .collect(),
            ),
        }));
        original.settings.backing.as_mut().unwrap().processing =
            Some(crate::settings::BackingProcessing {
                semitones: -12.0,
                cents: 0.0,
                filter: crate::settings::BackingFilter::HighAttenuation,
            });
        for rate in [44_100, 48_000] {
            let mut renderer = AudioService::renderer(&original, rate).unwrap();
            let mut pcm = vec![[0.0; 2]; rate as usize];
            renderer.render_into(&mut pcm);
            let crossings: Vec<_> = pcm[rate as usize / 4..]
                .windows(2)
                .enumerate()
                .filter_map(|(i, w)| {
                    (w[0][0] <= 0.0 && w[1][0] > 0.0)
                        .then(|| i as f64 - w[0][0] as f64 / (w[1][0] - w[0][0]) as f64)
                })
                .collect();
            let hz = (crossings.len() - 1) as f64 * rate as f64
                / (crossings.last().unwrap() - crossings[0]);
            assert!((hz - 220.0).abs() <= 1.0, "rate {rate}: {hz}");
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
    fn routing_a_track_to_a_port_reaches_a_playing_document_as_a_route_beside_the_mix() {
        use crate::{
            midi_out::{ListedPorts, MidiOut},
            settings::ChannelMix,
        };
        let original = document();
        let shared = Arc::new(SharedStatus::new());
        shared.desired.store(1, Ordering::Release);
        let (producer, mut commands) = HeapRb::new(CONTROL_CAPACITY).split();
        let (manager, _requests) = mpsc::channel();
        let ports = Arc::new(ListedPorts(Mutex::new(Vec::new())));
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
            audition: Mutex::new(None),
            line_in: Mutex::new(LineInSlot::default()),
            line_in_issued: AtomicU64::new(0),
            midi: MidiOut::with_backend(ports.clone()).with_retry_interval(Duration::ZERO),
            manager,
        };
        let route = |port: Option<&str>| {
            let mut settings = original.settings.clone();
            settings.mixes.insert(
                "gm".into(),
                ChannelMix {
                    midi_port: port.map(str::to_string),
                    ..Default::default()
                },
            );
            settings
        };
        let next_tap = |commands: &mut HeapCons<CallbackCommand>| {
            assert!(matches!(
                commands.try_pop(),
                Some(CallbackCommand::Mix { generation: 1, .. })
            ));
            match commands.try_pop() {
                Some(CallbackCommand::MidiRoute { tap, generation: 1 }) => Some(tap),
                None => None,
                _ => panic!("unexpected command"),
            }
        };
        // A port the system does not have: the mix goes through with the track routed to it, but nothing is sounded
        // there and the internal sound stays, and the status says why.
        service.set_mix(route(Some("Synth")), 1).unwrap();
        let tap = next_tap(&mut commands).expect("the track is routed to the port it asked for");
        assert!(tap.has_routes() && !tap.silences(0));
        service.midi_out().settle();
        let status = service.midi_out().status();
        assert!(!status.ports[0].open && status.ports[0].error.is_some());
        // A refresh while the port is still missing from the system changes nothing.
        service.midi_refresh();
        service.midi_out().settle();
        assert!(commands.try_pop().is_none());
        // The device appears; refreshing the list opens it, and the track moves over by itself: no new route is sent,
        // the audio thread follows the port's bit.
        lock_ports(&ports).push("Synth".into());
        service.midi_refresh();
        service.midi_out().settle();
        assert!(commands.try_pop().is_none());
        assert!(service.midi_out().status().ports[0].open);
        assert_eq!(
            service.midi_out().shared().faulted.load(Ordering::Acquire) & 1,
            0
        );
        service.midi_refresh();
        assert!(
            commands.try_pop().is_none(),
            "everything works: nothing to do"
        );
        // A mix change while routed carries the route, so levels and mute reach the port.
        let tap = {
            service.set_mix(route(Some("Synth")), 1).unwrap();
            next_tap(&mut commands).unwrap()
        };
        assert_eq!(tap.destination(0), Some((0, 0)));
        // Taking the routing away sends an empty route once, so the port is released, then only mixes.
        service.set_mix(route(None), 1).unwrap();
        assert!(!next_tap(&mut commands).unwrap().has_routes());
        service.set_mix(route(None), 1).unwrap();
        assert!(next_tap(&mut commands).is_none());
        assert!(commands.try_pop().is_none());
    }
    fn lock_ports(ports: &crate::midi_out::ListedPorts) -> std::sync::MutexGuard<'_, Vec<String>> {
        ports.0.lock().unwrap()
    }
    /// A document with one track on General MIDI that strikes a note at the start and never ends it, sent to "Synth".
    fn held_note_document() -> PreparedDocument {
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 7680, "durationMs": 4000,
            "tracks": [{"id": "gm", "program": 0, "percussion": false}],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [
                {"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},
                {"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":4000}
            ],
            "notes": [],
            "midi": [{"type":"noteOn","trackId":"gm","tick":0,"channel":0,"key":60,"velocity":90}]
        }))
        .unwrap();
        let mut settings = DocumentSettings::default();
        settings.mixes.insert(
            "gm".into(),
            ChannelMix {
                midi_port: Some("Synth".into()),
                ..Default::default()
            },
        );
        settings.sounds.insert(
            "gm".into(),
            crate::settings::TrackSound {
                voice_id: Some("gm".into()),
                ..Default::default()
            },
        );
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
            backing: None,
            practice: PracticeSettings::default(),
            plugin_plans: Vec::new(),
        }
    }
    fn settled(log: &Arc<Mutex<Vec<Vec<u8>>>>, mut done: impl FnMut(&[Vec<u8>]) -> bool) -> bool {
        let until = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < until {
            if done(&log.lock().unwrap()) {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        false
    }
    /// A service whose "Synth" port records what it is sent, with the document above playing on a transport the
    /// caller drives, and the note sounding on the port.
    fn sounding_service() -> (
        AudioService,
        CallbackTransport,
        Arc<Mutex<Vec<Vec<u8>>>>,
        PreparedDocument,
    ) {
        use crate::midi_out::{RecordingPorts, sounding};
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        service.midi = MidiOut::with_backend(Arc::new(RecordingPorts {
            names: vec!["Synth".into()],
            log: log.clone(),
        }));
        let document = held_note_document();
        service.shared.desired.store(1, Ordering::Release);
        service
            .midi
            .ensure_ports(&MidiOut::port_names(&document.settings), Ensure::Prepare);
        service.midi.settle();
        let (renderer, route) = service.routed_renderer(&document, 48_000).unwrap();
        service.midi.commit(route);
        let mut transport = CallbackTransport::new(48_000, service.shared.clone());
        transport.midi = MidiOutPort::attached(service.midi.shared(), 48_000);
        transport.install_with_practice(renderer, 1, false, document.practice);
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        for _ in 0..4 {
            transport.render_callback(&mut [[0.0; 2]; 480]);
        }
        service.midi.wake();
        assert!(
            settled(&log, |log| sounding(log) == vec![(0, 60)]),
            "the note sounds on the port"
        );
        (service, transport, log, document)
    }
    #[test]
    fn a_failed_device_switch_leaves_nothing_sounding_on_a_port() {
        use crate::midi_out::sounding;
        let (service, transport, log, document) = sounding_service();
        let (producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired, retirement_queue) = HeapRb::new(CONTROL_CAPACITY).split();
        {
            let mut state = service.control.lock().unwrap();
            state.producer = Some(producer);
            state.document = Some(document);
        }
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
            let until = std::time::Instant::now() + Duration::from_secs(3);
            let mut output = [0.0f32; BLOCK * 2];
            while !callback.suspended {
                callback.render(&mut output, 2);
                assert!(std::time::Instant::now() < until);
                thread::sleep(Duration::from_millis(1));
            }
        });
        // The old callback is frozen for the switch, and the new device will not open.
        let result = service.command(TransportCommand::SelectDevice {
            generation: 1,
            device_id: Some("no-such-device".into()),
        });
        assert!(result.is_err(), "{result:?}");
        worker.join().unwrap();
        assert!(
            settled(&log, |log| sounding(log).is_empty()),
            "still sounding: {:?}",
            sounding(&log.lock().unwrap())
        );
        service.midi.shutdown();
    }
    #[test]
    fn a_stream_error_leaves_nothing_sounding_on_a_port_but_an_xrun_does_not() {
        use crate::midi_out::sounding;
        let (service, _transport, log, _document) = sounding_service();
        let epoch = service.shared.epoch.load(Ordering::Acquire);
        let midi = service.midi.shared();
        // A glitch is not a failure.
        stream_notice(&service.shared, Some(&midi), epoch, cpal::ErrorKind::Xrun);
        thread::sleep(Duration::from_millis(150));
        assert_eq!(sounding(&log.lock().unwrap()), vec![(0, 60)]);
        // The device going away is: nothing will call back to release the note, so the sender does.
        stream_notice(
            &service.shared,
            Some(&midi),
            epoch,
            cpal::ErrorKind::DeviceNotAvailable,
        );
        assert!(
            settled(&log, |log| sounding(log).is_empty()),
            "still sounding: {:?}",
            sounding(&log.lock().unwrap())
        );
        service.midi.shutdown();
    }
    fn bare_service(
        document: &PreparedDocument,
        backend: Arc<dyn crate::midi_out::MidiBackend>,
    ) -> (AudioService, HeapCons<CallbackCommand>) {
        let shared = Arc::new(SharedStatus::new());
        shared.desired.store(1, Ordering::Release);
        let (producer, commands) = HeapRb::new(CONTROL_CAPACITY).split();
        let (manager, _requests) = mpsc::channel();
        let service = AudioService {
            root: PathBuf::new(),
            shared,
            control: Mutex::new(ControlState {
                producer: Some(producer),
                document: Some(document.clone()),
                rate: 48_000,
                device: None,
                next_barrier: 0,
            }),
            audition: Mutex::new(None),
            line_in: Mutex::new(LineInSlot::default()),
            line_in_issued: AtomicU64::new(0),
            midi: MidiOut::with_backend(backend),
            manager,
        };
        (service, commands)
    }
    #[test]
    fn a_device_switch_whose_barrier_times_out_still_silences_the_ports() {
        let original = held_note_document();
        let (service, _commands) = bare_service(
            &original,
            Arc::new(crate::midi_out::ListedPorts(Mutex::new(Vec::new()))),
        );
        let before = service
            .midi_out()
            .shared()
            .reset_requested
            .load(Ordering::Acquire);
        // Nobody answers the barrier: the old callback is not to be trusted to release anything.
        let result = service.command(TransportCommand::SelectDevice {
            generation: 1,
            device_id: None,
        });
        assert!(result.is_err(), "{result:?}");
        assert!(
            service
                .midi_out()
                .shared()
                .reset_requested
                .load(Ordering::Acquire)
                > before
        );
    }
    #[test]
    fn a_mix_routed_to_a_port_that_will_not_open_is_applied_at_once_with_the_track_routed() {
        let original = held_note_document();
        let (service, mut commands) =
            bare_service(&original, Arc::new(crate::midi_out::HangingPorts));
        let mut settings = original.settings.clone();
        settings.mixes.get_mut("gm").unwrap().midi_port = Some("Hang".into());
        let started = std::time::Instant::now();
        service.set_mix(settings, 1).unwrap();
        // Nothing waited for the port, and nothing needs to be prepared again when it opens.
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "{:?}",
            started.elapsed()
        );
        assert!(matches!(
            commands.try_pop(),
            Some(CallbackCommand::Mix { .. })
        ));
        match commands.try_pop() {
            Some(CallbackCommand::MidiRoute { tap, .. }) => {
                assert!(tap.has_routes());
                assert!(!tap.silences(0), "internal sound until the port is there");
            }
            _ => panic!("the track should be routed"),
        }
        service.midi_out().shutdown();
    }
    #[test]
    fn a_route_that_could_not_be_queued_is_not_remembered() {
        use crate::midi_out::ListedPorts;
        let original = held_note_document();
        let shared = Arc::new(SharedStatus::new());
        shared.desired.store(1, Ordering::Release);
        // A control queue with room for the mix and nothing else.
        let (producer, mut commands) = HeapRb::new(1).split();
        let (manager, _requests) = mpsc::channel();
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
            audition: Mutex::new(None),
            line_in: Mutex::new(LineInSlot::default()),
            line_in_issued: AtomicU64::new(0),
            midi: MidiOut::with_backend(Arc::new(ListedPorts(Mutex::new(vec!["Synth".into()])))),
            manager,
        };
        let mut settings = original.settings.clone();
        settings.mixes.get_mut("gm").unwrap().gain = 0.5;
        let error = service.set_mix(settings, 1).unwrap_err();
        assert!(error.contains("queue is full"), "{error}");
        // It was the route that did not fit: the mix went in.
        assert!(matches!(
            commands.try_pop(),
            Some(CallbackCommand::Mix { .. })
        ));
        assert!(!service.midi_out().routed());
        assert!(service.midi_out().status().ports.is_empty());
        assert_eq!(
            service
                .control
                .lock()
                .unwrap()
                .document
                .as_ref()
                .unwrap()
                .settings,
            original.settings,
            "and the mix is not taken as applied either"
        );
        service.midi_out().shutdown();
    }
    #[test]
    fn a_drum_kit_edit_reaches_a_playing_document_as_a_mix_and_never_rebuilds_it() {
        use crate::settings::{ChannelMix, DrumElementMix, DrumKitMix};
        let mut original = document();
        let mut plan = (*original.plan).clone();
        plan.tracks[0].percussion = true;
        original.plan = Arc::new(plan);
        let shared = Arc::new(SharedStatus::new());
        shared.desired.store(1, Ordering::Release);
        let (producer, mut commands) = HeapRb::new(CONTROL_CAPACITY).split();
        let (manager, _requests) = mpsc::channel();
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
            audition: Mutex::new(None),
            line_in: Mutex::new(LineInSlot::default()),
            line_in_issued: AtomicU64::new(0),
            midi: MidiOut::default(),
            manager,
        };
        // Giving the track its first kit, changing it, and taking it away again: each is a mix, never an install, which
        // would cut every ringing note and strike the held ones again.
        let kit = |gain: f32| ChannelMix {
            drum_kit: Some(DrumKitMix {
                cymbals: Some(DrumElementMix {
                    gain,
                    pan: 0.0,
                    mute: false,
                    solo: false,
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        for mix in [Some(kit(0.5)), Some(kit(0.25)), None] {
            let mut settings = original.settings.clone();
            if let Some(mix) = mix {
                settings.mixes.insert("gm".into(), mix);
            }
            service.set_mix(settings.clone(), 1).unwrap();
            assert!(
                matches!(
                    commands.try_pop(),
                    Some(CallbackCommand::Mix { generation: 1, .. })
                ),
                "a kit edit is a mix change"
            );
            assert!(commands.try_pop().is_none());
            let state = service.control.lock().unwrap();
            let next = state.document.as_ref().unwrap();
            assert_eq!(next.settings, settings);
            assert!(Arc::ptr_eq(&next.plan, &original.plan));
            assert!(Arc::ptr_eq(&next.resources, &original.resources));
        }
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
            audition: Mutex::new(None),
            line_in: Mutex::new(LineInSlot::default()),
            line_in_issued: AtomicU64::new(0),
            midi: MidiOut::default(),
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

/// Whether the sound sources a prepared plan needs differ between two settings: a track's instrument, or its lock
/// against sound automations, which decides which program each note sounds as. Either needs a rebuilt renderer and the
/// samples the new settings ask for, not a mix change, so a locked-era bank is never kept for an unlocked track.
fn sound_source_changed(
    plan: &PlaybackPlan,
    old: &DocumentSettings,
    new: &DocumentSettings,
) -> bool {
    plan.tracks.iter().any(|track| {
        voice_id_for_track(track, new) != voice_id_for_track(track, old)
            || track_locked(new, &track.id) != track_locked(old, &track.id)
            || drum_kit_for_track(track, new) != drum_kit_for_track(track, old)
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_change_of_drum_kit_needs_a_rebuilt_renderer_but_only_on_a_drum_track() {
        use crate::settings::TrackSound;
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"d","program":0,"percussion":true},{"id":"g","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap();
        let with = |track: &str, kit| {
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                track.into(),
                TrackSound {
                    drum_kit: kit,
                    ..TrackSound::default()
                },
            );
            settings
        };
        let none = DocumentSettings::default();
        assert!(sound_source_changed(&plan, &none, &with("d", Some(32))));
        assert!(sound_source_changed(&plan, &with("d", Some(32)), &none));
        assert!(sound_source_changed(
            &plan,
            &with("d", Some(8)),
            &with("d", Some(40))
        ));
        assert!(!sound_source_changed(&plan, &none, &with("g", Some(32))));
    }

    #[test]
    fn a_change_of_lock_needs_a_rebuilt_renderer_and_new_samples_but_a_mix_change_does_not() {
        use crate::settings::TrackSound;
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"a","program":25,"percussion":false},{"id":"b","program":33,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap();
        let sound = |locked| TrackSound {
            locked,
            ..TrackSound::default()
        };
        let with = |track: &str, locked| {
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(track.into(), sound(locked));
            settings
        };
        let none = DocumentSettings::default();
        // Locking and unlocking either track, as a toggle and as its undo, each need a rebuild.
        for track in ["a", "b"] {
            assert!(sound_source_changed(&plan, &none, &with(track, true)));
            assert!(sound_source_changed(&plan, &with(track, true), &none));
            assert!(sound_source_changed(
                &plan,
                &with(track, true),
                &with(track, false)
            ));
        }
        // A lock on a track the plan does not have changes nothing the player sounds.
        assert!(!sound_source_changed(
            &plan,
            &none,
            &with("elsewhere", true)
        ));
        // Nothing but the lock-free settings changed: the cheap mix path stands.
        assert!(!sound_source_changed(
            &plan,
            &with("a", true),
            &with("a", true)
        ));
        assert!(!sound_source_changed(&plan, &none, &with("a", false)));
        let mut louder = with("a", true);
        louder.mixes.insert(
            "a".into(),
            crate::settings::ChannelMix {
                gain: 0.5,
                ..Default::default()
            },
        );
        assert!(!sound_source_changed(&plan, &with("a", true), &louder));
    }

    use super::*;
    fn practice(speed: f64, enabled: bool) -> PracticeSettings {
        PracticeSettings {
            tempo: super::super::practice::PracticeTempo::Relative { ratio: speed },
            metronome: super::super::practice::MetronomeSettings {
                enabled,
                volume: 0.4,
                visual: false,
                sound: Default::default(),
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
    fn a_pause_leaves_no_board_sounding() {
        // Re-review R2-1: the device renders nothing while paused, so a resume is a play start. A plug-in added during
        // a pause must start on `D` behind silence, as after a stop; that needs every board to stop counting as
        // sounding when the device pauses, the live mix's and one installed during the pause alike.
        let document = counted_document();
        let mut transport = CallbackTransport::headless(48_000);
        // No count-in: the boards render from the first frame.
        transport.install(AudioService::renderer(&document, 48_000).unwrap(), 1, false);
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        for _ in 0..20 {
            transport.render_callback(&mut [[0.0; 2]; 480]);
        }
        let sounding = |t: &CallbackTransport| t.renderer.as_ref().unwrap().channels_sounding();
        assert!(
            sounding(&transport).iter().all(|s| *s),
            "playing boards sound"
        );
        transport
            .command(TransportCommand::Pause { generation: 1 })
            .unwrap();
        assert!(
            sounding(&transport).iter().all(|s| !*s),
            "a pause silences every board"
        );
        let mix = PreparedMix::prepare(&document.settings, &document.plan, 48_000).unwrap();
        drop(transport.replace_mix(mix, 1));
        assert!(
            sounding(&transport).iter().all(|s| !*s),
            "a mix installed during the pause is not sounding"
        );
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        transport.render_callback(&mut [[0.0; 2]; 480]);
        assert!(
            sounding(&transport).iter().all(|s| *s),
            "a resume sounds again"
        );
    }

    #[test]
    fn output_callback_records_the_largest_callback_for_plugin_pipelines() {
        let transport = CallbackTransport::headless(48_000);
        let shared = transport.shared.clone();
        let (_producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired, _retirement_queue) = HeapRb::new(CONTROL_CAPACITY).split();
        let mut callback = OutputCallback {
            transport,
            controls,
            retired,
            scratch: [[0.0; 2]; BLOCK],
            epoch: 0,
            suspended: false,
        };
        // A shared-mode stream's first callback can be twice its period (preflight ruling P32).
        for frames in [1056usize, 480, 480] {
            callback.render(&mut vec![0.0f32; frames * 2], 2);
        }
        assert_eq!(shared.max_callback_frames.load(Ordering::Relaxed), 1056);
        assert_eq!(shared.buffer_size.load(Ordering::Relaxed), 480);
    }

    #[test]
    fn output_callback_parks_a_mix_during_a_crossfade_and_retires_every_one_off_thread() {
        let service = unavailable_device_with_practice();
        let document = service.control.lock().unwrap().document.clone().unwrap();
        let mut transport = CallbackTransport::headless(48_000);
        transport.install_with_practice(
            AudioService::renderer(&document, 48_000).unwrap(),
            1,
            false,
            document.practice,
        );
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let (mut controls_in, controls) = HeapRb::<CallbackCommand>::new(CONTROL_CAPACITY).split();
        let (retired_in, mut retired_out) = HeapRb::<Retired>::new(CONTROL_CAPACITY).split();
        let mut callback = OutputCallback {
            transport,
            controls,
            retired: retired_in,
            scratch: [[0.0; 2]; BLOCK],
            epoch: 0,
            suspended: false,
        };
        let mut retired = |callback: &mut OutputCallback, frames: usize| {
            callback.render(&mut vec![0.0f32; frames * 2], 2);
            let mut count = 0;
            while let Some(item) = retired_out.try_pop() {
                assert!(matches!(item, Retired::Mix(_)));
                count += 1;
            }
            count
        };
        let mut send = |mix| {
            assert!(
                controls_in
                    .try_push(CallbackCommand::Mix { mix, generation: 1 })
                    .is_ok()
            );
        };
        let mix = || PreparedMix::prepare(&document.settings, &document.plan, 48_000).unwrap();
        send(mix());
        assert_eq!(retired(&mut callback, 64), 1, "taken at once");
        send(mix());
        assert_eq!(retired(&mut callback, 64), 0, "waits for the crossfade");
        send(mix());
        assert_eq!(retired(&mut callback, 64), 1, "the one waiting gives way");
        // Blocks run one after another inside a callback, and the mix goes in between them.
        assert_eq!(
            retired(&mut callback, BLOCK * 2),
            1,
            "installed when it ends"
        );
        assert_eq!(retired(&mut callback, BLOCK * 2), 0, "nothing is left");
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
    fn shared_practice_carries_every_metronome_sound() {
        use super::super::practice::ClickSound;
        let shared = SharedPractice::new();
        assert_eq!(shared.read().metronome.sound, ClickSound::Beep);
        for sound in [
            ClickSound::Woodblock,
            ClickSound::Cowbell,
            ClickSound::Stick,
            ClickSound::Beep,
        ] {
            let mut settings = practice(0.75, true);
            settings.metronome.sound = sound;
            shared.store(settings);
            assert_eq!(shared.read(), settings);
        }
    }
    #[test]
    fn count_in_clicks_use_the_chosen_sound() {
        use super::super::practice::{ClickSound, ClickVoice};
        let mut rendered = Vec::new();
        for sound in [ClickSound::Beep, ClickSound::Cowbell] {
            let mut document = counted_document();
            document.practice.metronome.sound = sound;
            let mut transport = CallbackTransport::headless(48_000);
            transport.install_with_practice(
                AudioService::renderer(&document, 48_000).unwrap(),
                1,
                false,
                document.practice,
            );
            transport
                .command(TransportCommand::Play { generation: 1 })
                .unwrap();
            let mut output = [[0.0; 2]; 400];
            transport.render_into(&mut output);
            assert_eq!(transport.phase, PracticePhase::CountIn);
            // The count-in starts on a downbeat, so its first click is the voice's accented shape at the practice level.
            let mut voice = ClickVoice::new(48_000);
            voice.trigger(true, sound);
            for frame in output {
                let expected = voice.frame(document.practice.metronome.volume);
                assert_eq!(frame, [expected, expected], "{sound:?}");
            }
            rendered.push(output);
        }
        assert_ne!(rendered[0], rendered[1]);
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

#[cfg(test)]
mod diagnostics_and_test_tone_tests {
    use super::*;

    fn service_with_stream(rate: u32) -> (AudioService, AuditionConsumer) {
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        let consumer = service.attach_test_audition(rate);
        (service, consumer)
    }

    #[test]
    fn test_tone_refused_during_playback_with_a_stable_code() {
        let (service, _consumer) = service_with_stream(48_000);
        service.shared.playing.store(true, Ordering::Release);
        assert_eq!(service.test_tone().unwrap_err(), AUDIO_ERROR_TONE_PLAYBACK);
    }

    #[test]
    fn a_fault_is_reported_before_playback() {
        let (service, _consumer) = service_with_stream(48_000);
        service.shared.playing.store(true, Ordering::Release);
        service.shared.mark_fault();
        assert_eq!(service.test_tone().unwrap_err(), AUDIO_ERROR_FAILED);
    }

    #[test]
    fn test_tone_refused_when_no_stream() {
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        assert_eq!(service.test_tone().unwrap_err(), AUDIO_ERROR_UNAVAILABLE);
    }

    #[test]
    fn test_tone_is_an_audible_440_hz_clip_at_the_stream_rate() {
        let (service, mut consumer) = service_with_stream(48_000);
        service.test_tone().expect("test tone should succeed");
        let clip = consumer.try_pop().expect("audition consumer received clip");
        assert!(clip.tone, "marked so playback can cut it");
        assert_eq!(clip.rate, 48_000);
        assert_eq!(clip.frames.len(), 24_000);
        let peak = clip.frames.iter().fold(0.0f32, |p, f| p.max(f[0].abs()));
        assert!(peak > 0.075 && peak <= 0.0801, "audible but quiet: {peak}");
        assert!(clip.frames.iter().all(|f| f[0] == f[1]));
        // Fades: starts and ends silent.
        assert_eq!(clip.frames[0][0], 0.0);
        assert!(clip.frames[23_999][0].abs() < 1e-3);
        // 440 Hz: count rising zero crossings across 0.1 s..0.4 s (0.3 s = 132 cycles).
        let window = &clip.frames[4_800..19_200];
        let rising = window
            .windows(2)
            .filter(|w| w[0][0] < 0.0 && w[1][0] >= 0.0)
            .count();
        assert!((131..=133).contains(&rising), "rising crossings: {rising}");
    }

    #[test]
    fn diagnostics_read_unknown_with_no_stream_whatever_the_hardware() {
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        let diagnostics = service.diagnostics().expect("no stream is not an error");
        assert_eq!(
            diagnostics,
            AudioDiagnostics {
                device_name: None,
                sample_rate: None,
                buffer_size: None
            }
        );
    }

    #[test]
    fn diagnostics_report_the_cached_stream_values() {
        let (service, _consumer) = service_with_stream(44_100);
        *service.shared.stream_name.lock().unwrap() = Some("Studio speakers".into());
        service.shared.buffer_size.store(256, Ordering::Relaxed);
        let diagnostics = service.diagnostics().unwrap();
        assert_eq!(diagnostics.device_name.as_deref(), Some("Studio speakers"));
        assert_eq!(diagnostics.sample_rate, Some(44_100));
        assert_eq!(diagnostics.buffer_size, Some(256));
    }

    #[test]
    fn diagnostics_report_a_fault_with_a_stable_code() {
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        service.shared.mark_fault();
        assert_eq!(service.diagnostics().unwrap_err(), AUDIO_ERROR_FAILED);
    }

    #[test]
    fn a_reroute_of_the_live_stream_makes_the_name_unknown_until_the_next_open() {
        let (service, _consumer) = service_with_stream(48_000);
        *service.shared.stream_name.lock().unwrap() = Some("Speakers".into());
        let epoch = service.shared.epoch.load(Ordering::Acquire);
        let name = |s: &AudioService| s.diagnostics().unwrap().device_name;
        stream_notice(&service.shared, None, epoch, cpal::ErrorKind::Xrun);
        assert_eq!(name(&service).as_deref(), Some("Speakers"));
        // A retired stream's notice changes nothing.
        stream_notice(
            &service.shared,
            None,
            epoch + 1,
            cpal::ErrorKind::DeviceChanged,
        );
        assert_eq!(name(&service).as_deref(), Some("Speakers"));
        stream_notice(&service.shared, None, epoch, cpal::ErrorKind::DeviceChanged);
        let diagnostics = service.diagnostics().expect("a reroute is not a fault");
        assert_eq!(diagnostics.device_name, None);
        assert_eq!(diagnostics.sample_rate, Some(48_000));
        // The next open bumps the epoch, which retires the mark with no reset.
        service.shared.next_epoch_snapshot();
        assert_eq!(name(&service).as_deref(), Some("Speakers"));
        // A notice from the old stream racing that open cannot mark the new one.
        stream_notice(&service.shared, None, epoch, cpal::ErrorKind::DeviceChanged);
        assert_eq!(name(&service).as_deref(), Some("Speakers"));
    }

    #[test]
    fn other_backend_errors_still_fault_the_live_stream() {
        let shared = SharedStatus::new();
        let epoch = shared.epoch.load(Ordering::Acquire);
        stream_notice(&shared, None, epoch, cpal::ErrorKind::RealtimeDenied);
        assert!(!shared.is_faulted());
        stream_notice(&shared, None, epoch, cpal::ErrorKind::DeviceNotAvailable);
        assert!(shared.is_faulted());
    }

    fn callback_for(shared: &Arc<SharedStatus>, epoch: u64) -> OutputCallback {
        let transport = CallbackTransport::new(48_000, shared.clone());
        let (_controls_in, controls) = HeapRb::<CallbackCommand>::new(CONTROL_CAPACITY).split();
        let (retired_in, _retired_out) = HeapRb::<Retired>::new(CONTROL_CAPACITY).split();
        OutputCallback {
            transport,
            controls,
            retired: retired_in,
            scratch: [[0.0; 2]; BLOCK],
            epoch,
            suspended: false,
        }
    }

    #[test]
    fn only_the_live_callback_reports_its_buffer_size() {
        let shared = Arc::new(SharedStatus::new());
        let live = shared.epoch.load(Ordering::Acquire);
        let mut retired = callback_for(&shared, live);
        shared.next_epoch_snapshot();
        let mut out = vec![0.0f32; 128 * 2];
        retired.render(&mut out, 2);
        assert_eq!(
            shared.buffer_size.load(Ordering::Relaxed),
            0,
            "a retired callback must not write the replacement's field"
        );
        let mut replacement = callback_for(&shared, live + 1);
        replacement.render(&mut out, 2);
        assert_eq!(shared.buffer_size.load(Ordering::Relaxed), 128);
    }

    fn clip(value: f32, tone: bool) -> Box<AuditionClip> {
        Box::new(AuditionClip {
            rate: 48_000,
            frames: vec![[value; 2]; 9_600],
            tone,
        })
    }

    #[test]
    fn playback_cuts_a_sounding_tone_but_not_a_note_audition() {
        for (tone, survives) in [(true, false), (false, true)] {
            let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
            let mut output = [[0.0; 2]; 512];
            assert!(producer.try_push(clip(0.5, tone)).is_ok());
            transport.render_into(&mut output);
            assert_eq!(output[511], [0.5, 0.5], "sounds while stopped");
            // Playback starts (count-in counts): the next block fades the tone out.
            transport.playing = true;
            transport.render_into(&mut output);
            if survives {
                assert_eq!(output[511], [0.5, 0.5], "a note audition rides on top");
            } else {
                assert_eq!(output[300], [0.0, 0.0], "the tone is gone after 5 ms");
                assert!(output[0][0] > 0.4, "fades rather than clicks");
            }
        }
    }

    #[test]
    fn a_tone_queued_during_playback_never_sounds() {
        let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
        transport.playing = true;
        assert!(producer.try_push(clip(0.5, true)).is_ok());
        let mut output = [[0.0; 2]; 512];
        transport.render_into(&mut output);
        assert!(output.iter().all(|f| *f == [0.0, 0.0]));
        assert_eq!(transport.status().audition_serial, 0);
    }
}

#[cfg(test)]
mod audition_callback_tests {
    use super::*;

    #[test]
    fn submit_refuses_clips_the_live_stream_could_not_sound() {
        let service = AudioService::new(PathBuf::new(), Arc::new(|_| {}));
        let clip = |rate| {
            Box::new(AuditionClip {
                rate,
                frames: vec![[0.1; 2]; 8],
                tone: false,
            })
        };
        assert!(!service.submit_audition(clip(48_000)), "no stream yet");
        let mut consumer = service.attach_test_audition(48_000);
        assert!(!service.submit_audition(clip(44_100)), "wrong rate");
        assert!(service.submit_audition(clip(48_000)));
        assert!(consumer.try_pop().is_some());
        service.shared.mark_fault();
        assert!(!service.submit_audition(clip(48_000)), "faulted device");
        let _consumer = service.attach_test_audition(48_000);
        service.shared.fault.store(0, Ordering::Release);
        assert!(service.submit_audition(clip(48_000)));
        // A newer stream epoch retires the old producer.
        service.shared.next_epoch_snapshot();
        assert!(!service.submit_audition(clip(48_000)), "replaced stream");
    }

    #[test]
    fn output_callback_adds_a_clip_while_stopped_and_retires_it_off_thread() {
        let shared = Arc::new(SharedStatus::new());
        let mut transport = CallbackTransport::new(48_000, shared.clone());
        let (mut producer, consumer) = audition_channel();
        transport.audition.attach(consumer);
        let (_controls_in, controls) = HeapRb::<CallbackCommand>::new(CONTROL_CAPACITY).split();
        let (retired_in, mut retired_out) = HeapRb::<Retired>::new(CONTROL_CAPACITY).split();
        let mut callback = OutputCallback {
            transport,
            controls,
            retired: retired_in,
            scratch: [[0.0; 2]; BLOCK],
            epoch: shared.epoch.load(Ordering::Acquire),
            suspended: false,
        };
        let clip = Box::new(AuditionClip {
            rate: 48_000,
            frames: vec![[0.5, -0.25]; 600],
            tone: false,
        });
        assert!(producer.try_push(clip).is_ok());
        let mut stereo = vec![0.0f32; 1024 * 2];
        callback.render(&mut stereo, 2);
        assert_eq!(&stereo[..2], &[0.5, -0.25]);
        assert_eq!(&stereo[599 * 2..599 * 2 + 2], &[0.5, -0.25]);
        assert_eq!(&stereo[600 * 2..600 * 2 + 2], &[0.0, 0.0]);
        // Mono output downmixes the clip like normal playback.
        assert!(
            producer
                .try_push(Box::new(AuditionClip {
                    rate: 48_000,
                    frames: vec![[0.5, -0.25]; 8],
                    tone: false,
                }))
                .is_ok()
        );
        let mut mono = vec![0.0f32; 16];
        callback.render(&mut mono, 1);
        assert_eq!(mono[0], 0.125);
        let status = shared.snapshot().0;
        assert_eq!(status.audition_serial, 2);
        assert_eq!(status.audition_peak, 0.5);
        assert!(!status.playing);
        assert_eq!(status.rendered_frames, 0);
        let mut retired = 0;
        while let Some(item) = retired_out.try_pop() {
            assert!(matches!(item, Retired::Clip(_)));
            retired += 1;
        }
        assert_eq!(retired, 2);
    }
}

impl LineInOutput for AudioService {
    fn prepare_output(&self) -> Result<u32, String> {
        self.line_in_output()
    }
    fn attach(&self, ring: Arc<MonitorRing>, meter: Arc<LineInMeter>) -> Result<(), String> {
        self.line_in_attach(ring, meter)
    }
    fn detach(&self) {
        self.line_in_detach();
    }
    fn output_rate(&self) -> Option<u32> {
        let rate = self.shared.audition_rate.load(Ordering::Acquire);
        (rate != 0).then_some(rate)
    }
    fn buffer_frames(&self) -> Option<u32> {
        let frames = self.shared.buffer_size.load(Ordering::Relaxed);
        (frames != 0).then_some(frames)
    }
    fn resync(&self) {
        self.line_in_resync();
    }
}

#[cfg(test)]
mod line_in_service_tests {
    use super::*;
    use crate::audio::line_in::monitor_channel;
    use crate::audio_input::SampleSink;

    fn service() -> AudioService {
        AudioService::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            Arc::new(|_| {}),
        )
    }

    /// Opens a pretend stream at `rate`: a headless transport takes the Line-In the way
    /// `open_current` gives it to a real one.
    fn open(service: &AudioService, rate: u32) -> CallbackTransport {
        let mut transport = CallbackTransport::headless(rate);
        let (control, built) = service.line_in_prepare(&mut transport, rate);
        service.line_in_commit(control, rate, built);
        transport
    }

    fn tone(freq: f64, rate: f64, start: usize, count: usize) -> Vec<f32> {
        (start..start + count)
            .map(|n| (0.5 * (std::f64::consts::TAU * freq * n as f64 / rate).sin()) as f32)
            .collect()
    }

    /// Runs the transport for `seconds` while a producer feeds a 330 Hz tone in real-time
    /// order, returning the left channel.
    fn run(
        transport: &mut CallbackTransport,
        producer: &mut crate::audio::line_in::LineInProducer,
        written: &mut usize,
        in_rate: f64,
        out_rate: f64,
        seconds: f64,
    ) -> Vec<f32> {
        let blocks = (seconds * out_rate / 480.0) as usize;
        let mut out = Vec::new();
        let mut block = [[0.0f32; 2]; 480];
        for n in 0..blocks {
            let due = *written + (480.0 / out_rate * in_rate) as usize;
            let _ = n;
            let count = due - *written;
            producer.push_samples(&tone(330.0, in_rate, *written, count));
            producer.end_block(count);
            *written = due;
            transport.render_into(&mut block);
            transport.retire_line_in(|item| {
                drop(item);
                None
            });
            out.extend(block.iter().map(|f| f[0]));
        }
        out
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0, |p, x| p.max(x.abs()))
    }

    #[test]
    fn settings_are_validated_stored_and_harmless_to_repeat() {
        let service = service();
        assert_eq!(service.line_in_settings(), LineInSettings::default());
        let mut louder = LineInSettings::default();
        louder.level = 0.5;
        service.line_in_set(louder.clone()).unwrap();
        service.line_in_set(louder.clone()).unwrap();
        assert_eq!(service.line_in_settings(), louder);
        let mut bad = louder.clone();
        bad.level = 1.5;
        assert!(service.line_in_set(bad).is_err());
        let mut bad = louder.clone();
        bad.sound.preset_id = "nonsense".into();
        assert!(service.line_in_set(bad).is_err());
        assert_eq!(service.line_in_settings(), louder);
    }

    #[test]
    fn changes_reach_the_stream_once_and_a_repeat_sends_nothing() {
        let service = service();
        let mut transport = open(&service, 48_000);
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter).unwrap();
        let pending = |service: &AudioService| {
            service
                .line_in
                .lock()
                .unwrap()
                .control
                .as_ref()
                .unwrap()
                .pending()
        };
        assert_eq!(pending(&service), 1, "the attach");
        let mut written = 0;
        run(
            &mut transport,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.2,
        );
        assert_eq!(pending(&service), 0);
        let mut settings = LineInSettings::default();
        settings.sound.effects.reverb.enabled = true;
        service.line_in_set(settings.clone()).unwrap();
        assert_eq!(pending(&service), 1, "one new chain");
        service.line_in_set(settings.clone()).unwrap();
        assert_eq!(pending(&service), 1, "setting it again sends nothing");
        settings.level = 0.4;
        service.line_in_set(settings.clone()).unwrap();
        assert_eq!(pending(&service), 2, "a level change is its own message");
        run(
            &mut transport,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.2,
        );
        assert_eq!(pending(&service), 0);
    }

    #[test]
    fn a_rebuilt_stream_keeps_the_sound_level_and_capture() {
        let service = service();
        let mut first = open(&service, 48_000);
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter).unwrap();
        let mut settings = LineInSettings::default();
        settings.level = 0.4;
        service.line_in_set(settings.clone()).unwrap();
        let mut written = 0;
        let before = run(
            &mut first,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            1.0,
        );
        assert!((peak(&before[before.len() / 2..]) - 0.5 * 0.4).abs() < 0.01);
        // The output device changes: a stream at another rate opens, and the old one is gone.
        drop(first);
        let mut second = open(&service, 44_100);
        assert!(second.line_in_active(), "rebuilt with the stream");
        let after = run(
            &mut second,
            &mut producer,
            &mut written,
            48_000.0,
            44_100.0,
            1.5,
        );
        let tail = &after[after.len() / 2..];
        assert!(
            (peak(tail) - 0.5 * 0.4).abs() < 0.01,
            "level kept: {}",
            peak(tail)
        );
        // The tone is still 330 Hz at the new rate.
        let crossings = tail
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        let measured = crossings as f64 / (tail.len() as f64 / 44_100.0);
        assert!((measured - 330.0).abs() < 2.0, "{measured}");
        // And changes now reach the new stream.
        settings.monitor = false;
        service.line_in_set(settings).unwrap();
        let muted = run(
            &mut second,
            &mut producer,
            &mut written,
            48_000.0,
            44_100.0,
            0.3,
        );
        assert!(peak(&muted[muted.len() - 4_000..]) < 1e-4);
    }

    #[test]
    fn a_detached_capture_is_not_rebuilt() {
        let service = service();
        let _ = open(&service, 48_000);
        let (_producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter).unwrap();
        service.line_in_detach();
        let transport = open(&service, 44_100);
        assert!(!transport.line_in_active());
    }

    #[test]
    fn attaching_without_a_stream_is_a_clear_error() {
        let service = service();
        let (_producer, ring, meter) = monitor_channel(48_000.0);
        assert!(service.line_in_attach(ring, meter).is_err());
    }

    #[test]
    fn a_capture_attached_while_the_stream_reopens_is_not_lost() {
        let service = service();
        let _first = open(&service, 48_000);
        // The new stream is prepared (no capture yet) ...
        let mut second = CallbackTransport::headless(44_100);
        let (control, built) = service.line_in_prepare(&mut second, 44_100);
        assert!(!second.line_in_active());
        // ... a capture attaches, and the message goes to the old stream's queue ...
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter).unwrap();
        // ... and then the new stream opens.
        service.line_in_commit(control, 44_100, built);
        let mut written = 0;
        let out = run(
            &mut second,
            &mut producer,
            &mut written,
            48_000.0,
            44_100.0,
            1.0,
        );
        assert!(second.line_in_active());
        assert!(peak(&out[out.len() / 2..]) > 0.3, "the guitar is heard");
    }

    #[test]
    fn a_capture_stopped_while_the_stream_reopens_is_not_left_sounding() {
        let service = service();
        let mut first = open(&service, 48_000);
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter).unwrap();
        let mut written = 0;
        run(
            &mut first,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.5,
        );
        // The new stream is prepared with the capture, which then stops before it opens.
        let mut second = CallbackTransport::headless(44_100);
        let (control, built) = service.line_in_prepare(&mut second, 44_100);
        assert!(second.line_in_active());
        service.line_in_detach();
        service.line_in_commit(control, 44_100, built);
        let out = run(
            &mut second,
            &mut producer,
            &mut written,
            48_000.0,
            44_100.0,
            0.5,
        );
        assert!(
            !second.line_in_active(),
            "the detach reached the new stream"
        );
        assert!(peak(&out[out.len() / 2..]) < 1e-6);
        assert!(service.line_in.lock().unwrap().active.is_none());
    }

    #[test]
    fn changes_apply_in_ticket_order_and_a_stale_one_never_wins() {
        let service = service();
        let mut a = LineInSettings::default();
        a.level = 0.2;
        let mut b = LineInSettings::default();
        b.level = 0.7;
        let first = service.line_in_ticket(&a).unwrap();
        let second = service.line_in_ticket(&b).unwrap();
        assert!(second > first);
        // The newer arrives first; the older is dropped when it comes.
        service.line_in_apply(b.clone(), second).unwrap();
        service.line_in_apply(a.clone(), first).unwrap();
        assert_eq!(service.line_in_settings(), b);
        // The older arriving first is skipped as superseded: only the latest is applied.
        let service = self::service();
        let first = service.line_in_ticket(&a).unwrap();
        let second = service.line_in_ticket(&b).unwrap();
        service.line_in_apply(a.clone(), first).unwrap();
        assert_eq!(service.line_in_settings(), LineInSettings::default());
        service.line_in_apply(b.clone(), second).unwrap();
        assert_eq!(service.line_in_settings(), b);
        // A change that fails validation takes no ticket.
        let mut bad = b.clone();
        bad.level = 3.0;
        assert!(service.line_in_ticket(&bad).is_err());
        let next = service.line_in_ticket(&a).unwrap();
        assert_eq!(next, second + 1);
    }

    fn plan(generation: u64) -> PlaybackPlan {
        serde_json::from_value(serde_json::json!({"generation":generation,"ppq":960,"durationTick":7680,"durationMs":8000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":60}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":4000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":4000,"endMs":8000}],"notes":[],"midi":[]})).unwrap()
    }

    /// A stream that opened with no score, as `line_in_start` opens one, through the real
    /// callback: its command queue is the service's, as `open_current` makes it.
    fn idle_stream(service: &AudioService, rate: u32) -> OutputCallback {
        let (producer, controls) = HeapRb::new(CONTROL_CAPACITY).split();
        let (retired, _kept) = HeapRb::new(CONTROL_CAPACITY).split();
        let (epoch, _) = service.shared.next_epoch_snapshot();
        let mut transport = CallbackTransport::new(rate, service.shared.clone());
        let (control, built) = service.line_in_prepare(&mut transport, rate);
        service.line_in_commit(control, rate, built);
        service.shared.audition_rate.store(rate, Ordering::Release);
        {
            let mut state = service.control.lock().unwrap();
            state.rate = rate;
            state.producer = Some(producer);
        }
        OutputCallback {
            transport,
            controls,
            retired,
            scratch: [[0.0; 2]; BLOCK],
            epoch,
            suspended: false,
        }
    }

    #[test]
    fn the_first_prepare_installs_into_an_idle_stream_without_disturbing_the_line_in() {
        let service = service();
        let mut callback = idle_stream(&service, 48_000);
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter.clone()).unwrap();
        // Device callbacks of 1536 frames, stereo.
        let mut written = 0usize;
        let mut play = |callback: &mut OutputCallback, calls: usize| {
            let mut left = Vec::new();
            for _ in 0..calls {
                producer.push_samples(&tone(330.0, 48_000.0, written, 1536));
                producer.end_block(1536);
                written += 1536;
                let mut out = vec![0.0f32; 1536 * 2];
                callback.render(&mut out, 2);
                left.extend(out.chunks(2).map(|f| f[0]));
            }
            left
        };
        let before = play(&mut callback, 40);
        assert!(!callback.transport.status().ready, "no score yet");
        assert!(peak(&before[before.len() / 2..]) > 0.3);
        // The first score is prepared: the service queues an Install for the stream already open.
        service
            .prepare(plan(1), DocumentSettings::default(), None)
            .unwrap();
        let after = play(&mut callback, 40);
        let status = callback.transport.status();
        assert!(status.ready && status.generation == 1, "{status:?}");
        assert!(peak(&after[after.len() / 2..]) > 0.3, "the guitar goes on");
        // Nothing was lost along the way: the buffer never ran dry and no callback fell silent.
        assert_eq!(meter.underruns(), 0);
        let quietest = after.chunks(1536).map(peak).fold(f32::MAX, f32::min);
        assert!(quietest > 0.3, "{quietest}");
    }

    fn reverb(mix: f64) -> LineInSettings {
        let mut settings = LineInSettings::default();
        settings.sound.effects.reverb.enabled = true;
        settings.sound.effects.reverb.mix = mix;
        settings
    }
    fn pending(service: &AudioService) -> usize {
        service
            .line_in
            .lock()
            .unwrap()
            .control
            .as_ref()
            .unwrap()
            .pending()
    }
    fn unsent(service: &AudioService) -> bool {
        let slot = service.line_in.lock().unwrap();
        slot.sent != slot.settings
    }

    #[test]
    fn changes_made_while_the_stream_is_failed_are_recorded_not_queued() {
        let service = service();
        let mut transport = open(&service, 48_000);
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter).unwrap();
        let mut written = 0;
        run(
            &mut transport,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.2,
        );
        assert_eq!(pending(&service), 0);
        // The stream fails, so nothing drains its queue. Dozens of changes follow.
        service.shared.mark_fault();
        for step in 0..40 {
            service
                .line_in_set(reverb(0.1 + step as f64 * 0.01))
                .unwrap();
        }
        assert_eq!(
            pending(&service),
            0,
            "no chain was built and queued for a dead stream"
        );
        let wanted = reverb(0.1 + 39.0 * 0.01);
        assert_eq!(
            service.line_in_settings(),
            wanted,
            "the last one is recorded"
        );
        assert!(unsent(&service));
        // A stream that opens afterwards starts from the recorded settings.
        service.shared.fault.store(0, Ordering::Release);
        let mut next = CallbackTransport::headless(44_100);
        let (control, built) = service.line_in_prepare(&mut next, 44_100);
        assert_eq!(built.settings, wanted);
        service.line_in_commit(control, 44_100, built);
        assert!(!unsent(&service));
        assert!(next.line_in_active());
    }

    #[test]
    fn a_full_queue_records_the_change_and_sends_it_when_it_drains() {
        let service = service();
        let mut transport = open(&service, 48_000);
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter).unwrap();
        let mut written = 0;
        run(
            &mut transport,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.2,
        );
        // The callback is not draining (it is busy or suspended); changes keep coming.
        for step in 0..30 {
            service
                .line_in_set(reverb(0.1 + step as f64 * 0.01))
                .expect("a change is never refused for a backed-up queue");
        }
        assert!(
            pending(&service) <= MESSAGE_CAPACITY / 2 + 2,
            "{}",
            pending(&service)
        );
        let wanted = reverb(0.1 + 29.0 * 0.01);
        assert_eq!(service.line_in_settings(), wanted);
        assert!(unsent(&service), "part of it is still waiting");
        // It drains; the status poll's resync sends what is left.
        run(
            &mut transport,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.2,
        );
        assert_eq!(pending(&service), 0);
        service.line_in_resync();
        assert!(!unsent(&service));
        assert!(pending(&service) > 0);
        run(
            &mut transport,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.2,
        );
        assert_eq!(pending(&service), 0);
    }

    #[test]
    fn a_chain_the_audio_thread_gave_up_on_is_replaced_by_the_next_resync() {
        let service = service();
        let mut transport = open(&service, 48_000);
        let (mut producer, ring, meter) = monitor_channel(48_000.0);
        service.line_in_attach(ring, meter.clone()).unwrap();
        let mut written = 0;
        run(
            &mut transport,
            &mut producer,
            &mut written,
            48_000.0,
            48_000.0,
            0.2,
        );
        service.line_in_resync();
        assert_eq!(pending(&service), 0, "nothing wrong, nothing sent");
        meter.mark_broken();
        service.line_in_resync();
        assert_eq!(pending(&service), 1, "a fresh chain");
        assert!(!meter.take_broken());
        service.line_in_resync();
        assert_eq!(pending(&service), 1, "asked for once");
    }
}
