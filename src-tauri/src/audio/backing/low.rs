//! The low band of the backing stretcher (THE-212).
//!
//! The grain stretcher in the parent module splices each grain where the waveform lines up with the previous one,
//! searching `radius` source frames either side of where it aims. A period longer than twice the radius (below about
//! 94 Hz for an unshifted voice at 48 kHz) has no lined-up splice in reach, so those grains land on the clock and drop
//! back the stretch each time: a sustained low tone comes out at its own pitch times the speed, and its level at its own
//! pitch is lost. Longer grains or a wider search for the low band cannot fix that without timing errors of up to half a
//! period and a second splice rule meeting the first at the crossover.
//!
//! While the voice stretches, the low band is therefore taken out of the grains and put back from a phase vocoder:
//!
//!   out = W(x) - W(low) + V(low)
//!
//! W is the grain stretcher, unchanged (the same search, on the whole signal, so the same splices); `low` is a
//! zero-phase low-pass of what the grains read, and V a phase vocoder on it. V's frames sit on the score clock, so its
//! level and timing follow the score. Below the grains' reach (`pass`) each partial's phase is carried forward at its own
//! frequency, so it keeps its pitch; above it, where the two bands overlap, V turns each partial to the phase the grains
//! read at, so that both halves of the crossover add up as before. Both channels turn by the same angle, which keeps
//! the stereo image.
//!
//! The low-pass is decimated to 32 times the lowest frequency the grains splice coherently (3 kHz at 48 kHz) and
//! computed while playing, a sample at a time as the clock reaches it, into a cache; V's frames are N samples there
//! (170 ms at 48 kHz). A frame that long would smear an attack, so attacks in the low band split it into segments: a frame
//! sees only its own segment, through a window that fades out smoothly towards the segment's edges; V's frames start
//! from the phases the grains read at whenever V is not heard; and the grains near an attack (where a frame would read
//! across it, or where its window has faded) keep the grain stretcher's own low band, with a grain's ramp either side.
//! At the neutral speed V does not come in, so the voice's output is the grains' own, bit for bit; when the speed
//! returns to it while V is heard, V keeps the low band until the next attack in it (or a seek), because handing it back
//! in the middle of a sustained partial would cross-fade two versions of it whose phases disagree.
//! Every buffer is made when the voice is built: nothing here allocates, locks or waits. Where the low band has to start
//! afresh (after a seek, a loop or the neutral speed), its work is spread over grains and V comes in once it has caught
//! up, so that no device callback carries all of it.

use super::{HOP, MAX_AIM, NEUTRAL_RATE, Transient};
use std::f64::consts::PI;

/// Frame length of the phase vocoder, in decimated samples: 170 ms at 48 kHz, which resolves partials 12 Hz apart
/// (an E1 with its fifth above).
const N: usize = 512;
/// The second analysis frame, which gives each partial's frequency, lies this many decimated samples from the first.
const DELTA: i64 = 8;
/// A frame's window fades out over this many decimated samples (11 ms at 48 kHz) towards either edge of its segment.
const TAPER: f64 = 32.0;
/// An attack in the low band is where the mean power of the next RISE_AHEAD decimated samples first exceeds RISE times
/// the loudest such mean over the RISE_BEHIND samples before them (64 ms at 48 kHz), plus RISE_FLOOR (about -60 dBFS,
/// so silence and hiss do not count). Comparing with the loudest, not the average, keeps the beating of two partials
/// (any beat faster than about 16 Hz) from counting as attacks.
const RISE_AHEAD: i64 = 8;
const RISE_BEHIND: usize = 192;
const HISTORY: usize = RISE_AHEAD as usize + RISE_BEHIND;
const RISE: f64 = 2.0;
const RISE_FLOOR: f64 = 1e-6;
/// The attack itself starts where the short-term power first reaches a quarter of its peak over the ATTACK_SEARCH
/// decimated samples from the detection (16 ms at 48 kHz); the detection can come several ms earlier, on the low-pass's
/// own ringing ahead of a loud attack.
const ATTACK_SEARCH: i64 = 48;
/// The grains keep their own low band while they read within ATTACK_HOLD decimated samples after an attack starts
/// (8 ms at 48 kHz), so the vocoder takes over in the decay, from phases the grains read at.
const ATTACK_HOLD: f64 = 24.0;
/// Below this share of the speed, the grains hear only frames whose whole window lies in their segment. Close to an
/// attack a frame sees only part of a partial, and the small error in its frequency there adds up over the stretch:
/// the 85 ms of source over which a frame is cut short take 850 ms to play at a tenth of the speed.
const WHOLE_BELOW: f64 = 0.4;
/// Decimated samples kept (a power of two), and attacks kept.
const CACHE: usize = 4096;
const ONSETS: usize = 64;
/// V follows the clock between these shares of the neutral speed: the practice speeds of 10 to 300% with key shifts of
/// more than an octave either way. Outside them the clock counts as unknown (a leap of it, or a map far too steep).
const MIN_RATIO: f64 = 1.0 / 32.0;
const MAX_RATIO: f64 = 8.0;
/// V is made only where a grain reads at most this many decimated samples (twice what it reads with the grain search
/// at its usual radius); further, the search radius is at its cap and a frame would not span what the grains read.
const MOST_READ: f64 = 32.0;
/// While V is out, the attack scan computes at most this many multiplies of the low-pass per grain (about 0.1 ms), and
/// at least twice what the clock moves on over a grain. A seek, a loop or a return from the neutral speed into audio
/// the low band has not seen needs some 850 decimated samples before V can come in, which at once take 0.5 ms of one
/// device callback at 48 kHz and 2.3 ms for a 192 kHz file an octave up. V comes in once the scan has caught up
/// instead: 1 to 5 grains later at 48 kHz (21 to 43 ms after a seek instead of 16), 22 to 25 grains later for files at
/// 192 and 384 kHz an octave up (133 to 149 ms); the grains keep their own low band until then.
const CATCH_UP: usize = 1 << 18;
/// The low band hears the decoded audio clipped at this (+12 dBFS), far above what a decoder gives for real audio. A
/// damaged or hostile file may hold samples up to the largest an f32 holds (or not numbers at all), which overflow the
/// low-pass's sums or, finite, would put a pulse of that size into V's frames for as long as they span; clipped, such a
/// sample is a loud click, which the low band handles like any other.
const CLIP: f32 = 4.0;

/// What the grains read: the decoded frames, the frames the sync map lets through, and the isolated impulses the voice
/// takes out and adds back on the clock.
pub(super) struct Source<'a> {
    pub(super) frames: &'a [[f32; 2]],
    pub(super) first: i64,
    pub(super) end: i64,
    pub(super) transients: &'a [Transient],
}

pub(super) struct LowBand {
    step: f64,
    radius: f64,
    factor: i64,
    d: f64,
    /// Half of the symmetric low-pass, centre first.
    taps: Vec<f32>,
    /// The largest the low-pass gives for audio clipped at CLIP: CLIP times the sum of the taps' magnitudes.
    most: f32,
    /// Partials below this (radians per decimated sample) keep their own phase; above it they follow the grains.
    pass: f64,
    /// The highest bin V keeps.
    top: usize,
    /// How far a frame's grain advances from one frame to the next, in decimated samples.
    hop: f64,
    window: Vec<f64>,
    transform: Transform,
    /// For each of the 2 * HOP output frames a frame spans: the grain sample before the read and the four weights.
    read_base: Vec<usize>,
    read_weights: Vec<[f64; 4]>,
    fade: Vec<f64>,
    /// What the inverse transform's samples are multiplied by: one over the analysis window and over N / 2.
    synthesis: Vec<f64>,
    cache: Vec<[f32; 2]>,
    tags: Vec<i64>,
    /// Decimated samples the low-pass computed during this grain, and how many the scan may compute in one.
    spent: usize,
    catch_up: usize,
    /// Frames made during this grain, and the most samples and frames any grain took since tests last asked.
    frames: usize,
    most_spent: usize,
    most_frames: usize,
    onsets: [f64; ONSETS],
    onset_first: usize,
    onset_count: usize,
    /// The latest attack forgotten, so a long segment keeps its start.
    dropped: f64,
    scanning: bool,
    scan_from: i64,
    scan_next: i64,
    scan_last: bool,
    /// The short-term power at the HISTORY decimated samples before `scan_next`, oldest at `recent_at`.
    recent: Vec<f64>,
    recent_at: usize,
    /// The windowed low band of a frame, and of the frame DELTA decimated samples from it.
    frame_a: Vec<[f64; 2]>,
    frame_b: Vec<[f64; 2]>,
    /// The window both frames were taken with: the analysis window, tapered at the segment's edges.
    weights: Vec<f64>,
    /// The spectra of each channel of the two frames, to N / 2 (zero above `top`).
    left: Vec<[f64; 2]>,
    right: Vec<[f64; 2]>,
    b_left: Vec<[f64; 2]>,
    b_right: Vec<[f64; 2]>,
    power: Vec<f64>,
    arg: Vec<f64>,
    side: Vec<bool>,
    theta: Vec<f64>,
    /// The window's phase at each bin's partial, and the phase each bin's partial is carried forward with.
    psi: Vec<f64>,
    phase: Vec<f64>,
    peaks: Vec<usize>,
    grain: Vec<[f64; 2]>,
    framed: bool,
    /// Whether the last frame started over from the phases the grains read at (what it carries is then in step with
    /// them), rather than carrying V's own phases on.
    restarted: bool,
    segment: f64,
    carry: [[f32; 2]; HOP],
    next_carry: [[f32; 2]; HOP],
    v: [[f32; 2]; HOP],
    tail: [[f32; 2]; HOP],
    tail_valid: bool,
    alpha: f32,
    rate: f64,
    /// What a grain adds to the grain stretcher's output.
    pub(super) delta: [[f32; 2]; HOP],
}

impl LowBand {
    /// The low band of a voice reading `step` source frames per output frame with a grain search of `radius` source
    /// frames, or None when the search is too narrow for a decimated band (under 16 frames either side, which needs a
    /// file at a sixteenth of the output rate or less) or held at its cap far below what a grain reads (a file at many
    /// times the output rate, shifted up).
    pub(super) fn new(step: f64, radius: i32, source_rate: u32) -> Option<Box<Self>> {
        if radius < 16 || !step.is_finite() || step <= 0.0 {
            return None;
        }
        let rate = source_rate as f64;
        // The lowest frequency whose period the search spans: below it a grain may find no lined-up splice.
        let lock = rate / (2.0 * radius as f64);
        let factor = (radius / 16).max(1) as i64;
        let d = factor as f64;
        if HOP as f64 * step / d > MOST_READ {
            return None;
        }
        let taps = lowpass(rate, 2.625 * lock, 2.75 * lock);
        let most = CLIP * (taps[0].abs() + 2.0 * taps[1..].iter().map(|h| h.abs()).sum::<f32>());
        // A decimated sample costs a multiply per tap held and channel.
        let catch_up = CATCH_UP / (2 * taps.len());
        let window: Vec<f64> = (0..N)
            .map(|n| 0.5 - 0.5 * (2.0 * PI * n as f64 / N as f64).cos())
            .collect();
        let mut read_base = Vec::with_capacity(2 * HOP);
        let mut read_weights = Vec::with_capacity(2 * HOP);
        for i in 0..2 * HOP {
            let u = (N / 2) as f64 + (i as f64 - HOP as f64) * step / d;
            let base = u.floor();
            read_base.push(base as usize);
            read_weights.push(cubic(u - base));
        }
        let top = ((6.0 * lock * d / rate * N as f64).ceil() as usize).clamp(4, N / 2 - 1);
        Some(Box::new(Self {
            step,
            radius: radius as f64,
            factor,
            d,
            taps,
            most,
            pass: 2.0 * PI * 1.25 * lock * d / rate,
            top,
            hop: HOP as f64 * step / d,
            synthesis: window
                .iter()
                .map(|w| if *w > 0.0 { 2.0 / (w * N as f64) } else { 0.0 })
                .collect(),
            window,
            transform: Transform::new(),
            read_base,
            read_weights,
            fade: (0..2 * HOP)
                .map(|i| 0.5 - 0.5 * (PI * i as f64 / HOP as f64).cos())
                .collect(),
            cache: vec![[0.0; 2]; CACHE],
            tags: vec![i64::MIN; CACHE],
            spent: 0,
            catch_up,
            frames: 0,
            most_spent: 0,
            most_frames: 0,
            onsets: [0.0; ONSETS],
            onset_first: 0,
            onset_count: 0,
            dropped: f64::NEG_INFINITY,
            scanning: false,
            scan_from: 0,
            scan_next: 0,
            scan_last: false,
            recent: vec![0.0; HISTORY],
            recent_at: 0,
            frame_a: vec![[0.0; 2]; N],
            frame_b: vec![[0.0; 2]; N],
            weights: vec![0.0; N],
            left: vec![[0.0; 2]; N / 2 + 1],
            right: vec![[0.0; 2]; N / 2 + 1],
            b_left: vec![[0.0; 2]; N / 2 + 1],
            b_right: vec![[0.0; 2]; N / 2 + 1],
            power: vec![0.0; N / 2 + 1],
            arg: vec![0.0; N / 2 + 1],
            side: vec![false; N / 2 + 1],
            theta: vec![0.0; N / 2 + 1],
            psi: vec![0.0; N / 2 + 1],
            phase: vec![0.0; N / 2 + 1],
            peaks: Vec::with_capacity(N / 2 + 1),
            grain: vec![[0.0; 2]; N],
            framed: false,
            restarted: true,
            segment: f64::NEG_INFINITY,
            carry: [[0.0; 2]; HOP],
            next_carry: [[0.0; 2]; HOP],
            v: [[0.0; 2]; HOP],
            tail: [[0.0; 2]; HOP],
            tail_valid: false,
            alpha: 0.0,
            rate: step,
            delta: [[0.0; 2]; HOP],
        }))
    }

    /// Forgets the position (a seek); the cached low band stays, since it depends on the source alone.
    pub(super) fn reset(&mut self) {
        self.scanning = false;
        self.onset_count = 0;
        self.dropped = f64::NEG_INFINITY;
        self.framed = false;
        self.tail_valid = false;
        self.alpha = 0.0;
        self.carry = [[0.0; 2]; HOP];
    }

    /// The low band of one grain, whose first output frame is at source position `clock` on the score clock, while the
    /// clock moves `rate` source frames per output frame (None when unknown, right after a seek); the grain reads from
    /// `best`, and the previous one read from `previous` (None when there was none to crossfade from). Returns whether
    /// `delta` holds something to add to the grain.
    pub(super) fn grain(
        &mut self,
        source: &Source,
        clock: f64,
        rate: Option<f64>,
        best: f64,
        previous: Option<f64>,
    ) -> bool {
        self.spent = 0;
        self.frames = 0;
        let heard = self.prepare(source, clock, rate, best, previous);
        self.most_spent = self.most_spent.max(self.spent);
        self.most_frames = self.most_frames.max(self.frames);
        heard
    }

    /// For tests: the most decimated samples the low-pass computed and the most frames made in any one grain since the
    /// last call.
    pub(super) fn take_work(&mut self) -> (usize, usize) {
        let work = (self.most_spent, self.most_frames);
        self.most_spent = 0;
        self.most_frames = 0;
        work
    }

    fn prepare(
        &mut self,
        source: &Source,
        clock: f64,
        rate: Option<f64>,
        best: f64,
        previous: Option<f64>,
    ) -> bool {
        // Far outside the source there is nothing to hear (the voice is silent there), and a clock that far out may be
        // beyond what a sample index can hold: V stays out, and starts over when it comes back in.
        let far = 2.0 * (N as f64) * self.d + MAX_AIM;
        if !(clock > source.first as f64 - far && clock < source.end as f64 + far) {
            self.framed = false;
            self.tail_valid = false;
            self.alpha = 0.0;
            return false;
        }
        // V follows a clock that moves at a speed it was made for (the practice speeds, with key shifts of an octave or
        // more either way); a clock that leaps (a jump that is not a seek, or a map that steep) counts as unknown.
        let rate = rate.filter(|r| {
            r.is_finite() && *r >= MIN_RATIO * self.step && *r <= MAX_RATIO * self.step
        });
        // V comes in only while the voice stretches; once in, it stays through a return to the neutral speed until it hands
        // the low band back to the grains at an attack (or a seek). Handing it back while a partial sounds would cross-fade
        // two versions of it whose phases disagree, which can cancel it for a moment.
        let active =
            rate.is_some_and(|r| (r - self.step).abs() >= NEUTRAL_RATE || self.alpha > 0.0);
        if !active && self.alpha == 0.0 {
            self.framed = false;
            self.tail_valid = false;
            return false;
        }
        if let Some(rate) = rate {
            self.rate = rate;
        }
        let ahead = HOP as f64 * self.rate;
        let reach = HOP as f64 * self.step;
        let (s0, s1) = (clock, clock + ahead);
        let s2 = s1 + ahead;
        // Every attack that decides how a frame here is windowed, or whether the grains may hear it (`usable`), is known:
        // a frame reads N / 2 + DELTA decimated samples either side of its centre and `usable` looks N / 2 + TAPER past it.
        let span = ((N / 2) as f64 + TAPER + (DELTA + 8) as f64) * self.d;
        let margin = 4.0 * self.d;
        let hold = ATTACK_HOLD * self.d;
        // What this grain hears from the grains (the previous grain's continuation and this grain's start), and what the
        // next grain may: it continues this one and starts where its search lands, within `radius` of where it aims.
        let (now_lo, now_hi) = match previous {
            Some(previous) => (
                (previous + reach).min(best),
                (previous + 2.0 * reach).max(best + reach),
            ),
            None => (best, best + reach),
        };
        let aim = s1 + ((HOP as f64 - 0.5) * (self.rate - self.step)).clamp(-MAX_AIM, MAX_AIM);
        let (next_lo, next_hi) = (
            (best + reach).min(aim - self.radius),
            (best + 2.0 * reach).max(aim + self.radius + reach),
        );
        // The attacks are needed wherever the frames or the grains read, only while V may stay in. The scan spreads its
        // work over grains (see CATCH_UP), in every grain; what the frames and the grains read lies in what it has
        // computed once it has caught up.
        let limit = self
            .catch_up
            .max(2 * (HOP as f64 * self.rate / self.d).ceil() as usize + 16);
        let ready = if active {
            self.scan(
                source,
                (s0.min(s2) - span).min(now_lo.min(next_lo) - margin - hold),
                (s0.max(s2) + span).max(now_hi.max(next_hi) + margin),
                limit,
            )
        } else {
            self.scan(source, s0.min(s2) - span, s0.max(s2) + span, limit)
        };
        if !ready {
            if self.alpha == 0.0 {
                self.framed = false;
                self.tail_valid = false;
                return false;
            }
            // V is heard, but where it would read next is not scanned yet: the clock leapt without a seek (a map that
            // steep, or a jump). V leaves over this grain from what its last frame carries into it, making no frame
            // here, and comes back once the scan has caught up.
            return self.leave(source, best, previous);
        }
        if !self.framed || (self.alpha == 0.0 && !self.restarted) {
            // Nothing carries into this grain, or what carries holds V's own phases while V comes in from the grains'
            // (it left in the last grain): its first half comes from a frame centred on its first output frame.
            self.frame(source, s0, best, true);
            self.synthesize(false);
        }
        // While V is not heard, its frames start over from the phases the grains read at, so that it comes in in step
        // with them.
        let restart = self.alpha == 0.0;
        self.frame(source, s1, best + reach, restart);
        self.synthesize(true);
        // A grain uses V only where nothing it hears reads across an attack: neither of the two frames (from their
        // centre on, and up to it), nor the grains (the previous grain's continuation and this grain's start). Where the
        // grains read an attack earlier or later than the clock, V's frames on the other side of it would leave the
        // attack's low half out, or put it in twice.
        let now = active
            && !self.attack_near(now_lo - margin, now_hi + margin, 0.0, hold)
            && self.usable(s0)
            && self.usable(s1);
        let next = now
            && !self.attack_near(next_lo - margin, next_hi + margin, 0.0, hold)
            && self.usable(s2);
        // At a steady speed the previous grain's look ahead has already kept V out of a grain that cannot use it; when
        // the speed changes, V still leaves over this grain's ramp, never at once.
        let a0 = self.alpha;
        let a1 = if next { 1.0 } else { 0.0 };
        self.alpha = a1;
        if a0 == 0.0 && a1 == 0.0 {
            self.tail_valid = false;
            return false;
        }
        if let Some(previous) = previous
            && !self.tail_valid
        {
            for i in 0..HOP {
                self.tail[i] = self.read(source, previous + (i + HOP) as f64 * self.step);
            }
        }
        for i in 0..HOP {
            let t = i as f32 / HOP as f32;
            let head = self.read(source, best + i as f64 * self.step);
            // The grain stretcher's own low band, crossfaded exactly as it crossfades the grains.
            let heard: [f32; 2] = if previous.is_some() {
                std::array::from_fn(|c| self.tail[i][c] * (1.0 - t) + head[c] * t)
            } else {
                head
            };
            let a = a0 + (a1 - a0) * t;
            self.delta[i] = std::array::from_fn(|c| finite(a * (self.v[i][c] - heard[c])));
            self.tail[i] = self.read(source, best + (i + HOP) as f64 * self.step);
        }
        self.tail_valid = true;
        true
    }

    /// V leaves over this grain from what the last frame carries into it (its second half, already faded out by its
    /// window), while the grains' own low band fades in by the same window; no frame is made.
    fn leave(&mut self, source: &Source, best: f64, previous: Option<f64>) -> bool {
        if let Some(previous) = previous
            && !self.tail_valid
        {
            for i in 0..HOP {
                self.tail[i] = self.read(source, previous + (i + HOP) as f64 * self.step);
            }
        }
        for i in 0..HOP {
            let t = i as f32 / HOP as f32;
            let head = self.read(source, best + i as f64 * self.step);
            let heard: [f32; 2] = if previous.is_some() {
                std::array::from_fn(|c| self.tail[i][c] * (1.0 - t) + head[c] * t)
            } else {
                head
            };
            let out = self.fade[HOP + i] as f32;
            self.delta[i] = std::array::from_fn(|c| finite(self.carry[i][c] - out * heard[c]));
        }
        self.carry = [[0.0; 2]; HOP];
        self.framed = false;
        self.tail_valid = false;
        self.alpha = 0.0;
        true
    }

    /// The decimated low band at `j` (source frame `j * factor`).
    fn low(&mut self, source: &Source, j: i64) -> [f32; 2] {
        let slot = (j as u64 as usize) & (CACHE - 1);
        if self.tags[slot] != j {
            self.cache[slot] = self.filter(source, j);
            self.tags[slot] = j;
            self.spent += 1;
        }
        self.cache[slot]
    }

    fn filter(&self, source: &Source, j: i64) -> [f32; 2] {
        let m = self.taps.len() as i64 - 1;
        let c = j * self.factor;
        let lo = (c - m).max(source.first);
        let hi = (c + m + 1).min(source.end);
        if lo >= hi {
            return [0.0; 2];
        }
        let x = source.frames;
        let h = &self.taps;
        let mut acc = [0.0f32; 2];
        if lo == c - m && hi == c + m + 1 {
            let c = c as usize;
            let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
            for k in 1..=m as usize {
                let (a, b) = (x[c - k], x[c + k]);
                l[k & 3] += h[k] * (a[0] + b[0]);
                r[k & 3] += h[k] * (a[1] + b[1]);
            }
            acc[0] = h[0] * x[c][0] + (l[0] + l[1]) + (l[2] + l[3]);
            acc[1] = h[0] * x[c][1] + (r[0] + r[1]) + (r[2] + r[3]);
        } else {
            for t in lo..hi {
                let w = h[(t - c).unsigned_abs() as usize];
                let s = x[t as usize];
                acc[0] += w * s[0];
                acc[1] += w * s[1];
            }
        }
        let from = source.transients.partition_point(|t| (t.frame as i64) < lo);
        for t in &source.transients[from..] {
            let f = t.frame as i64;
            if f >= hi {
                break;
            }
            let w = h[(f - c).unsigned_abs() as usize];
            acc[0] -= w * t.sample[0];
            acc[1] -= w * t.sample[1];
        }
        if acc[0].abs() <= self.most && acc[1].abs() <= self.most {
            acc
        } else {
            // A sample beyond CLIP (or not a number) is in reach: the same sum from the samples clipped, which is never
            // larger than `most`. Real audio never comes here.
            let mut acc = [0.0f32; 2];
            for t in lo..hi {
                let w = h[(t - c).unsigned_abs() as usize];
                let s = x[t as usize];
                acc[0] += w * clip(s[0]);
                acc[1] += w * clip(s[1]);
            }
            for t in &source.transients[from..] {
                let f = t.frame as i64;
                if f >= hi {
                    break;
                }
                let w = h[(f - c).unsigned_abs() as usize];
                acc[0] -= w * clip(t.sample[0]);
                acc[1] -= w * clip(t.sample[1]);
            }
            acc
        }
    }

    /// The low band at a source position, from the decimated samples by four-point Lagrange interpolation.
    fn read(&mut self, source: &Source, position: f64) -> [f32; 2] {
        let u = position / self.d;
        let base = u.floor();
        let w = cubic(u - base);
        let base = base as i64;
        let mut sum = [0.0f64; 2];
        for (k, w) in w.iter().enumerate() {
            let v = self.low(source, base - 1 + k as i64);
            sum[0] += w * v[0] as f64;
            sum[1] += w * v[1] as f64;
        }
        [sum[0] as f32, sum[1] as f32]
    }

    fn power(&mut self, source: &Source, j: i64) -> f64 {
        let v = self.low(source, j);
        (v[0] * v[0] + v[1] * v[1]) as f64
    }

    /// The mean power of the RISE_AHEAD decimated samples from `j`.
    fn energy(&mut self, source: &Source, j: i64) -> f64 {
        (0..RISE_AHEAD)
            .map(|k| self.power(source, j + k))
            .sum::<f64>()
            / RISE_AHEAD as f64
    }

    /// Whether `scan_next` is past an attack's start, and moves the history on.
    fn rising(&mut self, source: &Source) -> bool {
        let now = self.energy(source, self.scan_next);
        let loudest = (0..RISE_BEHIND)
            .map(|b| self.recent[(self.recent_at + b) % HISTORY])
            .fold(0.0, f64::max);
        self.recent[self.recent_at] = now;
        self.recent_at = (self.recent_at + 1) % HISTORY;
        now > RISE * loudest + RISE_FLOOR
    }

    /// Finds the attacks between source positions `from` and `to`, continuing from where the last call stopped, until
    /// the low-pass has computed `limit` decimated samples during this grain. Returns whether it reached `to`.
    fn scan(&mut self, source: &Source, from: f64, to: f64, limit: usize) -> bool {
        let lo = (from / self.d).floor() as i64;
        // A grain's range is at most about a quarter of the cache; this bounds the work of one call whatever it is given.
        let hi = ((to / self.d).ceil() as i64).min(lo.saturating_add((CACHE / 2) as i64));
        if !self.scanning || lo < self.scan_from || lo > self.scan_next + (CACHE / 4) as i64 {
            // Start over at `lo`: the HISTORY samples before it first fill the history, without counting attacks, so
            // that what is found from `lo` on is what a scan from further back would find.
            self.scanning = true;
            self.scan_from = lo;
            self.scan_next = lo - 1 - HISTORY as i64;
            self.recent_at = 0;
            self.scan_last = false;
            self.onset_count = 0;
            self.dropped = f64::NEG_INFINITY;
        }
        while self.scan_next <= hi && self.spent < limit {
            let now = self.rising(source);
            if now && !self.scan_last && self.scan_next >= self.scan_from {
                let from = self.scan_next;
                let peak = (0..ATTACK_SEARCH)
                    .map(|k| self.energy(source, from + k))
                    .fold(0.0, f64::max);
                let start = (0..ATTACK_SEARCH)
                    .find(|&k| self.energy(source, from + k) >= 0.25 * peak)
                    .unwrap_or(0);
                let mut at = (from + start) as f64 * self.d;
                if self.onset_count > 0 {
                    at = at.max(self.onsets[(self.onset_first + self.onset_count - 1) % ONSETS]);
                }
                if self.onset_count == ONSETS {
                    self.forget();
                }
                self.onsets[(self.onset_first + self.onset_count) % ONSETS] = at;
                self.onset_count += 1;
            }
            self.scan_last = now;
            self.scan_next += 1;
        }
        while self.onset_count > 0 && self.onsets[self.onset_first] < from {
            self.forget();
        }
        self.scan_next > hi
    }

    fn forget(&mut self) {
        self.dropped = self.onsets[self.onset_first];
        self.onset_first = (self.onset_first + 1) % ONSETS;
        self.onset_count -= 1;
    }

    /// The segment holding source position `s`: from the last attack at or before it to the first after it.
    fn segment(&self, s: f64) -> (f64, f64) {
        let mut lo = self.dropped;
        for i in 0..self.onset_count {
            let o = self.onsets[(self.onset_first + i) % ONSETS];
            if o > s {
                return (lo, o);
            }
            lo = o;
        }
        (lo, f64::INFINITY)
    }

    /// Whether an attack, widened by `before` and `after` source frames, overlaps source positions `a..=b`.
    fn attack_near(&self, a: f64, b: f64, before: f64, after: f64) -> bool {
        (0..self.onset_count).any(|i| {
            let o = self.onsets[(self.onset_first + i) % ONSETS];
            o - before <= b && o + after >= a
        })
    }

    /// For a frame centred on decimated sample `index`: its segment's start, which way the second frame lies (`lag`
    /// decimated samples earlier; negative: later), and the source positions both frames may take samples from.
    fn layout(&self, index: i64) -> (f64, i64, f64, f64) {
        let centre = index as f64 * self.d;
        let (lo, hi) = self.segment(centre);
        // The second frame lies away from the nearer edge of the segment, so the window is not shortened there.
        let lag = if centre - lo < hi - centre {
            -DELTA
        } else {
            DELTA
        };
        let from = lo + lag.max(0) as f64 * self.d;
        let to = hi - (-lag).max(0) as f64 * self.d;
        (lo, lag, from, to)
    }

    /// Whether the grains may hear the frame centred on source position `centre`: they read it `reach` either side of
    /// its centre, which must be clear of its window's taper. Below WHOLE_BELOW of the speed, the whole window must be.
    fn usable(&self, centre: f64) -> bool {
        let index = (centre / self.d).round() as i64;
        let (_, _, from, to) = self.layout(index);
        let c = index as f64 * self.d;
        let clear = if self.rate < WHOLE_BELOW * self.step {
            ((N / 2) as f64 + TAPER) * self.d
        } else {
            HOP as f64 * self.step + (TAPER + 4.0) * self.d
        };
        c - clear >= from && c + clear <= to
    }

    /// One frame centred on source position `centre`, whose middle the grains read from `at`; it leaves its grain
    /// (divided by the analysis window) in `grain`.
    fn frame(&mut self, source: &Source, centre: f64, at: f64, restart: bool) {
        let centre_index = (centre / self.d).round() as i64;
        let (lo, lag, from, to) = self.layout(centre_index);
        let restart = restart || !self.framed || lo != self.segment;
        self.framed = true;
        self.restarted = restart;
        self.segment = lo;
        self.frames += 1;
        let start = centre_index - (N / 2) as i64;
        // Both frames take the same window positions (where both stay in the segment): they differ only by the delay,
        // which keeps the frequency estimate unbiased at a segment's edge.
        let mut tapered = false;
        for n in 0..N {
            let j = start + n as i64;
            let position = j as f64 * self.d;
            // A smooth edge, not a cut: a cut spreads a low partial over the whole spectrum, down to 0 Hz and its
            // mirror image, which one turn per partial cannot follow.
            let edge =
                taper((position - from) / self.d, TAPER) * taper((to - position) / self.d, TAPER);
            tapered |= edge < 1.0 && n > 0;
            let (a, b) = if edge > 0.0 {
                (self.low(source, j), self.low(source, j - lag))
            } else {
                ([0.0; 2], [0.0; 2])
            };
            let w = self.window[n] * edge;
            self.weights[n] = w;
            self.frame_a[n] = [w * a[0] as f64, w * a[1] as f64];
            self.frame_b[n] = [w * b[0] as f64, w * b[1] as f64];
        }
        let top = self.top;
        // Each channel has its own transform, done the same way, so a channel that is a copy of the other, its
        // negative or silent stays exactly so.
        self.transform
            .forward(&self.frame_a, 0, top, &mut self.left);
        self.transform
            .forward(&self.frame_a, 1, top, &mut self.right);
        self.transform
            .forward(&self.frame_b, 0, top, &mut self.b_left);
        self.transform
            .forward(&self.frame_b, 1, top, &mut self.b_right);
        let mut loudest = 0.0f64;
        for k in 0..=top {
            let (l, r) = (self.left[k], self.right[k]);
            let power = l[0] * l[0] + l[1] * l[1] + r[0] * r[0] + r[1] * r[1];
            let mid = [l[0] + r[0], l[1] + r[1]];
            // Both channels turn by one angle, taken from their sum, or from their difference when they cancel.
            let side = mid[0] * mid[0] + mid[1] * mid[1] < 0.25 * power;
            let reference = if side {
                [l[0] - r[0], l[1] - r[1]]
            } else {
                mid
            };
            self.power[k] = power;
            self.side[k] = side;
            self.arg[k] = reference[1].atan2(reference[0]);
            loudest = loudest.max(power);
        }
        self.peaks.clear();
        let floor = (loudest * 1e-9).max(1e-24);
        for k in 1..top {
            let p = self.power[k];
            if p > floor && p > self.power[k - 1] && p >= self.power[k + 1] {
                self.peaks.push(k);
            }
        }
        // Where the grains read, relative to this frame's centre, in decimated samples.
        let shift = (at - centre_index as f64 * self.d) / self.d;
        for i in 0..self.peaks.len() {
            let p = self.peaks[i];
            let (l, r) = (self.b_left[p], self.b_right[p]);
            let reference = if self.side[p] {
                [l[0] - r[0], l[1] - r[1]]
            } else {
                [l[0] + r[0], l[1] + r[1]]
            };
            let bin = 2.0 * PI * p as f64 / N as f64;
            let before = reference[1].atan2(reference[0]);
            let omega = bin + wrap(self.arg[p] - before - bin * lag as f64) / lag as f64;
            // A peak's phase is the partial's phase at the frame's centre plus the window's own phase there, which is
            // nothing for the symmetric window but not for one tapered at a segment's edge; it changes as the frame
            // moves away from the edge, so it is taken out of what is carried forward.
            self.psi[p] = if tapered && omega < 2.0 * self.pass {
                self.window_phase(bin - omega)
            } else {
                0.0
            };
            self.theta[p] = if !restart && omega < self.pass {
                self.phase[p] + omega * self.hop - (self.arg[p] - self.psi[p])
            } else {
                omega * shift
            };
        }
        if let (Some(&first), Some(&last)) = (self.peaks.first(), self.peaks.last()) {
            // Identity phase locking: every bin turns with the peak whose lobe it is in.
            for k in 0..first {
                self.theta[k] = self.theta[first];
                self.psi[k] = self.psi[first];
            }
            for i in 1..self.peaks.len() {
                let (p, q) = (self.peaks[i - 1], self.peaks[i]);
                let mut valley = p;
                for k in p + 1..q {
                    if valley == p || self.power[k] < self.power[valley] {
                        valley = k;
                    }
                }
                for k in p + 1..q {
                    let lobe = if k <= valley { p } else { q };
                    self.theta[k] = self.theta[lobe];
                    self.psi[k] = self.psi[lobe];
                }
            }
            for k in last + 1..=top {
                self.theta[k] = self.theta[last];
                self.psi[k] = self.psi[last];
            }
        } else {
            for k in 0..=top {
                self.theta[k] = 2.0 * PI * k as f64 / N as f64 * shift;
                self.psi[k] = 0.0;
            }
        }
        self.theta[0] = 0.0;
        for k in 0..=top {
            self.phase[k] = wrap(self.arg[k] - self.psi[k] + self.theta[k]);
            let (s, c) = self.theta[k].sin_cos();
            let (l, r) = (self.left[k], self.right[k]);
            self.left[k] = [l[0] * c - l[1] * s, l[0] * s + l[1] * c];
            self.right[k] = [r[0] * c - r[1] * s, r[0] * s + r[1] * c];
        }
        // The low band is bounded (see CLIP), so this cannot happen; if it ever did, nothing of it is carried on: the
        // frame is silent and the next one starts over.
        if !self.phase[..=top].iter().all(|p| p.is_finite()) {
            self.phase.fill(0.0);
            self.left.fill([0.0; 2]);
            self.right.fill([0.0; 2]);
            self.restarted = true;
            self.framed = false;
        }
        self.transform
            .inverse(&self.left, &self.synthesis, &mut self.grain, 0);
        self.transform
            .inverse(&self.right, &self.synthesis, &mut self.grain, 1);
    }

    /// The phase of the last frame's window (`weights`) at `delta` radians per decimated sample from a partial,
    /// about the frame's centre: arg sum w[n] e^(-i delta (n - N / 2)).
    fn window_phase(&self, delta: f64) -> f64 {
        let (s, c) = delta.sin_cos();
        let (mut zi, mut zr) = (delta * (N / 2) as f64).sin_cos();
        let (mut re, mut im) = (0.0, 0.0);
        for &w in &self.weights {
            re += w * zr;
            im += w * zi;
            (zr, zi) = (zr * c + zi * s, zi * c - zr * s);
        }
        im.atan2(re)
    }

    /// Adds the last frame, centred HOP output frames into this grain, to the grain's output (`v`) and to what carries
    /// into the next grain; or, with `into_grain` false, only to what carries (a frame centred on this grain's start).
    fn synthesize(&mut self, into_grain: bool) {
        for i in 0..2 * HOP {
            if !into_grain && i < HOP {
                continue;
            }
            let base = self.read_base[i];
            let w = self.read_weights[i];
            let mut sum = [0.0f64; 2];
            for (k, w) in w.iter().enumerate() {
                let g = self.grain[base + k - 1];
                sum[0] += w * g[0];
                sum[1] += w * g[1];
            }
            let fade = self.fade[i];
            let value = [(sum[0] * fade) as f32, (sum[1] * fade) as f32];
            if i < HOP {
                self.v[i] = [self.carry[i][0] + value[0], self.carry[i][1] + value[1]];
            } else {
                self.next_carry[i - HOP] = value;
            }
        }
        self.carry = self.next_carry;
    }
}

/// Weights of four-point Lagrange interpolation at fraction `f` past the second point.
fn cubic(f: f64) -> [f64; 4] {
    [
        -f * (f - 1.0) * (f - 2.0) / 6.0,
        (f + 1.0) * (f - 1.0) * (f - 2.0) / 2.0,
        -(f + 1.0) * f * (f - 2.0) / 2.0,
        (f + 1.0) * f * (f - 1.0) / 6.0,
    ]
}

/// A raised-cosine edge of `length` samples: 0 at `t` 0 and below, 1 from `length` on.
fn taper(t: f64, length: f64) -> f64 {
    if t <= 0.0 {
        0.0
    } else if t >= length {
        1.0
    } else {
        0.5 - 0.5 * (PI * t / length).cos()
    }
}

/// A decoded sample clipped at CLIP; zero for one that is not a number.
fn clip(x: f32) -> f32 {
    if x.abs() <= CLIP {
        x
    } else if x > 0.0 {
        CLIP
    } else if x < 0.0 {
        -CLIP
    } else {
        0.0
    }
}

/// Zero for what is not a finite number: what a grain adds is never anything else.
fn finite(x: f32) -> f32 {
    if x.is_finite() { x } else { 0.0 }
}

fn wrap(angle: f64) -> f64 {
    angle - 2.0 * PI * (angle / (2.0 * PI)).round()
}

/// The transform of N real samples, X[k] = sum x[n] e^(-2 pi i k n / N), by a complex transform of half the length
/// (the even samples as its real part, the odd ones as its imaginary part).
struct Transform {
    /// cos and sin of 2 pi k / N, for k below N / 2.
    cos: Vec<f64>,
    sin: Vec<f64>,
    bitrev: Vec<usize>,
    re: Vec<f64>,
    im: Vec<f64>,
}

impl Transform {
    fn new() -> Self {
        let m = N / 2;
        let bits = m.trailing_zeros();
        Self {
            cos: (0..m)
                .map(|k| (2.0 * PI * k as f64 / N as f64).cos())
                .collect(),
            sin: (0..m)
                .map(|k| (2.0 * PI * k as f64 / N as f64).sin())
                .collect(),
            bitrev: (0..m)
                .map(|i| i.reverse_bits() >> (usize::BITS - bits))
                .collect(),
            re: vec![0.0; m],
            im: vec![0.0; m],
        }
    }

    /// In-place radix-2 transform of the N / 2 complex points in `re` and `im`.
    fn half(&mut self) {
        let m = N / 2;
        let (re, im) = (&mut self.re, &mut self.im);
        for i in 0..m {
            let j = self.bitrev[i];
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= m {
            let half = size / 2;
            // The twiddle for k of `size` points is 2 pi k / size = 2 pi (k N / size) / N.
            let stride = N / size;
            for start in (0..m).step_by(size) {
                for k in 0..half {
                    let (c, s) = (self.cos[k * stride], self.sin[k * stride]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * c + im[b] * s;
                    let ti = im[b] * c - re[b] * s;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            size *= 2;
        }
    }

    /// Bins 0..=top (below N / 2) of the transform of `x[n][channel]`, into `out`.
    fn forward(&mut self, x: &[[f64; 2]], channel: usize, top: usize, out: &mut [[f64; 2]]) {
        let m = N / 2;
        for i in 0..m {
            self.re[i] = x[2 * i][channel];
            self.im[i] = x[2 * i + 1][channel];
        }
        self.half();
        for (k, out) in out.iter_mut().enumerate().take(top + 1) {
            let j = (m - k) % m;
            let (ar, ai, br, bi) = (self.re[k], self.im[k], self.re[j], self.im[j]);
            // The transforms of the even samples and of the odd ones, then X[k] = even + e^(-2 pi i k / N) odd.
            let (er, ei) = (0.5 * (ar + br), 0.5 * (ai - bi));
            let (or, oi) = (0.5 * (ai + bi), 0.5 * (br - ar));
            let (c, s) = (self.cos[k], self.sin[k]);
            *out = [er + or * c + oi * s, ei + oi * c - or * s];
        }
    }

    /// The N real samples whose bins 0..=N / 2 are `spectrum`, times `scale[n]` (which includes 1 / (N / 2)), into
    /// `y[n][channel]`.
    fn inverse(
        &mut self,
        spectrum: &[[f64; 2]],
        scale: &[f64],
        y: &mut [[f64; 2]],
        channel: usize,
    ) {
        let m = N / 2;
        for k in 0..m {
            let (a, b) = (spectrum[k], spectrum[m - k]);
            let (er, ei) = (0.5 * (a[0] + b[0]), 0.5 * (a[1] - b[1]));
            let (dr, di) = (0.5 * (a[0] - b[0]), 0.5 * (a[1] + b[1]));
            let (c, s) = (self.cos[k], self.sin[k]);
            let (or, oi) = (dr * c - di * s, dr * s + di * c);
            // even + i odd, conjugated for the inverse by a forward transform.
            self.re[k] = er - oi;
            self.im[k] = -(ei + or);
        }
        self.half();
        for i in 0..m {
            y[2 * i][channel] = self.re[i] * scale[2 * i];
            y[2 * i + 1][channel] = -self.im[i] * scale[2 * i + 1];
        }
    }
}

/// Half of a zero-phase Kaiser-windowed low-pass (70 dB) at `rate`, passing below `cutoff - transition / 2`, with unit
/// gain at 0 Hz.
fn lowpass(rate: f64, cutoff: f64, transition: f64) -> Vec<f32> {
    let attenuation = 70.0;
    let beta = 0.1102 * (attenuation - 8.7);
    let half = ((attenuation - 8.0) / (2.285 * 2.0 * PI * transition / rate) / 2.0)
        .ceil()
        .max(2.0) as usize;
    let fc = cutoff / rate;
    let i0 = |x: f64| {
        let (mut sum, mut term, mut k) = (1.0, 1.0, 1.0);
        while term > 1e-12 * sum {
            term *= (x / (2.0 * k)) * (x / (2.0 * k));
            sum += term;
            k += 1.0;
        }
        sum
    };
    let norm = i0(beta);
    let taps: Vec<f64> = (0..=half)
        .map(|k| {
            let x = k as f64;
            let sinc = if k == 0 {
                2.0 * fc
            } else {
                (2.0 * PI * fc * x).sin() / (PI * x)
            };
            let r = x / half as f64;
            sinc * i0(beta * (1.0 - r * r).max(0.0).sqrt()) / norm
        })
        .collect();
    let gain = taps[0] + 2.0 * taps[1..].iter().sum::<f64>();
    taps.iter().map(|t| (t / gain) as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_transform_matches_its_definition_and_inverts() {
        let mut transform = Transform::new();
        let x: Vec<[f64; 2]> = (0..N)
            .map(|n| {
                [
                    ((n * 7 % 13) as f64 - 6.0) / 6.0,
                    ((n * 5 % 11) as f64 - 5.0) / 5.0,
                ]
            })
            .collect();
        let top = N / 2 - 1;
        let mut spectrum = vec![[0.0; 2]; N / 2 + 1];
        for channel in 0..2 {
            transform.forward(&x, channel, top, &mut spectrum);
            for k in [0, 1, 7, 100, top] {
                let (mut sr, mut si) = (0.0, 0.0);
                for (n, x) in x.iter().enumerate() {
                    let a = -2.0 * PI * (k * n) as f64 / N as f64;
                    sr += x[channel] * a.cos();
                    si += x[channel] * a.sin();
                }
                assert!(
                    (sr - spectrum[k][0]).abs() < 1e-9 && (si - spectrum[k][1]).abs() < 1e-9,
                    "channel {channel}, bin {k}"
                );
            }
            // The bin at N / 2, which `forward` leaves out.
            spectrum[N / 2] = [
                x.iter()
                    .enumerate()
                    .map(|(n, x)| if n % 2 == 0 { x[channel] } else { -x[channel] })
                    .sum(),
                0.0,
            ];
            let mut y = vec![[0.0; 2]; N];
            transform.inverse(&spectrum, &vec![2.0 / N as f64; N], &mut y, channel);
            for n in 0..N {
                assert!((y[n][channel] - x[n][channel]).abs() < 1e-12, "sample {n}");
            }
        }
    }

    #[test]
    fn the_low_pass_passes_the_low_band_and_stops_above_it() {
        // At 48 kHz with a 256-frame search: passes to 117 Hz, stops from 375 Hz.
        let taps = lowpass(48_000.0, 2.625 * 93.75, 2.75 * 93.75);
        let response = |hz: f64| {
            let w = 2.0 * PI * hz / 48_000.0;
            taps[0] as f64
                + 2.0
                    * taps[1..]
                        .iter()
                        .enumerate()
                        .map(|(k, t)| *t as f64 * (w * (k + 1) as f64).cos())
                        .sum::<f64>()
        };
        for hz in [0.0, 20.0, 41.2, 55.0, 82.4, 110.0, 117.0] {
            assert!(
                (response(hz) - 1.0).abs() < 2e-3,
                "{hz} Hz: {}",
                response(hz)
            );
        }
        for hz in [375.0, 500.0, 1000.0, 1500.0, 5000.0] {
            assert!(response(hz).abs() < 1e-3, "{hz} Hz: {}", response(hz));
        }
    }
}
