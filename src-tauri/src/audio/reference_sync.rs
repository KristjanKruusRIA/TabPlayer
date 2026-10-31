use crate::audio::{
    decode::DecodedAudio,
    plan::{PlaybackPlan, Timeline},
};
use crate::settings::BackingSettings;

#[derive(Clone, Debug)]
pub struct ReferenceSyncMap {
    entry_source_ms: f64,
    exit_source_ms: f64,
    entry_tick: f64,
    end_tick: f64,
    entry_seconds: f64,
}

impl ReferenceSyncMap {
    pub fn new(settings: &BackingSettings, plan: &PlaybackPlan) -> Result<Self, String> {
        settings.validate()?;
        let timeline = Timeline::new(plan)?;
        let bounds = settings
            .reference_sync
            .as_ref()
            .ok_or("Reference bounds are required.")?;
        let first = plan
            .occurrences
            .first()
            .ok_or("Reference sync requires performed music.")?;
        let last = plan.occurrences.last().unwrap();
        if plan.playback_end_tick != Some(last.end_tick) {
            return Err("Reference playback end must match the performed exit.".into());
        }
        // Subtract offset before comparing intervals: distinct stored values can
        // collapse to one physical source coordinate at large offsets.
        let entry = bounds.entry_audio_ms - settings.offset_ms;
        let exit = bounds.exit_audio_ms - settings.offset_ms;
        let mut pins = vec![(first.start_tick, entry), (last.end_tick, exit)];
        for anchor in &settings.anchors {
            let occurrence = plan
                .occurrences
                .iter()
                .find(|o| o.bar == anchor.bar && o.occurrence == anchor.occurrence)
                .ok_or("Reference anchor refers to missing performed music.")?;
            let tick = occurrence.start_tick
                + (occurrence.end_tick - occurrence.start_tick) * anchor.ratio;
            if !tick.is_finite() || tick <= first.start_tick || tick >= last.end_tick {
                return Err(
                    "Reference anchors must be strictly inside performed endpoints.".into(),
                );
            }
            pins.push((tick, anchor.audio_ms - settings.offset_ms));
        }
        pins.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut spans = Vec::with_capacity(pins.len() - 1);
        for pair in pins.windows(2) {
            let ticks = pair[1].0 - pair[0].0;
            let milliseconds = pair[1].1 - pair[0].1;
            let bpm = 60_000.0 * ticks / (960.0 * milliseconds);
            let seconds_per_tick = 60.0 / (960.0 * bpm);
            if ticks <= 0.0
                || milliseconds <= 0.0
                || !bpm.is_finite()
                || bpm <= 0.0
                || !seconds_per_tick.is_finite()
                || seconds_per_tick <= 0.0
                || !(1.0 / seconds_per_tick).is_finite()
            {
                return Err("Reference pins require positive finite timing intervals.".into());
            }
            spans.push((pair[0].0, bpm));
        }
        // Every outgoing tempo span must agree, including grace and note tails.
        for tempo in &plan.tempos {
            let index = spans
                .partition_point(|span| span.0 <= tempo.tick)
                .saturating_sub(1);
            let expected = spans[index].1;
            if (tempo.bpm - expected).abs() > expected * 1e-9 {
                return Err("Effective playback tempos disagree with reference pins.".into());
            }
        }
        // A missing derived breakpoint also fails even if other spans compensate.
        for &(tick, expected) in &spans {
            let index = plan
                .tempos
                .partition_point(|tempo| tempo.tick <= tick)
                .saturating_sub(1);
            if (plan.tempos[index].bpm - expected).abs() > expected * 1e-9 {
                return Err("Effective playback tempos omit a reference pin change.".into());
            }
        }
        let entry_seconds = timeline.tick_to_seconds(first.start_tick);
        for &(tick, source) in &pins {
            let seconds = timeline.tick_to_seconds(tick);
            if !seconds.is_finite()
                || (seconds - entry_seconds - (source - entry) / 1000.0).abs() > 1e-7
            {
                return Err("Effective playback time disagrees with reference pins.".into());
            }
        }
        Ok(Self {
            entry_source_ms: entry,
            exit_source_ms: exit,
            entry_tick: first.start_tick,
            end_tick: last.end_tick,
            entry_seconds,
        })
    }
    pub fn validate_audio(&self, audio: &DecodedAudio) -> Result<(), String> {
        if audio.sample_rate == 0
            || audio.frames.is_empty()
            || self.exit_source_ms > 1000.0 * audio.frames.len() as f64 / audio.sample_rate as f64
        {
            return Err("Reference exit exceeds decoded backing audio.".into());
        }
        Ok(())
    }
    pub fn entry_source_seconds(&self) -> f64 {
        self.entry_source_ms / 1000.0
    }
    pub fn exit_source_seconds(&self) -> f64 {
        self.exit_source_ms / 1000.0
    }
    pub fn entry_tick(&self) -> f64 {
        self.entry_tick
    }
    pub fn end_tick(&self) -> f64 {
        self.end_tick
    }
    pub fn source_seconds(&self, seconds: f64) -> f64 {
        self.entry_source_seconds() + (seconds - self.entry_seconds)
    }
    pub fn score_seconds(&self, source: f64) -> f64 {
        self.entry_seconds + (source - self.entry_source_seconds())
    }
    pub(super) fn contains_frame(&self, frame: usize, rate: u32) -> bool {
        // Match waveform duration coordinates without a seconds round trip at
        // exact frame boundaries or decoded EOF.
        let milliseconds = 1000.0 * frame as f64 / rate as f64;
        milliseconds >= self.entry_source_ms && milliseconds < self.exit_source_ms
    }
    pub(super) fn frame_score_seconds(&self, frame: usize, rate: u32) -> f64 {
        self.entry_seconds + (1000.0 * frame as f64 / rate as f64 - self.entry_source_ms) / 1000.0
    }
}
