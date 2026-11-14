//! Renders one guitar riff through the driven sounds with the real sample voices, for judging them by ear, and
//! measures them. Not shipped.
//!
//!   cargo run --release --example tone_ab -- render <old|new>   writes `<sound>-<tag>.wav`
//!   cargo run --release --example tone_ab -- ir                 writes `<sound>-new-ir.wav`; needs `TONE_IR_PATH`
//!   cargo run --release --example tone_ab -- clean <directory>  writes every clean sound's raw PCM, to compare bytes
//!   cargo run --release --example tone_ab -- bench              times a heavy sound on one track
//!   cargo run --release --example tone_ab -- ir-bench           the cost of loaded cabinet responses; synthesizes its own
//!   cargo run --release --example tone_ab -- nam-bench <file|synthetic>   the cost of one NAM capture, in microseconds per sample
//!   cargo run --release --example tone_ab -- input              reports the levels the samples reach the chain at
//!   cargo run --release --example tone_ab -- measure            the bench figures of each driven sound
//!   cargo run --release --example tone_ab -- levels             every factory sound's loudness on the riff
//!
//! `TONE_AB_OUT` overrides the output folder, and `TONE_AUDIO` the recorded sample folder.
//! `TONE_IR_PATH` names a reference cabinet impulse response: a local comparison only, never part of the app.
mod measure;

use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Instant};
use tabplayer_lib::{
    audio::{
        dsp::{FxSettings, TrackDsp},
        plan::PlaybackPlan,
        renderer::{Renderer, master_limit},
        resources::AudioResources,
        voices::resource_requests,
    },
    settings::{DocumentSettings, TrackSound},
};

const RATE: u32 = 48_000;
const PPQ: f64 = 960.0;
/// A bar of four beats at 120 bpm lasts two seconds. Five bars and a tail of one bar.
const BARS: f64 = 5.0;
const SOUNDING_SECONDS: f64 = 10.0;
const TAIL_SECONDS: f64 = 1.5;

/// One step of the riff: beats long, keys struck, and whether a palm mutes it.
struct Hit {
    beats: f64,
    keys: &'static [u8],
    muted: bool,
    /// Bend in semitones reached over the note's first third, and vibrato depth in semitones.
    bend: f64,
    vibrato: f64,
}
const fn hit(beats: f64, keys: &'static [u8]) -> Hit {
    Hit {
        beats,
        keys,
        muted: false,
        bend: 0.0,
        vibrato: 0.0,
    }
}
const fn chug(beats: f64, keys: &'static [u8]) -> Hit {
    Hit {
        beats,
        keys,
        muted: true,
        bend: 0.0,
        vibrato: 0.0,
    }
}
const fn sing(beats: f64, keys: &'static [u8], bend: f64, vibrato: f64) -> Hit {
    Hit {
        beats,
        keys,
        muted: false,
        bend,
        vibrato,
    }
}
const E5: &[u8] = &[40, 47, 52];
const G5: &[u8] = &[43, 50, 55];
const A5: &[u8] = &[45, 52, 57];
const C5: &[u8] = &[48, 55, 60];
const B5: &[u8] = &[47, 54, 59];
/// Power chords and palm mutes for two bars, two open chords whose thirds show whether a chord stays defined, then a
/// single-note line with a bend and a held note.
const GUITAR: [Hit; 22] = [
    hit(1.0, E5),
    chug(0.5, E5),
    chug(0.5, E5),
    hit(1.0, G5),
    hit(1.0, A5),
    chug(0.5, A5),
    chug(0.5, A5),
    hit(1.0, C5),
    hit(2.0, B5),
    hit(2.0, &[40, 47, 52, 55, 59, 64]),
    hit(2.0, &[50, 57, 62, 66]),
    hit(0.5, &[64]),
    hit(0.5, &[67]),
    hit(0.5, &[69]),
    hit(0.5, &[71]),
    hit(0.5, &[74]),
    sing(1.0, &[76], 0.0, 0.3),
    hit(0.5, &[74]),
    hit(0.5, &[71]),
    hit(1.0, &[69]),
    sing(1.0, &[69], 2.0, 0.0),
    sing(1.5, &[64], 0.0, 0.3),
];
const BASS: [Hit; 22] = [
    hit(1.0, &[28]),
    chug(0.5, &[28]),
    chug(0.5, &[28]),
    hit(1.0, &[31]),
    hit(1.0, &[33]),
    chug(0.5, &[33]),
    chug(0.5, &[33]),
    hit(1.0, &[36]),
    hit(2.0, &[35]),
    hit(2.0, &[28, 35]),
    hit(2.0, &[38, 45]),
    hit(0.5, &[40]),
    hit(0.5, &[43]),
    hit(0.5, &[45]),
    hit(0.5, &[47]),
    hit(0.5, &[50]),
    sing(1.0, &[52], 0.0, 0.2),
    hit(0.5, &[50]),
    hit(0.5, &[47]),
    hit(1.0, &[45]),
    sing(1.0, &[45], 2.0, 0.0),
    sing(1.5, &[40], 0.0, 0.2),
];

fn plan(riff: &[Hit], program: u8) -> PlaybackPlan {
    let (mut tick, mut notes, mut index) = (0.0, vec![], 0);
    for step in riff {
        let end = tick + step.beats * PPQ;
        for (string, &key) in step.keys.iter().enumerate() {
            let mut pitch = vec![json!({"tick":tick,"semitones":0})];
            if step.bend != 0.0 {
                pitch.push(json!({"tick":tick+(end-tick)/3.0,"semitones":step.bend}));
                pitch.push(json!({"tick":end,"semitones":step.bend}));
            }
            if step.vibrato != 0.0 {
                let mut at = tick + PPQ / 4.0;
                let mut up = true;
                while at < end {
                    pitch.push(
                        json!({"tick":at,"semitones":if up {step.vibrato} else {-step.vibrato}}),
                    );
                    at += PPQ / 8.0;
                    up = !up;
                }
            }
            notes.push(json!({
                "id":format!("n{index}"),"trackId":"t",
                "source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":index},"string":string+1},
                "occurrence":0,"startTick":tick,"endTick":end,"key":key,
                "velocity":if step.keys.len() > 1 || step.muted {112} else {104},
                "articulation":if step.muted {"muted"} else {"picked"},"legatoFrom":null,"pitch":pitch
            }));
            index += 1;
        }
        tick = end;
    }
    let total = BARS * 4.0 * PPQ;
    serde_json::from_value(json!({
        "generation":1,"ppq":960,"durationTick":total,"durationMs":SOUNDING_SECONDS*1000.0,
        "tracks":[{"id":"t","program":program,"percussion":false}],
        "tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":total,"startMs":0,"endMs":SOUNDING_SECONDS*1000.0}],
        "notes":notes,"midi":[]
    }))
    .unwrap()
}

fn catalog() -> Vec<Value> {
    serde_json::from_str(include_str!("../../../tests/factory-sounds.json")).unwrap()
}
/// The factory sound `id`'s effects, if the catalog this build carries has it.
fn factory(id: &str) -> Option<FxSettings> {
    let entry = catalog().into_iter().find(|entry| entry["id"] == id)?;
    Some(serde_json::from_value(entry["effects"].clone()).unwrap())
}
/// The chain closest to a driven bass before it had a factory sound: the bass amp pushed by an overdrive.
fn old_driven_bass() -> FxSettings {
    let mut fx = FxSettings::preset("bass").unwrap();
    fx.drive.enabled = true;
    fx.drive.drive = 0.5;
    fx.amp.drive = 0.8;
    fx
}
/// The compared sounds: the file name, the factory sound, and the program that picks its sample voice.
const SOUNDS: [(&str, &str, u8); 6] = [
    ("overdrive", "blues-crunch", 30),
    ("crunch", "classic-rock", 30),
    ("lead", "rock-lead", 30),
    ("high-gain-metal", "metal-rhythm", 30),
    ("fuzz", "fuzz-lead", 30),
    ("driven-bass", "driven-bass", 33),
];
fn sound_effects(id: &str) -> FxSettings {
    factory(id).unwrap_or_else(old_driven_bass)
}
fn riff_for(program: u8) -> PlaybackPlan {
    if program >= 32 {
        plan(&BASS, program)
    } else {
        plan(&GUITAR, program)
    }
}
fn audio_root() -> PathBuf {
    std::env::var_os("TONE_AUDIO")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"))
}
fn output_folder() -> PathBuf {
    let folder = std::env::var_os("TONE_AB_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("tabplayer-tone-ab"));
    std::fs::create_dir_all(&folder).unwrap();
    folder
}
fn settings_for(effects: FxSettings) -> DocumentSettings {
    let mut settings = DocumentSettings::default();
    settings.sounds.insert(
        "t".into(),
        TrackSound {
            voice_id: None,
            preset_id: "crunch".into(),
            effects,
            ..Default::default()
        },
    );
    settings
}
/// The riff's stereo output through `effects`.
fn render(plan: &PlaybackPlan, effects: FxSettings) -> Vec<[f32; 2]> {
    let settings = settings_for(effects);
    let resources =
        AudioResources::load_for_requests(&audio_root(), &resource_requests(plan, &settings))
            .unwrap();
    let mut renderer =
        Renderer::new(Arc::new(plan.clone()), Arc::new(resources), settings, RATE).unwrap();
    let frames = ((SOUNDING_SECONDS + TAIL_SECONDS) * RATE as f64) as usize;
    let mut output = vec![[0.0f32; 2]; frames];
    renderer.render_into(&mut output);
    output
}
fn write_wav(path: &std::path::Path, frames: &[[f32; 2]]) {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: RATE,
        bits_per_sample: 24,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for frame in frames {
        for &value in frame {
            writer
                .write_sample((value.clamp(-1.0, 1.0) as f64 * 8_388_607.0) as i32)
                .unwrap();
        }
    }
    writer.finalize().unwrap();
}

/// A radix-2 FFT in place, for the measurements below.
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
        let angle = -std::f64::consts::TAU / len as f64;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (s, c) = (angle * k as f64).sin_cos();
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * c - im[b] * s, re[b] * s + im[b] * c);
                (re[b], im[b]) = (re[a] - tr, im[a] - ti);
                (re[a], im[a]) = (re[a] + tr, im[a] + ti);
            }
        }
        len <<= 1;
    }
}
/// The long-term power spectrum of `mono`, by Hann-windowed frames of `size`.
fn spectrum(mono: &[f64], size: usize) -> Vec<f64> {
    let window: Vec<f64> = (0..size)
        .map(|n| 0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / size as f64).cos())
        .collect();
    let mut sum = vec![0.0; size / 2];
    let mut count = 0.0;
    for frame in mono.chunks_exact(size / 2).collect::<Vec<_>>().windows(2) {
        let mut re: Vec<f64> = frame[0]
            .iter()
            .chain(frame[1])
            .zip(&window)
            .map(|(x, w)| x * w)
            .collect();
        let mut im = vec![0.0; size];
        fft(&mut re, &mut im);
        for k in 0..size / 2 {
            sum[k] += re[k] * re[k] + im[k] * im[k];
        }
        count += 1.0;
    }
    sum.iter().map(|p| p / count).collect()
}
/// Band levels in dB against the 1 kHz band, in the octave and third bands that show a guitar's balance.
fn balance(mono: &[f64]) -> String {
    let size = 8192;
    let power = spectrum(mono, size);
    let band = |hz: f64| {
        let (low, high) = (hz / 2f64.powf(1.0 / 6.0), hz * 2f64.powf(1.0 / 6.0));
        let bin = RATE as f64 / size as f64;
        let (a, b) = ((low / bin) as usize, (high / bin).ceil() as usize);
        power[a..b.min(size / 2)].iter().sum::<f64>().max(1e-30)
    };
    let reference = band(1_000.0);
    [
        80.0, 125.0, 250.0, 500.0, 2_000.0, 3_150.0, 4_000.0, 5_000.0, 6_300.0, 8_000.0, 10_000.0,
        16_000.0,
    ]
    .map(|hz: f64| {
        format!(
            "{}:{:+.0}",
            hz as u32,
            10.0 * (band(hz) / reference).log10()
        )
    })
    .join(" ")
}
/// A BS.1770 K-weighted level of the sounding part in LU, ungated: the head and high-pass biquads at 48 kHz.
fn loudness(frames: &[[f32; 2]]) -> f64 {
    let run = |input: &[f64], b: [f64; 3], a: [f64; 2]| -> Vec<f64> {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        input
            .iter()
            .map(|&x| {
                let y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
                (x2, x1, y2, y1) = (x1, x, y1, y);
                y
            })
            .collect()
    };
    let mut total = 0.0;
    for c in 0..2 {
        let channel: Vec<f64> = frames.iter().map(|f| f[c] as f64).collect();
        let shelf = run(
            &channel,
            [1.53512485958697, -2.69169618940638, 1.19839281085285],
            [-1.69065929318241, 0.73248077421585],
        );
        let weighted = run(
            &shelf,
            [1.0, -2.0, 1.0],
            [-1.99004745483398, 0.99007225036621],
        );
        total += weighted.iter().map(|v| v * v).sum::<f64>() / weighted.len() as f64;
    }
    -0.691 + 10.0 * total.max(1e-30).log10()
}
fn report(name: &str, frames: &[[f32; 2]]) {
    let sounding = &frames[..(SOUNDING_SECONDS * RATE as f64) as usize];
    let mono: Vec<f64> = sounding
        .iter()
        .map(|f| (f[0] as f64 + f[1] as f64) * 0.5)
        .collect();
    let peak = frames
        .iter()
        .flatten()
        .fold(0.0f32, |most, v| most.max(v.abs()));
    let rms = (mono.iter().map(|v| v * v).sum::<f64>() / mono.len() as f64).sqrt();
    let tail = &frames[frames.len() - RATE as usize / 2..];
    let tail_rms = (tail.iter().flatten().map(|v| (v * v) as f64).sum::<f64>()
        / (2 * tail.len()) as f64)
        .sqrt();
    println!(
        "{name:<24} peak {peak:.3}  rms {:6.1} dB  loudness {:6.1} LU  tail {:6.1} dB",
        20.0 * rms.max(1e-12).log10(),
        loudness(sounding),
        20.0 * tail_rms.max(1e-12).log10()
    );
    println!("    {}", balance(&mono));
}

/// Reads a mono impulse response of any common WAV format.
fn read_impulse(path: &std::path::Path) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).unwrap();
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(Result::unwrap).collect(),
        hound::SampleFormat::Int => {
            let scale = 2f32.powi(spec.bits_per_sample as i32 - 1);
            reader
                .samples::<i32>()
                .map(|v| v.unwrap() as f32 / scale)
                .collect()
        }
    };
    assert_eq!(
        spec.sample_rate, RATE,
        "the impulse response must be at 48 kHz"
    );
    samples
        .chunks(spec.channels as usize)
        .map(|frame| frame[0])
        .collect()
}
/// Runs `effects` without its cabinet, convolves with the impulse response where the cabinet stands, and passes the
/// result through the blocks after it, so only the cabinet differs from the same sound's `-new.wav`.
fn with_impulse(plan: &PlaybackPlan, effects: &FxSettings, impulse: &[f32]) -> Vec<[f32; 2]> {
    let (mut before, mut after) = (effects.clone(), effects.clone());
    before.cabinet.enabled = false;
    (
        before.eq.enabled,
        before.graphic_eq.enabled,
        before.vibrato.enabled,
        before.phaser.enabled,
        before.flanger.enabled,
        before.chorus.enabled,
        before.tremolo.enabled,
        before.delay.enabled,
        before.reverb.enabled,
    ) = (
        false, false, false, false, false, false, false, false, false,
    );
    (
        after.microphone.enabled,
        after.gate.enabled,
        after.compressor.enabled,
        after.wah.enabled,
        after.octaver.enabled,
        after.pitch.enabled,
        after.drive.enabled,
        after.amp.enabled,
        after.cabinet.enabled,
    ) = (
        false, false, false, false, false, false, false, false, false,
    );
    let dry = render(plan, before);
    let size = (dry.len() + impulse.len()).next_power_of_two();
    let mut wet = vec![[0.0f32; 2]; dry.len()];
    let (mut ir_re, mut ir_im) = (vec![0.0; size], vec![0.0; size]);
    ir_re[..impulse.len()].copy_from_slice(&impulse.iter().map(|&v| v as f64).collect::<Vec<_>>());
    fft(&mut ir_re, &mut ir_im);
    for c in 0..2 {
        let (mut re, mut im) = (vec![0.0; size], vec![0.0; size]);
        for (n, frame) in dry.iter().enumerate() {
            re[n] = frame[c] as f64;
        }
        fft(&mut re, &mut im);
        for k in 0..size {
            let (a, b) = (re[k], im[k]);
            re[k] = a * ir_re[k] - b * ir_im[k];
            im[k] = a * ir_im[k] + b * ir_re[k];
        }
        // The inverse through the forward transform, with the imaginary part negated.
        im.iter_mut().for_each(|v| *v = -*v);
        fft(&mut re, &mut im);
        for (n, frame) in wet.iter_mut().enumerate() {
            frame[c] = (re[n] / size as f64) as f32;
        }
    }
    let mut dsp = TrackDsp::new(after, RATE, 16.0).unwrap();
    wet.iter().map(|frame| dsp.process(*frame, 120.0)).collect()
}

fn render_all(tag: &str) {
    let folder = output_folder();
    for (name, id, program) in SOUNDS {
        let frames = render(&riff_for(program), sound_effects(id));
        report(&format!("{name}-{tag}"), &frames);
        write_wav(&folder.join(format!("{name}-{tag}.wav")), &frames);
    }
}
fn render_impulse() {
    let path = PathBuf::from(
        std::env::var_os("TONE_IR_PATH").expect("TONE_IR_PATH names the impulse response"),
    );
    let impulse = read_impulse(&path);
    let folder = output_folder();
    for (name, id, program) in SOUNDS {
        let plan = riff_for(program);
        let effects = sound_effects(id);
        let reference = render(&plan, effects.clone());
        let mut frames = with_impulse(&plan, &effects, &impulse);
        // Matched in level to the same sound's `-new.wav`, so only the tone differs.
        let shift = 10f64.powf((loudness(&reference) - loudness(&frames)) / 20.0) as f32;
        frames
            .iter_mut()
            .flatten()
            .for_each(|v| *v = master_limit(*v * shift));
        report(&format!("{name}-new-ir"), &frames);
        write_wav(&folder.join(format!("{name}-new-ir.wav")), &frames);
    }
}
/// Writes the raw PCM of every sound that must not change, through the real voices.
fn dump_clean(folder: &str) {
    std::fs::create_dir_all(folder).unwrap();
    for entry in catalog() {
        let id = entry["id"].as_str().unwrap();
        let clean = entry["effects"]["amp"]["model"] == "clean"
            || !entry["effects"]["amp"]["enabled"]
                .as_bool()
                .unwrap_or(false)
            || entry["effects"]["amp"]["model"] == "bass";
        if !clean {
            continue;
        }
        let program = if entry["effects"]["amp"]["model"] == "bass" {
            33
        } else {
            25
        };
        let effects: FxSettings = serde_json::from_value(entry["effects"].clone()).unwrap();
        let frames = render(&riff_for(program), effects);
        let bytes: Vec<u8> = frames
            .iter()
            .flatten()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        std::fs::write(format!("{folder}/{id}.f32"), bytes).unwrap();
        println!("{id}");
    }
}
/// Real-time load of one track of each sound on the dry riff, playing centred and panned. A voice reaches the chain as
/// exact mono unless it is panned, so a centred track runs one channel and a panned one both, the worst case.
fn bench() {
    let plan = plan(&GUITAR, 30);
    let centred = render(&plan, FxSettings::default());
    let panned: Vec<[f32; 2]> = centred.iter().map(|f| [f[0], f[1] * 0.7]).collect();
    for id in [
        "clean-default",
        "blues-crunch",
        "classic-rock",
        "rock-lead",
        "metal-rhythm",
        "fuzz-lead",
    ] {
        let effects = if id == "clean-default" {
            FxSettings::preset("clean").unwrap()
        } else {
            factory(id).unwrap()
        };
        let load = |dry: &[[f32; 2]]| {
            let mut best = f64::INFINITY;
            for _ in 0..5 {
                let mut dsp = TrackDsp::new(effects.clone(), RATE, 16.0).unwrap();
                let started = Instant::now();
                let mut guard = 0.0f32;
                for _ in 0..4 {
                    for frame in dry {
                        guard += dsp.process(*frame, 120.0)[0];
                    }
                }
                std::hint::black_box(guard);
                best = best.min(started.elapsed().as_secs_f64());
            }
            100.0 * best / (4.0 * dry.len() as f64 / RATE as f64)
        };
        println!(
            "{id:<16} {:6.2}% of one core centred, {:6.2}% panned",
            load(&centred),
            load(&panned)
        );
    }
}
/// Real-time load of a full mix on one core: every track running the heaviest driven sound at once, as the audio callback
/// runs them in turn. `warm` readies each track, and each then plays its own part of `timed`. `rests` allows the shortcuts.
fn mix_load(
    board: &FxSettings,
    tracks: usize,
    warm: &[[f32; 2]],
    timed: &[&[[f32; 2]]],
    rests: bool,
) -> f64 {
    let frames = RATE as usize * 3;
    let mut best = f64::INFINITY;
    for _ in 0..3 {
        let mut dsps: Vec<TrackDsp> = (0..tracks)
            .map(|_| TrackDsp::new(board.clone(), RATE, 16.0).unwrap())
            .collect();
        for dsp in &mut dsps {
            if !rests {
                dsp.never_rest();
            }
            for frame in warm {
                dsp.process(*frame, 120.0);
            }
        }
        let mut guard = 0.0f32;
        let started = Instant::now();
        for frame in 0..frames {
            for (index, dsp) in dsps.iter_mut().enumerate() {
                let part = timed[index % timed.len()];
                guard += dsp.process(part[frame % part.len()], 120.0)[0];
            }
        }
        best = best.min(started.elapsed().as_secs_f64());
        std::hint::black_box(guard);
    }
    100.0 * best / (frames as f64 / RATE as f64)
}
/// The figures for eight and sixteen tracks. Sounding tracks hold the riff's real gaps; a silent one has played and died away.
fn mix_bench() {
    let plan = plan(&GUITAR, 30);
    let centred = render(&plan, FxSettings::default());
    let panned: Vec<[f32; 2]> = centred.iter().map(|f| [f[0], f[1] * 0.7]).collect();
    let note = &panned[..RATE as usize / 2];
    let silence = vec![[0.0f32; 2]; RATE as usize * 3];
    let drained: Vec<[f32; 2]> = note.iter().chain(&silence).copied().collect();
    let board = factory("metal-rhythm").unwrap();
    let mut duplicated = board.clone();
    duplicated.second = Some(Box::new(board.clone()));
    for tracks in [8, 16] {
        let row = |name: &str, board: &FxSettings, warm: &[[f32; 2]], timed: &[&[[f32; 2]]]| {
            println!(
                "{tracks:>2} tracks, {name:<44} {:6.1}% of one core",
                mix_load(board, tracks, warm, timed, true)
            );
        };
        row("all sounding, centred", &board, &[], &[&centred]);
        row("all sounding, panned", &board, &[], &[&panned]);
        row(
            "all sounding, panned, duplicate boards",
            &duplicated,
            &[],
            &[&panned],
        );
        row(
            "a quarter sounding, the rest silent",
            &board,
            &drained,
            &[&centred, &silence, &silence, &silence],
        );
        row("all silent, tails finished", &board, &drained, &[&silence]);
        println!(
            "{tracks:>2} tracks, {:<44} {:6.1}% of one core",
            "all silent, tails finished, shortcut off",
            mix_load(&board, tracks, &drained, &[&silence], false)
        );
        row(
            "all panned once, centred again",
            &board,
            &drained,
            &[&centred],
        );
        println!(
            "{tracks:>2} tracks, {:<44} {:6.1}% of one core",
            "all panned once, centred again, shortcut off",
            mix_load(&board, tracks, &drained, &[&centred], false)
        );
    }
}
/// The bench figures of each driven sound as the app plays it, with its time-based blocks and gate off, which would
/// otherwise measure themselves.
fn measure_all() {
    for (name, id, _) in SOUNDS {
        let mut effects = sound_effects(id);
        effects.gate.enabled = false;
        effects.delay.enabled = false;
        effects.reverb.enabled = false;
        effects.phaser.enabled = false;
        effects.chorus.enabled = false;
        let make = || {
            let mut dsp = TrackDsp::new(effects.clone(), RATE, 1.0).unwrap();
            move |x: f32| dsp.process([x; 2], 120.0)[0]
        };
        println!("{name}");
        print!("{}", measure::survey(make));
        println!(
            "  alias 1319 Hz {:.1} dB, 2637 Hz {:.1} dB; low third intermodulation 0.08 {:.1} dB, 0.25 {:.1} dB",
            measure::alias_db(make(), RATE as f64, 1_318.51, 0.1),
            measure::alias_db(make(), RATE as f64, 2_637.02, 0.1),
            measure::intermod_db(make(), RATE as f64, 0.08),
            measure::intermod_db(make(), RATE as f64, 0.25)
        );
    }
}
/// Every factory sound's loudness on the riff, to compare the driven sounds with the clean ones.
fn levels() {
    for entry in catalog() {
        let id = entry["id"].as_str().unwrap();
        let effects: FxSettings = serde_json::from_value(entry["effects"].clone()).unwrap();
        let program = match entry["presetId"].as_str() {
            Some("bass") => 33,
            Some("crunch" | "lead") => 30,
            _ => 25,
        };
        let frames = render(&riff_for(program), effects);
        println!(
            "{id:<18} {:6.1} LU",
            loudness(&frames[..(SOUNDING_SECONDS * RATE as f64) as usize])
        );
    }
}
/// The levels the samples reach the chain at, by section of the riff.
fn input() {
    for (name, program, riff) in [
        ("guitar", 30u8, &GUITAR),
        ("clean guitar", 25, &GUITAR),
        ("bass", 33, &BASS),
    ] {
        let frames = render(&plan(riff, program), FxSettings::default());
        report(name, &frames);
        let stereo: f64 = frames
            .iter()
            .map(|f| (f[0] as f64 - f[1] as f64).abs())
            .sum::<f64>()
            / frames.len() as f64;
        println!("    mean |L-R| {stereo:.6}");
        for (label, from, to) in [
            ("power chords", 0.0, 4.0),
            ("open chords", 4.0, 6.0),
            ("single notes", 6.0, 10.0),
            ("tail", 10.5, 11.5),
        ] {
            let part = &frames[(from * RATE as f64) as usize..(to * RATE as f64) as usize];
            let peak = part
                .iter()
                .flatten()
                .fold(0.0f32, |most, v| most.max(v.abs()));
            let rms = (part.iter().flatten().map(|v| (v * v) as f64).sum::<f64>()
                / (2 * part.len()) as f64)
                .sqrt();
            println!("    {label:<14} peak {peak:.4}  rms {rms:.4}");
        }
    }
}
/// Writes the dry riffs as raw PCM, for tuning away from this build.
fn dump_dry(folder: &str) {
    std::fs::create_dir_all(folder).unwrap();
    for (name, program, riff) in [
        ("guitar", 30u8, &GUITAR),
        ("green", 25, &GUITAR),
        ("bass", 33, &BASS),
    ] {
        let frames = render(&plan(riff, program), FxSettings::default());
        let bytes: Vec<u8> = frames
            .iter()
            .flatten()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        std::fs::write(format!("{folder}/{name}.f32"), bytes).unwrap();
    }
}
/// The cost of a loaded cabinet response against the built-in cabinet the sound has, in percent of one core, for eight
/// tracks. The responses are synthesized here: a click and low-passed noise that dies away, of each length.
fn ir_bench() {
    use tabplayer_lib::audio::{cabinet_ir, dsp::CabinetIr};
    let plan = plan(&GUITAR, 30);
    let centred = render(&plan, FxSettings::default());
    let panned: Vec<[f32; 2]> = centred.iter().map(|f| [f[0], f[1] * 0.7]).collect();
    let library = cabinet_ir::install(std::env::temp_dir().join("tabplayer-ir-bench"), None);
    let board = factory("metal-rhythm").unwrap();
    let tracks = 8;
    let load =
        |board: &FxSettings, timed: &[[f32; 2]]| mix_load(board, tracks, &[], &[timed], true);
    let (built_in_centred, built_in_panned) = (load(&board, &centred), load(&board, &panned));
    println!(
        "{tracks} tracks, metal-rhythm with its built-in {} cabinet: {built_in_centred:5.1}% centred, {built_in_panned:5.1}% panned",
        board.cabinet.model
    );
    for seconds in [0.1, 0.2, 0.5, 1.0] {
        let length = (RATE as f64 * seconds) as usize;
        let mut state = 0x2545_f491u32;
        let mut low = 0.0f32;
        let samples: Vec<f32> = (0..length)
            .map(|n| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                low += 0.45 * ((state as f32 / u32::MAX as f32 * 2.0 - 1.0) - low);
                low * (-(n as f32) / (0.2 * length as f32)).exp() * 0.25
                    + if n == 0 { 0.6 } else { 0.0 }
            })
            .collect();
        let mut bytes = Vec::new();
        for v in &samples {
            bytes.extend_from_slice(&((v * 8_388_607.0) as i32).to_le_bytes()[..3]);
        }
        let mut file = b"RIFF".to_vec();
        file.extend_from_slice(&(36 + bytes.len() as u32).to_le_bytes());
        file.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
        file.extend_from_slice(&RATE.to_le_bytes());
        file.extend_from_slice(&(RATE * 3).to_le_bytes());
        file.extend_from_slice(b"\x03\0\x18\0data");
        file.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        file.extend_from_slice(&bytes);
        let entry = library.import_bytes(&file, "bench.wav").unwrap();
        let mut with = board.clone();
        with.cabinet.ir = Some(CabinetIr {
            id: entry.id,
            name: "bench".into(),
            level_db: 0.0,
        });
        let (c, p) = (load(&with, &centred), load(&with, &panned));
        println!(
            "{tracks} tracks, response of {seconds:.1} s ({length} taps): {c:5.1}% centred ({:+5.1} per track), {p:5.1}% panned ({:+5.1} per track)",
            (c - built_in_centred) / tracks as f64,
            (p - built_in_panned) / tracks as f64
        );
    }
}
/// Cost of one NAM capture through the inference engine alone, after prewarm, on a quiet riff-like tone.
fn nam_bench(path: &str) {
    let bytes = if path == "synthetic" {
        synthetic_standard_nam()
    } else {
        std::fs::read(path).unwrap()
    };
    nam_bench_bytes(path, &bytes);
}
/// A standard-size A1 model (channels 16/8, head 8/1, dilations 1..512 twice) with pseudo-random weights.
fn synthetic_standard_nam() -> Vec<u8> {
    use tabplayer_lib::audio::nam::{NamError, parse_nam};
    let dilations: Vec<u32> = (0..10).map(|i| 1 << i).collect();
    let array = |input: u32, channels: u32, head: u32, bias: bool| {
        json!({"input_size": input, "condition_size": 1, "head_size": head, "channels": channels,
            "kernel_size": 3, "dilations": dilations, "activation": "Tanh", "gated": false, "head_bias": bias})
    };
    let mut model = json!({"version": "0.5.4", "architecture": "WaveNet",
        "config": {"layers": [array(1, 16, 8, false), array(16, 8, 1, true)], "head": null, "head_scale": 0.02},
        "weights": [], "sample_rate": 48000});
    let Err(NamError::WeightCount { expected, .. }) =
        parse_nam(&serde_json::to_vec(&model).unwrap())
    else {
        panic!("expected a weight count refusal")
    };
    let mut seed = 1u64;
    let weights: Vec<f64> = (0..expected)
        .map(|_| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (((seed >> 40) as f64) / (1u64 << 24) as f64 - 0.5) * 0.4
        })
        .collect();
    model["weights"] = json!(weights);
    serde_json::to_vec(&model).unwrap()
}
fn nam_bench_bytes(path: &str, bytes: &[u8]) {
    use tabplayer_lib::audio::nam::{
        NamModel, NamState, cost_per_sample, macs_per_sample, parse_nam,
    };
    let file = parse_nam(bytes).unwrap();
    let macs = macs_per_sample(file.spec());
    let cost = cost_per_sample(file.spec());
    let model = NamModel::build(&file);
    let mut state = NamState::new(&model);
    let prewarm_started = Instant::now();
    state.prewarm(&model);
    let prewarm_ms = prewarm_started.elapsed().as_secs_f64() * 1e3;
    let samples = RATE as usize * 10;
    let input: Vec<f32> = (0..samples)
        .map(|i| 0.3 * (i as f32 * 0.0287).sin() * (i as f32 * 0.00031).sin())
        .collect();
    let mut best = f64::INFINITY;
    let mut guard = 0.0f32;
    for _ in 0..5 {
        let started = Instant::now();
        for &x in &input {
            guard += state.process(&model, x);
        }
        best = best.min(started.elapsed().as_secs_f64());
    }
    let per_sample = best / samples as f64 * 1e6;
    println!(
        "{path}: {per_sample:.3} us/sample, {:.1}x real time at {} Hz, {macs} MACs/sample, {cost} estimated cost units/sample, {:.3} ns per unit, prewarm {prewarm_ms:.0} ms ({} samples) (check {guard:.3})",
        samples as f64 / RATE as f64 / best,
        model.model_rate(),
        per_sample * 1e3 / cost as f64,
        model.prewarm_samples()
    );
}
fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["render", tag] => render_all(tag),
        ["ir"] => render_impulse(),
        ["clean", folder] => dump_clean(folder),
        ["dry", folder] => dump_dry(folder),
        ["bench"] => bench(),
        ["mix-bench"] => mix_bench(),
        ["ir-bench"] => ir_bench(),
        ["nam-bench", path] => nam_bench(path),
        ["input"] => input(),
        ["measure"] => measure_all(),
        ["levels"] => levels(),
        _ => eprintln!(
            "usage: tone_ab render <tag> | ir | clean <folder> | dry <folder> | bench | mix-bench | ir-bench | nam-bench <file> | input | measure | levels"
        ),
    }
}
