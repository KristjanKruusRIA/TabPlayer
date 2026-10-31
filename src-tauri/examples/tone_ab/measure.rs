//! Bench measurements of a mono chain: the signals and figures of the installed-plug-in survey, so its numbers can be
//! read directly against this chain's, plus the two the tone work is judged on, alias level and low-chord intermodulation.
use std::f64::consts::TAU;

pub const RATE: usize = 48_000;

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
fn db(value: f64) -> f64 {
    20.0 * value.max(1e-12).log10()
}
fn rms(values: &[f64]) -> f64 {
    (values.iter().map(|v| v * v).sum::<f64>() / values.len() as f64).sqrt()
}
fn sine(hz: f64, peak: f64, seconds: f64) -> Vec<f64> {
    (0..(seconds * RATE as f64) as usize)
        .map(|n| peak * (TAU * hz * n as f64 / RATE as f64).sin())
        .collect()
}
fn through(mut chain: impl FnMut(f32) -> f32, input: &[f64]) -> Vec<f64> {
    input.iter().map(|&x| chain(x as f32) as f64).collect()
}
fn last_second(signal: &[f64]) -> &[f64] {
    &signal[signal.len() - RATE..]
}
/// The amplitude of the `hz` line in a Hann-windowed `segment`.
fn line(segment: &[f64], hz: f64) -> f64 {
    let size = segment.len() as f64;
    let (mut re, mut im, mut sum) = (0.0, 0.0, 0.0);
    for (n, y) in segment.iter().enumerate() {
        let w = 0.5 - 0.5 * (TAU * n as f64 / size).cos();
        let phase = TAU * hz * n as f64 / RATE as f64;
        re += y * w * phase.cos();
        im += y * w * phase.sin();
        sum += w;
    }
    2.0 * (re * re + im * im).sqrt() / sum
}
fn welch(signal: &[f64]) -> Vec<f64> {
    let size = 8_192;
    let window: Vec<f64> = (0..size)
        .map(|n| 0.5 - 0.5 * (TAU * n as f64 / size as f64).cos())
        .collect();
    let mut sum = vec![0.0; size / 2 + 1];
    let (mut at, mut count) = (0, 0.0);
    while at + size <= signal.len() {
        let frame = &signal[at..at + size];
        let mean = frame.iter().sum::<f64>() / size as f64;
        let mut re: Vec<f64> = frame
            .iter()
            .zip(&window)
            .map(|(x, w)| (x - mean) * w)
            .collect();
        let mut im = vec![0.0; size];
        fft(&mut re, &mut im);
        for k in 0..=size / 2 {
            sum[k] += re[k] * re[k] + im[k] * im[k];
        }
        count += 1.0;
        at += size / 2;
    }
    sum.iter().map(|p| p / count).collect()
}
fn band(power: &[f64], low: f64, high: f64) -> f64 {
    let bin = RATE as f64 / 8_192.0;
    power
        .iter()
        .enumerate()
        .filter(|(k, _)| (low..high).contains(&(*k as f64 * bin)))
        .map(|(_, p)| p)
        .sum()
}
fn pink(rms_level: f64, seed: u32) -> Vec<f64> {
    let size = 1 << 19;
    let mut state = seed;
    let mut uniform = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state as f64 + 1.0) / (u32::MAX as f64 + 2.0)
    };
    let mut re = vec![0.0; size];
    let mut im = vec![0.0; size];
    for k in 1..size / 2 {
        let hz = k as f64 * RATE as f64 / size as f64;
        if hz < 20.0 {
            continue;
        }
        // A normal pair by the Box-Muller transform, each bin scaled for a power falling 3 dB an octave.
        let (a, b) = (uniform(), uniform());
        let radius = (-2.0 * a.ln()).sqrt() / hz.sqrt();
        let (s, c) = (TAU * b).sin_cos();
        re[k] = radius * c;
        im[k] = radius * s;
        re[size - k] = radius * c;
        im[size - k] = -radius * s;
    }
    fft(&mut re, &mut im);
    let scale = rms_level / rms(&re);
    re.iter().map(|v| v * scale).collect()
}

/// The survey's figures for one chain, where `make` builds it fresh for each signal, as the survey resets its plug-in.
pub fn survey<C: FnMut(f32) -> f32>(make: impl Fn() -> C) -> String {
    let mut out = String::new();
    let run = |input: &[f64]| through(make(), input);
    for (hz, peak) in [(220.0, 0.1), (220.0, 0.25), (82.0, 0.1)] {
        let y = run(&sine(hz, peak, 2.5));
        let tail = last_second(&y);
        let first = line(tail, hz);
        let harmonic = |k: usize| line(tail, hz * k as f64) / first;
        let sum = |start: usize| {
            (start..=12)
                .step_by(2)
                .filter(|k| hz * *k as f64 <= 20_000.0)
                .map(|k| harmonic(k).powi(2))
                .sum::<f64>()
        };
        let top = tail.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        out += &format!(
            "  {hz} Hz {peak}: gain {:.1} H2 {:.1} H3 {:.1} H4 {:.1} H5 {:.1} even {:.1} odd {:.1} crest {:.1}\n",
            db(rms(tail) / (peak / 2f64.sqrt())),
            db(harmonic(2)),
            db(harmonic(3)),
            db(harmonic(4)),
            db(harmonic(5)),
            db(sum(2).sqrt()),
            db(sum(3).sqrt()),
            db(top / rms(tail))
        );
    }
    let levels: Vec<(i32, f64)> = (-54..-2)
        .step_by(6)
        .map(|peak_db| {
            let peak = 10f64.powf(peak_db as f64 / 20.0);
            (peak_db, db(rms(last_second(&run(&sine(220.0, peak, 1.5))))))
        })
        .collect();
    let (low, high) = levels.iter().fold((f64::MAX, f64::MIN), |(a, b), (_, v)| {
        (a.min(*v), b.max(*v))
    });
    let row: Vec<String> = levels
        .iter()
        .map(|(peak, value)| format!("{peak}:{value:.1}"))
        .collect();
    out += &format!("  sweep {} (moves {:.1} dB)\n", row.join(" "), high - low);
    let two: Vec<f64> = (0..(2.5 * RATE as f64) as usize)
        .map(|n| {
            let t = n as f64 / RATE as f64;
            0.1 * ((TAU * 110.0 * t).sin() + (TAU * 165.0 * t).sin())
        })
        .collect();
    let y = run(&two);
    let tail = last_second(&y);
    let reference = line(tail, 110.0).max(line(tail, 165.0));
    let row: Vec<String> = [55.0, 110.0, 165.0, 220.0, 275.0, 330.0, 385.0, 440.0, 550.0]
        .map(|hz| format!("{hz}:{:.1}", db(line(tail, hz) / reference)))
        .to_vec();
    out += &format!("  two-tone {}\n", row.join(" "));
    for level in [0.003, 0.07] {
        let x = pink(level, 0x2545_F491);
        let y = run(&x);
        let (input, output) = (welch(&x[RATE..]), welch(&y[RATE..]));
        let total: f64 = output.iter().sum();
        let share: Vec<String> = [
            (0.0, 100.0),
            (100.0, 400.0),
            (400.0, 1_000.0),
            (1_000.0, 2_000.0),
            (2_000.0, 5_000.0),
            (5_000.0, 10_000.0),
            (10_000.0, 24_001.0),
        ]
        .map(|(a, b)| {
            format!(
                "{:.0}-{:.0}:{:.1}%",
                a,
                b,
                100.0 * band(&output, a, b) / total
            )
        })
        .to_vec();
        out += &format!(
            "  pink {level}: out {:.1} {}\n",
            db(rms(&y[RATE..])),
            share.join(" ")
        );
        let row: Vec<String> = (0..8)
            .map(|i| 30.0 * 2f64.powf(i as f64 * 2.0 / 3.0 * 1.5))
            .chain([7_680.0, 12_191.0])
            .map(|hz: f64| {
                let edge = 2f64.powf(1.0 / 6.0);
                let ratio = band(&output, hz / edge, hz * edge)
                    / band(&input, hz / edge, hz * edge).max(1e-30);
                format!("{}:{:.1}", hz as u32, 10.0 * ratio.max(1e-30).log10())
            })
            .collect();
        out += &format!("    xfer {}\n", row.join(" "));
    }
    let row: Vec<String> = [
        30.0, 45.0, 60.0, 82.0, 110.0, 165.0, 220.0, 330.0, 440.0, 660.0, 1_000.0, 1_500.0,
        2_000.0, 3_000.0, 4_000.0, 6_000.0, 8_000.0, 12_000.0,
    ]
    .map(|hz: f64| {
        let y = run(&sine(hz, 0.15, 1.5));
        format!("{}:{:.1}", hz as u32, db(line(last_second(&y), hz) / 0.15))
    })
    .to_vec();
    out += &format!("  steps {}\n", row.join(" "));
    let x: Vec<f64> = (0..4 * RATE)
        .map(|n| {
            let t = n as f64 / RATE as f64;
            0.25 * (-t / 0.9).exp() * (TAU * 220.0 * t).sin()
        })
        .collect();
    let y = run(&x);
    let row: Vec<String> = [0.1, 0.3, 0.6, 1.0, 1.5, 2.0, 2.5, 3.0]
        .map(|t: f64| {
            let at = (t * RATE as f64) as usize;
            let span = at..at + RATE / 20;
            format!(
                "{t}:{:.1}>{:.1}",
                db(rms(&x[span.clone()])),
                db(rms(&y[span]))
            )
        })
        .to_vec();
    out += &format!("  pluck {}\n", row.join(" "));
    out
}

/// What of a high tone's output is neither the tone nor its harmonics, against what is, in dB, up to 16 kHz.
pub fn alias_db(mut chain: impl FnMut(f32) -> f32, rate: f64, hz: f64, peak: f64) -> f64 {
    let size = 1 << 16;
    let settle = rate as usize / 2;
    let mut re = vec![0.0; size];
    for n in 0..size + settle {
        let y = chain(((TAU * hz * n as f64 / rate).sin() * peak) as f32);
        if n >= settle {
            let x = TAU * (n - settle) as f64 / size as f64;
            // The 4-term Blackman-Harris window: its side lobes lie below -92 dB, so no line leaks into the count.
            let w =
                0.35875 - 0.48829 * x.cos() + 0.14128 * (2.0 * x).cos() - 0.01168 * (3.0 * x).cos();
            re[n - settle] = y as f64 * w;
        }
    }
    let mut im = vec![0.0; size];
    fft(&mut re, &mut im);
    let bin = rate / size as f64;
    let (mut harmonic, mut alias) = (0.0, 0.0);
    for k in (60.0 / bin) as usize..(16_000.0 / bin) as usize {
        let f = k as f64 * bin;
        let power = re[k] * re[k] + im[k] * im[k];
        if (f - (f / hz).round() * hz).abs() < 9.0 * bin {
            harmonic += power;
        } else {
            alias += power;
        }
    }
    10.0 * (alias / harmonic).log10()
}
/// The low-order products of a major third on the fifth string, 110 and 138.59 Hz, each `peak` high, in dB against the
/// two notes' own harmonics. A third is the case that turns to mud: unlike a fifth its products fall on no note.
pub fn intermod_db(mut chain: impl FnMut(f32) -> f32, rate: f64, peak: f64) -> f64 {
    let (a, b) = (110.0, 138.59);
    let size = 1 << 16;
    let settle = rate as usize / 2;
    let mut re = vec![0.0; size];
    for n in 0..size + settle {
        let t = n as f64 / rate;
        let y = chain((peak * ((TAU * a * t).sin() + (TAU * b * t).sin())) as f32);
        if n >= settle {
            let x = TAU * (n - settle) as f64 / size as f64;
            let w =
                0.35875 - 0.48829 * x.cos() + 0.14128 * (2.0 * x).cos() - 0.01168 * (3.0 * x).cos();
            re[n - settle] = y as f64 * w;
        }
    }
    let mut im = vec![0.0; size];
    fft(&mut re, &mut im);
    let bin = rate / size as f64;
    let power = |hz: f64| {
        let k = (hz / bin).round() as usize;
        (k - 4..=k + 4)
            .map(|i| re[i] * re[i] + im[i] * im[i])
            .sum::<f64>()
    };
    let mut products = 0.0;
    for m in -3i32..=3 {
        for n in -3i32..=3 {
            let hz = m as f64 * a + n as f64 * b;
            if m != 0 && n != 0 && m.abs() + n.abs() <= 4 && (20.0..1_000.0).contains(&hz) {
                products += power(hz);
            }
        }
    }
    let notes: f64 = (1..=8)
        .map(|k| power(k as f64 * a) + power(k as f64 * b))
        .sum();
    10.0 * (products / notes).log10()
}
