use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{
    io::{Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
pub const BLOCK_FRAMES: usize = 512;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub bit_depth: u16,
}
impl AudioFormat {
    pub fn validate(self) -> Result<(), String> {
        if ![44100, 48000].contains(&self.sample_rate) || ![16, 24].contains(&self.bit_depth) {
            Err("Choose stereo 44.1/48 kHz, 16/24-bit PCM WAV.".into())
        } else {
            Ok(())
        }
    }
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
        file.write_all(&[0; 44]).map_err(|e| e.to_string())?;
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
        if new_frames * 2 * bytes_per_sample as u64 > u32::MAX as u64 - 36 {
            return Err("WAV exceeds the standard RIFF size limit. Export a shorter range.".into());
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
            bytes.extend_from_slice(&value.to_le_bytes()[..bytes_per_sample]);
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
        if actual != 44 + size as u64 {
            return Err("WAV frame verification failed.".into());
        }
        let mut header = Vec::with_capacity(44);
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
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;
        self.file.write_all(&header).map_err(|e| e.to_string())?;
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
                    AudioFormat {
                        sample_rate: rate,
                        bit_depth: depth,
                    },
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
            AudioFormat {
                sample_rate: 48000,
                bit_depth: 16,
            },
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
                AudioFormat {
                    sample_rate: 48000,
                    bit_depth: 16
                },
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
                AudioFormat {
                    sample_rate: 44100,
                    bit_depth: 16,
                },
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
}
