use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{
    io::{Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
pub const BLOCK_FRAMES: usize = 512;
/// The audio file type: RIFF WAV, little-endian, or AIFF, big-endian.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AudioContainer {
    #[default]
    Wav,
    Aiff,
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
        }
    }
    /// The most sample bytes a file can hold: a RIFF size is unsigned, and an AIFF chunk size is signed.
    fn max_data_bytes(self) -> u64 {
        match self {
            AudioContainer::Wav => u32::MAX as u64 - 36,
            AudioContainer::Aiff => i32::MAX as u64 - 46,
        }
    }
    /// The header's length; the samples follow it.
    fn header_bytes(self) -> u64 {
        match self {
            AudioContainer::Wav => 44,
            AudioContainer::Aiff => 54,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioFormat {
    pub sample_rate: u32,
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
            Err("Choose stereo 44.1/48 kHz, 16/24-bit PCM WAV or AIFF.".into())
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
pub struct PcmWriter<W: Write + Seek> {
    file: W,
    format: AudioFormat,
    frames: u64,
    random: u32,
}
impl<W: Write + Seek> PcmWriter<W> {
    pub fn new(mut file: W, format: AudioFormat) -> Result<Self, String> {
        format.validate()?;
        file.write_all(&vec![0; format.container.header_bytes() as usize])
            .map_err(|e| e.to_string())?;
        Ok(Self {
            file,
            format,
            frames: 0,
            random: 0x6a09e667,
        })
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
        if new_frames * 2 * bytes_per_sample as u64 > self.format.container.max_data_bytes() {
            return Err(match self.format.container {
                AudioContainer::Wav => {
                    "WAV exceeds the standard RIFF size limit. Export a shorter range."
                }
                AudioContainer::Aiff => {
                    "AIFF exceeds the standard size limit. Export a shorter range."
                }
            }
            .into());
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
            }
        }
        self.file.write_all(&bytes).map_err(|e| e.to_string())?;
        self.frames = new_frames;
        Ok(())
    }
    pub fn finish(mut self) -> Result<(W, u64), String> {
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
    fn writes_aiff_with_the_same_samples_as_wav_at_each_rate_and_depth() {
        let d = tempfile::tempdir().unwrap();
        for rate in [44100, 48000] {
            for depth in [16, 24] {
                let mut outputs = Vec::new();
                for container in [AudioContainer::Wav, AudioContainer::Aiff] {
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
                            let count = (1025 - n).min(block.len());
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
                    assert_eq!(frames, 1025);
                    outputs.push(std::fs::read(path).unwrap());
                }
                let mut reader = hound::WavReader::new(std::io::Cursor::new(&outputs[0])).unwrap();
                let wav: Vec<i32> = reader.samples::<i32>().map(Result::unwrap).collect();
                let (aiff_rate, frames, bits, aiff) = read_aiff(&outputs[1]);
                assert_eq!((aiff_rate, frames, bits), (rate as f64, 1025, depth));
                // The same dithered samples, in the other byte order.
                assert_eq!(aiff, wav, "{rate} Hz {depth} bit");
                assert_eq!(outputs[1].len(), 54 + 1025 * 2 * depth as usize / 8);
            }
        }
    }
    #[test]
    fn older_requests_read_as_wav_and_only_aiff_is_written() {
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
        for wrong in [r#""flac""#, r#""AIFF""#, "null", "1"] {
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
    fn a_cancelled_aiff_leaves_the_prior_file() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("existing.aiff");
        std::fs::write(&path, b"prior").unwrap();
        let cancel = AtomicBool::new(false);
        let format = AudioFormat {
            container: AudioContainer::Aiff,
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
