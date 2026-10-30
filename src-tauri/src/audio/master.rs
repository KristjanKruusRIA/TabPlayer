//! The song-level chain on the mixed output: a compressor, an EQ and a reverb on the tracks and backing, the overall
//! level and balance, and a limiter on everything that sounds.
//!
//! Like a track's sound, a master's settings resolve off the audio thread into a `MasterBus`, and `process` only reads
//! one: it allocates nothing, takes no lock and touches no file. A new bus takes over from the old one through
//! `transition_from`, which crossfades the effects (the pedalboard does that itself), glides the level, and carries the
//! limiter's gain across, so changing a setting while it plays does not click.
//!
//! With the defaults the bus changes nothing: it hands its input back untouched, so the mix is bit for bit what it was
//! before the master existed.
use super::dsp::TrackDsp;
use crate::settings::MasterSettings;

/// How long a level change glides, matching the pedalboard's crossfade.
const RAMP_SECONDS: f64 = 0.01;
/// The pedalboard's delay storage. The master has no delay block, so this only has to be allowed.
const BOARD_DELAY_SECONDS: f64 = 0.05;
/// A switched-off limiter's ceiling, far above any sample a mix can hold.
const OFF_CEILING: f64 = 1.0e6;
/// How quickly a switched-off limiter lets go of the gain it holds, so it is soon out of the signal.
const OFF_RELEASE_SECONDS: f64 = 0.02;

/// The overall level and balance as a gain per channel, gliding to a new one.
#[derive(Clone, Copy)]
struct Level {
    current: [f32; 2],
    target: [f32; 2],
    remaining: u32,
}
impl Level {
    const UNITY: [f32; 2] = [1.0; 2];
    fn new(settings: &MasterSettings) -> Self {
        let gain = 10f64.powf(settings.gain_db / 20.0);
        // Balance turns one side down and leaves the other, so a centred one is exactly unity.
        let target = [
            gain * (1.0 - settings.balance.max(0.0)),
            gain * (1.0 + settings.balance.min(0.0)),
        ]
        .map(|g| g as f32);
        Self {
            current: target,
            target,
            remaining: 0,
        }
    }
    /// Whether it passes its input as it is.
    #[inline]
    fn unity(&self) -> bool {
        self.current == Self::UNITY && self.target == Self::UNITY
    }
    #[inline]
    fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        if self.remaining > 0 {
            self.remaining -= 1;
            if self.remaining == 0 {
                self.current = self.target;
            } else {
                for c in 0..2 {
                    self.current[c] +=
                        (self.target[c] - self.current[c]) / (self.remaining + 1) as f32;
                }
            }
        }
        std::array::from_fn(|c| x[c] * self.current[c])
    }
}

/// A peak limiter with an instant attack and no lookahead, so it adds no delay and nothing it passes is over its
/// ceiling: the gain drops to what the loudest channel's sample needs the moment it is needed, and recovers with the
/// release time.
#[derive(Clone, Copy)]
struct Limiter {
    enabled: bool,
    ceiling: f64,
    ceiling32: f32,
    /// The share of the way back to unity gain covered each frame.
    release: f64,
    gain: f64,
}
impl Limiter {
    fn new(settings: &MasterSettings, rate: f64) -> Self {
        let (ceiling, seconds) = if settings.limiter.enabled {
            (
                10f64.powf(settings.limiter.ceiling_db / 20.0),
                settings.limiter.release_ms * 0.001,
            )
        } else {
            (OFF_CEILING, OFF_RELEASE_SECONDS)
        };
        Self {
            enabled: settings.limiter.enabled,
            ceiling,
            ceiling32: ceiling as f32,
            release: 1.0 - (-1.0 / (rate * seconds)).exp(),
            gain: 1.0,
        }
    }
    /// Whether it is off and holds no gain, so it passes its input as it is.
    #[inline]
    fn idle(&self) -> bool {
        !self.enabled && self.gain == 1.0
    }
    fn same_setting(&self, other: &Self) -> bool {
        self.enabled == other.enabled
            && self.ceiling == other.ceiling
            && self.release == other.release
    }
    #[inline]
    fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        let x = x.map(|v| if v.is_finite() { v } else { 0.0 });
        let peak = x[0].abs().max(x[1].abs()) as f64;
        let needed = if peak > self.ceiling {
            self.ceiling / peak
        } else {
            1.0
        };
        let released = self.gain + (1.0 - self.gain) * self.release;
        self.gain = if needed < released { needed } else { released };
        // Gain this close to unity is unity, so a limiter that is off finishes letting go.
        if 1.0 - self.gain < 1e-9 {
            self.gain = 1.0;
        }
        // The product can land one rounding above the ceiling; the clamp keeps the promise exactly.
        let limit = self.ceiling32;
        x.map(|v| ((v as f64 * self.gain) as f32).clamp(-limit, limit))
    }
}

/// One master configuration resolved for the audio thread.
pub struct MasterBus {
    /// The compressor, EQ and reverb. It is built whether or not any is on, so that a change to or from the master's
    /// effects always has a board to crossfade from, and is only run while one is on or fading.
    board: Box<TrackDsp>,
    board_on: bool,
    level: Level,
    limiter: Limiter,
    /// The limiter this one took over from, still running while `fade_left` frames remain. The two are crossfaded: a
    /// limiter switched on, or given a lower ceiling, would otherwise drop the gain in one frame, which is a click.
    leaving: Limiter,
    fade_left: u32,
    ramp_frames: u32,
}
impl MasterBus {
    /// `None` is a master that was never touched, which plays as the defaults do.
    pub fn new(settings: Option<&MasterSettings>, rate: u32) -> Result<Self, String> {
        let fallback;
        let settings = match settings {
            Some(settings) => settings,
            None => {
                fallback = MasterSettings::default();
                &fallback
            }
        };
        settings.validate()?;
        let hz = rate as f64;
        Ok(Self {
            board: Box::new(TrackDsp::new(settings.board(), rate, BOARD_DELAY_SECONDS)?),
            board_on: settings.compressor.enabled || settings.eq.enabled || settings.reverb.enabled,
            level: Level::new(settings),
            limiter: Limiter::new(settings, hz),
            leaving: Limiter::new(settings, hz),
            fade_left: 0,
            ramp_frames: (hz * RAMP_SECONDS) as u32,
        })
    }
    /// Takes over from the bus that is playing: the effects crossfade, the level glides from where it is, and the
    /// limiter carries on from the gain it holds. Moves state and allocates nothing.
    pub fn transition_from(&mut self, old: &mut Self) {
        self.board.transition_from(&mut old.board);
        self.level.current = old.level.current;
        self.level.remaining = if self.level.current == self.level.target {
            0
        } else {
            self.ramp_frames.max(1)
        };
        self.limiter.gain = old.limiter.gain;
        self.leaving = old.limiter;
        self.fade_left = if self.limiter.same_setting(&old.limiter) {
            0
        } else {
            self.ramp_frames.max(1)
        };
    }
    /// Whether a change is still gliding or crossfading. A bus that took over now would cut it short.
    pub fn ramping(&self) -> bool {
        self.board.ramping() || self.level.remaining > 0 || self.fade_left > 0
    }
    /// A seek: the effects' tails and the limiter's gain start over.
    pub fn reset(&mut self) {
        self.board.reset();
        self.limiter.gain = 1.0;
        self.leaving.gain = 1.0;
    }
    /// The tracks and backing, mixed, through the effects and the level.
    #[inline]
    pub fn bus(&mut self, x: [f32; 2], bpm: f64) -> [f32; 2] {
        let mut y = x;
        if self.board_on || self.board.ramping() {
            y = self.board.process(y, bpm);
        }
        if !self.level.unity() {
            y = self.level.process(y);
        }
        y
    }
    /// Everything that sounds, the metronome included, under the ceiling. For the ramp after a change to the limiter,
    /// the output is a blend of the old limiter and the new, so it is under the higher of their ceilings, and under
    /// the new one from then on.
    #[inline]
    pub fn limit(&mut self, x: [f32; 2]) -> [f32; 2] {
        if self.fade_left > 0 {
            return self.crossfade(x);
        }
        if self.limiter.idle() {
            x
        } else {
            self.limiter.process(x)
        }
    }
    fn crossfade(&mut self, x: [f32; 2]) -> [f32; 2] {
        let old = self.leaving.process(x);
        let new = self.limiter.process(x);
        self.fade_left -= 1;
        let weight = 1.0 - (self.fade_left as f32 / self.ramp_frames.max(1) as f32);
        std::array::from_fn(|c| old[c] + (new[c] - old[c]) * weight)
    }
}
