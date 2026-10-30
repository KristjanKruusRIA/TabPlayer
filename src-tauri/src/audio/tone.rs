//! The driven half of the signal chain: amps, drive pedals and speaker cabinets.
//!
//! A sound's settings resolve off the audio thread into a plain `Shape`, and `Chain::process` only reads one, so the
//! audio callback never allocates, locks or loads anything. Everything nonlinear runs oversampled.
//!
//! All of this is synthesized from how the circuits and speakers behave. It holds no captured data.
use std::sync::{Arc, Mutex, PoisonError};

const PI: f64 = std::f64::consts::PI;
const TAU: f64 = std::f64::consts::TAU;
/// Zeroes vanishing state, so silence does not leave slow denormal arithmetic running.
#[inline]
fn flush(value: f64) -> f64 {
    if value.abs() < 1e-20 { 0.0 } else { value }
}
/// The coefficient of a one-pole filter at `hz`, for a rate of `rate`.
fn one_pole(hz: f64, rate: f64) -> f64 {
    1.0 - (-TAU * hz.min(rate * 0.45) / rate).exp()
}
fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// A two-path polyphase allpass halfband filter of `N` sections, whose response is mirrored about a quarter of its
/// rate. Each path delays by a different amount, so the two cancel in the stop band.
#[derive(Clone, Copy)]
struct Halfband<const N: usize> {
    coefficients: [f64; N],
    inputs: [f64; N],
    outputs: [f64; N],
}
impl<const N: usize> Halfband<N> {
    /// `transition` is the width of the band from the pass band's edge to a quarter of the rate, as a share of the
    /// rate. The sections come from the elliptic design for two allpass paths.
    fn new(transition: f64) -> Self {
        let k = ((1.0 - transition * 2.0) * PI / 4.0).tan().powi(2);
        let root = (1.0 - k * k).powf(0.25);
        let e = 0.5 * (1.0 - root) / (1.0 + root);
        let e4 = e.powi(4);
        let q = e * (1.0 + e4 * (2.0 + e4 * (15.0 + 150.0 * e4)));
        let order = (N * 2 + 1) as f64;
        let coefficients = std::array::from_fn(|index| {
            let c = (index + 1) as f64;
            let (mut above, mut below) = (0.0, 0.5);
            for i in 0..12 {
                let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
                let n = i as f64;
                above += sign * q.powi(i * (i + 1)) * ((2.0 * n + 1.0) * c * PI / order).sin();
                if i > 0 {
                    below += sign * q.powi(i * i) * (2.0 * n * c * PI / order).cos();
                }
            }
            let w = (above * q.powf(0.25) / below).powi(2);
            let x = ((1.0 - w * k) * (1.0 - w / k)).sqrt() / (1.0 + w);
            (1.0 - x) / (1.0 + x)
        });
        Self {
            coefficients,
            inputs: [0.0; N],
            outputs: [0.0; N],
        }
    }
    #[inline]
    fn paths(&mut self, mut even: f64, mut odd: f64) -> [f64; 2] {
        for i in (0..N).step_by(2) {
            let next = (even - self.outputs[i]) * self.coefficients[i] + self.inputs[i];
            self.inputs[i] = even;
            self.outputs[i] = flush(next);
            even = next;
            let next = (odd - self.outputs[i + 1]) * self.coefficients[i + 1] + self.inputs[i + 1];
            self.inputs[i + 1] = odd;
            self.outputs[i + 1] = flush(next);
            odd = next;
        }
        [even, odd]
    }
    /// One input frame as two output frames at twice the rate.
    #[inline]
    fn raise(&mut self, input: f64) -> [f64; 2] {
        self.paths(input, input)
    }
    /// Two input frames as one output frame at half the rate.
    #[inline]
    fn lower(&mut self, input: [f64; 2]) -> f64 {
        let [a, b] = self.paths(input[1], input[0]);
        (a + b) * 0.5
    }
    fn reset(&mut self) {
        self.inputs = [0.0; N];
        self.outputs = [0.0; N];
    }
}
/// The oversampling factor for a rate: four times at the usual rates, less where the rate is already high.
fn oversampling(rate: f64) -> usize {
    match rate {
        r if r < 64_000.0 => 4,
        r if r < 128_000.0 => 2,
        _ => 1,
    }
}
/// Raises a channel to the chain's internal rate and brings it back down. The filters are minimum-phase, so the
/// chain adds under a millisecond of delay, and a dry path crossfaded against it does not comb audibly.
#[derive(Clone, Copy)]
struct Oversampler {
    ratio: usize,
    up: (Halfband<10>, Halfband<4>),
    down: (Halfband<10>, Halfband<4>),
}
impl Oversampler {
    fn new(rate: f64) -> Self {
        let ratio = oversampling(rate);
        // The first stage passes up to 20 kHz at 48 kHz; the second has twice the room and needs far fewer sections.
        let first = Halfband::new(0.04);
        let second = Halfband::new(0.15);
        Self {
            ratio,
            up: (first, second),
            down: (first, second),
        }
    }
    #[inline]
    fn raise(&mut self, input: f64, block: &mut [f64; 4]) {
        match self.ratio {
            4 => {
                let [a, b] = self.up.0.raise(input);
                [block[0], block[1]] = self.up.1.raise(a);
                [block[2], block[3]] = self.up.1.raise(b);
            }
            2 => [block[0], block[1]] = self.up.0.raise(input),
            _ => block[0] = input,
        }
    }
    #[inline]
    fn lower(&mut self, block: &[f64; 4]) -> f64 {
        match self.ratio {
            4 => {
                let a = self.down.1.lower([block[0], block[1]]);
                let b = self.down.1.lower([block[2], block[3]]);
                self.down.0.lower([a, b])
            }
            2 => self.down.0.lower([block[0], block[1]]),
            _ => block[0],
        }
    }
    fn reset(&mut self) {
        self.up.0.reset();
        self.up.1.reset();
        self.down.0.reset();
        self.down.1.reset();
    }
}

/// A second-order filter's coefficients, normalized. They interpolate safely: the set of stable filters is convex.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Section {
    b: [f64; 3],
    a: [f64; 2],
}
impl Section {
    const FLAT: Self = Self {
        b: [1.0, 0.0, 0.0],
        a: [0.0, 0.0],
    };
    fn from(b: [f64; 3], a: [f64; 3]) -> Self {
        Self {
            b: b.map(|v| v / a[0]),
            a: [a[1] / a[0], a[2] / a[0]],
        }
    }
    /// Butterworth-shaped at a `q` of 0.707.
    fn low_pass(hz: f64, q: f64, rate: f64) -> Self {
        let w = TAU * hz.min(rate * 0.45) / rate;
        let (c, alpha) = (w.cos(), w.sin() / (2.0 * q));
        Self::from(
            [(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0],
            [1.0 + alpha, -2.0 * c, 1.0 - alpha],
        )
    }
    fn high_pass(hz: f64, q: f64, rate: f64) -> Self {
        let w = TAU * hz.min(rate * 0.45) / rate;
        let (c, alpha) = (w.cos(), w.sin() / (2.0 * q));
        Self::from(
            [(1.0 + c) / 2.0, -1.0 - c, (1.0 + c) / 2.0],
            [1.0 + alpha, -2.0 * c, 1.0 - alpha],
        )
    }
    fn peak(hz: f64, db: f64, q: f64, rate: f64) -> Self {
        let w = TAU * hz.min(rate * 0.45) / rate;
        let (a, alpha) = (10f64.powf(db / 40.0), w.sin() / (2.0 * q));
        Self::from(
            [1.0 + alpha * a, -2.0 * w.cos(), 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * w.cos(), 1.0 - alpha / a],
        )
    }
    fn shelf(hz: f64, db: f64, rate: f64, high: bool) -> Self {
        let w = TAU * hz.min(rate * 0.45) / rate;
        let (c, a) = (w.cos(), 10f64.powf(db / 40.0));
        let k = w.sin() * (2.0 * a).sqrt();
        let s = if high { 1.0 } else { -1.0 };
        Self::from(
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
        )
    }
    fn between(&self, other: &Self, t: f64) -> Self {
        Self {
            b: std::array::from_fn(|i| mix(self.b[i], other.b[i], t)),
            a: std::array::from_fn(|i| mix(self.a[i], other.a[i], t)),
        }
    }
    #[inline]
    fn run(&self, z: &mut [f64; 2], x: f64) -> f64 {
        let y = self.b[0] * x + z[0];
        z[0] = flush(self.b[1] * x - self.a[0] * y + z[1]);
        z[1] = flush(self.b[2] * x - self.a[1] * y);
        y
    }
}

/// Rounds off toward ±1, reached with zero slope at ±3, with a slope of 1 at 0: a rational match for `tanh` near the
/// origin that costs one division.
#[inline]
fn soft(v: f64) -> f64 {
    let v = v.clamp(-3.0, 3.0);
    let s = v * v;
    v * (27.0 + s) / (27.0 + 9.0 * s)
}
/// Stays straight longer, then reaches ±1 with zero slope at ±1.5: a diode's short knee.
#[inline]
fn hard(v: f64) -> f64 {
    let s = v.clamp(-1.5, 1.5);
    s - 4.0 / 27.0 * s * s * s
}
/// One gain stage resolved for the chain's internal rate. Going in: a coupling capacitor's high-pass, then a shelf
/// that gives the lows less gain, as a part-bypassed cathode does. Then gain, a curve that saturates at different
/// levels on each side of its bias, and a low-pass, as the stage's own capacitance gives.
#[derive(Clone, Copy, Debug, PartialEq)]
struct StageShape {
    couple: f64,
    split: f64,
    cut: f64,
    gain: f64,
    rise: f64,
    fall: f64,
    bias: f64,
    /// Where the curve sits at rest, taken off what it gives, so the stage passes no offset.
    rest: f64,
    /// How much of the diode's short knee replaces the rounded curve.
    knee: f64,
    smooth: f64,
}
impl StageShape {
    /// Fills the stages a chain does not have.
    const UNUSED: Self = Self {
        couple: 0.0,
        split: 0.0,
        cut: 0.0,
        gain: 1.0,
        rise: 1.0,
        fall: 1.0,
        bias: 0.0,
        rest: 0.0,
        knee: 0.0,
        smooth: 1.0,
    };
    #[inline]
    fn curve(&self, v: f64) -> f64 {
        let limit = if v >= 0.0 { self.rise } else { self.fall };
        let y = soft(v / limit);
        limit
            * if self.knee > 0.0 {
                y + (hard(v / limit) - y) * self.knee
            } else {
                y
            }
    }
}
#[derive(Clone, Copy, Default)]
struct StageState {
    couple: f64,
    lows: f64,
    smooth: f64,
}
impl StageState {
    /// `shift` moves the working point, after the coupling that would otherwise remove it.
    #[inline]
    fn run(&mut self, s: &StageShape, input: f64, shift: f64) -> f64 {
        self.couple = flush(self.couple + s.couple * (input - self.couple));
        let v = input - self.couple;
        self.lows = flush(self.lows + s.split * (v - self.lows));
        let v = (v - s.cut * self.lows + shift) * s.gain;
        let y = s.curve(v + s.bias) - s.rest;
        self.smooth = flush(self.smooth + s.smooth * (y - self.smooth));
        self.smooth
    }
}
/// The most gain stages a chain has.
const STAGES: usize = 5;
/// One amp or pedal resolved for the audio thread.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    /// Scales the input to where the first stage expects it.
    input: f64,
    /// The stages in use.
    count: usize,
    stages: [StageShape; STAGES],
    /// A path around the stages, mixed back in after them: the overdrive's clean path, or a driven bass's lows.
    around: Section,
    around_gain: f64,
    /// The fixed tone-stack voicing after the preamp, ahead of the power stage.
    voicing: [Section; 3],
    /// The power stage's gain, or 0 for none; its limits; and how far the supply sags under a sustained level.
    power: f64,
    power_limits: [f64; 2],
    sag: f64,
    /// The supply's attack and release per internal frame.
    sag_rates: [f64; 2],
    /// Brings a reference level back to its target.
    pub level: f64,
}
impl Shape {
    /// Sets `level` so a `peak` sine at 220 Hz leaves at `target` RMS, by running it. With `offset` as the pedal's
    /// playing-level offset would be at that peak.
    fn calibrated(mut self, rate: f64, peak: f64, offset: f64, target: f64) -> Self {
        self.level = 1.0;
        let mut chain = Chain::new(rate);
        // 220 Hz fits whole periods into this length closely enough, and the second half has settled.
        let frames = (rate * 0.05) as usize;
        let mut sum = 0.0;
        for n in 0..frames {
            let x = (TAU * 220.0 * n as f64 / rate).sin() * peak;
            let y = chain.process(&self, [x as f32; 2], offset)[0];
            if n >= frames / 2 {
                sum += y * y;
            }
        }
        let rms = (sum / (frames - frames / 2) as f64).sqrt();
        self.level = target / rms.max(1e-9);
        self
    }
}
#[derive(Clone, Copy)]
struct ChannelState {
    over: Oversampler,
    stages: [StageState; STAGES],
    around: [f64; 2],
    voicing: [[f64; 2]; 3],
    supply: f64,
    dc: f64,
}
/// The running state of one amp or pedal, per channel.
#[derive(Clone, Copy)]
pub struct Chain {
    channels: [ChannelState; 2],
    /// The DC blocker's coefficient at the output rate.
    dc: f64,
    /// Whether both channels hold the same state, so that a frame with the same input on both needs only one run. Sample
    /// voices reach the chain as exact mono unless they are panned, which halves the usual cost.
    twin: bool,
    /// Whether it ran on the previous frame. A chain starting again starts silent.
    pub live: bool,
}
impl Chain {
    pub fn new(rate: f64) -> Self {
        let channel = ChannelState {
            over: Oversampler::new(rate),
            stages: [StageState::default(); STAGES],
            around: [0.0; 2],
            voicing: [[0.0; 2]; 3],
            supply: 0.0,
            dc: 0.0,
        };
        Self {
            channels: [channel; 2],
            dc: one_pole(6.0, rate),
            twin: true,
            live: false,
        }
    }
    pub fn reset(&mut self) {
        for channel in &mut self.channels {
            channel.over.reset();
            channel.stages = [StageState::default(); STAGES];
            channel.around = [0.0; 2];
            channel.voicing = [[0.0; 2]; 3];
            channel.supply = 0.0;
            channel.dc = 0.0;
        }
        self.twin = true;
    }
    /// One frame through `s`. `offset` shifts the input, for a fuzz's bias that follows the playing level.
    pub fn process(&mut self, s: &Shape, input: [f32; 2], offset: f64) -> [f64; 2] {
        if self.twin {
            if input[0] == input[1] {
                let y = self.channels[0].run(s, input[0], offset, self.dc);
                return [y, y];
            }
            self.channels[1] = self.channels[0];
            self.twin = false;
        }
        let dc = self.dc;
        std::array::from_fn(|c| self.channels[c].run(s, input[c], offset, dc))
    }
    /// One frame moving from the circuit `from`, which `leaving` carries, to `to`, by `t`. `first` marks the ramp's first
    /// frame. Each circuit plays as itself and only their outputs crossfade, because a circuit part way between two has
    /// no known level: a move from an overdrive to a fuzz would swell through it.
    #[allow(clippy::too_many_arguments)]
    pub fn crossfade(
        &mut self,
        leaving: &mut Self,
        from: &Shape,
        to: &Shape,
        t: f64,
        first: bool,
        input: [f32; 2],
        offsets: [f64; 2],
    ) -> [f64; 2] {
        if first {
            *leaving = *self;
        }
        let a = leaving.process(from, input, offsets[0]);
        let b = self.process(to, input, offsets[1]);
        std::array::from_fn(|c| mix(a[c], b[c], t))
    }
}
impl ChannelState {
    #[inline]
    fn run(&mut self, s: &Shape, input: f32, offset: f64, dc: f64) -> f64 {
        // A stage this circuit does not use keeps no state, for the next circuit that does.
        self.stages[s.count..].fill(StageState::default());
        let mut block = [0.0; 4];
        self.over.raise(input as f64 * s.input, &mut block);
        for sample in &mut block[..self.over.ratio] {
            let direct = *sample;
            let (mut v, mut shift) = (direct, offset);
            for (stage, state) in s.stages[..s.count].iter().zip(&mut self.stages) {
                v = state.run(stage, v, shift);
                shift = 0.0;
            }
            if s.around_gain != 0.0 {
                v += s.around_gain * s.around.run(&mut self.around, direct);
            }
            for (filter, z) in s.voicing.iter().zip(&mut self.voicing) {
                v = filter.run(z, v);
            }
            if s.power > 0.0 {
                // The supply droops under a sustained level and recovers slowly, which lets a note bloom.
                let level = v.abs();
                let rate = s.sag_rates[if level > self.supply { 0 } else { 1 }];
                self.supply = flush(self.supply + rate * (level - self.supply));
                let drive = s.power * v / (1.0 + s.sag * self.supply);
                let limit = s.power_limits[if drive >= 0.0 { 0 } else { 1 }];
                v = soft(drive / limit) * limit;
            }
            *sample = v;
        }
        let y = self.over.lower(&block) * s.level;
        self.dc = flush(self.dc + dc * (y - self.dc));
        y - self.dc
    }
}

/// One stage of a model, in real units, before it is resolved for a rate.
#[derive(Clone, Copy)]
struct Tube {
    couple_hz: f64,
    shelf_hz: f64,
    shelf_db: f64,
    gain: f64,
    rise: f64,
    fall: f64,
    bias: f64,
    knee: f64,
    smooth_hz: f64,
}
const fn tube(couple_hz: f64, gain: f64, limits: [f64; 2], bias: f64, smooth_hz: f64) -> Tube {
    Tube {
        couple_hz,
        shelf_hz: 0.0,
        shelf_db: 0.0,
        gain,
        rise: limits[0],
        fall: limits[1],
        bias,
        knee: 0.0,
        smooth_hz,
    }
}
impl Tube {
    const fn shelved(mut self, hz: f64, db: f64) -> Self {
        self.shelf_hz = hz;
        self.shelf_db = db;
        self
    }
    const fn diode(mut self) -> Self {
        self.knee = 1.0;
        self
    }
    fn resolve(&self, gain: f64, rate: f64) -> StageShape {
        let mut shape = StageShape {
            couple: one_pole(self.couple_hz, rate),
            split: if self.shelf_hz > 0.0 {
                one_pole(self.shelf_hz, rate)
            } else {
                0.0
            },
            cut: 1.0 - 10f64.powf(-self.shelf_db / 20.0),
            gain: self.gain * gain,
            rise: self.rise,
            fall: self.fall,
            bias: self.bias,
            rest: 0.0,
            knee: self.knee,
            smooth: one_pole(self.smooth_hz, rate),
        };
        shape.rest = shape.curve(self.bias);
        shape
    }
}
/// Resolves `tubes`, the one at `pot` scaled by `taper`, as a guitar amp's gain control sits between two stages.
fn resolved(tubes: &[Tube], pot: usize, taper: f64, rate: f64) -> ([StageShape; STAGES], usize) {
    let mut stages = [StageShape::UNUSED; STAGES];
    for (index, tube) in tubes.iter().enumerate() {
        stages[index] = tube.resolve(if index == pot { taper } else { 1.0 }, rate);
    }
    (stages, tubes.len())
}
fn flat_shape(rate: f64) -> Shape {
    Shape {
        input: 1.0,
        count: 0,
        stages: [StageShape::UNUSED; STAGES],
        around: Section::FLAT,
        around_gain: 0.0,
        voicing: [Section::FLAT; 3],
        power: 0.0,
        power_limits: [1.0; 2],
        sag: 0.0,
        sag_rates: [one_pole(60.0, rate), one_pole(6.0, rate)],
        level: 1.0,
    }
}

/// The level, at a 0.1 peak and 220 Hz, that the driven amps leave at, before a cabinet.
const AMP_TARGET: f64 = 0.078;
/// How much the amps' input raises a sample voice. A chord's attack peaks near 1 in the chain and a held note near 0.03,
/// so the first stage only clips on a hard attack, and the stages behind its filtering take the sustained gain.
const PICKUP: f64 = 3.0;
/// The gain control's taper: `span` dB from the bottom of its travel to the top, in the shape of an audio pot, which
/// gives most of its rise early. A low setting already saturates a sample's sustained level, as an amp does a pickup's.
fn taper(drive: f64, span: f64) -> f64 {
    10f64.powf(-(1.0 - drive).powi(2) * span / 20.0)
}
/// A driven amp resolved for `rate`, or `None` for a model on the original path.
///
/// Each amp is a chain of triode stages, each gently clipping a filtered copy of the last. That spreads the gain the
/// original single stage took in one step: a mild high-pass ahead of each stage thins the low strings where they would
/// beat against each other, and each stage rounds what the last one sharpened, so sustain stays smooth. The middle stages
/// close down further than the last, which leaves the top open for the cabinet to end, while slowing the edges they
/// hand on: that is what limits aliasing, since what a clipper folds back is already in the band a filter after it has
/// to pass.
///
/// The fixed voicing comes after the clipping, as a tone stack does, so that it shapes the tone without changing what
/// clips: lifted lows and highs around a low-mid dip. The lows it restores cannot intermodulate, and the cabinet then
/// takes away what lies below the guitar.
pub fn amp_shape(model: &str, drive: f64, rate: f64) -> Option<Shape> {
    let over = rate * oversampling(rate) as f64;
    let mut shape = flat_shape(over);
    shape.input = PICKUP;
    match model {
        // A cranked British plexi: three stages, open and dynamic, with a forward midrange and power stage in the sound.
        "crunch" => {
            let tubes = [
                tube(30.0, 3.0, [1.2, 2.0], 0.04, 16_000.0).shelved(160.0, 6.0),
                tube(90.0, 16.0, [1.2, 1.0], -0.03, 9_000.0),
                tube(70.0, 3.5, [1.0, 1.25], 0.02, 12_000.0),
            ];
            (shape.stages, shape.count) = resolved(&tubes, 1, taper(drive, 38.0), over);
            shape.voicing = [
                Section::shelf(190.0, 3.0, over, false),
                Section::peak(1_100.0, 2.0, 0.8, over),
                Section::shelf(2_200.0, 4.0, over, true),
            ];
            shape.power = 0.6;
            shape.power_limits = [1.0, 1.15];
            shape.sag = 0.3;
        }
        // A hot-rodded lead channel: four stages with a strong midrange, so single notes sing.
        "lead" => {
            let tubes = [
                tube(30.0, 3.0, [1.2, 2.0], 0.04, 16_000.0).shelved(200.0, 6.0),
                tube(120.0, 11.0, [1.2, 0.95], -0.04, 9_000.0),
                tube(90.0, 6.0, [0.95, 1.25], 0.03, 6_500.0),
                tube(60.0, 2.0, [1.2, 1.0], -0.02, 12_000.0),
            ];
            (shape.stages, shape.count) = resolved(&tubes, 1, taper(drive, 34.0), over);
            shape.voicing = [
                Section::shelf(170.0, 5.0, over, false),
                Section::peak(900.0, 2.5, 0.7, over),
                Section::shelf(2_000.0, 8.0, over, true),
            ];
            shape.power = 0.4;
            shape.power_limits = [1.0, 1.1];
            shape.sag = 0.2;
        }
        // A modern high-gain channel: five stages and the deepest V, for chords that stay separate under a lot of gain.
        "metal" => {
            let tubes = [
                tube(60.0, 3.0, [1.2, 2.0], 0.04, 16_000.0).shelved(250.0, 6.0),
                tube(160.0, 11.0, [1.2, 0.95], -0.04, 9_000.0),
                tube(120.0, 7.0, [0.95, 1.25], 0.03, 6_500.0),
                tube(90.0, 4.0, [1.2, 1.0], -0.02, 7_000.0),
                tube(60.0, 1.6, [1.1, 1.2], 0.01, 12_000.0),
            ];
            (shape.stages, shape.count) = resolved(&tubes, 1, taper(drive, 34.0), over);
            shape.voicing = [
                Section::shelf(170.0, 10.0, over, false),
                Section::peak(520.0, -1.0, 0.6, over),
                Section::shelf(1_900.0, 8.0, over, true),
            ];
            shape.power = 0.3;
            shape.power_limits = [1.0, 1.05];
            shape.sag = 0.15;
        }
        // A bass overdrive: the lows go around the clipping, so the note's weight stays clean under a driven upper
        // band, which is how a bass keeps its pitch under distortion.
        "bassDrive" => {
            let tubes = [
                tube(220.0, 3.0, [1.2, 1.9], 0.04, 7_000.0),
                tube(160.0, 12.0, [1.1, 0.9], -0.04, 5_000.0),
                tube(90.0, 3.0, [1.0, 1.3], 0.02, 3_800.0),
            ];
            (shape.stages, shape.count) = resolved(&tubes, 1, taper(drive, 34.0), over);
            // Inverted, because a low-pass and the stages' high-passes meet near opposite phase, and would cancel.
            shape.around = Section::low_pass(170.0, 0.707, over);
            shape.around_gain = -0.34;
            shape.voicing = [
                Section::peak(700.0, -3.0, 0.7, over),
                Section::peak(1_400.0, 2.5, 0.9, over),
                Section::FLAT,
            ];
            shape.power = 0.5;
            shape.power_limits = [1.1, 1.2];
            shape.sag = 0.15;
        }
        _ => return None,
    }
    Some(shape.calibrated(rate, 0.1, 0.0, AMP_TARGET))
}
/// A loud pickup's peak, at which the drive pedal keeps its output level whatever its setting.
pub const DRIVE_REFERENCE: f64 = 0.1;
/// The fuzz offsets its input by this share of the playing level, so its clipping is lopsided at any level and adds
/// even harmonics, as a fuzz's biased transistor does.
const FUZZ_BIAS: f64 = 0.25;
/// What of the distortion's gain comes after its op-amp stage, at the diodes. The stage before them has a limited
/// bandwidth, so the edges the diodes square off are already slow, which keeps what they fold back low.
const DIODE_GAIN: f64 = 6.0;
/// A drive pedal resolved for `rate`, and the share of the playing level its input is offset by.
///
/// Overdrive clips only what lies above its low-mid cut and adds that to the untouched input, as a Screamer's clipping
/// in the feedback loop does, so the pick and the chord's low notes pass through it. Distortion takes its gain mostly
/// above the low mids, with the op-amp's bandwidth closing as the gain rises, then clips hard at the diodes. Fuzz runs two rounded
/// stages into each other, the first offset by the playing level, and scoops its mids after.
pub fn drive_shape(model: &str, drive: f64, rate: f64) -> (Shape, f64) {
    let over = rate * oversampling(rate) as f64;
    let squared = drive * drive;
    let mut shape = flat_shape(over);
    let bias = match model {
        "distortion" => {
            let gain = 1.0 + 300.0 * squared;
            let smooth = 6_500.0 / (1.0 + gain / 90.0);
            let tubes = [
                tube(
                    90.0,
                    gain / DIODE_GAIN,
                    [1.0, 1.0],
                    0.0,
                    smooth.max(2_200.0),
                )
                .shelved(420.0, 12.0),
                tube(60.0, DIODE_GAIN, [0.7, 0.7], 0.0, 6_500.0).diode(),
                tube(50.0, 1.3, [0.9, 0.9], 0.0, 4_500.0),
            ];
            (shape.stages, shape.count) = resolved(&tubes, usize::MAX, 1.0, over);
            0.0
        }
        "fuzz" => {
            let tubes = [
                tube(40.0, 1.0 + 120.0 * drive, [0.9, 0.9], 0.0, 5_500.0),
                tube(60.0, 1.0 + 12.0 * drive, [0.9, 0.9], 0.0, 7_000.0),
            ];
            (shape.stages, shape.count) = resolved(&tubes, usize::MAX, 1.0, over);
            shape.voicing[0] = Section::peak(800.0, -2.0, 0.7, over);
            FUZZ_BIAS
        }
        _ => {
            let tubes = [tube(
                720.0,
                1.0 + 110.0 * squared,
                [0.42, 0.42],
                0.0,
                6_500.0,
            )];
            (shape.stages, shape.count) = resolved(&tubes, usize::MAX, 1.0, over);
            shape.around_gain = 1.0;
            0.0
        }
    };
    let reference = DRIVE_REFERENCE;
    (
        shape.calibrated(
            rate,
            reference,
            bias * reference,
            reference / std::f64::consts::SQRT_2,
        ),
        bias,
    )
}

/// One speaker cabinet and microphone, as a designed magnitude response. The box's high-pass and resonance run as
/// filters, which an FIR this short could not resolve; everything above them is the FIR.
struct CabinetDesign {
    /// (hertz, dB) along the response, joined smoothly in log frequency.
    curve: &'static [(f64, f64)],
    /// The depth in dB of the irregular cone-breakup and interference ripple above about 700 Hz.
    ragged: f64,
    seed: u32,
    /// The box's two high-pass sections as (hertz, quality), the second skipped at 0 Hz. Together they give the steep
    /// fall below the guitar that keeps the low strings tight; a sealed box and a close microphone fall about that fast.
    box_filters: [(f64, f64); 2],
    /// The box's resonance as (hertz, dB).
    resonance: (f64, f64),
}
/// The closed 4x12 with a dynamic microphone near the cone's edge, an open-backed 2x12 combo, and a bass stack. Each
/// curve is coarse by design, in dB against its midrange: the close microphone's low-mid body, a presence rise between 2
/// and 4 kHz, then a fall of about 50 dB an octave from the speaker's cone that levels out into a faint top.
const CABINETS: [(&str, CabinetDesign); 3] = [
    (
        "closed",
        CabinetDesign {
            curve: &[
                (200.0, 3.5),
                (330.0, 2.5),
                (450.0, 0.5),
                (1_000.0, 0.0),
                (1_600.0, -1.0),
                (2_000.0, -0.5),
                (2_600.0, 2.0),
                (3_300.0, 2.0),
                (4_000.0, 0.0),
                (4_800.0, -3.0),
                (5_900.0, -9.5),
                (7_400.0, -20.5),
                (9_000.0, -28.0),
                (12_000.0, -36.0),
                (16_000.0, -44.0),
                (20_000.0, -54.0),
            ],
            ragged: 2.2,
            seed: 0x51ED_2701,
            box_filters: [(90.0, 0.54), (90.0, 1.31)],
            resonance: (115.0, 1.0),
        },
    ),
    (
        "combo",
        CabinetDesign {
            curve: &[
                (200.0, 3.0),
                (350.0, 2.5),
                (550.0, 1.0),
                (1_000.0, 0.0),
                (1_700.0, 0.5),
                (2_500.0, 2.5),
                (3_300.0, 2.0),
                (4_200.0, -0.5),
                (5_200.0, -5.0),
                (6_300.0, -12.0),
                (7_800.0, -24.0),
                (9_500.0, -31.0),
                (12_500.0, -38.0),
                (16_000.0, -46.0),
                (20_000.0, -56.0),
            ],
            ragged: 2.5,
            seed: 0x2F6E_2B15,
            box_filters: [(92.0, 0.54), (92.0, 1.0)],
            resonance: (140.0, 1.5),
        },
    ),
    (
        "bassStack",
        CabinetDesign {
            curve: &[
                (150.0, 2.0),
                (300.0, 1.0),
                (500.0, -1.5),
                (800.0, -3.0),
                (1_200.0, -1.5),
                (1_800.0, 0.0),
                (2_400.0, 0.5),
                (3_000.0, -2.0),
                (3_800.0, -8.0),
                (4_800.0, -18.0),
                (6_000.0, -30.0),
                (8_000.0, -44.0),
                (12_000.0, -58.0),
                (20_000.0, -72.0),
            ],
            ragged: 2.0,
            seed: 0x9E37_79B9,
            box_filters: [(40.0, 0.8), (0.0, 0.0)],
            resonance: (70.0, 2.0),
        },
    ),
];
/// The cabinet index of `model`, or `None` for one on the original filters.
pub fn cabinet_index(model: &str) -> Option<usize> {
    CABINETS.iter().position(|(name, _)| *name == model)
}
/// A radix-2 FFT in place, for designing cabinets off the audio thread.
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let (step_s, step_c) = (-TAU / len as f64).sin_cos();
        for start in (0..n).step_by(len) {
            let (mut c, mut s) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * c - im[b] * s, re[b] * s + im[b] * c);
                (re[b], im[b]) = (re[a] - tr, im[a] - ti);
                (re[a], im[a]) = (re[a] + tr, im[a] + ti);
                (c, s) = (c * step_c - s * step_s, c * step_s + s * step_c);
            }
        }
        len <<= 1;
    }
}
fn inverse_fft(re: &mut [f64], im: &mut [f64]) {
    im.iter_mut().for_each(|v| *v = -*v);
    fft(re, im);
    let n = re.len() as f64;
    re.iter_mut().for_each(|v| *v /= n);
    im.iter_mut().for_each(|v| *v = -*v / n);
}
/// The curve's dB at `hz`, joined with a raised cosine in log frequency, so no corner is sharp.
fn curve_db(curve: &[(f64, f64)], hz: f64) -> f64 {
    let first = curve[0];
    if hz <= first.0 {
        return first.1;
    }
    for pair in curve.windows(2) {
        if hz < pair[1].0 {
            let t = (hz / pair[0].0).ln() / (pair[1].0 / pair[0].0).ln();
            return mix(pair[0].1, pair[1].1, 0.5 - 0.5 * (PI * t).cos());
        }
    }
    curve[curve.len() - 1].1
}
/// The irregular ripple of a real cone, as dips and peaks at seeded places in log frequency. It is what separates a
/// speaker from a smooth filter: it stops the top of a distorted signal reading as one even buzz.
fn ragged_db(design: &CabinetDesign, hz: f64) -> f64 {
    let mut state = design.seed;
    let mut next = move || {
        // The xorshift generator: small, and the same everywhere.
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state as f64 / u32::MAX as f64
    };
    let octave = (hz / 700.0).log2();
    let mut sum = 0.0;
    for _ in 0..28 {
        let at = next() * 3.6;
        let width = 0.05 + next() * 0.14;
        let height = (next() * 2.0 - 1.0) * design.ragged;
        sum += height * (-((octave - at) / width).powi(2)).exp();
    }
    // The ripple grows in from nothing, so the body below it stays as the curve draws it.
    sum * ((hz / 700.0 - 0.6) / 0.6).clamp(0.0, 1.0)
}
/// The design's impulse response, minimum-phase as a speaker's nearly is, from its magnitude through the real
/// cepstrum.
fn cabinet_impulse(design: &CabinetDesign, rate: f64, taps: usize) -> Vec<f32> {
    let size = 4096usize.max((taps * 4).next_power_of_two());
    let mut re = vec![0.0; size];
    let mut im = vec![0.0; size];
    for k in 0..=size / 2 {
        let hz = (k.max(1) as f64) * rate / size as f64;
        let db = curve_db(design.curve, hz) + ragged_db(design, hz);
        let log = db / 20.0 * std::f64::consts::LN_10;
        re[k] = log;
        re[(size - k) % size] = log;
    }
    inverse_fft(&mut re, &mut im);
    for n in 1..size / 2 {
        re[n] *= 2.0;
    }
    re[size / 2 + 1..].fill(0.0);
    im.fill(0.0);
    fft(&mut re, &mut im);
    for k in 0..size {
        let gain = re[k].exp();
        (re[k], im[k]) = (gain * im[k].cos(), gain * im[k].sin());
    }
    inverse_fft(&mut re, &mut im);
    // The last quarter fades out, so the truncation does not ring.
    let fade = taps / 4;
    (0..taps)
        .map(|n| {
            let left = taps - n;
            let gain = if left < fade {
                0.5 - 0.5 * (PI * left as f64 / fade as f64).cos()
            } else {
                1.0
            };
            (re[n] * gain) as f32
        })
        .collect()
}
/// Every cabinet's impulse response and box filters for one rate.
pub struct CabinetBank {
    rate: u32,
    taps: usize,
    impulses: Vec<Vec<f32>>,
    boxes: Vec<[Section; 3]>,
}
/// The FIR's length: about 10.7 ms, enough to hold what a speaker does above its box resonance, up to a limit that
/// keeps it affordable at very high rates.
fn cabinet_taps(rate: f64) -> usize {
    ((rate * 0.01067).round() as usize).clamp(64, 1024)
}
impl CabinetBank {
    fn design(rate: u32) -> Self {
        let hz = rate as f64;
        let taps = cabinet_taps(hz);
        Self {
            rate,
            taps,
            impulses: CABINETS
                .iter()
                .map(|(_, design)| cabinet_impulse(design, hz, taps))
                .collect(),
            boxes: CABINETS
                .iter()
                .map(|(_, design)| {
                    let [first, second] = design.box_filters;
                    [
                        Section::high_pass(first.0, first.1, hz),
                        if second.0 > 0.0 {
                            Section::high_pass(second.0, second.1, hz)
                        } else {
                            Section::FLAT
                        },
                        Section::peak(design.resonance.0, design.resonance.1, 1.2, hz),
                    ]
                })
                .collect(),
        }
    }
    /// The bank for `rate`, designed once. Call off the audio thread: this locks, and the first call computes.
    pub fn shared(rate: u32) -> Arc<Self> {
        static BANKS: Mutex<Vec<Arc<CabinetBank>>> = Mutex::new(Vec::new());
        let mut banks = BANKS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(bank) = banks.iter().find(|bank| bank.rate == rate) {
            return bank.clone();
        }
        let bank = Arc::new(Self::design(rate));
        banks.push(bank.clone());
        bank
    }
}
/// The sum of the products of two equal slices, in eight lanes the compiler can vectorize. The lanes keep the order of
/// the arithmetic fixed, so the result does not depend on how it is compiled.
#[inline]
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut lanes = [0.0f32; 8];
    let (x, y) = (a.chunks_exact(8), b.chunks_exact(8));
    let tail: f32 = x
        .remainder()
        .iter()
        .zip(y.remainder())
        .map(|(p, q)| p * q)
        .sum();
    for (p, q) in x.zip(y) {
        for lane in 0..8 {
            lanes[lane] += p[lane] * q[lane];
        }
    }
    lanes.iter().sum::<f32>() + tail
}
/// A cabinet's running state: the box filters per channel, and a history of the input for the FIR. One history serves
/// any model, so moving between two models crossfades two readings of the same past and cannot click.
pub struct Cabinet {
    bank: Arc<CabinetBank>,
    boxes: [[[f64; 2]; 3]; 2],
    /// Each channel's frames, held twice over so the latest `taps` always lie in one run.
    history: Vec<f32>,
    at: usize,
    /// Whether both channels hold the same state, as `Chain` keeps it.
    twin: bool,
    /// Whether it ran on the previous frame. A cabinet starting again starts silent.
    pub live: bool,
}
impl Cabinet {
    /// Call off the audio thread.
    pub fn new(rate: u32) -> Self {
        let bank = CabinetBank::shared(rate);
        let history = vec![0.0; bank.taps * 4];
        Self {
            bank,
            boxes: [[[0.0; 2]; 3]; 2],
            history,
            at: 0,
            twin: true,
            live: false,
        }
    }
    pub fn reset(&mut self) {
        self.history.fill(0.0);
        self.boxes = [[[0.0; 2]; 3]; 2];
        self.at = 0;
        self.twin = true;
    }
    /// One frame through the cabinet `to`, crossfading from `from` by `t`, or straight through `to` at `t` = 1.
    pub fn process(&mut self, from: usize, to: usize, t: f64, input: [f32; 2]) -> [f32; 2] {
        let bank = &*self.bank;
        let taps = bank.taps;
        let settled = from == to || t >= 1.0;
        let sections = if settled {
            bank.boxes[to]
        } else {
            let (a, b) = (&bank.boxes[from], &bank.boxes[to]);
            std::array::from_fn(|i| a[i].between(&b[i], t))
        };
        self.at = if self.at == 0 { taps - 1 } else { self.at - 1 };
        let at = self.at;
        let channel = |c: usize, x: f32, boxes: &mut [[f64; 2]; 3], history: &mut [f32]| {
            let mut v = x as f64;
            for (section, z) in sections.iter().zip(boxes) {
                v = section.run(z, v);
            }
            let line = &mut history[c * 2 * taps..(c + 1) * 2 * taps];
            line[at] = v as f32;
            line[at + taps] = v as f32;
            let recent = &line[at..at + taps];
            let y = dot(&bank.impulses[to], recent);
            if settled {
                y
            } else {
                let x = dot(&bank.impulses[from], recent);
                x + (y - x) * t as f32
            }
        };
        if self.twin {
            if input[0] == input[1] {
                let y = channel(0, input[0], &mut self.boxes[0], &mut self.history);
                return [y, y];
            }
            self.boxes[1] = self.boxes[0];
            self.history.copy_within(..2 * taps, 2 * taps);
            self.twin = false;
        }
        std::array::from_fn(|c| channel(c, input[c], &mut self.boxes[c], &mut self.history))
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// The amplitude of the `hz` line in `signal`, once settled.
    fn line(signal: &[f64], hz: f64, rate: f64) -> f64 {
        let tail = &signal[signal.len() / 2..];
        let (mut re, mut im) = (0.0, 0.0);
        for (n, y) in tail.iter().enumerate() {
            let phase = TAU * hz * n as f64 / rate;
            re += y * phase.cos();
            im += y * phase.sin();
        }
        2.0 * (re * re + im * im).sqrt() / tail.len() as f64
    }
    #[test]
    fn oversampling_passes_the_audio_band_and_rejects_its_images() {
        for hz in [100.0, 1_000.0, 10_000.0, 18_000.0] {
            let mut over = Oversampler::new(48_000.0);
            let (mut raised, mut lowered) = (vec![], vec![]);
            let mut block = [0.0; 4];
            for n in 0..48_000 {
                over.raise((TAU * hz * n as f64 / 48_000.0).sin(), &mut block);
                raised.extend_from_slice(&block);
                lowered.push(over.lower(&block));
            }
            let through = line(&lowered, hz, 48_000.0);
            assert!((through - 1.0).abs() < 1e-3, "{hz} Hz passes at {through}");
            for image in [48_000.0 - hz, 48_000.0 + hz, 96_000.0 - hz, 96_000.0 + hz] {
                let db = 20.0 * line(&raised, image, 192_000.0).log10();
                println!("{hz} Hz image at {image}: {db:.1} dB");
                assert!(db < -70.0, "{hz} Hz image at {image}: {db} dB");
            }
        }
    }
}
