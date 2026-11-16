//! Offline shaping of the recorded drum kit's hits, done once when a hit's recording is loaded and never in the audio callback.
//!
//! Each kit sound names a profile in a small table beside the kit map (carried in the manifest, validated here). A profile lists, in
//! the order they run: mixing in a second microphone's recording of the same performance (aligned in time and polarity by
//! measurement, not summed blindly), an equaliser, a compressor and a tail envelope. The result is one ordinary buffer, so playing
//! it costs what playing the raw recording costs. Everything here is deterministic: no random numbers, no clock, no threads. The
//! coefficient maths uses the platform's `sin`, `cos`, `exp` and `powf`, which may differ in the last bit between platforms, so the
//! tests compare within tolerances, never bit for bit.
//!
//! The table is data and is not trusted: every count and number is bounded and rejected when out of range.
use super::decode::DecodedAudio;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

pub const MAX_PROFILES: usize = 32;
pub const MAX_SOUNDS: usize = 128;
pub const MAX_EQ_BANDS: usize = 8;
pub const MAX_NAME_LENGTH: usize = 32;
/// The longest a processed hit may be: nothing in a drum kit rings longer than this.
pub const MAX_END_MS: f64 = 20_000.0;
/// The low band the two microphones are compared in: a drum's thump is the part both of them hear the same way.
const ALIGN_LOWPASS_HZ: f64 = 250.0;
/// How much of a hit's start the two microphones are compared over.
const ALIGN_WINDOW_MS: f64 = 100.0;
/// The tail of a hit is faded to nothing over this long, so cutting it never clicks.
const END_FADE_MS: f64 = 15.0;
/// The sample rates a processed recording may have, as the voices accept them.
const RATES: std::ops::RangeInclusive<u32> = 8_000..=192_000;
/// The largest sample a processed hit may reach, where full scale is 1: 8 is 18 dB over it. The shipped kit's largest is far under.
pub const MAX_PROCESSED_PEAK: f32 = 8.0;
/// Values smaller than this are written as zero, so no subnormal number reaches a buffer (they cost a slow path on some CPUs).
const FLUSH: f64 = 1e-30;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KitProcessing {
    /// Named profiles.
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
    /// The profile each kit sound (a key from 0 to 127, written as text) plays through; a sound not named plays as recorded.
    #[serde(default)]
    pub sounds: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Profile {
    pub companion: Option<Companion>,
    pub eq: Vec<EqBand>,
    pub compressor: Option<Compressor>,
    pub envelope: Option<Envelope>,
}

/// A second microphone's recording of the same performance, mixed in after it is aligned with the first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Companion {
    /// Level of the companion against the main recording, dB.
    pub gain_db: f64,
    /// The farthest the two arrivals may differ (either way), ms. The alignment looks no farther.
    pub max_offset_ms: f64,
    /// The least normalised correlation of the two thumps accepted at the best alignment; below it the pair is rejected.
    pub min_correlation: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EqKind {
    Highpass,
    Lowpass,
    Lowshelf,
    Highshelf,
    Peak,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EqBand {
    pub kind: EqKind,
    pub hz: f64,
    /// Gain in dB for a shelf or a peak; a high-pass and a low-pass take none and must say 0.
    #[serde(default)]
    pub db: f64,
    pub q: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Compressor {
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
}

/// Shortens a hit's tail: after `hold_ms` from the hit's start, the level falls a further `decay_db_per_second`; the hit ends at
/// `end_ms`, faded out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub hold_ms: f64,
    pub decay_db_per_second: f64,
    pub end_ms: f64,
}

fn within(value: f64, low: f64, high: f64) -> bool {
    value.is_finite() && value >= low && value <= high
}

impl KitProcessing {
    /// Rejects anything out of range or inconsistent. Every number is finite and bounded, names are short and plain, and every sound
    /// names a profile that exists.
    pub fn validate(&self) -> Result<(), String> {
        if self.profiles.len() > MAX_PROFILES || self.sounds.len() > MAX_SOUNDS {
            return Err("Kit processing table is too large".into());
        }
        let plain = |name: &str| {
            !name.is_empty()
                && name.len() <= MAX_NAME_LENGTH
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        for (name, profile) in &self.profiles {
            if !plain(name) {
                return Err(format!("Invalid kit processing profile name {name:?}"));
            }
            profile
                .validate()
                .map_err(|e| format!("Kit processing profile {name}: {e}"))?;
        }
        for (key, profile) in &self.sounds {
            let numeric =
                !key.is_empty() && key.len() <= 3 && key.bytes().all(|b| b.is_ascii_digit());
            if !numeric
                || key.parse::<u8>().map_or(true, |k| k > 127)
                || (key.len() > 1 && key.starts_with('0'))
                || !self.profiles.contains_key(profile)
            {
                return Err(format!("Invalid kit processing sound {key:?}"));
            }
        }
        Ok(())
    }
}

impl Profile {
    fn validate(&self) -> Result<(), String> {
        if self.eq.len() > MAX_EQ_BANDS {
            return Err("too many equaliser bands".into());
        }
        if let Some(c) = &self.companion {
            if !within(c.gain_db, -40.0, 40.0)
                || !within(c.max_offset_ms, 0.5, 12.0)
                || !within(c.min_correlation, 0.1, 0.99)
            {
                return Err("companion out of range".into());
            }
        }
        for band in &self.eq {
            let passing = matches!(band.kind, EqKind::Highpass | EqKind::Lowpass);
            if !within(band.hz, 20.0, 20_000.0)
                || !within(band.q, 0.2, 10.0)
                || !within(band.db, -18.0, 18.0)
                || (passing && band.db != 0.0)
            {
                return Err("equaliser band out of range".into());
            }
        }
        if let Some(c) = &self.compressor {
            if !within(c.threshold_db, -60.0, 0.0)
                || !within(c.ratio, 1.0, 20.0)
                || !within(c.attack_ms, 0.1, 100.0)
                || !within(c.release_ms, 5.0, 1000.0)
                || !within(c.makeup_db, -12.0, 24.0)
            {
                return Err("compressor out of range".into());
            }
        }
        if let Some(e) = &self.envelope {
            if !within(e.hold_ms, 0.0, 5000.0)
                || !within(e.decay_db_per_second, 0.0, 2000.0)
                || !within(e.end_ms, 20.0, MAX_END_MS)
            {
                return Err("envelope out of range".into());
            }
        }
        Ok(())
    }
}

/// Second-order section in transposed direct form II.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    /// The cookbook sections, normalised so `a0` is 1. `hz` must be under half the sample rate.
    pub fn new(kind: EqKind, hz: f64, db: f64, q: f64, rate: f64) -> Biquad {
        let w = std::f64::consts::TAU * hz / rate;
        let (sin, cos) = (w.sin(), w.cos());
        let alpha = sin / (2.0 * q);
        let a = 10f64.powf(db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            EqKind::Highpass => (
                (1.0 + cos) / 2.0,
                -(1.0 + cos),
                (1.0 + cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            EqKind::Lowpass => (
                (1.0 - cos) / 2.0,
                1.0 - cos,
                (1.0 - cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            EqKind::Peak => (
                1.0 + alpha * a,
                -2.0 * cos,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos,
                1.0 - alpha / a,
            ),
            EqKind::Lowshelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - s),
                    (a + 1.0) + (a - 1.0) * cos + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - s,
                )
            }
            EqKind::Highshelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - s),
                    (a + 1.0) - (a - 1.0) * cos + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - s,
                )
            }
        };
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// The section's gain in dB at `hz`.
    pub fn response_db(&self, hz: f64, rate: f64) -> f64 {
        let w = std::f64::consts::TAU * hz / rate;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let (nr, ni) = (
            self.b0 + self.b1 * c1 + self.b2 * c2,
            -(self.b1 * s1 + self.b2 * s2),
        );
        let (dr, di) = (
            1.0 + self.a1 * c1 + self.a2 * c2,
            -(self.a1 * s1 + self.a2 * s2),
        );
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }

    fn run(&self, input: &[f64]) -> Vec<f64> {
        let (mut z1, mut z2) = (0.0, 0.0);
        input
            .iter()
            .map(|&x| {
                let y = self.b0 * x + z1;
                z1 = self.b1 * x - self.a1 * y + z2;
                z2 = self.b2 * x - self.a2 * y;
                y
            })
            .collect()
    }
}

/// How the second recording lies against the first: it must be moved `lag` frames earlier (negative: later) and multiplied by
/// `sign` to coincide with it, at normalised correlation `correlation` of their low band.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Alignment {
    pub lag: isize,
    pub sign: f64,
    pub correlation: f64,
    /// How far that correlation stands above the best any other alignment gets (a wrong cycle of the thump, or the inverted
    /// microphone), which is not within 1.5 ms of the chosen one. Near 0 is ambiguous, near the correlation is unmistakable.
    pub margin: f64,
}

/// Finds the time offset and polarity at which `companion` best matches `main` in the low band both microphones hear alike (the
/// start of the hit, below 250 Hz), within `max_offset_ms` either way. Returns the best of all lags, so a polarity-inverted
/// second microphone comes back with a negative `sign` rather than a poor correlation. Errors when `main` or `companion` is silent
/// over the window or when the best correlation is under `min_correlation`.
pub fn align_companion(
    main: &[[f32; 2]],
    companion: &[[f32; 2]],
    rate: f64,
    max_offset_ms: f64,
    min_correlation: f64,
) -> Result<Alignment, String> {
    if !RATES.contains(&(rate as u32)) || ALIGN_LOWPASS_HZ >= 0.45 * rate {
        return Err(format!(
            "The sample rate {rate} Hz is not one the microphones can be aligned at"
        ));
    }
    let window = (ALIGN_WINDOW_MS / 1000.0 * rate) as usize;
    let reach = (max_offset_ms / 1000.0 * rate).ceil() as usize;
    let low = |frames: &[[f32; 2]], take: usize| {
        let mono: Vec<f64> = frames
            .iter()
            .take(take)
            .map(|f| (f[0] as f64 + f[1] as f64) / 2.0)
            .collect();
        let stage = Biquad::new(
            EqKind::Lowpass,
            ALIGN_LOWPASS_HZ,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
            rate,
        );
        stage.run(&stage.run(&mono))
    };
    // The main recording over its window, the companion over the window and the reach on either side of it.
    let m = low(main, window);
    let c = low(companion, window + 2 * reach);
    let energy_m: f64 = m.iter().map(|x| x * x).sum();
    if m.is_empty() || energy_m <= 0.0 || c.iter().all(|x| *x == 0.0) {
        return Err("A kit recording is silent where the microphones are compared".into());
    }
    let at = |lag: isize, t: usize| {
        let index = t as isize + lag;
        if index >= 0 && (index as usize) < c.len() {
            c[index as usize]
        } else {
            0.0
        }
    };
    let mut best = (0isize, 0.0f64);
    let mut all = Vec::with_capacity(2 * reach + 1);
    for lag in -(reach as isize)..=(reach as isize) {
        let (mut dot, mut energy_c) = (0.0, 0.0);
        for (t, x) in m.iter().enumerate() {
            let y = at(lag, t);
            dot += x * y;
            energy_c += y * y;
        }
        if energy_c <= 0.0 {
            continue;
        }
        let r = dot / (energy_m * energy_c).sqrt();
        all.push((lag, r));
        if r.abs() > best.1.abs() + 1e-12 {
            best = (lag, r);
        }
    }
    if best.1.abs() < min_correlation {
        return Err(format!(
            "The two microphones' recordings do not match (correlation {:.2}, at least {min_correlation:.2} wanted)",
            best.1.abs()
        ));
    }
    let apart = (1.5 / 1000.0 * rate) as isize;
    let runner_up = all
        .iter()
        .filter(|(lag, _)| (lag - best.0).abs() > apart)
        .map(|(_, r)| r.abs())
        .fold(0.0, f64::max);
    Ok(Alignment {
        lag: best.0,
        sign: best.1.signum(),
        correlation: best.1.abs(),
        margin: best.1.abs() - runner_up,
    })
}

/// The companion as the main recording hears it: moved by the alignment, made the same polarity, and as long as the main one.
fn moved(companion: &[[f32; 2]], length: usize, alignment: &Alignment) -> Vec<[f64; 2]> {
    (0..length)
        .map(|t| {
            let index = t as isize + alignment.lag;
            if index >= 0 && (index as usize) < companion.len() {
                let f = companion[index as usize];
                [f[0] as f64 * alignment.sign, f[1] as f64 * alignment.sign]
            } else {
                [0.0; 2]
            }
        })
        .collect()
}

fn compress(frames: &mut [[f64; 2]], c: &Compressor, rate: f64) {
    let attack = (-1.0 / (c.attack_ms / 1000.0 * rate)).exp();
    let release = (-1.0 / (c.release_ms / 1000.0 * rate)).exp();
    let mut reduction = 0.0f64;
    for frame in frames {
        let level = frame[0].abs().max(frame[1].abs()).max(1e-9);
        let over = 20.0 * level.log10() - c.threshold_db;
        let wanted = if over > 0.0 {
            over * (1.0 - 1.0 / c.ratio)
        } else {
            0.0
        };
        let coefficient = if wanted > reduction { attack } else { release };
        reduction = coefficient * reduction + (1.0 - coefficient) * wanted;
        let gain = 10f64.powf((c.makeup_db - reduction) / 20.0);
        frame[0] *= gain;
        frame[1] *= gain;
    }
}

/// The index of a hit's first frame within 30 dB of its peak: where the drum is struck, after the recording's lead-in.
pub fn onset(frames: &[[f64; 2]]) -> usize {
    let peak = frames
        .iter()
        .map(|f| f[0].abs().max(f[1].abs()))
        .fold(0.0, f64::max);
    frames
        .iter()
        .position(|f| f[0].abs().max(f[1].abs()) > peak * 0.0316)
        .unwrap_or(0)
}

/// Fades the last `END_FADE_MS` of a hit to nothing.
fn fade_out(frames: &mut [[f64; 2]], rate: f64) {
    let end = frames.len();
    let fade = ((END_FADE_MS / 1000.0 * rate) as usize).clamp(1, end.max(1));
    for (i, frame) in frames.iter_mut().enumerate().skip(end.saturating_sub(fade)) {
        let t = (end - i) as f64 / fade as f64;
        let gain = 0.5 - 0.5 * (std::f64::consts::PI * t).cos();
        frame[0] *= gain;
        frame[1] *= gain;
    }
}

fn shorten(frames: &mut Vec<[f64; 2]>, e: &Envelope, rate: f64) {
    let start = onset(frames);
    let end = ((e.end_ms / 1000.0 * rate) as usize).min(frames.len());
    frames.truncate(end);
    let fade = ((END_FADE_MS / 1000.0 * rate) as usize).clamp(1, end.max(1));
    for (i, frame) in frames.iter_mut().enumerate() {
        let seconds = (i as f64 - start as f64) / rate;
        let extra = (seconds - e.hold_ms / 1000.0).max(0.0) * e.decay_db_per_second;
        let mut gain = 10f64.powf(-extra / 20.0);
        if i + fade > end {
            let t = (end - i) as f64 / fade as f64;
            gain *= 0.5 - 0.5 * (std::f64::consts::PI * t).cos();
        }
        frame[0] *= gain;
        frame[1] *= gain;
    }
}

/// One recorded hit through its profile: the companion mixed in (when the profile has one), the equaliser, the compressor, then the
/// envelope. The result keeps the sample rate and channel count of `main`.
pub fn process_hit(
    profile: &Profile,
    main: &DecodedAudio,
    companion: Option<&DecodedAudio>,
) -> Result<DecodedAudio, String> {
    let rate = main.sample_rate as f64;
    if !RATES.contains(&main.sample_rate)
        || companion.is_some_and(|c| !RATES.contains(&c.sample_rate))
    {
        return Err("A kit recording's sample rate is outside 8 to 192 kHz".into());
    }
    profile.validate()?;
    if profile.eq.iter().any(|b| b.hz >= 0.45 * rate) {
        return Err("An equaliser band is above 0.45 of the sample rate".into());
    }
    // What the envelope will cut is not worked on at all: the filters and the compressor see only the part that is kept.
    let length = profile.envelope.as_ref().map_or(main.frames.len(), |e| {
        ((e.end_ms / 1000.0 * rate) as usize).min(main.frames.len())
    });
    let mut frames: Vec<[f64; 2]> = main.frames[..length]
        .iter()
        .map(|f| [f[0] as f64, f[1] as f64])
        .collect();
    match (&profile.companion, companion) {
        (None, None) => {}
        (Some(c), Some(other)) => {
            if other.sample_rate != main.sample_rate {
                return Err("The two microphones' recordings differ in sample rate".into());
            }
            let alignment = align_companion(
                &main.frames,
                &other.frames,
                rate,
                c.max_offset_ms,
                c.min_correlation,
            )?;
            let gain = 10f64.powf(c.gain_db / 20.0);
            for (frame, second) in frames
                .iter_mut()
                .zip(moved(&other.frames, length, &alignment))
            {
                frame[0] += gain * second[0];
                frame[1] += gain * second[1];
            }
        }
        _ => return Err("A kit sound's companion recording and its profile disagree".into()),
    }
    for band in &profile.eq {
        let section = Biquad::new(band.kind, band.hz, band.db, band.q, rate);
        for index in 0..2 {
            let input: Vec<f64> = frames.iter().map(|f| f[index]).collect();
            for (frame, y) in frames.iter_mut().zip(section.run(&input)) {
                frame[index] = y;
            }
        }
    }
    if let Some(c) = &profile.compressor {
        compress(&mut frames, c, rate);
    }
    if let Some(e) = &profile.envelope {
        shorten(&mut frames, e, rate);
    } else if profile.companion.is_some() {
        // No envelope ends the hit, and the companion may run on to where the main recording stops: fade out rather than cut.
        fade_out(&mut frames, rate);
    }
    let narrow = |v: f64| if v.abs() < FLUSH { 0.0 } else { v as f32 };
    let mut out = Vec::with_capacity(frames.len());
    let mut peak = 0.0f32;
    for f in &frames {
        let (l, r) = (narrow(f[0]), narrow(f[1]));
        if !l.is_finite() || !r.is_finite() {
            return Err("Kit processing produced a value that is not a number".into());
        }
        peak = peak.max(l.abs()).max(r.abs());
        out.push([l, r]);
    }
    if peak > MAX_PROCESSED_PEAK {
        return Err(format!(
            "Kit processing made a hit peak at {peak:.1}, over the {MAX_PROCESSED_PEAK} allowed"
        ));
    }
    Ok(DecodedAudio {
        sample_rate: main.sample_rate,
        channels: main.channels,
        frames: Arc::new(out),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;

    fn sine(hz: f64, seconds: f64, amplitude: f64) -> Vec<[f32; 2]> {
        (0..(seconds * RATE) as usize)
            .map(|n| {
                let x = (std::f64::consts::TAU * hz * n as f64 / RATE).sin() * amplitude;
                [x as f32, x as f32]
            })
            .collect()
    }
    fn audio(frames: Vec<[f32; 2]>) -> DecodedAudio {
        DecodedAudio {
            sample_rate: RATE as u32,
            channels: 2,
            frames: Arc::new(frames),
        }
    }
    /// RMS of the left channel from `from` seconds.
    fn rms(frames: &[[f32; 2]], from: f64) -> f64 {
        let part = &frames[(from * RATE) as usize..];
        (part.iter().map(|f| f[0] as f64 * f[0] as f64).sum::<f64>() / part.len() as f64).sqrt()
    }
    /// A short low thump with an onset at `start` seconds: a 70 Hz burst under an exponential decay.
    fn thump(start: f64, length: f64, sign: f32) -> Vec<[f32; 2]> {
        (0..(length * RATE) as usize)
            .map(|n| {
                let t = n as f64 / RATE - start;
                let x = if t < 0.0 {
                    0.0
                } else {
                    (std::f64::consts::TAU * 70.0 * t).sin() * (-t * 30.0).exp()
                };
                [x as f32 * sign; 2]
            })
            .collect()
    }

    #[test]
    fn eq_sections_have_the_designed_response() {
        let peak = Biquad::new(EqKind::Peak, 1000.0, 6.0, 1.0, RATE);
        assert!((peak.response_db(1000.0, RATE) - 6.0).abs() < 1e-6);
        assert!(peak.response_db(100.0, RATE).abs() < 0.2);
        let cut = Biquad::new(EqKind::Peak, 400.0, -9.0, 1.4, RATE);
        assert!((cut.response_db(400.0, RATE) + 9.0).abs() < 1e-6);
        let high = Biquad::new(EqKind::Highshelf, 5000.0, 4.0, 0.7, RATE);
        assert!((high.response_db(20_000.0, RATE) - 4.0).abs() < 0.3);
        assert!(high.response_db(100.0, RATE).abs() < 0.05);
        let low = Biquad::new(EqKind::Lowshelf, 200.0, -5.0, 0.7, RATE);
        assert!((low.response_db(30.0, RATE) + 5.0).abs() < 0.3);
        assert!(low.response_db(8000.0, RATE).abs() < 0.05);
        // A high-pass at its corner is 3 dB down with the Butterworth Q, and a low-pass passes what is under it.
        let hp = Biquad::new(
            EqKind::Highpass,
            100.0,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
            RATE,
        );
        assert!((hp.response_db(100.0, RATE) + 3.01).abs() < 0.05);
        assert!(hp.response_db(10.0, RATE) < -35.0);
        assert!(hp.response_db(2000.0, RATE).abs() < 0.01);
        let lp = Biquad::new(
            EqKind::Lowpass,
            5000.0,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
            RATE,
        );
        assert!((lp.response_db(5000.0, RATE) + 3.01).abs() < 0.05);
        assert!(lp.response_db(100.0, RATE).abs() < 0.01);
    }

    #[test]
    fn processing_a_sine_through_the_equaliser_matches_the_response() {
        for (kind, hz, db, probe) in [
            (EqKind::Peak, 2000.0, 8.0, 2000.0),
            (EqKind::Peak, 2000.0, 8.0, 500.0),
            (EqKind::Highpass, 300.0, 0.0, 150.0),
            (EqKind::Highshelf, 6000.0, -6.0, 12_000.0),
        ] {
            let band = EqBand {
                kind,
                hz,
                db,
                q: 1.0,
            };
            let profile = Profile {
                eq: vec![band.clone()],
                ..Profile::default()
            };
            let input = sine(probe, 1.0, 0.25);
            let out = process_hit(&profile, &audio(input.clone()), None).unwrap();
            // The second half, past the filter's settling.
            let measured = 20.0 * (rms(&out.frames, 0.5) / rms(&input, 0.5)).log10();
            let expected = Biquad::new(kind, hz, db, band.q, RATE).response_db(probe, RATE);
            assert!(
                (measured - expected).abs() < 0.1,
                "{kind:?} at {probe} Hz: measured {measured:.2} dB, designed {expected:.2} dB"
            );
        }
    }

    #[test]
    fn the_envelope_shortens_the_tail_and_ends_the_hit() {
        let frames: Vec<[f32; 2]> = (0..RATE as usize * 2)
            .map(|n| {
                let t = n as f64 / RATE;
                let x = if n < 480 {
                    0.0
                } else {
                    0.5 * (std::f64::consts::TAU * 200.0 * t).sin()
                };
                [x as f32; 2]
            })
            .collect();
        let profile = Profile {
            envelope: Some(Envelope {
                hold_ms: 100.0,
                decay_db_per_second: 200.0,
                end_ms: 500.0,
            }),
            ..Profile::default()
        };
        let out = process_hit(&profile, &audio(frames.clone()), None).unwrap();
        // Ends at 500 ms.
        assert_eq!(out.frames.len(), 24_000);
        // Before the hold nothing changes; the hold runs 100 ms from the onset (10 ms in), so at 202 ms the level is 18.4 dB
        // down (200 dB/s over 92 ms).
        let peak = |a: &[[f32; 2]], from: f64, to: f64| {
            a[(from * RATE) as usize..(to * RATE) as usize]
                .iter()
                .map(|f| f[0].abs())
                .fold(0.0, f32::max) as f64
        };
        assert!((peak(&out.frames, 0.05, 0.09) / peak(&frames, 0.05, 0.09) - 1.0).abs() < 1e-3);
        let down = 20.0 * (peak(&out.frames, 0.2, 0.2025) / peak(&frames, 0.2, 0.2025)).log10();
        assert!((down + 18.4).abs() < 1.0, "{down}");
        // The last frame is silent: the fade reaches zero.
        assert!(out.frames[23_999][0].abs() < 1e-4);
        assert!(out.frames.iter().all(|f| f[0].is_finite()));
    }

    #[test]
    fn the_compressor_lowers_loud_parts_by_the_ratio_and_leaves_quiet_ones() {
        let profile = Profile {
            compressor: Some(Compressor {
                threshold_db: -20.0,
                ratio: 4.0,
                attack_ms: 1.0,
                release_ms: 50.0,
                makeup_db: 0.0,
            }),
            ..Profile::default()
        };
        // A steady tone at -6 dBFS is 14 dB over: 10.5 dB of reduction by the static curve, to -16.5 dBFS; the detector follows
        // the waveform, so it lands within a dB of that.
        let loud = process_hit(&profile, &audio(sine(300.0, 1.0, 0.5)), None).unwrap();
        let peak = loud.frames[(0.8 * RATE) as usize..]
            .iter()
            .map(|f| f[0].abs())
            .fold(0.0, f32::max) as f64;
        assert!(
            (20.0 * peak.log10() + 16.5).abs() < 1.0,
            "{}",
            20.0 * peak.log10()
        );
        // A tone at -30 dBFS is under the threshold and comes out unchanged.
        let quiet_in = sine(300.0, 1.0, 0.0316);
        let quiet = process_hit(&profile, &audio(quiet_in.clone()), None).unwrap();
        assert!((rms(&quiet.frames, 0.5) / rms(&quiet_in, 0.5) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn two_microphones_are_aligned_in_time_and_polarity_before_they_are_mixed() {
        // The same thump 3.2 ms later on the second microphone, and with it inverted.
        let main = thump(0.004, 0.4, 1.0);
        for sign in [1.0f32, -1.0] {
            let second = thump(0.004 + 0.0032, 0.4, sign);
            let found = align_companion(&main, &second, RATE, 8.0, 0.5).unwrap();
            // 3.2 ms is 153.6 frames: the second must move 154 frames earlier.
            assert!((found.lag - 154).abs() <= 1, "lag {}", found.lag);
            assert_eq!(found.sign, sign as f64);
            assert!(found.correlation > 0.97, "{}", found.correlation);
            // The right cycle and polarity stand clear of every other alignment.
            assert!(found.margin > 0.1, "margin {}", found.margin);
        }
        // Mixed: aligned and in phase the two add (+6 dB for equal levels); summed blindly the inverted one would cancel.
        let profile = Profile {
            companion: Some(Companion {
                gain_db: 0.0,
                max_offset_ms: 8.0,
                min_correlation: 0.5,
            }),
            ..Profile::default()
        };
        let inverted = audio(thump(0.0072, 0.4, -1.0));
        let mixed = process_hit(&profile, &audio(main.clone()), Some(&inverted)).unwrap();
        let alone = rms(&main, 0.0);
        assert!(
            rms(&mixed.frames, 0.0) / alone > 1.9,
            "aligned mix {} of one microphone's {}",
            rms(&mixed.frames, 0.0),
            alone
        );
        let blind: f64 = main
            .iter()
            .zip(inverted.frames.iter())
            .map(|(a, b)| (a[0] + b[0]) as f64 * (a[0] + b[0]) as f64)
            .sum::<f64>()
            / main.len() as f64;
        assert!(
            blind.sqrt() < 0.8 * rms(&mixed.frames, 0.0),
            "summed blindly the inverted microphone costs level"
        );
    }

    #[test]
    fn microphones_that_do_not_match_are_rejected() {
        // A 70 Hz thump against a 3 kHz tone burst: nothing in common in the low band.
        let main = thump(0.004, 0.4, 1.0);
        let other: Vec<[f32; 2]> = (0..(0.4 * RATE) as usize)
            .map(|n| {
                let t = n as f64 / RATE;
                let x = (std::f64::consts::TAU * 3000.0 * t).sin() * (-t * 40.0).exp();
                [x as f32; 2]
            })
            .collect();
        assert!(align_companion(&main, &other, RATE, 8.0, 0.5).is_err());
        let silent = vec![[0.0f32; 2]; 4800];
        assert!(align_companion(&main, &silent, RATE, 8.0, 0.5).is_err());
        // A profile that wants a companion and gets none, or the reverse, is refused.
        let wants = Profile {
            companion: Some(Companion {
                gain_db: 0.0,
                max_offset_ms: 8.0,
                min_correlation: 0.5,
            }),
            ..Profile::default()
        };
        assert!(process_hit(&wants, &audio(main.clone()), None).is_err());
        assert!(
            process_hit(
                &Profile::default(),
                &audio(main.clone()),
                Some(&audio(main))
            )
            .is_err()
        );
    }

    #[test]
    fn a_table_is_validated_strictly() {
        let good = r#"{"profiles":{"kick":{"eq":[{"kind":"peak","hz":400,"db":-6,"q":1.2}],"envelope":{"holdMs":50,"decayDbPerSecond":200,"endMs":300}}},"sounds":{"36":"kick"}}"#;
        let table: KitProcessing = serde_json::from_str(good).unwrap();
        table.validate().unwrap();
        let bad = [
            // unknown field, unknown kind, unknown profile for a sound, a key out of range, a name with capitals
            r#"{"profiles":{"a":{"gain":1}}}"#,
            r#"{"profiles":{"a":{"eq":[{"kind":"notch","hz":400,"q":1}]}}}"#,
            r#"{"profiles":{"a":{}},"sounds":{"36":"b"}}"#,
            r#"{"profiles":{"a":{}},"sounds":{"200":"a"}}"#,
            r#"{"profiles":{"a":{}},"sounds":{"x":"a"}}"#,
            r#"{"profiles":{"Kick":{}}}"#,
            // numbers out of range
            r#"{"profiles":{"a":{"eq":[{"kind":"peak","hz":10,"db":1,"q":1}]}}}"#,
            r#"{"profiles":{"a":{"eq":[{"kind":"peak","hz":400,"db":40,"q":1}]}}}"#,
            r#"{"profiles":{"a":{"eq":[{"kind":"highpass","hz":400,"db":3,"q":1}]}}}"#,
            r#"{"profiles":{"a":{"envelope":{"holdMs":0,"decayDbPerSecond":0,"endMs":1000000}}}}"#,
            r#"{"profiles":{"a":{"compressor":{"thresholdDb":-20,"ratio":0.5,"attackMs":1,"releaseMs":50,"makeupDb":0}}}}"#,
            r#"{"profiles":{"a":{"companion":{"gainDb":0,"maxOffsetMs":50,"minCorrelation":0.5}}}}"#,
        ];
        for text in bad {
            let rejected = serde_json::from_str::<KitProcessing>(text)
                .map_err(|e| e.to_string())
                .and_then(|t| t.validate());
            assert!(rejected.is_err(), "accepted {text}");
        }
        // Too many bands, too many profiles.
        let many_bands = format!(
            r#"{{"profiles":{{"a":{{"eq":[{}]}}}}}}"#,
            vec![r#"{"kind":"peak","hz":400,"db":1,"q":1}"#; MAX_EQ_BANDS + 1].join(",")
        );
        assert!(
            serde_json::from_str::<KitProcessing>(&many_bands)
                .unwrap()
                .validate()
                .is_err()
        );
        let profiles: BTreeMap<String, Profile> = (0..MAX_PROFILES + 1)
            .map(|i| (format!("p{i}"), Profile::default()))
            .collect();
        assert!(
            KitProcessing {
                profiles,
                sounds: BTreeMap::new()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn sample_rates_outside_the_supported_range_are_refused() {
        for rate in [4_000u32, 200_000] {
            let audio = DecodedAudio {
                sample_rate: rate,
                channels: 2,
                frames: Arc::new(vec![[0.1, 0.1]; 4800]),
            };
            let error = process_hit(&Profile::default(), &audio, None)
                .err()
                .unwrap();
            assert!(error.contains("sample rate"), "{error}");
        }
        // The alignment's low-pass has to sit well under half the rate.
        let hit = thump(0.004, 0.4, 1.0);
        assert!(align_companion(&hit, &hit, 400.0, 8.0, 0.5).is_err());
        assert!(align_companion(&hit, &hit, 48_000.0, 8.0, 0.5).is_ok());
    }

    #[test]
    fn no_subnormal_value_reaches_a_processed_buffer() {
        // A tail falling 2000 dB a second passes through the subnormal range of a float on its way to nothing.
        let profile = Profile {
            envelope: Some(Envelope {
                hold_ms: 0.0,
                decay_db_per_second: 2000.0,
                end_ms: 1400.0,
            }),
            ..Profile::default()
        };
        let out = process_hit(&profile, &audio(sine(200.0, 1.5, 0.5)), None).unwrap();
        assert!(out.frames.iter().any(|f| f[0] != 0.0));
        assert!(
            out.frames
                .iter()
                .flatten()
                .all(|v| *v == 0.0 || v.abs() >= 1e-30),
            "a value under 1e-30 survived"
        );
        assert!(out.frames[(0.5 * RATE) as usize][0] == 0.0);
    }

    #[test]
    fn a_result_over_the_peak_ceiling_is_refused() {
        let loud = Profile {
            compressor: Some(Compressor {
                threshold_db: 0.0,
                ratio: 1.0,
                attack_ms: 1.0,
                release_ms: 50.0,
                makeup_db: 24.0,
            }),
            ..Profile::default()
        };
        // 0.9 at +24 dB is 14: over the ceiling of 8. At +12 dB it is 3.6.
        let error = process_hit(&loud, &audio(sine(300.0, 0.2, 0.9)), None)
            .err()
            .unwrap();
        assert!(error.contains("peak"), "{error}");
        let fine = Profile {
            compressor: Some(Compressor {
                makeup_db: 12.0,
                ..loud.compressor.clone().unwrap()
            }),
            ..loud
        };
        assert!(process_hit(&fine, &audio(sine(300.0, 0.2, 0.9)), None).is_ok());
    }

    #[test]
    fn a_companion_without_an_envelope_is_faded_where_the_main_recording_ends() {
        // Both run on at full level to the end of the main recording; the mix must not stop dead there.
        let steady = sine(70.0, 0.4, 0.5);
        let profile = Profile {
            companion: Some(Companion {
                gain_db: 0.0,
                max_offset_ms: 8.0,
                min_correlation: 0.5,
            }),
            ..Profile::default()
        };
        let faded = process_hit(
            &profile,
            &audio(steady.clone()),
            Some(&audio(steady.clone())),
        )
        .unwrap();
        let n = faded.frames.len();
        assert_eq!(n, steady.len());
        assert!(
            faded.frames[n - 1][0].abs() < 1e-3,
            "{}",
            faded.frames[n - 1][0]
        );
        let before = faded.frames[n - (0.03 * RATE) as usize..n - (0.02 * RATE) as usize]
            .iter()
            .map(|f| f[0].abs())
            .fold(0.0, f32::max);
        assert!(before > 0.5, "{before}");
        // With no companion the recording is left as it is.
        let plain = process_hit(&Profile::default(), &audio(steady.clone()), None).unwrap();
        assert_eq!(plain.frames[..], steady[..]);
    }

    #[test]
    fn processing_is_deterministic() {
        let profile = Profile {
            companion: None,
            eq: vec![EqBand {
                kind: EqKind::Peak,
                hz: 800.0,
                db: 5.0,
                q: 1.0,
            }],
            compressor: Some(Compressor {
                threshold_db: -30.0,
                ratio: 3.0,
                attack_ms: 2.0,
                release_ms: 80.0,
                makeup_db: 3.0,
            }),
            envelope: Some(Envelope {
                hold_ms: 50.0,
                decay_db_per_second: 100.0,
                end_ms: 800.0,
            }),
        };
        let input = audio(thump(0.004, 1.0, 1.0));
        let (a, b) = (
            process_hit(&profile, &input, None).unwrap(),
            process_hit(&profile, &input, None).unwrap(),
        );
        assert_eq!(a.frames, b.frames);
    }
}
