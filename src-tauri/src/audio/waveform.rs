use super::decode::DecodedAudio;
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

pub fn reduce_waveform(_audio: &DecodedAudio, _buckets: usize) -> Result<WaveformPeaks, String> {
    Err("Waveform reduction is not implemented.".into())
}
