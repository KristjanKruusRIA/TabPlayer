//! THE-212: the backing stretcher keeps low bass. One fixed scorecard, measured on `BackingVoice` alone (no device, no
//! transport) with synthetic signals generated here, at the practice speeds 50, 60, 75 and 90%. Nobody has listened to
//! any of this; every number is a headless measurement at 48 kHz. The rows:
//! (a) low-band (30-150 Hz) power of the output against the unstretched source, per signal;
//! (b) flutter of a sustained low sine and of a two-sine low pair (slow amplitude swing, and energy off the tones);
//! (c) transients: attack time, pre-echo and onset error of a kick-like burst, in the full band and the low band;
//! (d) mid and high band power and spectral flatness of noise;
//! (e) alignment against the score clock;
//! (f) stereo: proportional channels stay proportional, inter-channel coherence and phase, mono sum;
//! (g) CPU (release profile, `cost_of_a_second_of_audio`).
use std::sync::Arc;
use tabplayer_lib::{
    audio::{
        backing::{BackingMap, BackingVoice},
        decode::DecodedAudio,
        plan::PlaybackPlan,
    },
    settings::{BackingFilter, BackingProcessing},
};

const RATE: u32 = 48_000;
const SR: f64 = 48_000.0;
const TAU: f64 = std::f64::consts::TAU;
/// The practice speeds of the scorecard.
const SPEEDS: [f64; 4] = [0.5, 0.6, 0.75, 0.9];

fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":6000,"tracks":[{"id":"guitar","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120},{"tick":3840,"bpm":60}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":6000}],"notes":[],"midi":[]})).unwrap()
}

fn voice(frames: Vec<[f32; 2]>, shift: i8) -> BackingVoice {
    BackingVoice::new_with_processing_shifted(
        Arc::new(DecodedAudio {
            sample_rate: RATE,
            channels: 2,
            frames: Arc::new(frames),
        }),
        BackingMap::new(&[], 0.0, &plan()).unwrap(),
        RATE,
        BackingProcessing {
            semitones: 0.0,
            cents: 0.0,
            filter: BackingFilter::None,
        },
        shift,
    )
    .unwrap()
}

/// `frames` output frames with the score clock running at `speed`, from a seek to 0, the way the renderer drives it.
fn run_stereo(source: &[[f32; 2]], speed: f64, shift: i8, frames: usize) -> Vec<[f64; 2]> {
    let mut voice = voice(source.to_vec(), shift);
    voice.seek(0.0);
    (0..frames)
        .map(|n| {
            let x = voice.next_frame(n as f64 * speed / SR);
            [f64::from(x[0]), f64::from(x[1])]
        })
        .collect()
}

fn run(source: &[f32], speed: f64, shift: i8, frames: usize) -> Vec<f64> {
    let stereo: Vec<[f32; 2]> = source.iter().map(|&x| [x, x]).collect();
    run_stereo(&stereo, speed, shift, frames)
        .iter()
        .map(|x| x[0])
        .collect()
}

fn mono(x: &[f64]) -> Vec<f32> {
    x.iter().map(|&v| v as f32).collect()
}

fn left(x: &[[f64; 2]]) -> Vec<f64> {
    x.iter().map(|v| v[0]).collect()
}

fn right(x: &[[f64; 2]]) -> Vec<f64> {
    x.iter().map(|v| v[1]).collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// Signals. Integer noise, exact constants; `sin` only where a tone is the point.

struct Noise(u32);
impl Noise {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        f64::from(self.0) / f64::from(u32::MAX) * 2.0 - 1.0
    }
}

fn tones(freqs: &[(f64, f64)], frames: usize) -> Vec<f64> {
    (0..frames)
        .map(|n| {
            freqs
                .iter()
                .map(|(f, a)| a * (TAU * f * n as f64 / SR).sin())
                .sum()
        })
        .collect()
}

/// A bass-guitar-like line: E1, A1, D2, E1, a note every half second, six harmonics (1/h) that die away faster the
/// higher they are, a 4 ms attack, each note ringing into the next.
fn bass_notes(frames: usize) -> Vec<f64> {
    let mut x = vec![0.0; frames];
    let note_len = 24_000;
    for (i, start) in (0..frames).step_by(note_len).enumerate() {
        let f = [41.2, 55.0, 73.4, 41.2][i % 4];
        for n in 0..(note_len * 2).min(frames - start) {
            let t = n as f64 / SR;
            let attack = (t / 0.004).min(1.0);
            // The previous note is damped when the next starts (a player's hand), over 30 ms.
            let damp = if n >= note_len {
                (-((n - note_len) as f64 / SR) / 0.03).exp()
            } else {
                1.0
            };
            let v: f64 = (1..=6)
                .map(|h| {
                    let h = f64::from(h);
                    (TAU * f * h * t).sin() * (0.35 / h) * (-t * (1.5 + 0.8 * h)).exp()
                })
                .sum();
            x[start + n] += v * attack * damp;
        }
    }
    x
}

/// A kick: a sine sweep from 120 to 45 Hz (1 ms attack, 80 ms decay) with a 2 ms beater click of noise on top.
fn kick(seed: u32) -> Vec<f64> {
    let mut phase = 0.0f64;
    let mut noise = Noise(seed);
    (0..9_000)
        .map(|n| {
            let t = n as f64 / SR;
            phase += TAU * (45.0 + 75.0 * (-t / 0.02).exp()) / SR;
            let body = 0.7 * (t / 0.001).min(1.0) * (-t / 0.08).exp() * phase.sin();
            let click = 0.25 * noise.next() * (-t / 0.0007).exp();
            body + click
        })
        .collect()
}

const KICK_SPACING: usize = 16_000;
const KICK_FIRST: usize = 24_000;

/// Kicks every `KICK_SPACING` frames from `KICK_FIRST`, over `bed` (a sustained low sine of that amplitude at 55 Hz, or
/// silence); the onsets in source frames.
fn kicks(count: usize, bed: f64) -> (Vec<f64>, Vec<usize>) {
    let frames = KICK_FIRST + (count + 2) * KICK_SPACING;
    let mut x = tones(&[(55.0, bed)], frames);
    let onsets: Vec<usize> = (0..count).map(|i| KICK_FIRST + i * KICK_SPACING).collect();
    for (i, &at) in onsets.iter().enumerate() {
        for (n, v) in kick(0x0BAD_CAFE + i as u32).iter().enumerate() {
            x[at + n] += v;
        }
    }
    (x, onsets)
}

/// A Karplus-Strong pluck at `freq`, `len` frames, from a fixed noise seed.
fn pluck(freq: f64, len: usize, seed: u32) -> Vec<f64> {
    let n = (SR / freq).round() as usize;
    let mut noise = Noise(seed);
    let mut line: Vec<f64> = (0..n).map(|_| noise.next() * 0.5).collect();
    let mut at = 0;
    (0..len)
        .map(|_| {
            let out = line[at];
            let next = line[(at + 1) % n];
            line[at] = 0.5 * 0.998 * (out + next);
            at = (at + 1) % n;
            out
        })
        .collect()
}

/// Eight drum hits (decaying noise) or plucks of 82.4 Hz, 12,000 frames apart from 24,000.
fn hits(drum: bool) -> (Vec<f64>, Vec<usize>) {
    let count = 8;
    let spacing = 12_000;
    let first = 24_000;
    let mut x = vec![0.0; first + (count + 3) * spacing];
    let onsets: Vec<usize> = (0..count).map(|i| first + i * spacing).collect();
    for (i, &at) in onsets.iter().enumerate() {
        let hit: Vec<f64> = if drum {
            let mut noise = Noise(0x0BAD_CAFE + i as u32);
            (0..4_000)
                .map(|n| noise.next() * 0.7 * (-(n as f64) / 720.0).exp())
                .collect()
        } else {
            pluck(82.4, 9_000, 0x1357_9BDF + i as u32)
        };
        for (n, v) in hit.iter().enumerate() {
            x[at + n] += v * 0.6;
        }
    }
    (x, onsets)
}

fn white(frames: usize, seed: u32, level: f64) -> Vec<f64> {
    let mut noise = Noise(seed);
    (0..frames).map(|_| noise.next() * level).collect()
}

/// Everything at once: the bass line, a kick on every beat, a guitar-like chord and a little hiss.
fn mix(frames: usize) -> Vec<f64> {
    let bass = bass_notes(frames);
    let chord = tones(
        &[(196.0, 0.06), (293.7, 0.05), (392.0, 0.04), (587.3, 0.03)],
        frames,
    );
    let hiss = white(frames, 0x2545_F491, 0.02);
    let mut x: Vec<f64> = (0..frames).map(|n| bass[n] + chord[n] + hiss[n]).collect();
    for (i, at) in (2_000..frames.saturating_sub(9_000))
        .step_by(24_000)
        .enumerate()
    {
        for (n, v) in kick(0x5EED + i as u32).iter().enumerate() {
            x[at + n] += v * 0.8;
        }
    }
    x
}

// ---------------------------------------------------------------------------------------------------------------------
// Analysis.

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
        let angle = -TAU / len as f64;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (s, c) = (angle * k as f64).sin_cos();
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * c - im[b] * s, re[b] * s + im[b] * c);
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

/// Power per frame of `x` between `f1` and `f2` Hz: one transform over the whole span (ends tapered over 10 ms),
/// Parseval's sum of the bins in the band.
fn band_power(x: &[f64], f1: f64, f2: f64) -> f64 {
    let n = x.len().next_power_of_two();
    let taper = 480.min(x.len() / 4);
    let mut re: Vec<f64> = x
        .iter()
        .enumerate()
        .map(|(i, &v)| {
            let edge = i.min(x.len() - 1 - i);
            if edge < taper {
                v * (0.5 - 0.5 * (std::f64::consts::PI * edge as f64 / taper as f64).cos())
            } else {
                v
            }
        })
        .collect();
    re.resize(n, 0.0);
    let mut im = vec![0.0; n];
    fft(&mut re, &mut im);
    let bin = SR / n as f64;
    let energy: f64 = (1..n / 2)
        .filter(|&k| (f1..f2).contains(&(k as f64 * bin)))
        .map(|k| 2.0 * (re[k] * re[k] + im[k] * im[k]))
        .sum::<f64>()
        / n as f64;
    energy / x.len() as f64
}

fn db(ratio: f64) -> f64 {
    10.0 * ratio.max(1e-30).log10()
}

/// Welch power spectrum (Hann, 8192, half overlap): one value per bin.
fn welch(x: &[f64]) -> Vec<f64> {
    let n = 8192;
    let w: Vec<f64> = (0..n)
        .map(|i| 0.5 - 0.5 * (TAU * i as f64 / n as f64).cos())
        .collect();
    let mut sum = vec![0.0; n / 2];
    let mut count = 0;
    let mut at = 0;
    while at + n <= x.len() {
        let mut re: Vec<f64> = (0..n).map(|i| x[at + i] * w[i]).collect();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im);
        for k in 0..n / 2 {
            sum[k] += re[k] * re[k] + im[k] * im[k];
        }
        count += 1;
        at += n / 2;
    }
    sum.iter().map(|v| v / count as f64).collect()
}

/// Spectral flatness (geometric over arithmetic mean of the Welch spectrum) between `f1` and `f2` Hz, in dB.
fn flatness(x: &[f64], f1: f64, f2: f64) -> f64 {
    let psd = welch(x);
    let bin = SR / 8192.0;
    let band: Vec<f64> = (1..psd.len())
        .filter(|&k| (f1..f2).contains(&(k as f64 * bin)))
        .map(|k| psd[k].max(1e-30))
        .collect();
    let geo = band.iter().map(|v| v.ln()).sum::<f64>() / band.len() as f64;
    let arith = band.iter().sum::<f64>() / band.len() as f64;
    10.0 * (geo.exp() / arith).log10()
}

/// Magnitude-squared coherence of `a` and `b`, power-weighted over `f1`..`f2` Hz (Welch, Hann 8192, half overlap).
fn coherence(a: &[f64], b: &[f64], f1: f64, f2: f64) -> f64 {
    let n = 8192;
    let w: Vec<f64> = (0..n)
        .map(|i| 0.5 - 0.5 * (TAU * i as f64 / n as f64).cos())
        .collect();
    let (mut saa, mut sbb, mut sab_re, mut sab_im) = (
        vec![0.0; n / 2],
        vec![0.0; n / 2],
        vec![0.0; n / 2],
        vec![0.0; n / 2],
    );
    let mut at = 0;
    while at + n <= a.len().min(b.len()) {
        let mut ar: Vec<f64> = (0..n).map(|i| a[at + i] * w[i]).collect();
        let mut ai = vec![0.0; n];
        let mut br: Vec<f64> = (0..n).map(|i| b[at + i] * w[i]).collect();
        let mut bi = vec![0.0; n];
        fft(&mut ar, &mut ai);
        fft(&mut br, &mut bi);
        for k in 0..n / 2 {
            saa[k] += ar[k] * ar[k] + ai[k] * ai[k];
            sbb[k] += br[k] * br[k] + bi[k] * bi[k];
            sab_re[k] += ar[k] * br[k] + ai[k] * bi[k];
            sab_im[k] += ai[k] * br[k] - ar[k] * bi[k];
        }
        at += n / 2;
    }
    let bin = SR / n as f64;
    let (mut num, mut den) = (0.0, 0.0);
    for k in 1..n / 2 {
        if (f1..f2).contains(&(k as f64 * bin)) {
            let weight = saa[k] + sbb[k];
            let msc =
                (sab_re[k] * sab_re[k] + sab_im[k] * sab_im[k]) / (saa[k] * sbb[k]).max(1e-30);
            num += weight * msc;
            den += weight;
        }
    }
    num / den.max(1e-30)
}

/// Hann-weighted least-squares fit of sines and cosines at `freqs` (Hz, of the output): each tone's complex amplitude
/// (cos, sin coefficients) and the share of the windowed energy outside the tones.
fn fit(x: &[f64], freqs: &[f64]) -> (Vec<(f64, f64)>, f64) {
    let n = x.len();
    let w: Vec<f64> = (0..n)
        .map(|i| 0.5 - 0.5 * (TAU * (i as f64 + 0.5) / n as f64).cos())
        .collect();
    let columns: Vec<Vec<f64>> = freqs
        .iter()
        .flat_map(|&f| {
            [
                (0..n).map(|i| (TAU * f * i as f64 / SR).cos()).collect(),
                (0..n).map(|i| (TAU * f * i as f64 / SR).sin()).collect(),
            ]
        })
        .collect();
    let coefficients = solve(&columns, &w, x);
    let total: f64 = (0..n).map(|t| w[t] * w[t] * x[t] * x[t]).sum();
    let residual: f64 = (0..n)
        .map(|t| {
            let model: f64 = (0..columns.len())
                .map(|i| coefficients[i] * columns[i][t])
                .sum();
            w[t] * w[t] * (x[t] - model).powi(2)
        })
        .sum();
    (
        (0..freqs.len())
            .map(|i| (coefficients[2 * i], coefficients[2 * i + 1]))
            .collect(),
        residual / total.max(1e-30),
    )
}

/// Weighted least squares: the coefficients of `columns` that fit `x` best with weights `w` squared.
fn solve(columns: &[Vec<f64>], w: &[f64], x: &[f64]) -> Vec<f64> {
    let k = columns.len();
    let n = x.len();
    let mut a = vec![vec![0.0; k + 1]; k];
    for i in 0..k {
        for j in 0..k {
            a[i][j] = (0..n)
                .map(|t| w[t] * w[t] * columns[i][t] * columns[j][t])
                .sum();
        }
        a[i][k] = (0..n).map(|t| w[t] * w[t] * columns[i][t] * x[t]).sum();
    }
    for col in 0..k {
        let pivot = (col..k)
            .max_by(|&p, &q| a[p][col].abs().total_cmp(&a[q][col].abs()))
            .unwrap();
        a.swap(col, pivot);
        for row in 0..k {
            if row != col {
                let factor = a[row][col] / a[col][col];
                for c in col..=k {
                    a[row][c] -= factor * a[col][c];
                }
            }
        }
    }
    (0..k).map(|i| a[i][k] / a[i][i]).collect()
}

/// The frequency near `nominal` that a single sine fits `x` best at.
fn peak(x: &[f64], nominal: f64) -> f64 {
    let mut best = (f64::INFINITY, nominal);
    let mut search = |from: f64, to: f64, step: f64, best: &mut (f64, f64)| {
        let mut f = from;
        while f <= to + 1e-9 {
            let (_, residual) = fit(x, &[f]);
            if residual < best.0 {
                *best = (residual, f);
            }
            f += step;
        }
    };
    search(nominal - 2.0, nominal + 2.0, 0.25, &mut best);
    let centre = best.1;
    search(centre - 0.25, centre + 0.25, 0.02, &mut best);
    best.1
}

/// A sustained set of tones through the stretcher: (b) the slow swing of each tone's amplitude over 100 ms windows
/// every 10 ms (largest over smallest, dB, worst tone), the worst tone's mean level error (dB), and the share of the
/// energy off the tones over 0.5 s (dB, lower is purer).
struct Steady {
    swing_db: f64,
    level_db: f64,
    off_tone_db: f64,
}

fn steady(speed: f64, shift: i8, set: &[(f64, f64)]) -> Steady {
    let skip = 9_600;
    let measured = 72_000;
    let out_frames = skip + measured;
    let source = tones(set, (out_frames as f64 * speed) as usize + 48_000);
    let out = run(&mono(&source), speed, shift, out_frames);
    let x = &out[skip..];
    let pitch = 2f64.powf(f64::from(shift) / 12.0);
    let freqs: Vec<f64> = set
        .iter()
        .map(|t| peak(&x[..24_000], t.0 * pitch))
        .collect();
    let (_, residual) = fit(&x[..24_000], &freqs);
    let window = 4_800;
    let mut amplitudes = vec![Vec::new(); set.len()];
    let mut at = 0;
    while at + window <= x.len() {
        let (c, _) = fit(&x[at..at + window], &freqs);
        for (i, (a, b)) in c.iter().enumerate() {
            amplitudes[i].push(a.hypot(*b));
        }
        at += 480;
    }
    let mut swing: f64 = 0.0;
    let mut level: f64 = 0.0;
    for (i, a) in amplitudes.iter().enumerate() {
        let max = a.iter().copied().fold(0.0, f64::max);
        let min = a.iter().copied().fold(f64::INFINITY, f64::min);
        swing = swing.max(20.0 * (max / min.max(1e-12)).log10());
        let mean = a.iter().sum::<f64>() / a.len() as f64;
        let error = 20.0 * (mean / set[i].1).log10();
        if error.abs() > level.abs() {
            level = error;
        }
    }
    Steady {
        swing_db: swing,
        level_db: level,
        off_tone_db: db(residual),
    }
}

/// (a) Low-band (30-150 Hz) power of the output over that of the source, dB, from source second 1 to `seconds`; and the
/// share of the source's low-band spectrum that the output has at the same frequencies (the sum over 5.9 Hz bins of
/// the smaller of the two Welch spectra, over the source's sum, dB): a bass moved to another pitch keeps its power in the
/// band and loses this.
fn low_band_ratio(source: &[f64], speed: f64, seconds: f64) -> (f64, f64) {
    let (from, to) = (48_000usize, (seconds * SR) as usize);
    let out = run(&mono(source), speed, 0, (to as f64 / speed) as usize + 10);
    let (a, b) = ((from as f64 / speed) as usize, (to as f64 / speed) as usize);
    let (o, s) = (&out[a..b], &source[from..to]);
    let (po, ps) = (welch(o), welch(s));
    let bin = SR / 8192.0;
    let (mut kept, mut total) = (0.0, 0.0);
    for k in 1..ps.len() {
        if (30.0..150.0).contains(&(k as f64 * bin)) {
            kept += po[k].min(ps[k]);
            total += ps[k];
        }
    }
    (
        db(band_power(o, 30.0, 150.0) / band_power(s, 30.0, 150.0)),
        db(kept / total),
    )
}

/// A causal fourth order Butterworth low-pass (`high` false) or high-pass at `hz`.
fn butter(x: &[f64], hz: f64, high: bool) -> Vec<f64> {
    let k = (std::f64::consts::PI * hz / SR).tan();
    let mut y = x.to_vec();
    for q in [0.541_196_100_146_197, 1.306_562_964_876_376_5] {
        let norm = 1.0 / (1.0 + k / q + k * k);
        let (b0, b1, b2) = if high {
            (norm, -2.0 * norm, norm)
        } else {
            (k * k * norm, 2.0 * k * k * norm, k * k * norm)
        };
        let a1 = 2.0 * (k * k - 1.0) * norm;
        let a2 = (1.0 - k / q + k * k) * norm;
        let (mut z1, mut z2) = (0.0, 0.0);
        for v in y.iter_mut() {
            let input = *v;
            let out = b0 * input + z1;
            z1 = b1 * input - a1 * out + z2;
            z2 = b2 * input - a2 * out;
            *v = out;
        }
    }
    y
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// (c) What a hit looks like after the stretcher, medians over the hits after the first two: energy of the
/// `pre` ms before the clock's onset over that of the `post` ms after it (dB, lower is cleaner), the rise of the
/// 1 ms rms envelope from 10% to 90% of its peak (ms) and where the 10% point sits against the clock's onset plus
/// the source's own (ms, negative is early). `band`: none (full band), Some((hz, false)) a low-pass, Some((hz,
/// true)) a high-pass, applied to the source and the output alike.
struct Hit {
    pre_echo_db: f64,
    attack_ms: f64,
    lag_ms: f64,
}

fn hit(
    source: &[f64],
    onsets: &[usize],
    speed: f64,
    shift: i8,
    band: Option<(f64, bool)>,
    pre: usize,
    post: usize,
) -> Hit {
    let out_frames = ((onsets[onsets.len() - 1] + 12_000) as f64 / speed) as usize;
    let out = run(&mono(source), speed, shift, out_frames);
    let filter = |x: &[f64]| match band {
        None => x.to_vec(),
        Some((hz, high)) => butter(x, hz, high),
    };
    let (out, src) = (filter(&out), filter(source));
    let envelope =
        |x: &[f64], n: usize| (x[n - 47..=n].iter().map(|v| v * v).sum::<f64>() / 48.0).sqrt();
    let cross = |x: &[f64], from: usize, to: usize| {
        let top = (from..to).map(|n| envelope(x, n)).fold(0.0, f64::max);
        let at = |level: f64| {
            (from..to)
                .find(|&n| envelope(x, n) >= level * top)
                .unwrap_or(to)
        };
        (at(0.1), at(0.9))
    };
    let (mut pre_echo, mut attack, mut lag) = (Vec::new(), Vec::new(), Vec::new());
    for &onset in &onsets[2..] {
        let at = (onset as f64 / speed).round() as usize;
        let energy = |a: usize, b: usize| out[a..b].iter().map(|v| v * v).sum::<f64>();
        pre_echo.push(db(
            energy(at - pre * 48, at - 24) / energy(at, at + post * 48).max(1e-30)
        ));
        let (low, high) = cross(&out, at - 1_440, at + 4_800);
        let (src_low, _) = cross(&src, onset - 1_440, onset + 4_800);
        attack.push((high - low) as f64 / 48.0);
        lag.push(((low as f64 - at as f64) - (src_low as f64 - onset as f64)) / 48.0);
    }
    Hit {
        pre_echo_db: median(pre_echo),
        attack_ms: median(attack),
        lag_ms: median(lag),
    }
}

/// (e) Where Hann-windowed bursts sit against the score clock: the energy centroid of each in the output against
/// where the clock puts it, in ms (negative: early). `carrier` Hz, 0 for noise; `length` frames.
fn burst_errors(speed: f64, carrier: f64, length: usize, count: usize) -> Vec<f64> {
    let spacing = (length * 3).max(6_000);
    let first = 2 * spacing;
    let mut source = vec![0.0f64; first + (count + 2) * spacing];
    let mut noise = Noise(0x1234_5678);
    let centres: Vec<usize> = (0..count).map(|i| first + i * spacing).collect();
    for &centre in &centres {
        for n in 0..length {
            let w = 0.5 - 0.5 * (TAU * n as f64 / length as f64).cos();
            let c = if carrier == 0.0 {
                noise.next()
            } else {
                (TAU * carrier * n as f64 / SR).sin()
            };
            source[centre - length / 2 + n] = c * w * 0.5;
        }
    }
    let out_frames = ((first + (count + 1) * spacing) as f64 / speed) as usize;
    let out = run(&mono(&source), speed, 0, out_frames);
    centres
        .iter()
        .map(|&centre| {
            let expected = centre as f64 / speed;
            let half = (1.5625 * length as f64 / speed) as usize;
            let (from, to) = (
                (expected as usize).saturating_sub(half),
                ((expected as usize) + half).min(out.len()),
            );
            let (mut sum, mut weight) = (0.0, 0.0);
            for (n, x) in out.iter().enumerate().take(to).skip(from) {
                sum += x * x * n as f64;
                weight += x * x;
            }
            (sum / weight - expected) * speed / 48.0
        })
        .collect()
}

fn worst(v: &[f64]) -> f64 {
    v.iter()
        .copied()
        .fold(0.0, |a: f64, b| if b.abs() > a.abs() { b } else { a })
}

/// (f) A stereo source: a low pair the same in both channels (the right 0.9 of the left) and noise that is correlated
/// 0.6 between them; plus a 55 Hz tone whose right channel lags the left by 60 degrees.
fn stereo_source(frames: usize) -> Vec<[f32; 2]> {
    let pair = tones(&[(55.0, 0.25), (82.4, 0.2)], frames);
    let (n1, n3) = (white(frames, 0xACE1, 0.1), white(frames, 0xBEEF, 0.1));
    (0..frames)
        .map(|n| {
            [
                (pair[n] + n1[n]) as f32,
                (0.9 * pair[n] + 0.6 * n1[n] + 0.8 * n3[n]) as f32,
            ]
        })
        .collect()
}

fn phase_source(frames: usize) -> Vec<[f32; 2]> {
    (0..frames)
        .map(|n| {
            let t = n as f64 / SR;
            [
                (0.3 * (TAU * 55.0 * t).sin()) as f32,
                (0.3 * (TAU * 55.0 * t - 60f64.to_radians()).sin()) as f32,
            ]
        })
        .collect()
}

struct Stereo {
    /// The largest |right - 0.5 left| of a source whose right channel is half its left.
    proportional_error: f64,
    low_coherence: f64,
    mid_coherence: f64,
    /// Low-band power of (L + R) / 2 over the mean of L's and R's, dB.
    low_mono_db: f64,
    /// Inter-channel phase of the 55 Hz tone against the source's 60 degrees.
    phase_error_deg: f64,
}

fn stereo(speed: f64, shift: i8) -> Stereo {
    // Proportional channels: a busy mono source with the right channel exactly half the left.
    let m = mix(96_000);
    let proportional: Vec<[f32; 2]> = m.iter().map(|&v| [v as f32, (v * 0.5) as f32]).collect();
    let out = run_stereo(&proportional, speed, shift, 120_000);
    let proportional_error = out
        .iter()
        .map(|x| (x[1] - 0.5 * x[0]).abs())
        .fold(0.0, f64::max);
    let frames = 240_000;
    let source = stereo_source(frames);
    let out_frames = ((frames - 24_000) as f64 / speed) as usize;
    let out = run_stereo(&source, speed, shift, out_frames);
    let skip = 24_000;
    let (l, r) = (left(&out[skip..]), right(&out[skip..]));
    let low_mono = {
        let sum: Vec<f64> = l.iter().zip(&r).map(|(a, b)| 0.5 * (a + b)).collect();
        db(band_power(&sum, 30.0, 150.0)
            / (0.5 * (band_power(&l, 30.0, 150.0) + band_power(&r, 30.0, 150.0))))
    };
    let phase = run_stereo(&phase_source(200_000), speed, shift, 120_000);
    let pitch = 2f64.powf(f64::from(shift) / 12.0);
    let (cl, _) = fit(&left(&phase[24_000..72_000]), &[55.0 * pitch]);
    let (cr, _) = fit(&right(&phase[24_000..72_000]), &[55.0 * pitch]);
    // sin(wt + p) = sin p cos wt + cos p sin wt: the cos coefficient is sin p, the sin coefficient cos p.
    let pl = cl[0].0.atan2(cl[0].1);
    let pr = cr[0].0.atan2(cr[0].1);
    let mut difference = (pl - pr).to_degrees();
    while difference > 180.0 {
        difference -= 360.0;
    }
    while difference < -180.0 {
        difference += 360.0;
    }
    Stereo {
        proportional_error,
        low_coherence: coherence(&l, &r, 30.0, 150.0),
        mid_coherence: coherence(&l, &r, 500.0, 4_000.0),
        low_mono_db: low_mono,
        phase_error_deg: difference - 60.0,
    }
}

/// The same for the source itself (what the stretched output is compared with).
fn stereo_reference() -> (f64, f64, f64) {
    let source = stereo_source(240_000);
    let (l, r): (Vec<f64>, Vec<f64>) = source[24_000..]
        .iter()
        .map(|x| (f64::from(x[0]), f64::from(x[1])))
        .unzip();
    let sum: Vec<f64> = l.iter().zip(&r).map(|(a, b)| 0.5 * (a + b)).collect();
    (
        coherence(&l, &r, 30.0, 150.0),
        coherence(&l, &r, 500.0, 4_000.0),
        db(band_power(&sum, 30.0, 150.0)
            / (0.5 * (band_power(&l, 30.0, 150.0) + band_power(&r, 30.0, 150.0)))),
    )
}

/// (d) White noise through the stretcher: band power against the source (dB) in 30-150, 150-500, 500-4000 and
/// 4000-16000 Hz, and the change of spectral flatness over 100-16000 Hz (dB, negative is more coloured).
fn noise_row(speed: f64) -> ([f64; 4], f64) {
    let frames = 480_000;
    let source = white(frames, 0x7777_1234, 0.3);
    let out_frames = ((frames - 48_000) as f64 / speed) as usize;
    let out = run(&mono(&source), speed, 0, out_frames);
    let o = &out[24_000..];
    let s = &source[48_000..];
    let bands = [
        (30.0, 150.0),
        (150.0, 500.0),
        (500.0, 4_000.0),
        (4_000.0, 16_000.0),
    ];
    let ratios = bands.map(|(a, b)| db(band_power(o, a, b) / band_power(s, a, b)));
    (
        ratios,
        flatness(o, 100.0, 16_000.0) - flatness(s, 100.0, 16_000.0),
    )
}

fn low_sets() -> Vec<(&'static str, Vec<(f64, f64)>)> {
    vec![
        ("sine41", vec![(41.2, 0.5)]),
        ("sine55", vec![(55.0, 0.5)]),
        ("sine82", vec![(82.4, 0.5)]),
        ("pair55+82", vec![(55.0, 0.3), (82.4, 0.3)]),
        ("pair41+62", vec![(41.2, 0.3), (61.7, 0.3)]),
    ]
}

#[test]
#[ignore = "scorecard: cargo test --release --test audio_backing_bass scorecard -- --ignored --nocapture"]
fn scorecard() {
    // (a)
    let seconds = 9.0;
    let frames = (seconds * SR) as usize + 48_000;
    let (kick_bed, _) = kicks(40, 0.15);
    let signals: Vec<(&str, Vec<f64>)> = vec![
        ("sine41", tones(&[(41.2, 0.5)], frames)),
        ("sine55", tones(&[(55.0, 0.5)], frames)),
        ("sine82", tones(&[(82.4, 0.5)], frames)),
        ("pair55+82", tones(&[(55.0, 0.3), (82.4, 0.3)], frames)),
        ("pair41+62", tones(&[(41.2, 0.3), (61.7, 0.3)], frames)),
        ("bassnotes", bass_notes(frames)),
        ("kick+note", kick_bed),
        ("noise", white(frames, 0x7777_1234, 0.3)),
        ("mix", mix(frames)),
    ];
    for (name, source) in &signals {
        let row: Vec<String> = SPEEDS
            .iter()
            .map(|&s| {
                let (power, matched) = low_band_ratio(source, s, seconds);
                format!("{power:+.2} / {matched:+.2}")
            })
            .collect();
        eprintln!(
            "A low-band dB power / at its pitch {name}: {}",
            row.join(" | ")
        );
    }
    // (b), with 100% first: the stretcher is bypassed there, so it is the measurement's own floor.
    for (name, set) in low_sets() {
        let row: Vec<String> = [1.0]
            .iter()
            .chain(SPEEDS.iter())
            .map(|&s| {
                let q = steady(s, 0, &set);
                format!(
                    "swing {:.2} level {:+.2} off {:.1}",
                    q.swing_db, q.level_db, q.off_tone_db
                )
            })
            .collect();
        eprintln!("B {name}: {}", row.join(" | "));
    }
    // (c)
    let (kick_src, kick_onsets) = kicks(8, 0.0);
    let (over_src, over_onsets) = kicks(8, 0.15);
    let (drum_src, drum_onsets) = hits(true);
    let (pluck_src, pluck_onsets) = hits(false);
    for &s in [1.0].iter().chain(SPEEDS.iter()) {
        let full = hit(&kick_src, &kick_onsets, s, 0, None, 10, 30);
        let low = hit(&kick_src, &kick_onsets, s, 0, Some((150.0, false)), 20, 60);
        let over = hit(&over_src, &over_onsets, s, 0, Some((500.0, true)), 10, 30);
        let drum = hit(&drum_src, &drum_onsets, s, 0, None, 10, 30);
        let pl = hit(&pluck_src, &pluck_onsets, s, 0, None, 10, 30);
        eprintln!(
            "C {s}: kick full pre {:.1} att {:.2} lag {:.2} | kick low pre {:.1} att {:.2} lag {:.2} | click over note pre {:.1} att {:.2} lag {:.2} | drum pre {:.1} att {:.2} lag {:.2} | pluck82 pre {:.1} att {:.2} lag {:.2}",
            full.pre_echo_db,
            full.attack_ms,
            full.lag_ms,
            low.pre_echo_db,
            low.attack_ms,
            low.lag_ms,
            over.pre_echo_db,
            over.attack_ms,
            over.lag_ms,
            drum.pre_echo_db,
            drum.attack_ms,
            drum.lag_ms,
            pl.pre_echo_db,
            pl.attack_ms,
            pl.lag_ms
        );
    }
    // (d)
    for &s in &SPEEDS {
        let (bands, flat) = noise_row(s);
        eprintln!(
            "D {s}: noise bands dB {:+.2} {:+.2} {:+.2} {:+.2} flatness change {:+.2} dB",
            bands[0], bands[1], bands[2], bands[3], flat
        );
    }
    // (e)
    for &s in &SPEEDS {
        let short = burst_errors(s, 1_000.0, 1_920, 8);
        let long = burst_errors(s, 1_000.0, 9_600, 6);
        let noise = burst_errors(s, 0.0, 1_920, 8);
        let low = burst_errors(s, 55.0, 9_600, 6);
        eprintln!(
            "E {s}: worst ms: 1k 40ms {:+.2} | 1k 200ms {:+.2} | noise 40ms {:+.2} | 55Hz 200ms {:+.2}",
            worst(&short),
            worst(&long),
            worst(&noise),
            worst(&low)
        );
    }
    // (f)
    let (lc, mc, lm) = stereo_reference();
    eprintln!("F source: low coherence {lc:.4} mid coherence {mc:.4} low mono {lm:+.2} dB");
    for &s in &SPEEDS {
        let st = stereo(s, 0);
        eprintln!(
            "F {s}: proportional error {:.2e} low coherence {:.4} mid coherence {:.4} low mono {:+.2} dB phase error {:+.1} deg",
            st.proportional_error,
            st.low_coherence,
            st.mid_coherence,
            st.low_mono_db,
            st.phase_error_deg
        );
    }
}

/// The phase step at each splice of a sine, read from the output: inside one grain the stretcher plays
/// (1 - u) * tail + u * head (u from 0 to 1 over the grain), two sines of the same frequency, so a fit of
/// (1 - u) cos, (1 - u) sin, u cos and u sin gives each one's phase. Returns the phase of head minus tail, per grain.
fn splice_steps(out: &[f64], hz: f64, grains: std::ops::Range<usize>) -> Vec<f64> {
    let hop = 256;
    let w = vec![1.0; hop];
    grains
        .map(|g| {
            let x = &out[g * hop..(g + 1) * hop];
            let at = |i: usize| TAU * hz * (g * hop + i) as f64 / SR;
            let u = |i: usize| i as f64 / hop as f64;
            let columns = vec![
                (0..hop).map(|i| (1.0 - u(i)) * at(i).cos()).collect(),
                (0..hop).map(|i| (1.0 - u(i)) * at(i).sin()).collect(),
                (0..hop).map(|i| u(i) * at(i).cos()).collect(),
                (0..hop).map(|i| u(i) * at(i).sin()).collect(),
            ];
            let c = solve(&columns, &w, x);
            let tail = c[1].atan2(c[0]);
            let head = c[3].atan2(c[2]);
            let mut step = head - tail;
            while step > std::f64::consts::PI {
                step -= TAU;
            }
            while step < -std::f64::consts::PI {
                step += TAU;
            }
            step
        })
        .collect()
}

#[test]
#[ignore = "root cause: cargo test --release --test audio_backing_bass root_cause -- --ignored --nocapture"]
fn root_cause() {
    // For a steady sine through the stretcher at the speeds of practice: the phase step between the two sines each grain
    // crossfades (head against tail), the power a linear crossfade of two equal sines that far apart keeps
    // (2/3 + cos(step)/3, averaged over the grains), the power the output keeps at the tone (fit over 0.5 s), and where
    // the rest went: the share of the output's power within 3 Hz of the tone, and at the tone plus or minus the grain
    // rate (48000 / 256 = 187.5 Hz) and its multiples.
    for hz in [41.2, 55.0, 82.4, 110.0, 220.0, 440.0] {
        for &speed in &SPEEDS {
            let frames = 120_000;
            let source = tones(&[(hz, 0.5)], (frames as f64 * speed) as usize + 48_000);
            let out = run(&mono(&source), speed, 0, frames);
            let steps = splice_steps(&out, hz, 40..400);
            let mean_abs = steps.iter().map(|s| s.abs()).sum::<f64>() / steps.len() as f64;
            let predicted =
                steps.iter().map(|s| 2.0 / 3.0 + s.cos() / 3.0).sum::<f64>() / steps.len() as f64;
            let coherent = steps
                .iter()
                .filter(|s| s.abs() < 10f64.to_radians())
                .count() as f64
                / steps.len() as f64;
            let x = &out[24_000..48_000];
            let f = peak(x, hz);
            let (c, _) = fit(x, &[f]);
            let kept = (c[0].0.hypot(c[0].1) / 0.5).powi(2);
            let tail = &out[24_000..];
            let total = band_power(tail, 1.0, 20_000.0);
            let at_tone = band_power(tail, hz - 3.0, hz + 3.0);
            let sidebands: f64 = (1..=6)
                .flat_map(|k| [hz + 187.5 * f64::from(k), (187.5 * f64::from(k) - hz).abs()])
                .map(|f| band_power(tail, f - 3.0, f + 3.0))
                .sum();
            // Where the power went instead: the strongest frequency of the output, and the share at the tone times the
            // speed (the pitch the clock would give it if the bass were simply played slower).
            let psd = welch(tail);
            let bin = SR / 8192.0;
            let strongest = (1..psd.len())
                .filter(|&k| k as f64 * bin < 400.0)
                .max_by(|&a, &b| psd[a].total_cmp(&psd[b]))
                .unwrap() as f64
                * bin;
            let slowed = band_power(tail, hz * speed - 3.0, hz * speed + 3.0);
            eprintln!(
                "R {hz} Hz {speed}x: mean |splice step| {:.1} deg (drift per grain {:.1} deg), splices within 10 deg {:.0}%, crossfade predicts {:.2} dB, tone kept {:.2} dB, power at the tone {:.1}%, at grain-rate sidebands {:.1}%, strongest {:.1} Hz, at tone x speed ({:.1} Hz) {:.1}%",
                mean_abs.to_degrees(),
                360.0 * 256.0 * (1.0 - speed) * hz / SR,
                coherent * 100.0,
                db(predicted),
                db(kept),
                100.0 * at_tone / total,
                100.0 * sidebands / total,
                strongest,
                hz * speed,
                100.0 * slowed / total
            );
        }
    }
}

#[test]
#[ignore = "release-profile timing: cargo test --release --test audio_backing_bass cost_of_a_second_of_audio -- --ignored --nocapture"]
fn cost_of_a_second_of_audio() {
    // (g) Milliseconds of one thread per second of audio, median of five runs of ten seconds of output after a seek, for
    // a stereo mix (bass line, kicks, chord, hiss) at the speeds of the scorecard, at 100% and with key shifts; and what
    // building the voice costs (once per backing and key shift, off the audio thread).
    let m = mix(48_000 * 40);
    let frames: Vec<[f32; 2]> = m.iter().map(|&v| [v as f32, (v * 0.9) as f32]).collect();
    for (speed, shift) in [
        (1.0, 0),
        (0.5, 0),
        (0.6, 0),
        (0.75, 0),
        (0.9, 0),
        (0.5, 12),
        (1.0, -12),
        (3.0, 12),
        (3.0, -12),
    ] {
        let started = std::time::Instant::now();
        let mut voice = voice(frames.clone(), shift);
        let build_ms = started.elapsed().as_secs_f64() * 1e3;
        let mut runs: Vec<f64> = (0..5)
            .map(|_| {
                voice.seek(1.0);
                let started = std::time::Instant::now();
                let mut sum = 0.0f32;
                for n in 0..480_000 {
                    sum += voice.next_frame(1.0 + n as f64 * speed / SR)[0];
                }
                std::hint::black_box(sum);
                started.elapsed().as_secs_f64() * 1e3 / 10.0
            })
            .collect();
        runs.sort_by(f64::total_cmp);
        eprintln!(
            "G {speed}x key {shift}: {:.2} ms per second of audio (median of 5; min {:.2}, max {:.2}); voice built in {build_ms:.1} ms",
            runs[2], runs[0], runs[4]
        );
    }
}
