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
    let regions = super::resources::eligible_regions(
        instrument,
        key,
        velocity,
        articulation_name(articulation),
        trigger,
    );
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
    }
}

pub fn voice_id_for_track<'a>(
    track: &super::plan::PlanTrack,
    settings: &'a crate::settings::DocumentSettings,
) -> Option<&'a str> {
    voice_id_for_program(track, settings, track.program)
}

pub fn automatic_voice_id(program: u8, percussion: bool) -> Option<&'static str> {
    if percussion {
        return None;
    }
    match program {
        24..=25 => Some("green-guitar"),
        26..=31 => Some("black-guitar"),
        33 => Some("babyblue-bass"),
        32..=39 => Some("darkblack-bass"),
        _ => None,
    }
}

pub fn voice_id_for_program<'a>(
    track: &super::plan::PlanTrack,
    settings: &'a crate::settings::DocumentSettings,
    program: u8,
) -> Option<&'a str> {
    if let Some(id) = settings
        .sounds
        .get(&track.id)
        .and_then(|s| s.voice_id.as_deref())
    {
        return if id == "gm" { None } else { Some(id) };
    }
    automatic_voice_id(program, track.percussion)
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

pub fn voice_id_for_note<'a>(
    plan: &super::plan::PlaybackPlan,
    note: &super::plan::PlanNote,
    settings: &'a crate::settings::DocumentSettings,
) -> Option<&'a str> {
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
    let mut requests: Vec<_> = plan
        .notes
        .iter()
        .filter(|n| n.velocity > 0)
        .filter_map(|note| {
            let instrument_id = voice_id_for_note(plan, note, settings)?;
            Some(super::resources::SampleRequest {
                instrument_id: instrument_id.into(),
                key: note.key,
                velocity: note.velocity,
                articulation: articulation_name(effective_articulation(note, settings)).into(),
            })
        })
        .collect();
    for track in &plan.tracks {
        if let Some(instrument_id) = voice_id_for_track(track, settings) {
            if !requests.iter().any(|r| r.instrument_id == instrument_id) {
                requests.push(super::resources::SampleRequest {
                    instrument_id: instrument_id.into(),
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
}
impl SampleVoice {
    pub fn new(
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
            self.release_gain *= (-dt * 6.907755 / self.params.release_seconds.max(0.003)).exp();
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
    pub fn transition(&mut self, key: u8, articulation: Articulation) {
        self.params.key = key;
        self.params.articulation = articulation;
        self.released = false;
    }
    pub fn seek_elapsed_seconds(&mut self, seconds: f64, semitones: f64) {
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
    pub fn release(&mut self) {
        self.released = true;
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn source_position(&self) -> f64 {
        self.position
    }
}
