use serde::{Deserialize, Serialize};

/// Native track delay storage is bounded independently of score tempo and playback speed.
pub const MAX_TRACK_DELAY_SECONDS: f64 = 16.0;

macro_rules! block {
    ($name:ident { $($field:ident:$kind:ty=$value:expr),* $(,)? }) => {
        #[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
        #[serde(rename_all="camelCase",deny_unknown_fields)]
        pub struct $name {pub enabled:bool,$(pub $field:$kind),*}
        impl Default for $name {fn default()->Self {Self {enabled:false,$($field:$value),*}}}
    };
}
block!(Gate {
    threshold_db: f64 = -60.0,
    release_ms: f64 = 100.0
});
block!(Compressor {
    threshold_db: f64 = -18.0,
    ratio: f64 = 4.0,
    attack_ms: f64 = 10.0,
    release_ms: f64 = 100.0,
    makeup_db: f64 = 0.0
});
block!(Amp {
    model: String = "clean".into(),
    drive: f64 = 0.1,
    gain_db: f64 = 0.0
});
block!(Cabinet {
    model: String = "open".into()
});
block!(Eq {
    low_db: f64 = 0.0,
    mid_db: f64 = 0.0,
    high_db: f64 = 0.0,
    mid_hz: f64 = 1000.0
});
block!(Chorus {
    rate_hz: f64 = 1.0,
    depth_ms: f64 = 5.0,
    mix: f64 = 0.15
});
block!(Delay {
    quarter_notes: f64 = 1.0,
    feedback: f64 = 0.25,
    mix: f64 = 0.15
});
block!(Reverb {
    room: f64 = 0.5,
    damping: f64 = 0.5,
    mix: f64 = 0.12
});

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FxSettings {
    pub gate: Gate,
    pub compressor: Compressor,
    pub amp: Amp,
    pub cabinet: Cabinet,
    pub eq: Eq,
    pub chorus: Chorus,
    pub delay: Delay,
    pub reverb: Reverb,
}

impl FxSettings {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, low, high) in [
            ("gate threshold", self.gate.threshold_db, -96.0, 0.0),
            ("gate release", self.gate.release_ms, 1.0, 1000.0),
            (
                "compressor threshold",
                self.compressor.threshold_db,
                -60.0,
                0.0,
            ),
            ("compressor ratio", self.compressor.ratio, 1.0, 20.0),
            ("compressor attack", self.compressor.attack_ms, 0.1, 200.0),
            (
                "compressor release",
                self.compressor.release_ms,
                1.0,
                2000.0,
            ),
            ("compressor makeup", self.compressor.makeup_db, 0.0, 24.0),
            ("amp drive", self.amp.drive, 0.0, 1.0),
            ("amp gain", self.amp.gain_db, -24.0, 24.0),
            ("EQ low", self.eq.low_db, -24.0, 24.0),
            ("EQ mid", self.eq.mid_db, -24.0, 24.0),
            ("EQ high", self.eq.high_db, -24.0, 24.0),
            ("EQ frequency", self.eq.mid_hz, 200.0, 5000.0),
            ("chorus rate", self.chorus.rate_hz, 0.1, 8.0),
            ("chorus depth", self.chorus.depth_ms, 0.0, 20.0),
            ("chorus mix", self.chorus.mix, 0.0, 1.0),
            ("delay feedback", self.delay.feedback, 0.0, 0.9),
            ("delay mix", self.delay.mix, 0.0, 1.0),
            ("reverb room", self.reverb.room, 0.0, 1.0),
            ("reverb damping", self.reverb.damping, 0.0, 1.0),
            ("reverb mix", self.reverb.mix, 0.0, 1.0),
        ] {
            if !value.is_finite() || value < low || value > high {
                return Err(format!("Invalid {name}: expected {low}..{high}."));
            }
        }
        if ![0.125, 0.25, 0.5, 1.0, 2.0, 4.0].contains(&self.delay.quarter_notes) {
            return Err("Invalid delay note duration.".into());
        }
        if !["clean", "crunch", "lead", "bass"].contains(&self.amp.model.as_str()) {
            return Err("Unknown amp model.".into());
        }
        if !["open", "closed", "bass"].contains(&self.cabinet.model.as_str()) {
            return Err("Unknown cabinet model.".into());
        }
        Ok(())
    }
    pub fn preset(name: &str) -> Result<Self, String> {
        let mut fx = Self::default();
        match name {
            "gm" => {}
            "clean" => {
                fx.amp.enabled = true;
                fx.cabinet.enabled = true;
            }
            "crunch" => {
                fx.amp.enabled = true;
                fx.amp.model = "crunch".into();
                fx.amp.drive = 0.4;
                fx.cabinet.enabled = true;
                fx.cabinet.model = "closed".into();
                fx.eq.enabled = true;
                fx.eq.mid_db = 2.0;
            }
            "lead" => {
                fx.amp.enabled = true;
                fx.amp.model = "lead".into();
                fx.amp.drive = 0.75;
                fx.cabinet.enabled = true;
                fx.cabinet.model = "closed".into();
                fx.delay.enabled = true;
                fx.reverb.enabled = true;
            }
            "bass" => {
                fx.amp.enabled = true;
                fx.amp.model = "bass".into();
                fx.amp.drive = 0.2;
                fx.cabinet.enabled = true;
                fx.cabinet.model = "bass".into();
                fx.compressor.enabled = true;
                fx.compressor.makeup_db = 3.0;
                fx.eq.enabled = true;
                fx.eq.low_db = 3.0;
                fx.eq.high_db = -2.0;
            }
            _ => return Err("Unknown sound preset.".into()),
        }
        Ok(fx)
    }
}

#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [[f64; 2]; 2],
}
impl Default for Biquad {
    fn default() -> Self {
        Self {
            b: [1.0, 0.0, 0.0],
            a: [0.0; 2],
            z: [[0.0; 2]; 2],
        }
    }
}
impl Biquad {
    fn set(&mut self, b: [f64; 3], a: [f64; 3]) {
        self.b = b.map(|x| x / a[0]);
        self.a = [a[1] / a[0], a[2] / a[0]];
    }
    fn pass(&mut self, hz: f64, rate: f64, high: bool) {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let c = w.cos();
        let alpha = w.sin() / std::f64::consts::SQRT_2;
        let b = if high {
            [(1.0 + c) / 2.0, -1.0 - c, (1.0 + c) / 2.0]
        } else {
            [(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0]
        };
        self.set(b, [1.0 + alpha, -2.0 * c, 1.0 - alpha]);
    }
    fn peak(&mut self, hz: f64, db: f64, rate: f64) {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let a = 10f64.powf(db / 40.0);
        let alpha = w.sin() / 1.4;
        self.set(
            [1.0 + alpha * a, -2.0 * w.cos(), 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * w.cos(), 1.0 - alpha / a],
        );
    }
    fn shelf(&mut self, hz: f64, db: f64, rate: f64, high: bool) {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let c = w.cos();
        let a = 10f64.powf(db / 40.0);
        let k = w.sin() * (2.0 * a).sqrt();
        let s = if high { 1.0 } else { -1.0 };
        self.set(
            [
                a * ((a + 1.0) + s * (a - 1.0) * c + k),
                -2.0 * s * a * ((a - 1.0) + s * (a + 1.0) * c),
                a * ((a + 1.0) + s * (a - 1.0) * c - k),
            ],
            [
                (a + 1.0) - s * (a - 1.0) * c + k,
                2.0 * s * ((a - 1.0) - s * (a + 1.0) * c),
                (a + 1.0) - s * (a - 1.0) * c - k,
            ],
        );
    }
    fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        std::array::from_fn(|c| {
            let y = self.b[0] * x[c] as f64 + self.z[c][0];
            self.z[c][0] = self.b[1] * x[c] as f64 - self.a[0] * y + self.z[c][1];
            self.z[c][1] = self.b[2] * x[c] as f64 - self.a[1] * y;
            y as f32
        })
    }
    fn reset(&mut self) {
        self.z = [[0.0; 2]; 2];
    }
}

struct DelayLine {
    frames: Vec<[f32; 2]>,
    cursor: usize,
}
impl DelayLine {
    fn new(length: usize) -> Self {
        Self {
            frames: vec![[0.0; 2]; length.max(2)],
            cursor: 0,
        }
    }
    fn read(&self, offset: f64) -> [f32; 2] {
        let offset = offset.clamp(1.0, (self.frames.len() - 1) as f64);
        let p = (self.cursor as f64 - offset).rem_euclid(self.frames.len() as f64);
        let i = p.floor() as usize;
        let f = (p - i as f64) as f32;
        std::array::from_fn(|c| {
            self.frames[i][c] * (1.0 - f) + self.frames[(i + 1) % self.frames.len()][c] * f
        })
    }
    fn write(&mut self, x: [f32; 2]) {
        self.frames[self.cursor] = x;
        self.cursor = (self.cursor + 1) % self.frames.len();
    }
    fn reset(&mut self) {
        self.frames.fill([0.0; 2]);
        self.cursor = 0;
    }
}

pub struct TrackDsp {
    settings: FxSettings,
    previous: FxSettings,
    rate: f64,
    ramp_left: u32,
    ramp_frames: u32,
    gate_envelope: f64,
    compressor_envelope: f64,
    amp_dc: [f64; 2],
    amp_previous_input: [f64; 2],
    amp_anti_alias: [[f64; 3]; 2],
    cabinet: [Biquad; 3],
    eq: [Biquad; 3],
    chorus: DelayLine,
    phase: f64,
    delay: DelayLine,
    reverb: [DelayLine; 4],
    reverb_damp: [[f32; 2]; 4],
    cached_eq: [f64; 4],
    cached_cabinet: [f64; 2],
}
impl TrackDsp {
    pub fn new(
        settings: FxSettings,
        sample_rate: u32,
        max_delay_seconds: f64,
    ) -> Result<Self, String> {
        settings.validate()?;
        if !(8_000..=192_000).contains(&sample_rate)
            || !max_delay_seconds.is_finite()
            || !(0.01..=120.0).contains(&max_delay_seconds)
        {
            return Err("Invalid DSP sample rate or delay capacity.".into());
        }
        let rate = sample_rate as f64;
        Ok(Self {
            previous: settings.clone(),
            settings,
            rate,
            ramp_left: 0,
            ramp_frames: (rate * 0.01) as u32,
            gate_envelope: 1.0,
            compressor_envelope: 0.0,
            amp_dc: [0.0; 2],
            amp_previous_input: [0.0; 2],
            amp_anti_alias: [[0.0; 3]; 2],
            cabinet: [Biquad::default(); 3],
            eq: [Biquad::default(); 3],
            chorus: DelayLine::new((rate * 0.05) as usize + 2),
            phase: 0.0,
            delay: DelayLine::new((rate * max_delay_seconds).ceil() as usize + 2),
            reverb: std::array::from_fn(|i| {
                DelayLine::new((rate * [0.0297, 0.0371, 0.0411, 0.0437][i]) as usize + 23 * i)
            }),
            reverb_damp: [[0.0; 2]; 4],
            cached_eq: [f64::NAN; 4],
            cached_cabinet: [f64::NAN; 2],
        })
    }
    pub fn set_settings(&mut self, settings: FxSettings) -> Result<(), String> {
        settings.validate()?;
        self.previous = std::mem::replace(&mut self.settings, settings);
        self.ramp_left = self.ramp_frames;
        Ok(())
    }
    /// Move running state into an off-thread prepared configuration; old allocations remain owned by `old`.
    pub fn transition_from(&mut self, old: &mut Self) {
        let running = [
            old.settings.gate.enabled,
            old.settings.compressor.enabled,
            old.settings.amp.enabled,
            old.settings.cabinet.enabled,
            old.settings.eq.enabled,
            old.settings.chorus.enabled,
            old.settings.delay.enabled,
            old.settings.reverb.enabled,
        ];
        std::mem::swap(&mut self.previous, &mut old.settings);
        macro_rules! move_state {($($name:ident),*)=>{$(std::mem::swap(&mut self.$name,&mut old.$name);)*}}
        if running[0] {
            move_state!(gate_envelope);
        }
        if running[1] {
            move_state!(compressor_envelope);
        }
        if running[2] {
            move_state!(amp_dc, amp_previous_input, amp_anti_alias);
        }
        if running[3] {
            move_state!(cabinet, cached_cabinet);
        }
        if running[4] {
            move_state!(eq, cached_eq);
        }
        if running[5] {
            move_state!(chorus, phase);
        }
        if running[6] {
            move_state!(delay);
        }
        if running[7] {
            move_state!(reverb, reverb_damp);
        }
        self.ramp_left = self.ramp_frames;
    }
    pub fn process(&mut self, input: [f32; 2], bpm: f64) -> [f32; 2] {
        let mut x = input.map(|v| if v.is_finite() { v } else { 0.0 });
        let t = if self.ramp_left == 0 {
            1.0
        } else {
            1.0 - self.ramp_left as f64 / self.ramp_frames as f64
        };
        let lerp = |a: f64, b: f64| a + (b - a) * t;
        let blend = |dry: [f32; 2], wet: [f32; 2], a: bool, b: bool| {
            let amount = lerp(if a { 1.0 } else { 0.0 }, if b { 1.0 } else { 0.0 }) as f32;
            std::array::from_fn(|c| dry[c] + (wet[c] - dry[c]) * amount)
        };
        let f = &self.settings;
        let p = &self.previous;
        if f.gate.enabled || p.gate.enabled && t < 1.0 {
            let peak = x[0].abs().max(x[1].abs()) as f64;
            let target = if peak > 10f64.powf(lerp(p.gate.threshold_db, f.gate.threshold_db) / 20.0)
            {
                1.0
            } else {
                0.0
            };
            let k = if target > self.gate_envelope {
                0.1
            } else {
                (-1.0 / (self.rate * lerp(p.gate.release_ms, f.gate.release_ms) * 0.001)).exp()
            };
            self.gate_envelope = target + (self.gate_envelope - target) * k;
            x = blend(
                x,
                x.map(|v| v * self.gate_envelope as f32),
                p.gate.enabled,
                f.gate.enabled,
            );
        }
        if f.compressor.enabled || p.compressor.enabled && t < 1.0 {
            let level = x[0].abs().max(x[1].abs()) as f64;
            let time = if level > self.compressor_envelope {
                lerp(p.compressor.attack_ms, f.compressor.attack_ms)
            } else {
                lerp(p.compressor.release_ms, f.compressor.release_ms)
            };
            let k = (-1.0 / (self.rate * time * 0.001)).exp();
            self.compressor_envelope = level + (self.compressor_envelope - level) * k;
            let db = 20.0 * self.compressor_envelope.max(1e-9).log10();
            let above = (db - lerp(p.compressor.threshold_db, f.compressor.threshold_db)).max(0.0);
            let gain = 10f64.powf(
                (lerp(p.compressor.makeup_db, f.compressor.makeup_db)
                    - above * (1.0 - 1.0 / lerp(p.compressor.ratio, f.compressor.ratio)))
                    / 20.0,
            ) as f32;
            x = blend(
                x,
                x.map(|v| v * gain),
                p.compressor.enabled,
                f.compressor.enabled,
            );
        }
        if f.amp.enabled || p.amp.enabled && t < 1.0 {
            let drive = lerp(p.amp.drive, f.amp.drive);
            let gain = 10f64.powf(lerp(p.amp.gain_db, f.amp.gain_db) / 20.0);
            let model = |s: &str| match s {
                // Reference peak .10 corresponds to the measured loud pickup RMS .0704.
                // Normalization keeps this level steady while quieter notes gain sustain.
                "crunch" => {
                    let pre = 1.0 + 220.0 * drive.powf(1.2);
                    (pre, 0.10 / (0.10 * pre).tanh(), 0.08 * drive, 1.0)
                }
                "lead" => {
                    let pre = 1.0 + 600.0 * drive.powf(1.1);
                    (pre, 0.11 / (0.11 * pre).tanh(), 0.04 * drive, 1.0)
                }
                "bass" => {
                    let pre = 1.0 + drive * 3.0;
                    (pre, 1.0 / pre.sqrt(), 0.02 * drive, 0.0)
                }
                _ => {
                    let pre = 1.0 + drive;
                    (pre, 1.0 / pre.sqrt(), 0.02 * drive, 0.0)
                }
            };
            let a = model(&p.amp.model);
            let b = model(&f.amp.model);
            let pre = lerp(a.0, b.0);
            let post = lerp(a.1, b.1);
            let bias = lerp(a.2, b.2);
            let oversampled = lerp(a.3, b.3);
            let zero = bias.tanh();
            let filter = 1.0 - (-std::f64::consts::TAU * 0.22 / 4.0).exp();
            let wet = std::array::from_fn(|c| {
                let v = x[c] as f64;
                let direct = if oversampled == 0.0 {
                    (v * pre + bias).tanh() / pre.sqrt() - zero / pre.sqrt()
                } else {
                    ((v * pre + bias).tanh() - zero) * post
                };
                let mut colored = direct;
                if oversampled > 0.0 {
                    let mut sum = 0.0;
                    for step in 1..=4 {
                        let input = self.amp_previous_input[c]
                            + (v - self.amp_previous_input[c]) * step as f64 / 4.0;
                        let mut sample = ((input * pre + bias).tanh() - zero) * post;
                        for state in &mut self.amp_anti_alias[c] {
                            *state += filter * (sample - *state);
                            sample = *state;
                        }
                        sum += sample;
                    }
                    colored += ((sum / 4.0) - direct) * oversampled;
                }
                self.amp_previous_input[c] = v;
                self.amp_dc[c] += 0.0005 * (colored - self.amp_dc[c]);
                ((colored - self.amp_dc[c]) * gain) as f32
            });
            x = blend(x, wet, p.amp.enabled, f.amp.enabled);
        }
        if f.cabinet.enabled || p.cabinet.enabled && t < 1.0 {
            let cutoff = |s: &str| match s {
                "closed" => [90.0, 4200.0],
                "bass" => [35.0, 3500.0],
                _ => [65.0, 5500.0],
            };
            let a = cutoff(&p.cabinet.model);
            let b = cutoff(&f.cabinet.model);
            let values = [lerp(a[0], b[0]), lerp(a[1], b[1])];
            if values != self.cached_cabinet {
                self.cabinet[0].pass(values[0], self.rate, true);
                self.cabinet[1].pass(values[1], self.rate, false);
                self.cabinet[2].pass(values[1], self.rate, false);
                self.cached_cabinet = values;
            }
            let mut wet = x;
            for b in &mut self.cabinet {
                wet = b.process(wet);
            }
            x = blend(x, wet, p.cabinet.enabled, f.cabinet.enabled);
        }
        if f.eq.enabled || p.eq.enabled && t < 1.0 {
            let values = [
                lerp(p.eq.low_db, f.eq.low_db),
                lerp(p.eq.mid_db, f.eq.mid_db),
                lerp(p.eq.high_db, f.eq.high_db),
                lerp(p.eq.mid_hz, f.eq.mid_hz),
            ];
            if values != self.cached_eq {
                self.eq[0].shelf(180.0, values[0], self.rate, false);
                self.eq[1].peak(values[3], values[1], self.rate);
                self.eq[2].shelf(4000.0, values[2], self.rate, true);
                self.cached_eq = values;
            }
            let mut wet = x;
            for b in &mut self.eq {
                wet = b.process(wet);
            }
            x = blend(x, wet, p.eq.enabled, f.eq.enabled);
        }
        if f.chorus.enabled || p.chorus.enabled && t < 1.0 {
            let depth = self.rate * lerp(p.chorus.depth_ms, f.chorus.depth_ms) * 0.001;
            let wet: [f32; 2] = std::array::from_fn(|c| {
                self.chorus.read(
                    self.rate * 0.012 + depth * (1.0 + (self.phase + c as f64 * 1.2).sin()) * 0.5,
                )[c]
            });
            self.chorus.write(x);
            self.phase = (self.phase
                + std::f64::consts::TAU * lerp(p.chorus.rate_hz, f.chorus.rate_hz) / self.rate)
                % std::f64::consts::TAU;
            let mix = lerp(p.chorus.mix, f.chorus.mix) as f32;
            x = blend(
                x,
                std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                p.chorus.enabled,
                f.chorus.enabled,
            );
        }
        if f.delay.enabled || p.delay.enabled && t < 1.0 {
            let bpm = if bpm.is_finite() && bpm > 0.0 {
                bpm
            } else {
                120.0
            };
            // Extremely slow tempos retain a bounded echo rather than rejecting the score.
            let offset = (self.rate * 60.0 / bpm
                * lerp(p.delay.quarter_notes, f.delay.quarter_notes))
            .min((self.delay.frames.len() - 2) as f64);
            let wet = self.delay.read(offset);
            let feedback = lerp(p.delay.feedback, f.delay.feedback) as f32;
            self.delay
                .write(std::array::from_fn(|c| x[c] + wet[c] * feedback));
            let mix = lerp(p.delay.mix, f.delay.mix) as f32;
            x = blend(
                x,
                std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                p.delay.enabled,
                f.delay.enabled,
            );
        }
        if f.reverb.enabled || p.reverb.enabled && t < 1.0 {
            let mut wet = [0.0; 2];
            let feedback = (0.55 + 0.37 * lerp(p.reverb.room, f.reverb.room)) as f32;
            let damping = (0.05 + 0.9 * lerp(p.reverb.damping, f.reverb.damping)) as f32;
            for i in 0..4 {
                let y = self.reverb[i].read((self.reverb[i].frames.len() - 1) as f64);
                for (c, value) in wet.iter_mut().enumerate() {
                    self.reverb_damp[i][c] =
                        y[c] * (1.0 - damping) + self.reverb_damp[i][c] * damping;
                    *value += y[c] * 0.25;
                }
                self.reverb[i].write(std::array::from_fn(|c| {
                    x[c] + self.reverb_damp[i][1 - c] * feedback
                }));
            }
            let mix = lerp(p.reverb.mix, f.reverb.mix) as f32;
            x = blend(
                x,
                std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                p.reverb.enabled,
                f.reverb.enabled,
            );
        }
        self.ramp_left = self.ramp_left.saturating_sub(1);
        x.map(|v| {
            if v.is_finite() {
                v.clamp(-64.0, 64.0)
            } else {
                0.0
            }
        })
    }
    pub fn reset(&mut self) {
        self.gate_envelope = 1.0;
        self.compressor_envelope = 0.0;
        self.amp_dc = [0.0; 2];
        self.amp_previous_input = [0.0; 2];
        self.amp_anti_alias = [[0.0; 3]; 2];
        for b in &mut self.cabinet {
            b.reset();
        }
        for b in &mut self.eq {
            b.reset();
        }
        self.chorus.reset();
        self.delay.reset();
        for line in &mut self.reverb {
            line.reset();
        }
        self.reverb_damp = [[0.0; 2]; 4];
        self.phase = 0.0;
    }
}

pub(crate) struct BackingFilterDsp {
    filter: Option<Biquad>,
}
impl BackingFilterDsp {
    pub(crate) fn new(mode: crate::settings::BackingFilter, rate: u32) -> Result<Self, String> {
        use crate::settings::BackingFilter;
        if !(8_000..=192_000).contains(&rate) {
            return Err("Invalid backing filter sample rate.".into());
        }
        let mut filter = Biquad::default();
        match mode {
            BackingFilter::None => return Ok(Self { filter: None }),
            BackingFilter::BassEnhance => filter.shelf(180.0, 6.0, rate as f64, false),
            BackingFilter::BassAttenuation => filter.shelf(180.0, -6.0, rate as f64, false),
            BackingFilter::MediumEnhance => filter.peak(1000.0, 6.0, rate as f64),
            BackingFilter::MediumAttenuation => filter.peak(1000.0, -6.0, rate as f64),
            BackingFilter::HighEnhance => filter.shelf(4000.0, 6.0, rate as f64, true),
            BackingFilter::HighAttenuation => filter.shelf(4000.0, -6.0, rate as f64, true),
        }
        Ok(Self {
            filter: Some(filter),
        })
    }
    pub(crate) fn process(&mut self, frame: [f32; 2]) -> [f32; 2] {
        match &mut self.filter {
            Some(filter) => filter.process(frame),
            None => frame,
        }
    }
    pub(crate) fn reset(&mut self) {
        if let Some(filter) = &mut self.filter {
            filter.reset();
        }
    }
}
#[cfg(test)]
mod backing_filter_tests {
    use super::BackingFilterDsp;
    use crate::settings::BackingFilter;

    const MODES: [BackingFilter; 7] = [
        BackingFilter::None,
        BackingFilter::BassEnhance,
        BackingFilter::BassAttenuation,
        BackingFilter::MediumEnhance,
        BackingFilter::MediumAttenuation,
        BackingFilter::HighEnhance,
        BackingFilter::HighAttenuation,
    ];
    const PATTERNS: [[f32; 2]; 4] = [[1.0, 1.0], [1.0, -1.0], [1.0, 0.0], [0.0, 1.0]];

    // Measure settled PCM energy, without examining filter coefficients.
    fn response(mode: BackingFilter, target: usize, sign: f64) {
        for rate in [44_100, 48_000] {
            for pattern in PATTERNS {
                for (band, hz) in [80.0, 1000.0, 10000.0].into_iter().enumerate() {
                    let mut dsp = BackingFilterDsp::new(mode, rate).unwrap();
                    let mut input_energy = 0.0;
                    let mut output_energy = [0.0; 2];
                    for i in 0..rate {
                        let s = (0.05 * (std::f64::consts::TAU * hz * i as f64 / rate as f64).sin())
                            as f32;
                        let output = dsp.process(pattern.map(|p| p * s));
                        assert!(output.iter().all(|v| v.is_finite()));
                        if pattern[0] == 0.0 {
                            assert_eq!(output[0], 0.0);
                        }
                        if pattern[1] == 0.0 {
                            assert_eq!(output[1], 0.0);
                        }
                        if pattern[0] == pattern[1] {
                            assert_eq!(output[0], output[1]);
                        }
                        if pattern[0] == -pattern[1] {
                            assert_eq!(output[0], -output[1]);
                        }
                        if i >= rate / 2 {
                            input_energy += (s as f64).powi(2);
                            for c in 0..2 {
                                output_energy[c] += (output[c] as f64).powi(2);
                            }
                        }
                    }
                    for c in 0..2 {
                        if pattern[c] == 0.0 {
                            continue;
                        }
                        let db = 10.0 * (output_energy[c] / input_energy).log10();
                        if band == target {
                            assert!(
                                (4.0..=7.0).contains(&(db * sign)),
                                "{mode:?} {rate}Hz {hz}Hz {pattern:?} channel {c}: {db}dB"
                            );
                        } else {
                            assert!(db.abs() < 1.0, "{mode:?} {rate}Hz {hz}Hz: {db}dB");
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn bass_enhance_response() {
        response(BackingFilter::BassEnhance, 0, 1.0);
    }
    #[test]
    fn bass_attenuation_response() {
        response(BackingFilter::BassAttenuation, 0, -1.0);
    }
    #[test]
    fn medium_enhance_response() {
        response(BackingFilter::MediumEnhance, 1, 1.0);
    }
    #[test]
    fn medium_attenuation_response() {
        response(BackingFilter::MediumAttenuation, 1, -1.0);
    }
    #[test]
    fn high_enhance_response() {
        response(BackingFilter::HighEnhance, 2, 1.0);
    }
    #[test]
    fn high_attenuation_response() {
        response(BackingFilter::HighAttenuation, 2, -1.0);
    }

    #[test]
    fn none_is_bit_exact_bypass() {
        for rate in [8_000, 44_100, 48_000, 192_000] {
            let mut dsp = BackingFilterDsp::new(BackingFilter::None, rate).unwrap();
            for frame in [
                [0.0, -0.0],
                [0.125, -0.3],
                [2.0, -4.0],
                [f32::MIN_POSITIVE, f32::from_bits(1)],
            ] {
                assert_eq!(
                    dsp.process(frame).map(f32::to_bits),
                    frame.map(f32::to_bits)
                );
            }
            dsp.reset();
            assert_eq!(dsp.process([0.25, -0.5]), [0.25, -0.5]);
        }
    }
    #[test]
    fn reset_matches_fresh_filter() {
        for rate in [44_100, 48_000] {
            for mode in MODES {
                let mut used = BackingFilterDsp::new(mode, rate).unwrap();
                for i in 0..1000 {
                    used.process([(i as f32 * 0.17).sin() * 0.1, 0.0]);
                }
                used.reset();
                let mut fresh = BackingFilterDsp::new(mode, rate).unwrap();
                for i in 0..2000 {
                    let frame = [(i as f32 * 0.23).sin() * 0.1, (i as f32 * 0.31).cos() * 0.1];
                    assert_eq!(used.process(frame), fresh.process(frame));
                }
            }
        }
    }
    #[test]
    fn supported_boundary_rates_remain_finite() {
        for rate in [8_000, 192_000] {
            for mode in MODES {
                let mut dsp = BackingFilterDsp::new(mode, rate).unwrap();
                for i in 0..rate {
                    let input = if i == 0 { [0.1, -0.2] } else { [0.0; 2] };
                    assert!(dsp.process(input).iter().all(|v| v.is_finite()));
                }
            }
        }
    }
    #[test]
    fn rejects_unsupported_rates() {
        for mode in MODES {
            for rate in [0, 1, 7_999, 192_001, u32::MAX] {
                assert!(BackingFilterDsp::new(mode, rate).is_err());
            }
        }
    }
}
