//! A frame's length prefix is checked against the cap before anything is allocated for its body. The allocator here
//! remembers the largest single allocation made on the test thread, so "refused before allocating" is measured.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    io::Read,
};
use tabplayer_plugin_protocol::{
    MAX_FRAME_BYTES,
    control::{FrameError, HostMessage, read_frame, read_frame_limited},
};

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}

struct TrackAllocator;
unsafe impl GlobalAlloc for TrackAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note(new_size);
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}
fn note(size: usize) {
    let _ = TRACK.try_with(|track| {
        if track.get() {
            let _ = LARGEST.try_with(|largest| largest.set(largest.get().max(size)));
        }
    });
}
#[global_allocator]
static ALLOCATOR: TrackAllocator = TrackAllocator;

/// Runs `f` and returns its result with the largest allocation it made on this thread.
fn measure<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.with(|largest| largest.set(0));
    TRACK.with(|track| track.set(true));
    let result = f();
    TRACK.with(|track| track.set(false));
    (result, LARGEST.with(Cell::get))
}

/// A reader that serves a length prefix, then fails the test if anything reads past it.
struct PrefixOnly {
    prefix: [u8; 4],
    at: usize,
}
impl Read for PrefixOnly {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        assert!(
            self.at < 4,
            "the reader tried to read a body for a refused length"
        );
        let n = buffer.len().min(4 - self.at);
        buffer[..n].copy_from_slice(&self.prefix[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

#[test]
fn frame_over_cap_is_refused_before_allocation() {
    for length in [MAX_FRAME_BYTES + 1, MAX_FRAME_BYTES * 2, u32::MAX as usize] {
        let mut reader = PrefixOnly {
            prefix: (length as u32).to_le_bytes(),
            at: 0,
        };
        let (result, largest) = measure(|| read_frame::<HostMessage>(&mut reader));
        assert!(
            matches!(result, Err(FrameError::TooLarge(n)) if n == length),
            "{length}"
        );
        assert!(
            largest < 4096,
            "refusing {length} bytes allocated {largest} bytes"
        );
    }
    // A tighter limit refuses just as early.
    let mut reader = PrefixOnly {
        prefix: (100_000u32).to_le_bytes(),
        at: 0,
    };
    let (result, largest) = measure(|| read_frame_limited::<HostMessage>(&mut reader, 64 << 10));
    assert!(matches!(result, Err(FrameError::TooLarge(100_000))));
    assert!(largest < 4096);
}

#[test]
fn a_length_at_the_cap_with_no_body_allocates_only_what_arrives() {
    // The prefix promises the full cap and the stream ends after 10 bytes. The reader may not reserve the promise.
    let mut wire = (MAX_FRAME_BYTES as u32).to_le_bytes().to_vec();
    wire.extend_from_slice(b"{\"type\":\"sh");
    let (result, largest) = measure(|| read_frame::<HostMessage>(&mut &wire[..]));
    assert!(matches!(result, Err(FrameError::Truncated)));
    assert!(
        largest <= 128 << 10,
        "allocated {largest} bytes for a 15-byte stream"
    );
}
