use crate::project::{BeatTarget, NoteTarget};
use crate::settings::KitElement;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackPlan {
    pub generation: u64,
    pub ppq: u32,
    pub duration_tick: f64,
    pub duration_ms: f64,
    #[serde(
        default,
        deserialize_with = "present_playback_end_tick",
        skip_serializing_if = "Option::is_none"
    )]
    pub playback_end_tick: Option<f64>,
    pub tracks: Vec<PlanTrack>,
    pub tempos: Vec<PlanTempo>,
    pub occurrences: Vec<MeasureOccurrence>,
    #[serde(
        default,
        deserialize_with = "present_performed_beats",
        skip_serializing_if = "Option::is_none"
    )]
    pub performed_beats: Option<Vec<PerformedBeat>>,
    pub notes: Vec<PlanNote>,
    pub midi: Vec<PlanMidiEvent>,
}
fn present_playback_end_tick<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    f64::deserialize(deserializer).map(Some)
}
fn present_performed_beats<'de, D>(deserializer: D) -> Result<Option<Vec<PerformedBeat>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<PerformedBeat>::deserialize(deserializer).map(Some)
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformedBeat {
    pub target: BeatTarget,
    pub occurrence: u32,
    pub start_tick: f64,
    pub end_tick: f64,
    pub lead_in_tick: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTrack {
    pub id: String,
    pub program: u8,
    pub percussion: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTempo {
    pub tick: f64,
    pub bpm: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasureOccurrence {
    pub bar: u32,
    pub occurrence: u32,
    pub meter_numerator: u32,
    pub meter_denominator: u32,
    pub start_tick: f64,
    pub end_tick: f64,
    pub start_ms: f64,
    pub end_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub click_ticks: Option<Vec<f64>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PitchPoint {
    pub tick: f64,
    pub semitones: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Articulation {
    Picked,
    Fingered,
    Muted,
    Dead,
    Ghost,
    Staccato,
    Legato,
    Tapped,
    Harmonic,
    Feedback,
    Slap,
    Pop,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanNote {
    pub id: String,
    pub track_id: String,
    pub source: NoteTarget,
    pub occurrence: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub played_bar: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<u8>,
    pub start_tick: f64,
    pub end_tick: f64,
    pub key: u8,
    pub velocity: u8,
    pub articulation: Articulation,
    /// The articulation the note has when its track's sound is locked: the default of the start sound, where an automation would change it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_articulation: Option<Articulation>,
    pub legato_from: Option<String>,
    pub pitch: Vec<PitchPoint>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlanMidiEvent {
    NoteOn {
        track_id: String,
        tick: f64,
        channel: u8,
        key: u8,
        velocity: u8,
        /// The kit element the articulation belongs to, where that is not the one its pitch sounds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kit_element: Option<KitElement>,
    },
    NoteOff {
        track_id: String,
        tick: f64,
        channel: u8,
        key: u8,
        velocity: u8,
        /// The kit element the articulation belongs to, where that is not the one its pitch sounds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kit_element: Option<KitElement>,
    },
    Program {
        track_id: String,
        tick: f64,
        channel: u8,
        program: u8,
    },
    Controller {
        track_id: String,
        tick: f64,
        channel: u8,
        controller: u8,
        value: u8,
    },
    Bend {
        track_id: String,
        tick: f64,
        channel: u8,
        value: f64,
    },
    NoteBend {
        track_id: String,
        tick: f64,
        channel: u8,
        key: u8,
        value: f64,
    },
}
impl PlanMidiEvent {
    pub fn tick(&self) -> f64 {
        match self {
            Self::NoteOn { tick, .. }
            | Self::NoteOff { tick, .. }
            | Self::Program { tick, .. }
            | Self::Controller { tick, .. }
            | Self::Bend { tick, .. }
            | Self::NoteBend { tick, .. } => *tick,
        }
    }
    pub fn track_id(&self) -> &str {
        match self {
            Self::NoteOn { track_id, .. }
            | Self::NoteOff { track_id, .. }
            | Self::Program { track_id, .. }
            | Self::Controller { track_id, .. }
            | Self::Bend { track_id, .. }
            | Self::NoteBend { track_id, .. } => track_id,
        }
    }
}
fn nonnegative(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}
impl PlaybackPlan {
    pub fn validate(&self) -> Result<(), String> {
        let invalid = || "Invalid native playback plan.".to_string();
        if self.generation > 9_007_199_254_740_991
            || self.ppq != 960
            || !nonnegative(self.duration_tick)
            || !nonnegative(self.duration_ms)
            || self.tracks.is_empty()
        {
            return Err(invalid());
        }
        let mut track_ids = HashSet::new();
        for t in &self.tracks {
            if t.id.is_empty() || !track_ids.insert(t.id.as_str()) || t.program > 127 {
                return Err(invalid());
            }
        }
        let mut prior = -1.0;
        for t in &self.tempos {
            if !nonnegative(t.tick)
                || t.tick <= prior
                || t.tick > self.duration_tick
                || !t.bpm.is_finite()
                || t.bpm <= 0.0
                || !(60.0 / (t.bpm * self.ppq as f64)).is_finite()
            {
                return Err(invalid());
            }
            prior = t.tick;
        }
        if self.tempos.first().is_none_or(|t| t.tick != 0.0) {
            return Err(invalid());
        }
        let mut occurrences = HashSet::new();
        let mut counts = HashMap::new();
        prior = 0.0;
        for o in &self.occurrences {
            let count = counts.entry(o.bar).or_insert(0);
            if o.meter_numerator == 0
                || !matches!(
                    o.meter_denominator,
                    1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256
                )
                || !nonnegative(o.start_tick)
                || o.start_tick < prior
                || !nonnegative(o.end_tick)
                || o.end_tick <= o.start_tick
                || o.end_tick > self.duration_tick
                || !nonnegative(o.start_ms)
                || !nonnegative(o.end_ms)
                || o.end_ms <= o.start_ms
                || o.end_ms > self.duration_ms + 0.001
                || o.occurrence != *count
            {
                return Err(invalid());
            }
            if let Some(clicks) = &o.click_ticks {
                if clicks.first().is_none_or(|tick| *tick != o.start_tick)
                    || clicks.iter().enumerate().any(|(i, tick)| {
                        !tick.is_finite()
                            || *tick < o.start_tick
                            || *tick >= o.end_tick
                            || i > 0 && clicks[i - 1] >= *tick
                    })
                {
                    return Err(invalid());
                }
            }
            *count += 1;
            occurrences.insert((o.bar, o.occurrence));
            prior = o.end_tick;
        }
        if self.playback_end_tick.is_some_and(|end| {
            !end.is_finite()
                || end <= 0.0
                || end > self.duration_tick
                || self
                    .occurrences
                    .last()
                    .is_none_or(|last| last.end_tick != end)
        }) {
            return Err(invalid());
        }
        if let Some(rows) = &self.performed_beats {
            let mut mapped = HashSet::new();
            for row in rows {
                let target = &row.target;
                if target.track as usize >= self.tracks.len()
                    || !occurrences.contains(&(target.bar, row.occurrence))
                    || !nonnegative(row.lead_in_tick)
                    || !nonnegative(row.start_tick)
                    || !nonnegative(row.end_tick)
                    || row.lead_in_tick > row.start_tick
                    || row.start_tick > row.end_tick
                    || row.end_tick > self.duration_tick
                    || !mapped.insert((
                        target.track,
                        target.staff,
                        target.bar,
                        target.voice,
                        target.beat,
                        row.occurrence,
                    ))
                {
                    return Err(invalid());
                }
            }
        }
        let mut note_ids = HashMap::new();
        prior = -1.0;
        for n in &self.notes {
            if n.id.is_empty()
                || note_ids.insert(n.id.as_str(), n).is_some()
                || !track_ids.contains(n.track_id.as_str())
                || self
                    .tracks
                    .get(n.source.target.track as usize)
                    .is_none_or(|t| t.id != n.track_id)
                || n.played_bar.is_some_and(|bar| bar < n.source.target.bar)
                || !occurrences
                    .contains(&(n.played_bar.unwrap_or(n.source.target.bar), n.occurrence))
                || !nonnegative(n.start_tick)
                || n.start_tick < prior
                || !nonnegative(n.end_tick)
                || n.end_tick <= n.start_tick
                || n.end_tick > self.duration_tick + 0.001
                || n.key > 127
                || n.velocity > 127
                || n.channel.is_some_and(|channel| channel > 15)
                || n.program.is_some_and(|program| program > 127)
                || n.pitch.is_empty()
            {
                return Err(invalid());
            }
            let mut pitch_prior = -1.0;
            for p in &n.pitch {
                if !p.tick.is_finite()
                    || p.tick < n.start_tick
                    || p.tick > n.end_tick
                    || p.tick <= pitch_prior
                    || !p.semitones.is_finite()
                {
                    return Err(invalid());
                }
                pitch_prior = p.tick;
            }
            if n.pitch[0].tick != n.start_tick {
                return Err(invalid());
            }
            if let Some(origin) = &n.legato_from {
                if note_ids.get(origin.as_str()).is_none_or(|from| {
                    from.id == n.id
                        || from.track_id != n.track_id
                        || from.source.target.staff != n.source.target.staff
                        || from.source.target.voice != n.source.target.voice
                        || from.source.string != n.source.string
                        || from.start_tick >= n.start_tick
                }) {
                    return Err(invalid());
                }
            }
            prior = n.start_tick;
        }
        prior = -1.0;
        for e in &self.midi {
            if !nonnegative(e.tick())
                || e.tick() < prior
                || e.tick() > self.duration_tick + 0.001
                || !track_ids.contains(e.track_id())
            {
                return Err(invalid());
            }
            let valid = match e {
                PlanMidiEvent::NoteOn {
                    channel,
                    key,
                    velocity,
                    ..
                }
                | PlanMidiEvent::NoteOff {
                    channel,
                    key,
                    velocity,
                    ..
                } => *channel < 16 && *key < 128 && *velocity < 128,
                PlanMidiEvent::Program {
                    channel, program, ..
                } => *channel < 16 && *program < 128,
                PlanMidiEvent::Controller {
                    channel,
                    controller,
                    value,
                    ..
                } => *channel < 16 && *controller < 128 && *value < 128,
                PlanMidiEvent::Bend { channel, value, .. } => *channel < 16 && value.is_finite(),
                PlanMidiEvent::NoteBend {
                    channel,
                    key,
                    value,
                    ..
                } => *channel < 16 && *key < 128 && value.is_finite(),
            };
            if !valid {
                return Err(invalid());
            }
            prior = e.tick();
        }
        let timeline = Timeline::from_tempos(self.ppq, &self.tempos);
        let duration = timeline.tick_to_seconds(self.duration_tick) * 1000.0;
        if !duration.is_finite() || (duration - self.duration_ms).abs() > 0.01 {
            return Err(invalid());
        }
        for o in &self.occurrences {
            if (timeline.tick_to_seconds(o.start_tick) * 1000.0 - o.start_ms).abs() > 0.01
                || (timeline.tick_to_seconds(o.end_tick) * 1000.0 - o.end_ms).abs() > 0.01
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
struct TempoSegment {
    tick: f64,
    seconds: f64,
    seconds_per_tick: f64,
}
#[derive(Clone, Debug)]
pub struct Timeline {
    segments: Vec<TempoSegment>,
}
impl Timeline {
    pub fn new(plan: &PlaybackPlan) -> Result<Self, String> {
        plan.validate()?;
        Ok(Self::from_tempos(plan.ppq, &plan.tempos))
    }
    fn from_tempos(ppq: u32, tempos: &[PlanTempo]) -> Self {
        let mut segments: Vec<TempoSegment> = Vec::with_capacity(tempos.len());
        for t in tempos {
            let seconds = segments
                .last()
                .map_or(0.0, |p| p.seconds + (t.tick - p.tick) * p.seconds_per_tick);
            segments.push(TempoSegment {
                tick: t.tick,
                seconds,
                seconds_per_tick: 60.0 / (t.bpm * ppq as f64),
            });
        }
        Self { segments }
    }
    pub fn tick_to_seconds(&self, tick: f64) -> f64 {
        let tick = tick.max(0.0);
        let i = self
            .segments
            .partition_point(|s| s.tick <= tick)
            .saturating_sub(1);
        let s = &self.segments[i];
        s.seconds + (tick - s.tick) * s.seconds_per_tick
    }
    pub fn seconds_to_tick(&self, seconds: f64) -> f64 {
        let seconds = seconds.max(0.0);
        let i = self
            .segments
            .partition_point(|s| s.seconds <= seconds)
            .saturating_sub(1);
        let s = &self.segments[i];
        s.tick + (seconds - s.seconds) / s.seconds_per_tick
    }
}
