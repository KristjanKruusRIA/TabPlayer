//! The helper's audio thread: it takes input blocks out of the shared ring, runs the plug-in on each, and publishes the
//! answers.
//!
//! The loop (see [`run`]):
//! - waits on the input event with a timeout, and bumps the heartbeat on every timeout as well as on every block, so a
//!   helper that is idle looks alive and one stuck inside a plug-in does not (the app's supervisor kills it after 500 ms);
//! - processes every published block in order, and answers every input sequence with exactly one output, in order;
//! - on a new flush epoch resets the plug-in first, and answers blocks that a flush made stale with silence;
//! - when the ring reports `Lapped` or `Torn` (the helper fell more than a ring behind), resumes at the ring's
//!   resynchronisation point and answers every sequence it skipped with silence, so the answers stay in order;
//! - signals the output event after each published block.
//!
//! Everything the app wrote into the ring is untrusted data, and the ring API already copies it out (see the protocol
//! crate's `ring` module). The loop itself never allocates, locks or logs while it runs blocks.
use crate::core::BlockProcessor;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tabplayer_plugin_protocol::{
    limits::{BLOCK_FRAMES, RING_BLOCKS},
    ring::{BlockMeta, HelperRing, InputRead},
};

/// How long the loop waits for the input event before it beats and looks again.
pub const IDLE_TIMEOUT: Duration = Duration::from_millis(100);

/// An auto-reset event as the loop sees it. The real ones are Win32 events duplicated into this process; tests use a
/// condition variable.
pub trait Wake: Send {
    /// Waits until the event is signalled (and resets it) or `timeout` passes. True when it was signalled.
    fn wait(&self, timeout: Duration) -> bool;
    fn signal(&self);
}

/// Lets the main thread stop the audio loop between blocks, to reconfigure the plug-in, without stopping its heartbeat.
#[derive(Default)]
pub struct PauseGate {
    requested: AtomicBool,
    paused: AtomicBool,
}

impl PauseGate {
    /// Asks the loop to reset the plug-in and park, and waits up to `timeout` for it to. False when it did not (the plug-in
    /// is stuck in a block): the request is withdrawn.
    pub fn pause(&self, timeout: Duration) -> bool {
        self.requested.store(true, Ordering::Release);
        let start = std::time::Instant::now();
        while !self.paused.load(Ordering::Acquire) {
            if start.elapsed() >= timeout {
                self.requested.store(false, Ordering::Release);
                return false;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        true
    }

    /// Lets the loop go on, and waits (briefly) until it has left the pause, so that a `pause` straight after cannot take
    /// the old `paused` for its own answer.
    pub fn resume(&self) {
        self.requested.store(false, Ordering::Release);
        let start = std::time::Instant::now();
        while self.paused.load(Ordering::Acquire) && start.elapsed() < Duration::from_millis(250) {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

/// Everything the audio thread owns.
pub struct AudioLoop {
    pub ring: HelperRing,
    pub processor: Box<dyn BlockProcessor + Send>,
    pub input: Box<dyn Wake>,
    pub output: Box<dyn Wake>,
    pub gate: Arc<PauseGate>,
    pub stop: Arc<AtomicBool>,
    pub idle_timeout: Duration,
}

type Frames = [[f32; 2]; BLOCK_FRAMES];

/// Runs until `stop` is set. The caller sets the thread up (priority class) before it calls this.
pub fn run(mut audio: AudioLoop) {
    let mut input: Frames = [[0.0; 2]; BLOCK_FRAMES];
    let mut output: Frames = [[0.0; 2]; BLOCK_FRAMES];
    let silence: Frames = [[0.0; 2]; BLOCK_FRAMES];
    // The sequence of the next input block to answer. It always equals the ring's next output sequence.
    let mut next: u64 = 0;
    // The epoch the plug-in was last reset for.
    let mut epoch = audio.ring.flush_epoch();
    while !audio.stop.load(Ordering::Acquire) {
        if audio.gate.requested.load(Ordering::Acquire) {
            audio.processor.reset();
            audio.gate.paused.store(true, Ordering::Release);
            while audio.gate.requested.load(Ordering::Acquire)
                && !audio.stop.load(Ordering::Acquire)
            {
                audio.ring.beat();
                std::thread::sleep(Duration::from_millis(2));
            }
            audio.gate.paused.store(false, Ordering::Release);
            continue;
        }
        let available = audio.ring.input_available(next);
        if available == 0 {
            audio.ring.beat();
            if !audio.input.wait(audio.idle_timeout) {
                audio.ring.beat();
            }
            continue;
        }
        for _ in 0..available {
            match audio.ring.read_input(next, &mut input) {
                InputRead::Ready(block) => {
                    let latest = audio.ring.flush_epoch();
                    // `latest - block` above half the range means the block is older than the newest epoch. A block
                    // stamped one ahead of the published epoch (the host bumps its counter just before it publishes)
                    // is current.
                    let stale = (latest.wrapping_sub(block.epoch) as i32) > 0;
                    if stale {
                        publish(
                            &mut audio,
                            next,
                            block.epoch,
                            &silence,
                            &BlockMeta::default(),
                        );
                    } else {
                        if block.epoch != epoch {
                            audio.processor.reset();
                            epoch = block.epoch;
                        }
                        audio.processor.process(&input, &mut output, &block.meta);
                        publish(&mut audio, next, block.epoch, &output, &block.meta);
                    }
                    next += 1;
                }
                InputRead::NotYet => break,
                InputRead::Lapped | InputRead::Torn => {
                    // Skip to a point that is certain to be intact, answering what is skipped with silence. The
                    // answers are bounded: a host that claims a wild position gets a ring's worth at a time, and the
                    // heartbeat moves between them.
                    let resume = audio
                        .ring
                        .resync_point()
                        .max(next + 1)
                        .min(next + 2 * RING_BLOCKS as u64);
                    let tag = audio.ring.flush_epoch();
                    while next < resume {
                        publish(&mut audio, next, tag, &silence, &BlockMeta::default());
                        next += 1;
                    }
                    break;
                }
            }
        }
        audio.ring.beat();
    }
    // Leave the plug-in not processing.
    audio.processor.reset();
}

fn publish(audio: &mut AudioLoop, seq: u64, epoch: u32, frames: &Frames, meta: &BlockMeta) {
    // The loop answers in order, so the ring accepts this; a refusal means the sequences disagree and the next
    // block's answer will be refused as well, which the host sees as underruns.
    let _ = audio.ring.publish_output(seq, epoch, frames, meta);
    audio.ring.beat();
    audio.output.signal();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex, atomic::AtomicUsize};
    use std::time::Instant;
    use tabplayer_plugin_protocol::ring::{Block, HostRing, OwnedRing};

    /// An auto-reset event on a condition variable.
    #[derive(Clone, Default)]
    struct Event(Arc<(Mutex<bool>, Condvar)>);
    impl Wake for Event {
        fn wait(&self, timeout: Duration) -> bool {
            let (lock, cv) = &*self.0;
            let mut set = lock.lock().unwrap();
            if !*set {
                set = cv.wait_timeout(set, timeout).unwrap().0;
            }
            std::mem::take(&mut *set)
        }
        fn signal(&self) {
            let (lock, cv) = &*self.0;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
    }

    /// Doubles its input and counts resets.
    struct Doubler {
        resets: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
    }
    impl BlockProcessor for Doubler {
        fn reset(&mut self) {
            self.resets.fetch_add(1, Ordering::SeqCst);
        }
        fn process(&mut self, input: &[[f32; 2]], output: &mut [[f32; 2]], _: &BlockMeta) {
            self.calls.fetch_add(1, Ordering::SeqCst);
            for (o, i) in output.iter_mut().zip(input) {
                *o = [i[0] * 2.0, i[1] * 2.0];
            }
        }
    }

    struct Rig {
        ring: OwnedRing,
        host: HostRing,
        input: Event,
        output: Event,
        gate: Arc<PauseGate>,
        stop: Arc<AtomicBool>,
        resets: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Rig {
        fn new() -> Rig {
            let ring = OwnedRing::new(48_000);
            let host = ring.host();
            Rig {
                ring,
                host,
                input: Event::default(),
                output: Event::default(),
                gate: Arc::new(PauseGate::default()),
                stop: Arc::new(AtomicBool::new(false)),
                resets: Arc::new(AtomicUsize::new(0)),
                calls: Arc::new(AtomicUsize::new(0)),
                thread: None,
            }
        }

        fn start(&mut self) {
            let audio = AudioLoop {
                ring: self.ring.helper(),
                processor: Box::new(Doubler {
                    resets: self.resets.clone(),
                    calls: self.calls.clone(),
                }),
                input: Box::new(self.input.clone()),
                output: Box::new(self.output.clone()),
                gate: self.gate.clone(),
                stop: self.stop.clone(),
                idle_timeout: Duration::from_millis(5),
            };
            self.thread = Some(std::thread::spawn(move || run(audio)));
        }

        fn send(&mut self, seq: u64, value: f32) {
            let block: Block = [[value, -value]; BLOCK_FRAMES];
            let meta = BlockMeta {
                tempo: 90.0 + seq as f64,
                ..BlockMeta::default()
            };
            assert!(self.host.send_input(seq, &block, &meta));
            self.input.signal();
        }

        fn wait_for_output(&self, seq: u64, epoch: u32) -> Block {
            let mut block = [[0.0; 2]; BLOCK_FRAMES];
            let start = Instant::now();
            while !self.host.read_output(seq, epoch, &mut block) {
                assert!(
                    start.elapsed() < Duration::from_secs(5),
                    "block {seq} never came back"
                );
                self.output.wait(Duration::from_millis(5));
            }
            block
        }

        fn stop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.input.signal();
            self.thread.take().unwrap().join().unwrap();
        }
    }

    #[test]
    fn blocks_come_back_processed_in_order() {
        let mut rig = Rig::new();
        rig.start();
        for seq in 0..200u64 {
            rig.send(seq, (seq + 1) as f32);
            let out = rig.wait_for_output(seq, 0);
            assert_eq!(out[0], [2.0 * (seq + 1) as f32, -2.0 * (seq + 1) as f32]);
            assert_eq!(out[BLOCK_FRAMES - 1], out[0]);
        }
        rig.stop();
        assert_eq!(rig.calls.load(Ordering::SeqCst), 200);
    }

    #[test]
    fn many_blocks_published_at_once_are_answered_in_order() {
        let mut rig = Rig::new();
        rig.start();
        for seq in 0..40u64 {
            rig.send(seq, 1.0 + seq as f32);
        }
        for seq in 0..40u64 {
            let out = rig.wait_for_output(seq, 0);
            assert_eq!(out[7][0], 2.0 + 2.0 * seq as f32);
        }
        rig.stop();
    }

    #[test]
    fn a_flush_resets_the_plug_in_and_stale_blocks_get_silence() {
        let mut rig = Rig::new();
        rig.start();
        rig.send(0, 1.0);
        rig.wait_for_output(0, 0);
        assert_eq!(
            rig.resets.load(Ordering::SeqCst),
            0,
            "no reset before a flush"
        );
        // Park the loop so one block is waiting when the flush happens.
        assert!(rig.gate.pause(Duration::from_secs(2)));
        assert_eq!(rig.resets.load(Ordering::SeqCst), 1, "the pause resets");
        rig.send(1, 1.0);
        assert_eq!(rig.host.begin_flush(), 1);
        rig.send(2, 3.0);
        rig.gate.resume();
        let stale = rig.wait_for_output(1, 0);
        assert!(
            stale.iter().all(|f| *f == [0.0, 0.0]),
            "a stale block is silence"
        );
        let fresh = rig.wait_for_output(2, 1);
        assert_eq!(fresh[0], [6.0, -6.0]);
        assert_eq!(
            rig.calls.load(Ordering::SeqCst),
            2,
            "the stale block did not run"
        );
        assert_eq!(
            rig.resets.load(Ordering::SeqCst),
            2,
            "one more reset for the new epoch"
        );
        // The next block in the same epoch does not reset again.
        rig.send(3, 1.0);
        rig.wait_for_output(3, 1);
        assert_eq!(rig.resets.load(Ordering::SeqCst), 2);
        rig.stop();
        assert_eq!(
            rig.resets.load(Ordering::SeqCst),
            3,
            "and one when the loop ends"
        );
    }

    #[test]
    fn falling_a_ring_behind_answers_the_skipped_sequences_with_silence() {
        let mut rig = Rig::new();
        // The host runs more than a ring ahead while the helper is not running.
        let total = RING_BLOCKS as u64 + 10;
        for seq in 0..total {
            rig.send(seq, 1.0);
        }
        rig.start();
        let out = rig.wait_for_output(total - 1, 0);
        assert_eq!(out[0], [2.0, -2.0]);
        rig.stop();
        // The helper resumed at the oldest block certain to be intact; everything before it is silence, in order.
        let mut block = [[0.0; 2]; BLOCK_FRAMES];
        let resume = total - (RING_BLOCKS as u64 - 1);
        for seq in total - RING_BLOCKS as u64..resume {
            assert!(rig.host.read_output(seq, 0, &mut block), "seq {seq}");
            assert!(
                block.iter().all(|f| *f == [0.0, 0.0]),
                "seq {seq} is silence"
            );
        }
        for seq in resume..total {
            assert!(rig.host.read_output(seq, 0, &mut block), "seq {seq}");
            assert_eq!(block[0], [2.0, -2.0], "seq {seq}");
        }
        assert_eq!(
            rig.calls.load(Ordering::SeqCst) as u64,
            total - resume,
            "the skipped blocks were not run"
        );
    }

    #[test]
    fn the_heartbeat_moves_while_idle_and_stops_with_the_loop() {
        let mut rig = Rig::new();
        rig.start();
        let first = rig.host.heartbeat();
        std::thread::sleep(Duration::from_millis(80));
        let second = rig.host.heartbeat();
        assert!(second >= first + 5, "{first} -> {second}");
        rig.stop();
        let end = rig.host.heartbeat();
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(rig.host.heartbeat(), end);
    }

    #[test]
    fn a_pause_resets_the_plug_in_keeps_the_heartbeat_and_resumes() {
        let mut rig = Rig::new();
        rig.start();
        rig.send(0, 1.0);
        rig.wait_for_output(0, 0);
        let before = rig.resets.load(Ordering::SeqCst);
        assert!(rig.gate.pause(Duration::from_secs(2)));
        assert!(rig.resets.load(Ordering::SeqCst) > before);
        // While parked, blocks wait and the heartbeat moves.
        rig.send(1, 2.0);
        let beat = rig.host.heartbeat();
        std::thread::sleep(Duration::from_millis(40));
        assert!(rig.host.heartbeat() > beat);
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        assert!(
            !rig.host.read_output(1, 0, &mut scratch),
            "not processed while paused"
        );
        rig.gate.resume();
        let out = rig.wait_for_output(1, 0);
        assert_eq!(out[0], [4.0, -4.0]);
        // Pausing again straight away parks the loop again; it does not take the last pause's answer.
        for _ in 0..20 {
            assert!(rig.gate.pause(Duration::from_secs(2)));
            assert!(rig.gate.paused.load(Ordering::SeqCst));
            rig.gate.resume();
            assert!(!rig.gate.paused.load(Ordering::SeqCst));
        }
        rig.stop();
    }

    #[test]
    fn a_pause_that_the_loop_cannot_honour_gives_up() {
        let gate = PauseGate::default();
        assert!(!gate.pause(Duration::from_millis(20)));
        assert!(
            !gate.requested.load(Ordering::SeqCst),
            "the request is withdrawn"
        );
    }
}
