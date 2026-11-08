//! Delay compensation across stems (THE-71, Task 12).
//!
//! Delays dry tracks, the backing track and click by `D_max - D_i` so all stems align at `D_max`.
//! Kept continuous across loop wraps and drained at count-in and end of score.

use tabplayer_plugin_protocol::limits::{MAX_PIPELINE_FRAMES, max_latency_frames};

/// Default capacity for delay lines at sample rate `rate`: `8,192 + ceil(0.1 × rate) + 64`.
pub fn compensation_capacity(rate: u32) -> usize {
    MAX_PIPELINE_FRAMES + max_latency_frames(rate) as usize + 64
}

/// A stereo delay line with preallocated circular buffer and tap crossfade.
#[derive(Clone, Debug)]
pub struct DelayLine {
    buf: Vec<[f32; 2]>,
    write_pos: usize,
    delay: usize,
    old_delay: usize,
    crossfading: bool,
    fade_frames: usize,
    fade_remaining: usize,
}

impl DelayLine {
    pub fn new(delay: usize, capacity: usize, ramp_frames: usize) -> Self {
        let cap = capacity.max(delay + 64);
        Self {
            buf: vec![[0.0; 2]; cap],
            write_pos: 0,
            delay,
            old_delay: delay,
            crossfading: false,
            fade_frames: ramp_frames.max(1),
            fade_remaining: 0,
        }
    }

    pub fn delay(&self) -> usize {
        self.delay
    }

    pub fn flush(&mut self) {
        self.buf.fill([0.0; 2]);
        self.write_pos = 0;
        self.crossfading = false;
        self.fade_remaining = 0;
    }

    #[inline]
    pub fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        let cap = self.buf.len();
        let out = if !self.crossfading {
            if self.delay == 0 {
                x
            } else {
                let read_idx = if self.write_pos >= self.delay {
                    self.write_pos - self.delay
                } else {
                    self.write_pos + cap - self.delay
                };
                self.buf[read_idx]
            }
        } else {
            let old_sample = if self.old_delay == 0 {
                x
            } else {
                let read_idx = if self.write_pos >= self.old_delay {
                    self.write_pos - self.old_delay
                } else {
                    self.write_pos + cap - self.old_delay
                };
                self.buf[read_idx]
            };
            let new_sample = if self.delay == 0 {
                x
            } else {
                let read_idx = if self.write_pos >= self.delay {
                    self.write_pos - self.delay
                } else {
                    self.write_pos + cap - self.delay
                };
                self.buf[read_idx]
            };
            let alpha = self.fade_remaining as f32 / self.fade_frames as f32;
            let sample = [
                old_sample[0] * alpha + new_sample[0] * (1.0 - alpha),
                old_sample[1] * alpha + new_sample[1] * (1.0 - alpha),
            ];
            self.fade_remaining -= 1;
            if self.fade_remaining == 0 {
                self.crossfading = false;
            }
            sample
        };

        self.buf[self.write_pos] = x;
        self.write_pos += 1;
        if self.write_pos >= cap {
            self.write_pos = 0;
        }
        out
    }

    pub fn transition_from(&mut self, old: &mut Self) {
        std::mem::swap(&mut self.buf, &mut old.buf);
        self.write_pos = old.write_pos;
        if self.delay != old.delay {
            self.old_delay = old.delay;
            self.crossfading = true;
            self.fade_remaining = self.fade_frames;
        } else {
            self.crossfading = false;
            self.fade_remaining = 0;
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
    _capacity: usize,
    _ramp_frames: usize,
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
            _capacity: cap,
            _ramp_frames: ramp_frames,
        }
    }

    /// The maximum delay `D_max` among all stems.
    pub fn d_max(&self) -> usize {
        self.d_max
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

    /// Takes over running history from `old` and crossfades taps over 10 ms for any changed delay.
    pub fn transition_from(&mut self, old: &mut Self) {
        for (new_line, old_line) in self.track_lines.iter_mut().zip(&mut old.track_lines) {
            new_line.transition_from(old_line);
        }
        self.backing_line.transition_from(&mut old.backing_line);
        self.click_line.transition_from(&mut old.click_line);
    }
}
