//! Integer-factor decimation with a windowed-sinc low-pass, so the pitch detectors never work
//! above about 48 kHz however fast the device runs. Lower rates are left alone: YIN's
//! interpolation is more accurate on high notes the more samples a period has.

/// The analysis rate to aim for when decimating.
const TARGET_RATE: f64 = 46_000.0;
/// Rates up to this are analysed as they are.
const PASS_THROUGH_RATE: f64 = 48_000.0;

/// The integer factor that brings `rate` near 46 kHz (1 for rates up to 48 kHz). Standard rates
/// land at 44.1 or 48 kHz; others end between about 34.5 and 69 kHz.
pub fn factor_for(rate: f64) -> usize {
    if rate <= PASS_THROUGH_RATE {
        1
    } else {
        ((rate / TARGET_RATE).round() as usize).max(1)
    }
}

pub struct Decimator {
    factor: usize,
    taps: Vec<f32>,
    pending: Vec<f32>,
}

impl Decimator {
    pub fn new(factor: usize) -> Self {
        let factor = factor.max(1);
        let taps = if factor == 1 {
            Vec::new()
        } else {
            // Pass up to 0.4 of the output Nyquist band's width; Blackman window, about 74 dB
            // of stop-band attenuation.
            let len = 32 * factor + 1;
            let cutoff = 0.4 / factor as f64;
            let centre = (len - 1) as f64 / 2.0;
            let mut taps: Vec<f64> = (0..len)
                .map(|i| {
                    let x = i as f64 - centre;
                    let sinc = if x == 0.0 {
                        2.0 * cutoff
                    } else {
                        (std::f64::consts::TAU * cutoff * x).sin() / (std::f64::consts::PI * x)
                    };
                    let w = i as f64 / (len - 1) as f64;
                    let window = 0.42 - 0.5 * (std::f64::consts::TAU * w).cos()
                        + 0.08 * (2.0 * std::f64::consts::TAU * w).cos();
                    sinc * window
                })
                .collect();
            let gain: f64 = taps.iter().sum();
            taps.iter_mut().for_each(|t| *t /= gain);
            taps.into_iter().map(|t| t as f32).collect()
        };
        Self {
            factor,
            taps,
            pending: Vec::new(),
        }
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    /// Appends the decimated form of `input` to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.factor == 1 {
            out.extend_from_slice(input);
            return;
        }
        self.pending.extend_from_slice(input);
        let len = self.taps.len();
        let mut start = 0;
        while start + len <= self.pending.len() {
            let window = &self.pending[start..start + len];
            out.push(window.iter().zip(&self.taps).map(|(x, t)| x * t).sum());
            start += self.factor;
        }
        self.pending.drain(..start);
    }

    /// Forgets buffered input, as when the source stalled.
    pub fn reset(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tuner::detect::{detect_pitch, yin_frame_len};

    fn sine(freq: f64, rate: f64, len: usize, amp: f64) -> Vec<f32> {
        (0..len)
            .map(|i| (amp * (std::f64::consts::TAU * freq * i as f64 / rate).sin()) as f32)
            .collect()
    }

    #[test]
    fn factors() {
        assert_eq!(factor_for(8_000.0), 1);
        assert_eq!(factor_for(22_050.0), 1);
        assert_eq!(factor_for(44_100.0), 1);
        assert_eq!(factor_for(48_000.0), 1);
        assert_eq!(factor_for(88_200.0), 2);
        assert_eq!(factor_for(96_000.0), 2);
        assert_eq!(factor_for(176_400.0), 4);
        assert_eq!(factor_for(192_000.0), 4);
        assert_eq!(factor_for(384_000.0), 8);
        for rate in [
            88_200.0, 96_000.0, 176_400.0, 192_000.0, 384_000.0, 768_000.0,
        ] {
            let out = rate / factor_for(rate) as f64;
            assert!((44_000.0..=48_000.0).contains(&out), "{rate} -> {out}");
        }
    }

    #[test]
    fn passes_the_band_and_blocks_aliases() {
        let rate = 96_000.0;
        let mut decimator = Decimator::new(4);
        let mut out = Vec::new();
        let low = sine(1000.0, rate, 20_000, 0.5);
        decimator.process(&low, &mut out);
        let peak = out[200..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((peak - 0.5).abs() < 0.02, "{peak}");
        // 30 kHz would fold to 6 kHz at the 24 kHz output rate.
        let mut decimator = Decimator::new(4);
        let mut out = Vec::new();
        decimator.process(&sine(30_000.0, rate, 20_000, 0.5), &mut out);
        let peak = out[200..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak < 0.002, "{peak}");
    }

    #[test]
    fn chunked_input_matches_one_call() {
        let signal = sine(440.0, 96_000.0, 10_000, 0.4);
        let mut whole = Vec::new();
        Decimator::new(4).process(&signal, &mut whole);
        let mut decimator = Decimator::new(4);
        let mut pieces = Vec::new();
        for chunk in signal.chunks(333) {
            decimator.process(chunk, &mut pieces);
        }
        assert_eq!(whole, pieces);
    }

    /// A harmonic-rich tone through the same path the worker uses.
    fn detect_through_decimation(freq: f64, rate: f64) -> f64 {
        let factor = factor_for(rate);
        let out_rate = rate / factor as f64;
        let need = yin_frame_len(out_rate) + 1000;
        let mut decimator = Decimator::new(factor);
        let mut out = Vec::new();
        let len = need * factor + 2000;
        let tone: Vec<f32> = (0..len)
            .map(|i| {
                let t = i as f64 / rate;
                [0.3, 0.15, 0.08]
                    .iter()
                    .enumerate()
                    .map(|(h, a)| a * (std::f64::consts::TAU * freq * (h + 1) as f64 * t).sin())
                    .sum::<f64>() as f32
            })
            .collect();
        decimator.process(&tone, &mut out);
        assert!(out.len() >= need);
        detect_pitch(&out, out_rate).expect("pitch").frequency
    }

    fn cents(a: f64, b: f64) -> f64 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn yin_at_high_sample_rates_within_one_cent() {
        for rate in [96_000.0, 192_000.0] {
            for freq in [41.2, 110.0, 329.63, 659.26, 988.0, 1000.0, 1318.5] {
                let measured = detect_through_decimation(freq, rate);
                assert!(
                    cents(measured, freq).abs() <= 1.0,
                    "{freq} Hz at {rate}: {measured}"
                );
            }
        }
    }

    #[test]
    fn yin_at_8_khz_within_one_cent() {
        for freq in [82.41, 110.0, 329.63, 1000.0] {
            let measured = detect_through_decimation(freq, 8_000.0);
            assert!(cents(measured, freq).abs() <= 1.0, "{freq} Hz: {measured}");
        }
    }

    #[test]
    fn analysis_stays_cheap_at_192_khz() {
        let out_rate = 192_000.0 / factor_for(192_000.0) as f64;
        // About 5M multiply-adds per pass instead of 62M.
        assert!(yin_frame_len(out_rate) < 5000);
    }
}
