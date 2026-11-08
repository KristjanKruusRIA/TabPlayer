//! Every number the protocol fixes, in one place. Caps are enforced before allocating or decoding.
use std::time::Duration;

/// Version of the control messages and of the ring layout. Both sides refuse anything else.
pub const PROTOCOL_VERSION: u32 = 1;

/// Frames in one ring block. Measured in Spike 2 (`docs/validation/2026-11-08-vst-spikes.md`): the p99 hand-off at
/// this size is 2.31 ms with a real amp plug-in in eight helpers, against a 10.67 ms callback.
pub const BLOCK_FRAMES: usize = 128;

/// The largest pipeline `P`, in frames: how far the output trails the input.
pub const MAX_PIPELINE_FRAMES: usize = 8192;

/// Blocks in each direction of the ring: enough for a full pipeline plus two free (preflight ruling P9). It is derived
/// from the other two constants, never written as a number, so changing the block size cannot leave no block free at
/// the cap.
pub const RING_BLOCKS: usize = MAX_PIPELINE_FRAMES.div_ceil(BLOCK_FRAMES) + 2;

/// The longest plug-in latency `L` the app accepts, in seconds.
pub const MAX_LATENCY_SECONDS: f64 = 0.1;

/// The sample rates the ring accepts.
pub const MIN_SAMPLE_RATE: u32 = 8_000;
pub const MAX_SAMPLE_RATE: u32 = 384_000;

/// One control frame, from its length prefix.
pub const MAX_FRAME_BYTES: usize = 12 << 20;
/// Classes one bundle may report.
pub const MAX_CLASSES: usize = 64;
/// Plug-in name and vendor, in characters.
pub const MAX_NAME_CHARS: usize = 64;
/// Class version and sub-categories, in characters (preflight ruling P29).
pub const MAX_VERSION_CHARS: usize = 32;
pub const MAX_SUBCATEGORIES_CHARS: usize = 128;
/// `Error::detail`, in characters.
pub const MAX_DETAIL_CHARS: usize = 256;
/// An editor window title, in characters.
pub const MAX_TITLE_CHARS: usize = 256;
/// A bundle path, in characters (the long-path limit on Windows).
pub const MAX_PATH_CHARS: usize = 32_767;

/// One plug-in state: the whole container, 20 bytes of framing and both parts (see [`crate::state`]).
pub const MAX_STATE_BYTES: usize = 8 << 20;

/// Probing a bundle.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// Loading a plug-in and opening its editor. Slow amp plug-ins take about 6 s (Spike 1), so these keep the 30 s the
/// controller ruled for P16 rather than the 5 s of other requests.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
pub const EDITOR_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// Every other request.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// A helper whose heartbeat has not moved for this long has hung.
pub const HANG_TIMEOUT: Duration = Duration::from_millis(500);
/// How often the supervisor looks at heartbeats and exits.
pub const SUPERVISOR_TICK: Duration = Duration::from_millis(50);
/// One block in an offline export.
pub const OFFLINE_BLOCK_TIMEOUT: Duration = Duration::from_secs(10);

/// The pipeline depth `P` for a device callback of `callback_frames`: `C + max(C, BLOCK_FRAMES)`, rounded up to a whole
/// block (preflight ruling P9). A block can only be sent once 128 input frames have arrived, so for callbacks under 128
/// frames plain `2C` would leave no slack. For `C >= 128` this equals `2C` rounded up to a block, which is the spec's
/// two callbacks (an interpretation, recorded in the spike results). Size it from the device-level maximum callback
/// frames, not the steady period: the first shared-mode callback can ask for 1,056 frames against a 480-frame period.
///
/// The result may exceed [`MAX_PIPELINE_FRAMES`]; the caller refuses such a pipeline.
pub const fn pipeline_frames(callback_frames: usize) -> usize {
    let c = callback_frames;
    let widest = if c > BLOCK_FRAMES { c } else { BLOCK_FRAMES };
    (c + widest).div_ceil(BLOCK_FRAMES) * BLOCK_FRAMES
}

/// The longest latency in frames at `sample_rate`: `ceil(0.1 × rate)`. A [`Loaded`](crate::control::HelperMessage)
/// latency above this makes the plug-in `tooMuchLatency`.
pub fn max_latency_frames(sample_rate: u32) -> u32 {
    // Integer arithmetic: MAX_LATENCY_SECONDS is a tenth, and 0.1 × 44,100 is 4,410.000000000001 in floating point.
    sample_rate.div_ceil(10)
}

const _: () = assert!(MAX_PIPELINE_FRAMES % BLOCK_FRAMES == 0);
const _: () = assert!(RING_BLOCKS * BLOCK_FRAMES > MAX_PIPELINE_FRAMES);
const _: () = assert!(BLOCK_FRAMES * 8 % 64 == 0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_leaves_free_blocks_at_the_cap() {
        assert_eq!(RING_BLOCKS, 66);
        assert!((RING_BLOCKS - MAX_PIPELINE_FRAMES / BLOCK_FRAMES) >= 2);
    }

    #[test]
    fn small_callback_pipeline_has_slack() {
        // A callback below one block still waits for a whole block of input, so the pipeline must exceed it.
        for callback in 1..BLOCK_FRAMES {
            let p = pipeline_frames(callback);
            assert_eq!(p % BLOCK_FRAMES, 0, "C = {callback}");
            assert!(p >= callback + BLOCK_FRAMES, "C = {callback}: P = {p}");
        }
        assert_eq!(pipeline_frames(64), 256);
        assert_eq!(pipeline_frames(1), 256);
    }

    #[test]
    fn large_callback_pipeline_is_two_callbacks() {
        assert_eq!(pipeline_frames(128), 256);
        assert_eq!(pipeline_frames(256), 512);
        assert_eq!(pipeline_frames(480), 1024);
        assert_eq!(pipeline_frames(512), 1024);
        // The first shared-mode callback seen in Spike 2.
        assert_eq!(pipeline_frames(1056), 2176);
        for callback in (BLOCK_FRAMES..=4096).step_by(7) {
            let p = pipeline_frames(callback);
            assert!(
                p >= 2 * callback && p < 2 * callback + BLOCK_FRAMES,
                "C = {callback}: P = {p}"
            );
        }
    }

    #[test]
    fn pipeline_cap_is_reachable_and_a_larger_pipeline_is_visible() {
        assert_eq!(pipeline_frames(4096), MAX_PIPELINE_FRAMES);
        assert!(pipeline_frames(4097) > MAX_PIPELINE_FRAMES);
    }

    #[test]
    fn latency_cap_is_a_tenth_of_a_second() {
        assert_eq!(max_latency_frames(48_000), 4_800);
        assert_eq!(max_latency_frames(44_100), 4_410);
    }
}
