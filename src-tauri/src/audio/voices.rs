use super::resources::{Instrument, Region};
use super::{
    decode::DecodedAudio,
    plan::{Articulation, PitchPoint},
};
use std::sync::Arc;

/// Resolve velocity and round-robin layers before playback; unmatched techniques use recorded attacks.
pub fn select_region<'a>(
    instrument: &'a Instrument,
    key: u8,
    velocity: u8,
    articulation: Articulation,
    sequence: usize,
    trigger: &str,
) -> Option<&'a Region> {
    select_region_by_name(
        instrument,
        key,
        velocity,
        articulation_name(articulation),
        sequence,
        trigger,
    )
}

pub fn select_region_by_name<'a>(
    instrument: &'a Instrument,
    key: u8,
    velocity: u8,
    articulation: &str,
    sequence: usize,
    trigger: &str,
) -> Option<&'a Region> {
    let regions =
        super::resources::eligible_regions(instrument, key, velocity, articulation, trigger);
    regions
        .iter()
        .copied()
        .find(|r| {
            r.variant == 0 || r.variant == (sequence % r.sequence_length.max(1) as usize + 1) as u16
        })
        .or_else(|| regions.first().copied())
}

pub fn articulation_name(articulation: Articulation) -> &'static str {
    match articulation {
        Articulation::Picked => "picked",
        Articulation::Fingered => "fingered",
        Articulation::Muted => "muted",
        Articulation::Dead => "dead",
        Articulation::Ghost => "ghost",
        Articulation::Staccato => "staccato",
        Articulation::Legato => "legato",
        Articulation::Tapped => "tapped",
        Articulation::Harmonic => "harmonic",
        Articulation::Feedback => "feedback",
        Articulation::Slap => "slap",
        Articulation::Pop => "pop",
    }
}

pub fn voice_id_for_track(
    track: &super::plan::PlanTrack,
    settings: &crate::settings::DocumentSettings,
) -> Option<String> {
    voice_id_for_program(track, settings, track.program)
}

/// Legacy constant retained for synthetic tests and backward compatibility.
pub const RECORDED_KIT: &str = "virtuosity-kit";

pub fn is_drum_instrument(id: &str) -> bool {
    id == RECORDED_KIT || super::gp8_soundbanks::is_percussion_instrument_id(id)
}

pub fn legacy_automatic_voice_id(program: u8, percussion: bool) -> Option<&'static str> {
    if percussion {
        return (!crate::settings::DRUM_KIT_PROGRAMS.contains(&program)).then_some(RECORDED_KIT);
    }
    match program {
        24..=25 => Some("green-guitar"),
        26..=31 => Some("black-guitar"),
        33 => Some("babyblue-bass"),
        32..=39 => Some("darkblack-bass"),
        _ => None,
    }
}

pub fn automatic_voice_id(program: u8, percussion: bool) -> Option<String> {
    automatic_voice_id_with_kit(program, percussion, None, None)
}

pub fn automatic_voice_id_with_kit(
    program: u8,
    percussion: bool,
    drum_kit: Option<u8>,
    pickup: Option<&str>,
) -> Option<String> {
    let set_id = super::gp8_soundbanks::default_set_for_program(program, percussion, drum_kit)?;
    super::gp8_soundbanks::resolve_runtime_id(&set_id, pickup, percussion, drum_kit)
}

pub fn resolve_voice_id(
    explicit: Option<&str>,
    pickup: Option<&str>,
    percussion: bool,
    drum_kit: Option<u8>,
    program: u8,
) -> Option<String> {
    if let Some(id) = explicit {
        if id == "gm" {
            return None;
        }
        if let Some((set_id, variant)) = super::gp8_soundbanks::parse_runtime_id(id) {
            return super::gp8_soundbanks::resolve_runtime_id(
                set_id,
                variant.or(pickup),
                percussion,
                drum_kit,
            );
        }
        if let Some(mapped) = super::gp8_soundbanks::legacy_voice_to_gp8(id) {
            if let Some((set_id, variant)) = super::gp8_soundbanks::parse_runtime_id(&mapped) {
                return super::gp8_soundbanks::resolve_runtime_id(
                    set_id,
                    variant.or(pickup),
                    percussion,
                    drum_kit,
                );
            }
        }
        return None;
    }
    automatic_voice_id_with_kit(program, percussion, drum_kit, pickup)
}

pub fn voice_id_for_program(
    track: &super::plan::PlanTrack,
    settings: &crate::settings::DocumentSettings,
    program: u8,
) -> Option<String> {
    let sound = settings.sounds.get(&track.id);
    resolve_voice_id(
        sound.and_then(|s| s.voice_id.as_deref()),
        sound.and_then(|s| s.pickup.as_deref()),
        track.percussion,
        drum_kit_for_track(track, settings),
        program,
    )
}

pub fn note_program(plan: &super::plan::PlaybackPlan, note: &super::plan::PlanNote) -> u8 {
    note.program.unwrap_or_else(|| {
        plan.midi
            .iter()
            .take_while(|event| event.tick() <= note.start_tick)
            .filter_map(|event| match event {
                super::plan::PlanMidiEvent::Program {
                    track_id,
                    channel,
                    program,
                    ..
                } if track_id == &note.track_id && *channel == note.channel.unwrap_or(0) => {
                    Some(*program)
                }
                _ => None,
            })
            .last()
            .unwrap_or_else(|| {
                plan.tracks
                    .iter()
                    .find(|t| t.id == note.track_id)
                    .map_or(0, |t| t.program)
            })
    })
}

/// Whether the track's sound is locked against sound automations in the score.
pub fn track_locked(settings: &crate::settings::DocumentSettings, track_id: &str) -> bool {
    settings.sounds.get(track_id).is_some_and(|s| s.locked)
}

/// The program `channel` of a track sounds at the start of the score: its last program change at or before the first
/// bar's start, else the track's own. This is the sound a locked track keeps; `track.program` alone is GP's first
/// sound, which a bar-one automation may replace.
pub fn start_program(plan: &super::plan::PlaybackPlan, track_id: &str, channel: u8) -> u8 {
    let start = plan.occurrences.first().map_or(0.0, |o| o.start_tick);
    plan.midi
        .iter()
        .take_while(|event| event.tick() <= start)
        .filter_map(|event| match event {
            super::plan::PlanMidiEvent::Program {
                track_id: id,
                channel: c,
                program,
                ..
            } if id == track_id && *c == channel => Some(*program),
            _ => None,
        })
        .last()
        .unwrap_or_else(|| {
            plan.tracks
                .iter()
                .find(|t| t.id == track_id)
                .map_or(0, |t| t.program)
        })
}

/// The program that decides `note`'s sound: the score's, or the start program when the track is locked.
pub fn effective_note_program(
    plan: &super::plan::PlaybackPlan,
    note: &super::plan::PlanNote,
    settings: &crate::settings::DocumentSettings,
) -> u8 {
    if track_locked(settings, &note.track_id) {
        start_program(plan, &note.track_id, note.channel.unwrap_or(0))
    } else {
        note_program(plan, note)
    }
}

/// The drum kit program a percussion track is set to play, when it is not Standard.
pub fn drum_kit_for_track(
    track: &super::plan::PlanTrack,
    settings: &crate::settings::DocumentSettings,
) -> Option<u8> {
    if !track.percussion {
        return None;
    }
    settings
        .sounds
        .get(&track.id)
        .and_then(|sound| sound.drum_kit)
}

/// `plan` with each drum track that chose a kit selecting it everywhere the plan names a program: its
/// own, its program changes and its notes. Playback, auditions and exports all build their renderer from
/// this, so they play the same kit. The plan itself when no drum track chose one.
pub fn with_drum_kits(
    plan: Arc<super::plan::PlaybackPlan>,
    settings: &crate::settings::DocumentSettings,
) -> Arc<super::plan::PlaybackPlan> {
    if !plan
        .tracks
        .iter()
        .any(|track| drum_kit_for_track(track, settings).is_some())
    {
        return plan;
    }
    let kits: std::collections::HashMap<&str, u8> = plan
        .tracks
        .iter()
        .filter_map(|track| Some((track.id.as_str(), drum_kit_for_track(track, settings)?)))
        .collect();
    let mut changed = (*plan).clone();
    for track in &mut changed.tracks {
        if let Some(kit) = kits.get(track.id.as_str()) {
            track.program = *kit;
        }
    }
    for note in &mut changed.notes {
        if let (Some(kit), Some(_)) = (kits.get(note.track_id.as_str()), note.program) {
            note.program = Some(*kit);
        }
    }
    for event in &mut changed.midi {
        if let super::plan::PlanMidiEvent::Program {
            track_id, program, ..
        } = event
        {
            if let Some(kit) = kits.get(track_id.as_str()) {
                *program = *kit;
            }
        }
    }
    Arc::new(changed)
}

/// The articulation `note` sounds with: its own, or when the track is locked the one its start sound gives it.
pub fn effective_articulation(
    note: &super::plan::PlanNote,
    settings: &crate::settings::DocumentSettings,
) -> Articulation {
    match note.locked_articulation {
        Some(kept) if track_locked(settings, &note.track_id) => kept,
        _ => note.articulation,
    }
}

/// `plan` with each locked track's notes carrying their locked articulation; the plan itself when nothing changes.
pub fn with_locked_articulations(
    plan: Arc<super::plan::PlaybackPlan>,
    settings: &crate::settings::DocumentSettings,
) -> Arc<super::plan::PlaybackPlan> {
    if !plan
        .notes
        .iter()
        .any(|n| effective_articulation(n, settings) != n.articulation)
    {
        return plan;
    }
    let mut changed = (*plan).clone();
    for note in &mut changed.notes {
        note.articulation = effective_articulation(note, settings);
        note.locked_articulation = None;
    }
    Arc::new(changed)
}

pub fn voice_id_for_note(
    plan: &super::plan::PlaybackPlan,
    note: &super::plan::PlanNote,
    settings: &crate::settings::DocumentSettings,
) -> Option<String> {
    let track = plan.tracks.iter().find(|track| track.id == note.track_id)?;
    voice_id_for_program(
        track,
        settings,
        effective_note_program(plan, note, settings),
    )
}

pub fn resource_requests(
    plan: &super::plan::PlaybackPlan,
    settings: &crate::settings::DocumentSettings,
) -> Vec<super::resources::SampleRequest> {
    let mut requests = Vec::new();
    for note in plan.notes.iter().filter(|n| n.velocity > 0) {
        let Some(instrument_id) = voice_id_for_note(plan, note, settings) else {
            continue;
        };
        let drums = plan
            .tracks
            .iter()
            .find(|track| track.id == note.track_id && track.percussion);
        if let Some(track) = drums {
            if !is_drum_instrument(&instrument_id)
                || (instrument_id == RECORDED_KIT
                    && drum_kit_for_track(track, settings)
                        .is_some_and(|kit| crate::settings::DRUM_KIT_PROGRAMS.contains(&kit)))
            {
                continue;
            }
            let Some(sound) = note.kit_sound else {
                continue;
            };
            if note.choke {
                requests.push(super::resources::SampleRequest {
                    instrument_id: instrument_id.clone(),
                    key: sound,
                    velocity: note.velocity,
                    articulation: "choke".into(),
                });
            }
            requests.push(super::resources::SampleRequest {
                instrument_id,
                key: sound,
                velocity: note.velocity,
                articulation: "picked".into(),
            });
            continue;
        }
        requests.push(super::resources::SampleRequest {
            instrument_id,
            key: note.key,
            velocity: note.velocity,
            articulation: articulation_name(effective_articulation(note, settings)).into(),
        });
    }
    // A drum track needs no placeholder: its notes play General MIDI unless they asked for a kit sound above.
    for track in plan.tracks.iter().filter(|track| !track.percussion) {
        if let Some(instrument_id) = voice_id_for_track(track, settings) {
            if !requests.iter().any(|r| r.instrument_id == instrument_id) {
                requests.push(super::resources::SampleRequest {
                    instrument_id,
                    key: if (32..=39).contains(&track.program) {
                        40
                    } else {
                        57
                    },
                    velocity: 100,
                    articulation: "picked".into(),
                });
            }
        }
    }
    requests
}

#[derive(Clone, Copy, Debug)]
pub struct VoiceParameters {
    pub root_key: u8,
    pub key: u8,
    pub velocity: u8,
    pub articulation: Articulation,
    pub attack_seconds: f64,
    pub release_seconds: f64,
    pub gain_db: f64,
    pub loop_start: Option<u64>,
    pub loop_end: Option<u64>,
    pub pitch_keytrack: f64,
    pub velocity_gain_high: u8,
    pub tuning_cents: f64,
    pub is_recorded_harmonic: bool,
}
pub fn pitch_at(points: &[PitchPoint], tick: f64) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    let next = points.partition_point(|p| p.tick <= tick);
    if next == 0 {
        return points[0].semitones;
    }
    if next == points.len() {
        return points[next - 1].semitones;
    }
    let a = &points[next - 1];
    let b = &points[next];
    let t = ((tick - a.tick) / (b.tick - a.tick)).clamp(0.0, 1.0);
    a.semitones + (b.semitones - a.semitones) * t
}
pub struct SampleVoice {
    audio: Arc<DecodedAudio>,
    params: VoiceParameters,
    position: f64,
    rate: f64,
    age: f64,
    released: bool,
    release_gain: f64,
    active: bool,
    key: f64,
    filter: [f64; 2],
    harmonic_low: [f64; 2],
    fade_in_left: u32,
    /// A palm-muted note whose end came before `MUTED_RING_SECONDS`: it keeps ringing, damped, until then.
    ring_pending: bool,
    /// Low-pass of a palm mute: a few harmonics of the sounding note, so a low string stays dark and a high one is not dulled.
    muted_cutoff: f64,
    /// Seconds from the start of a muted or dead note's recording to its pick, at the sounding pitch. The recording keeps its lead-in (as every
    /// note's does, so notes stay in time with each other); the decay, the ring and the cut count from the pick, not from the start.
    lead_seconds: f64,
    /// Linear trims of palm mutes and dead notes on this voice, applied by the articulation the voice sounds now.
    trim_muted: f64,
    trim_dead: f64,
    /// Seconds a ring is held after the pick, set when the note's end is deferred.
    ring_hold: f64,
    /// A cut ring fades out over `CUT_FADE_SECONDS`, not over the recording's own release.
    cut: bool,
    /// After a join between a muted or dead note and another technique the low-pass and the gain glide to their new values.
    blend: Option<Blend>,
    blend_coefficient: f64,
    last_cutoff: f64,
    last_gain: f64,
    last_envelope: f64,
    /// Gain of a dead note at the key it sounds: `DEAD_GAIN` from its recording's root up, ramping down below it.
    dead_gain: f64,
}
#[derive(Clone, Copy)]
struct Blend {
    cutoff: f64,
    gain: f64,
    envelope: f64,
}
thread_local! {
    static LEAD_IN_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
/// Times this thread has measured a recording's lead-in. The renderer measures once while preparing, never on the audio callback; a test
/// reads it before and after playing.
pub fn lead_in_scans() -> usize {
    LEAD_IN_SCANS.with(|n| n.get())
}
/// A cut ring (the same string struck again) fades out over this long.
const CUT_FADE_SECONDS: f64 = 0.004;
/// A dead note's thud is held for this long after the pick before the note's end fades it.
const DEAD_HOLD_SECONDS: f64 = 0.03;

/// How long a palm-muted string rings before its note's end may stop it: a damped string, not a cut at the written
/// length (alphaTab writes palm mutes as ~80 ms notes).
pub const MUTED_RING_SECONDS: f64 = 0.2;
/// Palm mute envelope and tone (was decay 0.10 s, a fixed 1 kHz low-pass, gain 0.8). The low-pass sits this many harmonics above the
/// note, within these limits, so a low string is dark and a standard-tuned one is not boomy.
const MUTED_DECAY_SECONDS: f64 = 0.30;
const MUTED_GAIN: f64 = 1.0;
const MUTED_CUTOFF_HARMONICS: f64 = 4.0;
const MUTED_CUTOFF_MIN: f64 = 140.0;
const MUTED_CUTOFF_MAX: f64 = 1000.0;
/// Dead note thud (was decay 0.025 s, gain 0.55). The pick now sounds inside the envelope on every string, so it needs little more than it had.
const DEAD_DECAY_SECONDS: f64 = 0.05;
const DEAD_GAIN: f64 = 1.6;
/// Below the lowest recorded root the thud is the lowest recording pitched down, and the clean chain's low shelf lifts it above an open note
/// (peak +9 dB at D1 with a gain of 2): the gain falls in dB, semitone by semitone, to this at `DEAD_RAMP_SEMITONES` below the root.
const DEAD_GAIN_BELOW_ROOT: f64 = 0.6;
const DEAD_RAMP_SEMITONES: f64 = 14.0;
const BLEND_SECONDS: f64 = 0.004;
impl SampleVoice {
    pub fn new(
        audio: Arc<DecodedAudio>,
        params: VoiceParameters,
        sample_rate: u32,
    ) -> Result<Self, String> {
        let lead = if matches!(
            params.articulation,
            Articulation::Muted | Articulation::Dead
        ) {
            lead_in_frames(&audio)
        } else {
            0.0
        };
        Self::prepared(audio, params, sample_rate, lead, (0.0, 0.0))
    }
    /// A voice with what the renderer measured while preparing: `lead_frames` of recorded silence before the pick (see `lead_in_frames`) and
    /// the voice's palm mute and dead note trims in dB.
    pub fn prepared(
        audio: Arc<DecodedAudio>,
        params: VoiceParameters,
        sample_rate: u32,
        lead_frames: f64,
        trims_db: (f64, f64),
    ) -> Result<Self, String> {
        if audio.frames.is_empty()
            || audio.sample_rate == 0
            || !(8000..=192000).contains(&sample_rate)
            || params.key > 127
            || params.root_key > 127
            || params.velocity_gain_high == 0
            || !params.attack_seconds.is_finite()
            || params.attack_seconds < 0.0
            || !params.release_seconds.is_finite()
            || params.release_seconds < 0.0
            || !params.gain_db.is_finite()
            || !params.pitch_keytrack.is_finite()
            || !params.tuning_cents.is_finite()
            || !trims_db.0.is_finite()
            || !trims_db.1.is_finite()
            || !lead_frames.is_finite()
        {
            return Err("Invalid sample voice parameters.".into());
        }
        if let (Some(a), Some(b)) = (params.loop_start, params.loop_end) {
            if a >= b || b as usize > audio.frames.len() {
                return Err("Invalid sample loop.".into());
            }
        }
        let ratio = if params.tuning_cents != 0.0 {
            2f64.powf(
                ((params.key as f64 - params.root_key as f64) * params.pitch_keytrack / 100.0
                    + params.tuning_cents / 100.0)
                    / 12.0,
            )
        } else {
            2f64.powf(
                (params.key as f64 - params.root_key as f64) * params.pitch_keytrack / 100.0 / 12.0,
            )
        };
        let lead_seconds = if lead_frames > 0.0 && ratio > 0.0 {
            lead_frames / audio.sample_rate as f64 / ratio
        } else {
            0.0
        };
        Ok(Self {
            key: params.key as f64,
            params,
            position: 0.0,
            rate: sample_rate as f64,
            age: 0.0,
            released: false,
            release_gain: 1.0,
            active: true,
            filter: [0.0; 2],
            harmonic_low: [0.0; 2],
            fade_in_left: 0,
            ring_pending: false,
            muted_cutoff: muted_cutoff(params.key),
            lead_seconds,
            trim_muted: 10f64.powf(trims_db.0 / 20.0),
            trim_dead: 10f64.powf(trims_db.1 / 20.0),
            ring_hold: 0.0,
            cut: false,
            blend: None,
            blend_coefficient: 1.0 - (-1.0 / (sample_rate as f64 * BLEND_SECONDS)).exp(),
            last_cutoff: 0.0,
            last_gain: 0.0,
            last_envelope: 1.0,
            dead_gain: dead_gain(params.key, params.root_key),
            audio,
        })
    }
    pub fn next_frame(&mut self, semitones: f64) -> [f32; 2] {
        if !self.active {
            return [0.0; 2];
        }
        if self.position >= self.audio.frames.len() as f64 {
            self.active = false;
            return [0.0; 2];
        }
        let index = self.position as usize;
        let fraction = (self.position - index as f64) as f32;
        let a = self.audio.frames[index];
        let b = self.audio.frames.get(index + 1).copied().unwrap_or(a);
        let mut x = std::array::from_fn(|c| a[c] + (b[c] - a[c]) * fraction);
        let dt = 1.0 / self.rate;
        self.key += (self.params.key as f64 - self.key) * (1.0 - (-dt / 0.002).exp());
        let semitones = if semitones.is_finite() {
            semitones
        } else {
            0.0
        };
        let ratio = if self.params.tuning_cents != 0.0 {
            2f64.powf(
                ((self.key - self.params.root_key as f64) * self.params.pitch_keytrack / 100.0
                    + self.params.tuning_cents / 100.0
                    + semitones)
                    / 12.0,
            )
        } else {
            2f64.powf(
                ((self.key - self.params.root_key as f64) * self.params.pitch_keytrack / 100.0
                    + semitones)
                    / 12.0,
            )
        };
        self.position += self.audio.sample_rate as f64 / self.rate * ratio;
        if let (Some(start), Some(end)) = (self.params.loop_start, self.params.loop_end) {
            if self.position >= end as f64 {
                self.position =
                    start as f64 + (self.position - start as f64) % (end - start) as f64;
            }
        }
        let (decay, cutoff, technique_gain) = self.technique();
        // A muted or dead note's decay and ring count from its pick, which the recording's lead-in puts `lead_seconds` after the start.
        let envelope_age = if self.lead_seconds > 0.0 {
            (self.age - self.lead_seconds).max(0.0)
        } else {
            self.age
        };
        let mut decay_term = (-envelope_age / decay).exp();
        let (cutoff, technique_gain) = match &mut self.blend {
            Some(blend) => {
                let k = self.blend_coefficient;
                blend.cutoff += (cutoff - blend.cutoff) * k;
                blend.gain += (technique_gain - blend.gain) * k;
                blend.envelope += (decay_term - blend.envelope) * k;
                let now = (blend.cutoff, blend.gain);
                let settled = (now.0 - cutoff).abs() < 0.5
                    && (now.1 - technique_gain).abs() < 1e-4 * technique_gain.abs().max(1e-3)
                    && (blend.envelope - decay_term).abs() < 1e-4;
                decay_term = blend.envelope;
                if settled {
                    self.blend = None;
                }
                now
            }
            None => (cutoff, technique_gain),
        };
        self.last_cutoff = cutoff;
        self.last_gain = technique_gain;
        self.last_envelope = decay_term;
        let coefficient =
            1.0 - (-std::f64::consts::TAU * cutoff.min(self.rate * 0.4) / self.rate).exp();
        for c in 0..2 {
            self.filter[c] += coefficient * (x[c] as f64 - self.filter[c]);
            x[c] = self.filter[c] as f32;
            if matches!(self.params.articulation, Articulation::Harmonic)
                && !self.params.is_recorded_harmonic
            {
                let hp = 1.0 - (-std::f64::consts::TAU * 700.0 / self.rate).exp();
                self.harmonic_low[c] += hp * (x[c] as f64 - self.harmonic_low[c]);
                x[c] = (x[c] as f64 - self.harmonic_low[c] * 0.65) as f32;
            }
        }
        let attack = if self.params.attack_seconds > 0.0 {
            (self.age / self.params.attack_seconds).min(1.0)
        } else {
            1.0
        };
        let velocity = (self.params.velocity.min(self.params.velocity_gain_high) as f64
            / self.params.velocity_gain_high as f64)
            .powf(1.2);
        if self.ring_pending && envelope_age >= self.ring_hold {
            self.ring_pending = false;
            self.released = true;
        }
        if self.released {
            let seconds = if self.cut {
                CUT_FADE_SECONDS
            } else {
                self.params.release_seconds.max(0.003)
            };
            self.release_gain *= (-dt * 6.907755 / seconds).exp();
        }
        let envelope = attack
            * decay_term
            * self.release_gain
            * velocity
            * technique_gain
            * 10f64.powf(self.params.gain_db / 20.0);
        let fade = if self.fade_in_left > 0 {
            let value = 1.0 - self.fade_in_left as f64 / (self.rate * 0.003) as u32 as f64;
            self.fade_in_left -= 1;
            value
        } else {
            1.0
        };
        let gain = envelope * fade;
        self.age += dt;
        if self.release_gain < 1e-5 || envelope < 1e-7 && self.age > 0.05 {
            self.active = false;
        }
        x.map(|v| if v.is_finite() { v * gain as f32 } else { 0.0 })
    }
    /// The envelope's decay time, the low-pass and the gain of the technique the voice sounds now.
    fn technique(&self) -> (f64, f64, f64) {
        match self.params.articulation {
            Articulation::Muted => (
                MUTED_DECAY_SECONDS,
                self.muted_cutoff,
                MUTED_GAIN * self.trim_muted,
            ),
            Articulation::Dead => (DEAD_DECAY_SECONDS, 650.0, self.dead_gain * self.trim_dead),
            Articulation::Ghost => (0.08, 1800.0, 0.4),
            Articulation::Staccato => (0.13, 7000.0, 1.0),
            Articulation::Tapped => (0.8, 6500.0, 0.8),
            Articulation::Legato => (f64::INFINITY, 7000.0, 0.9),
            Articulation::Fingered => (f64::INFINITY, 8500.0, 1.0),
            Articulation::Harmonic => (f64::INFINITY, 14000.0, 0.75),
            Articulation::Feedback => (f64::INFINITY, 12000.0, 0.65),
            Articulation::Picked => (f64::INFINITY, 16000.0, 1.0),
            // The slap and pop recordings carry the technique; a bass without them plays its
            // ordinary voice, brighter, as slapped strings sound.
            Articulation::Slap | Articulation::Pop => (f64::INFINITY, 16000.0, 1.0),
        }
    }
    pub fn transition(&mut self, key: u8, articulation: Articulation) {
        let ringing = |a: Articulation| matches!(a, Articulation::Muted | Articulation::Dead);
        let was_ringing = ringing(self.params.articulation);
        let (last_cutoff, last_gain, last_envelope) =
            (self.last_cutoff, self.last_gain, self.last_envelope);
        self.params.key = key;
        self.params.articulation = articulation;
        self.released = false;
        self.ring_pending = false;
        self.cut = false;
        self.muted_cutoff = muted_cutoff(key);
        self.dead_gain = dead_gain(key, self.params.root_key);
        // A join into or out of a palm mute or dead note (or between two of them, across the root key) glides the low-pass, the gain and the decay.
        if (was_ringing || ringing(articulation)) && last_gain > 0.0 {
            let (_, cutoff, gain) = self.technique();
            if cutoff != last_cutoff || gain != last_gain {
                self.blend = Some(Blend {
                    cutoff: last_cutoff,
                    gain: last_gain,
                    envelope: last_envelope,
                });
            }
        }
    }
    /// The low-pass the voice is filtering with now, in Hz (0 before the first frame).
    pub fn filter_cutoff_hz(&self) -> f64 {
        self.last_cutoff
    }
    pub fn seek_elapsed_seconds(&mut self, seconds: f64, semitones: f64) {
        let seconds = seconds.max(0.0);
        self.age = seconds;
        self.fade_in_left = (self.rate * 0.003) as u32;
        self.position = if self.params.tuning_cents != 0.0 {
            seconds
                * self.audio.sample_rate as f64
                * 2f64.powf(
                    ((self.key - self.params.root_key as f64) * self.params.pitch_keytrack / 100.0
                        + self.params.tuning_cents / 100.0
                        + semitones)
                        / 12.0,
                )
        } else {
            seconds
                * self.audio.sample_rate as f64
                * 2f64.powf(
                    ((self.key - self.params.root_key as f64) * self.params.pitch_keytrack / 100.0
                        + semitones)
                        / 12.0,
                )
        };
        if let (Some(a), Some(b)) = (self.params.loop_start, self.params.loop_end) {
            if self.position >= b as f64 {
                self.position = a as f64 + (self.position - a as f64) % (b - a) as f64;
            }
        }
        self.active = self.position < self.audio.frames.len() as f64;
    }
    pub fn release(&mut self) {
        let hold = match self.params.articulation {
            Articulation::Muted => MUTED_RING_SECONDS,
            Articulation::Dead => DEAD_HOLD_SECONDS,
            _ => 0.0,
        };
        let since_pick = if self.lead_seconds > 0.0 {
            (self.age - self.lead_seconds).max(0.0)
        } else {
            self.age
        };
        if hold > 0.0 && !self.released && since_pick < hold {
            self.ring_pending = true;
            self.ring_hold = hold;
        } else {
            self.released = true;
        }
    }
    /// Stops a palm mute or dead note now (the same string is struck again, or the next note starts as this one ends), over a few ms;
    /// any other voice is untouched.
    pub fn cut_ring(&mut self) -> bool {
        if matches!(
            self.params.articulation,
            Articulation::Muted | Articulation::Dead
        ) && self.active
            && !self.cut
        {
            self.ring_pending = false;
            self.released = true;
            self.cut = true;
            true
        } else {
            false
        }
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn source_position(&self) -> f64 {
        self.position
    }
}

/// Gain of a dead note at `key` on a recording rooted at `root`: full from the root up, falling in dB with each semitone below it.
fn dead_gain(key: u8, root: u8) -> f64 {
    let below = (root as f64 - key as f64).clamp(0.0, DEAD_RAMP_SEMITONES) / DEAD_RAMP_SEMITONES;
    let db = 20.0 * DEAD_GAIN.log10() * (1.0 - below) + 20.0 * DEAD_GAIN_BELOW_ROOT.log10() * below;
    10f64.powf(db / 20.0)
}

fn muted_cutoff(key: u8) -> f64 {
    let f0 = 440.0 * 2f64.powf((key as f64 - 69.0) / 12.0);
    (f0 * MUTED_CUTOFF_HARMONICS).clamp(MUTED_CUTOFF_MIN, MUTED_CUTOFF_MAX)
}

/// Frames before a recording's pick (its first sample 10% of the opening 100 ms peak, less 1 ms); recorded guitar notes open with about
/// 20 ms of near-silence, which pitched down to a low string delays the sound by more than a short note lasts.
pub fn lead_in_frames(audio: &DecodedAudio) -> f64 {
    LEAD_IN_SCANS.with(|n| n.set(n.get() + 1));
    let rate = audio.sample_rate as f64;
    let window = ((rate * 0.1) as usize).min(audio.frames.len());
    let peak = audio.frames[..window]
        .iter()
        .fold(0.0f32, |m, f| m.max(f[0].abs()).max(f[1].abs()));
    if peak <= 0.0 {
        return 0.0;
    }
    let first = audio.frames[..window]
        .iter()
        .position(|f| f[0].abs().max(f[1].abs()) >= peak * 0.1)
        .unwrap_or(0);
    first.saturating_sub((rate * 0.001) as usize) as f64
}

/// How much quieter (negative) a palm mute or dead note sounds on a recorded voice than on the black electric guitar, whose recordings the
/// constants above were balanced for. The black guitar serves the clean, crunch and distorted electric programs alike, so its balance is the
/// one that is right dry and clean; the other voices keep a palm mute about as far from an open note as they had before THE-214, and a dead
/// note clearly under it. Measured by `palm-mute` renders dry, clean, classic-rock and the metal rhythm sound as it was then (docs/validation/2026-11-15-the-214-palm-mute.md;
/// the metal rhythm sound was retuned afterwards, see docs/validation/2026-11-15-the-217-metal-rhythm-amp.md, and these trims were not).
pub fn technique_trims_db(instrument_id: &str) -> (f64, f64) {
    match instrument_id {
        "green-guitar" => (-3.0, -6.0),
        "babyblue-bass" => (-6.2, -5.0),
        "darkblack-bass" => (-3.0, -5.0),
        _ => (0.0, 0.0),
    }
}

/// A verbatim copy of `develop`'s `SampleVoice` (before THE-214), kept so that every technique except the palm mute and the dead note can be
/// shown to render the same bits as before, in the same process and on any platform's maths library.
#[cfg(test)]
mod legacy_equivalence {
    use super::*;

    struct LegacyVoice {
        audio: Arc<DecodedAudio>,
        params: VoiceParameters,
        position: f64,
        rate: f64,
        age: f64,
        released: bool,
        release_gain: f64,
        active: bool,
        key: f64,
        filter: [f64; 2],
        harmonic_low: [f64; 2],
        fade_in_left: u32,
    }
    impl LegacyVoice {
        fn new(
            audio: Arc<DecodedAudio>,
            params: VoiceParameters,
            sample_rate: u32,
        ) -> Result<Self, String> {
            if audio.frames.is_empty()
                || audio.sample_rate == 0
                || !(8000..=192000).contains(&sample_rate)
                || params.key > 127
                || params.root_key > 127
                || params.velocity_gain_high == 0
                || !params.attack_seconds.is_finite()
                || params.attack_seconds < 0.0
                || !params.release_seconds.is_finite()
                || params.release_seconds < 0.0
                || !params.gain_db.is_finite()
                || !params.pitch_keytrack.is_finite()
            {
                return Err("Invalid sample voice parameters.".into());
            }
            if let (Some(a), Some(b)) = (params.loop_start, params.loop_end) {
                if a >= b || b as usize > audio.frames.len() {
                    return Err("Invalid sample loop.".into());
                }
            }
            Ok(Self {
                audio,
                key: params.key as f64,
                params,
                position: 0.0,
                rate: sample_rate as f64,
                age: 0.0,
                released: false,
                release_gain: 1.0,
                active: true,
                filter: [0.0; 2],
                harmonic_low: [0.0; 2],
                fade_in_left: 0,
            })
        }
        fn next_frame(&mut self, semitones: f64) -> [f32; 2] {
            if !self.active {
                return [0.0; 2];
            }
            if self.position >= self.audio.frames.len() as f64 {
                self.active = false;
                return [0.0; 2];
            }
            let index = self.position as usize;
            let fraction = (self.position - index as f64) as f32;
            let a = self.audio.frames[index];
            let b = self.audio.frames.get(index + 1).copied().unwrap_or(a);
            let mut x = std::array::from_fn(|c| a[c] + (b[c] - a[c]) * fraction);
            let dt = 1.0 / self.rate;
            self.key += (self.params.key as f64 - self.key) * (1.0 - (-dt / 0.002).exp());
            let semitones = if semitones.is_finite() {
                semitones
            } else {
                0.0
            };
            let ratio = 2f64.powf(
                ((self.key - self.params.root_key as f64) * self.params.pitch_keytrack / 100.0
                    + semitones)
                    / 12.0,
            );
            self.position += self.audio.sample_rate as f64 / self.rate * ratio;
            if let (Some(start), Some(end)) = (self.params.loop_start, self.params.loop_end) {
                if self.position >= end as f64 {
                    self.position =
                        start as f64 + (self.position - start as f64) % (end - start) as f64;
                }
            }
            let (decay, cutoff, technique_gain): (f64, f64, f64) = match self.params.articulation {
                Articulation::Muted => (0.10, 1000.0, 0.8),
                Articulation::Dead => (0.025, 650.0, 0.55),
                Articulation::Ghost => (0.08, 1800.0, 0.4),
                Articulation::Staccato => (0.13, 7000.0, 1.0),
                Articulation::Tapped => (0.8, 6500.0, 0.8),
                Articulation::Legato => (f64::INFINITY, 7000.0, 0.9),
                Articulation::Fingered => (f64::INFINITY, 8500.0, 1.0),
                Articulation::Harmonic => (f64::INFINITY, 14000.0, 0.75),
                Articulation::Feedback => (f64::INFINITY, 12000.0, 0.65),
                Articulation::Picked => (f64::INFINITY, 16000.0, 1.0),
                // The slap and pop recordings carry the technique; a bass without them plays its
                // ordinary voice, brighter, as slapped strings sound.
                Articulation::Slap | Articulation::Pop => (f64::INFINITY, 16000.0, 1.0),
            };
            let coefficient =
                1.0 - (-std::f64::consts::TAU * cutoff.min(self.rate * 0.4) / self.rate).exp();
            for c in 0..2 {
                self.filter[c] += coefficient * (x[c] as f64 - self.filter[c]);
                x[c] = self.filter[c] as f32;
                if matches!(self.params.articulation, Articulation::Harmonic) {
                    let hp = 1.0 - (-std::f64::consts::TAU * 700.0 / self.rate).exp();
                    self.harmonic_low[c] += hp * (x[c] as f64 - self.harmonic_low[c]);
                    x[c] = (x[c] as f64 - self.harmonic_low[c] * 0.65) as f32;
                }
            }
            let attack = if self.params.attack_seconds > 0.0 {
                (self.age / self.params.attack_seconds).min(1.0)
            } else {
                1.0
            };
            let velocity = (self.params.velocity.min(self.params.velocity_gain_high) as f64
                / self.params.velocity_gain_high as f64)
                .powf(1.2);
            if self.released {
                self.release_gain *=
                    (-dt * 6.907755 / self.params.release_seconds.max(0.003)).exp();
            }
            let envelope = attack
                * (-self.age / decay).exp()
                * self.release_gain
                * velocity
                * technique_gain
                * 10f64.powf(self.params.gain_db / 20.0);
            let fade = if self.fade_in_left > 0 {
                let value = 1.0 - self.fade_in_left as f64 / (self.rate * 0.003) as u32 as f64;
                self.fade_in_left -= 1;
                value
            } else {
                1.0
            };
            let gain = envelope * fade;
            self.age += dt;
            if self.release_gain < 1e-5 || envelope < 1e-7 && self.age > 0.05 {
                self.active = false;
            }
            x.map(|v| if v.is_finite() { v * gain as f32 } else { 0.0 })
        }
        fn transition(&mut self, key: u8, articulation: Articulation) {
            self.params.key = key;
            self.params.articulation = articulation;
            self.released = false;
        }
        fn seek_elapsed_seconds(&mut self, seconds: f64, semitones: f64) {
            let seconds = seconds.max(0.0);
            self.age = seconds;
            self.fade_in_left = (self.rate * 0.003) as u32;
            self.position = seconds
                * self.audio.sample_rate as f64
                * 2f64.powf(
                    ((self.key - self.params.root_key as f64) * self.params.pitch_keytrack / 100.0
                        + semitones)
                        / 12.0,
                );
            if let (Some(a), Some(b)) = (self.params.loop_start, self.params.loop_end) {
                if self.position >= b as f64 {
                    self.position = a as f64 + (self.position - a as f64) % (b - a) as f64;
                }
            }
            self.active = self.position < self.audio.frames.len() as f64;
        }
        fn release(&mut self) {
            self.released = true;
        }
        fn is_active(&self) -> bool {
            self.active
        }
        fn source_position(&self) -> f64 {
            self.position
        }
    }

    fn audio() -> Arc<DecodedAudio> {
        let mut seed = 7u32;
        let frames = (0..96_000)
            .map(|n| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = (seed >> 8) as f32 / 8_388_608.0 - 1.0;
                let t = n as f32 / 48_000.0;
                let x = 0.3 * (220.0 * std::f32::consts::TAU * t).sin() + 0.05 * noise;
                [x, 0.8 * x]
            })
            .collect();
        Arc::new(DecodedAudio {
            sample_rate: 48_000,
            channels: 2,
            frames: Arc::new(frames),
        })
    }
    fn parameters(articulation: Articulation, key: u8) -> VoiceParameters {
        VoiceParameters {
            root_key: 57,
            key,
            velocity: 90,
            articulation,
            attack_seconds: 0.01,
            release_seconds: 0.2,
            gain_db: -2.0,
            loop_start: Some(10_000),
            loop_end: Some(80_000),
            pitch_keytrack: 100.0,
            velocity_gain_high: 127,
            tuning_cents: 0.0,
            is_recorded_harmonic: false,
        }
    }

    #[test]
    fn every_technique_but_the_palm_mute_and_the_dead_note_renders_the_bits_it_did_before() {
        let open = [
            Articulation::Picked,
            Articulation::Fingered,
            Articulation::Legato,
            Articulation::Tapped,
            Articulation::Harmonic,
            Articulation::Feedback,
            Articulation::Ghost,
            Articulation::Staccato,
            Articulation::Slap,
            Articulation::Pop,
        ];
        for rate in [44_100u32, 48_000] {
            for (first, &articulation) in open.iter().enumerate() {
                for key in [26u8, 40, 57, 70] {
                    let mut new =
                        SampleVoice::new(audio(), parameters(articulation, key), rate).unwrap();
                    let mut old =
                        LegacyVoice::new(audio(), parameters(articulation, key), rate).unwrap();
                    for n in 0..rate as usize {
                        // A bend, a join into another technique, a release and a seek, at the same frames on both.
                        let bend = if n > 2000 {
                            0.5 * (n as f64 / 8000.0).sin()
                        } else {
                            0.0
                        };
                        if n == 6000 {
                            let to = open[(first + 3) % open.len()];
                            new.transition(key + 2, to);
                            old.transition(key + 2, to);
                        }
                        if n == 14_000 {
                            new.seek_elapsed_seconds(0.1, bend);
                            old.seek_elapsed_seconds(0.1, bend);
                        }
                        if n == 24_000 {
                            new.release();
                            old.release();
                        }
                        let (a, b) = (new.next_frame(bend), old.next_frame(bend));
                        assert_eq!(
                            [a[0].to_bits(), a[1].to_bits()],
                            [b[0].to_bits(), b[1].to_bits()],
                            "{articulation:?} key {key} at {rate} Hz, frame {n}"
                        );
                        assert_eq!(new.is_active(), old.is_active());
                        assert_eq!(
                            new.source_position().to_bits(),
                            old.source_position().to_bits()
                        );
                    }
                }
            }
        }
    }
}
