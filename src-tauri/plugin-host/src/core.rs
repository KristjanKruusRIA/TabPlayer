//! The hosting core's interface: what the helper's session and audio loop need from "one plug-in", with no VST3 in sight.
//!
//! The real core is `vst3_core::Vst3Core`. The session and the audio loop are written against these traits, so their
//! logic (and the rules for sanitizing what the app sends) is tested on every platform with fakes.
use crate::audio::PauseGate;
use std::path::Path;
use tabplayer_plugin_protocol::{
    control::{ClassInfo, ErrorCode, HelperMessage, Mode, Rect},
    ring::{BLOCK_FLAG_PLAYING, BlockMeta},
};

/// A request the core could not carry out: the protocol error code and a short English detail.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreError {
    pub code: ErrorCode,
    pub detail: String,
}

impl CoreError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> CoreError {
        CoreError {
            code,
            detail: detail.into(),
        }
    }

    /// The `Error` message for this failure, its detail cut to the protocol's cap.
    pub fn message(&self) -> HelperMessage {
        HelperMessage::error(self.code, &self.detail)
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.detail)
    }
}
impl std::error::Error for CoreError {}

/// Something the core noticed on its own, between requests.
#[derive(Debug, Clone, PartialEq)]
pub enum CoreEvent {
    /// The latency in frames, now. The app re-prepares.
    LatencyChanged(u32),
    /// The core cannot go on (it could not reconfigure the plug-in): the helper reports the error and exits.
    Fatal(CoreError),
    /// The editor changed the plug-in's state.
    StateDirty,
    /// The user closed the editor window.
    EditorClosed,
}

/// The processor side of a loaded plug-in, owned by the audio thread.
pub trait BlockProcessor {
    /// Clears the plug-in's tails and delay lines: `setProcessing(false)`, and `true` again with the next block.
    fn reset(&mut self);
    /// Processes one block of `input.len()` frames (at most `BLOCK_FRAMES`) into `output`, with the transport state the
    /// block carries. The output is silence when the plug-in fails. Nothing here may allocate or take a lock.
    fn process(&mut self, input: &[[f32; 2]], output: &mut [[f32; 2]], ctx: &BlockMeta);
}

/// One plug-in, loaded. The helper holds exactly one.
pub trait PluginCore: Sized {
    /// The audio-effect classes of a bundle, at most 64, with names the protocol accepts.
    fn probe(bundle: &Path) -> Result<Vec<ClassInfo>, CoreError>;
    /// Loads one class at `rate`. The plug-in is not processing yet.
    fn load(bundle: &Path, class_id: &str, rate: u32, mode: Mode) -> Result<Self, CoreError>;
    /// The process ID of the app, so closing an editor can hand it the foreground.
    fn set_app_pid(&mut self, _pid: u32) {}
    fn class(&self) -> &ClassInfo;
    /// Whether the plug-in is mono-only, so the processor downmixes its input and duplicates its output.
    fn mono(&self) -> bool;
    /// The plug-in's latency in frames.
    fn latency(&self) -> u32;
    /// Gives the plug-in a state: the component part and the controller part.
    fn set_state(&mut self, component: &[u8], controller: &[u8]) -> Result<(), CoreError>;
    /// The plug-in's state as (component, controller). `StateTooLarge` when a part passes the cap.
    fn state(&mut self) -> Result<(Vec<u8>, Vec<u8>), CoreError>;
    /// Sets one normalized parameter. The id must be one of the plug-in's own; the value is already clamped.
    fn set_parameter(&mut self, id: u32, value: f64) -> Result<(), CoreError>;
    /// Carries out the restarts the plug-in asked for while it was loading and taking its state, before the audio thread
    /// exists, so that `latency` is what the plug-in settles on. Call it once, after the load state is set.
    fn settle_after_load(&mut self) -> Result<(), CoreError> {
        Ok(())
    }
    /// The processor side. Call it once, after the state is set.
    fn processor(&mut self) -> Result<Box<dyn BlockProcessor + Send>, CoreError>;
    /// Opens the editor window and returns its handle. `near` is a screen rectangle to centre it in.
    fn open_editor(&mut self, title: &str, near: Option<Rect>) -> Result<u64, CoreError>;
    fn close_editor(&mut self);
    /// What the core noticed since the last call. `gate` pauses the audio thread when a restart needs the plug-in
    /// reconfigured.
    fn poll(&mut self, gate: &PauseGate) -> Vec<CoreEvent>;
}

// ---- the transport a block carries -----------------------------------------------------------------------------

/// The transport state a plug-in sees for one block, after sanitizing (see [`sanitize`]).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Transport {
    pub playing: bool,
    pub recording: bool,
    pub tempo: f64,
    pub numerator: u32,
    pub denominator: u32,
    pub samples: i64,
    pub quarters: f64,
    pub bar_start: f64,
}

pub const MIN_TEMPO: f64 = 20.0;
pub const MAX_TEMPO: f64 = 999.0;
/// Positions beyond this are not credible (about 2^53 samples is 5,900 years at 48 kHz) and would lose precision as
/// doubles.
const MAX_POSITION: i64 = 1 << 52;
const MAX_QUARTERS: f64 = 1.0e12;

/// What the app wrote into a block header is untrusted: a plug-in must not see a NaN or zero tempo, a 0/0 signature or an
/// absurd position (they divide by them). Out-of-range values become the host defaults: 120 bpm, 4/4, position 0.
pub fn sanitize(meta: &BlockMeta) -> Transport {
    let tempo = if meta.tempo.is_finite() {
        meta.tempo.clamp(MIN_TEMPO, MAX_TEMPO)
    } else {
        120.0
    };
    let (numerator, denominator) =
        if (1..=64).contains(&meta.sig_num) && matches!(meta.sig_den, 1 | 2 | 4 | 8 | 16 | 32) {
            (u32::from(meta.sig_num), u32::from(meta.sig_den))
        } else {
            (4, 4)
        };
    let samples = meta.project_frame.clamp(-MAX_POSITION, MAX_POSITION);
    let quarters = if meta.project_quarters.is_finite() {
        meta.project_quarters.clamp(-MAX_QUARTERS, MAX_QUARTERS)
    } else {
        0.0
    };
    let bar = f64::from(numerator) * 4.0 / f64::from(denominator);
    Transport {
        playing: meta.flags & BLOCK_FLAG_PLAYING != 0,
        recording: false,
        tempo,
        numerator,
        denominator,
        samples,
        quarters,
        bar_start: (quarters / bar).floor() * bar,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> BlockMeta {
        BlockMeta {
            flags: BLOCK_FLAG_PLAYING,
            tempo: 96.0,
            sig_num: 6,
            sig_den: 8,
            project_frame: 48_000,
            project_quarters: 7.0,
        }
    }

    #[test]
    fn a_sane_header_passes_through() {
        let t = sanitize(&meta());
        assert!(t.playing && !t.recording);
        assert_eq!((t.tempo, t.numerator, t.denominator), (96.0, 6, 8));
        assert_eq!(t.samples, 48_000);
        assert_eq!(t.quarters, 7.0);
        // 6/8 is three quarters a bar: bar 2 starts at 6.
        assert_eq!(t.bar_start, 6.0);
    }

    #[test]
    fn hostile_headers_become_defaults() {
        let mut bad = meta();
        bad.flags = 0xFFFF_FFFE;
        bad.tempo = f64::NAN;
        bad.sig_num = 0;
        bad.sig_den = 0;
        bad.project_frame = i64::MIN;
        bad.project_quarters = f64::INFINITY;
        let t = sanitize(&bad);
        assert!(!t.playing, "only bit 0 means playing");
        assert_eq!((t.tempo, t.numerator, t.denominator), (120.0, 4, 4));
        assert_eq!(t.samples, -(1 << 52));
        assert_eq!((t.quarters, t.bar_start), (0.0, 0.0));
        for tempo in [0.0, -5.0, 1.0e9, f64::NEG_INFINITY] {
            let mut m = meta();
            m.tempo = tempo;
            let t = sanitize(&m).tempo;
            assert!((MIN_TEMPO..=MAX_TEMPO).contains(&t), "{tempo} became {t}");
        }
        for (num, den) in [
            (0, 4),
            (4, 0),
            (4, 3),
            (65, 4),
            (4, 64),
            (u16::MAX, u16::MAX),
        ] {
            let mut m = meta();
            m.sig_num = num;
            m.sig_den = den;
            let t = sanitize(&m);
            assert_eq!((t.numerator, t.denominator), (4, 4), "{num}/{den}");
        }
        let mut m = meta();
        m.project_quarters = f64::NAN;
        assert_eq!(sanitize(&m).quarters, 0.0);
        m.project_quarters = 1.0e300;
        assert_eq!(sanitize(&m).quarters, MAX_QUARTERS);
        assert!(sanitize(&m).bar_start.is_finite());
    }

    #[test]
    fn core_errors_cut_their_detail() {
        let error = CoreError::new(ErrorCode::Internal, "\u{e9}".repeat(1000));
        let HelperMessage::Error { code, detail } = error.message() else {
            panic!("an error message");
        };
        assert_eq!(code, ErrorCode::Internal);
        assert_eq!(detail.chars().count(), 256);
    }
}
