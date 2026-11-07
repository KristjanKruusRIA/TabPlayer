//! Audio input capture shared by the tuner and Line-In monitoring: device listing and choice, the
//! stream builder over every sample format, the allocation-free mono downmix the stream callback
//! runs, failure codes the error callback leaves for the capture thread, and the bounded shutdown
//! of a capture thread. cpal streams are not `Send` on Windows, so each user of this module keeps
//! its stream on a thread of its own.
use cpal::{
    FromSample, Sample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use ringbuf::{HeapProd, traits::Producer};
use serde::Serialize;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::Duration,
};

/// How often a capture thread checks for a stop request or a stream failure.
pub const CAPTURE_POLL: Duration = Duration::from_millis(50);
/// How long shutting a capture down waits for its thread before leaving it to end by itself.
pub const STOP_TIMEOUT: Duration = Duration::from_millis(500);
/// Rates above this are refused; the ring and filter would be needlessly large.
pub const MAX_INPUT_RATE: u32 = 768_000;
/// Channels examined when choosing the loudest one.
pub const MAX_CHANNELS: usize = 64;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioInput {
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// Where the stream callback puts mono samples. Runs on the audio thread: implementations must
/// not allocate, lock, log or wait.
pub trait SampleSink {
    fn push_samples(&mut self, samples: &[f32]);
    /// Called once after each device block with its length in frames.
    fn end_block(&mut self, _frames: usize) {}
}

impl SampleSink for HeapProd<f32> {
    fn push_samples(&mut self, samples: &[f32]) {
        // What does not fit is dropped.
        Producer::push_slice(self, samples);
    }
}

/// Failure codes the stream's error callback leaves for the capture thread. Atomic only: the
/// callback must not allocate or lock.
#[derive(Default)]
pub struct StreamFault(AtomicU8);

impl StreamFault {
    const UNAVAILABLE: u8 = 1;
    const DENIED: u8 = 2;
    const OTHER: u8 = 3;

    pub fn note(&self, kind: cpal::ErrorKind) {
        let code = match kind {
            // Rerouting, glitches and a busy moment do not stop the capture.
            cpal::ErrorKind::DeviceChanged
            | cpal::ErrorKind::Xrun
            | cpal::ErrorKind::RealtimeDenied
            | cpal::ErrorKind::DeviceBusy => return,
            cpal::ErrorKind::DeviceNotAvailable
            | cpal::ErrorKind::HostUnavailable
            | cpal::ErrorKind::StreamInvalidated => Self::UNAVAILABLE,
            cpal::ErrorKind::PermissionDenied => Self::DENIED,
            _ => Self::OTHER,
        };
        let _ = self
            .0
            .compare_exchange(0, code, Ordering::AcqRel, Ordering::Acquire);
    }

    pub fn message(&self) -> Option<&'static str> {
        match self.0.load(Ordering::Acquire) {
            0 => None,
            Self::UNAVAILABLE => Some("The audio input was disconnected or became unavailable."),
            Self::DENIED => Some("Access to the audio input was denied."),
            _ => Some("The audio input stopped unexpectedly."),
        }
    }
}

pub fn open_error(error: &cpal::Error) -> String {
    match error.kind() {
        cpal::ErrorKind::PermissionDenied => {
            "Access to the microphone was denied. Allow TabPlayer to use it in the system settings."
                .into()
        }
        cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::HostUnavailable => {
            "The selected audio input is unavailable.".into()
        }
        cpal::ErrorKind::DeviceBusy => "The audio input is in use by another application.".into(),
        cpal::ErrorKind::UnsupportedConfig => {
            "The audio input does not support a usable format.".into()
        }
        _ => format!("Could not open the audio input: {error}"),
    }
}

/// A device's display name. `Display` can panic inside a backend, so a panic reads as no name.
pub fn device_label(device: &cpal::Device) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| device.to_string())).ok()
}

/// The system's audio inputs, the default one marked. The single source of truth for every
/// feature that captures.
pub fn list_devices() -> Result<Vec<AudioInput>, String> {
    let host = cpal::default_host();
    let default_id = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let mut inputs = Vec::new();
    for device in host
        .input_devices()
        .map_err(|e| format!("Could not list audio inputs: {e}"))?
    {
        let Ok(id) = device.id() else { continue };
        let id = id.to_string();
        inputs.push(AudioInput {
            default: default_id.as_deref() == Some(id.as_str()),
            name: device_label(&device).unwrap_or_else(|| "Audio input".into()),
            id,
        });
    }
    Ok(inputs)
}

fn usable_format(format: SampleFormat) -> bool {
    !matches!(
        format,
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32
    )
}

/// A config for a device whose default one cannot be used (DSD, or a rate outside 8 to 768 kHz):
/// the channel count is kept, and the rate is the nearest to 48 kHz at or below it, otherwise
/// the lowest the device offers.
fn fallback_config(device: &cpal::Device, channels: u16) -> Option<cpal::SupportedStreamConfig> {
    let ranges = device.supported_input_configs().ok()?;
    ranges
        .filter(|range| usable_format(range.sample_format()) && range.channels() == channels)
        .filter_map(|range| {
            let rate = if range.min_sample_rate() <= 48_000 {
                range.max_sample_rate().min(48_000)
            } else {
                range.min_sample_rate()
            }
            .max(8_000);
            let config = range.try_with_sample_rate(rate)?;
            let key = if rate <= 48_000 {
                (0u8, u32::MAX - rate)
            } else {
                (1u8, rate)
            };
            Some((key, config))
        })
        .min_by_key(|(key, _)| *key)
        .map(|(_, config)| config)
}

fn rate_in_range(config: &cpal::SupportedStreamConfig) -> bool {
    (8_000..=MAX_INPUT_RATE).contains(&config.sample_rate())
}

pub fn choose_input(
    id: Option<&str>,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let host = cpal::default_host();
    let device = if let Some(id) = id {
        host.input_devices()
            .map_err(|e| open_error(&e))?
            .find(|d| d.id().is_ok_and(|x| x.to_string() == id))
            .ok_or("The selected audio input is unavailable.")?
    } else {
        host.default_input_device()
            .ok_or("No audio input device is available.")?
    };
    // The device's own rate, channels and format are kept whenever they can be used: on some
    // systems opening a stream at another rate changes the device's rate for every application.
    let default = device.default_input_config().map_err(|e| open_error(&e))?;
    let config = if rate_in_range(&default) && usable_format(default.sample_format()) {
        default
    } else {
        fallback_config(&device, default.channels()).unwrap_or(default)
    };
    if config.channels() == 0 || !rate_in_range(&config) {
        return Err("The audio input runs at a sample rate that cannot be used.".into());
    }
    if !usable_format(config.sample_format()) {
        return Err("The audio input only offers a DSD format, which cannot be read.".into());
    }
    Ok((device, config))
}

fn sample_f32<T>(sample: T) -> f32
where
    T: Sample,
    f32: FromSample<T>,
{
    let value = sample.to_sample::<f32>();
    if value.is_finite() { value } else { 0.0 }
}

/// Pushes the loudest channel of a block as mono. One guitar on an 8-channel interface would be
/// 18 dB down in an average, so the channel with the most energy in the block is used, and it
/// changes only when another channel is 6 dB louder. Runs on the audio thread: no allocation,
/// lock, log or wait; samples that do not fit are dropped.
pub fn capture_block<T, S>(data: &[T], channels: usize, sink: &mut S, chosen: &mut usize)
where
    T: Sample,
    f32: FromSample<T>,
    S: SampleSink + ?Sized,
{
    if channels == 0 {
        return;
    }
    let tracked = channels.min(MAX_CHANNELS);
    let mut energy = [0.0f32; MAX_CHANNELS];
    for frame in data.chunks_exact(channels) {
        for (slot, &sample) in energy.iter_mut().zip(&frame[..tracked]) {
            let value = sample_f32(sample);
            *slot += value * value;
        }
    }
    if *chosen >= tracked {
        *chosen = 0;
    }
    let mut loudest = 0;
    for channel in 1..tracked {
        if energy[channel] > energy[loudest] {
            loudest = channel;
        }
    }
    if energy[loudest] > energy[*chosen] * 4.0 {
        *chosen = loudest;
    }
    let channel = *chosen;
    let mut chunk = [0.0f32; 256];
    let mut filled = 0;
    for frame in data.chunks_exact(channels) {
        chunk[filled] = sample_f32(frame[channel]);
        filled += 1;
        if filled == chunk.len() {
            sink.push_samples(&chunk);
            filled = 0;
        }
    }
    if filled > 0 {
        sink.push_samples(&chunk[..filled]);
    }
    sink.end_block(data.len() / channels);
}

fn build_input<T, S>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    mut sink: S,
    fault: Arc<StreamFault>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
    S: SampleSink + Send + 'static,
{
    let channels = config.channels() as usize;
    let mut chosen = 0usize;
    device.build_input_stream(
        config.clone().into(),
        move |data: &[T], _| capture_block(data, channels, &mut sink, &mut chosen),
        move |error| fault.note(error.kind()),
        None,
    )
}

/// Builds and starts an input stream over any sample format, feeding `sink` mono samples.
pub fn build_stream<S>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    sink: S,
    fault: Arc<StreamFault>,
) -> Result<cpal::Stream, String>
where
    S: SampleSink + Send + 'static,
{
    let stream = match config.sample_format() {
        SampleFormat::F32 => build_input::<f32, S>(device, config, sink, fault),
        SampleFormat::F64 => build_input::<f64, S>(device, config, sink, fault),
        SampleFormat::I8 => build_input::<i8, S>(device, config, sink, fault),
        SampleFormat::I16 => build_input::<i16, S>(device, config, sink, fault),
        SampleFormat::I24 => build_input::<cpal::I24, S>(device, config, sink, fault),
        SampleFormat::I32 => build_input::<i32, S>(device, config, sink, fault),
        SampleFormat::I64 => build_input::<i64, S>(device, config, sink, fault),
        SampleFormat::U8 => build_input::<u8, S>(device, config, sink, fault),
        SampleFormat::U16 => build_input::<u16, S>(device, config, sink, fault),
        SampleFormat::U24 => build_input::<cpal::U24, S>(device, config, sink, fault),
        SampleFormat::U32 => build_input::<u32, S>(device, config, sink, fault),
        SampleFormat::U64 => build_input::<u64, S>(device, config, sink, fault),
        _ => return Err("This audio input uses a sample format that cannot be read.".into()),
    }
    .map_err(|e| open_error(&e))?;
    stream.play().map_err(|e| open_error(&e))?;
    Ok(stream)
}

/// A running capture thread. Shutting it down asks the thread to stop and waits a bounded time;
/// a thread stuck in a driver is left behind (its generation is no longer current, so it can
/// change nothing) instead of blocking the caller forever.
pub struct CaptureHandle {
    pub stop: Option<mpsc::Sender<()>>,
    pub finished: mpsc::Receiver<()>,
    pub thread: Option<JoinHandle<()>>,
}

impl CaptureHandle {
    pub fn shutdown(mut self, budget: Duration) {
        self.finish(budget);
    }

    fn finish(&mut self, budget: Duration) {
        drop(self.stop.take());
        let ended = matches!(
            self.finished.recv_timeout(budget),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
        if let Some(thread) = self.thread.take() {
            if ended {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.finish(STOP_TIMEOUT);
    }
}
