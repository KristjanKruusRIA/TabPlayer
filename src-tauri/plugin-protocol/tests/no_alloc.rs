//! The host side of the ring never touches the heap. Allocations are counted only on the thread that sets the flag, so
//! the fake helper thread and the test harness do not count.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tabplayer_plugin_protocol::{
    BLOCK_FRAMES, RING_BLOCKS,
    ring::{BlockMeta, InputRead, OwnedRing},
};

thread_local! {
    static COUNT_HEAP: Cell<bool> = const { Cell::new(false) };
    static HEAP_OPERATIONS: Cell<usize> = const { Cell::new(0) };
}

struct CountAllocator;
unsafe impl GlobalAlloc for CountAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        count();
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}
fn count() {
    // `try_with`: the thread-local may be gone while a thread exits.
    let _ = COUNT_HEAP.try_with(|flag| {
        if flag.get() {
            let _ = HEAP_OPERATIONS.try_with(|n| n.set(n.get() + 1));
        }
    });
}
#[global_allocator]
static ALLOCATOR: CountAllocator = CountAllocator;

const BLOCKS: u64 = 100_000;
/// Blocks in flight between the host and the helper, as a pipeline of a few blocks would hold.
const IN_FLIGHT: u64 = 4;

#[test]
fn host_side_never_allocates() {
    // The counter must see an allocation made on this thread, or a count of zero below would prove nothing.
    COUNT_HEAP.with(|flag| flag.set(true));
    let probe = std::hint::black_box(vec![1u8; 16]);
    drop(probe);
    COUNT_HEAP.with(|flag| flag.set(false));
    assert!(
        HEAP_OPERATIONS.with(Cell::get) >= 2,
        "the counting allocator is not counting"
    );

    let ring = OwnedRing::new(48_000);
    let (mut host, mut helper) = (ring.host(), ring.helper());
    let stop = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);

    let mut failures = 0u64;
    let mut operations = usize::MAX;
    std::thread::scope(|scope| {
        // The fake helper: doubles every block and answers it, in order. It allocates freely.
        scope.spawn(|| {
            let mut input = [[0.0f32; 2]; BLOCK_FRAMES];
            let mut seq = 0u64;
            while !stop.load(Ordering::Relaxed) {
                if helper.input_available(seq) == 0 {
                    helper.beat();
                    std::thread::yield_now();
                    continue;
                }
                let InputRead::Ready(block) = helper.read_input(seq, &mut input) else {
                    std::thread::yield_now();
                    continue;
                };
                let mut output = input;
                for frame in &mut output {
                    frame[0] *= 2.0;
                    frame[1] *= 2.0;
                }
                helper.publish_output(seq, block.epoch, &output, &block.meta);
                seq += 1;
            }
        });

        let mut scratch = [[0.0f32; 2]; BLOCK_FRAMES];
        let mut block = [[0.0f32; 2]; BLOCK_FRAMES];
        let meta = BlockMeta {
            tempo: 120.0,
            sig_num: 4,
            sig_den: 4,
            ..BlockMeta::default()
        };
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|flag| flag.set(true));
        for seq in 0..BLOCKS + IN_FLIGHT {
            if seq < BLOCKS {
                for (i, frame) in block.iter_mut().enumerate() {
                    *frame = [seq as f32 + i as f32, -(seq as f32)];
                }
                assert!(host.send_input(seq, &block, &meta));
            }
            if seq >= IN_FLIGHT {
                let wanted = seq - IN_FLIGHT;
                while !host.output_ready(wanted, 0) {
                    assert!(
                        Instant::now() < deadline,
                        "the fake helper stopped answering"
                    );
                    std::thread::yield_now();
                }
                if !host.read_output(wanted, 0, &mut scratch)
                    || scratch[0][0] != 2.0 * wanted as f32
                    || scratch[BLOCK_FRAMES - 1][1] != -2.0 * wanted as f32
                {
                    failures += 1;
                }
            }
        }
        COUNT_HEAP.with(|flag| flag.set(false));
        operations = HEAP_OPERATIONS.with(Cell::get);
        stop.store(true, Ordering::Relaxed);
    });

    assert_eq!(failures, 0, "blocks came back wrong");
    assert_eq!(
        operations, 0,
        "the host side of the ring allocated or freed heap memory"
    );
    assert!(RING_BLOCKS > IN_FLIGHT as usize);
}
