//! The user's own cabinet impulse responses: reading a WAV file safely, turning it into taps at the playing rate, and
//! the per-user library the files are kept in.
//!
//! A document names a response by its identity, which is the start of the SHA-256 of the file, and never holds audio.
//! The same file imported on another machine has the same identity, so a shared document finds it there. A response
//! that is missing, damaged or refused leaves the document as it is and the built-in cabinet plays.
//!
//! Everything here runs off the audio thread. The file is read with a bound, parsed by hand with checked arithmetic,
//! resampled to the playing rate, trimmed, faded, and scaled to the level of the built-in cabinets.
use super::ir_convolver::{IrKernel, MAX_SECONDS, RealFft, max_taps};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

/// The largest file read.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// The longest recording accepted. A response longer than `MAX_SECONDS` once its silent tail is trimmed is cut there.
pub const MAX_SOURCE_SECONDS: f64 = 2.0;
pub const MIN_RATE: u32 = 8_000;
pub const MAX_RATE: u32 = 192_000;
/// The most responses a library holds.
pub const MAX_ENTRIES: usize = 256;
/// A response whose loudest sample is below this (-80 dBFS) is silent.
const SILENT_PEAK: f32 = 1e-4;
/// Samples before the first, and after the last, that reach these shares of the peak are dropped from the ends.
const LEAD_FLOOR: f32 = 1e-3;
const TAIL_FLOOR: f32 = 1e-4;
/// The band whose average gain the loaded response is set to 1 over, as the built-in cabinets are drawn against their
/// midrange.
const LEVEL_BAND: (f64, f64) = (400.0, 4_000.0);
/// A response with less than this share of its peak gain across the level band is no guitar cabinet.
const BAND_FLOOR: f64 = 3e-3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemKind {
    /// The library holds no such response.
    Missing,
    /// It holds the file, but it cannot be read.
    Unreadable,
    /// The file is not an acceptable response, and is not imported.
    Refused,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct IrProblem {
    pub kind: ProblemKind,
    pub message: String,
}
impl IrProblem {
    fn new(kind: ProblemKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    fn refused(message: impl Into<String>) -> Self {
        Self::new(ProblemKind::Refused, message)
    }
    fn unreadable(message: impl Into<String>) -> Self {
        Self::new(ProblemKind::Unreadable, message)
    }
}
impl std::fmt::Display for IrProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl From<IrProblem> for String {
    fn from(problem: IrProblem) -> Self {
        problem.message
    }
}

/// A decoded recording, mixed down to one channel.
pub struct Wav {
    pub rate: u32,
    pub channels: u16,
    pub mono: Vec<f32>,
}

fn le16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(at..at.checked_add(2)?)?.try_into().ok()?,
    ))
}
fn le32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

/// Reads a RIFF WAVE file: mono or stereo; 16, 24 or 32 bit integer, or 32 bit float; 8 to 192 kHz; up to
/// `MAX_SOURCE_SECONDS`. Every length it reads is checked against the bytes that exist, so a hostile file can neither
/// panic it nor make it allocate more than a few times the file's size.
pub fn parse_wav(bytes: &[u8]) -> Result<Wav, IrProblem> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(if bytes.get(0..4) == Some(b"RF64".as_slice()) {
            IrProblem::refused("This is an RF64 file. Only ordinary WAV files can be used.")
        } else {
            IrProblem::refused("This is not a WAV file.")
        });
    }
    let (mut position, mut format, mut data) = (12usize, None, None);
    for _ in 0..256 {
        let (Some(id), Some(size)) = (bytes.get(position..position + 4), le32(bytes, position + 4))
        else {
            break;
        };
        let body = position + 8;
        // A size past the end of the file, as a recorder that was stopped early leaves, reads to the end.
        let length = (size as usize).min(bytes.len() - body.min(bytes.len()));
        let chunk = &bytes[body.min(bytes.len())..body.min(bytes.len()) + length];
        match id {
            b"fmt " if format.is_none() => format = Some(chunk),
            b"data" if data.is_none() => data = Some(chunk),
            _ => {}
        }
        if format.is_some() && data.is_some() {
            break;
        }
        let Some(next) = body
            .checked_add(size as usize)
            .and_then(|n| n.checked_add(size as usize & 1))
        else {
            break;
        };
        position = next;
    }
    let format = format.ok_or_else(|| IrProblem::refused("This WAV file has no format chunk."))?;
    let data = data.ok_or_else(|| IrProblem::refused("This WAV file has no audio."))?;
    let (Some(mut tag), Some(channels), Some(rate), Some(align), Some(bits)) = (
        le16(format, 0),
        le16(format, 2),
        le32(format, 4),
        le16(format, 12),
        le16(format, 14),
    ) else {
        return Err(IrProblem::refused(
            "This WAV file's format chunk is damaged.",
        ));
    };
    if tag == 0xFFFE {
        // The extensible format keeps the real tag at the head of its sub-format.
        tag = le16(format, 24)
            .ok_or_else(|| IrProblem::refused("This WAV file's format chunk is damaged."))?;
    }
    let float = match (tag, bits) {
        (1, 16 | 24 | 32) => false,
        (3, 32) => true,
        (1, 8) => {
            return Err(IrProblem::refused(
                "8-bit WAV files are not supported. Use 16, 24 or 32-bit.",
            ));
        }
        (1 | 3, _) => {
            return Err(IrProblem::refused(format!(
                "{bits}-bit {} is not supported. Use 16, 24 or 32-bit integer, or 32-bit float.",
                if tag == 3 { "float" } else { "audio" }
            )));
        }
        _ => {
            return Err(IrProblem::refused(
                "This WAV file is compressed. Use uncompressed PCM or float audio.",
            ));
        }
    };
    if !(1..=2).contains(&channels) {
        return Err(IrProblem::refused(format!(
            "This WAV file has {channels} channels. Only mono and stereo are supported."
        )));
    }
    if !(MIN_RATE..=MAX_RATE).contains(&rate) {
        return Err(IrProblem::refused(format!(
            "The sample rate {rate} Hz is outside {MIN_RATE} to {MAX_RATE} Hz."
        )));
    }
    let width = bits as usize / 8;
    if align as usize != width * channels as usize {
        return Err(IrProblem::refused(
            "This WAV file's format chunk is inconsistent.",
        ));
    }
    let frames = data.len() / align as usize;
    if frames == 0 {
        return Err(IrProblem::refused("This WAV file contains no audio."));
    }
    let seconds = frames as f64 / rate as f64;
    if seconds > MAX_SOURCE_SECONDS {
        return Err(IrProblem::refused(format!(
            "This recording is {seconds:.1} seconds long. A cabinet response is under {MAX_SOURCE_SECONDS:.0} seconds."
        )));
    }
    let sample = |at: usize| -> f32 {
        let b = &data[at..at + width];
        match (float, width) {
            (true, _) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            (false, 2) => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
            (false, 3) => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
            _ => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        }
    };
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let at = frame * align as usize;
        let value = if channels == 2 {
            (sample(at) + sample(at + width)) * 0.5
        } else {
            sample(at)
        };
        if !value.is_finite() {
            return Err(IrProblem::refused(
                "This WAV file holds values that are not numbers.",
            ));
        }
        mono.push(value);
    }
    Ok(Wav {
        rate,
        channels,
        mono,
    })
}

/// The zeroth-order modified Bessel function, by its series.
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, quarter) = (1.0, 1.0, x * x / 4.0);
    for k in 1..60 {
        term *= quarter / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}
/// Moves `input` from one rate to another with a Kaiser-windowed sinc, whose cutoff is a little under the lower
/// rate's Nyquist, normalized to unit gain at DC.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return input.to_vec();
    }
    const ZEROS: f64 = 16.0;
    const BETA: f64 = 9.0;
    let ratio = to as f64 / from as f64;
    let cutoff = 0.5 * if ratio < 1.0 { ratio * 0.97 } else { 1.0 };
    let half = ZEROS / (2.0 * cutoff);
    let window: Vec<f64> = (0..=4096)
        .map(|i| {
            let u = i as f64 / 4096.0;
            bessel_i0(BETA * (1.0 - u * u).sqrt()) / bessel_i0(BETA)
        })
        .collect();
    let weight = |d: f64| {
        let u = (d.abs() / half).min(1.0) * 4096.0;
        let (i, f) = (u as usize, u.fract());
        let w = window[i] + (window[(i + 1).min(4096)] - window[i]) * f;
        let x = 2.0 * cutoff * d;
        let sinc = if x.abs() < 1e-9 {
            1.0
        } else {
            (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
        };
        2.0 * cutoff * sinc * w
    };
    let length = (input.len() * to as usize).div_ceil(from as usize);
    (0..length)
        .map(|n| {
            let at = n as f64 / ratio;
            let first = (at - half).ceil() as i64;
            let last = (at + half).floor() as i64;
            let (mut sum, mut total) = (0.0, 0.0);
            for j in first..=last {
                let w = weight(j as f64 - at);
                total += w;
                if (0..input.len() as i64).contains(&j) {
                    sum += w * input[j as usize] as f64;
                }
            }
            (sum / total) as f32
        })
        .collect()
}

/// The average gain of `taps` between 400 Hz and 4 kHz, and the largest gain anywhere.
fn band_gain(taps: &[f32], rate: u32) -> (f64, f64) {
    let size = taps.len().next_power_of_two().max(4096);
    let fft = RealFft::new(size / 2);
    let mut padded = vec![0.0f32; size];
    padded[..taps.len()].copy_from_slice(taps);
    let (mut re, mut im) = (vec![0.0; size / 2 + 1], vec![0.0; size / 2 + 1]);
    let (mut zr, mut zi) = (vec![0.0; size / 2], vec![0.0; size / 2]);
    fft.forward(&padded, &mut re, &mut im, &mut zr, &mut zi);
    let (low, high) = (LEVEL_BAND.0, LEVEL_BAND.1.min(rate as f64 * 0.45));
    let (mut power, mut bins, mut peak) = (0.0f64, 0usize, 0.0f64);
    for k in 0..=size / 2 {
        let gain = (re[k] as f64).hypot(im[k] as f64);
        peak = peak.max(gain);
        let hz = k as f64 * rate as f64 / size as f64;
        if (low..=high).contains(&hz) {
            power += gain * gain;
            bins += 1;
        }
    }
    ((power / bins.max(1) as f64).sqrt(), peak)
}

/// The taps for a recording at `rate`: resampled, with silence before the onset and after the tail dropped, cut and
/// faded if longer than `MAX_SECONDS`, and scaled so its gain across the guitar's midrange is 1, as the built-in
/// cabinets are drawn. Refuses a recording that is silent, or has nothing in that band.
pub fn prepare_taps(wav: &Wav, rate: u32) -> Result<Vec<f32>, IrProblem> {
    let peak = wav.mono.iter().fold(0.0f32, |p, v| p.max(v.abs()));
    if peak < SILENT_PEAK {
        return Err(IrProblem::refused(
            "This recording is silent, so it cannot be a cabinet response.",
        ));
    }
    let mut taps = resample(&wav.mono, wav.rate, rate);
    let peak = taps.iter().fold(0.0f32, |p, v| p.max(v.abs()));
    let first = taps
        .iter()
        .position(|v| v.abs() >= peak * LEAD_FLOOR)
        .unwrap_or(0);
    let last = taps
        .iter()
        .rposition(|v| v.abs() >= peak * TAIL_FLOOR)
        .unwrap_or(0);
    taps.truncate(last + 1);
    taps.drain(..first);
    let limit = max_taps(rate);
    let cut = taps.len() > limit;
    taps.truncate(limit);
    // A cut ends over a tenth of a second; a response that ended by itself over a millisecond, to stop a click.
    let fade = (if cut {
        rate as usize / 10
    } else {
        rate as usize / 1000
    })
    .clamp(1, taps.len() / 4 + 1);
    let from = taps.len().saturating_sub(fade);
    let tail = taps.len() - from;
    for (i, v) in taps[from..].iter_mut().enumerate() {
        let left = (tail - i) as f32 / tail as f32;
        *v *= 0.5 - 0.5 * (std::f32::consts::PI * left).cos();
    }
    let (band, top) = band_gain(&taps, rate);
    if top <= 0.0 || band < top * BAND_FLOOR {
        return Err(IrProblem::refused(
            "This recording has almost nothing between 400 Hz and 4 kHz, so it does not look like a guitar cabinet.",
        ));
    }
    let scale = (1.0 / band) as f32;
    taps.iter_mut().for_each(|v| *v *= scale);
    if taps.iter().any(|v| !v.is_finite()) {
        return Err(IrProblem::refused("This recording could not be scaled."));
    }
    Ok(taps)
}
/// Whether the response was cut because it ran past `MAX_SECONDS`.
pub fn was_cut(wav: &Wav, rate: u32) -> bool {
    let peak = wav.mono.iter().fold(0.0f32, |p, v| p.max(v.abs()));
    let last = wav
        .mono
        .iter()
        .rposition(|v| v.abs() >= peak * TAIL_FLOOR)
        .unwrap_or(0);
    (last + 1) as f64 * rate as f64 / wav.rate as f64 > rate as f64 * MAX_SECONDS
}

/// What the library keeps about a response, for the picker.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrEntry {
    pub id: String,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_ms: f64,
    pub bytes: u64,
    /// Said once, by an import: that a long response was cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    format: String,
    version: u32,
    name: String,
    sample_rate: u32,
    channels: u16,
    duration_ms: f64,
}
const SIDECAR_FORMAT: &str = "tabplayer-cabinet-ir";
/// What a response's state is, for the sound panel's notice.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrStatus {
    pub id: String,
    /// `ready`, `missing` or `unreadable`.
    pub state: &'static str,
    pub message: Option<String>,
}

/// Whether `id` is a response identity: 32 lowercase hexadecimal digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn identity(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))[..32].to_string()
}
/// A display name from a file name: no control characters or path, trimmed, at most 64 characters.
pub fn display_name(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let clean: String = stem.chars().filter(|c| !c.is_control()).collect();
    let name: String = clean.trim().chars().take(64).collect();
    let name = name.trim().to_string();
    if name.is_empty() {
        "Cabinet IR".into()
    } else {
        name
    }
}
/// Reads a file whole, but not past `MAX_FILE_BYTES`.
fn read_bounded(path: &Path) -> Result<Vec<u8>, IrProblem> {
    if std::fs::metadata(path).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(IrProblem::refused("This is not a file."));
    }
    let file = std::fs::File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            IrProblem::new(ProblemKind::Missing, "The file is missing.")
        }
        _ => IrProblem::unreadable(format!("The file cannot be read: {e}")),
    })?;
    let metadata = file
        .metadata()
        .map_err(|e| IrProblem::unreadable(format!("The file cannot be read: {e}")))?;
    if !metadata.is_file() {
        return Err(IrProblem::refused("This is not a file."));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(IrProblem::refused(format!(
            "This file is larger than {} MB.",
            MAX_FILE_BYTES / 1024 / 1024
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| IrProblem::unreadable(format!("The file cannot be read: {e}")))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(IrProblem::refused(format!(
            "This file is larger than {} MB.",
            MAX_FILE_BYTES / 1024 / 1024
        )));
    }
    Ok(bytes)
}

/// How many kernels the library keeps designed at once.
const CACHE_SIZE: usize = 12;
struct Cached {
    id: String,
    rate: u32,
    kernel: Arc<IrKernel>,
}
/// A folder of responses, one `<id>.wav` and `<id>.json` each, and the kernels designed from them.
pub struct IrLibrary {
    directory: PathBuf,
    cache: Mutex<Vec<Cached>>,
    writes: Mutex<()>,
}
impl IrLibrary {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            cache: Mutex::new(Vec::new()),
            writes: Mutex::new(()),
        }
    }
    fn wav_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.wav"))
    }
    fn meta_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.json"))
    }
    fn cache(&self) -> std::sync::MutexGuard<'_, Vec<Cached>> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Copies the file at `path` into the library.
    pub fn import_path(&self, path: &Path) -> Result<IrEntry, IrProblem> {
        let bytes = read_bounded(path)?;
        let name = display_name(&path.to_string_lossy());
        self.import_bytes(&bytes, &name)
    }
    /// Copies `bytes`, a WAV file called `name`, into the library, unless it is not an acceptable response. Importing
    /// a file that is already there changes nothing.
    pub fn import_bytes(&self, bytes: &[u8], name: &str) -> Result<IrEntry, IrProblem> {
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(IrProblem::refused("This file is too large."));
        }
        let wav = parse_wav(bytes)?;
        // The file must make a response at the usual rates, so a refusal comes now and not at the first note.
        prepare_taps(&wav, 48_000)?;
        let notice = was_cut(&wav, 48_000).then(|| {
            format!("Longer than {MAX_SECONDS:.0} second, so the end was faded out and cut.")
        });
        let id = identity(bytes);
        let _guard = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        let existing = self.entries_unlocked();
        if !existing.iter().any(|e| e.id == id) && existing.len() >= MAX_ENTRIES {
            return Err(IrProblem::refused(format!(
                "The library holds {MAX_ENTRIES} responses. Remove one first."
            )));
        }
        let kept = existing.into_iter().find(|e| e.id == id);
        let entry = IrEntry {
            id: id.clone(),
            name: kept
                .as_ref()
                .map_or_else(|| display_name(name), |e| e.name.clone()),
            sample_rate: wav.rate,
            channels: wav.channels,
            duration_ms: wav.mono.len() as f64 * 1000.0 / wav.rate as f64,
            bytes: bytes.len() as u64,
            notice,
        };
        if kept.is_none() {
            std::fs::create_dir_all(&self.directory).map_err(|e| {
                IrProblem::unreadable(format!("The library cannot be written: {e}"))
            })?;
            crate::files::write_bytes(&self.wav_path(&id), bytes).map_err(IrProblem::unreadable)?;
            let sidecar = serde_json::to_vec_pretty(&Sidecar {
                format: SIDECAR_FORMAT.into(),
                version: 1,
                name: entry.name.clone(),
                sample_rate: entry.sample_rate,
                channels: entry.channels,
                duration_ms: entry.duration_ms,
            })
            .map_err(|e| IrProblem::unreadable(e.to_string()))?;
            crate::files::write_bytes(&self.meta_path(&id), &sidecar)
                .map_err(IrProblem::unreadable)?;
        }
        Ok(entry)
    }
    fn entries_unlocked(&self) -> Vec<IrEntry> {
        let Ok(read) = std::fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        let mut entries: Vec<IrEntry> = read
            .flatten()
            .filter_map(|file| {
                let name = file.file_name().into_string().ok()?;
                let id = name.strip_suffix(".wav")?;
                if !valid_id(id) {
                    return None;
                }
                let bytes = file.metadata().ok()?.len();
                let sidecar = std::fs::read(self.meta_path(id))
                    .ok()
                    .filter(|b| b.len() < 4096)
                    .and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok())
                    .filter(|s| s.format == SIDECAR_FORMAT && s.version == 1);
                Some(match sidecar {
                    Some(s) => IrEntry {
                        id: id.into(),
                        name: display_name(&format!("{}.wav", s.name)),
                        sample_rate: s.sample_rate,
                        channels: s.channels,
                        duration_ms: s.duration_ms,
                        bytes,
                        notice: None,
                    },
                    // A response whose description is lost is described again from its audio.
                    None => {
                        let wav = read_bounded(&file.path())
                            .ok()
                            .and_then(|b| parse_wav(&b).ok())?;
                        IrEntry {
                            id: id.into(),
                            name: "Cabinet IR".into(),
                            sample_rate: wav.rate,
                            channels: wav.channels,
                            duration_ms: wav.mono.len() as f64 * 1000.0 / wav.rate as f64,
                            bytes,
                            notice: None,
                        }
                    }
                })
            })
            .collect();
        entries.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        entries.truncate(MAX_ENTRIES);
        entries
    }
    /// Every response in the library, by name.
    pub fn list(&self) -> Vec<IrEntry> {
        let _guard = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        self.entries_unlocked()
    }
    /// Takes a response out of the library. Documents that name it fall back to the built-in cabinet; a track already
    /// playing it carries on until its sound is next prepared.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Not a cabinet response identity.".into());
        }
        let _guard = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        for path in [self.wav_path(id), self.meta_path(id)] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("The response could not be removed: {e}")),
            }
        }
        self.cache().retain(|c| c.id != id);
        Ok(())
    }
    /// The taps for `id` at `rate`, checked against the identity it was filed under.
    pub fn taps(&self, id: &str, rate: u32) -> Result<Vec<f32>, IrProblem> {
        if !valid_id(id) {
            return Err(IrProblem::new(
                ProblemKind::Missing,
                "Not a cabinet response identity.",
            ));
        }
        let bytes = read_bounded(&self.wav_path(id))?;
        if identity(&bytes) != id {
            return Err(IrProblem::unreadable(
                "The file has changed since it was imported.",
            ));
        }
        let wav = parse_wav(&bytes).map_err(|p| IrProblem::unreadable(p.message))?;
        prepare_taps(&wav, rate).map_err(|p| IrProblem::unreadable(p.message))
    }
    /// The kernel for `id` at `rate`, designed once. Call off the audio thread: this reads a file the first time.
    pub fn kernel(&self, id: &str, rate: u32) -> Result<Arc<IrKernel>, IrProblem> {
        if let Some(found) = self.cache().iter().find(|c| c.id == id && c.rate == rate) {
            return Ok(found.kernel.clone());
        }
        let taps = self.taps(id, rate)?;
        let kernel = Arc::new(IrKernel::new(&taps, rate).map_err(IrProblem::unreadable)?);
        let mut cache = self.cache();
        if let Some(found) = cache.iter().find(|c| c.id == id && c.rate == rate) {
            return Ok(found.kernel.clone());
        }
        if cache.len() >= CACHE_SIZE {
            cache.remove(0);
        }
        cache.push(Cached {
            id: id.into(),
            rate,
            kernel: kernel.clone(),
        });
        Ok(kernel)
    }
    /// Whether each response can play, for the notice that says the built-in cabinet is playing instead.
    pub fn status(&self, ids: &[String]) -> Vec<IrStatus> {
        ids.iter()
            .map(|id| match self.taps(id, 48_000) {
                Ok(_) => IrStatus {
                    id: id.clone(),
                    state: "ready",
                    message: None,
                },
                Err(problem) => IrStatus {
                    id: id.clone(),
                    state: if problem.kind == ProblemKind::Missing {
                        "missing"
                    } else {
                        "unreadable"
                    },
                    message: Some(problem.message),
                },
            })
            .collect()
    }
}

static LIBRARY: Mutex<Option<Arc<IrLibrary>>> = Mutex::new(None);
/// Makes the folder at `directory` the library every track resolves its responses from.
pub fn install(directory: PathBuf) -> Arc<IrLibrary> {
    let library = Arc::new(IrLibrary::new(directory));
    *LIBRARY.lock().unwrap_or_else(PoisonError::into_inner) = Some(library.clone());
    library
}
pub fn library() -> Option<Arc<IrLibrary>> {
    LIBRARY
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}
/// The kernel a track plays for `id`, or `None` where the built-in cabinet plays instead: no library, no such
/// response, or one that cannot be read. Never an error, because a document must always open and play.
pub fn resolve(id: &str, rate: u32) -> Option<Arc<IrKernel>> {
    library()?.kernel(id, rate).ok()
}

/// The file the desktop acceptance run picks, in place of the file dialog.
#[cfg(feature = "desktop-test")]
fn test_selection() -> Option<Option<PathBuf>> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() != Ok("1") {
        return None;
    }
    let list = std::env::var_os("TABPLAYER_TEST_CABINET_IR")?;
    // Files are taken in turn, one for each import; `|` cannot occur in a Windows file name.
    let list = list.to_string_lossy().into_owned();
    let paths: Vec<&str> = list.split('|').collect();
    Some(
        paths
            .get(NEXT.fetch_add(1, Ordering::SeqCst))
            .map(PathBuf::from),
    )
}

fn library_for(app: &tauri::AppHandle) -> Result<Arc<IrLibrary>, String> {
    if let Some(library) = library() {
        return Ok(library);
    }
    Ok(install(
        crate::tuning_library_directory(app)?.join("cabinet-irs"),
    ))
}

#[tauri::command]
pub async fn cabinet_ir_list(app: tauri::AppHandle) -> Result<Vec<IrEntry>, String> {
    let library = library_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.list())
        .await
        .map_err(|e| e.to_string())
}
/// Asks for a WAV file and copies it into the library. `None` when the dialog is cancelled; an error says why a file
/// was refused.
#[tauri::command]
pub async fn cabinet_ir_import(app: tauri::AppHandle) -> Result<Option<IrEntry>, String> {
    use tauri_plugin_dialog::DialogExt;
    let library = library_for(&app)?;
    #[cfg(feature = "desktop-test")]
    let chosen = test_selection();
    #[cfg(not(feature = "desktop-test"))]
    let chosen: Option<Option<PathBuf>> = None;
    let path = match chosen {
        Some(path) => path,
        None => app
            .dialog()
            .file()
            .add_filter("Cabinet impulse response", &["wav"])
            .blocking_pick_file()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()?,
    };
    let Some(path) = path else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || library.import_path(&path).map(Some))
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)
}
#[tauri::command]
pub async fn cabinet_ir_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let library = library_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.remove(&id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn cabinet_ir_status(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<Vec<IrStatus>, String> {
    let library = library_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.status(&ids[..ids.len().min(64)]))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests;
