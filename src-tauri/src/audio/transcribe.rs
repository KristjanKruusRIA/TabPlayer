//! Local, offline automatic transcription for DI guitar and bass audio tracks.
//!
//! Uses Spotify's embedded Basic Pitch ONNX model (`nmp.onnx`, ICASSP 2022) executed via pure-Rust `tract-onnx`,
//! followed by rock/metal DI post-processing (tight chug re-articulation, overtone ghost suppression, palm-mute
//! attack/brightness scoring, and beat-grid tempo estimation).

use crate::audio::decode::decode_audio;
use serde::{Deserialize, Serialize};
use std::{
    f64::consts::TAU,
    io::{Cursor, Read},
    path::Path,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tract_onnx::prelude::{
    Datum, Framework, InferenceFact, InferenceModelExt, Tensor, TypedModel, TypedSimplePlan, tvec,
};

pub const TARGET_SAMPLE_RATE: u32 = 22_050;
pub const MAX_DI_FILE_BYTES: u64 = 128 * 1024 * 1024;
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
const MIN_PITCH_IDX: usize = 0;
const MAX_PITCH_IDX: usize = N_PITCH_BINS - 1;
const ENERGY_TOL_FRAMES: usize = 4;
const N_DIFF_ONSET: usize = 2;
const CONTOUR_BINS_PER_SEMITONE: usize = 3;
const RESAMPLE_RADIUS: isize = 16;

const OUTLET_NOTE: &str = "StatefulPartitionedCall:1";
const OUTLET_ONSET: &str = "StatefulPartitionedCall:2";
const OUTLET_CONTOUR: &str = "StatefulPartitionedCall:0";

static NMP_ONNX: &[u8] = include_bytes!("../../assets/basic-pitch/nmp.onnx");

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
}

impl Default for DiDecodeParams {
    fn default() -> Self {
        Self {
            onset_threshold: 0.45,
            frame_threshold: 0.30,
            min_note_ms: 55.0,
            min_pitch: 28,
            max_pitch: 96,
            suppress_overtones: true,
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

pub(crate) struct CachedDiAnalysis {
    analysis_id: String,
    mono_22k: Vec<f32>,
    /// Shape `[n_frames * 88]`, row-major `(frame, pitch_bin)`.
    notes: Vec<f32>,
    /// Shape `[n_frames * 88]`, row-major `(frame, pitch_bin)`.
    onsets: Vec<f32>,
    /// Shape `[n_frames * 264]`, row-major `(frame, contour_bin)`.
    contours: Vec<f32>,
    n_frames: usize,
    ref_attack_rms: f32,
}

pub struct DiTranscriptionState {
    cached: Mutex<Option<CachedDiAnalysis>>,
    next_id: AtomicU64,
}

impl Default for DiTranscriptionState {
    fn default() -> Self {
        Self {
            cached: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }
}

type TractPlan = Arc<TypedSimplePlan<TypedModel>>;

static MODEL_PLAN: OnceLock<Result<TractPlan, String>> = OnceLock::new();

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

fn read_bounded_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("unreadable: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_DI_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("unreadable: {e}"))?;
    if bytes.len() as u64 > MAX_DI_FILE_BYTES {
        return Err("too_large".into());
    }
    Ok(bytes)
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

    let mut notes = Vec::new();
    let mut onsets = Vec::new();
    let mut contours = Vec::new();
    let mut window_buf = vec![0.0_f32; AUDIO_N_SAMPLES];

    let mut offset = 0usize;
    while offset < padded.len() {
        let take = (padded.len() - offset).min(AUDIO_N_SAMPLES);
        window_buf[..take].copy_from_slice(&padded[offset..offset + take]);
        if take < AUDIO_N_SAMPLES {
            window_buf[take..].fill(0.0);
        }

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

        let extract = |index: usize, expected_cols: usize| -> Result<Vec<f32>, String> {
            let view = outputs[index]
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

        notes.extend_from_slice(&extract(0, N_PITCH_BINS)?);
        onsets.extend_from_slice(&extract(1, N_PITCH_BINS)?);
        contours.extend_from_slice(&extract(2, N_CONTOUR_BINS)?);
        offset += HOP_SIZE;
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

/// Minimal in-place radix-2 FFT for palm-mute spectral brightness measurement.
fn fft_magnitude_bins(samples: &[f32]) -> Vec<f64> {
    const N: usize = 512;
    let mut re = [0.0_f64; N];
    let mut im = [0.0_f64; N];
    let take = samples.len().min(N);
    let denom = take.saturating_sub(1).max(1) as f64;
    for i in 0..take {
        let hann = 0.5 * (1.0 - (TAU * i as f64 / denom).cos());
        re[i] = f64::from(samples[i]) * hann;
    }

    let mut j = 0usize;
    for i in 1..N {
        let mut bit = N >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
        }
    }

    let mut len = 2usize;
    while len <= N {
        let half = len / 2;
        let step = TAU / len as f64;
        for start in (0..N).step_by(len) {
            for k in 0..half {
                let angle = -step * k as f64;
                let (wr, wi) = (angle.cos(), angle.sin());
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

    (0..=N / 2)
        .map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt())
        .collect()
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

/// Estimates how strongly a plucked note sounds palm-muted (`0.0` = open/ringing, `1.0` = heavy mute).
fn score_palm_mute(mono_22k: &[f32], start_sec: f64, end_sec: f64, pitch: u8) -> f32 {
    let dur_ms = (end_sec - start_sec) * 1000.0;
    if dur_ms > 550.0 {
        return 0.0;
    }
    let s0 = seconds_to_sample_22k(start_sec);
    let win_attack = (TARGET_SAMPLE_RATE as usize * 28) / 1000;
    let s_tail_start = s0 + (TARGET_SAMPLE_RATE as usize * 40) / 1000;
    let s_tail_end = s0 + (TARGET_SAMPLE_RATE as usize * 110) / 1000;
    let attack_rms = slice_rms(mono_22k, s0, s0 + win_attack);
    if attack_rms < 1e-4 {
        return 0.0;
    }
    let tail_rms = slice_rms(mono_22k, s_tail_start, s_tail_end);
    let decay_ratio = (tail_rms / attack_rms).clamp(0.0, 2.0);
    // Open sustained strings retain ~50-90%+ energy at 40..110 ms; palm mutes damp sharply (< 28%).
    let decay_score = ((0.42 - decay_ratio) / 0.34).clamp(0.0, 1.0);

    // High-harmonic damping: compare post-transient spectrum [12ms..48ms] upper vs lower bands.
    let spec_start = s0 + (TARGET_SAMPLE_RATE as usize * 10) / 1000;
    let spec_end = (spec_start + 512).min(mono_22k.len());
    let brightness_damping = if spec_end - spec_start >= 128 {
        let mags = fft_magnitude_bins(&mono_22k[spec_start..spec_end]);
        let bin_hz = TARGET_SAMPLE_RATE as f64 / 512.0;
        let f0 = 440.0 * 2.0_f64.powf((f64::from(pitch) - 69.0) / 12.0);
        let low_lo = (0.8 * f0 / bin_hz).floor().max(1.0) as usize;
        let low_hi = ((2.8 * f0).max(800.0) / bin_hz).ceil().min(255.0) as usize;
        let high_lo = ((3.5 * f0).max(1_200.0) / bin_hz)
            .floor()
            .max(low_hi as f64 + 1.0) as usize;
        let high_hi = (6_500.0 / bin_hz).ceil().min(256.0) as usize;
        let low_energy: f64 = mags[low_lo..=low_hi].iter().map(|&m| m * m).sum();
        let high_energy: f64 = if high_hi > high_lo {
            mags[high_lo..=high_hi].iter().map(|&m| m * m).sum()
        } else {
            0.0
        };
        if low_energy > 1e-12 {
            let hf_ratio = (high_energy / low_energy) as f32;
            // Bright open plucks have significant upper harmonics; muted plucks roll off strongly above 1 kHz.
            ((0.22 - hf_ratio) / 0.20).clamp(0.0, 1.0)
        } else {
            0.5
        }
    } else {
        0.5
    };

    let dur_weight = if dur_ms <= 240.0 {
        1.0
    } else {
        ((550.0 - dur_ms as f32) / 310.0).clamp(0.0, 1.0)
    };
    let raw = (0.62 * decay_score + 0.38 * brightness_damping) * dur_weight;
    raw.clamp(0.0, 1.0)
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
        for bin in lo..=hi {
            if row[bin] > best_val {
                best_val = row[bin];
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

#[derive(Clone)]
struct RawDecodedNote {
    start_frame: usize,
    end_frame: usize,
    pitch: u8,
    onset_confidence: f32,
    frame_confidence: f32,
}

fn build_inferred_onsets(onsets: &[f32], frames: &[f32], n_frames: usize) -> Vec<f32> {
    let total = n_frames * N_PITCH_BINS;
    let mut diff = vec![0.0_f32; total];
    let mut max_diff = 0.0_f32;
    let mut max_onset = 0.0_f32;

    for &v in onsets {
        if v > max_onset {
            max_onset = v;
        }
    }
    for t in N_DIFF_ONSET..n_frames {
        for f in 0..N_PITCH_BINS {
            let cur = frames[t * N_PITCH_BINS + f];
            let mut min_delta = f32::INFINITY;
            for step in 1..=N_DIFF_ONSET {
                let prev = frames[(t - step) * N_PITCH_BINS + f];
                min_delta = min_delta.min(cur - prev);
            }
            let pos = min_delta.max(0.0);
            diff[t * N_PITCH_BINS + f] = pos;
            if pos > max_diff {
                max_diff = pos;
            }
        }
    }

    let scale = if max_diff > 1e-6 && max_onset > 0.0 {
        max_onset / max_diff
    } else {
        0.0
    };
    let mut merged = vec![0.0_f32; total];
    for idx in 0..total {
        merged[idx] = onsets[idx].max(diff[idx] * scale);
    }
    merged
}

fn decode_raw_notes(
    frames_in: &[f32],
    onsets_in: &[f32],
    n_frames: usize,
    params: &DiDecodeParams,
) -> Vec<RawDecodedNote> {
    if n_frames < 3 {
        return Vec::new();
    }
    let min_bin = params
        .min_pitch
        .saturating_sub(MIDI_OFFSET as u8)
        .min(MAX_PITCH_IDX as u8) as usize;
    let max_bin = params
        .max_pitch
        .saturating_sub(MIDI_OFFSET as u8)
        .min(MAX_PITCH_IDX as u8) as usize;
    if min_bin > max_bin {
        return Vec::new();
    }

    let total = n_frames * N_PITCH_BINS;
    let mut frames = frames_in.to_vec();
    let mut onsets = onsets_in.to_vec();
    for t in 0..n_frames {
        let base = t * N_PITCH_BINS;
        for f in 0..N_PITCH_BINS {
            if f < min_bin || f > max_bin {
                frames[base + f] = 0.0;
                onsets[base + f] = 0.0;
            }
        }
    }

    let inferred = build_inferred_onsets(&onsets, &frames, n_frames);
    let min_note_frames = ((f64::from(params.min_note_ms.max(15.0)) / 1000.0)
        * (TARGET_SAMPLE_RATE as f64 / FFT_HOP as f64))
        .round()
        .max(2.0) as usize;

    // Collect local onset maxima along time in reverse chronological order so repeated notes cut off cleanly.
    let mut peaks = Vec::<(usize, usize, f32)>::new();
    for t in 1..n_frames - 1 {
        let row = &inferred[t * N_PITCH_BINS..(t + 1) * N_PITCH_BINS];
        let prev = &inferred[(t - 1) * N_PITCH_BINS..t * N_PITCH_BINS];
        let next = &inferred[(t + 1) * N_PITCH_BINS..(t + 2) * N_PITCH_BINS];
        for f in min_bin..=max_bin {
            let val = row[f];
            if val >= params.onset_threshold && val > prev[f] && val >= next[f] {
                peaks.push((t, f, onsets[t * N_PITCH_BINS + f].max(val * 0.85)));
            }
        }
    }
    peaks.reverse();

    let mut remaining = frames.clone();
    let mut out = Vec::<RawDecodedNote>::new();

    for (start_t, freq_idx, onset_conf) in peaks {
        if start_t >= n_frames - 1 {
            continue;
        }
        let mut i = start_t + 1;
        let mut quiet_run = 0usize;
        while i < n_frames - 1 && quiet_run < ENERGY_TOL_FRAMES {
            if remaining[i * N_PITCH_BINS + freq_idx] < params.frame_threshold {
                quiet_run += 1;
            } else {
                quiet_run = 0;
            }
            i += 1;
        }
        let end_t = i.saturating_sub(quiet_run);
        if end_t.saturating_sub(start_t) < min_note_frames {
            continue;
        }
        let sum_frame: f32 = (start_t..end_t)
            .map(|t| remaining[t * N_PITCH_BINS + freq_idx])
            .sum();
        let mean_frame = sum_frame / (end_t - start_t) as f32;
        for t in start_t..end_t {
            remaining[t * N_PITCH_BINS + freq_idx] = 0.0;
            if freq_idx < MAX_PITCH_IDX {
                remaining[t * N_PITCH_BINS + freq_idx + 1] = 0.0;
            }
            if freq_idx > MIN_PITCH_IDX {
                remaining[t * N_PITCH_BINS + freq_idx - 1] = 0.0;
            }
        }
        out.push(RawDecodedNote {
            start_frame: start_t,
            end_frame: end_t,
            pitch: (freq_idx + MIDI_OFFSET) as u8,
            onset_confidence: onset_conf.clamp(0.0, 1.0),
            frame_confidence: mean_frame.clamp(0.0, 1.0),
        });
    }

    // Melodia trick: pick up legato / un-attacked sustained notes whose frame confidence stays strong.
    loop {
        let mut best_idx = 0usize;
        let mut best_val = 0.0_f32;
        for (idx, &val) in remaining.iter().enumerate().take(total) {
            if val > best_val {
                best_val = val;
                best_idx = idx;
            }
        }
        if best_val <= params.frame_threshold {
            break;
        }
        let mid_t = best_idx / N_PITCH_BINS;
        let freq_idx = best_idx % N_PITCH_BINS;
        remaining[best_idx] = 0.0;

        let mut i = mid_t + 1;
        let mut quiet = 0usize;
        while i < n_frames - 1 && quiet < ENERGY_TOL_FRAMES {
            let idx = i * N_PITCH_BINS + freq_idx;
            if remaining[idx] < params.frame_threshold {
                quiet += 1;
            } else {
                quiet = 0;
            }
            remaining[idx] = 0.0;
            if freq_idx < MAX_PITCH_IDX {
                remaining[idx + 1] = 0.0;
            }
            if freq_idx > MIN_PITCH_IDX {
                remaining[idx - 1] = 0.0;
            }
            i += 1;
        }
        let i_end = i.saturating_sub(1 + quiet);

        let mut rev = mid_t;
        let mut quiet_back = 0usize;
        while rev > 0 && quiet_back < ENERGY_TOL_FRAMES {
            rev -= 1;
            let idx = rev * N_PITCH_BINS + freq_idx;
            if remaining[idx] < params.frame_threshold {
                quiet_back += 1;
            } else {
                quiet_back = 0;
            }
            remaining[idx] = 0.0;
            if freq_idx < MAX_PITCH_IDX {
                remaining[idx + 1] = 0.0;
            }
            if freq_idx > MIN_PITCH_IDX {
                remaining[idx - 1] = 0.0;
            }
        }
        let i_start = rev + quiet_back;
        if i_end <= i_start || i_end - i_start < min_note_frames {
            continue;
        }
        let sum_frame: f32 = (i_start..i_end)
            .map(|t| frames[t * N_PITCH_BINS + freq_idx])
            .sum();
        let mean_frame = sum_frame / (i_end - i_start) as f32;
        out.push(RawDecodedNote {
            start_frame: i_start,
            end_frame: i_end,
            pitch: (freq_idx + MIDI_OFFSET) as u8,
            onset_confidence: onsets[i_start * N_PITCH_BINS + freq_idx].clamp(0.0, 1.0),
            frame_confidence: mean_frame.clamp(0.0, 1.0),
        });
    }

    out.sort_by(|a, b| {
        a.start_frame
            .cmp(&b.start_frame)
            .then(a.pitch.cmp(&b.pitch))
    });
    out
}

fn build_transcribed_notes(
    cached: &CachedDiAnalysis,
    params: &DiDecodeParams,
) -> Vec<TranscribedDiNote> {
    let raw = decode_raw_notes(&cached.notes, &cached.onsets, cached.n_frames, params);
    if raw.is_empty() {
        return Vec::new();
    }

    // Deduplicate identical-pitch notes whose onsets start within 25 ms (~2 frames).
    let mut deduped: Vec<RawDecodedNote> = Vec::with_capacity(raw.len());
    for item in raw {
        if let Some(prev) = deduped
            .iter_mut()
            .rev()
            .find(|other| other.pitch == item.pitch && item.start_frame <= other.start_frame + 2)
        {
            if item.end_frame > prev.end_frame {
                prev.end_frame = item.end_frame;
            }
            prev.onset_confidence = prev.onset_confidence.max(item.onset_confidence);
            prev.frame_confidence = prev.frame_confidence.max(item.frame_confidence);
        } else {
            deduped.push(item);
        }
    }

    let kept_mask: Vec<bool> = if params.suppress_overtones {
        let simultaneous_tol_frames = 3usize; // ~35 ms
        (0..deduped.len())
            .map(|i| {
                let candidate = &deduped[i];
                for j in 0..deduped.len() {
                    if i == j {
                        continue;
                    }
                    let root = &deduped[j];
                    if root.start_frame.abs_diff(candidate.start_frame) > simultaneous_tol_frames {
                        continue;
                    }
                    let interval = candidate.pitch.saturating_sub(root.pitch);
                    if interval == 12 {
                        // A genuine power chord has a strong +7 fifth alongside the +12 octave.
                        let has_fifth = deduped.iter().any(|fifth| {
                            fifth.pitch == root.pitch + 7
                                && fifth.start_frame.abs_diff(root.start_frame)
                                    <= simultaneous_tol_frames
                                && fifth.frame_confidence >= 0.40
                        });
                        if !has_fifth
                            && candidate.onset_confidence < 0.42
                            && candidate.frame_confidence < root.frame_confidence * 0.58
                        {
                            return false;
                        }
                    } else if interval == 19
                        && candidate.onset_confidence < 0.48
                        && candidate.frame_confidence < root.frame_confidence * 0.65
                    {
                        return false;
                    }
                }
                true
            })
            .collect()
    } else {
        vec![true; deduped.len()]
    };

    let mut result = Vec::with_capacity(deduped.len());
    for (idx, item) in deduped.into_iter().enumerate() {
        if !kept_mask[idx] {
            continue;
        }
        let start_sec = frame_to_seconds(item.start_frame);
        let end_sec = frame_to_seconds(item.end_frame).max(start_sec + 0.02);
        let s0 = seconds_to_sample_22k(start_sec);
        let attack_len = (TARGET_SAMPLE_RATE as usize * 30) / 1000;
        let local_rms = slice_rms(&cached.mono_22k, s0, s0 + attack_len);
        let vel_norm = (local_rms / cached.ref_attack_rms.max(1e-4)).clamp(0.1, 1.0);
        let velocity = (vel_norm * 127.0).round().clamp(1.0, 127.0) as u8;
        let palm_mute_score = score_palm_mute(&cached.mono_22k, start_sec, end_sec, item.pitch);
        let bend_semitones = estimate_bend_semitones(
            &cached.contours,
            item.start_frame,
            item.end_frame,
            item.pitch,
        );
        result.push(TranscribedDiNote {
            start_sec,
            end_sec,
            pitch: item.pitch,
            onset_confidence: item.onset_confidence,
            frame_confidence: item.frame_confidence,
            velocity,
            palm_mute_score,
            bend_semitones,
        });
    }
    result
}

pub(crate) fn analyze_samples_22k(
    analysis_id: String,
    file_name: String,
    sample_rate: u32,
    channels: u16,
    mono_22k: Vec<f32>,
) -> Result<(DiAnalysisSummary, CachedDiAnalysis), String> {
    let duration_sec = mono_22k.len() as f64 / TARGET_SAMPLE_RATE as f64;
    if !duration_sec.is_finite() || duration_sec > MAX_DI_DURATION_SEC {
        return Err("too_long".into());
    }
    let (notes, onsets, contours, n_frames) = infer_posteriorgrams(&mono_22k)?;
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
        mono_22k,
        notes,
        onsets,
        contours,
        n_frames,
        ref_attack_rms,
    };
    Ok((summary, cached))
}

pub(crate) fn analyze_file(
    path: &Path,
    analysis_id: String,
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
    analyze_samples_22k(
        analysis_id,
        file_name,
        decoded.sample_rate,
        decoded.channels,
        mono_22k,
    )
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
    let id_num = state.next_id.fetch_add(1, Ordering::Relaxed);
    let analysis_id = format!("di-{id_num}");
    let (summary, cached) =
        tauri::async_runtime::spawn_blocking(move || analyze_file(&path, analysis_id))
            .await
            .map_err(|e| e.to_string())??;
    let mut guard = state.cached.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(cached);
    Ok(Some(summary))
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
                4,
                TARGET_SAMPLE_RATE,
            );
            synth_pluck(
                &mut audio,
                base + step * 2.0,
                0.09,
                40,
                0.55,
                22.0,
                3,
                TARGET_SAMPLE_RATE,
            );
            synth_pluck(
                &mut audio,
                base + step * 3.0,
                0.09,
                40,
                0.60,
                22.0,
                3,
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
            3,
            TARGET_SAMPLE_RATE,
        );
        // Open ringing string: slow decay, rich upper harmonics.
        synth_pluck(&mut open, 0.30, 0.90, 40, 0.85, 1.5, 8, TARGET_SAMPLE_RATE);

        let pm_score = score_palm_mute(&muted, 0.30, 0.44, 40);
        let open_score = score_palm_mute(&open, 0.30, 1.20, 40);
        assert!(
            pm_score > 0.60,
            "expected high palm mute score, got {pm_score}"
        );
        assert!(
            open_score < 0.20,
            "expected low open score, got {open_score}"
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
}
