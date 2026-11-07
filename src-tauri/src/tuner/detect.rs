//! Pitch detection for the tuner. Pure functions over mono `f32` samples: no device, thread or
//! lock is involved, so everything here is exercised with synthesized signals.
//!
//! Chromatic mode uses YIN (de Cheveigne and Kawahara, 2002) on a short window. Polyphonic mode
//! reads a Hann-windowed, zero-padded FFT of a longer window around each target string.
use serde::Serialize;

/// What `level` reports when there is no signal.
pub const SILENT_DBFS: f32 = -120.0;
/// Below this RMS level the chromatic detector reports nothing.
pub const GATE_DBFS: f32 = -50.0;
pub const MIN_PITCH_HZ: f64 = 30.0;
pub const MAX_PITCH_HZ: f64 = 1500.0;
/// The tuner accepts string targets in this range.
pub const MIN_TARGET_HZ: f64 = 20.0;
pub const MAX_TARGET_HZ: f64 = 5000.0;
pub const MAX_TARGETS: usize = 12;

/// The first dip of the normalized difference below this is taken as the period.
const YIN_THRESHOLD: f64 = 0.15;
/// With no dip below the threshold, the deepest one still counts when it is below this.
const YIN_FALLBACK: f64 = 0.30;

/// A polyphonic peak must reach this multiple of the median magnitude around it.
const PEAK_TO_FLOOR: f64 = 6.0;
/// A polyphonic peak must be within this fraction of the strongest peak anywhere, which stops
/// the side lobes of a loud neighbour from reading as a quiet string (about -46 dB).
const PEAK_TO_LOUDEST: f64 = 0.005;
/// Smallest sinusoid amplitude the polyphonic mode reports (about -66 dBFS).
const MIN_PARTIAL_AMPLITUDE: f64 = 0.0005;
/// Each target is searched this far either side.
const SEARCH_CENTS: f64 = 50.0;
/// Highest harmonic of a lower string that can pass for a higher one.
const MAX_HARMONIC: usize = 8;
/// Highest partial of a lower note looked at when judging how its partials fall off.
const MAX_PARTIAL: usize = 12;
/// How closely a peak must sit on a harmonic of a lower note to be taken for it.
const HARMONIC_CENTS: f64 = 6.0;
/// A peak is a string of its own when it exceeds the expected harmonic contributions by this
/// factor.
const CLEARLY_STRONGER: f64 = 1.1;
/// Slowest fall-off per harmonic step assumed for a lower note's partials.
const MIN_DECAY: f64 = 0.7;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunerPitch {
    pub frequency: f64,
    /// 0 to 1; how clearly periodic the sound is.
    pub clarity: f32,
}

/// RMS level in dBFS, `SILENT_DBFS` for silence or non-finite input.
pub fn rms_dbfs(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return SILENT_DBFS;
    }
    let sum: f64 = samples.iter().map(|&x| f64::from(x) * f64::from(x)).sum();
    let rms = (sum / samples.len() as f64).sqrt();
    if !(rms > 0.0) || !rms.is_finite() {
        return SILENT_DBFS;
    }
    ((20.0 * rms.log10()) as f32).max(SILENT_DBFS)
}

/// Samples the chromatic detector reads: enough for two or more periods at 30 Hz.
pub fn yin_frame_len(rate: f64) -> usize {
    let tau_max = (rate / MIN_PITCH_HZ).ceil() as usize;
    (tau_max * 5 / 2).next_multiple_of(256).max(2048)
}

/// YIN over the last `yin_frame_len(rate)` samples. `None` below the gate, when the sound is not
/// clearly periodic, or when the period is outside 30 to 1500 Hz.
pub fn detect_pitch(samples: &[f32], rate: f64) -> Option<TunerPitch> {
    if !(8000.0..=192_000.0).contains(&rate) {
        return None;
    }
    let frame_len = yin_frame_len(rate);
    if samples.len() < frame_len {
        return None;
    }
    let frame = &samples[samples.len() - frame_len..];
    if rms_dbfs(frame) < GATE_DBFS {
        return None;
    }
    let tau_min = ((rate / MAX_PITCH_HZ).floor() as usize).max(2);
    let tau_max = (rate / MIN_PITCH_HZ).ceil() as usize;
    // One lag past `tau_max` so the minimum at `tau_max` can still be interpolated.
    let span = frame_len - (tau_max + 1);
    let mut difference = vec![0.0f64; tau_max + 2];
    for (tau, slot) in difference.iter_mut().enumerate().skip(1) {
        let mut sum = 0.0f64;
        for (a, b) in frame[..span].iter().zip(&frame[tau..tau + span]) {
            let d = f64::from(*a) - f64::from(*b);
            sum += d * d;
        }
        *slot = sum;
    }
    // Cumulative mean normalized difference.
    let mut normalized = vec![1.0f64; tau_max + 2];
    let mut running = 0.0f64;
    for tau in 1..tau_max + 2 {
        running += difference[tau];
        normalized[tau] = if running > 0.0 {
            difference[tau] * tau as f64 / running
        } else {
            1.0
        };
    }
    let mut chosen = None;
    let mut tau = tau_min;
    while tau <= tau_max {
        if normalized[tau] < YIN_THRESHOLD {
            while tau < tau_max && normalized[tau + 1] < normalized[tau] {
                tau += 1;
            }
            chosen = Some(tau);
            break;
        }
        tau += 1;
    }
    let tau = match chosen {
        Some(tau) => tau,
        None => {
            // No clean dip. The deepest one can be a multiple of the period, so take the first
            // local minimum that is nearly as deep.
            let deepest =
                (tau_min..=tau_max).min_by(|&a, &b| normalized[a].total_cmp(&normalized[b]))?;
            let best = normalized[deepest];
            if !(best <= YIN_FALLBACK) {
                return None;
            }
            (tau_min..=tau_max)
                .find(|&t| {
                    normalized[t] <= best * 1.1
                        && normalized[t] < normalized[t - 1]
                        && normalized[t] <= normalized[t + 1]
                })
                .unwrap_or(deepest)
        }
    };
    // The raw difference is close to symmetric about its minimum, so it interpolates better
    // than the normalized one.
    let (a, b, c) = (difference[tau - 1], difference[tau], difference[tau + 1]);
    let curvature = a - 2.0 * b + c;
    let offset = if curvature > 0.0 {
        (0.5 * (a - c) / curvature).clamp(-1.0, 1.0)
    } else {
        0.0
    };
    let frequency = rate / (tau as f64 + offset);
    if !(MIN_PITCH_HZ..=MAX_PITCH_HZ).contains(&frequency) {
        return None;
    }
    Some(TunerPitch {
        frequency,
        clarity: (1.0 - normalized[tau]).clamp(0.0, 1.0) as f32,
    })
}

/// Whether `strings` is a usable target list: at most 12 finite values from 20 to 5000 Hz.
pub fn validate_targets(strings: &[f64]) -> Result<(), String> {
    if strings.len() > MAX_TARGETS {
        return Err(format!(
            "At most {MAX_TARGETS} strings can be tuned at once."
        ));
    }
    if strings
        .iter()
        .any(|f| !f.is_finite() || !(MIN_TARGET_HZ..=MAX_TARGET_HZ).contains(f))
    {
        return Err("String frequencies must be from 20 to 5000 Hz.".into());
    }
    Ok(())
}

/// In-place iterative radix-2 FFT with a precomputed twiddle table.
struct Fft {
    size: usize,
    cos: Vec<f64>,
    sin: Vec<f64>,
}

impl Fft {
    fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 2);
        let half = size / 2;
        let step = std::f64::consts::TAU / size as f64;
        Self {
            size,
            cos: (0..half).map(|k| (step * k as f64).cos()).collect(),
            sin: (0..half).map(|k| (step * k as f64).sin()).collect(),
        }
    }

    fn forward(&self, re: &mut [f64], im: &mut [f64]) {
        let n = self.size;
        debug_assert!(re.len() == n && im.len() == n);
        let mut j = 0usize;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let stride = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * stride], -self.sin[k * stride]);
                    let (p, q) = (start + k, start + k + half);
                    let tr = re[q] * wr - im[q] * wi;
                    let ti = re[q] * wi + im[q] * wr;
                    re[q] = re[p] - tr;
                    im[q] = im[p] - ti;
                    re[p] += tr;
                    im[p] += ti;
                }
            }
            len <<= 1;
        }
    }
}

/// A spectral peak: refined frequency and linear magnitude.
#[derive(Clone, Copy, Debug)]
struct Peak {
    frequency: f64,
    magnitude: f64,
}

fn cents_between(a: f64, b: f64) -> f64 {
    1200.0 * (a / b).log2()
}

/// Measures the strongest partial near each target string from a long, zero-padded spectrum.
pub struct PolyAnalyzer {
    rate: f64,
    window_len: usize,
    window: Vec<f64>,
    window_sum: f64,
    fft: Fft,
    re: Vec<f64>,
    im: Vec<f64>,
    magnitude: Vec<f64>,
    scratch: Vec<f64>,
    loudest: f64,
}

impl PolyAnalyzer {
    pub fn new(rate: f64) -> Self {
        // About 0.3 s, a power of two: 16384 samples at 44.1 and 48 kHz.
        let window_len = ((rate * 0.3).ceil() as usize).next_power_of_two().max(4096);
        let fft_len = window_len * 2;
        let window: Vec<f64> = (0..window_len)
            .map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / window_len as f64).cos())
            .collect();
        Self {
            rate,
            window_len,
            window_sum: window.iter().sum(),
            window,
            fft: Fft::new(fft_len),
            re: vec![0.0; fft_len],
            im: vec![0.0; fft_len],
            magnitude: vec![0.0; fft_len / 2 + 1],
            scratch: Vec::new(),
            loudest: 0.0,
        }
    }

    pub fn window_len(&self) -> usize {
        self.window_len
    }

    /// Measured Hz for each target, `None` where no clear partial of its own lies within 50
    /// cents of it. The result has one entry per target; a target outside 20 to 5000 Hz (or
    /// not finite) is `None`. Targets are taken from the lowest up, and a peak that is a
    /// harmonic of a lower string or of a strong lower note in the spectrum is not reported.
    pub fn analyze(&mut self, samples: &[f32], targets: &[f64]) -> Vec<Option<f64>> {
        let mut found = vec![None; targets.len()];
        if samples.len() < self.window_len {
            return found;
        }
        let valid: Vec<f64> = targets
            .iter()
            .copied()
            .filter(|t| (MIN_TARGET_HZ..=MAX_TARGET_HZ).contains(t))
            .collect();
        if valid.is_empty() {
            return found;
        }
        let tail = &samples[samples.len() - self.window_len..];
        let mean = tail.iter().map(|&x| f64::from(x)).sum::<f64>() / self.window_len as f64;
        for (i, slot) in self.re.iter_mut().enumerate() {
            *slot = if i < self.window_len {
                (f64::from(tail[i]) - mean) * self.window[i]
            } else {
                0.0
            };
        }
        self.im.iter_mut().for_each(|x| *x = 0.0);
        self.fft.forward(&mut self.re, &mut self.im);
        for (k, m) in self.magnitude.iter_mut().enumerate() {
            *m = self.re[k].hypot(self.im[k]);
        }
        self.loudest = self.magnitude.iter().copied().fold(0.0f64, f64::max);
        if !(self.loudest > self.min_magnitude()) {
            return found;
        }
        let mut order: Vec<usize> = (0..targets.len())
            .filter(|&i| (MIN_TARGET_HZ..=MAX_TARGET_HZ).contains(&targets[i]))
            .collect();
        order.sort_by(|&a, &b| targets[a].total_cmp(&targets[b]));
        let mut measured: Vec<Peak> = Vec::new();
        for index in order {
            let Some(peak) = self.find_peak(targets[index], SEARCH_CENTS) else {
                continue;
            };
            if self.is_harmonic(peak, &measured, &valid) {
                continue;
            }
            found[index] = Some(peak.frequency);
            measured.push(peak);
        }
        found
    }

    fn min_magnitude(&self) -> f64 {
        // A sinusoid of amplitude A peaks at A * window_sum / 2.
        MIN_PARTIAL_AMPLITUDE * self.window_sum / 2.0
    }

    /// The clear peak nearest `center` (strongest within `cents`), or `None`.
    fn find_peak(&mut self, center: f64, cents: f64) -> Option<Peak> {
        let bin_hz = self.rate / self.fft.size as f64;
        let last = self.magnitude.len() - 2;
        if !(center > 0.0) || center / bin_hz > last as f64 {
            return None;
        }
        let ratio = (cents / 1200.0).exp2();
        // Two bins of slack, so a peak just inside the range is not mistaken for a slope; the
        // interpolated frequency is checked against the range at the end.
        let lo = ((center / ratio / bin_hz).ceil() as usize)
            .saturating_sub(2)
            .max(1);
        let hi = (((center * ratio / bin_hz).floor() as usize) + 2).min(last);
        if lo > hi {
            return None;
        }
        let k = (lo..=hi).max_by(|&a, &b| self.magnitude[a].total_cmp(&self.magnitude[b]))?;
        let (a, b, c) = (
            self.magnitude[k - 1],
            self.magnitude[k],
            self.magnitude[k + 1],
        );
        // A true peak, not the slope of a stronger one just outside the search range.
        if !(b > a && b >= c) {
            return None;
        }
        if b < self.loudest * PEAK_TO_LOUDEST || b < self.min_magnitude() {
            return None;
        }
        // Median magnitude from 2/3 to 3/2 of the centre is the local floor.
        let band_lo = ((center / 1.5 / bin_hz).floor() as usize).max(1);
        let band_hi = ((center * 1.5 / bin_hz).ceil() as usize).min(last);
        self.scratch.clear();
        self.scratch
            .extend_from_slice(&self.magnitude[band_lo..=band_hi]);
        let middle = self.scratch.len() / 2;
        let (_, median, _) = self.scratch.select_nth_unstable_by(middle, f64::total_cmp);
        if !(b > PEAK_TO_FLOOR * *median) {
            return None;
        }
        // Parabolic interpolation on log magnitude, which suits the shape of a Hann main lobe.
        let (la, lb, lc) = (a.ln(), b.ln(), c.ln());
        let curvature = la - 2.0 * lb + lc;
        let offset = if curvature < 0.0 && la.is_finite() && lc.is_finite() {
            (0.5 * (la - lc) / curvature).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        let frequency = (k as f64 + offset) * bin_hz;
        (cents_between(frequency, center).abs() <= cents + 5.0).then_some(Peak {
            frequency,
            magnitude: b,
        })
    }

    /// Whether `peak` is accounted for as harmonics of lower notes (integer multiples 3 to 8):
    /// strings already measured, or strong peaks in the spectrum at 1/h of its frequency. The
    /// expected contributions of all such notes are added up; a peak that does not clearly exceed
    /// the sum is treated as those harmonics, and one that does as a string of its own.
    ///
    /// The octave (h = 2) is never treated as a harmonic: tunings such as Drop D, DADGAD and open
    /// G put a string an octave above another, and the two cannot be told apart from a note
    /// whose second partial is strong. Hearing a string that is not sounding is a smaller fault
    /// than hiding one that is being tuned, so every doubtful case is decided towards "heard".
    fn is_harmonic(&mut self, peak: Peak, measured: &[Peak], targets: &[f64]) -> bool {
        let mut counted: Vec<f64> = Vec::new();
        let mut expected = 0.0;
        for h in 3..=MAX_HARMONIC {
            let mut sources: Vec<Peak> = measured
                .iter()
                .copied()
                .filter(|m| {
                    cents_between(peak.frequency, m.frequency * h as f64).abs() <= HARMONIC_CENTS
                })
                .collect();
            if let Some(lower) = self.find_peak(peak.frequency / h as f64, HARMONIC_CENTS) {
                // A lower peak that is another string, or a harmonic of one already measured,
                // is not a separate note.
                if lower.magnitude >= peak.magnitude * 0.5
                    && !near_any(lower.frequency, targets)
                    && !is_multiple_of_any(lower.frequency, measured)
                {
                    sources.push(lower);
                }
            }
            for source in sources {
                // The same note found twice (as a string and as a spectral peak) counts once.
                if counted
                    .iter()
                    .any(|&f| cents_between(f, source.frequency).abs() <= HARMONIC_CENTS)
                {
                    continue;
                }
                counted.push(source.frequency);
                expected += self.expected_share(source, h, peak.frequency, targets);
            }
        }
        !counted.is_empty() && peak.magnitude <= expected * CLEARLY_STRONGER
    }

    /// What harmonic `h` of `source` should contribute, read off the note's own partials: the
    /// ones that can be seen on their own (not on the peak under test, nor on a requested
    /// string, which belong to other notes too) are joined on a log-log scale and `h` is read
    /// from that curve. With nothing but the fundamental to go on, the fall-off is assumed to be
    /// `MIN_DECAY` per step.
    fn expected_share(&mut self, source: Peak, h: usize, tested: f64, targets: &[f64]) -> f64 {
        let on_its_own = |frequency: f64| {
            !near_any(frequency, targets) && cents_between(frequency, tested).abs() > SEARCH_CENTS
        };
        // (k, ln magnitude) of the partials that can be trusted, k ascending.
        let mut known = vec![(1.0, source.magnitude.ln())];
        for k in 2..=MAX_PARTIAL {
            let frequency = source.frequency * k as f64;
            if k == h || !on_its_own(frequency) {
                continue;
            }
            if let Some(partial) = self.find_peak(frequency, HARMONIC_CENTS) {
                known.push((k as f64, partial.magnitude.ln()));
            }
        }
        let target = h as f64;
        let below = known.iter().rev().find(|(k, _)| *k < target).copied();
        let above = known.iter().find(|(k, _)| *k > target).copied();
        // Partials fall off roughly as a power of k or as a power of the step; the slower of the
        // two readings is used, so the expectation errs high and a harmonic is not taken for a
        // string.
        let curve = |a: (f64, f64), b: (f64, f64)| {
            let linear = a.1 + (b.1 - a.1) * (target - a.0) / (b.0 - a.0);
            let power = a.1 + (b.1 - a.1) * (target.ln() - a.0.ln()) / (b.0.ln() - a.0.ln());
            linear.max(power)
        };
        let predicted = match (below, above) {
            (Some(a), Some(b)) => curve(a, b),
            (Some(a), None) => match known.iter().rev().find(|(k, _)| *k < a.0) {
                Some(&b) if a.1 < b.1 => curve(b, a),
                _ => source.magnitude.ln() + MIN_DECAY.ln() * (target - 1.0),
            },
            _ => source.magnitude.ln(),
        };
        predicted.min(source.magnitude.ln()).exp()
    }
}

/// Whether `frequency` is within a search window of any of `targets`.
fn near_any(frequency: f64, targets: &[f64]) -> bool {
    targets
        .iter()
        .any(|&t| cents_between(frequency, t).abs() <= SEARCH_CENTS)
}

/// Whether `frequency` is an integer multiple (2 to 8) of one of the measured strings.
fn is_multiple_of_any(frequency: f64, measured: &[Peak]) -> bool {
    measured.iter().any(|m| {
        (2..=MAX_HARMONIC)
            .any(|k| cents_between(frequency, m.frequency * k as f64).abs() <= HARMONIC_CENTS)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cents(measured: f64, expected: f64) -> f64 {
        1200.0 * (measured / expected).log2()
    }

    /// Sum of harmonics `amps[h-1] * sin(h * 2 pi f t)`.
    fn harmonic_tone(freq: f64, rate: f64, len: usize, amps: &[f64]) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let t = i as f64 / rate;
                amps.iter()
                    .enumerate()
                    .map(|(h, a)| a * (std::f64::consts::TAU * freq * (h + 1) as f64 * t).sin())
                    .sum::<f64>() as f32
            })
            .collect()
    }

    fn sine(freq: f64, rate: f64, len: usize, amp: f64) -> Vec<f32> {
        harmonic_tone(freq, rate, len, &[amp])
    }

    fn saw_like() -> Vec<f64> {
        (1..=10).map(|h| 0.4 / h as f64).collect()
    }

    fn guitar_like() -> Vec<f64> {
        (0..8).map(|h| 0.35 * 0.6f64.powi(h)).collect()
    }

    fn noise(len: usize, amp: f32) -> Vec<f32> {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                ((state >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32 * amp
            })
            .collect()
    }

    const FREQS: [f64; 6] = [41.2, 82.41, 110.0, 196.0, 329.63, 1000.0];
    const RATES: [f64; 2] = [44_100.0, 48_000.0];

    #[test]
    fn yin_sines_within_one_cent() {
        for rate in RATES {
            for freq in FREQS {
                let samples = sine(freq, rate, yin_frame_len(rate) + 500, 0.3);
                let pitch = detect_pitch(&samples, rate).unwrap_or_else(|| panic!("{freq}"));
                assert!(
                    cents(pitch.frequency, freq).abs() <= 1.0,
                    "{freq} Hz at {rate}: got {}",
                    pitch.frequency
                );
                assert!(pitch.clarity > 0.9);
            }
        }
    }

    #[test]
    fn yin_harmonic_rich_tones_within_one_cent() {
        for amps in [saw_like(), guitar_like()] {
            for rate in RATES {
                for freq in FREQS {
                    let samples = harmonic_tone(freq, rate, yin_frame_len(rate), &amps);
                    let pitch = detect_pitch(&samples, rate).unwrap_or_else(|| panic!("{freq}"));
                    assert!(
                        cents(pitch.frequency, freq).abs() <= 1.0,
                        "{freq} Hz at {rate}: got {}",
                        pitch.frequency
                    );
                }
            }
        }
    }

    #[test]
    fn yin_strong_second_harmonic_is_not_an_octave_error() {
        for rate in RATES {
            for freq in [82.41, 110.0, 196.0, 329.63] {
                let samples = harmonic_tone(freq, rate, yin_frame_len(rate), &[0.15, 0.4, 0.1]);
                let pitch = detect_pitch(&samples, rate).expect("pitch");
                assert!(
                    cents(pitch.frequency, freq).abs() <= 1.0,
                    "{freq} Hz at {rate}: got {}",
                    pitch.frequency
                );
            }
        }
    }

    #[test]
    fn yin_uses_the_latest_samples() {
        let rate = 48_000.0;
        let mut samples = sine(110.0, rate, 30_000, 0.3);
        samples.extend(sine(196.0, rate, yin_frame_len(rate), 0.3));
        let pitch = detect_pitch(&samples, rate).expect("pitch");
        assert!(cents(pitch.frequency, 196.0).abs() <= 1.0);
    }

    #[test]
    fn yin_silence_and_noise_report_nothing() {
        for rate in RATES {
            let len = yin_frame_len(rate) + 1000;
            assert_eq!(detect_pitch(&vec![0.0; len], rate), None);
            assert_eq!(detect_pitch(&noise(len, 0.5), rate), None);
            assert_eq!(detect_pitch(&noise(len, 0.05), rate), None);
        }
    }

    #[test]
    fn yin_gate_blocks_a_quiet_tone_and_passes_a_louder_one() {
        let rate = 48_000.0;
        let len = yin_frame_len(rate);
        // A sine of amplitude a has RMS a / sqrt(2): 0.002 is about -57 dBFS, 0.01 about -43.
        assert_eq!(detect_pitch(&sine(110.0, rate, len, 0.002), rate), None);
        assert!(detect_pitch(&sine(110.0, rate, len, 0.01), rate).is_some());
    }

    #[test]
    fn yin_needs_a_full_frame_and_a_sane_rate() {
        let rate = 48_000.0;
        let short = sine(110.0, rate, yin_frame_len(rate) - 1, 0.3);
        assert_eq!(detect_pitch(&short, rate), None);
        let full = sine(110.0, rate, yin_frame_len(rate), 0.3);
        assert_eq!(detect_pitch(&full, 0.0), None);
        assert_eq!(detect_pitch(&full, f64::NAN), None);
    }

    #[test]
    fn yin_ignores_non_finite_samples() {
        let rate = 48_000.0;
        let mut samples = sine(110.0, rate, yin_frame_len(rate), 0.3);
        samples[100] = f32::NAN;
        assert_eq!(detect_pitch(&samples, rate), None);
    }

    #[test]
    fn rms_levels() {
        assert_eq!(rms_dbfs(&[]), SILENT_DBFS);
        assert_eq!(rms_dbfs(&[0.0; 64]), SILENT_DBFS);
        assert_eq!(rms_dbfs(&[f32::NAN; 4]), SILENT_DBFS);
        assert!((rms_dbfs(&[1.0; 64]) - 0.0).abs() < 1e-4);
        assert!((rms_dbfs(&[0.1; 64]) + 20.0).abs() < 1e-3);
        let wave = sine(100.0, 48_000.0, 48_000, 1.0);
        assert!((rms_dbfs(&wave) + 3.0103).abs() < 0.01);
    }

    #[test]
    fn target_validation() {
        assert!(validate_targets(&[]).is_ok());
        assert!(validate_targets(&[82.41, 110.0, 5000.0, 20.0]).is_ok());
        assert!(validate_targets(&[100.0; 12]).is_ok());
        assert!(validate_targets(&[100.0; 13]).is_err());
        assert!(validate_targets(&[19.9]).is_err());
        assert!(validate_targets(&[5000.1]).is_err());
        assert!(validate_targets(&[f64::NAN]).is_err());
        assert!(validate_targets(&[f64::INFINITY]).is_err());
        assert!(validate_targets(&[f64::NEG_INFINITY]).is_err());
    }

    #[test]
    fn fft_matches_a_direct_transform() {
        let n = 64;
        let signal: Vec<f64> = (0..n)
            .map(|i| (i as f64 * 0.37).sin() + 0.5 * (i as f64 * 1.9).cos() + (i % 5) as f64)
            .collect();
        let mut re = signal.clone();
        let mut im = vec![0.0; n];
        Fft::new(n).forward(&mut re, &mut im);
        for k in 0..n {
            let (mut sr, mut si) = (0.0, 0.0);
            for (i, x) in signal.iter().enumerate() {
                let angle = -std::f64::consts::TAU * (i * k) as f64 / n as f64;
                sr += x * angle.cos();
                si += x * angle.sin();
            }
            assert!(
                (re[k] - sr).abs() < 1e-9 && (im[k] - si).abs() < 1e-9,
                "bin {k}"
            );
        }
    }

    const STANDARD: [f64; 6] = [82.4069, 110.0, 146.8324, 195.9977, 246.9417, 329.6276];

    fn detuned(freq: f64, cents: f64) -> f64 {
        freq * (cents / 1200.0).exp2()
    }

    fn chord(rate: f64, offsets: [f64; 6], skip: Option<usize>) -> Vec<f32> {
        let len = 20_000;
        let amps = [0.12, 0.06, 0.03, 0.015];
        let mut mix = vec![0.0f32; len];
        for (i, (&freq, &offset)) in STANDARD.iter().zip(&offsets).enumerate() {
            if skip == Some(i) {
                continue;
            }
            let tone = harmonic_tone(detuned(freq, offset), rate, len, &amps);
            mix.iter_mut().zip(tone).for_each(|(m, t)| *m += t);
        }
        mix
    }

    #[test]
    fn polyphonic_chord_with_two_detuned_strings() {
        for rate in RATES {
            let offsets = [0.0, 0.0, -20.0, 12.0, 0.0, 0.0];
            let samples = chord(rate, offsets, None);
            let mut analyzer = PolyAnalyzer::new(rate);
            let found = analyzer.analyze(&samples, &STANDARD);
            for (i, measured) in found.iter().enumerate() {
                let measured = measured.unwrap_or_else(|| panic!("string {i} at {rate}"));
                let error = cents(measured, detuned(STANDARD[i], offsets[i]));
                assert!(error.abs() <= 3.0, "string {i} at {rate}: {error} cents");
            }
        }
    }

    #[test]
    fn polyphonic_accuracy_across_detunes() {
        let rate = 48_000.0;
        let mut analyzer = PolyAnalyzer::new(rate);
        for offset in [-45.0, -30.0, -7.0, 0.0, 3.0, 25.0, 45.0] {
            for target in [82.4069, 329.6276, 1000.0] {
                let actual = detuned(target, offset);
                let samples = harmonic_tone(actual, rate, 20_000, &[0.2, 0.05]);
                let found = analyzer.analyze(&samples, &[target]);
                let measured = found[0].unwrap_or_else(|| panic!("{target} {offset}"));
                let error = cents(measured, actual);
                assert!(error.abs() <= 2.0, "{target} Hz, {offset} cents: {error}");
            }
        }
    }

    #[test]
    fn polyphonic_missing_string_is_none() {
        for rate in RATES {
            for skip in [1usize, 3] {
                let samples = chord(rate, [0.0, 5.0, -4.0, 8.0, -10.0, 2.0], Some(skip));
                let found = PolyAnalyzer::new(rate).analyze(&samples, &STANDARD);
                for (i, measured) in found.iter().enumerate() {
                    assert_eq!(measured.is_none(), i == skip, "string {i}, skipped {skip}");
                }
            }
        }
    }

    #[test]
    fn polyphonic_ignores_a_note_outside_the_search_range() {
        let rate = 48_000.0;
        let samples = sine(detuned(110.0, 70.0), rate, 20_000, 0.2);
        let found = PolyAnalyzer::new(rate).analyze(&samples, &[110.0]);
        assert_eq!(found, vec![None]);
    }

    #[test]
    fn polyphonic_silence_noise_and_short_input_are_none() {
        let rate = 48_000.0;
        let mut analyzer = PolyAnalyzer::new(rate);
        assert_eq!(
            analyzer.analyze(&vec![0.0; 20_000], &STANDARD),
            vec![None; 6]
        );
        assert_eq!(
            analyzer.analyze(&noise(20_000, 0.3), &STANDARD),
            vec![None; 6]
        );
        let quiet = sine(110.0, rate, 20_000, 0.0001);
        assert_eq!(analyzer.analyze(&quiet, &[110.0]), vec![None]);
        let short = sine(110.0, rate, analyzer.window_len() - 1, 0.3);
        assert_eq!(analyzer.analyze(&short, &[110.0]), vec![None]);
        assert!(analyzer.analyze(&short, &[]).is_empty());
    }

    #[test]
    fn polyphonic_removes_a_dc_offset() {
        let rate = 48_000.0;
        let samples: Vec<f32> = sine(196.0, rate, 20_000, 0.1)
            .iter()
            .map(|x| x + 0.3)
            .collect();
        let found = PolyAnalyzer::new(rate).analyze(&samples, &[195.9977]);
        assert!(cents(found[0].expect("peak"), 196.0).abs() <= 3.0);
    }

    #[test]
    fn polyphonic_window_scales_with_the_rate() {
        assert_eq!(PolyAnalyzer::new(44_100.0).window_len(), 16_384);
        assert_eq!(PolyAnalyzer::new(48_000.0).window_len(), 16_384);
        assert_eq!(PolyAnalyzer::new(96_000.0).window_len(), 32_768);
    }

    /// A plucked-string spectrum: harmonics fall off but stay clearly audible.
    const STRING_HARMONICS: [f64; 8] = [0.2, 0.12, 0.08, 0.05, 0.03, 0.02, 0.012, 0.008];

    /// A faster fall-off, as on a damped chord: partials half the size of the one below.
    const STEEP_HARMONICS: [f64; 8] = [0.2, 0.1, 0.05, 0.025, 0.0125, 0.006, 0.003, 0.0015];

    fn mix(rate: f64, notes: &[(f64, f64)]) -> Vec<f32> {
        mix_with(rate, notes, &STEEP_HARMONICS)
    }

    fn mix_with(rate: f64, notes: &[(f64, f64)], harmonics: &[f64]) -> Vec<f32> {
        let len = 20_000;
        let mut out = vec![0.0f32; len];
        for &(freq, gain) in notes {
            let amps: Vec<f64> = harmonics.iter().map(|a| a * gain).collect();
            let tone = harmonic_tone(freq, rate, len, &amps);
            out.iter_mut().zip(tone).for_each(|(m, t)| *m += t);
        }
        out
    }

    const FLAT_HARMONICS: [f64; 8] = [0.2, 0.1, 0.067, 0.05, 0.04, 0.033, 0.029, 0.025];

    /// Profiles in which a harmonic never exceeds what the lower partials predict.
    fn profiles() -> [&'static [f64]; 2] {
        [&STEEP_HARMONICS, &FLAT_HARMONICS]
    }

    #[test]
    fn a_lone_a2_does_not_light_up_e4_or_the_others() {
        for rate in RATES {
            for harmonics in profiles() {
                let a2 = detuned(110.0, 9.0);
                let samples = mix_with(rate, &[(a2, 1.0)], harmonics);
                let found = PolyAnalyzer::new(rate).analyze(&samples, &STANDARD);
                for (i, measured) in found.iter().enumerate() {
                    if i == 1 {
                        assert!(cents(measured.expect("A2"), a2).abs() <= 3.0);
                    } else {
                        assert_eq!(*measured, None, "string {i} at {rate}: {harmonics:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_lone_e2_does_not_light_up_b3_or_e4() {
        for rate in RATES {
            for harmonics in profiles() {
                let samples = mix_with(rate, &[(STANDARD[0], 1.0)], harmonics);
                let found = PolyAnalyzer::new(rate).analyze(&samples, &STANDARD);
                assert!(found[0].is_some());
                assert!(found[1..].iter().all(Option::is_none), "{found:?}");
            }
        }
    }

    #[test]
    fn every_lone_string_reports_only_itself() {
        let rate = 48_000.0;
        let mut analyzer = PolyAnalyzer::new(rate);
        for harmonics in profiles() {
            for (i, &freq) in STANDARD.iter().enumerate() {
                let samples = mix_with(rate, &[(freq, 1.0)], harmonics);
                let found = analyzer.analyze(&samples, &STANDARD);
                for (j, measured) in found.iter().enumerate() {
                    assert_eq!(measured.is_some(), i == j, "played {i}, string {j}");
                }
            }
        }
    }

    #[test]
    fn a_full_realistic_chord_measures_all_six() {
        for rate in RATES {
            for e4_offset in [0.0, 15.0, -15.0] {
                let offsets = [0.0, -6.0, 4.0, 0.0, 2.0, e4_offset];
                let notes: Vec<(f64, f64)> = STANDARD
                    .iter()
                    .zip(offsets)
                    .map(|(&f, c)| (detuned(f, c), 1.0))
                    .collect();
                let samples = mix_with(rate, &notes, &STEEP_HARMONICS);
                let found = PolyAnalyzer::new(rate).analyze(&samples, &STANDARD);
                for (i, measured) in found.iter().enumerate() {
                    let measured = measured.unwrap_or_else(|| panic!("string {i}, E4 {e4_offset}"));
                    let error = cents(measured, detuned(STANDARD[i], offsets[i]));
                    assert!(error.abs() <= 3.0, "string {i}, E4 {e4_offset}: {error}");
                }
            }
        }
    }

    #[test]
    fn a_full_chord_keeps_every_string_whatever_the_partial_profile() {
        for rate in RATES {
            for harmonics in profiles() {
                for e4_offset in [0.0, 15.0] {
                    let notes: Vec<(f64, f64)> = STANDARD
                        .iter()
                        .enumerate()
                        .map(|(i, &f)| (detuned(f, if i == 5 { e4_offset } else { 2.0 }), 1.0))
                        .collect();
                    let samples = mix_with(rate, &notes, harmonics);
                    let found = PolyAnalyzer::new(rate).analyze(&samples, &STANDARD);
                    assert!(
                        found.iter().all(Option::is_some),
                        "{harmonics:?}: {found:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_realistic_chord_without_b3_and_e4_leaves_them_none() {
        for rate in RATES {
            for harmonics in profiles() {
                let notes: Vec<(f64, f64)> = [0usize, 1, 2, 3]
                    .iter()
                    .map(|&i| (detuned(STANDARD[i], 5.0), 1.0))
                    .collect();
                let samples = mix_with(rate, &notes, harmonics);
                let found = PolyAnalyzer::new(rate).analyze(&samples, &STANDARD);
                for (i, measured) in found.iter().enumerate() {
                    assert_eq!(measured.is_some(), i < 4, "string {i}: {found:?}");
                }
            }
        }
    }

    #[test]
    fn a_harmonic_of_a_note_that_is_not_a_target_is_not_a_string() {
        // A2 rings but only the upper three strings are tuned.
        let rate = 48_000.0;
        let upper = &STANDARD[3..];
        let found = PolyAnalyzer::new(rate).analyze(&mix(rate, &[(110.0, 1.0)]), upper);
        assert_eq!(found, vec![None; 3]);
        // With the real strings sounding too, they are still measured.
        let notes = [(110.0, 1.0), (STANDARD[3], 1.0), (STANDARD[5], 1.0)];
        let found = PolyAnalyzer::new(rate).analyze(&mix(rate, &notes), upper);
        assert!(found[0].is_some() && found[1].is_none() && found[2].is_some());
    }

    #[test]
    fn bad_targets_read_as_none_and_the_rest_are_unaffected() {
        let rate = 48_000.0;
        let samples = mix(rate, &[(110.0, 1.0)]);
        let found = PolyAnalyzer::new(rate).analyze(
            &samples,
            &[f64::NAN, 110.0, 10.0, 6000.0, f64::INFINITY, 0.0, -110.0],
        );
        assert_eq!(found.len(), 7);
        assert!(found[1].is_some());
        assert!(found.iter().enumerate().all(|(i, f)| i == 1 || f.is_none()));
        assert!(
            PolyAnalyzer::new(rate)
                .analyze(&samples, &[f64::NAN])
                .iter()
                .all(Option::is_none)
        );
    }

    #[test]
    fn yin_at_8_khz_finds_low_and_high_notes() {
        for freq in [82.41, 329.63, 1000.0] {
            let samples = harmonic_tone(freq, 8000.0, yin_frame_len(8000.0), &[0.3, 0.1]);
            let pitch = detect_pitch(&samples, 8000.0).expect("pitch");
            assert!(cents(pitch.frequency, freq).abs() <= 1.0, "{freq}");
        }
    }

    #[test]
    fn yin_fallback_prefers_the_first_dip_over_a_deeper_multiple() {
        // Noise keeps every dip above the clean threshold, so the fallback decides. The dips at
        // the period and its multiples are nearly equal, and the deepest is often a multiple.
        let rate = 24_000.0;
        let freq = 110.0;
        let mut found = 0;
        for seed in 1..=40u64 {
            let mut signal = harmonic_tone(freq, rate, yin_frame_len(rate), &[0.25, 0.12, 0.06]);
            let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            for sample in signal.iter_mut() {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *sample += ((state >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32 * 0.2;
            }
            if let Some(pitch) = detect_pitch(&signal, rate) {
                found += 1;
                assert!(
                    cents(pitch.frequency, freq).abs() <= 100.0,
                    "seed {seed}: {} Hz",
                    pitch.frequency
                );
                assert!(pitch.clarity < 0.85, "seed {seed} did not use the fallback");
            }
        }
        assert!(found >= 20, "only {found} detections");
    }

    /// Harmonics with a random phase each, as separate strings never share one.
    fn phased_mix(rate: f64, notes: &[(f64, f64)], harmonics: &[f64], seed: u64) -> Vec<f32> {
        let len = 20_000;
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut out = vec![0.0f64; len];
        for &(freq, gain) in notes {
            for (h, amp) in harmonics.iter().enumerate() {
                let phase = next() * std::f64::consts::TAU;
                let step = std::f64::consts::TAU * freq * (h + 1) as f64 / rate;
                for (i, slot) in out.iter_mut().enumerate() {
                    *slot += amp * gain * (step * i as f64 + phase).sin();
                }
            }
        }
        out.into_iter().map(|x| x as f32).collect()
    }

    const DROP_D: [f64; 6] = [73.4162, 110.0, 146.8324, 195.9977, 246.9417, 329.6276];
    const DADGAD: [f64; 6] = [73.4162, 110.0, 146.8324, 195.9977, 220.0, 293.6648];

    /// Every string played in tune, over 50 random phase sets. Each string must be heard in at
    /// least `min_heard` of them, and every reading must be within 3 cents in at least
    /// `min_accurate` of the runs. (Detuned strings are not used here: a string a few cents from another's
    /// harmonic merges with it, and no analysis of one window can undo that.)
    fn assert_tuning_is_heard(
        strings: &[f64; 6],
        harmonics: &[f64],
        gain: f64,
        min_heard: usize,
        min_accurate: usize,
    ) {
        let rate = 48_000.0;
        let notes: Vec<(f64, f64)> = strings
            .iter()
            .enumerate()
            .map(|(i, &f)| (f, if i < 3 { 1.0 } else { gain }))
            .collect();
        let mut analyzer = PolyAnalyzer::new(rate);
        let mut heard = [0usize; 6];
        let mut accurate = 0;
        for seed in 1..=50u64 {
            let samples = phased_mix(rate, &notes, harmonics, seed);
            let found = analyzer.analyze(&samples, strings);
            let mut worst = 0.0f64;
            for (i, measured) in found.iter().enumerate() {
                if let Some(measured) = measured {
                    heard[i] += 1;
                    worst = worst.max(cents(*measured, strings[i]).abs());
                }
            }
            accurate += usize::from(worst <= 3.0);
        }
        assert!(
            heard.iter().all(|&n| n >= min_heard),
            "heard {heard:?} of 50: {strings:?}, gain {gain}, {harmonics:?}"
        );
        assert!(
            accurate >= min_accurate,
            "{accurate} of 50 within 3 cents: {strings:?}, gain {gain}, {harmonics:?}"
        );
    }

    /// A treble string a few cents off, strummed with in-tune bass strings whose harmonics fall
    /// next to it, over 50 random phase sets. The two partials merge within one window, so the
    /// reading is a blend: this measures how far off it can be, and how often an out-of-tune
    /// string reads as in tune (within 3 cents). The validation doc quotes these numbers.
    #[test]
    fn a_detuned_treble_string_beside_bass_harmonics_reads_as_a_blend() {
        let rate = 48_000.0;
        let mut analyzer = PolyAnalyzer::new(rate);
        let mut report = Vec::new();
        for (name, harmonics) in [
            ("steep", &STEEP_HARMONICS[..]),
            ("flat", &FLAT_HARMONICS[..]),
        ] {
            for gain in [1.0, 0.5] {
                for (string, detune) in [
                    (4usize, -8.0),
                    (4, 8.0),
                    (5, -8.0),
                    (5, 8.0),
                    (4, -4.0),
                    (4, 4.0),
                    (5, -4.0),
                    (5, 4.0),
                ] {
                    let mut played = STANDARD;
                    played[string] *= 2f64.powf(detune / 1200.0);
                    let notes: Vec<(f64, f64)> = played
                        .iter()
                        .enumerate()
                        .map(|(i, &f)| (f, if i < 3 { 1.0 } else { gain }))
                        .collect();
                    let (mut heard, mut falsely_in_tune, mut worst) = (0, 0, 0.0f64);
                    for seed in 1..=50u64 {
                        let samples = phased_mix(rate, &notes, harmonics, seed);
                        if let Some(measured) = analyzer.analyze(&samples, &STANDARD)[string] {
                            heard += 1;
                            let shown = cents(measured, STANDARD[string]);
                            worst = worst.max((shown - detune).abs());
                            falsely_in_tune += usize::from(shown.abs() <= 3.0);
                        }
                    }
                    report.push(format!(
                        "{name} gain {gain} string {} {detune:+}: heard {heard}/50, worst error {worst:.1} cents, in tune {falsely_in_tune}",
                        string + 1
                    ));
                    // A blend, but never further off than the gap to the neighbouring harmonic.
                    // Heard at all, so the error checks below measure something (lowest seen: 16 of 50).
                    assert!(heard >= 10, "{}", report.last().unwrap());
                    assert!(worst <= 20.0, "{}", report.last().unwrap());
                    // Eight cents off is never shown as in tune.
                    if detune.abs() >= 8.0 {
                        assert_eq!(falsely_in_tune, 0, "{}", report.last().unwrap());
                    }
                }
            }
        }
        println!("{}", report.join("\n"));
    }

    #[test]
    fn standard_tuning_with_quiet_treble_strings_is_heard_at_any_phase() {
        for harmonics in [STEEP_HARMONICS, FLAT_HARMONICS] {
            assert_tuning_is_heard(&STANDARD, &harmonics, 1.0, 40, 48);
            // 6 dB down, under the bass strings' own harmonics. Where the quiet string's pitch is
            // also a harmonic of a bass string the two are told apart only by size, and the
            // phase of the sum decides some of the time (the worker holds a reading for 1 s).
            assert_tuning_is_heard(&STANDARD, &harmonics, 0.5, 20, 44);
        }
    }

    #[test]
    fn drop_d_is_heard_at_any_phase() {
        for harmonics in [STRING_HARMONICS, STEEP_HARMONICS, FLAT_HARMONICS] {
            assert_tuning_is_heard(&DROP_D, &harmonics, 1.0, 40, 48);
            assert_tuning_is_heard(&DROP_D, &harmonics, 0.5, 20, 44);
        }
    }

    #[test]
    fn dadgad_is_heard_at_any_phase() {
        for harmonics in [STRING_HARMONICS, STEEP_HARMONICS, FLAT_HARMONICS] {
            assert_tuning_is_heard(&DADGAD, &harmonics, 1.0, 40, 48);
            assert_tuning_is_heard(&DADGAD, &harmonics, 0.5, 20, 44);
        }
    }

    #[test]
    fn lone_strings_stay_alone_at_any_phase() {
        let rate = 48_000.0;
        let mut analyzer = PolyAnalyzer::new(rate);
        for harmonics in profiles() {
            for seed in 1..=10u64 {
                for (played, name) in [(0usize, "E2"), (1, "A2")] {
                    let note = detuned(STANDARD[played], 9.0);
                    let samples = phased_mix(rate, &[(note, 1.0)], harmonics, seed);
                    let found = analyzer.analyze(&samples, &STANDARD);
                    for (i, measured) in found.iter().enumerate() {
                        assert_eq!(
                            measured.is_some(),
                            i == played,
                            "lone {name}, string {i}, seed {seed}, {harmonics:?}"
                        );
                    }
                }
            }
        }
    }
}
