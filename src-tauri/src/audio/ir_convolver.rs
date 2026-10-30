//! Convolution with no latency, for a cabinet impulse response the user loads.
//!
//! The response is split by tap position. The first `HEAD` taps run directly, one product per tap per frame. The rest
//! is cut into partitions in three tiers of growing size, each convolved in the frequency domain once per block, so a
//! long tail costs a few frequency-domain products a frame instead of one product per tap. A tier's partitions begin at
//! least one of its own blocks after the present, so everything they need has already been heard when a block starts.
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
}
impl TierChannel {
    fn copy_from(&mut self, other: &Self) {
        self.buffer.copy_from_slice(&other.buffer);
        self.fdl_re.copy_from_slice(&other.fdl_re);
        self.fdl_im.copy_from_slice(&other.fdl_im);
        for slot in 0..2 {
            self.out[slot].copy_from_slice(&other.out[slot]);
        }
    }
    fn clear(&mut self) {
        self.buffer.fill(0.0);
        self.fdl_re.fill(0.0);
        self.fdl_im.fill(0.0);
        self.out.iter_mut().for_each(|out| out.fill(0.0));
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
    fn new(index: usize, rate: u32) -> Self {
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
        };
        Self {
            block,
            offset,
            capacity,
            depth,
            phase: 0,
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
        self.phase = 0;
        self.newest = 0;
        self.channels.iter_mut().for_each(TierChannel::clear);
    }
    /// The output block of `kernel`'s partitions for the block after the newest spectrum, into slot `slot` of
    /// channel `c`.
    fn compute(&mut self, c: usize, slot: usize, kernel: &KernelTier) {
        let bins = self.block + 1;
        let channel = &mut self.channels[c];
        if kernel.parts == 0 {
            channel.out[slot].fill(0.0);
            return;
        }
        self.acc_re.fill(0.0);
        self.acc_im.fill(0.0);
        for part in 0..kernel.parts.min(self.capacity) {
            let at = (self.newest + self.depth - (self.offset - 1) - part) % self.depth;
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
        channel.out[slot].copy_from_slice(&self.time[self.block..]);
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
        for (slot, kernel) in held.into_iter().enumerate() {
            if let Some(kernel) = kernel {
                for c in 0..channels {
                    self.compute(c, slot, &kernel.tiers[tier]);
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
    /// Frames of silence in a row. Past `drain`, everything it holds is zero.
    silent: usize,
    drain: usize,
    /// Whether it may rest and rejoin its channels, which is off only to compare against running every frame.
    rests: bool,
    /// Whether it ran on the previous frame. An engine starting again starts silent.
    pub live: bool,
}
impl IrEngine {
    /// Call off the audio thread: this allocates every buffer the longest response will need.
    pub fn new(rate: u32) -> Self {
        let tiers: Vec<Tier> = (0..TIERS).map(|index| Tier::new(index, rate)).collect();
        let drain = tiers
            .iter()
            .map(|tier| (tier.depth + 2) * tier.block)
            .max()
            .unwrap_or(0)
            + HEAD;
        Self {
            rate,
            history: [[0.0; 2 * HEAD]; 2],
            at: 0,
            tiers,
            slots: [0; 2],
            twin: true,
            resting: true,
            silent: 0,
            drain,
            rests: true,
            live: false,
        }
    }
    pub fn rate(&self) -> u32 {
        self.rate
    }
    pub fn reset(&mut self) {
        self.history = [[0.0; 2 * HEAD]; 2];
        self.at = 0;
        self.tiers.iter_mut().for_each(Tier::clear);
        self.slots = [0; 2];
        self.twin = true;
        self.resting = true;
        self.silent = 0;
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
    /// Works out `kernel`'s output for the block now playing, into `slot`, from the history held.
    fn fill(&mut self, slot: usize, kernel: &IrKernel, channels: usize) {
        self.slots[slot] = kernel.serial;
        for (index, tier) in self.tiers.iter_mut().enumerate() {
            for c in 0..channels {
                tier.compute(c, slot, &kernel.tiers[index]);
            }
        }
    }
    /// A frame of silence while resting: every buffer holds zeros, so only the positions move on, which keeps the
    /// blocks falling where they would if the frame had run.
    fn idle(&mut self) {
        self.at = if self.at == 0 { HEAD - 1 } else { self.at - 1 };
        for tier in &mut self.tiers {
            tier.phase += 1;
            if tier.phase == tier.block {
                tier.phase = 0;
                tier.newest = (tier.newest + 1) % tier.depth;
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
        let silent = self.rests && input[0] == 0.0 && input[1] == 0.0;
        if silent && self.resting {
            self.idle();
            return [[0.0; 2]; 2];
        }
        self.resting = false;
        self.silent = if silent { self.silent + 1 } else { 0 };
        if self.twin && input[0].to_bits() != input[1].to_bits() {
            self.untwin();
        }
        let channels = if self.twin { 1 } else { 2 };
        let b = b.filter(|k| k.serial != a.serial);
        // Each kernel keeps the slot it has, or takes one the other does not hold.
        let held =
            |slots: &[u64; 2], kernel: &IrKernel| slots.iter().position(|&s| s == kernel.serial);
        let (mut slot_a, mut slot_b) = (held(&self.slots, a), b.and_then(|b| held(&self.slots, b)));
        if slot_a.is_none() {
            let slot = (0..2).find(|&s| Some(s) != slot_b).unwrap_or(0);
            self.fill(slot, a, channels);
            slot_a = Some(slot);
        }
        let slot_a = slot_a.unwrap_or(0);
        if let (Some(b), None) = (b, slot_b) {
            let slot = 1 - slot_a;
            self.fill(slot, b, channels);
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
}
