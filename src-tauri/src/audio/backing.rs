use super::{
    decode::DecodedAudio,
    dsp::BackingFilterDsp,
    plan::{PlaybackPlan, Timeline},
    reference_sync::ReferenceSyncMap,
};
use crate::settings::{BackingFilter, BackingProcessing, BackingSettings, SyncAnchor};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct BackingMap {
    points: Vec<(f64, f64)>,
    offset: f64,
    reference: Option<ReferenceSyncMap>,
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    #[test]
    fn exact_source_frame_entry_and_exit_use_waveform_coordinates() {
        let rate = 44_100;
        let entry = 1000.0 * 44_112.0 / rate as f64;
        let exit = 1000.0 * 88_224.0 / rate as f64;
        let duration = exit - entry;
        let plan:PlaybackPlan=serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":duration,"playbackEndTick":3840,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":240_000.0/duration}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":duration}],"notes":[],"midi":[]})).unwrap();
        let settings:BackingSettings=serde_json::from_value(serde_json::json!({"assetId":"a","offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":entry,"exitAudioMs":exit},"mix":{"gain":1,"pan":0,"mute":false,"solo":false}})).unwrap();
        let voice = BackingVoice::new(
            Arc::new(DecodedAudio {
                sample_rate: rate,
                channels: 2,
                frames: Arc::new(vec![[0.2; 2]; 100_000]),
            }),
            BackingMap::from_settings(&settings, &plan).unwrap(),
            rate,
        )
        .unwrap();
        assert_eq!(voice.source_frame(44_111), [0.0; 2]);
        assert_eq!(voice.source_frame(44_112), [0.2; 2]);
        assert_eq!(voice.source_frame(88_223), [0.2; 2]);
        assert_eq!(voice.source_frame(88_224), [0.0; 2]);
        let mut frames = vec![[0.0; 2]; 100_000];
        frames[44_112] = [0.7, 0.35];
        frames[88_224] = [1.0; 2];
        let mut impulse = BackingVoice::new(
            Arc::new(DecodedAudio {
                sample_rate: rate,
                channels: 2,
                frames: Arc::new(frames),
            }),
            BackingMap::from_settings(&settings, &plan).unwrap(),
            rate,
        )
        .unwrap();
        impulse.seek(0.0);
        assert_eq!(
            impulse.next_frame(0.0),
            [0.7, 0.35],
            "exact entry transient must survive installation seek"
        );
    }
    #[test]
    fn every_interpolation_neighbor_and_transient_read_obeys_fractional_frame_gate() {
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":960,"durationMs":100,"playbackEndTick":960,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":600}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":960,"startMs":0,"endMs":100}],"notes":[],"midi":[]})).unwrap();
        let settings: BackingSettings = serde_json::from_value(serde_json::json!({"assetId":"a","offsetMs":0,"anchors":[],"referenceSync":{"entryAudioMs":100.0625,"exitAudioMs":200.0625},"mix":{"gain":1,"pan":0,"mute":false,"solo":false}})).unwrap();
        let map = BackingMap::from_settings(&settings, &plan).unwrap();
        let audio = Arc::new(DecodedAudio {
            sample_rate: 8000,
            channels: 2,
            frames: Arc::new(vec![[0.2; 2]; 2400]),
        });
        let voice = BackingVoice::new(audio, map, 8000).unwrap();
        assert_eq!(voice.source_frame(800), [0.0; 2]);
        assert_eq!(voice.source_frame(801), [0.2; 2]);
        assert_eq!(voice.source_frame(1600), [0.2; 2]);
        assert_eq!(voice.source_frame(1601), [0.0; 2]);
        assert_eq!(voice.sample(800.5), [0.1; 2]);
        assert_eq!(voice.sample(1600.5), [0.1; 2]);
        assert!(voice.transients.is_empty());
    }
}
impl BackingMap {
    pub fn new(
        anchors: &[SyncAnchor],
        offset_ms: f64,
        plan: &PlaybackPlan,
    ) -> Result<Self, String> {
        if !offset_ms.is_finite() {
            return Err("Invalid backing offset.".into());
        }
        let timeline = Timeline::new(plan)?;
        let mut points = Vec::with_capacity(anchors.len());
        for anchor in anchors {
            if !anchor.ratio.is_finite()
                || !(0.0..=1.0).contains(&anchor.ratio)
                || !anchor.audio_ms.is_finite()
                || anchor.audio_ms < 0.0
            {
                return Err("Invalid backing synchronization anchor.".into());
            }
            let occurrence = plan
                .occurrences
                .iter()
                .find(|o| o.bar == anchor.bar && o.occurrence == anchor.occurrence)
                .ok_or("Backing anchor refers to missing score music.")?;
            let tick = occurrence.start_tick
                + (occurrence.end_tick - occurrence.start_tick) * anchor.ratio;
            let point = (timeline.tick_to_seconds(tick), anchor.audio_ms / 1000.0);
            points.push(point);
        }
        points.sort_by(|a, b| a.0.total_cmp(&b.0));
        if points
            .windows(2)
            .any(|pair| pair[0].0 >= pair[1].0 || pair[0].1 >= pair[1].1)
        {
            return Err("Backing anchors must have distinct score positions and increasing audio times in playback order.".into());
        }
        Ok(Self {
            points,
            offset: offset_ms / 1000.0,
            reference: None,
        })
    }
    pub fn from_settings(settings: &BackingSettings, plan: &PlaybackPlan) -> Result<Self, String> {
        if settings.reference_sync.is_some() {
            Ok(Self {
                points: Vec::new(),
                offset: 0.0,
                reference: Some(ReferenceSyncMap::new(settings, plan)?),
            })
        } else {
            Self::new(&settings.anchors, settings.offset_ms, plan)
        }
    }
    fn interpolate(&self, value: f64, inverse: bool) -> f64 {
        if self.points.is_empty() {
            return value;
        }
        let point = |i: usize| {
            let p = self.points[i];
            if inverse { (p.1, p.0) } else { p }
        };
        if self.points.len() == 1 {
            let p = point(0);
            return value - p.0 + p.1;
        }
        let index = self
            .points
            .partition_point(|&(s, a)| if inverse { a <= value } else { s <= value })
            .saturating_sub(1)
            .min(self.points.len() - 2);
        let a = point(index);
        let b = point(index + 1);
        a.1 + (value - a.0) * (b.1 - a.1) / (b.0 - a.0)
    }
    pub fn source_seconds(&self, score_seconds: f64) -> f64 {
        if let Some(reference) = &self.reference {
            return reference.source_seconds(score_seconds);
        }
        self.interpolate(score_seconds, false) - self.offset
    }
    pub fn score_seconds(&self, source_seconds: f64) -> f64 {
        if let Some(reference) = &self.reference {
            return reference.score_seconds(source_seconds);
        }
        self.interpolate(source_seconds + self.offset, true)
    }
    fn permits_source(&self, seconds: f64) -> bool {
        self.reference.as_ref().is_none_or(|reference| {
            seconds >= reference.entry_source_seconds() && seconds < reference.exit_source_seconds()
        })
    }
    fn permits_frame(&self, frame: usize, rate: u32) -> bool {
        self.reference
            .as_ref()
            .is_none_or(|reference| reference.contains_frame(frame, rate))
    }
    fn frame_score_seconds(&self, frame: usize, rate: u32) -> f64 {
        self.reference.as_ref().map_or_else(
            || self.score_seconds(frame as f64 / rate as f64),
            |reference| reference.frame_score_seconds(frame, rate),
        )
    }
}
const HOP: usize = 256;
/// The grain search looks at positions within +-RADIUS of the position the grain is aimed at, RADIUS = HOP * step
/// source frames, capped at MAX_RADIUS (about 43 ms at 48 kHz, reached only by a large upward key shift or a very high
/// file rate). It samples them COARSE_POINTS at most, 4 frames apart when that fits (always at step 1), wider
/// otherwise, then refines by single frames within one coarse step either side of the chosen peak. The work per grain,
/// in correlations of 64 samples each, is therefore at most
///   COARSE_POINTS + 2 * (stride - 1), stride = max(4, ceil(2 * RADIUS / (COARSE_POINTS - 1))),
/// which is 129 + 6 = 135 at step 1 (as before the re-centring), and never more than 144 + 56 = 200, at the cap. The
/// score of each coarse position is kept in a fixed array, so the search allocates nothing.
const MAX_RADIUS: f64 = 2048.0;
const COARSE_POINTS: usize = 144;
/// Which correlation peak a grain lands on is decided by its height less PULL_COST times the square of its distance
/// from the aim in grains (HOP frames): nothing close in, 0.35 a grain away. A peak is where the waveform lines up, so
/// whichever is chosen is phase-true, and the position is then refined on the correlation alone: the pull moves the
/// choice between peaks, never the position inside one.
const PULL_COST: f64 = 0.35;
/// A peak that scores more than this below the best is never chosen, however near the aim: a much weaker peak is not
/// preferred over a much stronger one.
const PEAK_FLOOR: f64 = 0.1;
/// Closer than this to the stretcher's own rate, the read position is not shifted at all (so 1.0x stays exact).
const NEUTRAL_RATE: f64 = 1e-6;
/// The furthest a grain is aimed from the score's source position, in source frames.
const MAX_AIM: f64 = 8192.0;
/// The spacing and number of the coarse search positions for a search radius (see MAX_RADIUS).
fn search_shape(radius: i32) -> (i32, usize) {
    let stride = ((2 * radius) as usize).div_ceil(COARSE_POINTS - 1).max(4) as i32;
    (stride, ((2 * radius) / stride) as usize + 1)
}
struct Transient {
    frame: usize,
    score_seconds: f64,
    sample: [f32; 2],
}
pub struct BackingVoice {
    audio: Arc<DecodedAudio>,
    map: BackingMap,
    step: f64,
    filter: BackingFilterDsp,
    processed: bool,
    output: [[f32; 2]; HOP],
    tail: [[f32; 2]; HOP],
    cursor: usize,
    primed: bool,
    transients: Vec<Transient>,
    transient_index: usize,
    previous_seconds: f64,
    /// Correlation of each coarse search position, kept so the search finds its peaks without allocating.
    scores: [f64; COARSE_POINTS],
    /// Where the last grain was read from, in source frames (for tests of the search).
    landed: f64,
}
impl BackingVoice {
    pub fn new(
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        sample_rate: u32,
    ) -> Result<Self, String> {
        Self::new_with_processing(audio, map, sample_rate, BackingProcessing::default())
    }
    pub fn new_with_processing(
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        sample_rate: u32,
        processing: BackingProcessing,
    ) -> Result<Self, String> {
        Self::new_with_processing_shifted(audio, map, sample_rate, processing, 0)
    }
    /// As `new_with_processing`, with the practice key shift `extra_semitones` added to the saved pitch. The saved
    /// `processing` is validated as it stands (the shift never loosens it) and is not rewritten; the total can reach
    /// 25 semitones either way. With a shift of 0 the pitch is exactly the saved value's.
    pub fn new_with_processing_shifted(
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        sample_rate: u32,
        processing: BackingProcessing,
        extra_semitones: i8,
    ) -> Result<Self, String> {
        processing.validate()?;
        if audio.sample_rate == 0
            || audio.frames.is_empty()
            || !(8000..=192000).contains(&sample_rate)
        {
            return Err("Invalid decoded backing audio or output sample rate.".into());
        }
        if let Some(reference) = &map.reference {
            reference.validate_audio(&audio)?;
        }
        let frame = |index: usize| {
            if map.permits_frame(index, audio.sample_rate) {
                audio.frames[index]
            } else {
                [0.0; 2]
            }
        };
        // Isolated impulses bypass grain overlap so slowdown cannot smear their clock position.
        let mut transients = Vec::new();
        for i in 32..audio.frames.len().saturating_sub(32) {
            if !map.permits_frame(i, audio.sample_rate) {
                continue;
            }
            let sample = frame(i);
            let peak = sample[0].abs().max(sample[1].abs());
            if peak < 0.05
                || frame(i - 1)
                    .iter()
                    .chain(frame(i + 1).iter())
                    .any(|x| x.abs() > peak * 0.2)
            {
                continue;
            }
            let rms = ((i - 32..i + 32)
                .map(|index| {
                    let x = frame(index);
                    x[0] * x[0] + x[1] * x[1]
                })
                .sum::<f32>()
                / 128.0)
                .sqrt();
            if peak > rms * 6.0 {
                transients.push(Transient {
                    frame: i,
                    score_seconds: map.frame_score_seconds(i, audio.sample_rate),
                    sample,
                });
            }
        }
        let mut step = audio.sample_rate as f64 / sample_rate as f64;
        let pitch = if extra_semitones == 0 {
            processing.semitones + processing.cents / 100.0
        } else {
            // Whole cents, summed as integers and divided once, so a cancelling pair is exactly neutral.
            let cents = processing.semitones as i64 * 100
                + processing.cents as i64
                + i64::from(extra_semitones) * 100;
            cents as f64 / 100.0
        };
        if pitch != 0.0 {
            step *= 2.0_f64.powf(pitch / 12.0);
        }
        Ok(Self {
            step,
            filter: BackingFilterDsp::new(processing.filter, sample_rate)?,
            processed: pitch != 0.0 || processing.filter != BackingFilter::None,
            audio,
            map,
            output: [[0.0; 2]; HOP],
            tail: [[0.0; 2]; HOP],
            cursor: HOP,
            primed: false,
            transients,
            transient_index: 0,
            previous_seconds: f64::NEG_INFINITY,
            scores: [0.0; COARSE_POINTS],
            landed: 0.0,
        })
    }
    fn source_frame(&self, index: i64) -> [f32; 2] {
        if index < 0
            || index as usize >= self.audio.frames.len()
            || !self
                .map
                .permits_frame(index as usize, self.audio.sample_rate)
        {
            return [0.0; 2];
        }
        if self
            .transients
            .binary_search_by_key(&(index as usize), |t| t.frame)
            .is_ok()
        {
            return [0.0; 2];
        }
        self.audio.frames[index as usize]
    }
    fn sample(&self, position: f64) -> [f32; 2] {
        let i = position.floor() as i64;
        let f = (position - i as f64) as f32;
        let a = self.source_frame(i);
        let b = self.source_frame(i + 1);
        std::array::from_fn(|c| a[c] * (1.0 - f) + b[c] * f)
    }
    /// How far from the score's own source position a grain should start so that what is heard sits on the score
    /// clock. A grain reads `step` source frames per output frame (the key shift and the file's rate change it) while
    /// the clock advances `rate` of them (practice speed and a sync map's slope), so the read position drifts from the
    /// clock by (step - rate) per output frame whenever the two differ, and the stretcher is then stretching in time:
    /// at any speed, with or without a key shift or a map slope, in playback and in export alike. The first half of a
    /// grain's output is the previous grain's continuation crossfaded into this one, so what is heard averages that
    /// drift over about HOP frames: starting (HOP - 0.5) * (rate - step) away puts the average on the clock. The aim
    /// is not limited to what the search window reaches, because the window is centred on it; only an absurd rate
    /// (more than MAX_AIM source frames away) is cut short. Zero for the first grain after a seek (it starts exactly
    /// on the clock) and where rate and step are equal, which is an unshifted voice at 100% speed on a slope-1 map:
    /// there nothing is stretched and the output is bit-identical to what it was before the re-centring.
    fn grain_bias(&self, seconds: f64) -> f64 {
        let dt = seconds - self.previous_seconds;
        if !self.primed || !(dt > 0.0 && dt < 0.05) {
            return 0.0;
        }
        let per_call = (self.map.source_seconds(seconds)
            - self.map.source_seconds(self.previous_seconds))
            * self.audio.sample_rate as f64;
        // The previous call was the previous output frame, so this is source frames per output frame.
        let rate = per_call;
        if !rate.is_finite() || (rate - self.step).abs() < NEUTRAL_RATE {
            return 0.0;
        }
        ((HOP as f64 - 0.5) * (rate - self.step)).clamp(-MAX_AIM, MAX_AIM)
    }
    /// The normalised correlation between the previous grain's continuation and what a grain read from `position` would
    /// hold, from every fourth frame.
    fn correlation(&self, position: f64, tail_energy: f64) -> f64 {
        let (mut cross, mut energy) = (0.0, 0.0);
        for i in (0..HOP).step_by(4) {
            let x = self.sample(position + i as f64 * self.step);
            let y = self.tail[i];
            cross += (x[0] * y[0] + x[1] * y[1]) as f64;
            energy += (x[0] * x[0] + x[1] * x[1]) as f64;
        }
        cross / (energy * tail_energy).sqrt().max(1e-12)
    }
    fn prepare_grain(&mut self, seconds: f64) {
        let natural = self.map.source_seconds(seconds) * self.audio.sample_rate as f64;
        let radius = (HOP as f64 * self.step).ceil().min(MAX_RADIUS) as i32;
        let aim = natural + self.grain_bias(seconds);
        let mut best = aim;
        let tail_energy = self
            .tail
            .iter()
            .step_by(4)
            .map(|x| (x[0] * x[0] + x[1] * x[1]) as f64)
            .sum::<f64>();
        if self.primed
            && tail_energy > 1e-10
            && natural >= 0.0
            && natural < self.audio.frames.len() as f64
        {
            // Coarse: score the window and take the best correlation PEAK by height less the pull toward the aim.
            let (stride, points) = search_shape(radius);
            for k in 0..points {
                let delta = -radius + k as i32 * stride;
                self.scores[k] = self.correlation(aim + delta as f64, tail_energy);
            }
            let top = self.scores[..points]
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            // A run of exactly equal scores (digital silence, or a signal whose period divides the coarse step) is one
            // peak, and the point of it nearest the aim stands for it.
            let nearest = (radius as usize).div_ceil(stride as usize) as i32;
            let nearest = if (nearest * stride - radius) > (radius - (nearest - 1) * stride) {
                nearest - 1
            } else {
                nearest
            } as usize;
            let mut chosen = (f64::NEG_INFINITY, 0usize);
            let mut start = 0;
            while start < points {
                let score = self.scores[start];
                let mut end = start;
                while end + 1 < points && self.scores[end + 1] == score {
                    end += 1;
                }
                let peak = (start == 0 || self.scores[start - 1] < score)
                    && (end + 1 == points || self.scores[end + 1] < score);
                if peak && score >= top - PEAK_FLOOR {
                    let at = nearest.clamp(start, end);
                    let grains = (-radius + at as i32 * stride) as f64 / HOP as f64;
                    let value = score - PULL_COST * grains * grains;
                    if value > chosen.0 {
                        chosen = (value, at);
                    }
                }
                start = end + 1;
            }
            let coarse = aim + (-radius + chosen.1 as i32 * stride) as f64;
            // Fine: single frames within one coarse step of the peak, whichever matches best.
            let mut best_score = self.scores[chosen.1];
            best = coarse;
            for delta in -(stride - 1)..stride {
                if delta == 0 {
                    continue;
                }
                let candidate = coarse + delta as f64;
                let score = self.correlation(candidate, tail_energy);
                if score > best_score {
                    best_score = score;
                    best = candidate;
                }
            }
        }
        self.landed = best;
        for i in 0..HOP {
            let head = self.sample(best + i as f64 * self.step);
            let t = i as f32 / HOP as f32;
            self.output[i] = if self.primed {
                std::array::from_fn(|c| self.tail[i][c] * (1.0 - t) + head[c] * t)
            } else {
                head
            };
            self.tail[i] = self.sample(best + (i + HOP) as f64 * self.step);
        }
        self.cursor = 0;
        self.primed = true;
    }
    pub fn next_frame(&mut self, score_seconds: f64) -> [f32; 2] {
        if !score_seconds.is_finite() {
            self.filter.reset();
            return [0.0; 2];
        }
        let source = self.map.source_seconds(score_seconds);
        if !source.is_finite() || !self.map.permits_source(source) {
            self.filter.reset();
            return [0.0; 2];
        }
        if self.cursor == HOP {
            self.prepare_grain(score_seconds);
        }
        let excluded = source < 0.0
            || source >= self.audio.frames.len() as f64 / self.audio.sample_rate as f64;
        let mut x = if excluded {
            [0.0; 2]
        } else {
            self.output[self.cursor]
        };
        while let Some(t) = self.transients.get(self.transient_index) {
            if t.score_seconds > score_seconds {
                break;
            }
            if t.score_seconds > self.previous_seconds {
                for c in 0..2 {
                    x[c] += t.sample[c];
                }
            }
            self.transient_index += 1;
        }
        self.previous_seconds = score_seconds;
        self.cursor += 1;
        if excluded || x.iter().any(|v| !v.is_finite()) {
            self.filter.reset();
            // Neutral callers retain the legacy cursor/transient and sanitization path.
            return if self.processed {
                [0.0; 2]
            } else {
                x.map(|v| if v.is_finite() { v } else { 0.0 })
            };
        }
        self.filter.process(x)
    }
    pub(crate) fn reset_filter(&mut self) {
        self.filter.reset();
    }
    pub fn seek(&mut self, seconds: f64) {
        self.filter.reset();
        self.cursor = HOP;
        self.primed = false;
        self.output.fill([0.0; 2]);
        self.tail.fill([0.0; 2]);
        self.transient_index = self
            .transients
            .partition_point(|t| t.score_seconds < seconds);
        self.previous_seconds = seconds - 1e-9;
    }
    pub fn end_seconds(&self) -> f64 {
        if let Some(reference) = &self.map.reference {
            return reference.score_seconds(reference.exit_source_seconds());
        }
        self.map
            .score_seconds(self.audio.frames.len() as f64 / self.audio.sample_rate as f64)
    }
}

#[cfg(test)]
mod search_bound_tests {
    use super::*;
    #[test]
    fn the_search_does_at_most_two_hundred_correlations_whatever_the_step() {
        // From a file at 8 kHz played at 192 kHz (step 1/24) to one at 192 kHz played at 8 kHz, +25 semitones.
        let mut step = 1.0 / 24.0;
        let mut worst = 0;
        while step < 24.0 * 4.5 {
            let radius = (HOP as f64 * step).ceil().min(MAX_RADIUS) as i32;
            let (stride, points) = search_shape(radius);
            assert!(points <= COARSE_POINTS && stride >= 4, "step {step}");
            // The coarse positions reach the whole window, and the fine search covers the gap between them.
            assert!(
                -radius + (points as i32 - 1) * stride > radius - stride,
                "step {step}"
            );
            let work = points + 2 * (stride as usize - 1);
            worst = worst.max(work);
            if step == 1.0 {
                assert_eq!(work, 135);
            }
            step *= 1.01;
        }
        assert!(worst <= 200, "{worst}");
        assert_eq!(search_shape(256), (4, 129));
    }
}

#[cfg(test)]
mod plateau_tests {
    use super::*;
    fn voice(frames: Vec<[f32; 2]>) -> BackingVoice {
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"a","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[]})).unwrap();
        let mut voice = BackingVoice::new(
            Arc::new(DecodedAudio {
                sample_rate: 48_000,
                channels: 2,
                frames: Arc::new(frames),
            }),
            BackingMap::new(&[], 0.0, &plan).unwrap(),
            48_000,
        )
        .unwrap();
        // A grain after an earlier one, with the clock not moving between calls (so nothing is aimed away).
        voice.primed = true;
        voice.previous_seconds = f64::NEG_INFINITY;
        voice
    }
    #[test]
    fn a_grain_whose_candidates_are_all_silent_lands_on_the_aim_not_the_edge() {
        // The tail still sounds, every candidate reads digital silence: every score is equal, one flat run.
        let mut voice = voice(vec![[0.0; 2]; 20_000]);
        voice.tail = [[0.5; 2]; HOP];
        voice.prepare_grain(0.1);
        assert_eq!(voice.landed, 4800.0);
    }
    #[test]
    fn a_signal_whose_period_divides_the_coarse_step_lands_on_the_peak_nearest_the_aim() {
        // A period of 4 frames makes every coarse position score exactly the same: one flat run, whole window.
        let pattern = [0.5f32, 0.25, -0.5, -0.25];
        let mut voice = voice((0..20_000).map(|n| [pattern[n % 4]; 2]).collect());
        for i in 0..HOP {
            voice.tail[i] = [pattern[i % 4]; 2];
        }
        voice.prepare_grain(0.1);
        assert_eq!(voice.landed, 4800.0);
    }
}
