use super::flac;
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, num::NonZeroU8, num::NonZeroU32, rc::Rc};
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoder, VorbisEncoderBuilder};
pub const BLOCK_FRAMES: usize = 512;
/// The RMS levels, in dB relative to full scale, that normalization can aim for.
pub const NORMALIZE_RMS_DB: std::ops::RangeInclusive<f64> = -30.0..=-6.0;
/// Normalization never lifts a sample above this peak, in dB relative to full scale.
pub const NORMALIZE_CEILING_DB: f64 = -1.0;
/// Normalization lifts the audio by at most this many dB, so a nearly silent export, such as a range holding only an
/// effect tail, is not raised into audible noise.
pub const NORMALIZE_MAX_GAIN_DB: f64 = 40.0;
/// Ogg Vorbis quality, from -0.2 to 1: 0.6 aims near 192 kbit/s for stereo music.
pub const OGG_QUALITY: f32 = 0.6;
/// The Ogg stream serial number. Fixed, so the same audio always encodes to the same file.
const OGG_SERIAL: i32 = 0x5450_4c59;
/// The audio file type: RIFF WAV, little-endian, AIFF, big-endian, lossless FLAC, or compressed Ogg Vorbis.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AudioContainer {
    #[default]
    Wav,
    Aiff,
    Flac,
    Ogg,
}
impl AudioContainer {
    fn is_wav(&self) -> bool {
        *self == AudioContainer::Wav
    }
    /// The file extension.
    pub fn extension(self) -> &'static str {
        match self {
            AudioContainer::Wav => "wav",
            AudioContainer::Aiff => "aiff",
            AudioContainer::Flac => "flac",
            AudioContainer::Ogg => "ogg",
        }
    }
    /// The most sample bytes a file can hold: a RIFF size is unsigned, and an AIFF chunk size is signed. FLAC is
    /// limited by its frame count instead, and Ogg by nothing a song reaches.
    fn max_data_bytes(self) -> u64 {
        match self {
            AudioContainer::Wav => u32::MAX as u64 - 36,
            AudioContainer::Aiff => i32::MAX as u64 - 46,
            AudioContainer::Flac | AudioContainer::Ogg => u64::MAX,
        }
    }
    /// The header's length; the samples follow it.
    fn header_bytes(self) -> u64 {
        match self {
            AudioContainer::Wav => 44,
            AudioContainer::Aiff => 54,
            AudioContainer::Flac => flac::HEADER_BYTES as u64,
            AudioContainer::Ogg => 0,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioFormat {
    pub sample_rate: u32,
    /// Ogg Vorbis encodes floating-point samples, so it ignores the bit depth.
    pub bit_depth: u16,
    /// Requests and stem manifests written before AIFF read as WAV, which is not written.
    #[serde(default, skip_serializing_if = "AudioContainer::is_wav")]
    pub container: AudioContainer,
}
impl AudioFormat {
    /// A WAV format.
    pub fn wav(sample_rate: u32, bit_depth: u16) -> Self {
        Self {
            sample_rate,
            bit_depth,
            container: AudioContainer::Wav,
        }
    }
    pub fn validate(self) -> Result<(), String> {
        if ![44100, 48000].contains(&self.sample_rate) || ![16, 24].contains(&self.bit_depth) {
            Err("Choose stereo 44.1/48 kHz, 16/24-bit WAV, AIFF, FLAC or Ogg Vorbis.".into())
        } else {
            Ok(())
        }
    }
}
/// `rate` as the 80-bit IEEE 754 extended number an AIFF header stores.
fn extended(rate: u32) -> [u8; 10] {
    let shift = rate.leading_zeros();
    let exponent = 16_383 + 31 - shift as u16;
    let mantissa = (rate as u64) << (32 + shift);
    let mut bytes = [0; 10];
    bytes[..2].copy_from_slice(&exponent.to_be_bytes());
    bytes[2..].copy_from_slice(&mantissa.to_be_bytes());
    bytes
}
/// Where the Vorbis encoder writes its pages: a buffer `PcmWriter` moves into its file after each block, so the file
/// stays the writer's own for every container.
#[derive(Clone, Default)]
struct OggPages(Rc<RefCell<Vec<u8>>>);
impl Write for OggPages {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub struct PcmWriter<W: Write + Seek> {
    file: W,
    format: AudioFormat,
    frames: u64,
    random: u32,
    /// FLAC only: samples of each channel waiting for a whole block, the blocks written, and the bytes they took.
    pending: [Vec<i32>; 2],
    blocks: u32,
    written: u64,
    frame_bytes: (u32, u32),
    /// Ogg only: the encoder, the pages it has written and not yet moved to the file, and each channel's samples.
    ogg: Option<(VorbisEncoder<OggPages>, OggPages, [Vec<f32>; 2])>,
}
impl<W: Write + Seek> PcmWriter<W> {
    pub fn new(mut file: W, format: AudioFormat) -> Result<Self, String> {
        format.validate()?;
        file.write_all(&vec![0; format.container.header_bytes() as usize])
            .map_err(|e| e.to_string())?;
        let ogg = if format.container == AudioContainer::Ogg {
            let pages = OggPages::default();
            let encoder = VorbisEncoderBuilder::new_with_serial(
                NonZeroU32::new(format.sample_rate).ok_or("Invalid sample rate.")?,
                NonZeroU8::new(2).unwrap(),
                pages.clone(),
                OGG_SERIAL,
            )
            .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
                target_quality: OGG_QUALITY,
            })
            .comment_tag("ENCODER", "TabPlayer")
            .and_then(|builder| builder.build())
            .map_err(|e| format!("Ogg Vorbis encoder failed: {e}"))?;
            Some((
                encoder,
                pages,
                [
                    Vec::with_capacity(BLOCK_FRAMES),
                    Vec::with_capacity(BLOCK_FRAMES),
                ],
            ))
        } else {
            None
        };
        Ok(Self {
            file,
            format,
            frames: 0,
            random: 0x6a09e667,
            pending: [Vec::new(), Vec::new()],
            blocks: 0,
            written: 0,
            frame_bytes: (u32::MAX, 0),
            ogg,
        })
    }
    /// Moves the pages the Vorbis encoder has written into the file.
    fn move_ogg_pages(file: &mut W, pages: &OggPages) -> Result<(), String> {
        let mut pages = pages.0.borrow_mut();
        file.write_all(&pages).map_err(|e| e.to_string())?;
        pages.clear();
        Ok(())
    }
    fn uniform(&mut self) -> f64 {
        self.random ^= self.random << 13;
        self.random ^= self.random >> 17;
        self.random ^= self.random << 5;
        self.random as f64 / (u32::MAX as f64 + 1.0)
    }
    pub fn write_block(&mut self, block: &[[f32; 2]]) -> Result<(), String> {
        if block.len() > BLOCK_FRAMES {
            return Err("Audio export block exceeds 512 frames.".into());
        }
        let bytes_per_sample = (self.format.bit_depth / 8) as usize;
        let new_frames = self.frames + block.len() as u64;
        if new_frames * 2 * bytes_per_sample as u64 > self.format.container.max_data_bytes()
            || self.format.container == AudioContainer::Flac && new_frames > flac::MAX_FRAMES
        {
            return Err(match self.format.container {
                AudioContainer::Wav => {
                    "WAV exceeds the standard RIFF size limit. Export a shorter range."
                }
                AudioContainer::Aiff => {
                    "AIFF exceeds the standard size limit. Export a shorter range."
                }
                AudioContainer::Flac => "FLAC exceeds its size limit. Export a shorter range.",
                AudioContainer::Ogg => "Ogg Vorbis exceeds its size limit. Export a shorter range.",
            }
            .into());
        }
        if let Some((encoder, pages, channels)) = &mut self.ogg {
            for channel in channels.iter_mut() {
                channel.clear();
            }
            for frame in block {
                for (channel, sample) in channels.iter_mut().zip(frame) {
                    if !sample.is_finite() {
                        return Err("Audio renderer produced a non-finite sample.".into());
                    }
                    channel.push(sample.clamp(-1.0, 1.0));
                }
            }
            if !block.is_empty() {
                encoder
                    .encode_audio_block(&*channels)
                    .map_err(|e| format!("Ogg Vorbis encoder failed: {e}"))?;
            }
            Self::move_ogg_pages(&mut self.file, pages)?;
            self.frames = new_frames;
            return Ok(());
        }
        let scale = (1_i64 << (self.format.bit_depth - 1)) as f64;
        let mut bytes = Vec::with_capacity(block.len() * 2 * bytes_per_sample);
        for sample in block.iter().flatten() {
            if !sample.is_finite() {
                return Err("Audio renderer produced a non-finite sample.".into());
            }
            let dither = self.uniform() - self.uniform();
            let value = ((*sample as f64).clamp(-1.0, 1.0) * scale + dither)
                .round()
                .clamp(-scale, scale - 1.0) as i32;
            match self.format.container {
                AudioContainer::Wav => {
                    bytes.extend_from_slice(&value.to_le_bytes()[..bytes_per_sample])
                }
                AudioContainer::Aiff => {
                    bytes.extend_from_slice(&value.to_be_bytes()[4 - bytes_per_sample..])
                }
                AudioContainer::Flac => {
                    let channel = self.pending[0].len() - self.pending[1].len();
                    self.pending[channel].push(value)
                }
                AudioContainer::Ogg => unreachable!("Ogg blocks are encoded above"),
            }
        }
        self.file.write_all(&bytes).map_err(|e| e.to_string())?;
        self.frames = new_frames;
        if self.pending[0].len() >= flac::BLOCK_FRAMES {
            self.write_flac_block()?;
        }
        Ok(())
    }
    /// Encodes and writes up to one FLAC block of the pending samples.
    fn write_flac_block(&mut self) -> Result<(), String> {
        let n = self.pending[0].len().min(flac::BLOCK_FRAMES);
        let frame = flac::encode_frame(
            self.blocks,
            self.format.sample_rate,
            self.format.bit_depth as u32,
            &self.pending[0][..n],
            &self.pending[1][..n],
        )?;
        self.file.write_all(&frame).map_err(|e| e.to_string())?;
        for channel in &mut self.pending {
            channel.drain(..n);
        }
        self.blocks += 1;
        self.written += frame.len() as u64;
        self.frame_bytes = (
            self.frame_bytes.0.min(frame.len() as u32),
            self.frame_bytes.1.max(frame.len() as u32),
        );
        Ok(())
    }
    pub fn finish(mut self) -> Result<(W, u64), String> {
        if let Some((encoder, pages, _)) = self.ogg.take() {
            // Finishing writes the last pages, which mark the end of the stream and hold its exact length.
            encoder
                .finish()
                .map_err(|e| format!("Ogg Vorbis encoder failed: {e}"))?;
            Self::move_ogg_pages(&mut self.file, &pages)?;
            self.file.flush().map_err(|e| e.to_string())?;
            return Ok((self.file, self.frames));
        }
        if self.format.container == AudioContainer::Flac {
            while !self.pending[0].is_empty() {
                self.write_flac_block()?;
            }
            let actual = self
                .file
                .seek(SeekFrom::End(0))
                .map_err(|e| e.to_string())?;
            if actual != flac::HEADER_BYTES as u64 + self.written
                || self.blocks as u64 != self.frames.div_ceil(flac::BLOCK_FRAMES as u64)
            {
                return Err("Audio frame verification failed.".into());
            }
            let header = flac::stream_header(
                self.format.sample_rate,
                self.format.bit_depth as u32,
                self.frames,
                if self.blocks == 0 {
                    0
                } else {
                    self.frame_bytes.0
                },
                self.frame_bytes.1,
            );
            return self.write_header(&header);
        }
        let size = (self.frames * 2 * (self.format.bit_depth / 8) as u64) as u32;
        let actual = self
            .file
            .seek(SeekFrom::End(0))
            .map_err(|e| e.to_string())?;
        let header_bytes = self.format.container.header_bytes();
        if actual != header_bytes + size as u64 {
            return Err("Audio frame verification failed.".into());
        }
        let mut header = Vec::with_capacity(header_bytes as usize);
        if self.format.container == AudioContainer::Aiff {
            header.extend_from_slice(b"FORM");
            header.extend_from_slice(&(46 + size).to_be_bytes());
            header.extend_from_slice(b"AIFFCOMM");
            header.extend_from_slice(&18_u32.to_be_bytes());
            header.extend_from_slice(&2_u16.to_be_bytes());
            header.extend_from_slice(&(self.frames as u32).to_be_bytes());
            header.extend_from_slice(&self.format.bit_depth.to_be_bytes());
            header.extend_from_slice(&extended(self.format.sample_rate));
            header.extend_from_slice(b"SSND");
            header.extend_from_slice(&(8 + size).to_be_bytes());
            // No offset and no block alignment.
            header.extend_from_slice(&[0; 8]);
            return self.write_header(&header);
        }
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&(36 + size).to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16_u32.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&2_u16.to_le_bytes());
        header.extend_from_slice(&self.format.sample_rate.to_le_bytes());
        header.extend_from_slice(
            &(self.format.sample_rate * 2 * (self.format.bit_depth / 8) as u32).to_le_bytes(),
        );
        header.extend_from_slice(&(2 * (self.format.bit_depth / 8)).to_le_bytes());
        header.extend_from_slice(&self.format.bit_depth.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&size.to_le_bytes());
        self.write_header(&header)
    }
    fn write_header(mut self, header: &[u8]) -> Result<(W, u64), String> {
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;
        self.file.write_all(header).map_err(|e| e.to_string())?;
        self.file.flush().map_err(|e| e.to_string())?;
        Ok((self.file, self.frames))
    }
}
static SCRATCH: AtomicU64 = AtomicU64::new(0);
/// A file removed when it goes out of scope.
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
/// What normalization measured and applied.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Normalized {
    pub frames: u64,
    /// The rendered RMS level and sample peak over both channels, before the gain, in dB relative to full scale.
    pub rms_db: f64,
    pub peak_db: f64,
    pub gain_db: f64,
}
/// Renders all of the audio into a scratch file beside `path`, then writes it as `write_wav` does with one gain that
/// brings its RMS level over both channels to `target_rms_db`, lowered where needed so no sample peaks above
/// `NORMALIZE_CEILING_DB` and limited to `NORMALIZE_MAX_GAIN_DB`. Silence is written unchanged. `progress` counts the frames of both passes.
pub fn write_normalized_wav(
    path: &Path,
    format: AudioFormat,
    target_rms_db: f64,
    mut render: impl FnMut(&mut [[f32; 2]]) -> Result<usize, String>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<Normalized, String> {
    format.validate()?;
    if !NORMALIZE_RMS_DB.contains(&target_rms_db) {
        return Err("Choose a normalization level from -30 to -6 dB RMS.".into());
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let scratch = Scratch(parent.join(format!(
        ".tabplayer-normalize-{}-{}",
        std::process::id(),
        SCRATCH.fetch_add(1, Ordering::Relaxed)
    )));
    let mut file = BufWriter::new(File::create_new(&scratch.0).map_err(|e| e.to_string())?);
    let mut block = [[0.0; 2]; BLOCK_FRAMES];
    let (mut frames, mut sum, mut peak) = (0u64, 0.0f64, 0.0f32);
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Audio export cancelled.".into());
        }
        let count = render(&mut block)?;
        if count > block.len() {
            return Err("Audio renderer returned an invalid frame count.".into());
        }
        if count == 0 {
            break;
        }
        for sample in block[..count].iter().flatten() {
            if !sample.is_finite() {
                return Err("Audio renderer produced a non-finite sample.".into());
            }
            sum += (*sample as f64).powi(2);
            peak = peak.max(sample.abs());
            file.write_all(&sample.to_le_bytes())
                .map_err(|e| e.to_string())?;
        }
        frames += count as u64;
        progress(frames);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let db = |value: f64| 20.0 * value.max(1e-12).log10();
    let rms = if frames == 0 {
        0.0
    } else {
        (sum / (2 * frames) as f64).sqrt()
    };
    let gain = if peak == 0.0 {
        1.0
    } else {
        (10f64.powf(target_rms_db / 20.0) / rms)
            .min(10f64.powf(NORMALIZE_CEILING_DB / 20.0) / peak as f64)
            .min(10f64.powf(NORMALIZE_MAX_GAIN_DB / 20.0))
    };
    let mut reader = BufReader::new(File::open(&scratch.0).map_err(|e| e.to_string())?);
    let mut bytes = vec![0; BLOCK_FRAMES * 8];
    let mut remaining = frames;
    let written = write_wav(
        path,
        format,
        |output| {
            let count = (remaining.min(output.len() as u64)) as usize;
            reader
                .read_exact(&mut bytes[..count * 8])
                .map_err(|e| e.to_string())?;
            for (frame, chunk) in output[..count].iter_mut().zip(bytes.chunks_exact(8)) {
                for (c, value) in frame.iter_mut().enumerate() {
                    let raw = f32::from_le_bytes(chunk[c * 4..c * 4 + 4].try_into().unwrap());
                    *value = (raw as f64 * gain) as f32;
                }
            }
            remaining -= count as u64;
            Ok(count)
        },
        cancel,
        |written| progress(frames + written),
    )?;
    Ok(Normalized {
        frames: written,
        rms_db: db(rms),
        peak_db: db(peak as f64),
        gain_db: db(gain),
    })
}
pub fn write_wav(
    path: &Path,
    format: AudioFormat,
    mut render: impl FnMut(&mut [[f32; 2]]) -> Result<usize, String>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<u64, String> {
    format.validate()?;
    if cancel.load(Ordering::Acquire) {
        return Err("Audio export cancelled.".into());
    }
    let file = AtomicWriteFile::open(path).map_err(|e| e.to_string())?;
    let mut writer = PcmWriter::new(file, format)?;
    let mut block = [[0.0; 2]; BLOCK_FRAMES];
    let mut frames = 0;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Audio export cancelled.".into());
        }
        let count = render(&mut block)?;
        if count > block.len() {
            return Err("Audio renderer returned an invalid frame count.".into());
        }
        if count == 0 {
            break;
        }
        writer.write_block(&block[..count])?;
        frames += count as u64;
        progress(frames);
    }
    let (file, frames) = writer.finish()?;
    if cancel.load(Ordering::Acquire) {
        return Err("Audio export cancelled.".into());
    }
    file.commit().map_err(|e| e.to_string())?;
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[test]
    fn streams_stereo_pcm_at_each_rate_and_depth_with_independent_header_reader() {
        let d = tempfile::tempdir().unwrap();
        for rate in [44100, 48000] {
            for depth in [16, 24] {
                let path = d.path().join(format!("{rate}-{depth}.wav"));
                let mut remain = 1025;
                let frames = write_wav(
                    &path,
                    AudioFormat::wav(rate, depth),
                    |block| {
                        assert!(block.len() <= 512);
                        let count = remain.min(block.len());
                        for sample in &mut block[..count] {
                            *sample = [0.25, -0.5];
                        }
                        remain -= count;
                        Ok(count)
                    },
                    &AtomicBool::new(false),
                    |_| {},
                )
                .unwrap();
                assert_eq!(frames, 1025);
                let mut reader = hound::WavReader::open(&path).unwrap();
                let spec = reader.spec();
                assert_eq!(spec.channels, 2);
                assert_eq!(spec.sample_rate, rate);
                assert_eq!(spec.bits_per_sample, depth);
                assert_eq!(reader.duration(), 1025);
                let samples: Vec<i32> = reader.samples::<i32>().map(Result::unwrap).collect();
                let scale = (1_i32 << (depth - 1)) as f64;
                assert!((samples[0] as f64 / scale - 0.25).abs() < 0.0001);
                assert!((samples[1] as f64 / scale + 0.5).abs() < 0.0001);
            }
        }
    }
    #[test]
    fn cancellation_or_nonfinite_render_preserves_prior_file_and_cleans_temporary() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("existing.wav");
        std::fs::write(&path, b"prior").unwrap();
        let cancel = AtomicBool::new(false);
        let result = write_wav(
            &path,
            AudioFormat::wav(48000, 16),
            |block| {
                block.fill([0.2, 0.3]);
                cancel.store(true, Ordering::Release);
                Ok(block.len())
            },
            &cancel,
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"prior");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
        assert!(
            write_wav(
                &path,
                AudioFormat::wav(48000, 16),
                |b| {
                    b[0] = [f32::NAN, 0.0];
                    Ok(1)
                },
                &AtomicBool::new(false),
                |_| {}
            )
            .is_err()
        );
        assert_eq!(std::fs::read(path).unwrap(), b"prior");
    }
    #[test]
    fn dither_is_deterministic_and_silent_samples_remain_bounded() {
        let d = tempfile::tempdir().unwrap();
        let mut outputs = Vec::new();
        for i in 0..2 {
            let path = d.path().join(format!("{i}.wav"));
            let mut first = true;
            write_wav(
                &path,
                AudioFormat::wav(44100, 16),
                |b| {
                    if !first {
                        return Ok(0);
                    }
                    first = false;
                    b.fill([0.0, 1.5]);
                    Ok(b.len())
                },
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            outputs.push(std::fs::read(path).unwrap());
        }
        assert_eq!(outputs[0], outputs[1]);
        let mut r = hound::WavReader::new(std::io::Cursor::new(&outputs[0])).unwrap();
        let v: Vec<i16> = r.samples().map(Result::unwrap).collect();
        assert!(v.iter().step_by(2).all(|v| v.abs() <= 1));
        assert!(v.iter().skip(1).step_by(2).all(|v| *v >= 32766));
    }
    /// The rate, frame count, bit depth and big-endian samples of an AIFF file, read chunk by chunk.
    fn read_aiff(bytes: &[u8]) -> (f64, u32, u16, Vec<i32>) {
        assert_eq!(&bytes[..4], b"FORM");
        assert_eq!(
            u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize,
            bytes.len() - 8
        );
        assert_eq!(&bytes[8..12], b"AIFF");
        let (mut at, mut comm, mut samples) = (12, None, None);
        while at < bytes.len() {
            let size = u32::from_be_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            let body = &bytes[at + 8..at + 8 + size];
            match &bytes[at..at + 4] {
                b"COMM" => comm = Some(body.to_vec()),
                b"SSND" => samples = Some(body[8..].to_vec()),
                other => panic!("unexpected chunk {other:?}"),
            }
            at += 8 + size + size % 2;
        }
        let comm = comm.unwrap();
        assert_eq!(u16::from_be_bytes(comm[..2].try_into().unwrap()), 2);
        let frames = u32::from_be_bytes(comm[2..6].try_into().unwrap());
        let bits = u16::from_be_bytes(comm[6..8].try_into().unwrap());
        let exponent = u16::from_be_bytes(comm[8..10].try_into().unwrap()) as i32 - 16_383;
        let mantissa = u64::from_be_bytes(comm[10..18].try_into().unwrap());
        let rate = mantissa as f64 * 2f64.powi(exponent - 63);
        let width = bits as usize / 8;
        let samples = samples
            .unwrap()
            .chunks(width)
            .map(|b| {
                let mut v = [0; 4];
                v[..width].copy_from_slice(b);
                i32::from_be_bytes(v) >> (32 - bits)
            })
            .collect();
        (rate, frames, bits, samples)
    }
    #[test]
    fn writes_aiff_and_flac_with_the_same_samples_as_wav_at_each_rate_and_depth() {
        let d = tempfile::tempdir().unwrap();
        // Two whole FLAC blocks and a short one, written in render blocks that do not divide them.
        const N: usize = 9_000;
        for rate in [44100, 48000] {
            for depth in [16, 24] {
                let mut outputs = Vec::new();
                for container in [
                    AudioContainer::Wav,
                    AudioContainer::Aiff,
                    AudioContainer::Flac,
                ] {
                    let path = d
                        .path()
                        .join(format!("{rate}-{depth}.{}", container.extension()));
                    let mut n = 0usize;
                    let frames = write_wav(
                        &path,
                        AudioFormat {
                            sample_rate: rate,
                            bit_depth: depth,
                            container,
                        },
                        |block| {
                            let count = (N - n).min(block.len());
                            for (i, sample) in block[..count].iter_mut().enumerate() {
                                let t = (n + i) as f32;
                                *sample = [(t * 0.031).sin() * 0.9, -(t * 0.017).cos() * 0.5];
                            }
                            n += count;
                            Ok(count)
                        },
                        &AtomicBool::new(false),
                        |_| {},
                    )
                    .unwrap();
                    assert_eq!(frames, N as u64);
                    outputs.push(std::fs::read(path).unwrap());
                }
                let mut reader = hound::WavReader::new(std::io::Cursor::new(&outputs[0])).unwrap();
                let wav: Vec<i32> = reader.samples::<i32>().map(Result::unwrap).collect();
                let (aiff_rate, frames, bits, aiff) = read_aiff(&outputs[1]);
                assert_eq!((aiff_rate, frames, bits), (rate as f64, N as u32, depth));
                // The same dithered samples, in the other byte order.
                assert_eq!(aiff, wav, "{rate} Hz {depth} bit");
                assert_eq!(outputs[1].len(), 54 + N * 2 * depth as usize / 8);
                // FLAC decodes to exactly the same samples, and its stream information counts them.
                let flac = &outputs[2];
                let decoded = crate::audio::decode::decode_audio(flac, Some("flac")).unwrap();
                assert_eq!((decoded.sample_rate, decoded.channels), (rate, 2));
                let scale = (1i64 << (depth - 1)) as f64;
                let samples: Vec<i32> = decoded
                    .frames
                    .iter()
                    .flatten()
                    .map(|v| (*v as f64 * scale).round() as i32)
                    .collect();
                assert_eq!(samples, wav, "FLAC at {rate} Hz {depth} bit");
                assert_eq!(&flac[..4], b"fLaC");
                let info = u64::from_be_bytes(flac[18..26].try_into().unwrap());
                assert_eq!(info >> 44, rate as u64);
                assert_eq!((info >> 36) & 0x1f, depth as u64 - 1);
                assert_eq!(info & 0xf_ffff_ffff, N as u64);
                assert!(flac.len() < outputs[0].len(), "FLAC is smaller than WAV");
            }
        }
    }
    #[test]
    fn ogg_vorbis_decodes_independently_to_the_same_length_and_sound() {
        let d = tempfile::tempdir().unwrap();
        // Ten seconds of a chord with a different line in each channel, rendered in uneven blocks.
        const N: usize = 441_000;
        let source = |t: usize| {
            let t = t as f32 / 44_100.0;
            let tau = std::f32::consts::TAU;
            [
                0.3 * (tau * 220.0 * t).sin() + 0.2 * (tau * 330.0 * t).sin(),
                0.25 * (tau * 440.0 * t).sin() - 0.15 * (tau * 165.0 * t).cos(),
            ]
        };
        let path = d.path().join("song.ogg");
        let mut n = 0;
        let mut odd = false;
        let frames = write_wav(
            &path,
            AudioFormat {
                sample_rate: 44_100,
                bit_depth: 16,
                container: AudioContainer::Ogg,
            },
            |block| {
                odd = !odd;
                let count = (N - n).min(if odd { 300 } else { block.len() });
                for (i, sample) in block[..count].iter_mut().enumerate() {
                    *sample = source(n + i);
                }
                n += count;
                Ok(count)
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(frames, N as u64);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"OggS");
        // Compressed: well under a tenth of 16-bit WAV.
        assert!(bytes.len() < N * 4 / 10, "{} bytes", bytes.len());
        let decoded = crate::audio::decode::decode_audio(&bytes, Some("ogg")).unwrap();
        assert_eq!((decoded.sample_rate, decoded.channels), (44_100, 2));
        assert_eq!(decoded.frames.len(), N, "the stream keeps the exact length");
        // Lossy but faithful: the error is more than 30 dB below the signal in each channel.
        for channel in 0..2 {
            let (mut signal, mut error) = (0.0f64, 0.0f64);
            for (t, frame) in decoded.frames.iter().enumerate() {
                let want = source(t)[channel] as f64;
                signal += want * want;
                error += (frame[channel] as f64 - want).powi(2);
            }
            let snr = 10.0 * (signal / error).log10();
            assert!(snr > 30.0, "channel {channel}: {snr:.1} dB");
        }
        // The same audio, in the same blocks, encodes to the same file whatever the bit depth asked for.
        let again = d.path().join("again.ogg");
        let mut m = 0;
        let mut odd = false;
        write_wav(
            &again,
            AudioFormat {
                sample_rate: 44_100,
                bit_depth: 24,
                container: AudioContainer::Ogg,
            },
            |block| {
                odd = !odd;
                let count = (N - m).min(if odd { 300 } else { block.len() });
                for (i, sample) in block[..count].iter_mut().enumerate() {
                    *sample = source(m + i);
                }
                m += count;
                Ok(count)
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(
            std::fs::read(&again).unwrap() == bytes,
            "the two encodings differ"
        );
    }
    #[test]
    fn an_empty_ogg_export_is_a_valid_stream() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("empty.ogg");
        let format = AudioFormat {
            sample_rate: 48_000,
            bit_depth: 16,
            container: AudioContainer::Ogg,
        };
        assert_eq!(
            write_wav(&path, format, |_| Ok(0), &AtomicBool::new(false), |_| {}).unwrap(),
            0
        );
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"OggS");
        let mut writer = PcmWriter::new(std::io::Cursor::new(Vec::new()), format).unwrap();
        assert!(writer.write_block(&[[f32::NAN, 0.0]]).is_err());
    }
    #[test]
    fn older_requests_read_as_wav_and_only_aiff_or_flac_is_written() {
        let older: AudioFormat =
            serde_json::from_str(r#"{"sampleRate":48000,"bitDepth":16}"#).unwrap();
        assert_eq!(older, AudioFormat::wav(48000, 16));
        assert_eq!(
            serde_json::to_string(&older).unwrap(),
            r#"{"sampleRate":48000,"bitDepth":16}"#
        );
        let aiff: AudioFormat =
            serde_json::from_str(r#"{"sampleRate":44100,"bitDepth":24,"container":"aiff"}"#)
                .unwrap();
        assert_eq!(aiff.container, AudioContainer::Aiff);
        assert_eq!(
            serde_json::to_string(&aiff).unwrap(),
            r#"{"sampleRate":44100,"bitDepth":24,"container":"aiff"}"#
        );
        let flac: AudioFormat =
            serde_json::from_str(r#"{"sampleRate":48000,"bitDepth":16,"container":"flac"}"#)
                .unwrap();
        assert_eq!(flac.container, AudioContainer::Flac);
        assert_eq!(
            serde_json::to_string(&flac).unwrap(),
            r#"{"sampleRate":48000,"bitDepth":16,"container":"flac"}"#
        );
        let ogg: AudioFormat =
            serde_json::from_str(r#"{"sampleRate":44100,"bitDepth":16,"container":"ogg"}"#)
                .unwrap();
        assert_eq!(ogg.container, AudioContainer::Ogg);
        assert_eq!(
            serde_json::to_string(&ogg).unwrap(),
            r#"{"sampleRate":44100,"bitDepth":16,"container":"ogg"}"#
        );
        for wrong in [
            r#""mp3""#,
            r#""FLAC""#,
            r#""AIFF""#,
            r#""OGG""#,
            "null",
            "1",
        ] {
            assert!(
                serde_json::from_str::<AudioFormat>(&format!(
                    r#"{{"sampleRate":48000,"bitDepth":16,"container":{wrong}}}"#
                ))
                .is_err(),
                "{wrong}"
            );
        }
        assert_eq!(extended(44100), [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
        assert_eq!(extended(48000), [0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
    }
    #[test]
    fn each_container_refuses_audio_past_its_size_limit() {
        for (container, limit) in [
            (AudioContainer::Wav, u32::MAX as u64 - 36),
            (AudioContainer::Aiff, i32::MAX as u64 - 46),
            (AudioContainer::Flac, flac::MAX_FRAMES * 4),
        ] {
            let format = AudioFormat {
                container,
                ..AudioFormat::wav(48000, 16)
            };
            // 16-bit stereo frames are 4 bytes: fill up to the last whole frame that fits.
            let mut writer = PcmWriter::new(std::io::Cursor::new(Vec::new()), format).unwrap();
            writer.frames = limit / 4 - 1;
            writer.write_block(&[[0.0; 2]]).unwrap();
            let error = writer.write_block(&[[0.0; 2]]).unwrap_err();
            assert!(error.contains("Export a shorter range"), "{error}");
        }
    }
    #[test]
    fn a_cancelled_aiff_or_flac_leaves_the_prior_file() {
        for container in [
            AudioContainer::Aiff,
            AudioContainer::Flac,
            AudioContainer::Ogg,
        ] {
            let d = tempfile::tempdir().unwrap();
            let path = d.path().join(format!("existing.{}", container.extension()));
            std::fs::write(&path, b"prior").unwrap();
            let cancel = AtomicBool::new(false);
            let format = AudioFormat {
                container,
                ..AudioFormat::wav(48000, 24)
            };
            let result = write_wav(
                &path,
                format,
                |block| {
                    block.fill([0.2, 0.3]);
                    cancel.store(true, Ordering::Release);
                    Ok(block.len())
                },
                &cancel,
                |_| {},
            );
            assert!(result.is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"prior");
            assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
        }
    }
    /// Writes `frames` frames of `signal` normalized to `target` dB RMS as 24-bit 48 kHz WAV, and reads them back.
    fn normalized(
        dir: &Path,
        name: &str,
        frames: usize,
        target: f64,
        signal: impl Fn(usize) -> [f32; 2],
    ) -> (Normalized, Vec<f64>, Vec<u64>) {
        let path = dir.join(name);
        let mut n = 0;
        let mut seen = Vec::new();
        let result = write_normalized_wav(
            &path,
            AudioFormat::wav(48000, 24),
            target,
            |block| {
                let count = (frames - n).min(block.len());
                for (i, sample) in block[..count].iter_mut().enumerate() {
                    *sample = signal(n + i);
                }
                n += count;
                Ok(count)
            },
            &AtomicBool::new(false),
            |done| seen.push(done),
        )
        .unwrap();
        let mut reader = hound::WavReader::open(&path).unwrap();
        let samples = reader
            .samples::<i32>()
            .map(|v| v.unwrap() as f64 / 8_388_608.0)
            .collect();
        (result, samples, seen)
    }
    fn rms_db(samples: &[f64]) -> f64 {
        10.0 * (samples.iter().map(|v| v * v).sum::<f64>() / samples.len() as f64).log10()
    }
    fn peak_db(samples: &[f64]) -> f64 {
        20.0 * samples.iter().fold(0.0f64, |a, v| a.max(v.abs())).log10()
    }
    #[test]
    fn normalization_brings_the_rms_level_to_the_target() {
        let d = tempfile::tempdir().unwrap();
        // A quiet 440 Hz sine in both channels peaking at -27 dBFS, so about -30 dB RMS.
        let amplitude = 10f64.powf(-27.0 / 20.0);
        let tone = |n: usize| {
            let v =
                ((std::f64::consts::TAU * 440.0 * n as f64 / 48_000.0).sin() * amplitude) as f32;
            [v, -v]
        };
        for target in [-20.0, -16.0, -12.0] {
            let (result, samples, seen) = normalized(d.path(), "tone.wav", 96_000, target, tone);
            assert_eq!(result.frames, 96_000);
            assert!(
                (result.rms_db - (-27.0 - 20.0 * 2f64.sqrt().log10())).abs() < 0.01,
                "{result:?}"
            );
            assert!((result.peak_db + 27.0).abs() < 0.01, "{result:?}");
            assert!(
                (result.gain_db - (target - result.rms_db)).abs() < 1e-9,
                "{result:?}"
            );
            assert!(
                (rms_db(&samples) - target).abs() < 0.01,
                "{target}: {}",
                rms_db(&samples)
            );
            // Progress counts the render and then the write.
            assert_eq!(*seen.last().unwrap(), 192_000);
            assert!(seen.windows(2).all(|w| w[0] < w[1]));
            assert!(seen.contains(&96_000));
        }
        // Only the WAV is left: the scratch file is gone.
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn normalization_never_lifts_a_peak_above_minus_one_dbfs() {
        let d = tempfile::tempdir().unwrap();
        // A quiet tone with one loud click: reaching -12 dB RMS would push the click far past full scale.
        let signal = |n: usize| {
            let v = if n == 30_000 {
                0.5
            } else {
                ((n as f32) * 0.05).sin() * 0.01
            };
            [v, v]
        };
        let (result, samples, _) = normalized(d.path(), "click.wav", 48_000, -12.0, signal);
        assert!((result.peak_db - 20.0 * 0.5f64.log10()).abs() < 0.01);
        assert!(
            (result.gain_db - (-1.0 - result.peak_db)).abs() < 0.01,
            "{result:?}"
        );
        assert!(
            (peak_db(&samples) + 1.0).abs() < 0.01,
            "peak {}",
            peak_db(&samples)
        );
        assert!(
            rms_db(&samples) < -12.0 - 6.0,
            "the level stays well under the target"
        );
        // A loud signal is turned down to the target.
        let (loud, samples, _) = normalized(d.path(), "loud.wav", 48_000, -20.0, |n| {
            [((n as f32) * 0.05).sin() * 0.9; 2]
        });
        assert!(loud.gain_db < -15.0, "{loud:?}");
        assert!((rms_db(&samples) + 20.0).abs() < 0.01);
        // A residue at -120 dBFS is lifted by at most 40 dB rather than to the target.
        let (faint, _, _) = normalized(d.path(), "faint.wav", 48_000, -16.0, |n| {
            [((n as f32) * 0.05).sin() * 1e-6; 2]
        });
        assert!((faint.gain_db - 40.0).abs() < 1e-9, "{faint:?}");
    }
    #[test]
    fn normalization_writes_silence_unchanged_and_refuses_other_levels() {
        let d = tempfile::tempdir().unwrap();
        let (result, samples, _) = normalized(d.path(), "silence.wav", 4_800, -16.0, |_| [0.0; 2]);
        assert_eq!(result.gain_db, 0.0);
        // Dither alone: within one 24-bit step of zero.
        assert!(samples.iter().all(|v| v.abs() <= 1.0 / 8_388_608.0));
        for target in [-30.5, -5.9, f64::NAN] {
            let error = write_normalized_wav(
                &d.path().join("refused.wav"),
                AudioFormat::wav(48000, 16),
                target,
                |_| Ok(0),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap_err();
            assert!(error.contains("-30 to -6 dB RMS"), "{error}");
        }
        assert!(!d.path().join("refused.wav").exists());
    }
    #[test]
    fn a_cancelled_or_failed_normalized_export_leaves_the_prior_file_and_no_scratch() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("existing.wav");
        std::fs::write(&path, b"prior").unwrap();
        // Cancelled while rendering, cancelled while writing, and a renderer failure.
        for stop_after in [2usize, 5, 0] {
            let cancel = AtomicBool::new(false);
            let mut blocks = 0usize;
            let mut written = 0u64;
            let result = write_normalized_wav(
                &path,
                AudioFormat::wav(48000, 16),
                -16.0,
                |block| {
                    if stop_after == 0 && blocks == 1 {
                        return Err("renderer failed".into());
                    }
                    if blocks == 4 {
                        return Ok(0);
                    }
                    blocks += 1;
                    block.fill([0.1, 0.1]);
                    if blocks == stop_after {
                        cancel.store(true, Ordering::Release);
                    }
                    Ok(block.len())
                },
                &cancel,
                |done| {
                    written = done;
                    if stop_after == 5 && done > 4 * BLOCK_FRAMES as u64 {
                        cancel.store(true, Ordering::Release);
                    }
                },
            );
            assert!(result.is_err(), "{stop_after}");
            assert_eq!(std::fs::read(&path).unwrap(), b"prior");
            assert_eq!(
                std::fs::read_dir(d.path()).unwrap().count(),
                1,
                "{stop_after}: only the earlier file is left"
            );
            if stop_after == 5 {
                assert!(
                    written > 4 * BLOCK_FRAMES as u64,
                    "the write pass had started"
                );
            }
        }
    }
}
