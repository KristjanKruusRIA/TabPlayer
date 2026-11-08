//! The parameter edit queue: how a value changed in the plug-in's editor (or sent by the app) reaches the processor.
//!
//! A bounded multi-producer, single-consumer queue of `(id, value)` pairs in preallocated cells, after Dmitry Vyukov's
//! bounded MPMC queue. It is the lock-free queue the spec asks for: producers (the main thread, where `performEdit` and
//! the app's requests arrive) and the consumer (the audio thread, once per block) never take a lock and never allocate.
//! A full queue refuses the newest edit and counts it; it never blocks.
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

struct Cell {
    sequence: AtomicUsize,
    id: AtomicU32,
    value: AtomicU64,
}

pub(crate) struct EditQueue {
    cells: Box<[Cell]>,
    mask: usize,
    enqueue: AtomicUsize,
    /// Only the consumer writes it.
    dequeue: AtomicUsize,
}

impl EditQueue {
    /// `capacity` is rounded up to a power of two (at least 2).
    pub fn new(capacity: usize) -> EditQueue {
        let capacity = capacity.max(2).next_power_of_two();
        EditQueue {
            cells: (0..capacity)
                .map(|i| Cell {
                    sequence: AtomicUsize::new(i),
                    id: AtomicU32::new(0),
                    value: AtomicU64::new(0),
                })
                .collect(),
            mask: capacity - 1,
            enqueue: AtomicUsize::new(0),
            dequeue: AtomicUsize::new(0),
        }
    }

    /// Adds an edit. False when the queue is full.
    pub fn push(&self, id: u32, value: f64) -> bool {
        let mut position = self.enqueue.load(Ordering::Relaxed);
        loop {
            let cell = &self.cells[position & self.mask];
            let sequence = cell.sequence.load(Ordering::Acquire);
            let difference = sequence as isize - position as isize;
            if difference == 0 {
                match self.enqueue.compare_exchange_weak(
                    position,
                    position.wrapping_add(1),
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => {
                        cell.id.store(id, Ordering::Relaxed);
                        cell.value.store(value.to_bits(), Ordering::Relaxed);
                        cell.sequence
                            .store(position.wrapping_add(1), Ordering::Release);
                        return true;
                    }
                    Err(actual) => position = actual,
                }
            } else if difference < 0 {
                return false;
            } else {
                position = self.enqueue.load(Ordering::Relaxed);
            }
        }
    }

    /// Takes the oldest edit. Only one thread may call it.
    pub fn pop(&self) -> Option<(u32, f64)> {
        let position = self.dequeue.load(Ordering::Relaxed);
        let cell = &self.cells[position & self.mask];
        let sequence = cell.sequence.load(Ordering::Acquire);
        if sequence as isize - position.wrapping_add(1) as isize != 0 {
            return None;
        }
        self.dequeue
            .store(position.wrapping_add(1), Ordering::Relaxed);
        let edit = (
            cell.id.load(Ordering::Relaxed),
            f64::from_bits(cell.value.load(Ordering::Relaxed)),
        );
        cell.sequence
            .store(position.wrapping_add(self.mask + 1), Ordering::Release);
        Some(edit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn edits_come_out_in_order_and_a_full_queue_refuses() {
        let queue = EditQueue::new(4);
        for i in 0..4 {
            assert!(queue.push(i, f64::from(i) / 10.0));
        }
        assert!(!queue.push(9, 0.9), "full");
        for i in 0..4 {
            assert_eq!(queue.pop(), Some((i, f64::from(i) / 10.0)));
        }
        assert_eq!(queue.pop(), None);
        // The cells are reused after a lap.
        for lap in 0..10u32 {
            assert!(queue.push(lap, 0.5));
            assert_eq!(queue.pop(), Some((lap, 0.5)));
        }
    }

    #[test]
    fn producers_on_several_threads_lose_nothing_and_keep_each_threads_order() {
        const PER_THREAD: u32 = 2_000;
        let queue = Arc::new(EditQueue::new(256));
        let producers: Vec<_> = (0..3u32)
            .map(|thread| {
                let queue = queue.clone();
                std::thread::spawn(move || {
                    for i in 0..PER_THREAD {
                        // Retry on a full queue: the consumer drains it.
                        while !queue.push(thread, f64::from(i)) {
                            std::thread::yield_now();
                        }
                    }
                })
            })
            .collect();
        let mut last = [-1.0f64; 3];
        let mut seen = 0;
        while seen < 3 * PER_THREAD {
            if let Some((thread, value)) = queue.pop() {
                assert!(value > last[thread as usize], "thread {thread} reordered");
                last[thread as usize] = value;
                seen += 1;
            } else {
                std::thread::yield_now();
            }
        }
        for producer in producers {
            producer.join().unwrap();
        }
        assert_eq!(queue.pop(), None);
    }
}
