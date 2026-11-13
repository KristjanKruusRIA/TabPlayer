use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PracticeTempo {
    Relative {
        ratio: f64,
    },
    Fixed {
        bpm: f64,
    },
    Progressive {
        start: f64,
        end: f64,
        step: f64,
        repetitions: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetronomeSettings {
    pub enabled: bool,
    pub volume: f64,
    pub visual: bool,
    /// Settings written before the sound could be chosen have no field and keep the original beep.
    #[serde(default)]
    pub sound: ClickSound,
}

/// The metronome's timbre. Each is synthesised on the audio thread without allocation or assets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClickSound {
    #[default]
    Beep,
    Woodblock,
    Cowbell,
    Stick,
}

impl ClickSound {
    pub fn code(self) -> u8 {
        match self {
            Self::Beep => 0,
            Self::Woodblock => 1,
            Self::Cowbell => 2,
            Self::Stick => 3,
        }
    }
    /// The (normal, accented) frequency in Hz and the length in seconds of one click. Every caller that needs a click's
    /// length reads it here, so a ringing click is treated the same wherever it is started or restored.
    pub fn shape(self) -> (f64, f64, f64) {
        match self {
            Self::Beep => (1800.0, 2400.0, 0.05),
            Self::Woodblock => (1000.0, 1300.0, 0.06),
            Self::Cowbell => (540.0, 680.0, 0.16),
            Self::Stick => (1700.0, 2100.0, 0.03),
        }
    }
    pub fn seconds(self) -> f64 {
        self.shape().2
    }
    pub fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Woodblock,
            2 => Self::Cowbell,
            3 => Self::Stick,
            _ => Self::Beep,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CountInSettings {
    pub bars: u8,
    pub between_loops: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PracticeSettings {
    pub tempo: PracticeTempo,
    pub metronome: MetronomeSettings,
    pub count_in: CountInSettings,
    /// Playback-only key shift in whole semitones (-12 to 12). Settings written without it mean the original key.
    #[serde(default)]
    pub tonality: i8,
}

impl Default for PracticeSettings {
    fn default() -> Self {
        Self {
            tempo: PracticeTempo::Relative { ratio: 1.0 },
            metronome: MetronomeSettings {
                enabled: false,
                volume: 0.4,
                visual: false,
                sound: ClickSound::Beep,
            },
            count_in: CountInSettings {
                bars: 0,
                between_loops: false,
            },
            tonality: 0,
        }
    }
}

impl PracticeSettings {
    pub fn validate(&self, has_backing: bool) -> Result<(), &'static str> {
        let valid_ratio = |ratio: f64| ratio.is_finite() && (0.1..=3.0).contains(&ratio);
        match self.tempo {
            PracticeTempo::Relative { ratio } if !valid_ratio(ratio) => {
                return Err("Practice speed must be between 10% and 300%.");
            }
            PracticeTempo::Fixed { bpm } => {
                if !bpm.is_finite() || !(10.0..=300.0).contains(&bpm) {
                    return Err("Fixed tempo must be between 10 and 300 BPM.");
                }
                if has_backing {
                    return Err("Fixed tempo is unavailable while a backing track is present.");
                }
            }
            PracticeTempo::Progressive {
                start,
                end,
                step,
                repetitions,
            } => {
                if !valid_ratio(start) || !valid_ratio(end) || end < start {
                    return Err("Progressive speed must increase between 10% and 300%.");
                }
                if !step.is_finite() || step <= 0.0 || step > 2.9 {
                    return Err(
                        "Progressive increment must be greater than 0 and at most 290 percentage points.",
                    );
                }
                if !(1..=100).contains(&repetitions) {
                    return Err("Repetitions per speed must be between 1 and 100.");
                }
            }
            _ => {}
        }
        if !self.metronome.volume.is_finite() || !(0.0..=1.0).contains(&self.metronome.volume) {
            return Err("Metronome volume must be between 0% and 100%.");
        }
        if self.count_in.bars > 16 {
            return Err("Count-in must be between 0 and 16 bars.");
        }
        if !(-12..=12).contains(&self.tonality) {
            return Err("Key shift must be between -12 and 12 semitones.");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RenderTempo {
    Relative { ratio: f64 },
    Fixed { bpm: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PulsePosition {
    pub beat: u32,
    pub beats_per_bar: u32,
    pub accent: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CountInSnapshot {
    pub bars: u8,
    pub numerator: u32,
    pub denominator: u32,
    pub bpm: f64,
    pub rate: u32,
    pub total_frames: u64,
    pub elapsed_frames: u64,
    pub emitted_pulses: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CountFrame {
    pub pulse: Option<PulsePosition>,
    pub remaining: u32,
    pub finished: bool,
}

pub fn progressive_ratio(settings: &PracticeTempo, completed_passes: u64) -> f64 {
    match *settings {
        PracticeTempo::Progressive {
            start,
            end,
            step,
            repetitions,
        } => (start + (completed_passes / u64::from(repetitions)) as f64 * step).min(end),
        PracticeTempo::Relative { ratio } => ratio,
        PracticeTempo::Fixed { .. } => 1.0,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CountInClock {
    snapshot: CountInSnapshot,
    frames_per_pulse: f64,
    total_pulses: u32,
}

impl CountInClock {
    pub fn new(
        bars: u8,
        numerator: u32,
        denominator: u32,
        bpm: f64,
        rate: u32,
    ) -> Result<Self, &'static str> {
        if rate == 0 || !bpm.is_finite() || bpm <= 0.0 {
            return Err("Count-in needs a positive sample rate and finite positive tempo.");
        }
        if bars > 16
            || numerator == 0
            || !matches!(denominator, 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256)
        {
            return Err("Count-in meter or bar count is invalid.");
        }
        let total_pulses = numerator
            .checked_mul(u32::from(bars))
            .ok_or("Count-in pulse count exceeds its supported range.")?;
        let frames_per_pulse = 60.0 / bpm * 4.0 / f64::from(denominator) * f64::from(rate);
        let total_frames = if total_pulses == 0 {
            0
        } else {
            if !frames_per_pulse.is_finite() || frames_per_pulse < 1.0 {
                return Err("Count-in pulses must be at least one sample apart.");
            }
            let frames = (frames_per_pulse * f64::from(total_pulses)).round();
            if !frames.is_finite() || frames >= u64::MAX as f64 {
                return Err("Count-in duration exceeds its supported range.");
            }
            frames as u64
        };
        Ok(Self {
            snapshot: CountInSnapshot {
                bars,
                numerator,
                denominator,
                bpm,
                rate,
                total_frames,
                elapsed_frames: 0,
                emitted_pulses: 0,
            },
            frames_per_pulse,
            total_pulses,
        })
    }

    pub fn next_frame(&mut self) -> CountFrame {
        if self.snapshot.elapsed_frames >= self.snapshot.total_frames {
            return CountFrame {
                pulse: None,
                remaining: 0,
                finished: true,
            };
        }
        let pulse = if self.snapshot.emitted_pulses < self.total_pulses
            && self.snapshot.elapsed_frames
                >= (f64::from(self.snapshot.emitted_pulses) * self.frames_per_pulse).round() as u64
        {
            let beat = self.snapshot.emitted_pulses % self.snapshot.numerator;
            self.snapshot.emitted_pulses += 1;
            Some(PulsePosition {
                beat,
                beats_per_bar: self.snapshot.numerator,
                accent: beat == 0,
            })
        } else {
            None
        };
        self.snapshot.elapsed_frames += 1;
        CountFrame {
            pulse,
            remaining: self.total_pulses - self.snapshot.emitted_pulses + 1,
            finished: false,
        }
    }

    pub fn remaining_wall_seconds(&self) -> f64 {
        (self.snapshot.total_frames - self.snapshot.elapsed_frames) as f64
            / f64::from(self.snapshot.rate)
    }

    pub fn snapshot(&self) -> CountInSnapshot {
        self.snapshot
    }

    pub fn from_snapshot(snapshot: CountInSnapshot, rate: u32) -> Result<Self, &'static str> {
        let original = Self::new(
            snapshot.bars,
            snapshot.numerator,
            snapshot.denominator,
            snapshot.bpm,
            snapshot.rate,
        )?;
        let valid_total = |clock: &Self, total: u64| {
            if clock.total_pulses == 0 {
                total == 0
            } else {
                total > (f64::from(clock.total_pulses - 1) * clock.frames_per_pulse).round() as u64
            }
        };
        if snapshot.elapsed_frames > snapshot.total_frames
            || snapshot.emitted_pulses > original.total_pulses
            || !valid_total(&original, snapshot.total_frames)
        {
            return Err("Count-in snapshot position is invalid.");
        }
        let mut restored = Self::new(
            snapshot.bars,
            snapshot.numerator,
            snapshot.denominator,
            snapshot.bpm,
            rate,
        )?;
        // Keep both actual rounded boundaries. Recomputing the total from BPM can
        // lose several destination samples after a large sample-rate increase.
        let rescale = |frames: u64| {
            let scaled = (u128::from(frames) * u128::from(rate) + u128::from(snapshot.rate / 2))
                / u128::from(snapshot.rate);
            u64::try_from(scaled).map_err(|_| "Count-in duration exceeds its supported range.")
        };
        restored.snapshot.total_frames = rescale(snapshot.total_frames)?;
        restored.snapshot.elapsed_frames = rescale(snapshot.elapsed_frames)?;
        restored.snapshot.emitted_pulses = snapshot.emitted_pulses;
        if !valid_total(&restored, restored.snapshot.total_frames) {
            return Err("Count-in snapshot duration cannot contain its scheduled pulses.");
        }
        Ok(restored)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ClickVoice {
    rate: u32,
    age: u64,
    length: u64,
    frequency: f64,
    sound: ClickSound,
    accent: bool,
    noise: u32,
}

impl ClickVoice {
    pub fn new(rate: u32) -> Self {
        let rate = rate.max(1);
        let length = (f64::from(rate) * 0.05) as u64;
        Self {
            rate,
            age: length,
            length,
            frequency: 1800.0,
            sound: ClickSound::Beep,
            accent: false,
            noise: 0x9E37_79B9,
        }
    }
    /// Starts a click, replacing any click still ringing. The sound is passed at each trigger, so a change of sound
    /// takes effect on the next beat and never alters a click already sounding.
    pub fn trigger(&mut self, accent: bool, sound: ClickSound) {
        self.age = 0;
        self.sound = sound;
        self.accent = accent;
        let (normal, accented, seconds) = sound.shape();
        self.frequency = if accent { accented } else { normal };
        self.length = (f64::from(self.rate) * seconds) as u64;
        self.noise = 0x9E37_79B9;
    }
    pub fn frame(&mut self, volume: f64) -> f32 {
        if self.age >= self.length {
            return 0.0;
        }
        let age = self.age as f64 / f64::from(self.rate);
        self.age += 1;
        let phase = std::f64::consts::TAU * self.frequency * age;
        let sample = match self.sound {
            ClickSound::Beep => phase.sin() * (-age * 100.0).exp(),
            // Two inharmonic partials with a fast decay read as a struck block.
            ClickSound::Woodblock => {
                (phase.sin() + 0.45 * (phase * 2.76).sin()) / 1.45 * (-age * 70.0).exp()
            }
            // Two clipped partials a slightly flat fifth apart, the classic drum-machine bell, with a longer ring. Its
            // gain is lower than the others' so its energy, not just its peak, stays near the beep's.
            ClickSound::Cowbell => {
                let square = |value: f64| (value.sin() * 4.0).clamp(-1.0, 1.0);
                (square(phase) + square(phase * 1.48)) * 0.3 * (-age * 22.0).exp()
            }
            // A short noise burst over a faint tone, like a stick on a rim.
            ClickSound::Stick => {
                self.noise ^= self.noise << 13;
                self.noise ^= self.noise >> 17;
                self.noise ^= self.noise << 5;
                let noise = f64::from(self.noise) / f64::from(u32::MAX) * 2.0 - 1.0;
                (noise * 0.8 + phase.sin() * 0.2) * (-age * 180.0).exp()
            }
        };
        // Accents on the bright sounds are carried by pitch; the noise burst is also louder.
        let accent_gain = if self.accent && self.sound == ClickSound::Stick {
            1.0
        } else if self.sound == ClickSound::Stick {
            0.7
        } else {
            1.0
        };
        (sample * 0.25 * accent_gain * volume) as f32
    }
}
