//! Note audition: a short note or chord played through a track's own sound, on top of
//! (or without) playback. Clips are rendered off the audio thread with the offline
//! renderer and handed to the callback through a dedicated lock-free queue; the
//! callback only adds finished samples into its output.
use super::{
    plan::{Articulation, MeasureOccurrence, PlanMidiEvent, PlanNote, PlanTempo, PlanTrack},
    plan::{PitchPoint, PlaybackPlan},
    renderer::Renderer,
    resources::AudioResources,
    voices::resource_requests,
};
use crate::{
    edit_types::NoteTarget,
    project::BeatTarget,
    settings::{ChannelMix, DocumentSettings, TrackSound},
};
use ringbuf::{HeapCons, HeapProd, HeapRb, traits::*};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};

pub const MAX_NOTES: usize = 12;
pub const MAX_START_MS: u32 = 1000;
pub const MIN_DURATION_MS: u32 = 100;
pub const MAX_DURATION_MS: u32 = 3000;
/// Clips waiting for the callback; a full queue refuses the newest clip.
pub const AUDITION_QUEUE: usize = 4;
const TRACK_ID: &str = "audition";
/// Fade applied to the end of every rendered clip.
const END_FADE_MS: u32 = 30;
/// Fade applied to a clip that a newer clip replaces.
const REPLACE_FADE_MS: u32 = 5;
const DONE_SLOTS: usize = 16;
/// Intake is skipped while fewer retirement slots than this are free, so the
/// callback never needs to free a clip itself.
const INTAKE_RESERVE: usize = 8;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditionNote {
    pub key: u8,
    pub start_ms: u32,
    pub velocity: u8,
}

/// `voice` is the track's `TrackSound` and `mix` its `ChannelMix`, exactly as the
/// frontend sends them to `audio_prepare`/`audio_set_mix`. `program` and
/// `percussion` are the plan track's identity fields. Mute and solo are ignored.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditionRequest {
    pub voice: TrackSound,
    pub program: u8,
    pub percussion: bool,
    pub mix: ChannelMix,
    pub notes: Vec<AuditionNote>,
    /// How long every note is held, in milliseconds.
    pub duration_ms: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditionResult {
    pub played: bool,
}

impl AuditionRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.notes.is_empty() || self.notes.len() > MAX_NOTES {
            return Err("An audition needs 1 to 12 notes.".into());
        }
        if self.program > 127 {
            return Err("Audition program must be 0–127.".into());
        }
        if !(MIN_DURATION_MS..=MAX_DURATION_MS).contains(&self.duration_ms) {
            return Err("Audition duration must be 100–3000 ms.".into());
        }
        for note in &self.notes {
            if note.key > 127 {
                return Err("Audition key must be 0–127.".into());
            }
            if note.start_ms > MAX_START_MS {
                return Err("Audition note start must be 0–1000 ms.".into());
            }
            if !(1..=127).contains(&note.velocity) {
                return Err("Audition velocity must be 1–127.".into());
            }
        }
        self.voice.validate()?;
        self.mix.validate()
    }
}

/// A finished stereo clip at the output stream's sample rate.
pub struct AuditionClip {
    pub rate: u32,
    pub frames: Vec<[f32; 2]>,
}

/// One-track plan: 62.5 bpm at 960 ppq makes one tick exactly one millisecond.
fn build(request: &AuditionRequest) -> (PlaybackPlan, DocumentSettings, f64) {
    let mut notes: Vec<_> = request.notes.clone();
    notes.sort_by_key(|n| n.start_ms);
    let last_start = notes.last().map_or(0, |n| n.start_ms);
    let total_ms = f64::from(last_start + request.duration_ms);
    let channel = if request.percussion { 9 } else { 0 };
    let mut settings = DocumentSettings::default();
    settings
        .sounds
        .insert(TRACK_ID.into(), request.voice.clone());
    settings.mixes.insert(
        TRACK_ID.into(),
        ChannelMix {
            mute: false,
            solo: false,
            ..request.mix.clone()
        },
    );
    let track = PlanTrack {
        id: TRACK_ID.into(),
        program: request.program,
        percussion: request.percussion,
    };
    // Matches src/audio/plan.ts: bass programs play fingered, everything else picked.
    let articulation = if (32..=39).contains(&request.program) {
        Articulation::Fingered
    } else {
        Articulation::Picked
    };
    let mut plan_notes = Vec::with_capacity(notes.len());
    let mut midi = Vec::with_capacity(notes.len() * 2);
    for (index, note) in notes.iter().enumerate() {
        let start = f64::from(note.start_ms);
        let end = start + f64::from(request.duration_ms);
        plan_notes.push(PlanNote {
            id: format!("audition-{index}"),
            track_id: TRACK_ID.into(),
            source: NoteTarget {
                target: BeatTarget {
                    track: 0,
                    staff: 0,
                    bar: 0,
                    voice: 0,
                    beat: index as u32,
                },
                string: index as u32 + 1,
            },
            occurrence: 0,
            played_bar: None,
            channel: request.percussion.then_some(9),
            program: None,
            start_tick: start,
            end_tick: end,
            key: note.key,
            velocity: note.velocity,
            articulation,
            legato_from: None,
            pitch: vec![PitchPoint {
                tick: start,
                semitones: 0.0,
            }],
        });
        midi.push(PlanMidiEvent::NoteOn {
            track_id: TRACK_ID.into(),
            tick: start,
            channel,
            key: note.key,
            velocity: note.velocity,
        });
        midi.push(PlanMidiEvent::NoteOff {
            track_id: TRACK_ID.into(),
            tick: end,
            channel,
            key: note.key,
            velocity: 0,
        });
    }
    midi.sort_by(|a, b| {
        a.tick().total_cmp(&b.tick()).then_with(|| {
            matches!(b, PlanMidiEvent::NoteOff { .. })
                .cmp(&matches!(a, PlanMidiEvent::NoteOff { .. }))
        })
    });
    let plan = PlaybackPlan {
        generation: 0,
        ppq: 960,
        duration_tick: total_ms,
        duration_ms: total_ms,
        playback_end_tick: None,
        tracks: vec![track],
        tempos: vec![PlanTempo {
            tick: 0.0,
            bpm: 62.5,
        }],
        occurrences: vec![MeasureOccurrence {
            bar: 0,
            occurrence: 0,
            meter_numerator: 4,
            meter_denominator: 4,
            start_tick: 0.0,
            end_tick: total_ms,
            start_ms: 0.0,
            end_ms: total_ms,
            click_ticks: None,
        }],
        performed_beats: None,
        notes: plan_notes,
        midi,
    };
    (plan, settings, total_ms)
}

/// Render a clip with the track's voices, effects chain, gain and pan. Blocking:
/// run it on a worker, never on the audio thread.
pub fn render_clip(
    root: &Path,
    request: &AuditionRequest,
    rate: u32,
) -> Result<Box<AuditionClip>, String> {
    request.validate()?;
    let (plan, settings, total_ms) = build(request);
    let resources = Arc::new(AudioResources::load_for_requests(
        root,
        &resource_requests(&plan, &settings),
    )?);
    let mut renderer = Renderer::new(Arc::new(plan), resources, settings, rate)?;
    let length = (total_ms * f64::from(rate) / 1000.0).ceil() as usize;
    let mut frames = vec![[0.0f32; 2]; length];
    renderer.render_into(&mut frames);
    for frame in &mut frames {
        for sample in frame.iter_mut() {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }
    }
    let fade = ((u64::from(rate) * u64::from(END_FADE_MS) / 1000) as usize)
        .max(1)
        .min(frames.len());
    let start = frames.len() - fade;
    for (n, frame) in frames[start..].iter_mut().enumerate() {
        let gain = 1.0 - (n + 1) as f32 / fade as f32;
        frame[0] *= gain;
        frame[1] *= gain;
    }
    Ok(Box::new(AuditionClip { rate, frames }))
}

pub type AuditionProducer = HeapProd<Box<AuditionClip>>;
pub type AuditionConsumer = HeapCons<Box<AuditionClip>>;

pub fn audition_channel() -> (AuditionProducer, AuditionConsumer) {
    HeapRb::new(AUDITION_QUEUE).split()
}

struct Sounding {
    clip: Box<AuditionClip>,
    pos: usize,
    fade_total: usize,
    fade_left: usize,
}

/// What a mixed block changed, for the status counters.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MixReport {
    /// A new clip began sounding in this block.
    pub started: bool,
    /// New peak of the current clip's own samples (before summing with playback,
    /// clamping or downmix), when it changed.
    pub peak: Option<f64>,
}

/// Callback-side state. `mix` never allocates, locks, blocks or logs: clips arrive
/// through the queue, and finished ones wait in `done` until the owner hands them
/// to the retirement path.
pub struct AuditionMixer {
    rate: u32,
    queue: Option<AuditionConsumer>,
    current: Option<Sounding>,
    fading: [Option<Sounding>; 2],
    done: [Option<Box<AuditionClip>>; DONE_SLOTS],
    peak: f64,
    fresh: bool,
}

fn stash(done: &mut [Option<Box<AuditionClip>>; DONE_SLOTS], clip: Box<AuditionClip>) {
    for slot in done.iter_mut() {
        if slot.is_none() {
            *slot = Some(clip);
            return;
        }
    }
    // Unreachable by the intake reserve; leaking beats freeing on the audio thread.
    std::mem::forget(clip);
}

impl AuditionMixer {
    pub fn new(rate: u32) -> Self {
        Self {
            rate,
            queue: None,
            current: None,
            fading: [None, None],
            done: std::array::from_fn(|_| None),
            peak: 0.0,
            fresh: false,
        }
    }
    pub fn attach(&mut self, queue: AuditionConsumer) {
        self.queue = Some(queue);
    }
    /// Hand every finished clip to `retire`; clips it refuses stay for the next call.
    pub fn retire(
        &mut self,
        mut retire: impl FnMut(Box<AuditionClip>) -> Option<Box<AuditionClip>>,
    ) {
        for slot in self.done.iter_mut() {
            if let Some(clip) = slot.take() {
                *slot = retire(clip);
            }
        }
    }
    fn intake(&mut self) {
        let Some(queue) = &mut self.queue else {
            return;
        };
        if self.done.iter().filter(|s| s.is_none()).count() < INTAKE_RESERVE {
            return;
        }
        let rate = self.rate;
        let mut incoming: Option<Box<AuditionClip>> = None;
        // Bounded: a producer can never keep the callback in this loop.
        for _ in 0..AUDITION_QUEUE {
            let Some(clip) = queue.try_pop() else {
                break;
            };
            if clip.rate != rate {
                stash(&mut self.done, clip);
            } else if let Some(previous) = incoming.replace(clip) {
                stash(&mut self.done, previous);
            }
        }
        let Some(clip) = incoming else {
            return;
        };
        if let Some(mut old) = self.current.take() {
            let total = ((u64::from(rate) * u64::from(REPLACE_FADE_MS) / 1000) as usize).max(1);
            old.fade_total = total;
            old.fade_left = total;
            if let Some(free) = self.fading.iter_mut().find(|s| s.is_none()) {
                *free = Some(old);
            } else {
                if let Some(oldest) = self.fading[0].take() {
                    stash(&mut self.done, oldest.clip);
                }
                self.fading[0] = self.fading[1].take();
                self.fading[1] = Some(old);
            }
        }
        self.current = Some(Sounding {
            clip,
            pos: 0,
            fade_total: 0,
            fade_left: 0,
        });
        self.fresh = true;
        self.peak = 0.0;
    }
    /// Add the sounding clips into `output`.
    pub fn mix(&mut self, output: &mut [[f32; 2]]) -> MixReport {
        self.intake();
        for slot in self.fading.iter_mut() {
            let Some(sounding) = slot else {
                continue;
            };
            let length = sounding.clip.frames.len();
            let count = output
                .len()
                .min(sounding.fade_left)
                .min(length.saturating_sub(sounding.pos));
            for (n, frame) in output[..count].iter_mut().enumerate() {
                let gain = (sounding.fade_left - n) as f32 / sounding.fade_total as f32;
                let source = sounding.clip.frames[sounding.pos + n];
                frame[0] += source[0] * gain;
                frame[1] += source[1] * gain;
            }
            sounding.pos += count;
            sounding.fade_left -= count;
            if sounding.fade_left == 0 || sounding.pos >= length {
                if let Some(finished) = slot.take() {
                    stash(&mut self.done, finished.clip);
                }
            }
        }
        let mut report = MixReport::default();
        if let Some(sounding) = &mut self.current {
            let length = sounding.clip.frames.len();
            let count = output.len().min(length.saturating_sub(sounding.pos));
            let mut block_peak = 0.0f32;
            for (frame, source) in output[..count]
                .iter_mut()
                .zip(&sounding.clip.frames[sounding.pos..sounding.pos + count])
            {
                frame[0] += source[0];
                frame[1] += source[1];
                block_peak = block_peak.max(source[0].abs()).max(source[1].abs());
            }
            sounding.pos += count;
            let finished = sounding.pos >= length;
            report.started = self.fresh;
            self.fresh = false;
            if report.started || f64::from(block_peak) > self.peak {
                self.peak = self.peak.max(f64::from(block_peak));
                report.peak = Some(self.peak);
            }
            if finished {
                if let Some(done) = self.current.take() {
                    stash(&mut self.done, done.clip);
                }
            }
        }
        report
    }
}
