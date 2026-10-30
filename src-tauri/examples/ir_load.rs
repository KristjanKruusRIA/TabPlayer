//! Timing of loaded cabinet responses in the audio callback's terms, with the sounds made here and no recorded samples:
//! callbacks of a given size over several tracks of the heaviest sound, each timed against its budget, and the tail of a
//! clean note, which is where a stream of subnormal numbers would show. Not shipped.
//!
//!   cargo run --release --example ir_load -- cells    median, 99th percentile and worst callback, and overruns
//!   cargo run --release --example ir_load -- tail     a clean note's tail into the cabinet, by second
//!   cargo run --release --example ir_load -- spikes   the convolution alone, tracks' transforms together and apart
use std::time::Instant;
use tabplayer_lib::audio::{
    cabinet_ir,
    dsp::{CabinetIr, FxSettings, TrackDsp},
    ir_convolver::{IrEngine, IrKernel},
};

fn noise(len: usize, seed: u32) -> Vec<f32> {
    let mut s = seed.max(1);
    (0..len)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f32 / u32::MAX as f32 * 2.0 - 1.0
        })
        .collect()
}
fn wav_f32(rate: u32, samples: &[f32]) -> Vec<u8> {
    let data: Vec<u8> = samples.iter().flat_map(|v| v.to_le_bytes()).collect();
    let mut f = b"RIFF".to_vec();
    f.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    f.extend_from_slice(b"WAVEfmt \x10\0\0\0\x03\0\x01\0");
    f.extend_from_slice(&rate.to_le_bytes());
    f.extend_from_slice(&(rate * 4).to_le_bytes());
    f.extend_from_slice(b"\x04\0\x20\0data");
    f.extend_from_slice(&(data.len() as u32).to_le_bytes());
    f.extend_from_slice(&data);
    f
}
fn quant(mut v: Vec<f64>, q: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * q) as usize]
}
fn heavy() -> FxSettings {
    let mut fx = FxSettings::default();
    fx.gate.enabled = true;
    fx.drive.enabled = true;
    fx.drive.drive = 0.2;
    fx.amp.enabled = true;
    fx.amp.model = "metal".into();
    fx.amp.drive = 0.55;
    fx.cabinet.enabled = true;
    fx.cabinet.model = "closed".into();
    fx
}
fn with_ir(id: &str, mut fx: FxSettings) -> FxSettings {
    fx.cabinet.ir = Some(CabinetIr {
        id: id.into(),
        name: "bench".into(),
        level_db: 0.0,
    });
    fx
}
/// Tracks of `fx` as the mix prepares them: each with its index.
fn tracks(fx: &FxSettings, count: usize, rate: u32) -> Vec<TrackDsp> {
    (0..count)
        .map(|index| {
            let mut dsp = TrackDsp::new(fx.clone(), rate, 16.0).unwrap();
            dsp.set_ir_index(index);
            dsp
        })
        .collect()
}
fn cell(rate: u32, count: usize, fx: &FxSettings, block: usize) -> (f64, f64, f64, usize, usize) {
    let mut dsps = tracks(fx, count, rate);
    let n = noise(1 << 16, 3);
    let (mut at, mut sink) = (0usize, 0.0f32);
    let wave = |i: usize| -> [f32; 2] {
        let t = i as f32 / rate as f32;
        let tone = (t * 110.0 * 6.283).sin() * 0.3
            + (t * 165.0 * 6.283).sin() * 0.2
            + n[i & 0xffff] * 0.01;
        [tone, tone * 0.7]
    };
    for _ in 0..rate as usize {
        let x = wave(at);
        at += 1;
        for d in dsps.iter_mut() {
            sink += d.process(x, 120.0)[0];
        }
    }
    let total = rate as usize * 3;
    let mut samples = Vec::with_capacity(total / block + 1);
    let mut done = 0;
    while done < total {
        let t = Instant::now();
        for _ in 0..block {
            let x = wave(at);
            at += 1;
            for d in dsps.iter_mut() {
                sink += d.process(x, 120.0)[0];
            }
        }
        samples.push(t.elapsed().as_secs_f64() * 1e3);
        done += block;
    }
    std::hint::black_box(sink);
    let budget = block as f64 / rate as f64 * 1e3;
    let over = samples.iter().filter(|m| **m > budget).count();
    let count = samples.len();
    (
        quant(samples.clone(), 0.5),
        quant(samples.clone(), 0.99),
        quant(samples, 1.0),
        over,
        count,
    )
}
fn cells(id: &str) {
    let (built_in, loaded) = (heavy(), with_ir(id, heavy()));
    println!("median / 99th percentile / worst callback in ms, then overruns, for three runs; least overruns of the three");
    for &(rate, count, block) in &[
        (48_000u32, 6usize, 64usize),
        (48_000, 6, 128),
        (48_000, 8, 128),
        (48_000, 8, 256),
        (96_000, 6, 480),
        (96_000, 8, 480),
        (48_000, 10, 480),
        (48_000, 12, 480),
    ] {
        for (name, fx) in [("built-in", &built_in), ("response", &loaded)] {
            let (mut row, mut least, mut total) = (String::new(), usize::MAX, 0);
            for _ in 0..3 {
                let (m, p, x, over, c) = cell(rate, count, fx, block);
                row += &format!(" [{m:.2} {p:.2} {x:.2} {over}]");
                least = least.min(over);
                total = c;
            }
            println!(
                "{rate} Hz {count:2} tracks block {block:4} {name:8}: budget {:.3}, least overruns {least}/{total}:{row}",
                block as f64 / rate as f64 * 1e3
            );
        }
    }
}
/// A note, then silence through the cabinet, with callbacks of `block` frames: the share of a core in each second, the
/// worst callback, and the overruns.
fn tail(name: &str, fx: &FxSettings, count: usize, block: usize, seconds: usize) {
    let rate = 48_000u32;
    let mut dsps = tracks(fx, count, rate);
    let burst = rate as usize / 2;
    let n = noise(burst, 7);
    for i in 0..burst {
        let e = (i as f32 / rate as f32 * 150.0 * 6.283).sin() * 0.3 + n[i] * 0.02;
        for d in dsps.iter_mut() {
            d.process([e, e * 0.7], 120.0);
        }
    }
    let per = rate as usize / block;
    let budget = block as f64 / rate as f64 * 1e3;
    let (mut line, mut worst, mut over) = (String::new(), 0.0f64, 0usize);
    for _ in 0..seconds {
        let mut sum = 0.0;
        for _ in 0..per {
            let t = Instant::now();
            for _ in 0..block {
                for d in dsps.iter_mut() {
                    std::hint::black_box(d.process([0.0; 2], 120.0));
                }
            }
            let ms = t.elapsed().as_secs_f64() * 1e3;
            sum += ms;
            worst = worst.max(ms);
            over += (ms > budget) as usize;
        }
        line += &format!(" {:.0}", sum / 10.0);
    }
    println!("{name:20} {count:2} tracks block {block:4}: % of a core by second:{line}; worst callback {worst:.2} ms, budget {budget:.1}, overruns {over}");
}
/// The convolution alone, which is what a mix of many tracks does once per block of each tier: `count` engines, callbacks
/// of `block` frames, with every track's transforms falling on the same frames or a place each. The best of five runs
/// for each figure, since a shared machine only ever adds time.
fn spikes(kernel: &IrKernel, count: usize, block: usize, apart: bool) -> (f64, f64, f64) {
    let rate = 48_000u32;
    let n = noise(1 << 16, 9);
    let mut best = (f64::MAX, f64::MAX, f64::MAX);
    for _ in 0..5 {
        let mut engines: Vec<IrEngine> = (0..count)
            .map(|i| IrEngine::keyed(rate, if apart { i as u64 * 2 } else { 0 }))
            .collect();
        let (mut at, mut sink) = (0usize, 0.0f32);
        let mut samples = Vec::new();
        for call in 0..(rate as usize * 4 / block) {
            let t = Instant::now();
            for _ in 0..block {
                let x = n[at & 0xffff] * 0.3;
                at += 1;
                for e in engines.iter_mut() {
                    sink += e.process([x, x * 0.7], kernel, None)[0][0];
                }
            }
            if call >= rate as usize / block {
                samples.push(t.elapsed().as_secs_f64() * 1e3);
            }
        }
        std::hint::black_box(sink);
        best.0 = best.0.min(quant(samples.clone(), 0.5));
        best.1 = best.1.min(quant(samples.clone(), 0.99));
        best.2 = best.2.min(quant(samples, 1.0));
    }
    best
}
fn main() {
    let dir = std::env::temp_dir().join(format!("ir-load-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let library = cabinet_ir::install(dir.join("library"));
    let mut low = 0.0f32;
    let response: Vec<f32> = noise(48_000, 12)
        .iter()
        .enumerate()
        .map(|(i, v)| {
            low += 0.45 * (v - low);
            low * (-(i as f32) / 9600.0).exp() * 0.25 + if i == 0 { 0.6 } else { 0.0 }
        })
        .collect();
    let id = library
        .import_bytes(&wav_f32(48_000, &response), "bench.wav")
        .unwrap()
        .id;
    match std::env::args().nth(1).as_deref() {
        Some("cells") => cells(&id),
        Some("tail") => {
            for preset in ["clean", "bass"] {
                let fx = FxSettings::preset(preset).unwrap();
                tail(&format!("{preset} built-in"), &fx, 8, 480, 9);
                tail(&format!("{preset} response"), &with_ir(&id, fx), 8, 480, 9);
            }
            let fx = FxSettings::preset("clean").unwrap();
            tail("clean response", &with_ir(&id, fx.clone()), 1, 480, 9);
            tail("clean response", &with_ir(&id, fx), 8, 64, 9);
        }
        Some("spikes") => {
            let mut low = 0.0f32;
            let taps: Vec<f32> = noise(48_000, 12)
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    low += 0.45 * (v - low);
                    low * (-(i as f32) / 9600.0).exp() * 0.25
                })
                .collect();
            let kernel = IrKernel::new(&taps, 48_000).unwrap();
            println!("convolution alone, 48 kHz, a full second of response, stereo input: median / 99th / worst callback in ms and the worst as a share of the callback's time");
            for &(count, block) in &[(6usize, 64usize), (8, 64), (6, 128), (8, 128), (8, 256), (12, 480)] {
                for (name, apart) in [("together", false), ("apart", true)] {
                    let (m, p, x) = spikes(&kernel, count, block, apart);
                    let budget = block as f64 / 48_000.0 * 1e3;
                    println!("{count:2} tracks block {block:4} {name:8}: {m:.3} / {p:.3} / {x:.3} ms, worst is {:.0}% of {budget:.2} ms", x / budget * 100.0);
                }
            }
        }
        _ => eprintln!("usage: ir_load cells | tail | spikes"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}
