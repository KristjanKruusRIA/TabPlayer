//! MP3 encoding through LAME 3.100, which `mp3lame-sys` builds from its bundled source and links statically.
//!
//! LAME is under the GNU Library GPL, version 2 or later. TabPlayer's own source is released under the MIT License,
//! so anyone can rebuild the app against a modified LAME, as that licence asks of statically linked programs.
use mp3lame_sys as lame;
use std::ffi::c_int;
use std::ptr::NonNull;
use std::sync::Mutex;

/// `lame_init_params` rewrites LAME's shared lookup tables, so encoders are set up one at a time.
static SETUP: Mutex<()> = Mutex::new(());

/// The constant bit rate, in kbit/s: transparent for most music, and a length every player reports correctly.
pub const MP3_KBPS: c_int = 256;
/// LAME's algorithm quality, from 0 (slowest) to 9: 2 is LAME's recommended high quality.
const MP3_QUALITY: c_int = 2;
/// LAME's documented worst case for the bytes one call can write: 1.25 bytes per sample frame plus 7200.
fn worst_case_bytes(frames: usize) -> usize {
    frames + frames.div_ceil(4) + 7200
}

/// One stereo LAME encoder. It is not shared between threads.
pub struct Mp3Encoder {
    lame: NonNull<lame::lame_global_flags>,
    /// Interleaved left and right samples of the current block.
    interleaved: Vec<f32>,
}

impl Mp3Encoder {
    /// A joint-stereo encoder at `sample_rate`, which must be one MPEG-1 accepts, with no ID3 tag. LAME reserves the
    /// first frame for its information tag, which `finish` returns for the caller to write there.
    pub fn new(sample_rate: u32) -> Result<Self, String> {
        let failed = || "MP3 encoder failed to start.".to_string();
        let _setup = SETUP
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // SAFETY: lame_init has no preconditions; a null result is handled.
        let lame = NonNull::new(unsafe { lame::lame_init() }).ok_or_else(failed)?;
        // Owning the handle first closes it on every error below.
        let encoder = Self {
            lame,
            interleaved: Vec::with_capacity(2 * super::wav::BLOCK_FRAMES),
        };
        let rate = c_int::try_from(sample_rate).map_err(|_| failed())?;
        let ptr = encoder.lame.as_ptr();
        // SAFETY: `ptr` is a live handle from lame_init, configured before lame_init_params as LAME requires.
        let configured = unsafe {
            lame::lame_set_in_samplerate(ptr, rate) == 0
                && lame::lame_set_out_samplerate(ptr, rate) == 0
                && lame::lame_set_num_channels(ptr, 2) == 0
                && lame::lame_set_mode(ptr, lame::MPEG_mode::JOINT_STEREO) == 0
                && lame::lame_set_VBR(ptr, lame::vbr_mode::vbr_off) == 0
                && lame::lame_set_brate(ptr, MP3_KBPS) == 0
                && lame::lame_set_quality(ptr, MP3_QUALITY) == 0
                && lame::lame_set_bWriteVbrTag(ptr, 1) == 0
                && {
                    lame::lame_set_write_id3tag_automatic(ptr, 0);
                    lame::lame_init_params(ptr) >= 0
                }
        };
        if configured {
            Ok(encoder)
        } else {
            Err(failed())
        }
    }

    /// Encodes one block of samples, clamped to [-1, 1], and appends the MP3 bytes LAME has ready to `out`. A
    /// non-finite sample is an error: LAME would index its tables with it.
    pub fn encode(&mut self, block: &[[f32; 2]], out: &mut Vec<u8>) -> Result<(), String> {
        if block.is_empty() {
            return Ok(());
        }
        self.interleaved.clear();
        for sample in block.iter().flatten() {
            if !sample.is_finite() {
                return Err("Audio renderer produced a non-finite sample.".into());
            }
            self.interleaved.push(sample.clamp(-1.0, 1.0));
        }
        let frames = c_int::try_from(block.len()).map_err(|_| "MP3 block is too long.")?;
        let room = worst_case_bytes(block.len());
        out.reserve(room);
        let start = out.len();
        // SAFETY: the handle is live and initialized; `interleaved` holds exactly 2 * `frames` floats; the output
        // pointer has at least `room` writable bytes, and LAME writes no more than the size it is given.
        let written = unsafe {
            lame::lame_encode_buffer_interleaved_ieee_float(
                self.lame.as_ptr(),
                self.interleaved.as_ptr(),
                frames,
                out.as_mut_ptr().add(start),
                c_int::try_from(room).map_err(|_| "MP3 block is too long.")?,
            )
        };
        let written =
            usize::try_from(written).map_err(|_| format!("MP3 encoder failed ({written})."))?;
        if written > room {
            return Err("MP3 encoder overran its buffer.".into());
        }
        // SAFETY: LAME initialized the first `written` bytes after `start`, within the reserved capacity.
        unsafe { out.set_len(start + written) };
        Ok(())
    }

    /// Flushes the last frames into `out` and returns the information tag, which belongs in the first frame LAME
    /// reserved at the start of the stream. It is empty if LAME wrote no tag.
    pub fn finish(mut self, out: &mut Vec<u8>) -> Result<Vec<u8>, String> {
        let room = 7200;
        out.reserve(room);
        let start = out.len();
        // SAFETY: as in `encode`, with `room` writable bytes.
        let written = unsafe {
            lame::lame_encode_flush(
                self.lame.as_ptr(),
                out.as_mut_ptr().add(start),
                room as c_int,
            )
        };
        let written =
            usize::try_from(written).map_err(|_| format!("MP3 encoder failed ({written})."))?;
        if written > room {
            return Err("MP3 encoder overran its buffer.".into());
        }
        // SAFETY: LAME initialized the first `written` bytes after `start`.
        unsafe { out.set_len(start + written) };
        self.lametag()
    }

    fn lametag(&mut self) -> Result<Vec<u8>, String> {
        // SAFETY: with a null buffer and size 0, LAME only reports the size the tag needs.
        let size =
            unsafe { lame::lame_get_lametag_frame(self.lame.as_ptr(), std::ptr::null_mut(), 0) };
        let mut tag = vec![0u8; size];
        if size > 0 {
            // SAFETY: `tag` has exactly `size` writable bytes.
            let written =
                unsafe { lame::lame_get_lametag_frame(self.lame.as_ptr(), tag.as_mut_ptr(), size) };
            if written != size {
                return Err("MP3 encoder failed to write its information tag.".into());
            }
        }
        Ok(tag)
    }
}

impl Drop for Mp3Encoder {
    fn drop(&mut self) {
        // SAFETY: the handle came from lame_init and is closed exactly once, here.
        unsafe { lame::lame_close(self.lame.as_ptr()) };
    }
}
