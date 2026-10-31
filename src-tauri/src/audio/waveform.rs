use super::decode::DecodedAudio;
use crate::backing_waveform::MAX_WAVEFORM_BUCKETS;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WaveformPeak {
    pub min: [f32; 2],
    pub max: [f32; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeaks {
    pub duration_ms: f64,
    pub sample_rate: u32,
    pub frame_count: u64,
    pub channels: u16,
    pub bucket_count: usize,
    pub peaks: Vec<WaveformPeak>,
}

pub fn reduce_waveform(audio: &DecodedAudio, buckets: usize) -> Result<WaveformPeaks, String> {
    if buckets == 0 || buckets > MAX_WAVEFORM_BUCKETS {
        return Err("Waveform bucket count must be between 1 and 8192.".into());
    }
    if audio.sample_rate == 0 || !(1..=2).contains(&audio.channels) || audio.frames.is_empty() {
        return Err("Invalid decoded waveform audio.".into());
    }
    let frame_count = u64::try_from(audio.frames.len())
        .map_err(|_| "Waveform frame count exceeds the safe serialized range.".to_string())?;
    if frame_count > 9_007_199_254_740_991 {
        return Err("Waveform frame count exceeds the safe serialized range.".into());
    }
    let bucket_count = buckets.min(audio.frames.len());
    let mut peaks = Vec::with_capacity(bucket_count);
    for bucket in 0..bucket_count {
        let start = (bucket as u128 * frame_count as u128 / bucket_count as u128) as usize;
        let end = ((bucket + 1) as u128 * frame_count as u128 / bucket_count as u128) as usize;
        let mut peak = WaveformPeak {
            min: audio.frames[start],
            max: audio.frames[start],
        };
        for frame in &audio.frames[start..end] {
            if frame.iter().any(|sample| !sample.is_finite()) {
                return Err("The audio contains invalid PCM samples.".into());
            }
            for channel in 0..2 {
                peak.min[channel] = peak.min[channel].min(frame[channel]);
                peak.max[channel] = peak.max[channel].max(frame[channel]);
            }
        }
        peaks.push(peak);
    }
    Ok(WaveformPeaks {
        duration_ms: 1000.0 * frame_count as f64 / audio.sample_rate as f64,
        sample_rate: audio.sample_rate,
        frame_count,
        channels: audio.channels,
        bucket_count,
        peaks,
    })
}
