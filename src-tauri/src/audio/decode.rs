use std::{io::Cursor, sync::Arc};
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    formats::{FormatOptions, TrackType, probe::Hint},
    io::MediaSourceStream,
    meta::MetadataOptions,
};

#[derive(Clone, Debug)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    /// Original channel count. Mono frames are duplicated into stereo internally.
    pub channels: u16,
    pub frames: Arc<Vec<[f32; 2]>>,
}

/// Decode on a preparation worker, never from the device callback.
pub fn decode_audio(bytes: &[u8], hint: Option<&str>) -> Result<DecodedAudio, String> {
    if bytes.is_empty() {
        return Err("The audio file is empty".into());
    }
    // RIFF permits a reader to reach EOF in the middle of its advertised data.
    // Reject this instead of silently installing a shortened backing or sample.
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as u64 + 8;
        if declared > bytes.len() as u64 {
            return Err("The WAV file is truncated".into());
        }
    }
    let source = MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
    let mut probe_hint = Hint::new();
    if let Some(extension) = hint {
        probe_hint.with_extension(extension.trim_start_matches('.'));
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &probe_hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("Unsupported or damaged audio file: {e}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("The file has no audio track")?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("The audio codec parameters are missing")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| format!("Unsupported audio codec: {e}"))?;
    let track_id = track.id;
    let mut frames = Vec::new();
    let mut interleaved = Vec::<f32>::new();
    let mut sample_rate = 0;
    let mut channels = 0;
    while let Some(packet) = format
        .next_packet()
        .map_err(|e| format!("Damaged audio packet: {e}"))?
    {
        if packet.track_id != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|e| format!("Could not decode audio: {e}"))?;
        let rate = decoded.spec().rate();
        let count = decoded.spec().channels().count();
        if rate == 0 || !(1..=2).contains(&count) {
            return Err("Use a mono or stereo audio file with a valid sample rate".into());
        }
        if sample_rate != 0 && (sample_rate != rate || channels != count as u16) {
            return Err("Changing audio rate or channel layout is unsupported".into());
        }
        sample_rate = rate;
        channels = count as u16;
        interleaved.resize(decoded.samples_interleaved(), 0.0);
        decoded.copy_to_slice_interleaved(&mut interleaved);
        for frame in interleaved.chunks_exact(count) {
            let pair = [frame[0], frame[if count == 1 { 0 } else { 1 }]];
            if pair.iter().any(|v| !v.is_finite()) {
                return Err("The audio contains invalid PCM samples".into());
            }
            frames.push(pair);
        }
    }
    if frames.is_empty() {
        return Err("The audio file has no decodable frames".into());
    }
    Ok(DecodedAudio {
        sample_rate,
        channels,
        frames: Arc::new(frames),
    })
}
