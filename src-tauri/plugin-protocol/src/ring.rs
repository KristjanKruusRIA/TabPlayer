//! The shared-memory audio ring between the app's audio thread and one helper process.
//!
//! Layout, every part 64-byte aligned and `#[repr(C)]`:
//!
//! ```text
//! RingHeader | input BlockHeader × RING_BLOCKS | output BlockHeader × RING_BLOCKS
//!            | input samples  RING_BLOCKS × BLOCK_FRAMES × [f32; 2]
//!            | output samples RING_BLOCKS × BLOCK_FRAMES × [f32; 2]
//! ```
//!
//! Block `seq` lives in slot `seq % RING_BLOCKS` and the sequence only ever grows. A flush bumps the *epoch* instead of
//! resetting the sequence: every block carries the epoch it was sent in, and the helper answers every input block, in
//! order, with that block's epoch (silence for blocks a flush made stale).
//!
//! # Trust
//!
//! The other process is untrusted (preflight ruling P3). Therefore:
//! - Counters this side owns (the host's next input sequence and flush epoch; the helper's next output sequence) live in
//!   ordinary memory, are only *written* to the mapping, and are never read back from it.
//! - The geometry (block size, ring blocks, rate) is read once by `from_raw` and cached.
//! - Every index read from the other side is checked against what this side knows before it is used to index anything.
//! - Samples are never lent out as a Rust slice, in either direction. Every sample is an `AtomicU32` cell accessed with
//!   Relaxed loads and stores (the same machine code as plain moves), so a concurrent rewrite by the other side, in or
//!   out of this process, is not a data race. Blocks are copied in and out whole, seqlock style: the block's sequence and
//!   epoch are checked before and after a read, finiteness is checked on the copy, and only the copy is played.
//! - Header fields the other side can write are atomics too.
//!
//! The host side does not allocate, lock, log or wait: it touches atomics and the mapping only. A wake-up event is the
//! caller's business, not the ring's.
use crate::limits::{
    BLOCK_FRAMES, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE, PROTOCOL_VERSION, RING_BLOCKS,
};
use std::{
    alloc::{Layout, alloc_zeroed, dealloc},
    sync::{
        Arc,
        atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering, fence},
    },
};

/// "TPIR".
pub const RING_MAGIC: u32 = 0x5450_4952;
/// A block header's sequence while its samples are being written, and before the first block.
pub const EMPTY_SEQUENCE: u64 = u64::MAX;

/// One block of stereo frames.
pub type Block = [[f32; 2]; BLOCK_FRAMES];
/// A block as it sits in the mapping: the bits of each `f32`, in atomic cells.
type RawBlock = [[AtomicU32; 2]; BLOCK_FRAMES];

#[repr(C, align(64))]
pub struct RingHeader {
    pub magic: AtomicU32,
    pub version: AtomicU32,
    pub block_frames: AtomicU32,
    pub ring_blocks: AtomicU32,
    pub sample_rate: AtomicU32,
    _pad: AtomicU32,
    /// Written by the host: blocks published so far.
    pub input_write: AtomicU64,
    /// Written by the helper: blocks answered so far.
    pub output_write: AtomicU64,
    /// Written by the helper: moves while it is alive.
    pub heartbeat: AtomicU64,
    /// Written by the host: the current flush epoch.
    pub flush_epoch: AtomicU32,
}

/// The block header as it sits in the mapping: `{ sequence: u64, epoch: u32, flags: u32, tempo: f64, sig_num: u16,
/// sig_den: u16, project_frame: i64, project_quarters: f64 }` byte for byte, with atomic cells so a concurrent rewrite
/// by the other process is not a data race.
#[repr(C, align(64))]
pub struct BlockHeader {
    sequence: AtomicU64,
    epoch: AtomicU32,
    flags: AtomicU32,
    tempo: AtomicU64,
    /// `sig_num` in the low 16 bits, `sig_den` in the high 16.
    signature: AtomicU32,
    _reserved: AtomicU32,
    project_frame: AtomicI64,
    project_quarters: AtomicU64,
}

/// `BlockMeta::flags` bit 0: the transport is playing (VST3's `kPlaying`). Task 8 assigned it; the other bits are free.
pub const BLOCK_FLAG_PLAYING: u32 = 1 << 0;

/// What travels with a block besides its samples. The epoch is stamped by the ring. The bits of `flags` are assigned by
/// the tasks that use them ([`BLOCK_FLAG_PLAYING`] so far). The other side's copy is untrusted data: the consumer sanitizes tempo and position before a
/// plug-in sees them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BlockMeta {
    pub flags: u32,
    pub tempo: f64,
    pub sig_num: u16,
    pub sig_den: u16,
    pub project_frame: i64,
    pub project_quarters: f64,
}

const HEADER_BYTES: usize = size_of::<RingHeader>();
const BLOCK_HEADERS_BYTES: usize = RING_BLOCKS * size_of::<BlockHeader>();
const DATA_BYTES: usize = RING_BLOCKS * size_of::<RawBlock>();
const IN_HEADERS: usize = HEADER_BYTES;
const OUT_HEADERS: usize = IN_HEADERS + BLOCK_HEADERS_BYTES;
const IN_DATA: usize = OUT_HEADERS + BLOCK_HEADERS_BYTES;
const OUT_DATA: usize = IN_DATA + DATA_BYTES;
/// The size of the mapping.
pub const RING_BYTES: usize = OUT_DATA + DATA_BYTES;

const _: () = assert!(size_of::<RingHeader>() == 64 && align_of::<RingHeader>() == 64);
const _: () = assert!(size_of::<BlockHeader>() == 64 && align_of::<BlockHeader>() == 64);
const _: () = assert!(size_of::<RawBlock>() == size_of::<Block>() && align_of::<RawBlock>() == 4);
const _: () = assert!(size_of::<RawBlock>() % 64 == 0);
const _: () = assert!(IN_DATA % 64 == 0 && OUT_DATA % 64 == 0 && RING_BYTES % 64 == 0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RingError {
    /// The region is shorter than [`RING_BYTES`].
    TooShort,
    /// Null, or not 64-byte aligned.
    Misaligned,
    BadMagic,
    BadVersion,
    /// Block size or block count differ from this build's.
    BadGeometry,
    BadSampleRate,
}

impl std::fmt::Display for RingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooShort => "audio ring region is too short",
            Self::Misaligned => "audio ring region is misaligned",
            Self::BadMagic => "audio ring has an unknown header",
            Self::BadVersion => "audio ring has an unsupported version",
            Self::BadGeometry => "audio ring has an unexpected geometry",
            Self::BadSampleRate => "audio ring has an unsupported sample rate",
        })
    }
}
impl std::error::Error for RingError {}

/// The outcome of copying an output block out of the mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputRead {
    /// Copied, unchanged during the copy and finite. Safe to play.
    Ready,
    /// Not published (yet), or published for another sequence or epoch, or the index it hangs on is not credible.
    NotReady,
    /// The helper rewrote the block while it was being copied.
    Torn,
    /// The copy holds a NaN or an infinity.
    NonFinite,
}

/// A view of a mapped ring. Cheap to clone; clones share the mapping and keep an owned mapping alive.
#[derive(Clone)]
struct View {
    base: *mut u8,
    sample_rate: u32,
    _keep: Option<Arc<Storage>>,
}

// SAFETY: the pointer is to memory that is valid for the view's lifetime (the `from_raw` contract, or `_keep`), and all
// shared access goes through atomic cells.
unsafe impl Send for View {}
unsafe impl Sync for View {}

impl View {
    /// Checks length, alignment, magic, version and geometry, then caches the rate.
    unsafe fn open(
        ptr: *mut u8,
        len: usize,
        keep: Option<Arc<Storage>>,
    ) -> Result<View, RingError> {
        if len < RING_BYTES {
            return Err(RingError::TooShort);
        }
        if ptr.is_null() || (ptr as usize) % 64 != 0 {
            return Err(RingError::Misaligned);
        }
        // SAFETY: the caller promises `len` valid bytes; the header is within them and aligned.
        let header = unsafe { &*(ptr as *const RingHeader) };
        if header.magic.load(Ordering::Acquire) != RING_MAGIC {
            return Err(RingError::BadMagic);
        }
        if header.version.load(Ordering::Relaxed) != PROTOCOL_VERSION {
            return Err(RingError::BadVersion);
        }
        if header.block_frames.load(Ordering::Relaxed) as usize != BLOCK_FRAMES
            || header.ring_blocks.load(Ordering::Relaxed) as usize != RING_BLOCKS
        {
            return Err(RingError::BadGeometry);
        }
        let sample_rate = header.sample_rate.load(Ordering::Relaxed);
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
            return Err(RingError::BadSampleRate);
        }
        Ok(View {
            base: ptr,
            sample_rate,
            _keep: keep,
        })
    }

    /// Writes a fresh header into a zeroed region, then opens it.
    unsafe fn initialize(
        ptr: *mut u8,
        len: usize,
        sample_rate: u32,
        keep: Option<Arc<Storage>>,
    ) -> Result<View, RingError> {
        if len < RING_BYTES {
            return Err(RingError::TooShort);
        }
        if ptr.is_null() || (ptr as usize) % 64 != 0 {
            return Err(RingError::Misaligned);
        }
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
            return Err(RingError::BadSampleRate);
        }
        // SAFETY: as in `open`; nothing else uses the region yet.
        let header = unsafe { &*(ptr as *const RingHeader) };
        header.version.store(PROTOCOL_VERSION, Ordering::Relaxed);
        header
            .block_frames
            .store(BLOCK_FRAMES as u32, Ordering::Relaxed);
        header
            .ring_blocks
            .store(RING_BLOCKS as u32, Ordering::Relaxed);
        header.sample_rate.store(sample_rate, Ordering::Relaxed);
        header.input_write.store(0, Ordering::Relaxed);
        header.output_write.store(0, Ordering::Relaxed);
        header.heartbeat.store(0, Ordering::Relaxed);
        header.flush_epoch.store(0, Ordering::Relaxed);
        let view = View {
            base: ptr,
            sample_rate,
            _keep: keep,
        };
        for slot in 0..RING_BLOCKS {
            view.in_header(slot)
                .sequence
                .store(EMPTY_SEQUENCE, Ordering::Relaxed);
            view.out_header(slot)
                .sequence
                .store(EMPTY_SEQUENCE, Ordering::Relaxed);
        }
        // The magic goes last: a region that has it is complete.
        header.magic.store(RING_MAGIC, Ordering::Release);
        Ok(view)
    }

    fn header(&self) -> &RingHeader {
        // SAFETY: `open` checked the region's size and alignment.
        unsafe { &*(self.base as *const RingHeader) }
    }
    fn in_header(&self, slot: usize) -> &BlockHeader {
        debug_assert!(slot < RING_BLOCKS);
        // SAFETY: in range by construction of `slot`.
        unsafe { &*(self.base.add(IN_HEADERS) as *const BlockHeader).add(slot) }
    }
    fn out_header(&self, slot: usize) -> &BlockHeader {
        debug_assert!(slot < RING_BLOCKS);
        // SAFETY: as above.
        unsafe { &*(self.base.add(OUT_HEADERS) as *const BlockHeader).add(slot) }
    }
    fn in_data(&self, slot: usize) -> &RawBlock {
        debug_assert!(slot < RING_BLOCKS);
        // SAFETY: as above.
        unsafe { &*(self.base.add(IN_DATA) as *const RawBlock).add(slot) }
    }
    fn out_data(&self, slot: usize) -> &RawBlock {
        debug_assert!(slot < RING_BLOCKS);
        // SAFETY: as above.
        unsafe { &*(self.base.add(OUT_DATA) as *const RawBlock).add(slot) }
    }
}

fn slot_of(seq: u64) -> usize {
    (seq % RING_BLOCKS as u64) as usize
}

/// Copies a block out of the mapping. Relaxed atomic loads: the seqlock's fences order them against the sequence checks.
fn copy_from_mapping(src: &RawBlock, dst: &mut Block) {
    for (frame, cells) in dst.iter_mut().zip(src) {
        *frame = [
            f32::from_bits(cells[0].load(Ordering::Relaxed)),
            f32::from_bits(cells[1].load(Ordering::Relaxed)),
        ];
    }
}

fn copy_to_mapping(src: &Block, dst: &RawBlock) {
    for (frame, cells) in src.iter().zip(dst) {
        cells[0].store(frame[0].to_bits(), Ordering::Relaxed);
        cells[1].store(frame[1].to_bits(), Ordering::Relaxed);
    }
}

fn is_finite(block: &Block) -> bool {
    block
        .iter()
        .all(|frame| frame[0].is_finite() && frame[1].is_finite())
}

fn store_meta(header: &BlockHeader, epoch: u32, meta: &BlockMeta) {
    header.epoch.store(epoch, Ordering::Relaxed);
    header.flags.store(meta.flags, Ordering::Relaxed);
    header.tempo.store(meta.tempo.to_bits(), Ordering::Relaxed);
    header.signature.store(
        u32::from(meta.sig_num) | (u32::from(meta.sig_den) << 16),
        Ordering::Relaxed,
    );
    header
        .project_frame
        .store(meta.project_frame, Ordering::Relaxed);
    header
        .project_quarters
        .store(meta.project_quarters.to_bits(), Ordering::Relaxed);
}

fn load_meta(header: &BlockHeader) -> BlockMeta {
    let signature = header.signature.load(Ordering::Relaxed);
    BlockMeta {
        flags: header.flags.load(Ordering::Relaxed),
        tempo: f64::from_bits(header.tempo.load(Ordering::Relaxed)),
        sig_num: signature as u16,
        sig_den: (signature >> 16) as u16,
        project_frame: header.project_frame.load(Ordering::Relaxed),
        project_quarters: f64::from_bits(header.project_quarters.load(Ordering::Relaxed)),
    }
}

// ---- the host side -----------------------------------------------------------------------------------------------

/// The part of the host side that other threads use: the supervisor reads the heartbeat, and a stop or seek bumps the
/// epoch. Cloneable. The epoch counter lives in ordinary memory and is *published* to the mapping, never read from it.
#[derive(Clone)]
pub struct HostControl {
    view: View,
    epoch: Arc<AtomicU32>,
}

impl HostControl {
    /// The helper's heartbeat. It is the helper's word and only meaningful as "has it moved".
    pub fn heartbeat(&self) -> u64 {
        self.view.header().heartbeat.load(Ordering::Relaxed)
    }

    /// The epoch blocks are sent in now.
    pub fn epoch(&self) -> u32 {
        self.epoch.load(Ordering::Acquire)
    }

    /// Starts a new epoch, so the helper resets the plug-in and discards what it holds for older ones. Returns the epoch
    /// this call started. Callers on several threads are safe: the mapping is re-stored until it holds the newest epoch,
    /// so it never ends up behind the counter.
    pub fn begin_flush(&self) -> u32 {
        let started = self.epoch.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
        let mut publish = started;
        loop {
            self.view
                .header()
                .flush_epoch
                .store(publish, Ordering::Release);
            let newest = self.epoch.load(Ordering::Acquire);
            if newest == publish {
                return started;
            }
            publish = newest;
        }
    }
}

/// The audio thread's end of the ring. One exists per mapping, and the thread that owns it is the only producer:
/// [`HostRing::send_input`] takes `&mut self`.
///
/// It owns an `Arc` (the epoch counter, and the storage of an [`OwnedRing`]), so dropping the last reference on the audio
/// thread would free heap memory. Retire it, and every [`HostControl`] clone, off the audio thread (Task 11 enforces
/// this).
pub struct HostRing {
    control: HostControl,
    next_input: u64,
}

impl HostRing {
    /// Opens a mapping the host created with [`HostRing::initialize`]. A reused mapping restarts its sequences at 0, so
    /// production code opens the mapping it just initialized and nothing else.
    ///
    /// # Safety
    /// `ptr` must be valid for reads and writes of `len` bytes for as long as the ring, and its clones, are used, and no
    /// other `HostRing` may exist on it.
    pub unsafe fn from_raw(ptr: *mut u8, len: usize) -> Result<HostRing, RingError> {
        // SAFETY: forwarded.
        Ok(Self::wrap(unsafe { View::open(ptr, len, None)? }))
    }

    /// Writes a fresh header into a zeroed mapping and opens it. The helper maps the same region afterwards.
    ///
    /// # Safety
    /// As for [`HostRing::from_raw`]; the region must also be zeroed and not yet shared.
    pub unsafe fn initialize(
        ptr: *mut u8,
        len: usize,
        sample_rate: u32,
    ) -> Result<HostRing, RingError> {
        // SAFETY: forwarded.
        Ok(Self::wrap(unsafe {
            View::initialize(ptr, len, sample_rate, None)?
        }))
    }

    fn wrap(view: View) -> HostRing {
        HostRing {
            control: HostControl {
                view,
                epoch: Arc::new(AtomicU32::new(0)),
            },
            next_input: 0,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.control.view.sample_rate
    }
    /// A handle for the supervisor and the control thread.
    pub fn control(&self) -> HostControl {
        self.control.clone()
    }
    pub fn heartbeat(&self) -> u64 {
        self.control.heartbeat()
    }
    pub fn epoch(&self) -> u32 {
        self.control.epoch()
    }
    pub fn begin_flush(&self) -> u32 {
        self.control.begin_flush()
    }
    /// The sequence the next input block must carry.
    pub fn next_input(&self) -> u64 {
        self.next_input
    }

    /// Copies `frames` into input block `seq` and publishes it with `meta`, in the current epoch. Only the next sequence
    /// is accepted (false otherwise), and a block is only ever published whole: the slot, which may still hold the block
    /// of a lap ago that a stalled helper is reading, is invalidated before the first sample is written, so the helper's
    /// seqlock check fails instead of seeing a mix.
    pub fn send_input(&mut self, seq: u64, frames: &Block, meta: &BlockMeta) -> bool {
        if seq != self.next_input {
            return false;
        }
        let view = &self.control.view;
        let slot = slot_of(seq);
        let header = view.in_header(slot);
        header.sequence.store(EMPTY_SEQUENCE, Ordering::Relaxed);
        fence(Ordering::Release);
        copy_to_mapping(frames, view.in_data(slot));
        store_meta(header, self.control.epoch.load(Ordering::Acquire), meta);
        header.sequence.store(seq, Ordering::Release);
        view.header().input_write.store(seq + 1, Ordering::Release);
        self.next_input = seq + 1;
        true
    }

    /// Whether output block `seq` of `epoch` has been published and is credible. It reads no samples.
    pub fn output_ready(&self, seq: u64, epoch: u32) -> bool {
        self.output_header(seq, epoch).is_some()
    }

    /// The header of a credible output block, or none. Credible means: this side has published input `seq`, it is no
    /// older than the ring, the helper claims to have answered it and claims no more than has been sent, and the block's
    /// own sequence and epoch agree.
    fn output_header(&self, seq: u64, epoch: u32) -> Option<&BlockHeader> {
        let published = self.next_input;
        if seq >= published || published - seq > RING_BLOCKS as u64 {
            return None;
        }
        let answered = self
            .control
            .view
            .header()
            .output_write
            .load(Ordering::Acquire);
        if answered <= seq || answered > published {
            return None;
        }
        let header = self.control.view.out_header(slot_of(seq));
        (header.sequence.load(Ordering::Acquire) == seq
            && header.epoch.load(Ordering::Relaxed) == epoch)
            .then_some(header)
    }

    /// Copies output block `seq` of `epoch` into `scratch`, and says whether it can be played. Only `scratch` is ever
    /// played, never the mapping.
    pub fn read_output(&self, seq: u64, epoch: u32, scratch: &mut Block) -> bool {
        self.read_output_status(seq, epoch, scratch) == OutputRead::Ready
    }

    /// As [`HostRing::read_output`], saying why a block was refused: a block that is not there is an underrun, and one
    /// that is non-finite is a fault.
    pub fn read_output_status(&self, seq: u64, epoch: u32, scratch: &mut Block) -> OutputRead {
        self.read_output_with(seq, epoch, scratch, || {})
    }

    /// `read_output_status` with a hook that runs between the copy and the second check, so tests can rewrite the block
    /// at that moment.
    fn read_output_with(
        &self,
        seq: u64,
        epoch: u32,
        scratch: &mut Block,
        between: impl FnOnce(),
    ) -> OutputRead {
        let Some(header) = self.output_header(seq, epoch) else {
            return OutputRead::NotReady;
        };
        copy_from_mapping(self.control.view.out_data(slot_of(seq)), scratch);
        between();
        fence(Ordering::Acquire);
        if header.sequence.load(Ordering::Relaxed) != seq
            || header.epoch.load(Ordering::Relaxed) != epoch
        {
            return OutputRead::Torn;
        }
        if !is_finite(scratch) {
            return OutputRead::NonFinite;
        }
        OutputRead::Ready
    }
}

// ---- the helper side ---------------------------------------------------------------------------------------------

/// An input block as the helper copied it out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InputBlock {
    pub epoch: u32,
    pub meta: BlockMeta,
}

/// The outcome of copying an input block out of the mapping.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InputRead {
    Ready(InputBlock),
    /// The host has not published this block yet.
    NotYet,
    /// The host has published it, but has since written a newer block over its slot: the helper fell more than a ring
    /// behind. Resynchronise at [`HelperRing::resync_point`], and answer every sequence skipped with silence (tagged with
    /// [`HelperRing::flush_epoch`]), so the answers stay in order. The host sees those as underruns.
    Lapped,
    /// The host rewrote the block while it was being copied. Treat it as `Lapped`.
    Torn,
}

impl InputRead {
    pub fn block(self) -> Option<InputBlock> {
        match self {
            InputRead::Ready(block) => Some(block),
            _ => None,
        }
    }
}

/// The helper's end of the ring: the mirror of [`HostRing`]. It owns the output sequence and the heartbeat and treats
/// `input_write` and `flush_epoch` as the host's untrusted words.
pub struct HelperRing {
    view: View,
    next_output: u64,
    beats: AtomicU64,
}

impl HelperRing {
    /// Opens the mapping the host initialized.
    ///
    /// # Safety
    /// `ptr` must be valid for reads and writes of `len` bytes for as long as the ring is used, and no other
    /// `HelperRing` may exist on it.
    pub unsafe fn from_raw(ptr: *mut u8, len: usize) -> Result<HelperRing, RingError> {
        // SAFETY: forwarded.
        Ok(Self::wrap(unsafe { View::open(ptr, len, None)? }))
    }

    fn wrap(view: View) -> HelperRing {
        HelperRing {
            view,
            next_output: 0,
            beats: AtomicU64::new(0),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.view.sample_rate
    }

    /// How many input blocks from `next_input` on the host claims to have published, at most one ring's worth. A claim
    /// behind `next_input` is no blocks.
    pub fn input_available(&self, next_input: u64) -> u64 {
        let written = self.view.header().input_write.load(Ordering::Acquire);
        written.saturating_sub(next_input).min(RING_BLOCKS as u64)
    }

    /// The oldest sequence that is certain to still be intact: one ring's worth behind what the host claims to have
    /// published, less the block whose slot the host may be overwriting. Where to resume after `Lapped`.
    pub fn resync_point(&self) -> u64 {
        let written = self.view.header().input_write.load(Ordering::Acquire);
        written.saturating_sub(RING_BLOCKS as u64 - 1)
    }

    /// The host's current epoch.
    pub fn flush_epoch(&self) -> u32 {
        self.view.header().flush_epoch.load(Ordering::Acquire)
    }

    /// Copies input block `seq` into `scratch`.
    pub fn read_input(&self, seq: u64, scratch: &mut Block) -> InputRead {
        if self.view.header().input_write.load(Ordering::Acquire) <= seq {
            return InputRead::NotYet;
        }
        let header = self.view.in_header(slot_of(seq));
        if header.sequence.load(Ordering::Acquire) != seq {
            return InputRead::Lapped;
        }
        let epoch = header.epoch.load(Ordering::Relaxed);
        let meta = load_meta(header);
        copy_from_mapping(self.view.in_data(slot_of(seq)), scratch);
        fence(Ordering::Acquire);
        if header.sequence.load(Ordering::Relaxed) == seq
            && header.epoch.load(Ordering::Relaxed) == epoch
        {
            InputRead::Ready(InputBlock { epoch, meta })
        } else {
            InputRead::Torn
        }
    }

    /// The sequence the next answer must carry.
    pub fn next_output(&self) -> u64 {
        self.next_output
    }

    /// Publishes the answer to input block `seq`, tagged with the epoch that block was sent in. Answers go out in order,
    /// one per input block; false when `seq` is not the next. `&mut self` keeps a second thread from interleaving writes
    /// into one slot.
    pub fn publish_output(
        &mut self,
        seq: u64,
        epoch: u32,
        frames: &Block,
        meta: &BlockMeta,
    ) -> bool {
        if seq != self.next_output {
            return false;
        }
        let slot = slot_of(seq);
        let header = self.view.out_header(slot);
        // Invalidate first, so a host mid-copy of the block this slot held a lap ago sees the change.
        header.sequence.store(EMPTY_SEQUENCE, Ordering::Relaxed);
        fence(Ordering::Release);
        copy_to_mapping(frames, self.view.out_data(slot));
        store_meta(header, epoch, meta);
        header.sequence.store(seq, Ordering::Release);
        self.view
            .header()
            .output_write
            .store(seq + 1, Ordering::Release);
        self.next_output = seq + 1;
        true
    }

    /// Moves the heartbeat on. Returns the new value. Call it from the thread that runs the plug-in, so a hung plug-in
    /// stops it.
    pub fn beat(&self) -> u64 {
        let beats = self.beats.fetch_add(1, Ordering::Relaxed) + 1;
        self.view.header().heartbeat.store(beats, Ordering::Relaxed);
        beats
    }
}

// ---- a heap-backed ring ------------------------------------------------------------------------------------------

struct Storage {
    ptr: *mut u8,
}

// SAFETY: a plain allocation, used only through atomic cells.
unsafe impl Send for Storage {}
unsafe impl Sync for Storage {}

impl Storage {
    fn layout() -> Layout {
        Layout::from_size_align(RING_BYTES, 64).expect("ring layout")
    }
}

impl Drop for Storage {
    fn drop(&mut self) {
        // SAFETY: allocated with the same layout in `OwnedRing::new`.
        unsafe { dealloc(self.ptr, Self::layout()) };
    }
}

/// A ring in ordinary memory with the same layout as the mapping, for tests and for an in-process fake helper. The
/// views it hands out keep the memory alive.
pub struct OwnedRing {
    storage: Arc<Storage>,
}

impl OwnedRing {
    /// Panics when `sample_rate` is outside the supported range.
    pub fn new(sample_rate: u32) -> OwnedRing {
        let layout = Storage::layout();
        // SAFETY: non-zero size.
        let ptr = unsafe { alloc_zeroed(layout) };
        assert!(!ptr.is_null(), "out of memory");
        let storage = Arc::new(Storage { ptr });
        // SAFETY: freshly allocated, zeroed, not shared.
        unsafe { View::initialize(ptr, RING_BYTES, sample_rate, Some(storage.clone())) }
            .expect("a valid sample rate");
        OwnedRing { storage }
    }

    /// The host end. Call it once.
    pub fn host(&self) -> HostRing {
        // SAFETY: the storage outlives the view through `_keep`; the contract of a single host is the caller's.
        let view = unsafe { View::open(self.storage.ptr, RING_BYTES, Some(self.storage.clone())) }
            .expect("own ring");
        HostRing::wrap(view)
    }

    /// The helper end. Call it once.
    pub fn helper(&self) -> HelperRing {
        // SAFETY: as above.
        let view = unsafe { View::open(self.storage.ptr, RING_BYTES, Some(self.storage.clone())) }
            .expect("own ring");
        HelperRing::wrap(view)
    }

    pub fn as_ptr(&self) -> *mut u8 {
        self.storage.ptr
    }
    pub fn len(&self) -> usize {
        RING_BYTES
    }
    pub fn is_empty(&self) -> bool {
        false
    }
    /// The shared header, so a test can play a hostile peer.
    pub fn header(&self) -> &RingHeader {
        // SAFETY: the storage is a valid, aligned ring.
        unsafe { &*(self.storage.ptr as *const RingHeader) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::atomic::AtomicBool, time::Duration, time::Instant};

    fn pattern(seq: u64, scale: f32) -> Block {
        let mut block = [[0.0; 2]; BLOCK_FRAMES];
        for (i, frame) in block.iter_mut().enumerate() {
            *frame = [
                (seq as f32 + i as f32 * 0.001) * scale,
                -(seq as f32) * scale,
            ];
        }
        block
    }

    fn meta(seq: u64) -> BlockMeta {
        BlockMeta {
            flags: seq as u32 & 7,
            tempo: 120.0 + seq as f64,
            sig_num: 3,
            sig_den: 8,
            project_frame: seq as i64 * BLOCK_FRAMES as i64,
            project_quarters: seq as f64 * 0.25,
        }
    }

    fn send(host: &mut HostRing, seq: u64) {
        assert!(host.send_input(seq, &pattern(seq, 1.0), &meta(seq)));
    }

    /// The fake helper for one block: reads input `seq` and answers with it doubled.
    fn answer(helper: &mut HelperRing, seq: u64) {
        let mut input = [[0.0; 2]; BLOCK_FRAMES];
        let info = helper
            .read_input(seq, &mut input)
            .block()
            .expect("input block");
        assert_eq!(info.meta, meta(seq));
        let mut output = input;
        for frame in &mut output {
            frame[0] *= 2.0;
            frame[1] *= 2.0;
        }
        assert!(helper.publish_output(seq, info.epoch, &output, &info.meta));
    }

    struct Stop<'a>(&'a AtomicBool);
    impl Drop for Stop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    #[test]
    fn layout_is_the_documented_one() {
        assert_eq!(RING_BYTES, 64 + 2 * 66 * 64 + 2 * 66 * BLOCK_FRAMES * 8);
        assert_eq!(RING_BYTES, 143_680);
    }

    #[test]
    fn ring_round_trips_blocks_in_order() {
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        // Three laps, with a pipeline of four blocks in flight.
        let total = 3 * RING_BLOCKS as u64 + 5;
        for seq in 0..total {
            send(&mut host, seq);
            assert_eq!(helper.input_available(seq), 1);
            answer(&mut helper, seq);
            if seq >= 3 {
                let wanted = seq - 3;
                assert!(host.read_output(wanted, 0, &mut scratch), "block {wanted}");
                assert_eq!(scratch, pattern(wanted, 2.0));
            }
        }
        assert_eq!(host.next_input(), total);
        assert_eq!(helper.next_output(), total);
    }

    #[test]
    fn blocks_must_go_out_in_order() {
        let ring = OwnedRing::new(44_100);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let frames = pattern(1, 1.0);
        assert!(!host.send_input(1, &frames, &meta(1)), "skipping ahead");
        send(&mut host, 0);
        assert!(!host.send_input(0, &frames, &meta(0)), "already published");
        let block = [[0.0; 2]; BLOCK_FRAMES];
        assert!(!helper.publish_output(1, 0, &block, &meta(1)));
        assert!(helper.publish_output(0, 0, &block, &meta(0)));
        assert!(!helper.publish_output(0, 0, &block, &meta(0)));
    }

    #[test]
    fn a_published_slot_always_holds_the_samples_just_sent() {
        // After a full lap the slot still holds the previous lap's samples until the next send overwrites them whole.
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        for seq in 0..RING_BLOCKS as u64 + 3 {
            send(&mut host, seq);
            let mut input = [[0.0; 2]; BLOCK_FRAMES];
            let info = helper.read_input(seq, &mut input).block().unwrap();
            assert_eq!(input, pattern(seq, 1.0), "block {seq}");
            assert_eq!(info.meta, meta(seq));
            answer_without_check(&mut helper, seq);
        }
    }

    fn answer_without_check(helper: &mut HelperRing, seq: u64) {
        assert!(helper.publish_output(seq, 0, &[[0.0; 2]; BLOCK_FRAMES], &BlockMeta::default()));
    }

    #[test]
    fn output_not_ready_until_published() {
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        // Nothing sent.
        assert!(!host.output_ready(0, 0));
        assert!(!host.read_output(0, 0, &mut scratch));
        // Sent, not answered.
        send(&mut host, 0);
        assert!(!host.output_ready(0, 0));
        assert!(!host.read_output(0, 0, &mut scratch));
        assert_eq!(helper.input_available(0), 1);
        answer(&mut helper, 0);
        assert!(host.output_ready(0, 0));
        assert!(host.read_output(0, 0, &mut scratch));
        // The next block is still not there.
        send(&mut host, 1);
        assert!(!host.output_ready(1, 0));
    }

    #[test]
    fn ring_reader_refuses_hostile_indices() {
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        for seq in 0..4 {
            send(&mut host, seq);
            answer(&mut helper, seq);
        }
        let seq = 2;
        assert!(host.read_output(seq, 0, &mut scratch));
        let real = ring.header().output_write.load(Ordering::Relaxed);

        // An output_write claim that is absurd, or beyond what was ever sent.
        for claim in [u64::MAX, u64::MAX - 1, seq + RING_BLOCKS as u64 + 1, 5] {
            ring.header().output_write.store(claim, Ordering::Release);
            assert!(!host.output_ready(seq, 0), "claim {claim}");
            assert!(!host.read_output(seq, 0, &mut scratch), "claim {claim}");
            assert_eq!(
                host.read_output_status(seq, 0, &mut scratch),
                OutputRead::NotReady
            );
        }
        // A claim not past the block.
        ring.header().output_write.store(seq, Ordering::Release);
        assert!(!host.read_output(seq, 0, &mut scratch));
        ring.header().output_write.store(real, Ordering::Release);
        assert!(host.read_output(seq, 0, &mut scratch));

        // Sequences that were never sent.
        for asked in [u64::MAX, 4, 5, 1000] {
            assert!(!host.read_output(asked, 0, &mut scratch), "asked {asked}");
        }

        // A block whose own sequence is another one's (a stale lap, or a lie).
        let other = seq + RING_BLOCKS as u64;
        let slot_header = host.control.view.out_header(slot_of(seq));
        slot_header.sequence.store(other, Ordering::Release);
        assert!(!host.read_output(seq, 0, &mut scratch));
        slot_header
            .sequence
            .store(EMPTY_SEQUENCE, Ordering::Release);
        assert!(!host.read_output(seq, 0, &mut scratch));
        slot_header.sequence.store(seq, Ordering::Release);
        assert!(host.read_output(seq, 0, &mut scratch));

        // A stale epoch: the block says 0, the host now wants 1.
        let epoch = host.begin_flush();
        assert_eq!(epoch, 1);
        assert!(!host.read_output(seq, epoch, &mut scratch));
        // And the block's own epoch can lie.
        slot_header.epoch.store(7, Ordering::Release);
        assert!(!host.read_output(seq, 0, &mut scratch));
        assert!(
            host.read_output(seq, 7, &mut scratch),
            "the block's own epoch is what the host compares against"
        );
    }

    #[test]
    fn a_block_older_than_the_ring_is_refused_even_if_forged_valid() {
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        let total = RING_BLOCKS as u64 + 5;
        for seq in 0..total {
            send(&mut host, seq);
            answer(&mut helper, seq);
        }
        // The oldest block still inside the window is readable.
        let oldest = total - RING_BLOCKS as u64;
        // Its slot was lapped by `oldest + 66`, which has not been sent; so it is intact.
        assert!(host.read_output(oldest, 0, &mut scratch));
        // One older is outside the window. Forge everything the other checks look at, so only the window can refuse it.
        let stale = oldest - 1;
        let header = host.control.view.out_header(slot_of(stale));
        header.sequence.store(stale, Ordering::Release);
        header.epoch.store(0, Ordering::Release);
        ring.header().output_write.store(total, Ordering::Release);
        assert!(!host.output_ready(stale, 0));
        assert_eq!(
            host.read_output_status(stale, 0, &mut scratch),
            OutputRead::NotReady
        );
    }

    #[test]
    fn ring_view_refuses_short_or_bad_magic_region() {
        let ring = OwnedRing::new(48_000);
        let (ptr, len) = (ring.as_ptr(), ring.len());
        // SAFETY: the pointer and length are the ring's own; each call only reads the header.
        unsafe {
            assert!(HostRing::from_raw(ptr, len).is_ok());
            assert!(HelperRing::from_raw(ptr, len).is_ok());
            assert_eq!(
                HostRing::from_raw(ptr, len - 1).err(),
                Some(RingError::TooShort)
            );
            assert_eq!(
                HelperRing::from_raw(ptr, 0).err(),
                Some(RingError::TooShort)
            );
            assert_eq!(
                HelperRing::from_raw(std::ptr::null_mut(), len).err(),
                Some(RingError::Misaligned)
            );
            assert_eq!(
                HostRing::from_raw(ptr.add(8), len).err(),
                Some(RingError::Misaligned)
            );
        }
        let header = ring.header();
        let field = |cell: &AtomicU32, bad: u32, expected: RingError| {
            let good = cell.load(Ordering::Relaxed);
            cell.store(bad, Ordering::Relaxed);
            // SAFETY: as above.
            let result = unsafe { HelperRing::from_raw(ptr, len) }.err();
            cell.store(good, Ordering::Relaxed);
            assert_eq!(result, Some(expected));
        };
        field(&header.magic, 0, RingError::BadMagic);
        field(&header.magic, RING_MAGIC ^ 1, RingError::BadMagic);
        field(&header.version, 2, RingError::BadVersion);
        field(&header.block_frames, 64, RingError::BadGeometry);
        field(&header.ring_blocks, 64, RingError::BadGeometry);
        field(&header.sample_rate, 0, RingError::BadSampleRate);
        field(&header.sample_rate, u32::MAX, RingError::BadSampleRate);
        // SAFETY: restored above.
        assert!(unsafe { HelperRing::from_raw(ptr, len) }.is_ok());
    }

    #[test]
    fn initialize_writes_a_header_that_opens() {
        let owned = OwnedRing::new(96_000);
        // A second, separate region initialized by hand, as the app does on a fresh file mapping.
        let layout = Storage::layout();
        // SAFETY: a zeroed allocation of the ring's size and alignment, freed below.
        unsafe {
            let ptr = alloc_zeroed(layout);
            assert_eq!(
                HelperRing::from_raw(ptr, RING_BYTES).err(),
                Some(RingError::BadMagic)
            );
            assert_eq!(
                HostRing::initialize(ptr, RING_BYTES, 1).err(),
                Some(RingError::BadSampleRate)
            );
            let host = HostRing::initialize(ptr, RING_BYTES, 96_000).unwrap();
            let helper = HelperRing::from_raw(ptr, RING_BYTES).unwrap();
            assert_eq!((host.sample_rate(), helper.sample_rate()), (96_000, 96_000));
            drop((host, helper));
            dealloc(ptr, layout);
        }
        assert_eq!(owned.header().sample_rate.load(Ordering::Relaxed), 96_000);
    }

    #[test]
    fn host_owned_counters_ignore_mapping_tampering() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        send(&mut host, 0);
        // A hostile peer rewrites the host's words in the mapping.
        ring.header().input_write.store(u64::MAX, Ordering::Release);
        ring.header().flush_epoch.store(99, Ordering::Release);
        // The host's own counters are unaffected, and it keeps publishing the right values.
        assert_eq!(host.next_input(), 1);
        assert_eq!(host.epoch(), 0);
        send(&mut host, 1);
        assert_eq!(ring.header().input_write.load(Ordering::Relaxed), 2);
        assert_eq!(host.begin_flush(), 1);
        assert_eq!(ring.header().flush_epoch.load(Ordering::Relaxed), 1);
        assert_eq!(helper.flush_epoch(), 1);
    }

    #[test]
    fn helper_clamps_hostile_input_write() {
        let ring = OwnedRing::new(48_000);
        let (_host, helper) = (ring.host(), ring.helper());
        ring.header().input_write.store(u64::MAX, Ordering::Release);
        assert_eq!(helper.input_available(0), RING_BLOCKS as u64);
        assert_eq!(helper.input_available(u64::MAX), 0);
        assert_eq!(helper.resync_point(), u64::MAX - (RING_BLOCKS as u64 - 1));
        ring.header().input_write.store(3, Ordering::Release);
        assert_eq!(helper.input_available(10), 0);
        assert_eq!(helper.resync_point(), 0);
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        // Claimed published, but the slot says otherwise.
        assert_eq!(helper.read_input(2, &mut scratch), InputRead::Lapped);
        // Not claimed.
        assert_eq!(helper.read_input(3, &mut scratch), InputRead::NotYet);
        assert_eq!(helper.read_input(u64::MAX, &mut scratch), InputRead::NotYet);
    }

    #[test]
    fn a_lapped_helper_is_told_and_can_resynchronise() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        // The host runs 71 blocks ahead of a helper that read nothing.
        for seq in 0..71 {
            send(&mut host, seq);
        }
        assert_eq!(helper.read_input(0, &mut scratch), InputRead::Lapped);
        assert_eq!(helper.read_input(4, &mut scratch), InputRead::Lapped);
        let resume = helper.resync_point();
        assert_eq!(resume, 71 - (RING_BLOCKS as u64 - 1));
        let info = helper.read_input(resume, &mut scratch).block().unwrap();
        assert_eq!(scratch, pattern(resume, 1.0));
        assert_eq!(info.meta, meta(resume));
        assert_eq!(
            helper.read_input(70, &mut scratch).block().unwrap().epoch,
            0
        );
    }

    #[test]
    fn helper_rewrite_during_read_is_refused() {
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        send(&mut host, 0);
        answer(&mut helper, 0);
        assert!(host.read_output(0, 0, &mut scratch));
        let header = host.control.view.out_header(0);

        // The helper starts rewriting the slot (invalidates it) while the host is mid-copy.
        let outcome = host.read_output_with(0, 0, &mut scratch, || {
            header.sequence.store(EMPTY_SEQUENCE, Ordering::Release);
        });
        assert_eq!(outcome, OutputRead::Torn);
        header.sequence.store(0, Ordering::Release);

        // The helper republishes the slot for another block while the host is mid-copy.
        let outcome = host.read_output_with(0, 0, &mut scratch, || {
            header.sequence.store(RING_BLOCKS as u64, Ordering::Release);
        });
        assert_eq!(outcome, OutputRead::Torn);
        header.sequence.store(0, Ordering::Release);

        // The block's epoch changes under the copy.
        let outcome = host.read_output_with(0, 0, &mut scratch, || {
            header.epoch.store(5, Ordering::Release)
        });
        assert_eq!(outcome, OutputRead::Torn);
        header.epoch.store(0, Ordering::Release);

        // Nothing changes: the copy is accepted.
        assert_eq!(
            host.read_output_with(0, 0, &mut scratch, || {}),
            OutputRead::Ready
        );
    }

    #[test]
    fn an_invalidated_input_slot_reads_as_lapped() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        send(&mut host, 0);
        // The helper reads block 0 while the host (a lap later, in this forged case) starts writing over its slot.
        let header = host.control.view.in_header(0);
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        assert!(helper.read_input(0, &mut scratch).block().is_some());
        header.sequence.store(EMPTY_SEQUENCE, Ordering::Release);
        assert_eq!(helper.read_input(0, &mut scratch), InputRead::Lapped);
    }

    #[test]
    fn concurrent_rewrite_is_caught_by_the_seqlock() {
        // A buggy or hostile helper answers block t, then, a moment later and out of protocol, reuses the slot for block
        // t + RING_BLOCKS (invalidating it first, as a seqlock writer does) without waiting for the host to send it. The
        // host reads block t in a loop. A read that overlaps the reuse must be Torn, never accepted; one that does not
        // is accepted, and then must hold exactly the answer. Sequences only grow, so a slot never returns to a value it
        // had.
        //
        // A handshake keeps a trial from being missed: the helper holds the reuse back until the host has read the answer
        // once (`seen`), so a host that is descheduled for a while cannot find the slot already reused. The race that
        // matters stays: the host keeps reading after that first read while the helper pauses a random time and reuses.
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let announced = AtomicU64::new(0);
        let seen = AtomicU64::new(0);
        let stop = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(60);
        let (mut accepted, mut torn, mut trials) = (0u64, 0u64, 0u64);
        std::thread::scope(|scope| {
            let _stop = Stop(&stop);
            scope.spawn(|| {
                let mut jitter = 0x9E37_79B9u32;
                let mut t = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    if announced.load(Ordering::Acquire) <= t {
                        std::hint::spin_loop();
                        continue;
                    }
                    let answer = [[t as f32; 2]; BLOCK_FRAMES];
                    assert!(helper.publish_output(t, 0, &answer, &BlockMeta::default()));
                    // Wait until the host has read the answer once.
                    while seen.load(Ordering::Acquire) <= t {
                        if stop.load(Ordering::Relaxed) {
                            return;
                        }
                        std::hint::spin_loop();
                    }
                    // A pause of random length, so the reuse lands at varying points of the host's loop.
                    jitter ^= jitter << 13;
                    jitter ^= jitter >> 17;
                    jitter ^= jitter << 5;
                    for _ in 0..jitter % 2000 {
                        std::hint::spin_loop();
                    }
                    let slot = slot_of(t);
                    let header = helper.view.out_header(slot);
                    header.sequence.store(EMPTY_SEQUENCE, Ordering::Relaxed);
                    fence(Ordering::Release);
                    copy_to_mapping(
                        &[[-1.0 - t as f32; 2]; BLOCK_FRAMES],
                        helper.view.out_data(slot),
                    );
                    header
                        .sequence
                        .store(t + RING_BLOCKS as u64, Ordering::Release);
                    t += 1;
                }
            });
            let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
            let frames = [[0.0; 2]; BLOCK_FRAMES];
            while trials < 20_000 && !(torn >= 25 && accepted > 0) {
                let t = trials;
                assert!(host.send_input(t, &frames, &BlockMeta::default()));
                announced.store(t + 1, Ordering::Release);
                let mut first_read = false;
                loop {
                    assert!(
                        Instant::now() < deadline,
                        "trial {t} is stuck (seen = {seen_first}): {accepted} accepted, {torn} torn so far",
                        seen_first = seen.load(Ordering::Relaxed),
                    );
                    match host.read_output_status(t, 0, &mut scratch) {
                        OutputRead::Ready => {
                            first_read = true;
                            seen.store(t + 1, Ordering::Release);
                            accepted += 1;
                            assert!(
                                scratch.iter().all(|frame| *frame == [t as f32; 2]),
                                "an accepted block was torn or not the answer"
                            );
                        }
                        OutputRead::Torn => {
                            torn += 1;
                            break;
                        }
                        OutputRead::NotReady if first_read => break,
                        OutputRead::NotReady => std::hint::spin_loop(),
                        OutputRead::NonFinite => panic!("a finite answer read as non-finite"),
                    }
                }
                trials += 1;
            }
        });
        assert!(
            torn > 0 && accepted > 0,
            "{trials} trials: {accepted} accepted, {torn} torn; the test must exercise both paths"
        );
    }

    #[test]
    fn non_finite_output_is_refused_on_the_copy() {
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        for (seq, bad) in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY]
            .into_iter()
            .enumerate()
        {
            let seq = seq as u64;
            send(&mut host, seq);
            let mut block = pattern(seq, 1.0);
            block[BLOCK_FRAMES - 1][1] = bad;
            assert!(helper.publish_output(seq, 0, &block, &meta(seq)));
            assert!(host.output_ready(seq, 0));
            assert!(!host.read_output(seq, 0, &mut scratch));
            assert_eq!(
                host.read_output_status(seq, 0, &mut scratch),
                OutputRead::NonFinite
            );
        }
    }

    #[test]
    fn heartbeat_moves_and_flush_bumps_the_epoch() {
        let ring = OwnedRing::new(48_000);
        let (host, helper) = (ring.host(), ring.helper());
        let control = host.control();
        assert_eq!(control.heartbeat(), 0);
        assert_eq!(helper.beat(), 1);
        assert_eq!(helper.beat(), 2);
        assert_eq!((host.heartbeat(), control.heartbeat()), (2, 2));
        assert_eq!(control.epoch(), 0);
        assert_eq!(control.begin_flush(), 1);
        assert_eq!(host.begin_flush(), 2);
        assert_eq!(
            (host.epoch(), control.epoch(), helper.flush_epoch()),
            (2, 2, 2)
        );
    }

    #[test]
    fn concurrent_flushes_leave_the_mapping_at_the_newest_epoch() {
        let ring = OwnedRing::new(48_000);
        let host = ring.host();
        let helper = ring.helper();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let control = host.control();
                scope.spawn(move || {
                    for _ in 0..2_000 {
                        control.begin_flush();
                    }
                });
            }
        });
        assert_eq!(host.epoch(), 8_000);
        assert_eq!(helper.flush_epoch(), 8_000);
    }

    #[test]
    fn a_flush_tags_later_blocks_with_the_new_epoch() {
        let ring = OwnedRing::new(48_000);
        let (mut host, mut helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        send(&mut host, 0);
        host.begin_flush();
        send(&mut host, 1);
        answer(&mut helper, 0);
        answer(&mut helper, 1);
        // The block sent before the flush answers in the old epoch, and is not playable in the new one.
        assert!(!host.read_output(0, 1, &mut scratch));
        assert!(host.read_output(0, 0, &mut scratch));
        assert!(host.read_output(1, 1, &mut scratch));
        assert!(!host.read_output(1, 0, &mut scratch));
    }
}
