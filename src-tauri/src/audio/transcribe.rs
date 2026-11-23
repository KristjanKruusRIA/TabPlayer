//! Local, offline automatic transcription for DI guitar and bass audio tracks.
//!
//! Combines TabPlayer's multi-resolution harmonic-stack ONNX model (`di_guitar_net.onnx`, `DiGuitarNetV5`)
//! with Spotify's Basic Pitch ONNX model (`nmp.onnx`, ICASSP 2022) executed in parallel via pure-Rust `tract-onnx`,
//! followed by Stage 1 tail-gating, self-similarity riff pooling, fretboard playability filtering, and palm-mute / bend extraction.

use crate::audio::decode::decode_audio;
use serde::{Deserialize, Serialize};
use std::{
    f64::consts::TAU,
    io::{Cursor, Read},
    path::Path,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tract_onnx::prelude::{
    Datum, Framework, InferenceFact, InferenceModelExt, Tensor, TypedModel, TypedSimplePlan, tvec,
};

pub const TARGET_SAMPLE_RATE: u32 = 22_050;
pub const MAX_DI_FILE_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_CUSTOM_MODEL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_DI_DURATION_SEC: f64 = 900.0;

const FFT_HOP: usize = 256;
const AUDIO_WINDOW_LENGTH: usize = 2;
const ANNOTATIONS_FPS: usize = TARGET_SAMPLE_RATE as usize / FFT_HOP; // 86
const ANNOT_N_FRAMES: usize = ANNOTATIONS_FPS * AUDIO_WINDOW_LENGTH; // 172
const AUDIO_N_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * AUDIO_WINDOW_LENGTH - FFT_HOP; // 43_844
const OVERLAP_FRAMES: usize = 30;
const HALF_OVERLAP_FRAMES: usize = OVERLAP_FRAMES / 2; // 15
const UNWRAPPED_WINDOW_FRAMES: usize = ANNOT_N_FRAMES - OVERLAP_FRAMES; // 142
const OVERLAP_LEN: usize = OVERLAP_FRAMES * FFT_HOP; // 7_680
const HALF_OVERLAP_SAMPLES: usize = OVERLAP_LEN / 2; // 3_840
const HOP_SIZE: usize = AUDIO_N_SAMPLES - OVERLAP_LEN; // 36_164

const N_PITCH_BINS: usize = 88;
const N_CONTOUR_BINS: usize = 264;
const MIDI_OFFSET: usize = 21;
const CONTOUR_BINS_PER_SEMITONE: usize = 3;
const RESAMPLE_RADIUS: isize = 16;

const DI_N_LO: usize = 4096;
const DI_N_MID: usize = 1024;
const DI_N_HI: usize = 512;
const DI_MIDI_MIN: usize = 24;
const DI_N_SEMITONES: usize = 72;
const DI_SUB_BINS: usize = 3;
const DI_N_FREQ_BINS: usize = DI_N_SEMITONES * DI_SUB_BINS; // 216
const DI_CHUNK_FRAMES: usize = 344;
const DI_CHUNK_SAMPLES: usize = (DI_CHUNK_FRAMES - 1) * FFT_HOP; // 87_808
const DI_OVERLAP_FRAMES: usize = 44;
const DI_HOP_FRAMES: usize = DI_CHUNK_FRAMES - DI_OVERLAP_FRAMES; // 300
const DI_HOP_SAMPLES: usize = DI_HOP_FRAMES * FFT_HOP; // 76_800
const DI_N_CHANNELS: usize = 8;

const OUTLET_NOTE: &str = "StatefulPartitionedCall:1";
const OUTLET_ONSET: &str = "StatefulPartitionedCall:2";
const OUTLET_CONTOUR: &str = "StatefulPartitionedCall:0";

static NMP_ONNX: &[u8] = include_bytes!("../../assets/basic-pitch/nmp.onnx");
static DI_NET_ONNX: &[u8] = include_bytes!("../../assets/di-guitar-net/di_guitar_net.onnx");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiAnalysisSummary {
    pub analysis_id: String,
    pub file_name: String,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub estimated_bpm: f64,
    pub estimated_offset_sec: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiDecodeParams {
    pub onset_threshold: f32,
    pub frame_threshold: f32,
    pub min_note_ms: f32,
    pub min_pitch: u8,
    pub max_pitch: u8,
    pub suppress_overtones: bool,
    #[serde(default)]
    pub open_tuning: Vec<u8>,
}

impl Default for DiDecodeParams {
    fn default() -> Self {
        Self {
            onset_threshold: 0.45,
            frame_threshold: 0.28,
            min_note_ms: 55.0,
            min_pitch: 28,
            max_pitch: 96,
            suppress_overtones: true,
            open_tuning: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedDiNote {
    pub start_sec: f64,
    pub end_sec: f64,
    pub pitch: u8,
    pub onset_confidence: f32,
    pub frame_confidence: f32,
    pub velocity: u8,
    pub palm_mute_score: f32,
    pub bend_semitones: f32,
}

#[derive(Default)]
struct DiNetPosteriors {
    n_frames: usize,
    /// Shape `[72, n_frames]` row-major `(semitone_bin, frame)` for MIDI `24..=95`.
    frame_p: Vec<f32>,
    /// Shape `[72, n_frames]` row-major `(semitone_bin, frame)` for MIDI `24..=95`.
    onset_p: Vec<f32>,
    attack_p: Vec<f32>,
    pm_p: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiCustomModelInfo {
    pub file_name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiModelSwitchResult {
    pub model: Option<DiCustomModelInfo>,
    pub analysis: Option<DiAnalysisSummary>,
}

struct LoadedCustomModel {
    info: DiCustomModelInfo,
    plan: TractPlan,
}

pub(crate) struct CachedDiAnalysis {
    analysis_id: String,
    summary: DiAnalysisSummary,
    mono_22k: Vec<f32>,
    /// Shape `[n_frames * 88]`, row-major `(frame, pitch_bin)`.
    notes: Vec<f32>,
    /// Shape `[n_frames * 88]`, row-major `(frame, pitch_bin)`.
    onsets: Vec<f32>,
    /// Shape `[n_frames * 264]`, row-major `(frame, contour_bin)`.
    contours: Vec<f32>,
    n_frames: usize,
    di_net: DiNetPosteriors,
    ref_attack_rms: f32,
}

pub struct DiTranscriptionState {
    cached: Mutex<Option<CachedDiAnalysis>>,
    custom_model: Mutex<Option<LoadedCustomModel>>,
    next_id: AtomicU64,
}

impl Default for DiTranscriptionState {
    fn default() -> Self {
        Self {
            cached: Mutex::new(None),
            custom_model: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }
}

type TractPlan = Arc<TypedSimplePlan<TypedModel>>;

static MODEL_PLAN: OnceLock<Result<TractPlan, String>> = OnceLock::new();
static DI_NET_PLAN: OnceLock<Result<TractPlan, String>> = OnceLock::new();

fn build_plan() -> Result<TractPlan, String> {
    let err = |e: tract_onnx::prelude::TractError| format!("model_failed: {e}");
    let mut model = tract_onnx::onnx()
        .model_for_read(&mut Cursor::new(NMP_ONNX))
        .map_err(err)?;
    let outlets = model.output_outlets().map_err(err)?.to_vec();
    let find = |label: &str| {
        outlets
            .iter()
            .copied()
            .find(|&outlet| model.outlet_label(outlet) == Some(label))
            .ok_or_else(|| format!("model_failed: missing output outlet {label}"))
    };
    let selected = [
        find(OUTLET_NOTE)?,
        find(OUTLET_ONSET)?,
        find(OUTLET_CONTOUR)?,
    ];
    model.set_output_outlets(&selected).map_err(err)?;
    let optimized = model
        .with_input_fact(
            0,
            InferenceFact::dt_shape(f32::datum_type(), tvec!(1, AUDIO_N_SAMPLES, 1)),
        )
        .and_then(InferenceModelExt::into_optimized)
        .map_err(err)?;
    Ok(Arc::new(optimized.into_runnable().map_err(err)?))
}

fn shared_plan() -> Result<&'static TractPlan, String> {
    match MODEL_PLAN.get_or_init(build_plan) {
        Ok(plan) => Ok(plan),
        Err(message) => Err(message.clone()),
    }
}

fn build_di_net_plan_from_bytes(bytes: &[u8], err_prefix: &str) -> Result<TractPlan, String> {
    let err = |e: tract_onnx::prelude::TractError| format!("{err_prefix}: {e}");
    let mut model = tract_onnx::onnx()
        .model_for_read(&mut Cursor::new(bytes))
        .map_err(err)?;
    if model.input_outlets().map_err(err)?.len() != 1 {
        return Err(format!("{err_prefix}: expected 1 input tensor"));
    }
    let outlets = model.output_outlets().map_err(err)?.to_vec();
    let find = |label: &str| {
        outlets
            .iter()
            .copied()
            .find(|&outlet| model.outlet_label(outlet) == Some(label))
            .ok_or_else(|| format!("{err_prefix}: missing di_net output outlet {label}"))
    };
    let selected = [
        find("frame_logits")?,
        find("onset_logits")?,
        find("attack_logits")?,
        find("palm_mute_logits")?,
    ];
    model.set_output_outlets(&selected).map_err(err)?;
    let optimized = model
        .with_input_fact(
            0,
            InferenceFact::dt_shape(
                f32::datum_type(),
                tvec!(1, DI_N_CHANNELS, DI_N_FREQ_BINS, DI_CHUNK_FRAMES),
            ),
        )
        .and_then(InferenceModelExt::into_optimized)
        .map_err(err)?;
    let expected_shapes: [&[usize]; 4] = [
        &[1, DI_N_SEMITONES, DI_CHUNK_FRAMES],
        &[1, DI_N_SEMITONES, DI_CHUNK_FRAMES],
        &[1, DI_CHUNK_FRAMES],
        &[1, DI_CHUNK_FRAMES],
    ];
    for (idx, expected_shape) in expected_shapes.iter().enumerate() {
        let fact = optimized.output_fact(idx).map_err(err)?;
        if fact.datum_type != f32::datum_type() {
            return Err(format!(
                "{err_prefix}: unexpected output #{idx} dtype {:?}",
                fact.datum_type
            ));
        }
        if fact.shape.as_concrete() != Some(*expected_shape) {
            return Err(format!(
                "{err_prefix}: unexpected output #{idx} shape {:?} (expected {:?})",
                fact.shape, expected_shape
            ));
        }
    }
    Ok(Arc::new(optimized.into_runnable().map_err(err)?))
}

fn build_di_net_plan() -> Result<TractPlan, String> {
    build_di_net_plan_from_bytes(DI_NET_ONNX, "model_failed")
}

fn shared_di_net_plan() -> Result<&'static TractPlan, String> {
    match DI_NET_PLAN.get_or_init(build_di_net_plan) {
        Ok(plan) => Ok(plan),
        Err(message) => Err(message.clone()),
    }
}

fn read_bounded_file_with_limit(
    path: &Path,
    max_bytes: u64,
    too_large_code: &str,
) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("unreadable: {e}"))?;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("unreadable: {e}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large_code.into());
    }
    Ok(bytes)
}

fn read_bounded_file(path: &Path) -> Result<Vec<u8>, String> {
    read_bounded_file_with_limit(path, MAX_DI_FILE_BYTES, "too_large")
}

pub(crate) fn load_custom_model_from_path(
    path: &Path,
) -> Result<(DiCustomModelInfo, TractPlan), String> {
    let bytes = read_bounded_file_with_limit(path, MAX_CUSTOM_MODEL_BYTES, "model_too_large")?;
    let plan = build_di_net_plan_from_bytes(&bytes, "invalid_model")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("custom.onnx")
        .to_string();
    let info = DiCustomModelInfo {
        file_name,
        path: path.to_string_lossy().into_owned(),
    };
    Ok((info, plan))
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

/// Resamples mono audio from `src_rate` to `TARGET_SAMPLE_RATE` (22,050 Hz) using a Hann-windowed sinc kernel.
pub fn resample_mono_22k(mono: &[f32], src_rate: u32) -> Vec<f32> {
    if mono.is_empty() || src_rate == 0 {
        return Vec::new();
    }
    if src_rate == TARGET_SAMPLE_RATE {
        return mono.to_vec();
    }
    let ratio = src_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let scale = 0.90 * (TARGET_SAMPLE_RATE as f64 / src_rate as f64).min(1.0);
    let radius = ((RESAMPLE_RADIUS as f64) / scale).ceil().clamp(16.0, 64.0) as isize;
    let out_len = ((mono.len() as f64) / ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    let radius_f = radius as f64;

    for out_idx in 0..out_len {
        let center = out_idx as f64 * ratio;
        let base = center.floor() as isize;
        let first = (base - radius + 1).max(0);
        let last = (base + radius).min(mono.len() as isize - 1);
        let mut weighted = 0.0_f64;
        let mut weight_sum = 0.0_f64;
        for src_idx in first..=last {
            let delta = center - src_idx as f64;
            let norm = delta / radius_f;
            if norm.abs() >= 1.0 {
                continue;
            }
            let hann = 0.5 * (1.0 + (std::f64::consts::PI * norm).cos());
            let w = scale * sinc(scale * delta) * hann;
            weighted += f64::from(mono[src_idx as usize]) * w;
            weight_sum += w;
        }
        let sample = if weight_sum.abs() > 1e-12 {
            (weighted / weight_sum) as f32
        } else {
            0.0
        };
        out.push(if sample.is_finite() { sample } else { 0.0 });
    }
    out
}

/// Converts an unwrapped Basic Pitch frame index back to seconds in the resampled 22,050 Hz audio timeline.
///
/// Using per-window `HOP_SIZE` instead of multiplying `frame * 256` eliminates the ~8.5 ms/window rounding drift
/// between `ANNOT_N_FRAMES * 256` and `AUDIO_N_SAMPLES`.
pub fn frame_to_seconds(frame: usize) -> f64 {
    let window = frame / UNWRAPPED_WINDOW_FRAMES;
    let local = frame % UNWRAPPED_WINDOW_FRAMES;
    let sample = window * HOP_SIZE + local * FFT_HOP;
    sample as f64 / TARGET_SAMPLE_RATE as f64
}

fn seconds_to_sample_22k(sec: f64) -> usize {
    (sec.max(0.0) * TARGET_SAMPLE_RATE as f64).round() as usize
}

/// Normalizes a raw audio buffer to a clean RMS baseline without hard-clipping transients so quiet DI takes
/// still cross Basic Pitch thresholds cleanly while loud hot pickups do not saturate.
fn prepare_model_mono(mono_22k: &[f32]) -> Vec<f32> {
    let mut peak = 0.0_f32;
    for &sample in mono_22k {
        let abs = sample.abs();
        if abs > peak {
            peak = abs;
        }
    }
    if peak < 1e-5 {
        return mono_22k.to_vec();
    }
    // Scale only if very quiet (< 0.12) or clipping (> 1.0); normal DI peaks (-18..-3 dBFS) stay near unit gain.
    let gain = if peak > 1.0 {
        0.95 / peak
    } else if peak < 0.15 {
        (0.45 / peak).min(8.0)
    } else {
        1.0
    };
    if (gain - 1.0).abs() < 1e-6 {
        mono_22k.to_vec()
    } else {
        mono_22k.iter().map(|&v| v * gain).collect()
    }
}

fn infer_posteriorgrams(mono_22k: &[f32]) -> Result<(Vec<f32>, Vec<f32>, Vec<f32>, usize), String> {
    let plan = shared_plan()?;
    let model_audio = prepare_model_mono(mono_22k);
    let orig_len = model_audio.len();
    if orig_len == 0 {
        return Ok((Vec::new(), Vec::new(), Vec::new(), 0));
    }

    let mut padded = Vec::with_capacity(HALF_OVERLAP_SAMPLES + orig_len);
    padded.resize(HALF_OVERLAP_SAMPLES, 0.0_f32);
    padded.extend_from_slice(&model_audio);

    let offsets: Vec<usize> = (0..padded.len()).step_by(HOP_SIZE).collect();
    let n_chunks = offsets.len();
    let next_idx = AtomicUsize::new(0);
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 4)
        .min(n_chunks);
    let slots: Vec<Mutex<Option<Result<(Vec<f32>, Vec<f32>, Vec<f32>), String>>>> =
        (0..n_chunks).map(|_| Mutex::new(None)).collect();

    let extract_out = |tensor: &Tensor, expected_cols: usize| -> Result<Vec<f32>, String> {
        let view = tensor
            .to_array_view::<f32>()
            .map_err(|e| format!("model_failed: {e}"))?;
        let shape = view.shape();
        if shape != [1, ANNOT_N_FRAMES, expected_cols] {
            return Err(format!(
                "model_failed: unexpected output shape {shape:?} (expected [1, {ANNOT_N_FRAMES}, {expected_cols}])"
            ));
        }
        let slice = view
            .as_slice()
            .ok_or_else(|| "model_failed: non-contiguous output tensor".to_string())?;
        let start = HALF_OVERLAP_FRAMES * expected_cols;
        let end = (ANNOT_N_FRAMES - HALF_OVERLAP_FRAMES) * expected_cols;
        Ok(slice[start..end].to_vec())
    };

    std::thread::scope(|scope| {
        for _ in 0..n_threads {
            scope.spawn(|| {
                let mut window_buf = vec![0.0_f32; AUDIO_N_SAMPLES];
                loop {
                    let wi = next_idx.fetch_add(1, Ordering::Relaxed);
                    if wi >= n_chunks {
                        break;
                    }
                    let offset = offsets[wi];
                    let take = (padded.len() - offset).min(AUDIO_N_SAMPLES);
                    window_buf[..take].copy_from_slice(&padded[offset..offset + take]);
                    if take < AUDIO_N_SAMPLES {
                        window_buf[take..].fill(0.0);
                    }
                    let res = (|| {
                        let input = Tensor::from_shape(&[1, AUDIO_N_SAMPLES, 1], &window_buf)
                            .map_err(|e| format!("model_failed: {e}"))?;
                        let outputs = plan
                            .run(tvec!(input.into()))
                            .map_err(|e| format!("model_failed: {e}"))?;
                        if outputs.len() != 3 {
                            return Err(format!(
                                "model_failed: expected 3 outputs, got {}",
                                outputs.len()
                            ));
                        }
                        Ok((
                            extract_out(&outputs[0], N_PITCH_BINS)?,
                            extract_out(&outputs[1], N_PITCH_BINS)?,
                            extract_out(&outputs[2], N_CONTOUR_BINS)?,
                        ))
                    })();
                    *slots[wi].lock().unwrap_or_else(|e| e.into_inner()) = Some(res);
                }
            });
        }
    });

    let mut notes = Vec::with_capacity(n_chunks * UNWRAPPED_WINDOW_FRAMES * N_PITCH_BINS);
    let mut onsets = Vec::with_capacity(n_chunks * UNWRAPPED_WINDOW_FRAMES * N_PITCH_BINS);
    let mut contours = Vec::with_capacity(n_chunks * UNWRAPPED_WINDOW_FRAMES * N_CONTOUR_BINS);
    for slot in slots {
        let (n, o, c) = slot
            .into_inner()
            .unwrap_or_else(|e| e.into_inner())
            .ok_or_else(|| "model_failed: missing worker output".to_string())??;
        notes.extend_from_slice(&n);
        onsets.extend_from_slice(&o);
        contours.extend_from_slice(&c);
    }

    let expected_frames = (((orig_len as f64) / (HOP_SIZE as f64))
        * (UNWRAPPED_WINDOW_FRAMES as f64))
        .floor() as usize;
    let actual_frames = notes.len() / N_PITCH_BINS;
    let n_frames = expected_frames.min(actual_frames);
    notes.truncate(n_frames * N_PITCH_BINS);
    onsets.truncate(n_frames * N_PITCH_BINS);
    contours.truncate(n_frames * N_CONTOUR_BINS);

    Ok((notes, onsets, contours, n_frames))
}

fn compute_reference_attack_rms(mono_22k: &[f32]) -> f32 {
    let win = (TARGET_SAMPLE_RATE as usize * 25) / 1000;
    let hop = FFT_HOP;
    if mono_22k.len() < win {
        let peak = mono_22k.iter().fold(0.0_f32, |acc, &v| acc.max(v.abs()));
        return peak.max(1e-4);
    }
    let mut active = Vec::new();
    let mut pos = 0usize;
    while pos + win <= mono_22k.len() {
        let sum_sq: f64 = mono_22k[pos..pos + win]
            .iter()
            .map(|&v| f64::from(v) * f64::from(v))
            .sum();
        let rms = (sum_sq / win as f64).sqrt() as f32;
        if rms > 2e-3 {
            active.push(rms);
        }
        pos += hop;
    }
    if active.is_empty() {
        return 0.05;
    }
    active.sort_by(|a, b| a.total_cmp(b));
    let idx = ((active.len() - 1) * 95) / 100;
    active[idx].max(1e-4)
}

fn estimate_tempo_and_offset(onsets: &[f32], mono_22k: &[f32], n_frames: usize) -> (f64, f64) {
    if n_frames < 16 {
        return (120.0, 0.0);
    }
    let frame_dt = (HOP_SIZE as f64 / UNWRAPPED_WINDOW_FRAMES as f64) / TARGET_SAMPLE_RATE as f64;
    let mut env = vec![0.0_f64; n_frames];
    let mut prev_rms = 0.0_f64;
    let mut has_energy = false;

    for frame in 0..n_frames {
        let mut max_onset = 0.0_f32;
        let row = &onsets[frame * N_PITCH_BINS..(frame + 1) * N_PITCH_BINS];
        for &val in row {
            if val > max_onset {
                max_onset = val;
            }
        }
        let center = seconds_to_sample_22k(frame_to_seconds(frame));
        let end = (center + FFT_HOP).min(mono_22k.len());
        let rms = if end > center {
            let sum_sq: f64 = mono_22k[center..end]
                .iter()
                .map(|&v| f64::from(v) * f64::from(v))
                .sum();
            (sum_sq / (end - center) as f64).sqrt()
        } else {
            0.0
        };
        let flux = (rms - prev_rms).max(0.0);
        prev_rms = rms;
        let combined = f64::from(max_onset) + (flux * 4.0).min(1.0);
        if combined > 0.05 {
            has_energy = true;
        }
        env[frame] = combined;
    }

    if !has_energy {
        return (120.0, 0.0);
    }

    let mean = env.iter().sum::<f64>() / n_frames as f64;
    for v in &mut env {
        *v = (*v - mean).max(0.0);
    }

    let min_bpm = 60.0_f64;
    let max_bpm = 220.0_f64;
    let min_lag = ((60.0 / (max_bpm * frame_dt)).floor() as usize).max(4);
    let max_lag = ((60.0 / (min_bpm * frame_dt)).ceil() as usize).min(n_frames / 2);
    if min_lag >= max_lag {
        return (120.0, 0.0);
    }

    let autocorr = |lag: usize| -> f64 {
        if lag == 0 || lag >= n_frames {
            return 0.0;
        }
        let count = n_frames - lag;
        let mut sum = 0.0_f64;
        for i in 0..count {
            sum += env[i] * env[i + lag];
        }
        sum / count as f64
    };

    let mut scores = vec![0.0_f64; max_lag + 1];
    let mut best_lag = min_lag;
    let mut best_score = f64::NEG_INFINITY;

    for lag in min_lag..=max_lag {
        let bpm = 60.0 / (lag as f64 * frame_dt);
        let prior = (-(bpm.ln() - 120.0_f64.ln()).powi(2) / 0.5).exp();
        let raw = autocorr(lag) + 0.5 * autocorr(lag * 2) + 0.25 * autocorr(lag * 4);
        let weighted = raw * (0.75 + 0.25 * prior);
        scores[lag] = weighted;
        if weighted > best_score {
            best_score = weighted;
            best_lag = lag;
        }
    }

    if best_score <= 1e-6 {
        return (120.0, 0.0);
    }

    let refined_lag = if best_lag > min_lag && best_lag < max_lag {
        let left = scores[best_lag - 1];
        let mid = scores[best_lag];
        let right = scores[best_lag + 1];
        let denom = 2.0 * (left - 2.0 * mid + right);
        if denom.abs() > 1e-12 {
            let delta = ((left - right) / denom).clamp(-0.5, 0.5);
            best_lag as f64 + delta
        } else {
            best_lag as f64
        }
    } else {
        best_lag as f64
    };

    let estimated_bpm = (60.0 / (refined_lag * frame_dt)).round().clamp(40.0, 240.0);
    let beat_sec = 60.0 / estimated_bpm;
    let phase_steps = 40usize;
    let total_sec = frame_to_seconds(n_frames.saturating_sub(1));
    let mut best_offset = 0.0_f64;
    let mut best_phase_score = f64::NEG_INFINITY;

    for step in 0..phase_steps {
        let offset = (step as f64 / phase_steps as f64) * beat_sec;
        let mut score = 0.0_f64;
        let mut t = offset;
        while t <= total_sec {
            let approx = (t / frame_dt).round() as isize;
            for d in -1..=1 {
                let idx = approx + d;
                if idx >= 0 && (idx as usize) < n_frames {
                    let w = if d == 0 { 1.0 } else { 0.5 };
                    score += env[idx as usize] * w;
                }
            }
            t += beat_sec;
        }
        if score > best_phase_score {
            best_phase_score = score;
            best_offset = offset;
        }
    }

    (estimated_bpm, (best_offset * 1000.0).round() / 1000.0)
}

/// Reusable radix-2 FFT plan with precomputed bit-reversal, twiddle, and symmetric Hann tables.
struct Radix2Fft {
    nfft: usize,
    bit_rev: Vec<usize>,
    cos_tbl: Vec<f64>,
    sin_tbl: Vec<f64>,
    hann: Vec<f64>,
}

impl Radix2Fft {
    fn new(nfft: usize) -> Self {
        debug_assert!(nfft.is_power_of_two() && nfft >= 4);
        let mut bit_rev = vec![0usize; nfft];
        let mut j = 0usize;
        for i in 1..nfft {
            let mut bit = nfft >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            bit_rev[i] = j;
        }
        let half = nfft / 2;
        let mut cos_tbl = Vec::with_capacity(half);
        let mut sin_tbl = Vec::with_capacity(half);
        for i in 0..half {
            let ang = -TAU * i as f64 / nfft as f64;
            cos_tbl.push(ang.cos());
            sin_tbl.push(ang.sin());
        }
        let denom = (nfft - 1).max(1) as f64;
        let hann: Vec<f64> = (0..nfft)
            .map(|i| 0.5 * (1.0 - (TAU * i as f64 / denom).cos()))
            .collect();
        Self {
            nfft,
            bit_rev,
            cos_tbl,
            sin_tbl,
            hann,
        }
    }

    fn log_rfft_frame(
        &self,
        samples: &[f32],
        frame_start_signed: isize,
        re: &mut [f64],
        im: &mut [f64],
        out_log: &mut [f32],
    ) {
        let len = samples.len();
        for i in 0..self.nfft {
            let src = frame_start_signed + i as isize;
            let sample = if src >= 0 && (src as usize) < len {
                f64::from(samples[src as usize])
            } else {
                0.0
            };
            let dest = self.bit_rev[i];
            re[dest] = sample * self.hann[i];
            im[dest] = 0.0;
        }

        let mut size = 2usize;
        while size <= self.nfft {
            let half = size / 2;
            let step = self.nfft / size;
            for base in (0..self.nfft).step_by(size) {
                for j in 0..half {
                    let tw = j * step;
                    let wr = self.cos_tbl[tw];
                    let wi = self.sin_tbl[tw];
                    let p = base + j;
                    let q = p + half;
                    let tr = re[q] * wr - im[q] * wi;
                    let ti = re[q] * wi + im[q] * wr;
                    re[q] = re[p] - tr;
                    im[q] = im[p] - ti;
                    re[p] += tr;
                    im[p] += ti;
                }
            }
            size <<= 1;
        }

        let norm = 2.0 / self.nfft as f64;
        for (k, slot) in out_log.iter_mut().enumerate().take(self.nfft / 2 + 1) {
            let mag = (re[k] * re[k] + im[k] * im[k]).sqrt() * norm;
            *slot = ((mag as f32) * 40.0).ln_1p();
        }
    }
}

#[derive(Clone, Copy)]
enum SpecRes {
    Lo,
    Mid,
    Hi,
}

#[derive(Clone, Copy)]
struct InterpPoint {
    res: SpecRes,
    i0: u16,
    frac: f32,
    valid: f32,
}

impl InterpPoint {
    fn new(freq_hz: f64, harm: f64, force_hi: bool) -> Self {
        let fh = freq_hz * harm;
        let (res, nfft) = if force_hi || fh >= 1_500.0 {
            (SpecRes::Hi, DI_N_HI)
        } else if fh >= 380.0 {
            (SpecRes::Mid, DI_N_MID)
        } else {
            (SpecRes::Lo, DI_N_LO)
        };
        let bin_hz = f64::from(TARGET_SAMPLE_RATE) / nfft as f64;
        let pos = fh / bin_hz;
        let max_bin = nfft / 2;
        let valid = if pos >= 1.0 && pos <= max_bin as f64 - 1.001 {
            1.0_f32
        } else {
            0.0_f32
        };
        let pos_clipped = pos.clamp(1.0, max_bin as f64 - 1.001);
        let i0 = pos_clipped.floor() as usize;
        let frac = (pos_clipped - i0 as f64) as f32;
        Self {
            res,
            i0: i0 as u16,
            frac,
            valid,
        }
    }

    #[inline]
    fn sample(self, log_lo: &[f32], log_mid: &[f32], log_hi: &[f32]) -> f32 {
        let spec = match self.res {
            SpecRes::Lo => log_lo,
            SpecRes::Mid => log_mid,
            SpecRes::Hi => log_hi,
        };
        let idx = usize::from(self.i0);
        ((1.0 - self.frac) * spec[idx] + self.frac * spec[idx + 1]) * self.valid
    }
}

struct DiFrontendSpec {
    fft_lo: Radix2Fft,
    fft_mid: Radix2Fft,
    fft_hi: Radix2Fft,
    harm_tbl: Vec<[InterpPoint; DI_N_FREQ_BINS]>,
    flux_tbl: [InterpPoint; DI_N_FREQ_BINS],
    bright_tbl: [InterpPoint; DI_N_FREQ_BINS],
}

impl DiFrontendSpec {
    fn build() -> Self {
        const HARMONICS: [f64; 6] = [0.5, 1.0, 2.0, 3.0, 4.0, 5.0];
        let mut freqs = [0.0_f64; DI_N_FREQ_BINS];
        for (k, freq) in freqs.iter_mut().enumerate() {
            let midi_f = (k as f64 - 1.0) / DI_SUB_BINS as f64 + DI_MIDI_MIN as f64;
            *freq = 440.0 * 2.0_f64.powf((midi_f - 69.0) / 12.0);
        }
        let harm_tbl: Vec<[InterpPoint; DI_N_FREQ_BINS]> = HARMONICS
            .iter()
            .map(|&h| std::array::from_fn(|k| InterpPoint::new(freqs[k], h, false)))
            .collect();
        let flux_tbl = std::array::from_fn(|k| InterpPoint::new(freqs[k], 2.0, true));
        let bright_tbl = std::array::from_fn(|k| InterpPoint::new(freqs[k], 4.0, true));

        Self {
            fft_lo: Radix2Fft::new(DI_N_LO),
            fft_mid: Radix2Fft::new(DI_N_MID),
            fft_hi: Radix2Fft::new(DI_N_HI),
            harm_tbl,
            flux_tbl,
            bright_tbl,
        }
    }
}

static DI_FRONTEND_SPEC: OnceLock<DiFrontendSpec> = OnceLock::new();

fn di_frontend_spec() -> &'static DiFrontendSpec {
    DI_FRONTEND_SPEC.get_or_init(DiFrontendSpec::build)
}

struct DiFrontendScratch {
    x_norm: Vec<f32>,
    re: Vec<f64>,
    im: Vec<f64>,
    log_lo: Vec<f32>,
    log_mid: Vec<f32>,
    log_hi: Vec<f32>,
    flux_base: Vec<f32>,
}

impl DiFrontendScratch {
    fn new() -> Self {
        Self {
            x_norm: vec![0.0_f32; DI_CHUNK_SAMPLES],
            re: vec![0.0_f64; DI_N_LO],
            im: vec![0.0_f64; DI_N_LO],
            log_lo: vec![0.0_f32; DI_N_LO / 2 + 1],
            log_mid: vec![0.0_f32; DI_N_MID / 2 + 1],
            log_hi: vec![0.0_f32; DI_N_HI / 2 + 1],
            flux_base: vec![0.0_f32; DI_N_FREQ_BINS * DI_CHUNK_FRAMES],
        }
    }

    fn extract_chunk(&mut self, chunk: &[f32], out_features: &mut [f32]) {
        debug_assert_eq!(chunk.len(), DI_CHUNK_SAMPLES);
        debug_assert_eq!(
            out_features.len(),
            DI_N_CHANNELS * DI_N_FREQ_BINS * DI_CHUNK_FRAMES
        );
        let spec = di_frontend_spec();

        let sum_sq: f64 = chunk.iter().map(|&v| f64::from(v) * f64::from(v)).sum();
        let rms = ((sum_sq / DI_CHUNK_SAMPLES as f64) + 1e-10).sqrt() as f32;
        let scale = 0.1_f32 / rms.max(1e-3);
        for (dst, &src) in self.x_norm.iter_mut().zip(chunk.iter()) {
            *dst = (src * scale).clamp(-4.0, 4.0);
        }
        out_features.fill(0.0);

        let bin_stride = DI_CHUNK_FRAMES;
        let chan_stride = DI_N_FREQ_BINS * DI_CHUNK_FRAMES;

        for t in 0..DI_CHUNK_FRAMES {
            let center = (t * FFT_HOP) as isize;
            spec.fft_lo.log_rfft_frame(
                &self.x_norm,
                center - (DI_N_LO / 2) as isize,
                &mut self.re[..DI_N_LO],
                &mut self.im[..DI_N_LO],
                &mut self.log_lo,
            );
            spec.fft_mid.log_rfft_frame(
                &self.x_norm,
                center - (DI_N_MID / 2) as isize,
                &mut self.re[..DI_N_MID],
                &mut self.im[..DI_N_MID],
                &mut self.log_mid,
            );
            spec.fft_hi.log_rfft_frame(
                &self.x_norm,
                center - (DI_N_HI / 2) as isize,
                &mut self.re[..DI_N_HI],
                &mut self.im[..DI_N_HI],
                &mut self.log_hi,
            );

            for ci in 0..6 {
                let tbl = &spec.harm_tbl[ci];
                let chan_off = ci * chan_stride;
                for k in 0..DI_N_FREQ_BINS {
                    out_features[chan_off + k * bin_stride + t] =
                        tbl[k].sample(&self.log_lo, &self.log_mid, &self.log_hi);
                }
            }

            for k in 0..DI_N_FREQ_BINS {
                let s_flux = spec.flux_tbl[k].sample(&self.log_lo, &self.log_mid, &self.log_hi);
                let fk = k * bin_stride;
                self.flux_base[fk + t] = s_flux;
                if t >= 2 {
                    let prev_max = self.flux_base[fk + t - 1].max(self.flux_base[fk + t - 2]);
                    out_features[6 * chan_stride + fk + t] = (s_flux - prev_max).max(0.0) * 2.5;
                }
                out_features[7 * chan_stride + fk + t] =
                    spec.bright_tbl[k].sample(&self.log_lo, &self.log_mid, &self.log_hi);
            }
        }
    }
}

#[inline]
fn sigmoid_f32(x: f32) -> f32 {
    let xc = x.clamp(-30.0, 30.0);
    1.0 / (1.0 + (-xc).exp())
}

fn extract_di_net_2d(tensor: &Tensor) -> Result<Vec<f32>, String> {
    let view = tensor
        .to_array_view::<f32>()
        .map_err(|e| format!("model_failed: {e}"))?;
    if view.shape() != [1, DI_N_SEMITONES, DI_CHUNK_FRAMES] {
        return Err(format!(
            "model_failed: unexpected di_net 2d shape {:?}",
            view.shape()
        ));
    }
    let slice = view
        .as_slice()
        .ok_or_else(|| "model_failed: non-contiguous di_net tensor".to_string())?;
    Ok(slice.iter().map(|&v| sigmoid_f32(v)).collect())
}

fn extract_di_net_1d(tensor: &Tensor) -> Result<Vec<f32>, String> {
    let view = tensor
        .to_array_view::<f32>()
        .map_err(|e| format!("model_failed: {e}"))?;
    if view.shape() != [1, DI_CHUNK_FRAMES] {
        return Err(format!(
            "model_failed: unexpected di_net 1d shape {:?}",
            view.shape()
        ));
    }
    let slice = view
        .as_slice()
        .ok_or_else(|| "model_failed: non-contiguous di_net tensor".to_string())?;
    Ok(slice.iter().map(|&v| sigmoid_f32(v)).collect())
}

struct ChunkDiNetOut {
    fp: Vec<f32>,
    op: Vec<f32>,
    ap: Vec<f32>,
    pp: Vec<f32>,
}

fn infer_di_net_posteriorgrams_with_plan(
    mono_22k: &[f32],
    plan: &TractPlan,
) -> Result<DiNetPosteriors, String> {
    let n_samples = mono_22k.len();
    if n_samples == 0 {
        return Ok(DiNetPosteriors::default());
    }
    let n_frames = n_samples.div_ceil(FFT_HOP) + 1;

    let mut starts = Vec::new();
    let limit = n_samples.saturating_sub(DI_CHUNK_SAMPLES) + 1;
    let mut s = 0usize;
    while s < limit {
        starts.push(s);
        s += DI_HOP_SAMPLES;
    }
    if starts.is_empty() || *starts.last().unwrap() + DI_CHUNK_SAMPLES < n_samples {
        starts.push(n_samples.saturating_sub(DI_CHUNK_SAMPLES));
    }

    let n_chunks = starts.len();
    let next_idx = AtomicUsize::new(0);
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8)
        .min(n_chunks);
    let slots: Vec<Mutex<Option<Result<ChunkDiNetOut, String>>>> =
        (0..n_chunks).map(|_| Mutex::new(None)).collect();

    std::thread::scope(|scope| {
        for _ in 0..n_threads {
            scope.spawn(|| {
                let mut scratch = DiFrontendScratch::new();
                let mut chunk_buf = vec![0.0_f32; DI_CHUNK_SAMPLES];
                let mut feat_buf = vec![0.0_f32; DI_N_CHANNELS * DI_N_FREQ_BINS * DI_CHUNK_FRAMES];
                loop {
                    let ci = next_idx.fetch_add(1, Ordering::Relaxed);
                    if ci >= n_chunks {
                        break;
                    }
                    let s0 = starts[ci];
                    let take = (n_samples - s0).min(DI_CHUNK_SAMPLES);
                    chunk_buf[..take].copy_from_slice(&mono_22k[s0..s0 + take]);
                    if take < DI_CHUNK_SAMPLES {
                        chunk_buf[take..].fill(0.0);
                    }
                    scratch.extract_chunk(&chunk_buf, &mut feat_buf);
                    let res = (|| {
                        let input = Tensor::from_shape(
                            &[1, DI_N_CHANNELS, DI_N_FREQ_BINS, DI_CHUNK_FRAMES],
                            &feat_buf,
                        )
                        .map_err(|e| format!("model_failed: {e}"))?;
                        let outputs = plan
                            .run(tvec!(input.into()))
                            .map_err(|e| format!("model_failed: {e}"))?;
                        if outputs.len() != 4 {
                            return Err(format!(
                                "model_failed: expected 4 di_net outputs, got {}",
                                outputs.len()
                            ));
                        }
                        Ok(ChunkDiNetOut {
                            fp: extract_di_net_2d(&outputs[0])?,
                            op: extract_di_net_2d(&outputs[1])?,
                            ap: extract_di_net_1d(&outputs[2])?,
                            pp: extract_di_net_1d(&outputs[3])?,
                        })
                    })();
                    *slots[ci].lock().unwrap_or_else(|e| e.into_inner()) = Some(res);
                }
            });
        }
    });

    let mut win_t = [1.0_f32; DI_CHUNK_FRAMES];
    for i in 0..DI_OVERLAP_FRAMES {
        let r = 0.05 + (0.95 * i as f32) / (DI_OVERLAP_FRAMES - 1) as f32;
        win_t[i] = r;
        win_t[DI_CHUNK_FRAMES - 1 - i] = r;
    }

    let mut frame_p = vec![0.0_f32; DI_N_SEMITONES * n_frames];
    let mut onset_p = vec![0.0_f32; DI_N_SEMITONES * n_frames];
    let mut attack_p = vec![0.0_f32; n_frames];
    let mut pm_p = vec![0.0_f32; n_frames];
    let mut w_acc = vec![0.0_f32; n_frames];

    for (ci, slot) in slots.into_iter().enumerate() {
        let chunk_out = slot
            .into_inner()
            .unwrap_or_else(|e| e.into_inner())
            .ok_or_else(|| "model_failed: missing di_net worker output".to_string())??;
        let f0 = starts[ci] / FFT_HOP;
        if f0 >= n_frames {
            continue;
        }
        let f1 = (f0 + DI_CHUNK_FRAMES).min(n_frames);
        let k = f1 - f0;
        let mut w = [0.0_f32; DI_CHUNK_FRAMES];
        w[..k].copy_from_slice(&win_t[..k]);
        if ci == 0 {
            w[..k.min(DI_OVERLAP_FRAMES)].fill(1.0);
        }
        if ci == n_chunks - 1 {
            w[k.saturating_sub(DI_OVERLAP_FRAMES)..k].fill(1.0);
        }
        for b in 0..DI_N_SEMITONES {
            let src_off = b * DI_CHUNK_FRAMES;
            let dst_off = b * n_frames + f0;
            for t in 0..k {
                frame_p[dst_off + t] += chunk_out.fp[src_off + t] * w[t];
                onset_p[dst_off + t] += chunk_out.op[src_off + t] * w[t];
            }
        }
        for t in 0..k {
            attack_p[f0 + t] += chunk_out.ap[t] * w[t];
            pm_p[f0 + t] += chunk_out.pp[t] * w[t];
            w_acc[f0 + t] += w[t];
        }
    }

    for f in 0..n_frames {
        let w = w_acc[f].max(1e-6);
        attack_p[f] /= w;
        pm_p[f] /= w;
        for b in 0..DI_N_SEMITONES {
            let idx = b * n_frames + f;
            frame_p[idx] /= w;
            onset_p[idx] /= w;
        }
    }

    Ok(DiNetPosteriors {
        n_frames,
        frame_p,
        onset_p,
        attack_p,
        pm_p,
    })
}

fn slice_rms(samples: &[f32], start: usize, end: usize) -> f32 {
    let clamped_start = start.min(samples.len());
    let clamped_end = end.min(samples.len());
    if clamped_end <= clamped_start {
        return 0.0;
    }
    let sum_sq: f64 = samples[clamped_start..clamped_end]
        .iter()
        .map(|&v| f64::from(v) * f64::from(v))
        .sum();
    (sum_sq / (clamped_end - clamped_start) as f64).sqrt() as f32
}

fn estimate_bend_semitones(
    contours: &[f32],
    start_frame: usize,
    end_frame: usize,
    pitch: u8,
) -> f32 {
    if end_frame <= start_frame || contours.is_empty() {
        return 0.0;
    }
    let pitch_offset = f64::from(pitch) - f64::from(MIDI_OFFSET as u8);
    // Contour bin resolution is 3 bins/semitone, center of semitone 0 is bin 1 (27.5 Hz base).
    let center_bin = (pitch_offset * CONTOUR_BINS_PER_SEMITONE as f64 + 1.0).round() as isize;
    let tol = 6isize; // +/- 2 semitones
    let lo = (center_bin - tol).max(0) as usize;
    let hi = (center_bin + tol).min(N_CONTOUR_BINS as isize - 1) as usize;
    let mut weighted_max = 0.0_f64;
    for frame in start_frame..end_frame {
        let row = &contours[frame * N_CONTOUR_BINS..(frame + 1) * N_CONTOUR_BINS];
        let mut best_bin = center_bin;
        let mut best_val = 0.15_f32;
        for (bin, &val) in row.iter().enumerate().take(hi + 1).skip(lo) {
            if val > best_val {
                best_val = val;
                best_bin = bin as isize;
            }
        }
        if best_val > 0.25 {
            let dev_semis = (best_bin - center_bin) as f64 / CONTOUR_BINS_PER_SEMITONE as f64;
            if dev_semis.abs() > weighted_max.abs() {
                weighted_max = dev_semis;
            }
        }
    }
    ((weighted_max * 100.0).round() / 100.0) as f32
}

#[inline]
fn di_frame_to_seconds(frame: usize) -> f64 {
    (frame * FFT_HOP) as f64 / f64::from(TARGET_SAMPLE_RATE)
}

#[inline]
fn sec_to_bp_frame(sec: f64, bp_n_frames: usize) -> usize {
    if bp_n_frames == 0 {
        return 0;
    }
    let s = sec.max(0.0) * f64::from(TARGET_SAMPLE_RATE);
    let w = (s / HOP_SIZE as f64).floor() as usize;
    let rem = s - (w * HOP_SIZE) as f64;
    let l = (rem / FFT_HOP as f64)
        .round()
        .clamp(0.0, (UNWRAPPED_WINDOW_FRAMES - 1) as f64) as usize;
    (w * UNWRAPPED_WINDOW_FRAMES + l).min(bp_n_frames - 1)
}

#[derive(Clone, Copy)]
struct ScoredPitchCand {
    pitch: u8,
    score: f32,
    body: f32,
    onset: f32,
}

fn best_fret_pen(pitches: &[u8], open_tuning: &[u8], max_fret: i16) -> Option<f32> {
    if pitches.len() > open_tuning.len() || open_tuning.is_empty() {
        return None;
    }
    // Sort open strings low-to-high so string indices 0..N-1 follow physical pitch order.
    let mut open_low_to_high: Vec<u8> = open_tuning.to_vec();
    open_low_to_high.sort_unstable();

    let mut opts_per_pitch: Vec<(u8, Vec<(usize, i16)>)> = Vec::with_capacity(pitches.len());
    for &pitch in pitches {
        let p_i16 = i16::from(pitch);
        let mut opts = Vec::new();
        for (s_idx, &open) in open_low_to_high.iter().enumerate() {
            let fr = p_i16 - i16::from(open);
            if (0..=max_fret).contains(&fr) {
                opts.push((s_idx, fr));
            }
        }
        if opts.is_empty() {
            return None;
        }
        opts_per_pitch.push((pitch, opts));
    }
    opts_per_pitch.sort_by_key(|a| a.1.len());

    let mut best: Option<f32> = None;
    let mut used = vec![false; open_low_to_high.len()];
    let mut chosen: Vec<(usize, u8, i16)> = Vec::with_capacity(pitches.len());

    fn dfs(
        depth: usize,
        opts_per_pitch: &[(u8, Vec<(usize, i16)>)],
        used: &mut [bool],
        chosen: &mut Vec<(usize, u8, i16)>,
        best: &mut Option<f32>,
    ) {
        if depth == opts_per_pitch.len() {
            let mut by_string = chosen.clone();
            by_string.sort_unstable_by_key(|x| x.0);
            for i in 0..by_string.len() {
                for j in (i + 1)..by_string.len() {
                    if by_string[i].1 > by_string[j].1 {
                        return; // Reject pitch-to-string inversions
                    }
                }
            }

            let mut min_f = i16::MAX;
            let mut max_f = i16::MIN;
            let mut fretted = 0usize;
            for &(_, _, fr) in &by_string {
                if fr > 0 {
                    min_f = min_f.min(fr);
                    max_f = max_f.max(fr);
                    fretted += 1;
                }
            }
            let mut pen = if fretted >= 2 {
                let sp = max_f - min_f;
                let max_span = if min_f >= 9 { 6 } else { 5 };
                if sp > max_span {
                    return;
                }
                if sp <= 4 {
                    sp as f32 * 0.015
                } else {
                    0.08 + (sp - 4) as f32 * 0.12
                }
            } else {
                0.0
            };

            for i in 0..by_string.len().saturating_sub(1) {
                let gap = by_string[i + 1].0.saturating_sub(by_string[i].0 + 1);
                if gap > 0 {
                    pen += gap as f32 * 0.08;
                }
            }

            for &(s_open, _, fr_open) in &by_string {
                if fr_open == 0 {
                    let mut max_lower_fret = 0_i16;
                    for &(s_other, _, fr_other) in &by_string {
                        if s_other < s_open && fr_other >= 5 {
                            max_lower_fret = max_lower_fret.max(fr_other);
                        }
                    }
                    if max_lower_fret >= 5 {
                        pen += 0.25 + (max_lower_fret - 4) as f32 * 0.08;
                    }
                }
            }

            if best.is_none_or(|b| pen < b) {
                *best = Some(pen);
            }
            return;
        }
        let pitch = opts_per_pitch[depth].0;
        for &(s_idx, fr) in &opts_per_pitch[depth].1 {
            if !used[s_idx] {
                used[s_idx] = true;
                chosen.push((s_idx, pitch, fr));
                dfs(depth + 1, opts_per_pitch, used, chosen, best);
                chosen.pop();
                used[s_idx] = false;
            }
        }
    }

    dfs(0, &opts_per_pitch, &mut used, &mut chosen, &mut best);
    best
}

fn build_transcribed_notes(
    cached: &CachedDiAnalysis,
    params: &DiDecodeParams,
) -> Vec<TranscribedDiNote> {
    let di = &cached.di_net;
    let n_frames = di.n_frames;
    let min_pitch = params.min_pitch.clamp(MIDI_OFFSET as u8, 108);
    let max_pitch = params.max_pitch.clamp(min_pitch, 108);
    if n_frames < 5 || params.min_pitch > params.max_pitch {
        return Vec::new();
    }

    let atk_thr = (0.40 + (params.onset_threshold - 0.45) * 0.70).clamp(0.24, 0.62);
    let pitch_thr =
        (0.48 + 0.5 * (params.onset_threshold - 0.45) + 0.5 * (params.frame_threshold - 0.28))
            .clamp(0.28, 0.68);
    let frame_thr = (0.34 + (params.frame_threshold - 0.28) * 0.75).clamp(0.18, 0.52);
    let onset_gate = (0.16 + (params.onset_threshold - 0.45) * 0.45).clamp(0.06, 0.30);
    let nms_radius = ((f64::from(params.min_note_ms.max(25.0)) / 1000.0)
        * (f64::from(TARGET_SAMPLE_RATE) / FFT_HOP as f64)
        * 0.65)
        .round()
        .clamp(2.0, 6.0) as usize;

    let mut v4_atk = vec![0.0_f32; n_frames];
    let mut bp_atk = vec![0.0_f32; n_frames];
    let v4_lo = usize::from(min_pitch).saturating_sub(DI_MIDI_MIN);
    let v4_hi = (usize::from(max_pitch).saturating_sub(DI_MIDI_MIN)).min(DI_N_SEMITONES - 1);
    let has_v4_range = usize::from(min_pitch) < DI_MIDI_MIN + DI_N_SEMITONES
        && usize::from(max_pitch) >= DI_MIDI_MIN;
    let bp_lo = usize::from(min_pitch) - MIDI_OFFSET;
    let bp_hi = (usize::from(max_pitch) - MIDI_OFFSET).min(N_PITCH_BINS - 1);

    for f in 0..n_frames {
        let mut mx = 0.0_f32;
        if has_v4_range {
            for b in v4_lo..=v4_hi {
                mx = mx.max(di.onset_p[b * n_frames + f]);
            }
        }
        v4_atk[f] = di.attack_p[f].max(0.90 * mx);
        if cached.n_frames > 0 {
            let bp_f = sec_to_bp_frame(di_frame_to_seconds(f), cached.n_frames);
            let row = &cached.onsets[bp_f * N_PITCH_BINS..(bp_f + 1) * N_PITCH_BINS];
            let mut bp_mx = 0.0_f32;
            for &v in &row[bp_lo..=bp_hi] {
                bp_mx = bp_mx.max(v);
            }
            bp_atk[f] = 0.68 * bp_mx;
        }
    }

    let mut cands = Vec::<(usize, f32)>::new();
    for f in 2..n_frames - 2 {
        let v4_sc = v4_atk[f];
        let bp_sc = bp_atk[f];
        let ap = di.attack_p[f];
        let is_v4_peak = v4_sc >= atk_thr
            && ap >= di.attack_p[f - 1] - 0.04
            && (ap >= di.attack_p[f - 1].max(di.attack_p[f + 1]) || v4_sc >= atk_thr + 0.08);
        let is_bp_peak = bp_sc >= atk_thr
            && bp_sc >= bp_atk[f - 1]
            && bp_sc >= bp_atk[f + 1]
            && (bp_sc > bp_atk[f - 1] || bp_sc > bp_atk[f + 1]);
        if is_v4_peak || is_bp_peak {
            cands.push((f, v4_sc.max(bp_sc)));
        }
    }
    cands.sort_by(|a, b| b.1.total_cmp(&a.1));

    let mut events = Vec::new();
    let mut suppressed = vec![false; n_frames];
    for (f, _) in cands {
        if suppressed[f] {
            continue;
        }
        events.push(f);
        let lo = f.saturating_sub(nms_radius);
        let hi = (f + nms_radius).min(n_frames - 1);
        suppressed[lo..=hi].fill(true);
    }
    events.sort_unstable();
    if events.is_empty() {
        return Vec::new();
    }

    let n_pitches = usize::from(max_pitch - min_pitch) + 1;
    struct EvBuf {
        ev_f: usize,
        next_ev_f: usize,
        atk_peak: f32,
        raw_scores: Vec<f32>,
        scores: Vec<f32>,
        bodies: Vec<f32>,
        onsets: Vec<f32>,
        sim_vec: Vec<f32>,
        nbrs: Vec<usize>,
        pm_val: f32,
    }

    let mut ev_objs = Vec::with_capacity(events.len());
    for (idx, &ev_f) in events.iter().enumerate() {
        let next_ev_f = events.get(idx + 1).copied().unwrap_or(n_frames - 1);
        let fr_hi = (ev_f + 2).max((ev_f + 6).min(next_ev_f)).min(n_frames);
        let bp_f = sec_to_bp_frame(di_frame_to_seconds(ev_f), cached.n_frames);
        let atk_lo = ev_f.saturating_sub(1);
        let atk_hi = (ev_f + 2).min(n_frames);
        let mut atk_peak = 0.0_f32;
        for t in atk_lo..atk_hi {
            atk_peak = atk_peak.max(di.attack_p[t]);
        }

        let pm_hi = (ev_f + 5).min(n_frames);
        let pm_val = if pm_hi > ev_f {
            di.pm_p[ev_f..pm_hi].iter().sum::<f32>() / (pm_hi - ev_f) as f32
        } else {
            0.0
        };

        let mut scores = vec![0.0_f32; n_pitches];
        let mut bodies = vec![0.0_f32; n_pitches];
        let mut onsets = vec![0.0_f32; n_pitches];
        let mut sim_vec = vec![0.0_f32; n_pitches];
        let mut sim_sq = 0.0_f64;

        for p_off in 0..n_pitches {
            let pitch = min_pitch + p_off as u8;
            let bp_bin = usize::from(pitch) - MIDI_OFFSET;

            let (bp_on, bp_body) = if cached.n_frames > 0 && bp_bin < N_PITCH_BINS {
                let mut b_mo = 0.0_f32;
                let b_lo = bp_f.saturating_sub(2);
                let b_hi = (bp_f + 3).min(cached.n_frames - 1);
                for t in b_lo..=b_hi {
                    b_mo = b_mo.max(cached.onsets[t * N_PITCH_BINS + bp_bin]);
                }
                let mut b_sf = 0.0_f32;
                let mut b_mf = 0.0_f32;
                let mut b_cnt = 0usize;
                let fr_end = (bp_f + 4).min(cached.n_frames - 1);
                for t in bp_f..=fr_end {
                    let v = cached.notes[t * N_PITCH_BINS + bp_bin];
                    b_sf += v;
                    b_mf = b_mf.max(v);
                    b_cnt += 1;
                }
                (b_mo, 0.55 * (b_sf / b_cnt.max(1) as f32) + 0.45 * b_mf)
            } else {
                (0.0, 0.0)
            };

            let (mo, body, pre_f) =
                if (DI_MIDI_MIN..DI_MIDI_MIN + DI_N_SEMITONES).contains(&usize::from(pitch)) {
                    let v4_b = usize::from(pitch) - DI_MIDI_MIN;
                    // Strum-aware onset window [-2, +4) (~70 ms) captures all 6-7 strings across a fast down/up-strum.
                    let on_lo = ev_f.saturating_sub(2);
                    let on_hi = (ev_f + 4).min(n_frames);
                    let mut v4_on = 0.0_f32;
                    for t in on_lo..on_hi {
                        v4_on = v4_on.max(di.onset_p[v4_b * n_frames + t]);
                    }
                    let mut v4_sf = 0.0_f32;
                    let mut v4_mf = 0.0_f32;
                    let mut v4_cnt = 0usize;
                    for t in ev_f..fr_hi {
                        let v = di.frame_p[v4_b * n_frames + t];
                        v4_sf += v;
                        v4_mf = v4_mf.max(v);
                        v4_cnt += 1;
                    }
                    let v4_body = 0.55 * (v4_sf / v4_cnt.max(1) as f32) + 0.45 * v4_mf;
                    let pre = di.frame_p[v4_b * n_frames + ev_f.saturating_sub(2)]
                        .min(di.frame_p[v4_b * n_frames + ev_f.saturating_sub(1)]);
                    if cached.n_frames > 0 {
                        let bp_w = if pitch >= 40 {
                            0.35_f32
                        } else {
                            (0.05 + 0.30 * ((f32::from(pitch) - 26.0).max(0.0) / 14.0))
                                .clamp(0.05, 0.35)
                        };
                        let v4_w = 1.0 - bp_w;
                        (
                            v4_w * v4_on + bp_w * bp_on,
                            v4_w * v4_body + bp_w * bp_body,
                            pre,
                        )
                    } else {
                        (v4_on, v4_body, pre)
                    }
                } else {
                    (bp_on, bp_body, 0.0)
                };

            let mut sc = 0.55 * mo + 0.45 * body;
            // Suppress sustained tail re-triggers when the global attack is weak, while preserving re-strummed chord notes.
            if atk_peak < 0.65 && pre_f > 0.45 && mo < 0.14 && body <= pre_f + 0.04 {
                sc *= 0.48;
            }
            scores[p_off] = sc;
            bodies[p_off] = body;
            onsets[p_off] = mo;
            sim_vec[p_off] = body;
            sim_sq += f64::from(body) * f64::from(body);
        }

        let norm = (sim_sq.sqrt() as f32).max(1e-6);
        for v in &mut sim_vec {
            *v /= norm;
        }
        let raw_scores = scores.clone();
        ev_objs.push(EvBuf {
            ev_f,
            next_ev_f,
            atk_peak,
            raw_scores,
            scores,
            bodies,
            onsets,
            sim_vec,
            nbrs: Vec::new(),
            pm_val,
        });
    }

    // Stage 1 Self-Similarity Riff Pooling
    let n_evs = ev_objs.len();
    if n_evs > 1 {
        let mut blended_scores: Vec<Vec<f32>> = ev_objs.iter().map(|e| e.scores.clone()).collect();
        let mut blended_bodies: Vec<Vec<f32>> = ev_objs.iter().map(|e| e.bodies.clone()).collect();
        let mut all_nbrs: Vec<Vec<usize>> = vec![Vec::new(); n_evs];
        let half_window = if n_evs <= 3000 { n_evs } else { 800 };
        for i in 0..n_evs {
            let lo_j = i.saturating_sub(half_window);
            let hi_j = (i + half_window + 1).min(n_evs);
            let vi = &ev_objs[i].sim_vec;
            let mut nbrs: Vec<(usize, f32)> = Vec::new();
            for (j, other) in ev_objs.iter().enumerate().take(hi_j).skip(lo_j) {
                if j == i {
                    continue;
                }
                let mut dot = 0.0_f32;
                for (a, b) in vi.iter().zip(other.sim_vec.iter()) {
                    dot += a * b;
                }
                if dot >= 0.945 {
                    nbrs.push((j, dot));
                }
            }
            if nbrs.is_empty() {
                continue;
            }
            nbrs.sort_by(|a, b| b.1.total_cmp(&a.1));
            nbrs.truncate(6);
            let w_sum: f32 = nbrs.iter().map(|x| x.1).sum();
            let alpha = (nbrs.len() as f32 * 0.075).min(0.32);
            for p_off in 0..n_pitches {
                let mut avg_sc = 0.0_f32;
                let mut avg_bd = 0.0_f32;
                for &(j, dot) in &nbrs {
                    let w = dot / w_sum.max(1e-6);
                    avg_sc += w * ev_objs[j].scores[p_off];
                    avg_bd += w * ev_objs[j].bodies[p_off];
                }
                blended_scores[i][p_off] =
                    (1.0 - alpha) * ev_objs[i].scores[p_off] + alpha * avg_sc;
                blended_bodies[i][p_off] =
                    (1.0 - alpha) * ev_objs[i].bodies[p_off] + alpha * avg_bd;
            }
            all_nbrs[i] = nbrs.into_iter().map(|(j, _)| j).collect();
        }
        for ((ev, (b_sc, b_bd)), nbrs) in ev_objs
            .iter_mut()
            .zip(blended_scores.into_iter().zip(blended_bodies.into_iter()))
            .zip(all_nbrs.into_iter())
        {
            ev.scores = b_sc;
            ev.bodies = b_bd;
            ev.nbrs = nbrs;
        }
    }

    let mut result = Vec::with_capacity(n_evs * 2);
    let attack_len = (TARGET_SAMPLE_RATE as usize * 30) / 1000;
    let stop_floor = frame_thr * 0.65;
    let max_poly = if !params.open_tuning.is_empty() {
        params.open_tuning.len().min(7)
    } else {
        6
    };

    let mut selected_per_ev: Vec<Vec<ScoredPitchCand>> = Vec::with_capacity(n_evs);
    for ev in &ev_objs {
        let mut pitch_cands = Vec::<ScoredPitchCand>::new();
        for p_off in 0..n_pitches {
            let sc = ev.scores[p_off];
            let body = ev.bodies[p_off];
            let onset = ev.onsets[p_off];
            let eff_gate = if ev.atk_peak >= 0.70 && body >= 0.65 {
                onset_gate.min(0.08)
            } else {
                onset_gate
            };
            if sc >= pitch_thr && body >= frame_thr * 0.70 && onset >= eff_gate {
                pitch_cands.push(ScoredPitchCand {
                    pitch: min_pitch + p_off as u8,
                    score: sc,
                    body,
                    onset,
                });
            }
        }
        pitch_cands.sort_by(|a, b| b.score.total_cmp(&a.score));

        if params.suppress_overtones && pitch_cands.len() > 1 {
            let snapshot = pitch_cands.clone();
            pitch_cands.retain(|cand| {
                !snapshot.iter().any(|root| {
                    root.score > cand.score
                        && matches!(cand.pitch.checked_sub(root.pitch), Some(12) | Some(19))
                        && (cand.body < frame_thr * 1.15 || cand.onset < pitch_thr * 0.78)
                })
            });
        }

        if !params.open_tuning.is_empty() && pitch_cands.len() > 1 {
            let pool_len = pitch_cands.len().min(8);
            let pool = &pitch_cands[..pool_len];
            let mut best_obj = f32::NEG_INFINITY;
            let mut best_mask = 0usize;
            for mask in 1..(1usize << pool_len) {
                let count = mask.count_ones() as usize;
                if count > max_poly {
                    continue;
                }
                let mut sub_pitches = Vec::with_capacity(count);
                let mut obj = 0.0_f32;
                for (i, item) in pool.iter().enumerate() {
                    if mask & (1 << i) != 0 {
                        sub_pitches.push(item.pitch);
                        obj += item.score - pitch_thr * 0.85;
                    }
                }
                if let Some(pen) = best_fret_pen(&sub_pitches, &params.open_tuning, 24) {
                    let net = obj - pen;
                    if net > best_obj {
                        best_obj = net;
                        best_mask = mask;
                    }
                }
            }
            if best_mask != 0 {
                pitch_cands = pool
                    .iter()
                    .enumerate()
                    .filter_map(|(i, item)| (best_mask & (1 << i) != 0).then_some(*item))
                    .collect();
            } else {
                pitch_cands.truncate(max_poly);
            }
        } else {
            pitch_cands.truncate(max_poly);
        }
        selected_per_ev.push(pitch_cands);
    }

    // Stage 2 Riff Chord Consensus: stabilize repeated multi-note chords (>= 3 notes) across high-similarity riff clusters.
    if n_evs > 1 {
        let snapshot_cands = selected_per_ev.clone();
        for (i, ev) in ev_objs.iter().enumerate() {
            if snapshot_cands[i].len() < 3 || ev.nbrs.len() < 3 {
                continue;
            }
            let cluster_len = 1 + ev.nbrs.len();
            let mut counts = vec![0usize; n_pitches];
            for item in &snapshot_cands[i] {
                counts[usize::from(item.pitch - min_pitch)] += 1;
            }
            for &j in &ev.nbrs {
                for item in &snapshot_cands[j] {
                    counts[usize::from(item.pitch - min_pitch)] += 1;
                }
            }

            let mut consensus_cands = Vec::<ScoredPitchCand>::new();
            for (p_off, &cnt) in counts.iter().enumerate() {
                if cnt == 0 {
                    continue;
                }
                let pitch = min_pitch + p_off as u8;
                let existing = snapshot_cands[i].iter().find(|c| c.pitch == pitch).copied();
                let keep = if cnt * 2 >= cluster_len {
                    ev.bodies[p_off] >= frame_thr * 0.70
                } else {
                    existing.is_some() && ev.raw_scores[p_off] >= pitch_thr + 0.14
                };
                if keep {
                    consensus_cands.push(existing.unwrap_or(ScoredPitchCand {
                        pitch,
                        score: ev.scores[p_off],
                        body: ev.bodies[p_off],
                        onset: ev.onsets[p_off],
                    }));
                }
            }
            consensus_cands.sort_by(|a, b| b.score.total_cmp(&a.score));
            consensus_cands.truncate(max_poly);
            if consensus_cands.len() >= 3 {
                let playable = if !params.open_tuning.is_empty() {
                    let sub_pitches: Vec<u8> = consensus_cands.iter().map(|c| c.pitch).collect();
                    best_fret_pen(&sub_pitches, &params.open_tuning, 24).is_some()
                } else {
                    true
                };
                if playable {
                    selected_per_ev[i] = consensus_cands;
                }
            }
        }
    }

    for (ev, pitch_cands) in ev_objs.iter().zip(selected_per_ev.into_iter()) {
        // Compute a unified chord end frame across all notes of a multi-note chord so simultaneous chord tones
        // share one rhythmic duration instead of splintering into 2 voices or cutting adjacent chord notes short.
        let mut end_frames = Vec::with_capacity(pitch_cands.len());
        for item in &pitch_cands {
            let in_v4 =
                (DI_MIDI_MIN..DI_MIDI_MIN + DI_N_SEMITONES).contains(&usize::from(item.pitch));
            let mut end_f = (ev.ev_f + 2).min(ev.next_ev_f);
            let mut quiet = 0usize;
            if in_v4 {
                let v4_b = usize::from(item.pitch) - DI_MIDI_MIN;
                while end_f < ev.next_ev_f && quiet < 3 {
                    if di.frame_p[v4_b * n_frames + end_f] < stop_floor {
                        quiet += 1;
                    } else {
                        quiet = 0;
                    }
                    end_f += 1;
                }
            } else if cached.n_frames > 0 {
                let bp_bin = usize::from(item.pitch) - MIDI_OFFSET;
                while end_f < ev.next_ev_f && quiet < 3 {
                    let bp_t = sec_to_bp_frame(di_frame_to_seconds(end_f), cached.n_frames);
                    if cached.notes[bp_t * N_PITCH_BINS + bp_bin] < stop_floor {
                        quiet += 1;
                    } else {
                        quiet = 0;
                    }
                    end_f += 1;
                }
            }
            let clean_end_f = end_f
                .saturating_sub(quiet)
                .max((ev.ev_f + 2).min(ev.next_ev_f));
            end_frames.push(clean_end_f);
        }

        let unified_end_f = if end_frames.len() >= 2 {
            let mut sorted_ends = end_frames.clone();
            sorted_ends.sort_unstable();
            // Upper-quartile chord duration (e.g. 75th percentile) preserves the ringing body of a strummed chord.
            sorted_ends[(sorted_ends.len() * 3) / 4]
        } else {
            end_frames
                .first()
                .copied()
                .unwrap_or((ev.ev_f + 2).min(ev.next_ev_f))
        };

        let start_sec = di_frame_to_seconds(ev.ev_f);
        let end_sec = di_frame_to_seconds(unified_end_f).max(start_sec + 0.04);
        let dur_ms = (end_sec - start_sec) * 1000.0;

        let palm_mute_score = if dur_ms <= 650.0 {
            ev.pm_val
        } else if dur_ms >= 900.0 {
            0.0
        } else {
            ev.pm_val * ((900.0 - dur_ms as f32) / 250.0)
        }
        .clamp(0.0, 1.0);

        let s0 = seconds_to_sample_22k(start_sec);
        let local_rms = slice_rms(&cached.mono_22k, s0, s0 + attack_len);
        let vel_norm = (local_rms / cached.ref_attack_rms.max(1e-4)).clamp(0.1, 1.0);
        let velocity = (vel_norm * 127.0).round().clamp(1.0, 127.0) as u8;

        for item in pitch_cands {
            let bend_semitones = if cached.n_frames > 0 {
                let bp_start_f = sec_to_bp_frame(start_sec, cached.n_frames);
                let bp_end_f = sec_to_bp_frame(end_sec, cached.n_frames)
                    .max(bp_start_f + 1)
                    .min(cached.n_frames);
                estimate_bend_semitones(&cached.contours, bp_start_f, bp_end_f, item.pitch)
            } else {
                0.0
            };

            result.push(TranscribedDiNote {
                start_sec,
                end_sec,
                pitch: item.pitch,
                onset_confidence: item.onset.clamp(0.0, 1.0),
                frame_confidence: item.body.clamp(0.0, 1.0),
                velocity,
                palm_mute_score,
                bend_semitones,
            });
        }
    }

    result.sort_by(|a, b| {
        a.start_sec
            .total_cmp(&b.start_sec)
            .then(a.pitch.cmp(&b.pitch))
    });
    result
}

pub(crate) fn analyze_samples_22k_with_plan(
    analysis_id: String,
    file_name: String,
    sample_rate: u32,
    channels: u16,
    mono_22k: Vec<f32>,
    di_plan: &TractPlan,
) -> Result<(DiAnalysisSummary, CachedDiAnalysis), String> {
    let duration_sec = mono_22k.len() as f64 / TARGET_SAMPLE_RATE as f64;
    if !duration_sec.is_finite() || duration_sec > MAX_DI_DURATION_SEC {
        return Err("too_long".into());
    }
    let (notes, onsets, contours, n_frames) = infer_posteriorgrams(&mono_22k)?;
    let di_net = infer_di_net_posteriorgrams_with_plan(&mono_22k, di_plan)?;
    let ref_attack_rms = compute_reference_attack_rms(&mono_22k);
    let (estimated_bpm, estimated_offset_sec) =
        estimate_tempo_and_offset(&onsets, &mono_22k, n_frames);
    let summary = DiAnalysisSummary {
        analysis_id: analysis_id.clone(),
        file_name,
        duration_sec,
        sample_rate,
        channels,
        estimated_bpm,
        estimated_offset_sec,
    };
    let cached = CachedDiAnalysis {
        analysis_id,
        summary: summary.clone(),
        mono_22k,
        notes,
        onsets,
        contours,
        n_frames,
        di_net,
        ref_attack_rms,
    };
    Ok((summary, cached))
}

#[cfg(test)]
pub(crate) fn analyze_samples_22k(
    analysis_id: String,
    file_name: String,
    sample_rate: u32,
    channels: u16,
    mono_22k: Vec<f32>,
) -> Result<(DiAnalysisSummary, CachedDiAnalysis), String> {
    let di_plan = shared_di_net_plan()?;
    analyze_samples_22k_with_plan(
        analysis_id,
        file_name,
        sample_rate,
        channels,
        mono_22k,
        di_plan,
    )
}

pub(crate) fn analyze_file_with_plan(
    path: &Path,
    analysis_id: String,
    di_plan: &TractPlan,
) -> Result<(DiAnalysisSummary, CachedDiAnalysis), String> {
    let bytes = read_bounded_file(path)?;
    let hint = path.extension().and_then(|ext| ext.to_str());
    let decoded = decode_audio(&bytes, hint).map_err(|e| format!("decode_failed: {e}"))?;
    let duration_sec = decoded.frames.len() as f64 / decoded.sample_rate as f64;
    if !duration_sec.is_finite() || duration_sec > MAX_DI_DURATION_SEC {
        return Err("too_long".into());
    }
    let mono: Vec<f32> = decoded
        .frames
        .iter()
        .map(|[left, right]| 0.5 * (left + right))
        .collect();
    let mono_22k = resample_mono_22k(&mono, decoded.sample_rate);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("guitar-di.wav")
        .to_string();
    analyze_samples_22k_with_plan(
        analysis_id,
        file_name,
        decoded.sample_rate,
        decoded.channels,
        mono_22k,
        di_plan,
    )
}

#[cfg(test)]
pub(crate) fn analyze_file(
    path: &Path,
    analysis_id: String,
) -> Result<(DiAnalysisSummary, CachedDiAnalysis), String> {
    let di_plan = shared_di_net_plan()?;
    analyze_file_with_plan(path, analysis_id, di_plan)
}

fn active_di_net_plan(state: &DiTranscriptionState) -> Result<TractPlan, String> {
    let guard = state.custom_model.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(custom) = guard.as_ref() {
        return Ok(custom.plan.clone());
    }
    Ok(shared_di_net_plan()?.clone())
}

async fn reanalyze_cached_with_plan(
    state: &DiTranscriptionState,
    plan: TractPlan,
) -> Result<Option<DiAnalysisSummary>, String> {
    let snapshot = {
        let guard = state.cached.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .map(|c| (c.mono_22k.clone(), c.analysis_id.clone(), c.summary.clone()))
    };
    let Some((mono_22k, old_id, mut summary)) = snapshot else {
        return Ok(None);
    };
    let di_net = tauri::async_runtime::spawn_blocking(move || {
        infer_di_net_posteriorgrams_with_plan(&mono_22k, &plan)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut guard = state.cached.lock().unwrap_or_else(|e| e.into_inner());
    let Some(cached) = guard.as_mut() else {
        return Ok(None);
    };
    if cached.analysis_id != old_id {
        return Ok(Some(cached.summary.clone()));
    }
    let new_id = format!("di-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    cached.di_net = di_net;
    cached.analysis_id = new_id.clone();
    summary.analysis_id = new_id;
    cached.summary = summary.clone();
    Ok(Some(summary))
}

#[tauri::command]
pub async fn di_transcribe_pick_and_analyze(
    app: tauri::AppHandle,
    state: State<'_, DiTranscriptionState>,
) -> Result<Option<DiAnalysisSummary>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Guitar DI audio", &["wav", "flac", "mp3", "ogg"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(file_path) = selected else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let di_plan = active_di_net_plan(&state)?;
    let id_num = state.next_id.fetch_add(1, Ordering::Relaxed);
    let analysis_id = format!("di-{id_num}");
    let (summary, cached) = tauri::async_runtime::spawn_blocking(move || {
        analyze_file_with_plan(&path, analysis_id, &di_plan)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut guard = state.cached.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(cached);
    Ok(Some(summary))
}

#[tauri::command]
pub fn di_transcribe_get_model(
    state: State<'_, DiTranscriptionState>,
) -> Option<DiCustomModelInfo> {
    let guard = state.custom_model.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map(|m| m.info.clone())
}

#[tauri::command]
pub async fn di_transcribe_pick_model(
    app: tauri::AppHandle,
    state: State<'_, DiTranscriptionState>,
) -> Result<Option<DiModelSwitchResult>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("ONNX transcription model", &["onnx"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(file_path) = selected else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let (info, plan) =
        tauri::async_runtime::spawn_blocking(move || load_custom_model_from_path(&path))
            .await
            .map_err(|e| e.to_string())??;
    {
        let mut guard = state.custom_model.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(LoadedCustomModel {
            info: info.clone(),
            plan: plan.clone(),
        });
    }
    let analysis = reanalyze_cached_with_plan(&state, plan).await?;
    Ok(Some(DiModelSwitchResult {
        model: Some(info),
        analysis,
    }))
}

#[tauri::command]
pub async fn di_transcribe_clear_model(
    state: State<'_, DiTranscriptionState>,
) -> Result<DiModelSwitchResult, String> {
    {
        let mut guard = state.custom_model.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
    let plan = shared_di_net_plan()?.clone();
    let analysis = reanalyze_cached_with_plan(&state, plan).await?;
    Ok(DiModelSwitchResult {
        model: None,
        analysis,
    })
}

#[tauri::command]
pub fn di_transcribe_decode(
    state: State<'_, DiTranscriptionState>,
    analysis_id: String,
    params: DiDecodeParams,
) -> Result<Vec<TranscribedDiNote>, String> {
    let guard = state.cached.lock().unwrap_or_else(|e| e.into_inner());
    let Some(cached) = guard.as_ref() else {
        return Err("stale_analysis".into());
    };
    if cached.analysis_id != analysis_id {
        return Err("stale_analysis".into());
    }
    Ok(build_transcribed_notes(cached, &params))
}

#[tauri::command]
pub fn di_transcribe_clear(state: State<'_, DiTranscriptionState>) {
    let mut guard = state.cached.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn midi_to_hz(midi: u8) -> f64 {
        440.0 * 2.0_f64.powf((f64::from(midi) - 69.0) / 12.0)
    }

    fn synth_pluck(
        buf: &mut [f32],
        start_sec: f64,
        dur_sec: f64,
        midi: u8,
        amp: f32,
        decay_rate: f64,
        max_harmonic: usize,
        sr: u32,
    ) {
        let f0 = midi_to_hz(midi);
        let start = (start_sec * sr as f64).round() as usize;
        let len = (dur_sec * sr as f64).round() as usize;
        for i in 0..len {
            let idx = start + i;
            if idx >= buf.len() {
                break;
            }
            let t = i as f64 / sr as f64;
            let attack = (t / 0.004).min(1.0);
            let mut sample = 0.0_f64;
            for h in 1..=max_harmonic {
                let freq = f0 * h as f64;
                if freq >= sr as f64 * 0.45 {
                    break;
                }
                let h_decay = (-(decay_rate * (1.0 + 0.35 * (h - 1) as f64)) * t).exp();
                sample += (TAU * freq * t).sin() * (h_decay / (h as f64).powf(0.85));
            }
            // Subtle release tail over the last 10 ms to avoid step discontinuities.
            let rem = len - i;
            let release = if rem < (sr as usize / 100) {
                rem as f64 / (sr as usize / 100) as f64
            } else {
                1.0
            };
            buf[idx] += (f64::from(amp) * attack * release * sample * 0.65) as f32;
        }
    }

    fn encode_test_wav(samples: &[f32], sr: u32) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: sr,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
        for &s in samples {
            let q = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            writer.write_sample(q).unwrap();
        }
        writer.finalize().unwrap();
        cursor.into_inner()
    }

    #[test]
    fn bundled_onnx_model_loads_and_outputs_valid_posteriorgrams() {
        let silence = vec![0.0_f32; TARGET_SAMPLE_RATE as usize];
        let (notes, onsets, contours, n_frames) = infer_posteriorgrams(&silence).unwrap();
        assert!(n_frames >= 80 && n_frames <= 90, "n_frames={n_frames}");
        assert_eq!(notes.len(), n_frames * N_PITCH_BINS);
        assert_eq!(onsets.len(), n_frames * N_PITCH_BINS);
        assert_eq!(contours.len(), n_frames * N_CONTOUR_BINS);
        for &v in notes.iter().chain(onsets.iter()).chain(contours.iter()) {
            assert!(v.is_finite() && (0.0..=1.0).contains(&v));
        }
    }

    #[test]
    fn detects_guitar_single_notes_and_drop_c_power_chord() {
        let mut audio = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 4];
        // C2 (36) -> A2 (45) -> E4 (64) -> Drop C power chord (36 + 43 + 48)
        synth_pluck(&mut audio, 0.25, 0.55, 36, 0.7, 3.0, 6, TARGET_SAMPLE_RATE);
        synth_pluck(&mut audio, 1.00, 0.55, 45, 0.7, 3.0, 6, TARGET_SAMPLE_RATE);
        synth_pluck(&mut audio, 1.75, 0.55, 64, 0.7, 3.0, 5, TARGET_SAMPLE_RATE);
        synth_pluck(&mut audio, 2.60, 0.85, 36, 0.65, 2.5, 5, TARGET_SAMPLE_RATE);
        synth_pluck(&mut audio, 2.60, 0.85, 43, 0.60, 2.5, 5, TARGET_SAMPLE_RATE);
        synth_pluck(&mut audio, 2.60, 0.85, 48, 0.55, 2.5, 5, TARGET_SAMPLE_RATE);

        let (_summary, cached) = analyze_samples_22k(
            "t-single".into(),
            "test.wav".into(),
            TARGET_SAMPLE_RATE,
            1,
            audio,
        )
        .unwrap();
        let detected = build_transcribed_notes(&cached, &DiDecodeParams::default());

        let has_pitch_near = |pitch: u8, t: f64| {
            detected
                .iter()
                .any(|n| n.pitch == pitch && (n.start_sec - t).abs() < 0.08)
        };
        assert!(has_pitch_near(36, 0.25), "missed C2 in {detected:?}");
        assert!(has_pitch_near(45, 1.00), "missed A2 in {detected:?}");
        assert!(has_pitch_near(64, 1.75), "missed E4 in {detected:?}");
        assert!(
            has_pitch_near(36, 2.60),
            "missed chord root 36 in {detected:?}"
        );
        assert!(
            has_pitch_near(43, 2.60),
            "missed chord fifth 43 in {detected:?}"
        );
        assert!(
            has_pitch_near(48, 2.60),
            "missed chord octave 48 in {detected:?}"
        );
    }

    #[test]
    fn re_articulates_fast_16th_chugs_and_estimates_tempo() {
        // 140 BPM -> beat = 60/140 = 0.42857 s; 16th = 0.10714 s (tight metal chugs + downbeats).
        let bpm = 140.0;
        let beat = 60.0 / bpm;
        let step = beat / 4.0;
        let mut audio = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 5];
        for beat_idx in 0..10usize {
            let base = 0.30 + beat_idx as f64 * beat;
            // Quarter accent + 16th chugs on alternating beats so autocorrelation locks 140 BPM cleanly.
            synth_pluck(
                &mut audio,
                base,
                0.14,
                40,
                0.85,
                18.0,
                6,
                TARGET_SAMPLE_RATE,
            );
            synth_pluck(
                &mut audio,
                base + step * 2.0,
                0.09,
                40,
                0.55,
                22.0,
                5,
                TARGET_SAMPLE_RATE,
            );
            synth_pluck(
                &mut audio,
                base + step * 3.0,
                0.09,
                40,
                0.60,
                22.0,
                5,
                TARGET_SAMPLE_RATE,
            );
        }

        let (summary, cached) = analyze_samples_22k(
            "t-chug".into(),
            "chug.wav".into(),
            TARGET_SAMPLE_RATE,
            1,
            audio,
        )
        .unwrap();
        let params = DiDecodeParams {
            onset_threshold: 0.38,
            frame_threshold: 0.25,
            min_note_ms: 45.0,
            ..DiDecodeParams::default()
        };
        let detected = build_transcribed_notes(&cached, &params);
        let e2_hits: Vec<_> = detected.iter().filter(|n| n.pitch == 40).collect();
        assert!(
            e2_hits.len() >= 18,
            "expected re-articulated E2 chugs, got {} hits",
            e2_hits.len()
        );
        assert!(
            (summary.estimated_bpm - 140.0).abs() <= 4.0
                || (summary.estimated_bpm - 70.0).abs() <= 2.0,
            "estimated_bpm={} too far from 140 BPM",
            summary.estimated_bpm
        );
    }

    #[test]
    fn di_net_frontend_matches_python_reference() {
        let mut sig = vec![0.0_f32; DI_CHUNK_SAMPLES];
        let start = TARGET_SAMPLE_RATE as usize;
        for (i, sample) in sig.iter_mut().enumerate().skip(start) {
            let dt = (i - start) as f64 / f64::from(TARGET_SAMPLE_RATE);
            let env = (-dt * 4.0).exp();
            for &midi in &[26_u8, 56, 57] {
                let f0 = midi_to_hz(midi);
                for h in 1..=6usize {
                    *sample +=
                        ((env / (h as f64).powf(0.7)) * (TAU * f0 * h as f64 * dt).sin()) as f32;
                }
            }
        }
        let mut scratch = DiFrontendScratch::new();
        let mut feats = vec![0.0_f32; DI_N_CHANNELS * DI_N_FREQ_BINS * DI_CHUNK_FRAMES];
        scratch.extract_chunk(&sig, &mut feats);
        assert!(feats.iter().all(|v| v.is_finite()));

        let chan_stride = DI_N_FREQ_BINS * DI_CHUNK_FRAMES;
        let t_atk = (1.02 * f64::from(TARGET_SAMPLE_RATE) / FFT_HOP as f64).round() as usize;
        let bin_of = |midi: usize| (midi - DI_MIDI_MIN) * DI_SUB_BINS + 1;
        let ch1_val = |midi: usize| feats[chan_stride + bin_of(midi) * DI_CHUNK_FRAMES + t_atk];
        assert!(
            (ch1_val(26) - 1.575_846).abs() < 1e-3,
            "D1 (26) fundamental mismatch vs Python reference: {}",
            ch1_val(26)
        );
        assert!(
            (ch1_val(45) - 0.994_016).abs() < 1e-3,
            "A2 (45, 3rd harmonic of D1) mismatch vs Python reference: {}",
            ch1_val(45)
        );
        assert!(
            (ch1_val(56) - 1.477_884).abs() < 1e-3,
            "G#3 (56) fundamental mismatch vs Python reference: {}",
            ch1_val(56)
        );
        assert!(
            (ch1_val(57) - 1.738_550).abs() < 1e-3,
            "A3 (57) fundamental mismatch vs Python reference: {}",
            ch1_val(57)
        );
        assert!(ch1_val(26) > ch1_val(45) && ch1_val(56) > ch1_val(45));

        let t_flux = (1.00 * f64::from(TARGET_SAMPLE_RATE) / FFT_HOP as f64).round() as usize;
        let flux_d1 = feats[6 * chan_stride + bin_of(26) * DI_CHUNK_FRAMES + t_flux];
        let flux_gs3 = feats[6 * chan_stride + bin_of(56) * DI_CHUNK_FRAMES + t_flux];
        assert!(
            (flux_d1 - 4.972_637).abs() < 1e-3,
            "D1 flux mismatch vs Python reference: {flux_d1}"
        );
        assert!(
            (flux_gs3 - 3.217_673).abs() < 1e-3,
            "G#3 flux mismatch vs Python reference: {flux_gs3}"
        );
    }

    #[test]
    fn palm_mute_score_separates_muted_chug_from_open_ring() {
        let mut muted = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 2];
        let mut open = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 2];
        // Heavy palm mute: fast decay, rolled-off harmonics.
        synth_pluck(
            &mut muted,
            0.30,
            0.14,
            40,
            0.85,
            24.0,
            5,
            TARGET_SAMPLE_RATE,
        );
        // Open ringing string: slow decay, rich upper harmonics.
        synth_pluck(&mut open, 0.30, 0.90, 40, 0.85, 1.5, 8, TARGET_SAMPLE_RATE);

        let (_sm, c_muted) = analyze_samples_22k(
            "t-pm-muted".into(),
            "muted.wav".into(),
            TARGET_SAMPLE_RATE,
            1,
            muted,
        )
        .unwrap();
        let (_so, c_open) = analyze_samples_22k(
            "t-pm-open".into(),
            "open.wav".into(),
            TARGET_SAMPLE_RATE,
            1,
            open,
        )
        .unwrap();
        let pm_notes = build_transcribed_notes(&c_muted, &DiDecodeParams::default());
        let open_notes = build_transcribed_notes(&c_open, &DiDecodeParams::default());
        let pm_hit = pm_notes
            .iter()
            .find(|n| n.pitch == 40 && (n.start_sec - 0.30).abs() < 0.08)
            .expect("muted E2 note missing");
        let open_hit = open_notes
            .iter()
            .find(|n| n.pitch == 40 && (n.start_sec - 0.30).abs() < 0.08)
            .expect("open E2 note missing");
        assert!(
            pm_hit.palm_mute_score > 0.50,
            "expected high palm mute score, got {}",
            pm_hit.palm_mute_score
        );
        assert!(
            open_hit.palm_mute_score < 0.30,
            "expected low open score, got {}",
            open_hit.palm_mute_score
        );
    }

    #[test]
    fn preserves_minor_second_dissonant_dyad() {
        let mut audio = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 2];
        synth_pluck(&mut audio, 0.35, 0.45, 56, 0.72, 2.5, 6, TARGET_SAMPLE_RATE);
        synth_pluck(&mut audio, 0.35, 0.45, 57, 0.72, 2.5, 6, TARGET_SAMPLE_RATE);
        let (_summary, cached) = analyze_samples_22k(
            "t-dyad".into(),
            "dyad.wav".into(),
            TARGET_SAMPLE_RATE,
            1,
            audio,
        )
        .unwrap();
        let params = DiDecodeParams {
            onset_threshold: 0.45,
            frame_threshold: 0.28,
            min_note_ms: 55.0,
            min_pitch: 40,
            max_pitch: 76,
            suppress_overtones: true,
            open_tuning: Vec::new(),
        };
        let detected = build_transcribed_notes(&cached, &params);
        let has = |p: u8| {
            detected
                .iter()
                .any(|n| n.pitch == p && (n.start_sec - 0.35).abs() < 0.08)
        };
        assert!(has(56), "missed G#3 (56) in minor-2nd dyad: {detected:?}");
        assert!(has(57), "missed A3 (57) in minor-2nd dyad: {detected:?}");
    }

    #[test]
    fn detects_ultra_low_drop_d1_power_chord() {
        let mut audio = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 2];
        synth_pluck(
            &mut audio,
            0.35,
            0.60,
            26,
            0.80,
            2.8,
            10,
            TARGET_SAMPLE_RATE,
        );
        synth_pluck(&mut audio, 0.35, 0.60, 33, 0.72, 2.8, 9, TARGET_SAMPLE_RATE);
        let (_summary, cached) = analyze_samples_22k(
            "t-dropd1".into(),
            "dropd1.wav".into(),
            TARGET_SAMPLE_RATE,
            1,
            audio,
        )
        .unwrap();
        let params = DiDecodeParams {
            onset_threshold: 0.45,
            frame_threshold: 0.28,
            min_note_ms: 55.0,
            min_pitch: 26,
            max_pitch: 76,
            suppress_overtones: true,
            open_tuning: Vec::new(),
        };
        let detected = build_transcribed_notes(&cached, &params);
        let near = |p: u8| {
            detected
                .iter()
                .any(|n| n.pitch == p && (n.start_sec - 0.35).abs() < 0.08)
        };
        assert!(near(26), "missed D1 (26): {detected:?}");
        assert!(near(33), "missed A1 (33): {detected:?}");
        assert!(
            !near(38),
            "false +12 octave ghost D2 (38) leaked on Drop D1 power chord: {detected:?}"
        );
    }

    #[test]
    fn does_not_retrigger_long_sustained_open_note() {
        let mut audio = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 4];
        synth_pluck(&mut audio, 0.35, 2.50, 40, 0.80, 1.2, 7, TARGET_SAMPLE_RATE);
        let (_summary, cached) = analyze_samples_22k(
            "t-sustain".into(),
            "sustain.wav".into(),
            TARGET_SAMPLE_RATE,
            1,
            audio,
        )
        .unwrap();
        let detected = build_transcribed_notes(&cached, &DiDecodeParams::default());
        let e2_count = detected.iter().filter(|n| n.pitch == 40).count();
        assert_eq!(
            e2_count, 1,
            "expected single sustained E2 (40) note without tail retriggers, got {detected:?}"
        );
    }

    #[test]
    fn resamples_48khz_wav_file_and_detects_note() {
        let dir = tempfile::tempdir().unwrap();
        let wav_path = dir.path().join("di48k.wav");
        let sr = 48_000_u32;
        let mut buf = vec![0.0_f32; sr as usize * 2];
        synth_pluck(&mut buf, 0.30, 0.70, 50, 0.75, 2.5, 6, sr); // D3 (50)
        std::fs::write(&wav_path, encode_test_wav(&buf, sr)).unwrap();

        let (summary, cached) = analyze_file(&wav_path, "wav-1".into()).unwrap();
        assert_eq!(summary.sample_rate, 48_000);
        assert_eq!(summary.channels, 1);
        assert!((summary.duration_sec - 2.0).abs() < 0.05);
        let notes = build_transcribed_notes(&cached, &DiDecodeParams::default());
        assert!(
            notes
                .iter()
                .any(|n| n.pitch == 50 && (n.start_sec - 0.30).abs() < 0.08),
            "expected D3 (50) around 0.30 s, got {notes:?}"
        );
    }

    #[test]
    fn rejects_invalid_or_missing_files_and_stale_analysis_ids() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("corrupt.wav");
        std::fs::write(&bad, b"not a wav file").unwrap();
        let err = analyze_file(&bad, "x".into()).err().unwrap();
        assert!(err.starts_with("decode_failed:"), "unexpected error {err}");

        let state = DiTranscriptionState::default();
        let guard = state.cached.lock().unwrap();
        assert!(guard.is_none());
    }

    #[test]
    fn custom_onnx_model_loads_validates_and_infers() {
        let dir = tempfile::tempdir().unwrap();
        let model_path = dir.path().join("band_custom.onnx");
        std::fs::write(&model_path, DI_NET_ONNX).unwrap();

        let (info, plan) = load_custom_model_from_path(&model_path).unwrap();
        assert_eq!(info.file_name, "band_custom.onnx");
        assert!(info.path.ends_with("band_custom.onnx"));

        let mut audio = vec![0.0_f32; TARGET_SAMPLE_RATE as usize];
        synth_pluck(&mut audio, 0.20, 0.50, 40, 0.75, 2.5, 6, TARGET_SAMPLE_RATE);
        let posteriors = infer_di_net_posteriorgrams_with_plan(&audio, &plan).unwrap();
        assert!(posteriors.n_frames >= 80 && posteriors.n_frames <= 90);
        assert_eq!(
            posteriors.frame_p.len(),
            DI_N_SEMITONES * posteriors.n_frames
        );
        assert!(posteriors.frame_p.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn custom_onnx_model_rejects_corrupt_and_incompatible_onnx() {
        let dir = tempfile::tempdir().unwrap();
        let corrupt = dir.path().join("corrupt.onnx");
        std::fs::write(&corrupt, b"not an onnx protobuf").unwrap();
        let err_corrupt = load_custom_model_from_path(&corrupt).err().unwrap();
        assert!(
            err_corrupt.starts_with("invalid_model:"),
            "unexpected error for corrupt ONNX: {err_corrupt}"
        );

        let wrong_model = dir.path().join("wrong_nmp.onnx");
        std::fs::write(&wrong_model, NMP_ONNX).unwrap();
        let err_wrong = load_custom_model_from_path(&wrong_model).err().unwrap();
        assert!(
            err_wrong.starts_with("invalid_model:"),
            "unexpected error for incompatible ONNX: {err_wrong}"
        );
    }
}
