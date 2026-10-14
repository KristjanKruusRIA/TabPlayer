use super::{
    decode::DecodedAudio,
    plan::{PlaybackPlan, Timeline},
};
use crate::settings::SyncAnchor;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct BackingMap {
    points: Vec<(f64, f64)>,
    offset: f64,
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
        })
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
        self.interpolate(score_seconds, false) - self.offset
    }
    pub fn score_seconds(&self, source_seconds: f64) -> f64 {
        self.interpolate(source_seconds + self.offset, true)
    }
}
const HOP: usize = 256;
struct Transient {
    frame: usize,
    score_seconds: f64,
    sample: [f32; 2],
}
pub struct BackingVoice {
    audio: Arc<DecodedAudio>,
    map: BackingMap,
    step: f64,
    output: [[f32; 2]; HOP],
    tail: [[f32; 2]; HOP],
    cursor: usize,
    primed: bool,
    transients: Vec<Transient>,
    transient_index: usize,
    previous_seconds: f64,
}
impl BackingVoice {
    pub fn new(
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        sample_rate: u32,
    ) -> Result<Self, String> {
        if audio.sample_rate == 0
            || audio.frames.is_empty()
            || !(8000..=192000).contains(&sample_rate)
        {
            return Err("Invalid decoded backing audio or output sample rate.".into());
        }
        // Isolated impulses bypass grain overlap so slowdown cannot smear their clock position.
        let mut transients = Vec::new();
        for i in 32..audio.frames.len().saturating_sub(32) {
            let peak = audio.frames[i][0].abs().max(audio.frames[i][1].abs());
            if peak < 0.05
                || audio.frames[i - 1]
                    .iter()
                    .chain(audio.frames[i + 1].iter())
                    .any(|x| x.abs() > peak * 0.2)
            {
                continue;
            }
            let rms = (audio.frames[i - 32..i + 32]
                .iter()
                .map(|x| x[0] * x[0] + x[1] * x[1])
                .sum::<f32>()
                / 128.0)
                .sqrt();
            if peak > rms * 6.0 {
                transients.push(Transient {
                    frame: i,
                    score_seconds: map.score_seconds(i as f64 / audio.sample_rate as f64),
                    sample: audio.frames[i],
                });
            }
        }
        Ok(Self {
            step: audio.sample_rate as f64 / sample_rate as f64,
            audio,
            map,
            output: [[0.0; 2]; HOP],
            tail: [[0.0; 2]; HOP],
            cursor: HOP,
            primed: false,
            transients,
            transient_index: 0,
            previous_seconds: f64::NEG_INFINITY,
        })
    }
    fn source_frame(&self, index: i64) -> [f32; 2] {
        if index < 0 || index as usize >= self.audio.frames.len() {
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
    fn prepare_grain(&mut self, seconds: f64) {
        let expected = self.map.source_seconds(seconds) * self.audio.sample_rate as f64;
        let mut best = expected;
        let tail_energy = self
            .tail
            .iter()
            .step_by(4)
            .map(|x| (x[0] * x[0] + x[1] * x[1]) as f64)
            .sum::<f64>();
        if self.primed
            && tail_energy > 1e-10
            && expected >= 0.0
            && expected < self.audio.frames.len() as f64
        {
            let radius = (HOP as f64 * self.step).ceil() as i32;
            let mut best_score = f64::NEG_INFINITY;
            for delta in (-radius..=radius).step_by(4) {
                let candidate = expected + delta as f64;
                let mut cross = 0.0;
                let mut energy = 0.0;
                for i in (0..HOP).step_by(4) {
                    let x = self.sample(candidate + i as f64 * self.step);
                    let y = self.tail[i];
                    cross += (x[0] * y[0] + x[1] * y[1]) as f64;
                    energy += (x[0] * x[0] + x[1] * x[1]) as f64;
                }
                let score =
                    cross / (energy * tail_energy).sqrt().max(1e-12) - 1e-7 * (delta as f64).abs();
                if score > best_score {
                    best_score = score;
                    best = candidate;
                }
            }
            // Refine at source-frame precision after the coarse correlation search.
            let coarse = best;
            for delta in -3..=3 {
                let candidate = coarse + delta as f64;
                let mut cross = 0.0;
                let mut energy = 0.0;
                for i in (0..HOP).step_by(4) {
                    let x = self.sample(candidate + i as f64 * self.step);
                    let y = self.tail[i];
                    cross += (x[0] * y[0] + x[1] * y[1]) as f64;
                    energy += (x[0] * x[0] + x[1] * x[1]) as f64;
                }
                let score = cross / (energy * tail_energy).sqrt().max(1e-12)
                    - 1e-7 * (candidate - expected).abs();
                if score > best_score {
                    best_score = score;
                    best = candidate;
                }
            }
        }
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
            return [0.0; 2];
        }
        if self.cursor == HOP {
            self.prepare_grain(score_seconds);
        }
        let source = self.map.source_seconds(score_seconds);
        let mut x = if source < 0.0
            || source >= self.audio.frames.len() as f64 / self.audio.sample_rate as f64
        {
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
        x.map(|v| if v.is_finite() { v } else { 0.0 })
    }
    pub fn seek(&mut self, seconds: f64) {
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
        self.map
            .score_seconds(self.audio.frames.len() as f64 / self.audio.sample_rate as f64)
    }
}
