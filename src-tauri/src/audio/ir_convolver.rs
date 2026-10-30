//! Convolution with no latency, for a cabinet impulse response the user loads.
//!
//! The response is split by tap position. The first `HEAD` taps run directly, one product per tap per frame. The rest
//! is cut into partitions in three tiers of growing size, each convolved in the frequency domain once per block, so a
//! long tail costs a few frequency-domain products a frame instead of one product per tap. A tier's partitions begin at
//! least one of its own blocks after the present, so everything they need has already been heard when a block starts.
//! The two larger tiers begin two blocks after the present, which leaves them a block to work in: the output of the
//! block after next is worked out part way through the block now playing, each channel at its own point, and the
//! transform of the block just heard is all that is left for its end. So no tier does all its work on one frame.
//!
//! Everything that allocates or computes a table is done off the audio thread, by `IrKernel::new` and `IrEngine::new`.
//! `IrEngine::process` takes no lock, allocates nothing and reads no file. Every sum runs in a fixed order, so the same
//! input gives the same bits however the callback blocks fall.
use super::tone::dot;
use std::sync::atomic::{AtomicU64, Ordering};

/// Taps that run directly: the speaker's first few milliseconds, which no block may delay.
pub const HEAD: usize = 128;
const TIERS: usize = 3;
/// Each tier's block size and the tap where its partitions begin, a whole number of its blocks from the start. A tier
/// covers taps up to where the next one begins.
const PLAN: [(usize, usize); TIERS] = [(128, 128), (512, 1024), (2048, 4096)];
/// The longest response played, in seconds. Longer ones are cut with a fade when they are loaded.
pub const MAX_SECONDS: f64 = 1.0;
/// Input this small is a decaying tail's residue, not sound: a follower still falling after a note has ended passes
/// through the subnormal numbers, where every product costs many times the usual, and a dozen tracks of them in the
/// frequency-domain tiers miss the callback. Below this the input is zero, so the engine rests as soon as it can.
const FLUSH: f32 = 1e-20;

/// The most taps a response may have at `rate`.
pub fn max_taps(rate: u32) -> usize {
    (rate as f64 * MAX_SECONDS) as usize
}
/// The taps of a response of `len` that fall in tier `tier`.
fn tier_taps(len: usize, tier: usize) -> usize {
    let start = PLAN[tier].1;
    let end = PLAN.get(tier + 1).map_or(usize::MAX, |next| next.1);
    len.min(end).saturating_sub(start)
}
fn tier_parts(len: usize, tier: usize) -> usize {
    tier_taps(len, tier).div_ceil(PLAN[tier].0)
}
/// The frames of silence after which a response of `len` taps has left nothing but zeros in an engine: for each tier,
/// the blocks before its first partition, its partitions, and three more: two to clear the block being filled, and one
/// for the output worked out ahead.
fn drain_frames(len: usize) -> usize {
    (0..TIERS)
        .map(|tier| {
            let (block, start) = PLAN[tier];
            (start / block + tier_parts(len, tier) + 3) * block
        })
        .max()
        .unwrap_or(0)
        + HEAD
}
/// Where in its block a tier of a track begins. It follows from the track's key alone, spread evenly by the golden
/// ratio so that the tracks' transforms, and one track's three tiers, fall on different frames and not all in one
/// callback. It is no function of time, so a render and a playback of the same document agree to the bit, and
/// nothing in it depends on how the callback blocks fall.
fn start_phase(key: u64, tier: usize) -> usize {
    let spread = key
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add((tier as u64).wrapping_mul(0x5555_5555_5555_5555));
    (((spread >> 32) * PLAN[tier].0 as u64) >> 32) as usize
}

/// A radix-2 transform on separate real and imaginary arrays, with its tables made once.
struct ComplexFft {
    size: usize,
    reversed: Vec<u32>,
    /// The twiddles of the stage with half-length `h` begin at `h`.
    cos: Vec<f32>,
    sin: Vec<f32>,
}
impl ComplexFft {
    fn new(size: usize) -> Self {
        assert!(size.is_power_of_two());
        let bits = size.trailing_zeros();
        let reversed = (0..size as u32)
            .map(|i| {
                if bits == 0 {
                    0
                } else {
                    i.reverse_bits() >> (32 - bits)
                }
            })
            .collect();
        let (mut cos, mut sin) = (vec![0.0; size.max(2)], vec![0.0; size.max(2)]);
        let mut half = 1;
        while half < size {
            for k in 0..half {
                let angle = std::f64::consts::PI * k as f64 / half as f64;
                cos[half + k] = angle.cos() as f32;
                sin[half + k] = -angle.sin() as f32;
            }
            half *= 2;
        }
        Self {
            size,
            reversed,
            cos,
            sin,
        }
    }
    /// The forward transform in place, unscaled.
    fn run(&self, re: &mut [f32], im: &mut [f32]) {
        let n = self.size;
        let (re, im) = (&mut re[..n], &mut im[..n]);
        for i in 0..n {
            let j = self.reversed[i] as usize;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut half = 1;
        while half < n {
            let (wr, wi) = (&self.cos[half..2 * half], &self.sin[half..2 * half]);
            for (re, im) in re
                .chunks_exact_mut(2 * half)
                .zip(im.chunks_exact_mut(2 * half))
            {
                let (low_re, high_re) = re.split_at_mut(half);
                let (low_im, high_im) = im.split_at_mut(half);
                for k in 0..half {
                    let tr = high_re[k] * wr[k] - high_im[k] * wi[k];
                    let ti = high_re[k] * wi[k] + high_im[k] * wr[k];
                    high_re[k] = low_re[k] - tr;
                    high_im[k] = low_im[k] - ti;
                    low_re[k] += tr;
                    low_im[k] += ti;
                }
            }
            half *= 2;
        }
    }
}

/// The transform of `2 * half` real values into `half + 1` bins, through a complex transform of half the length.
pub struct RealFft {
    half: usize,
    fft: ComplexFft,
    /// `exp(-2 pi i k / n)` for `k` up to `half`.
    cos: Vec<f32>,
    sin: Vec<f32>,
}
impl RealFft {
    pub fn new(half: usize) -> Self {
        let n = 2.0 * half as f64;
        let angle = |k: usize| std::f64::consts::TAU * k as f64 / n;
        Self {
            half,
            fft: ComplexFft::new(half),
            cos: (0..=half).map(|k| angle(k).cos() as f32).collect(),
            sin: (0..=half).map(|k| -angle(k).sin() as f32).collect(),
        }
    }
    /// The spectrum of `x`, which holds `2 * half` values. `zr` and `zi` are scratch of `half` values each.
    pub fn forward(
        &self,
        x: &[f32],
        out_re: &mut [f32],
        out_im: &mut [f32],
        zr: &mut [f32],
        zi: &mut [f32],
    ) {
        let m = self.half;
        for j in 0..m {
            zr[j] = x[2 * j];
            zi[j] = x[2 * j + 1];
        }
        self.fft.run(zr, zi);
        for k in 0..=m {
            let a = if k == m { 0 } else { k };
            let b = if k == 0 { 0 } else { m - k };
            let (ar, ai, br, bi) = (zr[a], zi[a], zr[b], -zi[b]);
            let (er, ei) = ((ar + br) * 0.5, (ai + bi) * 0.5);
            // The odd samples' spectrum, from the difference over 2i.
            let (or, oi) = ((ai - bi) * 0.5, -(ar - br) * 0.5);
            let (wr, wi) = (self.cos[k], self.sin[k]);
            out_re[k] = er + wr * or - wi * oi;
            out_im[k] = ei + wr * oi + wi * or;
        }
    }
    /// The `2 * half` real values whose spectrum is `in_re` and `in_im`, scaled so that it undoes `forward`.
    pub fn inverse(
        &self,
        in_re: &[f32],
        in_im: &[f32],
        out: &mut [f32],
        zr: &mut [f32],
        zi: &mut [f32],
    ) {
        let m = self.half;
        for k in 0..m {
            let j = m - k;
            let (xr, xi, cr, ci) = (in_re[k], in_im[k], in_re[j], -in_im[j]);
            let (er, ei) = ((xr + cr) * 0.5, (xi + ci) * 0.5);
            let (dr, di) = ((xr - cr) * 0.5, (xi - ci) * 0.5);
            let (wr, wi) = (self.cos[k], self.sin[k]);
            let (or, oi) = (dr * wr + di * wi, di * wr - dr * wi);
            zr[k] = er - oi;
            zi[k] = ei + or;
        }
        // Swapping the arrays turns the forward transform into the unscaled inverse.
        self.fft.run(zi, zr);
        let scale = 1.0 / m as f32;
        for j in 0..m {
            out[2 * j] = zr[j] * scale;
            out[2 * j + 1] = zi[j] * scale;
        }
    }
}

/// The spectra of one tier's partitions, `parts` of `block + 1` bins each, real parts and imaginary parts apart.
struct KernelTier {
    parts: usize,
    re: Vec<f32>,
    im: Vec<f32>,
}

static SERIALS: AtomicU64 = AtomicU64::new(1);

/// An impulse response ready to convolve: the direct head and every partition's spectrum. It is immutable once made,
/// so any number of tracks share one.
pub struct IrKernel {
    serial: u64,
    rate: u32,
    len: usize,
    /// Frames of silence after which an engine that played only this holds nothing but zeros.
    drain: usize,
    head: [f32; HEAD],
    tiers: [KernelTier; TIERS],
}
impl IrKernel {
    /// The kernel for `taps` at `rate`. Call off the audio thread. The response must be finite, no longer than
    /// `max_taps(rate)` and not empty.
    pub fn new(taps: &[f32], rate: u32) -> Result<Self, String> {
        if taps.is_empty() || taps.len() > max_taps(rate) || taps.iter().any(|v| !v.is_finite()) {
            return Err("Invalid impulse response.".into());
        }
        let mut head = [0.0; HEAD];
        let direct = taps.len().min(HEAD);
        head[..direct].copy_from_slice(&taps[..direct]);
        let tiers = std::array::from_fn(|tier| {
            let (block, start) = PLAN[tier];
            let parts = tier_parts(taps.len(), tier);
            let bins = block + 1;
            let fft = RealFft::new(block);
            let (mut re, mut im) = (vec![0.0; parts * bins], vec![0.0; parts * bins]);
            let (mut window, mut zr, mut zi) =
                (vec![0.0; 2 * block], vec![0.0; block], vec![0.0; block]);
            for part in 0..parts {
                window.fill(0.0);
                let begin = start + part * block;
                let end = (begin + block).min(taps.len());
                window[..end - begin].copy_from_slice(&taps[begin..end]);
                fft.forward(
                    &window,
                    &mut re[part * bins..(part + 1) * bins],
                    &mut im[part * bins..(part + 1) * bins],
                    &mut zr,
                    &mut zi,
                );
            }
            KernelTier { parts, re, im }
        });
        Ok(Self {
            serial: SERIALS.fetch_add(1, Ordering::Relaxed),
            rate,
            len: taps.len(),
            drain: drain_frames(taps.len()),
            head,
            tiers,
        })
    }
    pub fn rate(&self) -> u32 {
        self.rate
    }
    /// The number of taps.
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    /// A number no other kernel has, which says which one a slot holds.
    pub fn serial(&self) -> u64 {
        self.serial
    }
}

/// `acc += h * x`, bin by bin, for one partition.
#[inline]
fn accumulate(
    acc_re: &mut [f32],
    acc_im: &mut [f32],
    hr: &[f32],
    hi: &[f32],
    xr: &[f32],
    xi: &[f32],
) {
    let n = acc_re.len();
    let (acc_im, hr, hi, xr, xi) = (&mut acc_im[..n], &hr[..n], &hi[..n], &xr[..n], &xi[..n]);
    for k in 0..n {
        acc_re[k] += hr[k] * xr[k] - hi[k] * xi[k];
        acc_im[k] += hr[k] * xi[k] + hi[k] * xr[k];
    }
}

/// One channel of one tier: the last two blocks of input, the spectra of past blocks, and the output the two kernels'
/// partitions have for the block now playing.
struct TierChannel {
    buffer: Vec<f32>,
    fdl_re: Vec<f32>,
    fdl_im: Vec<f32>,
    out: [Vec<f32>; 2],
    /// Where a tier that works ahead keeps the output of the block after the one now playing.
    next: [Vec<f32>; 2],
}
impl TierChannel {
    fn copy_from(&mut self, other: &Self) {
        self.buffer.copy_from_slice(&other.buffer);
        self.fdl_re.copy_from_slice(&other.fdl_re);
        self.fdl_im.copy_from_slice(&other.fdl_im);
        for slot in 0..2 {
            self.out[slot].copy_from_slice(&other.out[slot]);
            self.next[slot].copy_from_slice(&other.next[slot]);
        }
    }
    fn clear(&mut self) {
        self.buffer.fill(0.0);
        self.fdl_re.fill(0.0);
        self.fdl_im.fill(0.0);
        self.out.iter_mut().for_each(|out| out.fill(0.0));
        self.next.iter_mut().for_each(|out| out.fill(0.0));
    }
}
struct Tier {
    block: usize,
    /// How many blocks after the present this tier's first partition begins.
    offset: usize,
    /// The partitions the longest response has here.
    capacity: usize,
    /// Spectra kept: the offset plus the partitions.
    depth: usize,
    /// Whether it works out a block's output a block ahead, which a tier can do if its first partition begins at least
    /// two blocks on.
    ahead: bool,
    /// The frame of each channel's work on the output of the block after next, when it works ahead.
    work_at: [usize; 2],
    /// Where in its block the tier begins, which is how a track's transforms are kept apart from the others'.
    start: usize,
    /// Frames into the block now playing.
    phase: usize,
    /// Where the newest spectrum sits in the ring.
    newest: usize,
    channels: [TierChannel; 2],
    fft: RealFft,
    zr: Vec<f32>,
    zi: Vec<f32>,
    acc_re: Vec<f32>,
    acc_im: Vec<f32>,
    time: Vec<f32>,
}
impl Tier {
    fn new(index: usize, rate: u32, key: u64) -> Self {
        let (block, start) = PLAN[index];
        let capacity = tier_parts(max_taps(rate), index);
        let offset = start / block;
        let depth = offset + capacity;
        let bins = block + 1;
        let channel = || TierChannel {
            buffer: vec![0.0; 2 * block],
            fdl_re: vec![0.0; depth * bins],
            fdl_im: vec![0.0; depth * bins],
            out: [vec![0.0; block], vec![0.0; block]],
            next: [vec![0.0; block], vec![0.0; block]],
        };
        Self {
            block,
            offset,
            capacity,
            depth,
            ahead: offset >= 2,
            work_at: [block / 3, 2 * block / 3],
            start: start_phase(key, index),
            phase: start_phase(key, index),
            newest: 0,
            channels: [channel(), channel()],
            fft: RealFft::new(block),
            zr: vec![0.0; block],
            zi: vec![0.0; block],
            acc_re: vec![0.0; bins],
            acc_im: vec![0.0; bins],
            time: vec![0.0; 2 * block],
        }
    }
    fn clear(&mut self) {
        self.phase = self.start;
        self.newest = 0;
        self.channels.iter_mut().for_each(TierChannel::clear);
    }
    /// The output block of `kernel`'s partitions into slot `slot` of channel `c`: for the block after the newest
    /// spectrum, or, with `ahead`, for the one after that, which only a tier that works ahead can do.
    fn compute(&mut self, c: usize, slot: usize, kernel: &KernelTier, ahead: bool) {
        let bins = self.block + 1;
        let channel = &mut self.channels[c];
        let into = if ahead {
            &mut channel.next[slot]
        } else {
            &mut channel.out[slot]
        };
        if kernel.parts == 0 {
            into.fill(0.0);
            return;
        }
        // The spectrum a partition reads is as many blocks back as the tier's first partition begins on, less the one
        // the block computed for lies ahead of the newest.
        let back = self.offset - 1 - ahead as usize;
        self.acc_re.fill(0.0);
        self.acc_im.fill(0.0);
        for part in 0..kernel.parts.min(self.capacity) {
            let at = (self.newest + self.depth - back - part) % self.depth;
            accumulate(
                &mut self.acc_re,
                &mut self.acc_im,
                &kernel.re[part * bins..(part + 1) * bins],
                &kernel.im[part * bins..(part + 1) * bins],
                &channel.fdl_re[at * bins..(at + 1) * bins],
                &channel.fdl_im[at * bins..(at + 1) * bins],
            );
        }
        self.fft.inverse(
            &self.acc_re,
            &self.acc_im,
            &mut self.time,
            &mut self.zr,
            &mut self.zi,
        );
        let into = if ahead {
            &mut channel.next[slot]
        } else {
            &mut channel.out[slot]
        };
        into.copy_from_slice(&self.time[self.block..]);
    }
    /// Part way through a block: a tier that works ahead works out the next block's output for the kernels held, for
    /// the channel whose point this is.
    fn work(&mut self, channels: usize, held: [Option<&IrKernel>; 2], tier: usize) {
        for c in 0..channels {
            if self.phase == self.work_at[c] {
                for (slot, kernel) in held.into_iter().enumerate() {
                    if let Some(kernel) = kernel {
                        self.compute(c, slot, &kernel.tiers[tier], true);
                    }
                }
            }
        }
    }
    /// A block of input is complete: take its spectrum, then work out the next block's output for each kernel held.
    fn boundary(&mut self, channels: usize, held: [Option<&IrKernel>; 2], tier: usize) {
        let bins = self.block + 1;
        self.newest = (self.newest + 1) % self.depth;
        for c in 0..channels {
            let TierChannel {
                buffer,
                fdl_re,
                fdl_im,
                ..
            } = &mut self.channels[c];
            let at = self.newest * bins;
            self.fft.forward(
                buffer,
                &mut fdl_re[at..at + bins],
                &mut fdl_im[at..at + bins],
                &mut self.zr,
                &mut self.zi,
            );
            buffer.copy_within(self.block.., 0);
        }
        self.phase = 0;
        if self.ahead {
            // What was worked out a block ago is now the block playing.
            for channel in &mut self.channels[..channels] {
                for slot in 0..2 {
                    std::mem::swap(&mut channel.out[slot], &mut channel.next[slot]);
                }
            }
            return;
        }
        for (slot, kernel) in held.into_iter().enumerate() {
            if let Some(kernel) = kernel {
                for c in 0..channels {
                    self.compute(c, slot, &kernel.tiers[tier], false);
                }
            }
        }
    }
}

/// The running state of one track's convolution: the last input, past blocks' spectra, and the output of up to two
/// kernels at once, which is what a crossfade from one response to another needs. Both read one history, so moving
/// between responses cannot click.
pub struct IrEngine {
    rate: u32,
    /// What keeps this track's transforms apart from other tracks' (see `start_phase`).
    key: u64,
    /// Each channel's latest `HEAD` inputs, twice over so they always lie in one run.
    history: [[f32; 2 * HEAD]; 2],
    at: usize,
    tiers: Vec<Tier>,
    /// The kernel each of the two output slots holds, by serial, or 0 for none.
    slots: [u64; 2],
    /// Whether both channels hold the same state, so that input equal on both needs one run.
    twin: bool,
    /// Whether all it holds is zero, so silence going in comes out as silence without a run.
    resting: bool,
    /// Frames of silence in a row, which a fresh engine has had for ever. Past `drain`, everything the kernels played
    /// hold is zero.
    silent: usize,
    /// The longest drain of the kernels played since it last woke.
    drain: usize,
    /// Whether it may rest and rejoin its channels, which is off only to compare against running every frame.
    rests: bool,
    /// Whether it ran on the previous frame. An engine starting again starts silent.
    pub live: bool,
}
impl IrEngine {
    /// Call off the audio thread: this allocates every buffer the longest response will need.
    pub fn new(rate: u32) -> Self {
        Self::keyed(rate, 0)
    }
    /// An engine for the `key`th convolution of a render or a playback, such as a track's index, whose transforms do
    /// not fall on the same frames as another key's.
    pub fn keyed(rate: u32, key: u64) -> Self {
        let tiers: Vec<Tier> = (0..TIERS)
            .map(|index| Tier::new(index, rate, key))
            .collect();
        Self {
            rate,
            key,
            history: [[0.0; 2 * HEAD]; 2],
            at: 0,
            tiers,
            slots: [0; 2],
            twin: true,
            resting: true,
            silent: usize::MAX,
            drain: 0,
            rests: true,
            live: false,
        }
    }
    pub fn rate(&self) -> u32 {
        self.rate
    }
    pub fn key(&self) -> u64 {
        self.key
    }
    /// Moves where the tiers begin to those of `key`, if nothing has been played since the last reset.
    pub fn rekey(&mut self, key: u64) {
        if self.resting && self.silent == usize::MAX && key != self.key {
            self.key = key;
            for (index, tier) in self.tiers.iter_mut().enumerate() {
                tier.start = start_phase(key, index);
            }
            self.reset();
        }
    }
    pub fn reset(&mut self) {
        self.history = [[0.0; 2 * HEAD]; 2];
        self.at = 0;
        self.tiers.iter_mut().for_each(Tier::clear);
        self.slots = [0; 2];
        self.twin = true;
        self.resting = true;
        self.silent = usize::MAX;
        self.drain = 0;
    }
    /// Runs every frame from now on, as it would with no shortcuts, to compare the two.
    pub fn never_rest(&mut self) {
        self.rests = false;
    }
    /// Whether all it holds is zero, and whether it is running one channel for both.
    pub fn at_rest(&self) -> [bool; 2] {
        [self.resting, self.twin]
    }
    fn untwin(&mut self) {
        self.history[1] = self.history[0];
        for tier in &mut self.tiers {
            let [first, second] = &mut tier.channels;
            second.copy_from(first);
        }
        self.twin = false;
    }
    /// Works out `kernel`'s output for the block now playing, into `slot`, from the history held. When `quiet` frames
    /// of silence, at least as many as the kernel needs to drain, came before, the history holds nothing it would
    /// reach and the output is zero without working it out.
    fn fill(&mut self, slot: usize, kernel: &IrKernel, channels: usize, quiet: usize) {
        self.slots[slot] = kernel.serial;
        let nothing = quiet >= kernel.drain;
        for (index, tier) in self.tiers.iter_mut().enumerate() {
            for c in 0..channels {
                if nothing {
                    tier.channels[c].out[slot].fill(0.0);
                    tier.channels[c].next[slot].fill(0.0);
                } else {
                    tier.compute(c, slot, &kernel.tiers[index], false);
                    if tier.ahead {
                        tier.compute(c, slot, &kernel.tiers[index], true);
                    }
                }
            }
        }
    }
    /// A frame of silence while resting: every buffer holds zeros, so only the positions move on, which keeps the
    /// blocks falling where they would if the frame had run. A block that would have been taken is zero, so it is
    /// written as zeros over what the ring held from a block long past.
    fn idle(&mut self) {
        self.silent = self.silent.saturating_add(1);
        self.at = if self.at == 0 { HEAD - 1 } else { self.at - 1 };
        for tier in &mut self.tiers {
            tier.phase += 1;
            if tier.phase == tier.block {
                tier.phase = 0;
                tier.newest = (tier.newest + 1) % tier.depth;
                let bins = tier.block + 1;
                let at = tier.newest * bins;
                for channel in &mut tier.channels {
                    channel.fdl_re[at..at + bins].fill(0.0);
                    channel.fdl_im[at..at + bins].fill(0.0);
                }
            }
        }
    }
    /// One frame through the kernel `a` and, if given and different, `b`. The results are `a`'s and `b`'s output, which
    /// is `a`'s again when there is no `b`. Both kernels must be for this engine's rate.
    pub fn process(
        &mut self,
        input: [f32; 2],
        a: &IrKernel,
        b: Option<&IrKernel>,
    ) -> [[f32; 2]; 2] {
        let input = input.map(|v| if v.abs() < FLUSH { 0.0 } else { v });
        let silent = self.rests && input[0] == 0.0 && input[1] == 0.0;
        if silent && self.resting {
            self.idle();
            return [[0.0; 2]; 2];
        }
        // Waking from rest, the history is all zero for as long as it has been silent.
        let quiet = if self.resting { self.silent } else { 0 };
        if self.resting {
            self.drain = 0;
        }
        self.resting = false;
        self.silent = if silent {
            self.silent.saturating_add(1)
        } else {
            0
        };
        if self.twin && input[0].to_bits() != input[1].to_bits() {
            self.untwin();
        }
        let channels = if self.twin { 1 } else { 2 };
        let b = b.filter(|k| k.serial != a.serial);
        self.drain = self.drain.max(a.drain).max(b.map_or(0, |b| b.drain));
        // Each kernel keeps the slot it has, or takes one the other does not hold.
        let held =
            |slots: &[u64; 2], kernel: &IrKernel| slots.iter().position(|&s| s == kernel.serial);
        let (mut slot_a, mut slot_b) = (held(&self.slots, a), b.and_then(|b| held(&self.slots, b)));
        if slot_a.is_none() {
            let slot = (0..2).find(|&s| Some(s) != slot_b).unwrap_or(0);
            self.fill(slot, a, channels, quiet);
            slot_a = Some(slot);
        }
        let slot_a = slot_a.unwrap_or(0);
        if let (Some(b), None) = (b, slot_b) {
            let slot = 1 - slot_a;
            self.fill(slot, b, channels, quiet);
            slot_b = Some(slot);
        }
        if b.is_none() {
            self.slots[1 - slot_a] = 0;
        }
        let slot_b = slot_b.unwrap_or(slot_a);
        self.at = if self.at == 0 { HEAD - 1 } else { self.at - 1 };
        for c in 0..channels {
            self.history[c][self.at] = input[c];
            self.history[c][self.at + HEAD] = input[c];
            for tier in &mut self.tiers {
                tier.channels[c].buffer[tier.block + tier.phase] = input[c];
            }
        }
        let mut output = [[0.0f32; 2]; 2];
        for c in 0..channels {
            let recent = &self.history[c][self.at..self.at + HEAD];
            let mut y = [dot(&a.head, recent), 0.0];
            if let Some(b) = b {
                y[1] = dot(&b.head, recent);
            }
            for tier in &self.tiers {
                let out = &tier.channels[c].out;
                y[0] += out[slot_a][tier.phase];
                if b.is_some() {
                    y[1] += out[slot_b][tier.phase];
                }
            }
            output[0][c] = y[0];
            output[1][c] = if b.is_some() { y[1] } else { y[0] };
        }
        if self.twin {
            output[0][1] = output[0][0];
            output[1][1] = output[1][0];
        }
        let mut kernels: [Option<&IrKernel>; 2] = [None, None];
        kernels[slot_a] = Some(a);
        if let Some(b) = b {
            kernels[slot_b] = Some(b);
        }
        for (index, tier) in self.tiers.iter_mut().enumerate() {
            tier.phase += 1;
            if tier.phase == tier.block {
                tier.boundary(channels, kernels, index);
            } else if tier.ahead {
                tier.work(channels, kernels, index);
            }
        }
        if self.rests && self.silent >= self.drain {
            // Everything it held has been replaced by silence.
            self.resting = true;
            self.twin = true;
        }
        output
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A reproducible sequence in -1..1.
    fn noise(len: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as f32 / u32::MAX as f32 * 2.0 - 1.0
            })
            .collect()
    }
    fn direct(taps: &[f32], input: &[f32]) -> Vec<f64> {
        (0..input.len())
            .map(|n| {
                (0..taps.len().min(n + 1))
                    .map(|k| taps[k] as f64 * input[n - k] as f64)
                    .sum()
            })
            .collect()
    }
    fn run(engine: &mut IrEngine, kernel: &IrKernel, input: &[f32]) -> Vec<f32> {
        input
            .iter()
            .map(|&x| engine.process([x; 2], kernel, None)[0][0])
            .collect()
    }
    fn worst(a: &[f32], b: &[f64]) -> f64 {
        a.iter()
            .zip(b)
            .map(|(a, b)| (*a as f64 - b).abs())
            .fold(0.0, f64::max)
    }

    #[test]
    fn the_real_transform_matches_a_direct_sum_and_inverts() {
        let fft = RealFft::new(16);
        let x = noise(32, 7);
        let (mut re, mut im, mut zr, mut zi) =
            (vec![0.0; 17], vec![0.0; 17], vec![0.0; 16], vec![0.0; 16]);
        fft.forward(&x, &mut re, &mut im, &mut zr, &mut zi);
        for k in 0..=16 {
            let (mut sr, mut si) = (0.0f64, 0.0f64);
            for (n, v) in x.iter().enumerate() {
                let angle = std::f64::consts::TAU * (k * n) as f64 / 32.0;
                sr += *v as f64 * angle.cos();
                si -= *v as f64 * angle.sin();
            }
            assert!((re[k] as f64 - sr).abs() < 1e-4, "bin {k} real");
            assert!((im[k] as f64 - si).abs() < 1e-4, "bin {k} imaginary");
        }
        let mut back = vec![0.0; 32];
        fft.inverse(&re, &im, &mut back, &mut zr, &mut zi);
        for (a, b) in x.iter().zip(&back) {
            assert!((a - b).abs() < 1e-5);
        }
    }
    #[test]
    fn it_convolves_like_a_direct_sum_at_every_length() {
        // Lengths on both sides of each tier's start and end, and the longest.
        for len in [
            1, 100, 128, 129, 600, 1024, 1025, 4000, 4096, 4097, 9000, 48_000,
        ] {
            let taps: Vec<f32> = noise(len, len as u32 + 3).iter().map(|v| v * 0.1).collect();
            let kernel = IrKernel::new(&taps, 48_000).unwrap();
            let input = noise(9000.max(len + 3000).min(12_000), 11);
            let got = run(&mut IrEngine::new(48_000), &kernel, &input);
            let want = direct(&taps, &input);
            assert!(
                worst(&got, &want) < 2e-4,
                "{len} taps: error {}",
                worst(&got, &want)
            );
        }
    }
    #[test]
    fn an_impulse_comes_back_as_the_response_with_no_delay() {
        let taps = noise(5000, 5);
        let kernel = IrKernel::new(&taps, 48_000).unwrap();
        let mut input = vec![0.0f32; 6000];
        input[0] = 1.0;
        let got = run(&mut IrEngine::new(48_000), &kernel, &input);
        for (n, v) in got.iter().enumerate() {
            let want = taps.get(n).copied().unwrap_or(0.0);
            assert!((v - want).abs() < 1e-4, "frame {n}: {v} against {want}");
        }
    }
    #[test]
    fn the_two_channels_run_apart_and_together() {
        let taps: Vec<f32> = noise(3000, 9).iter().map(|v| v * 0.1).collect();
        let kernel = IrKernel::new(&taps, 48_000).unwrap();
        let (left, right) = (noise(8000, 1), noise(8000, 2));
        let mut engine = IrEngine::new(48_000);
        let (mut got_left, mut got_right) = (vec![], vec![]);
        for n in 0..8000 {
            // Equal for the first 3000 frames, which run as one channel, then different.
            let r = if n < 3000 { left[n] } else { right[n] };
            let y = engine.process([left[n], r], &kernel, None)[0];
            got_left.push(y[0]);
            got_right.push(y[1]);
        }
        let mixed: Vec<f32> = (0..8000)
            .map(|n| if n < 3000 { left[n] } else { right[n] })
            .collect();
        assert!(worst(&got_left, &direct(&taps, &left)) < 2e-4);
        assert!(worst(&got_right, &direct(&taps, &mixed)) < 2e-4);
    }
    #[test]
    fn a_second_kernel_is_worked_out_from_the_same_history() {
        let a: Vec<f32> = noise(6000, 21).iter().map(|v| v * 0.1).collect();
        let b: Vec<f32> = noise(2500, 22).iter().map(|v| v * 0.1).collect();
        let (ka, kb) = (
            IrKernel::new(&a, 48_000).unwrap(),
            IrKernel::new(&b, 48_000).unwrap(),
        );
        let input = noise(12_000, 4);
        let mut engine = IrEngine::new(48_000);
        let (mut first, mut second) = (vec![], vec![]);
        for (n, &x) in input.iter().enumerate() {
            // The second kernel joins part way through a block, and the first leaves later.
            let out = if (5_001..7_777).contains(&n) {
                engine.process([x; 2], &ka, Some(&kb))
            } else if n >= 7_777 {
                let y = engine.process([x; 2], &kb, None);
                [y[0], y[0]]
            } else {
                let y = engine.process([x; 2], &ka, None);
                [y[0], y[0]]
            };
            first.push(out[0][0]);
            second.push(out[1][0]);
        }
        let (want_a, want_b) = (direct(&a, &input), direct(&b, &input));
        for n in 0..12_000 {
            if n < 7_777 {
                assert!((first[n] as f64 - want_a[n]).abs() < 2e-4, "a at {n}");
            }
            if (5_001..7_777).contains(&n) {
                assert!((second[n] as f64 - want_b[n]).abs() < 2e-4, "b at {n}");
            }
            if n >= 7_777 {
                assert!((first[n] as f64 - want_b[n]).abs() < 2e-4, "b after at {n}");
            }
        }
    }
    #[test]
    fn silence_rests_and_a_resting_engine_matches_one_that_runs() {
        let taps: Vec<f32> = noise(8000, 31).iter().map(|v| v * 0.05).collect();
        let kernel = IrKernel::new(&taps, 48_000).unwrap();
        let burst = noise(2000, 3);
        let (mut resting, mut running) = (IrEngine::new(48_000), IrEngine::new(48_000));
        running.never_rest();
        for n in 0..(2000 + 48_000 + 12_000) {
            let x = burst.get(n).copied().unwrap_or(0.0);
            let a = resting.process([x; 2], &kernel, None);
            let b = running.process([x; 2], &kernel, None);
            assert_eq!(a[0][0], b[0][0], "frame {n}");
        }
        assert!(resting.at_rest() == [true, true]);
        assert!(!running.at_rest()[0]);
    }

    #[test]
    fn a_tail_that_decays_into_subnormal_numbers_is_silence_to_the_engine() {
        // What a clean note leaves behind: a follower that falls by a fixed share each frame, through 1e-20 and the
        // subnormal numbers, to zero about four seconds on. It must not keep the engine awake, or run as numbers.
        let taps: Vec<f32> = noise(48_000, 41).iter().map(|v| v * 0.05).collect();
        let kernel = IrKernel::new(&taps, 48_000).unwrap();
        let burst = noise(2000, 3);
        let mut engine = IrEngine::new(48_000);
        let mut follower = 0.05f32;
        let (mut subnormal, mut tail_time) = (0usize, std::time::Duration::ZERO);
        let mut silent_at = None;
        for n in 0..6 * 48_000 {
            let x = if n < 2000 {
                burst[n]
            } else {
                follower *= 0.9995;
                follower
            };
            let late = x != 0.0 && x.abs() < f32::MIN_POSITIVE;
            subnormal += late as usize;
            let started = std::time::Instant::now();
            let y = engine.process([x; 2], &kernel, None);
            if late {
                tail_time += started.elapsed();
            }
            assert!(y[0][0].is_finite());
            if silent_at.is_none() && engine.at_rest()[0] {
                silent_at = Some(n);
            }
        }
        assert!(subnormal > 10_000, "{subnormal} subnormal frames");
        // It rested long before the first subnormal number, about 3.6 s in, not after the last one.
        assert!(silent_at.unwrap() < 3 * 48_000 + 24_000, "{silent_at:?}");
        // The frames that were subnormal cost no more than the same number of frames of ordinary input.
        let mut ordinary = IrEngine::new(48_000);
        let hiss = noise(subnormal, 5);
        let started = std::time::Instant::now();
        for v in &hiss {
            std::hint::black_box(ordinary.process([v * 1e-3; 2], &kernel, None));
        }
        assert!(
            tail_time < started.elapsed(),
            "tail {tail_time:?} against {:?}",
            started.elapsed()
        );
    }
    #[test]
    fn tracks_keep_their_transforms_on_different_callbacks() {
        for key in 0..64 {
            for tier in 0..TIERS {
                assert!(start_phase(key, tier) < PLAN[tier].0);
            }
        }
        // The frame a tier's first block ends on, for six tracks and callbacks of 64 frames: the largest tier's land
        // in six callbacks, and the middle tier's are spread over at least four.
        for (tier, most) in [(1, 4), (2, 6)] {
            let mut calls: Vec<usize> = (0..6u64)
                .map(|key| (PLAN[tier].0 - 1 - start_phase(key, tier)) / 64)
                .collect();
            calls.sort_unstable();
            calls.dedup();
            assert!(calls.len() >= most, "tier {tier}: {calls:?}");
        }
    }
    #[test]
    fn every_key_convolves_like_a_direct_sum_and_the_same_key_gives_the_same_bits() {
        let taps: Vec<f32> = noise(30_000, 61).iter().map(|v| v * 0.1).collect();
        let kernel = IrKernel::new(&taps, 48_000).unwrap();
        let input = noise(40_000, 12);
        let want = direct(&taps, &input);
        let mut first = vec![];
        for key in [0u64, 1, 2, 5, 11, 63] {
            let got = run(&mut IrEngine::keyed(48_000, key), &kernel, &input);
            assert!(
                worst(&got, &want) < 3e-4,
                "key {key}: {}",
                worst(&got, &want)
            );
            let again = run(&mut IrEngine::keyed(48_000, key), &kernel, &input);
            assert_eq!(got, again, "key {key}");
            first.push(got);
        }
        // The engines differ in when their blocks fall, so the sums differ in the last places: they are not copies.
        assert!(first.windows(2).any(|pair| pair[0] != pair[1]));
        // Moving a fresh engine to a key gives the engine made with it, and a reset keeps the key.
        let mut moved = IrEngine::new(48_000);
        moved.rekey(5);
        assert_eq!(run(&mut moved, &kernel, &input), first[3]);
        moved.reset();
        assert_eq!(run(&mut moved, &kernel, &input), first[3]);
        // An engine already playing does not move.
        moved.rekey(7);
        assert_eq!(moved.key(), 5);
    }
    #[test]
    fn a_short_response_drains_sooner_and_a_longer_one_after_a_rest_is_right() {
        let short: Vec<f32> = noise(300, 71).iter().map(|v| v * 0.1).collect();
        let long: Vec<f32> = noise(20_000, 72).iter().map(|v| v * 0.05).collect();
        let (ks, kl) = (
            IrKernel::new(&short, 48_000).unwrap(),
            IrKernel::new(&long, 48_000).unwrap(),
        );
        assert!(ks.drain < kl.drain);
        let full = IrKernel::new(&noise(max_taps(48_000), 73), 48_000).unwrap();
        assert!(kl.drain < full.drain);
        // The same bits as an engine that never rests, through a burst, a rest and another burst, whatever the length.
        for (taps, kernel) in [(&short, &ks), (&long, &kl)] {
            let (mut resting, mut running) = (IrEngine::new(48_000), IrEngine::new(48_000));
            running.never_rest();
            let (first, second) = (noise(2000, 3), noise(3000, 4));
            let mut rested_at = None;
            for n in 0..(2000 + 60_000 + 3000 + 40_000) {
                let x = match n {
                    0..2000 => first[n],
                    62_000..65_000 => second[n - 62_000],
                    _ => 0.0,
                };
                let a = resting.process([x, x * 0.5], kernel, None);
                let b = running.process([x, x * 0.5], kernel, None);
                assert_eq!(a[0], b[0], "{} taps, frame {n}", taps.len());
                if n < 62_000 && rested_at.is_none() && resting.at_rest()[0] {
                    rested_at = Some(n);
                }
            }
            // It rested as soon as this response's tail had gone, not when the longest possible one would have.
            let rested_at = rested_at.expect("it rested");
            assert!(rested_at <= 2000 + kernel.drain + 1, "{rested_at}");
            assert!(resting.at_rest() == [true, true]);
        }
        // A longer response taking over a rested engine plays right: nothing of the earlier input is left to it.
        let mut engine = IrEngine::new(48_000);
        let (first, second) = (noise(1500, 8), noise(4000, 9));
        let mut input = first.clone();
        input.extend(vec![0.0; 40_000]);
        input.extend(&second);
        let got: Vec<f32> = input
            .iter()
            .enumerate()
            .map(|(n, &x)| {
                let kernel = if n < 20_000 { &ks } else { &kl };
                engine.process([x; 2], kernel, None)[0][0]
            })
            .collect();
        // While it rested the first response had long since drained and the second was not yet needed: silence.
        let mut want = direct(&short, &input[..20_000]);
        want.extend(vec![0.0; 41_500 - 20_000]);
        want.extend(&direct(&long, &input)[41_500..]);
        assert!(worst(&got, &want) < 2e-4, "{}", worst(&got, &want));
    }
    #[test]
    fn joining_a_kernel_and_splitting_the_channels_at_any_frame_is_right() {
        // The larger tiers work out a block's output ahead, part way through the block before: a kernel that joins, or
        // channels that part, before or after that point must give the sum a direct convolution gives.
        let a: Vec<f32> = noise(9000, 81).iter().map(|v| v * 0.1).collect();
        let b: Vec<f32> = noise(6000, 82).iter().map(|v| v * 0.1).collect();
        let (ka, kb) = (
            IrKernel::new(&a, 48_000).unwrap(),
            IrKernel::new(&b, 48_000).unwrap(),
        );
        let (left, right) = (noise(14_000, 6), noise(14_000, 7));
        for (key, join, split) in [
            (0u64, 4_100usize, 5_300usize),
            (1, 4_300, 4_050),
            (2, 4_650, 4_990),
            (3, 5_000, 4_500),
            (4, 5_200, 6_100),
            (5, 6_150, 5_050),
            (6, 6_700, 4_700),
        ] {
            let mut engine = IrEngine::keyed(48_000, key);
            let (mut got_a, mut got_b, mut got_right) = (vec![], vec![], vec![]);
            for n in 0..14_000 {
                let r = if n < split { left[n] } else { right[n] };
                let out = if n >= join {
                    engine.process([left[n], r], &ka, Some(&kb))
                } else {
                    let y = engine.process([left[n], r], &ka, None);
                    [y[0], y[0]]
                };
                got_a.push(out[0][0]);
                got_b.push(out[1][0]);
                got_right.push(out[0][1]);
            }
            let mixed: Vec<f32> = (0..14_000)
                .map(|n| if n < split { left[n] } else { right[n] })
                .collect();
            let (want_a, want_b) = (direct(&a, &left), direct(&b, &left));
            let want_right = direct(&a, &mixed);
            let tag = format!("key {key}, join {join}, split {split}");
            assert!(worst(&got_a, &want_a) < 3e-4, "{tag}: a left");
            assert!(worst(&got_right, &want_right) < 3e-4, "{tag}: a right");
            let after: Vec<f32> = got_b[join..].to_vec();
            let want_after: Vec<f64> = want_b[join..].to_vec();
            assert!(worst(&after, &want_after) < 3e-4, "{tag}: b left");
        }
    }
}
