//! Delay compensation across stems (THE-71, Task 12).
//!
//! Delays dry tracks, the backing track and click by `D_max - D_i` so all stems align at `D_max`.
//! Kept continuous across loop wraps and drained at count-in and end of score.

use tabplayer_plugin_protocol::limits::{MAX_PIPELINE_FRAMES, max_latency_frames};

/// Default capacity for delay lines at sample rate `rate`: `8,192 + ceil(0.1 × rate) + 64`.
pub fn compensation_capacity(rate: u32) -> usize {
    MAX_PIPELINE_FRAMES + max_latency_frames(rate) as usize + 64
}

/// A stereo delay line with preallocated circular buffer and smooth tap crossfade.
#[derive(Clone, Debug)]
pub struct DelayLine {
    buf: Vec<[f32; 2]>,
    write_pos: usize,
    history: usize,
    timing_from: usize,
    timing_to: usize,
    timing_s: f32,
    timing_goal: usize,
    ramp_frames: usize,
    delay: usize,
}

impl DelayLine {
    pub fn new(delay: usize, capacity: usize, ramp_frames: usize) -> Self {
        let cap = capacity.max(delay + 64);
        Self {
            buf: vec![[0.0; 2]; cap],
            write_pos: 0,
            history: delay + 1,
            timing_from: delay,
            timing_to: delay,
            timing_s: 1.0,
            timing_goal: delay,
            ramp_frames: ramp_frames.max(1),
            delay,
        }
    }

    pub fn delay(&self) -> usize {
        self.delay
    }

    pub fn gliding(&self) -> bool {
        self.timing_from != self.timing_to || self.timing_to != self.timing_goal
    }

    pub fn flush(&mut self) {
        // After a flush the line claims `delay + 1` frames of silent history, the frames just behind the write
        // position. Reads never reach further back than the history, which grows only as new frames overwrite the
        // buffer from the start, so only those frames need zeroing, not the whole buffer.
        let span = self.buf.len();
        let from = span.saturating_sub(self.delay + 1);
        if let Some(stale) = self.buf.get_mut(from..) {
            stale.fill([0.0; 2]);
        }
        self.write_pos = 0;
        self.history = self.delay + 1;
        self.timing_from = self.delay;
        self.timing_to = self.delay;
        self.timing_s = 1.0;
        self.timing_goal = self.delay;
    }

    /// Prepares the line to start undelayed when introduced mid-play while the board is sounding.
    pub fn start_undelayed(&mut self) {
        self.history = 0;
        self.timing_from = 0;
        self.timing_to = 0;
        self.timing_s = 1.0;
        self.timing_goal = self.delay;
    }

    /// Retimes the line to a new delay, starting a crossfade as soon as enough history exists.
    pub fn retime_to(&mut self, delay: usize) {
        self.delay = delay;
        self.timing_goal = delay;
        if self.timing_from == self.timing_to && self.timing_goal < self.history {
            self.timing_to = self.timing_goal;
            self.timing_s = 0.0;
        }
    }

    /// Takes over buffer history from `old` and retimes to `self.delay`.
    pub fn transition_from(&mut self, old: &mut Self) {
        std::mem::swap(&mut self.buf, &mut old.buf);
        self.write_pos = old.write_pos;
        self.history = old.history;
        self.timing_from = old.timing_from;
        self.timing_to = old.timing_to;
        self.timing_s = old.timing_s;
        self.timing_goal = self.delay;
        if self.timing_from == self.timing_to && self.timing_goal < self.history {
            self.timing_to = self.timing_goal;
            self.timing_s = 0.0;
        }
    }

    /// The input `back` frames before the current one (0: the current one).
    fn sample_at(&self, back: usize) -> [f32; 2] {
        let span = self.buf.len();
        let index = (self.write_pos + span - 1 - back.min(span - 1)) % span;
        self.buf.get(index).copied().unwrap_or([0.0; 2])
    }

    #[inline]
    pub fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        let span = self.buf.len();
        if let Some(slot) = self.buf.get_mut(self.write_pos) {
            *slot = x;
        }
        self.write_pos = (self.write_pos + 1) % span;
        self.history = (self.history + 1).min(span);

        if self.timing_s >= 1.0 {
            self.timing_from = self.timing_to;
        }
        if self.timing_from == self.timing_to
            && self.timing_to != self.timing_goal
            && self.timing_goal < self.history
        {
            self.timing_to = self.timing_goal;
            self.timing_s = 0.0;
        }

        if self.timing_from == self.timing_to {
            self.sample_at(self.timing_to)
        } else {
            self.timing_s = (self.timing_s + 1.0 / self.ramp_frames as f32).min(1.0);
            let a = self.sample_at(self.timing_from);
            let b = self.sample_at(self.timing_to);
            let s = self.timing_s;
            [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]
        }
    }
}

/// Delay compensation stage for all stems.
#[derive(Clone, Debug)]
pub struct Compensation {
    track_lines: Vec<DelayLine>,
    backing_line: DelayLine,
    click_line: DelayLine,
    d_max: usize,
}

impl Compensation {
    /// Builds compensation for tracks with latencies `track_delays` and preallocated `capacity`.
    pub fn new(track_delays: &[usize], capacity: usize) -> Self {
        Self::new_with_rate(track_delays, capacity, 48_000)
    }

    /// Builds compensation with sample rate specified for exact ramp length.
    pub fn new_with_rate(track_delays: &[usize], capacity: usize, rate: u32) -> Self {
        let d_max = *track_delays.iter().max().unwrap_or(&0);
        let ramp_frames = (rate as f64 * 0.01).round() as usize;
        let cap = capacity.max(d_max + 64);
        let mut track_lines = Vec::with_capacity(track_delays.len());
        for &d_i in track_delays {
            let delay = d_max.saturating_sub(d_i);
            track_lines.push(DelayLine::new(delay, cap, ramp_frames));
        }
        let backing_line = DelayLine::new(d_max, cap, ramp_frames);
        let click_line = DelayLine::new(d_max, cap, ramp_frames);
        Self {
            track_lines,
            backing_line,
            click_line,
            d_max,
        }
    }

    /// The maximum delay `D_max` among all stems.
    pub fn d_max(&self) -> usize {
        self.d_max
    }

    /// Whether any delay line is currently crossfading or waiting to crossfade to a new tap.
    pub fn gliding(&self) -> bool {
        self.track_lines.iter().any(|l| l.gliding())
            || self.backing_line.gliding()
            || self.click_line.gliding()
    }

    /// Whether the stage still does anything. One left behind by removing the last plug-in delays nothing once its
    /// glide to zero has ended, and then plays exactly as no compensation does.
    pub fn active(&self) -> bool {
        self.d_max > 0 || self.gliding()
    }

    /// Delays track `i` by `D_max - D_i`.
    pub fn track(&mut self, i: usize, x: [f32; 2]) -> [f32; 2] {
        if let Some(line) = self.track_lines.get_mut(i) {
            line.process(x)
        } else {
            x
        }
    }

    /// Delays the backing track by `D_max`.
    pub fn backing(&mut self, x: [f32; 2]) -> [f32; 2] {
        self.backing_line.process(x)
    }

    /// Delays the metronome click by `D_max`.
    pub fn click(&mut self, x: [f32; 2]) -> [f32; 2] {
        self.click_line.process(x)
    }

    /// Flushes all delay lines with silence on a user seek or stop.
    pub fn flush(&mut self) {
        for line in &mut self.track_lines {
            line.flush();
        }
        self.backing_line.flush();
        self.click_line.flush();
    }

    /// Prepares all lines to start undelayed and glide to `delay` once history is accumulated.
    pub fn start_undelayed(&mut self) {
        for line in &mut self.track_lines {
            line.start_undelayed();
        }
        self.backing_line.start_undelayed();
        self.click_line.start_undelayed();
    }

    /// Retimes all lines to 0 delay, crossfading back to real-time.
    pub fn retime_to_zero(&mut self) {
        self.d_max = 0;
        for line in &mut self.track_lines {
            line.retime_to(0);
        }
        self.backing_line.retime_to(0);
        self.click_line.retime_to(0);
    }

    /// Takes over running history from `old` and crossfades taps over 10 ms for any changed delay.
    pub fn transition_from(&mut self, old: &mut Self) {
        for (new_line, old_line) in self.track_lines.iter_mut().zip(&mut old.track_lines) {
            new_line.transition_from(old_line);
        }
        self.backing_line.transition_from(&mut old.backing_line);
        self.click_line.transition_from(&mut old.click_line);
    }
}
