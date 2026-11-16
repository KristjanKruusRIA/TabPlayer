//! A counting allocator for the helper's unit tests, so a test can prove that a code path makes no heap operation.
//!
//! The helper's tests are one binary, and a binary has one global allocator: this is it, for every test in the crate. It
//! counts only on the threads that switch counting on (through [`heap_operations`]), so parallel tests do not disturb
//! each other.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static COUNT_HEAP: Cell<bool> = const { Cell::new(false) };
    static HEAP_OPERATIONS: Cell<usize> = const { Cell::new(0) };
}

/// Counts heap operations on the threads that switch counting on, and no others.
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

/// The heap operations `f` makes on this thread. A plug-in's own allocations are not counted: it is a separate Rust
/// library with its own allocator.
pub fn heap_operations(f: impl FnOnce()) -> usize {
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|flag| flag.set(true));
    f();
    COUNT_HEAP.with(|flag| flag.set(false));
    HEAP_OPERATIONS.with(Cell::get)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counting_allocator_counts() {
        let operations = heap_operations(|| drop(std::hint::black_box(vec![1u8; 16])));
        assert!(operations >= 2, "a count of zero below would prove nothing");
    }
}
