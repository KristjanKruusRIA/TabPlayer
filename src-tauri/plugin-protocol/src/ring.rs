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
//! - Samples are never lent out as a Rust slice. They are copied with volatile reads into caller-owned scratch, seqlock
//!   style: the block's sequence and epoch are checked before and after the copy, finiteness is checked on the copy, and
//!   only the copy is played.
//! - Header fields the other side can write are atomics.
//!
//! The host side does not allocate, lock, log or wait: it touches atomics and the mapping only. A wake-up event is the
//! caller's business, not the ring's.
use crate::limits::{
    BLOCK_FRAMES, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE, PROTOCOL_VERSION, RING_BLOCKS,
};
use std::{
    alloc::{Layout, alloc_zeroed, dealloc},
    ptr,
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

/// What travels with a block besides its samples. The epoch is stamped by the ring. The bits of `flags` are assigned by
/// the tasks that use them. The other side's copy is untrusted data: the consumer sanitizes tempo and position before a
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
const DATA_BYTES: usize = RING_BLOCKS * size_of::<Block>();
const IN_HEADERS: usize = HEADER_BYTES;
const OUT_HEADERS: usize = IN_HEADERS + BLOCK_HEADERS_BYTES;
const IN_DATA: usize = OUT_HEADERS + BLOCK_HEADERS_BYTES;
const OUT_DATA: usize = IN_DATA + DATA_BYTES;
/// The size of the mapping.
pub const RING_BYTES: usize = OUT_DATA + DATA_BYTES;

const _: () = assert!(size_of::<RingHeader>() == 64 && align_of::<RingHeader>() == 64);
const _: () = assert!(size_of::<BlockHeader>() == 64 && align_of::<BlockHeader>() == 64);
const _: () = assert!(size_of::<Block>() % 64 == 0);
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
// shared access goes through atomics or the volatile copies below.
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
    fn in_data(&self, slot: usize) -> *mut Block {
        debug_assert!(slot < RING_BLOCKS);
        // SAFETY: as above.
        unsafe { (self.base.add(IN_DATA) as *mut Block).add(slot) }
    }
    fn out_data(&self, slot: usize) -> *mut Block {
        debug_assert!(slot < RING_BLOCKS);
        // SAFETY: as above.
        unsafe { (self.base.add(OUT_DATA) as *mut Block).add(slot) }
    }
}

fn slot_of(seq: u64) -> usize {
    (seq % RING_BLOCKS as u64) as usize
}

/// Copies a block out of the mapping with volatile reads, so the compiler can neither merge them with the checks around
/// them nor assume the bytes are stable.
unsafe fn copy_from_mapping(src: *const Block, dst: &mut Block) {
    let src = src as *const [f32; 2];
    for (i, frame) in dst.iter_mut().enumerate() {
        // SAFETY: `i < BLOCK_FRAMES`, inside the block.
        *frame = unsafe { ptr::read_volatile(src.add(i)) };
    }
}

unsafe fn copy_to_mapping(src: &Block, dst: *mut Block) {
    let dst = dst as *mut [f32; 2];
    for (i, frame) in src.iter().enumerate() {
        // SAFETY: as above.
        unsafe { ptr::write_volatile(dst.add(i), *frame) };
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

    /// Starts a new epoch, so the helper resets the plug-in and discards what it holds for older ones. Returns it.
    pub fn begin_flush(&self) -> u32 {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
        self.view
            .header()
            .flush_epoch
            .store(epoch, Ordering::Release);
        epoch
    }
}

/// The audio thread's end of the ring. One exists per mapping, and the thread that owns it is the only producer: the
/// methods that write input take `&mut self`.
pub struct HostRing {
    control: HostControl,
    next_input: u64,
}

impl HostRing {
    /// Opens a mapping the host created with [`HostRing::initialize`].
    ///
    /// # Safety
    /// `ptr` must be valid for reads and writes of `len` bytes for as long as the ring, and its clones, are used, and no
    /// other `HostRing` may exist on it.
    pub unsafe fn from_raw(ptr: *mut u8, len: usize) -> Result<HostRing, RingError> {
        // SAFETY: forwarded.
        unsafe { Self::wrap(View::open(ptr, len, None)?) }
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
        unsafe { Self::wrap(View::initialize(ptr, len, sample_rate, None)?) }
    }

    unsafe fn wrap(view: View) -> Result<HostRing, RingError> {
        Ok(HostRing {
            control: HostControl {
                view,
                epoch: Arc::new(AtomicU32::new(0)),
            },
            next_input: 0,
        })
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
    /// The sequence the next published input block must carry.
    pub fn next_input(&self) -> u64 {
        self.next_input
    }

    /// The samples of input block `seq`, to be filled and then published. Only the next unpublished block can be asked
    /// for. The slice is write-only: the helper may read it at any time, so nothing here reads it back. Asking again
    /// for the same block is fine.
    pub fn input_block_mut(&mut self, seq: u64) -> Option<&mut Block> {
        if seq != self.next_input {
            return None;
        }
        let slot = slot_of(seq);
        // The slot may still hold block `seq - RING_BLOCKS`, which a stalled helper could be reading: mark it invalid
        // before the first sample is overwritten, so the helper's seqlock check fails instead of seeing a mix.
        self.control
            .view
            .in_header(slot)
            .sequence
            .store(EMPTY_SEQUENCE, Ordering::Relaxed);
        fence(Ordering::Release);
        // SAFETY: in range, 64-aligned, and `&mut self` makes this the only producer slice.
        Some(unsafe { &mut *self.control.view.in_data(slot) })
    }

    /// Publishes input block `seq` with `meta`, in the current epoch. Returns false when `seq` is not the next block.
    pub fn publish_input(&mut self, seq: u64, meta: &BlockMeta) -> bool {
        if seq != self.next_input {
            return false;
        }
        let view = &self.control.view;
        let header = view.in_header(slot_of(seq));
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

    /// `read_output_status` with a hook that runs between the copy and the second check. It exists so tests can rewrite
    /// the block at that moment; the ring itself passes an empty closure.
    #[doc(hidden)]
    pub fn read_output_with(
        &self,
        seq: u64,
        epoch: u32,
        scratch: &mut Block,
        between: impl FnOnce(),
    ) -> OutputRead {
        let Some(header) = self.output_header(seq, epoch) else {
            return OutputRead::NotReady;
        };
        // SAFETY: the slot is in range; the copy tolerates concurrent writes.
        unsafe { copy_from_mapping(self.control.view.out_data(slot_of(seq)), scratch) };
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

    /// The meta the helper published with output block `seq`. Call after a successful read.
    pub fn output_meta(&self, seq: u64) -> BlockMeta {
        load_meta(self.control.view.out_header(slot_of(seq)))
    }
}

// ---- the helper side ---------------------------------------------------------------------------------------------

/// An input block as the helper copied it out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InputBlock {
    pub epoch: u32,
    pub meta: BlockMeta,
}

/// The helper's end of the ring: the mirror of [`HostRing`]. It owns the output sequence and the heartbeat and treats
/// `input_write` and `flush_epoch` as the host's untrusted words.
pub struct HelperRing {
    view: View,
    next_output: AtomicU64,
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
            next_output: AtomicU64::new(0),
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

    /// The host's current epoch.
    pub fn flush_epoch(&self) -> u32 {
        self.view.header().flush_epoch.load(Ordering::Acquire)
    }

    /// Copies input block `seq` into `scratch`. None when the host has not published it, or rewrote it while it was
    /// being copied.
    pub fn read_input(&self, seq: u64, scratch: &mut Block) -> Option<InputBlock> {
        if self.view.header().input_write.load(Ordering::Acquire) <= seq {
            return None;
        }
        let header = self.view.in_header(slot_of(seq));
        if header.sequence.load(Ordering::Acquire) != seq {
            return None;
        }
        let epoch = header.epoch.load(Ordering::Relaxed);
        let meta = load_meta(header);
        // SAFETY: in range; the copy tolerates concurrent writes.
        unsafe { copy_from_mapping(self.view.in_data(slot_of(seq)), scratch) };
        fence(Ordering::Acquire);
        (header.sequence.load(Ordering::Relaxed) == seq
            && header.epoch.load(Ordering::Relaxed) == epoch)
            .then_some(InputBlock { epoch, meta })
    }

    /// The sequence the next answer must carry.
    pub fn next_output(&self) -> u64 {
        self.next_output.load(Ordering::Relaxed)
    }

    /// Publishes the answer to input block `seq`, tagged with the epoch that block was sent in. Answers go out in order,
    /// one per input block; false when `seq` is not the next.
    pub fn publish_output(&self, seq: u64, epoch: u32, frames: &Block, meta: &BlockMeta) -> bool {
        if seq != self.next_output.load(Ordering::Relaxed) {
            return false;
        }
        let slot = slot_of(seq);
        let header = self.view.out_header(slot);
        // Invalidate first, so a host mid-copy of the block this slot held a lap ago sees the change.
        header.sequence.store(EMPTY_SEQUENCE, Ordering::Relaxed);
        fence(Ordering::Release);
        // SAFETY: in range.
        unsafe { copy_to_mapping(frames, self.view.out_data(slot)) };
        store_meta(header, epoch, meta);
        header.sequence.store(seq, Ordering::Release);
        self.view
            .header()
            .output_write
            .store(seq + 1, Ordering::Release);
        self.next_output.store(seq + 1, Ordering::Relaxed);
        true
    }

    /// Moves the heartbeat on. Returns the new value.
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

// SAFETY: a plain allocation, used only through atomics and the volatile copies.
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
        // SAFETY: `wrap` has no further requirements.
        unsafe { HostRing::wrap(view) }.expect("own ring")
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
        host.input_block_mut(seq)
            .unwrap()
            .copy_from_slice(&pattern(seq, 1.0));
        assert!(host.publish_input(seq, &meta(seq)));
    }

    /// The fake helper for one block: reads input `seq` and answers with it doubled.
    fn answer(helper: &HelperRing, seq: u64) {
        let mut input = [[0.0; 2]; BLOCK_FRAMES];
        let info = helper.read_input(seq, &mut input).expect("input block");
        assert_eq!(info.meta, meta(seq));
        let mut output = input;
        for frame in &mut output {
            frame[0] *= 2.0;
            frame[1] *= 2.0;
        }
        assert!(helper.publish_output(seq, info.epoch, &output, &info.meta));
    }

    #[test]
    fn layout_is_the_documented_one() {
        assert_eq!(RING_BYTES, 64 + 2 * 66 * 64 + 2 * 66 * BLOCK_FRAMES * 8);
        assert_eq!(RING_BYTES, 143_680);
    }

    #[test]
    fn ring_round_trips_blocks_in_order() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        // Three laps, with a pipeline of four blocks in flight.
        let total = 3 * RING_BLOCKS as u64 + 5;
        for seq in 0..total {
            send(&mut host, seq);
            assert_eq!(helper.input_available(seq), 1);
            answer(&helper, seq);
            if seq >= 3 {
                let wanted = seq - 3;
                assert!(host.read_output(wanted, 0, &mut scratch), "block {wanted}");
                assert_eq!(scratch, pattern(wanted, 2.0));
                assert_eq!(host.output_meta(wanted), meta(wanted));
            }
        }
        assert_eq!(host.next_input(), total);
        assert_eq!(helper.next_output(), total);
    }

    #[test]
    fn blocks_must_go_out_in_order() {
        let ring = OwnedRing::new(44_100);
        let (mut host, helper) = (ring.host(), ring.helper());
        assert!(host.input_block_mut(1).is_none());
        assert!(!host.publish_input(1, &meta(1)));
        send(&mut host, 0);
        assert!(host.input_block_mut(0).is_none(), "already published");
        let block = [[0.0; 2]; BLOCK_FRAMES];
        assert!(!helper.publish_output(1, 0, &block, &meta(1)));
        assert!(helper.publish_output(0, 0, &block, &meta(0)));
    }

    #[test]
    fn output_not_ready_until_published() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        // Nothing sent.
        assert!(!host.output_ready(0, 0));
        assert!(!host.read_output(0, 0, &mut scratch));
        // Sent, not answered.
        send(&mut host, 0);
        assert!(!host.output_ready(0, 0));
        assert!(!host.read_output(0, 0, &mut scratch));
        assert_eq!(helper.input_available(0), 1);
        answer(&helper, 0);
        assert!(host.output_ready(0, 0));
        assert!(host.read_output(0, 0, &mut scratch));
        // The next block is still not there.
        send(&mut host, 1);
        assert!(!host.output_ready(1, 0));
    }

    #[test]
    fn ring_reader_refuses_hostile_indices() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        for seq in 0..4 {
            send(&mut host, seq);
            answer(&helper, seq);
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

        // Sequences that were never sent, or are older than the ring.
        for asked in [u64::MAX, 4, 5, 1000] {
            assert!(!host.read_output(asked, 0, &mut scratch), "asked {asked}");
        }

        // A block whose own sequence is another one's (a stale lap, or a lie).
        assert!(helper.publish_output(4, 0, &pattern(4, 2.0), &meta(4)));
        ring.header().output_write.store(real, Ordering::Release);
        let other = seq + RING_BLOCKS as u64;
        ring.header().output_write.store(real, Ordering::Release);
        // Overwrite slot of `seq` with a block that claims to be `other`.
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
        assert!(host.input_block_mut(1).is_some());
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
        ring.header().input_write.store(3, Ordering::Release);
        assert_eq!(helper.input_available(10), 0);
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        // Claimed published, but the block says otherwise.
        assert!(helper.read_input(2, &mut scratch).is_none());
        assert!(helper.read_input(u64::MAX, &mut scratch).is_none());
        assert!(helper.read_input(5, &mut scratch).is_none());
    }

    #[test]
    fn helper_rewrite_during_read_is_refused() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        send(&mut host, 0);
        answer(&helper, 0);
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
    fn concurrent_rewrite_never_yields_a_torn_block() {
        // A fast helper laps one slot over and over: block 0, then RING_BLOCKS, then 2 * RING_BLOCKS, and so on, each
        // filled with one value (its lap number) and published with the helper's protocol. The host asks for whichever
        // block the helper has reached. A copy that is accepted must be one whole block of that lap; a half-old,
        // half-new copy must be caught by the seqlock.
        // Lap numbers wrap, so the helper can run for as long as the host reads. A copy would have to span 1,000 laps to
        // see the same number twice, which it cannot.
        const LAPS: u64 = 1_000;
        struct Stop<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Stop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        for seq in 0..LAPS * RING_BLOCKS as u64 {
            assert!(host.input_block_mut(seq).is_some());
            assert!(host.publish_input(seq, &BlockMeta::default()));
        }
        let stop = std::sync::atomic::AtomicBool::new(false);
        let lap = AtomicU64::new(0);
        let (mut accepted, mut refused) = (0u64, 0u64);
        std::thread::scope(|scope| {
            let _stop = Stop(&stop);
            scope.spawn(|| {
                let (view, header) = (&helper.view, helper.view.out_header(0));
                let (mut count, mut jitter) = (0u64, 0x9E37_79B9u32);
                while !stop.load(Ordering::Relaxed) {
                    // A pause of random length, so some host copies finish between laps and some are overlapped.
                    jitter ^= jitter << 13;
                    jitter ^= jitter >> 17;
                    jitter ^= jitter << 5;
                    for _ in 0..jitter % 3000 {
                        std::hint::spin_loop();
                    }
                    let n = count % LAPS;
                    count += 1;
                    let seq = n * RING_BLOCKS as u64;
                    header.sequence.store(EMPTY_SEQUENCE, Ordering::Relaxed);
                    fence(Ordering::Release);
                    let block = [[n as f32; 2]; BLOCK_FRAMES];
                    // SAFETY: slot 0 is in range.
                    unsafe { copy_to_mapping(&block, view.out_data(0)) };
                    header.epoch.store(0, Ordering::Relaxed);
                    header.sequence.store(seq, Ordering::Release);
                    view.header().output_write.store(seq + 1, Ordering::Release);
                    lap.store(n, Ordering::Release);
                }
            });
            let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
            let started = std::time::Instant::now();
            while started.elapsed() < std::time::Duration::from_millis(500) {
                let n = lap.load(Ordering::Acquire);
                match host.read_output_status(n * RING_BLOCKS as u64, 0, &mut scratch) {
                    OutputRead::Ready => {
                        accepted += 1;
                        assert!(
                            scratch.iter().all(|frame| *frame == [n as f32; 2]),
                            "an accepted block was torn or from another lap"
                        );
                    }
                    _ => refused += 1,
                }
            }
        });
        assert!(
            accepted > 0 && refused > 0,
            "accepted {accepted}, refused {refused}: the test must exercise both paths"
        );
    }

    #[test]
    fn non_finite_output_is_refused_on_the_copy() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
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
    fn a_flush_tags_later_blocks_with_the_new_epoch() {
        let ring = OwnedRing::new(48_000);
        let (mut host, helper) = (ring.host(), ring.helper());
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        send(&mut host, 0);
        host.begin_flush();
        send(&mut host, 1);
        answer(&helper, 0);
        answer(&helper, 1);
        // The block sent before the flush answers in the old epoch, and is not playable in the new one.
        assert!(!host.read_output(0, 1, &mut scratch));
        assert!(host.read_output(0, 0, &mut scratch));
        assert!(host.read_output(1, 1, &mut scratch));
        assert!(!host.read_output(1, 0, &mut scratch));
    }
}
