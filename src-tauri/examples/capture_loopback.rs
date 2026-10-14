//! Bounded Windows output-loopback evidence helper. No microphone is selected.
use cpal::{
    FromSample, Sample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use ringbuf::{HeapCons, HeapRb, traits::*};
use std::{
    io::{self, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

struct CaptureFaults {
    overflow: AtomicBool,
    fatal: AtomicBool,
    notifications: AtomicU64,
}
fn stream<T: Sample + SizedSample>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
) -> Result<(cpal::Stream, HeapCons<[f32; 2]>, Arc<CaptureFaults>), String>
where
    f32: FromSample<T>,
{
    let channels = config.channels() as usize;
    let (mut producer, consumer) = HeapRb::new(config.sample_rate() as usize * 4).split();
    let failed = Arc::new(CaptureFaults {
        overflow: AtomicBool::new(false),
        fatal: AtomicBool::new(false),
        notifications: AtomicU64::new(0),
    });
    let callback_failed = failed.clone();
    let error_failed = failed.clone();
    let stream = device
        .build_input_stream(
            config.clone().into(),
            move |samples: &[T], _| {
                for frame in samples.chunks_exact(channels) {
                    let left = f32::from_sample(frame[0]);
                    let right = if channels > 1 {
                        f32::from_sample(frame[1])
                    } else {
                        left
                    };
                    if producer.try_push([left, right]).is_err() {
                        callback_failed.overflow.store(true, Ordering::Relaxed);
                    }
                }
            },
            move |error| {
                if matches!(
                    error.kind(),
                    cpal::ErrorKind::Xrun
                        | cpal::ErrorKind::DeviceChanged
                        | cpal::ErrorKind::RealtimeDenied
                ) {
                    error_failed.notifications.fetch_add(1, Ordering::Relaxed);
                } else {
                    error_failed.fatal.store(true, Ordering::Relaxed);
                }
            },
            None,
        )
        .map_err(|e| e.to_string())?;
    Ok((stream, consumer, failed))
}
fn dominant_frequency(signal: &[[f32; 2]], rate: u32) -> Option<f64> {
    let low = rate as usize / 1200;
    let high = rate as usize / 80;
    if signal.len() <= high {
        return None;
    }
    let count = signal.len() - high;
    let correlations: Vec<_> = (low..=high)
        .map(|lag| {
            let (cross, left, right) = signal[..count].iter().zip(&signal[lag..lag + count]).fold(
                (0.0, 0.0, 0.0),
                |(cross, left, right), (a, b)| {
                    let a = a[0] as f64;
                    let b = b[0] as f64;
                    (cross + a * b, left + a * a, right + b * b)
                },
            );
            cross / (left * right).sqrt().max(1e-20)
        })
        .collect();
    let maximum = correlations
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    if maximum < 0.5 {
        return None;
    }
    let index = correlations
        .windows(3)
        .position(|p| p[1] >= maximum * 0.995 && p[1] > p[0] && p[1] >= p[2])?
        + 1;
    Some(rate as f64 / (low + index) as f64)
}
fn main() -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("This helper records Windows WASAPI output loopback.".into());
    }
    let output = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("Pass an ignored output WAV path.")?,
    );
    let host = cpal::default_host();
    let wanted = std::env::args().nth(2);
    let device = if let Some(id) = wanted {
        host.output_devices()
            .map_err(|e| e.to_string())?
            .find(|device| device.id().is_ok_and(|found| found.to_string() == id))
            .ok_or("The app's output device is unavailable.")?
    } else {
        host.default_output_device()
            .ok_or("No output device is available.")?
    };
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    let sample_rate = config.sample_rate();
    let (stream, mut consumer, failed) = match config.sample_format() {
        SampleFormat::F32 => stream::<f32>(&device, &config),
        SampleFormat::F64 => stream::<f64>(&device, &config),
        SampleFormat::I16 => stream::<i16>(&device, &config),
        SampleFormat::I32 => stream::<i32>(&device, &config),
        _ => return Err("Loopback sample format is unsupported by the evidence helper.".into()),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    println!("{{\"ready\":true,\"sampleRate\":{sample_rate},\"durationSeconds\":3}}");
    io::stdout().flush().map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_secs(3));
    drop(stream);
    let mut frames = Vec::with_capacity(sample_rate as usize * 3);
    while let Some(frame) = consumer.try_pop() {
        frames.push(frame);
    }
    if failed.overflow.load(Ordering::Relaxed) || failed.fatal.load(Ordering::Relaxed) {
        return Err(format!(
            "Loopback failed: overflow={}, deviceFailed={}, receivedFrames={}.",
            failed.overflow.load(Ordering::Relaxed),
            failed.fatal.load(Ordering::Relaxed),
            frames.len()
        ));
    }
    if frames.is_empty() {
        return Err("The output device produced no loopback PCM.".into());
    }
    let peak = frames
        .iter()
        .flat_map(|f| f.iter())
        .fold(0.0f32, |p, s| p.max(s.abs()));
    let finite = frames
        .iter()
        .flat_map(|f| f.iter())
        .all(|s| s.is_finite() && s.abs() <= 1.0);
    if !finite {
        return Err("Captured PCM is nonfinite or outside its normalized bounds.".into());
    }
    let rms = (frames
        .iter()
        .flat_map(|f| f.iter())
        .map(|s| (*s as f64).powi(2))
        .sum::<f64>()
        / (frames.len() * 2) as f64)
        .sqrt();
    let onset = frames
        .iter()
        .position(|f| f[0].abs().max(f[1].abs()) > 0.001);
    let active = onset.map(|first| {
        let start = (first + sample_rate as usize / 50).min(frames.len());
        &frames[start..frames.len().min(start + sample_rate as usize / 3)]
    });
    let frequency = active.and_then(|signal| dominant_frequency(signal, sample_rate));
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(&output, spec).map_err(|e| e.to_string())?;
    for frame in &frames {
        for &sample in frame {
            writer.write_sample(sample).map_err(|e| e.to_string())?;
        }
    }
    writer.finalize().map_err(|e| e.to_string())?;
    let metrics = serde_json::json!({"device":device.to_string(),"deviceId":device.id().map_err(|e|e.to_string())?.to_string(),"sampleRate":sample_rate,"frames":frames.len(),"durationSeconds":frames.len() as f64/sample_rate as f64,"peak":peak,"rms":rms,"onsetFrame":onset,"frequencyHz":frequency,"finite":finite,"backendNotifications":failed.notifications.load(Ordering::Relaxed),"source":"WASAPI output loopback; microphone not selected"});
    std::fs::write(
        output.with_extension("json"),
        serde_json::to_vec_pretty(&metrics).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    println!("{metrics}");
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn independently_detects_a4_and_a5_without_octave_alias() {
        for rate in [44_100, 48_000] {
            for hz in [440.0, 880.0] {
                let tone: Vec<_> = (0..rate / 3)
                    .map(|n| {
                        let sample = (std::f64::consts::TAU * hz * n as f64 / rate as f64).sin()
                            as f32
                            * 0.2;
                        [sample, sample]
                    })
                    .collect();
                let detected = super::dominant_frequency(&tone, rate).unwrap();
                assert!(
                    (detected / hz - 1.0).abs() < 0.01,
                    "{rate} Hz: {hz} detected as {detected}"
                );
            }
        }
    }
}
