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
//! An instrument also gets the note events of each block, through the [`NoteGuard`]: it forwards only what keeps the
//! plug-in's notes sound, and every path that can lose blocks (a new epoch, a lapped or torn read, a stale block, a pause)
//! ends in the guard's release-all, so the plug-in is told to stop every note it was told to start. An effect gets no
//! events, whatever the block carries.
//!
//! Everything the app wrote into the ring is untrusted data, and the ring API already copies it out (see the protocol
//! crate's `ring` module). The loop itself never allocates, locks or logs while it runs blocks.
use crate::core::BlockProcessor;
use crate::notes::{MAX_BLOCK_EVENTS, NoteGuard};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tabplayer_plugin_protocol::{
    control::PluginKind,
    event::MidiEvent,
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
    /// What the plug-in is: only an instrument is given events.
    pub kind: PluginKind,
    pub idle_timeout: Duration,
    /// How long a pause keeps the heartbeat moving. A reconfigure that takes longer is a hang in the plug-in (its
    /// `setActive` or `setupProcessing`), and the heartbeat then stops so the app's supervisor sees it.
    pub pause_beat_limit: Duration,
}

type Frames = [[f32; 2]; BLOCK_FRAMES];

/// What the buffer of admitted events starts out as. Never read as an event.
const NO_EVENT: MidiEvent = MidiEvent::AllNotesOff {
    offset: 0,
    channel: 0,
};

/// Runs until `stop` is set. The caller sets the thread up (priority class) before it calls this.
pub fn run(mut audio: AudioLoop) {
    let mut input: Frames = [[0.0; 2]; BLOCK_FRAMES];
    // Read with every block; an instrument is given the ones the guard admits.
    let mut events = [0u64; tabplayer_plugin_protocol::limits::EVENTS_PER_BLOCK];
    let mut notes = NoteGuard::new();
    let mut admitted = [NO_EVENT; MAX_BLOCK_EVENTS];
    let mut output: Frames = [[0.0; 2]; BLOCK_FRAMES];
    let silence: Frames = [[0.0; 2]; BLOCK_FRAMES];
    // The sequence of the next input block to answer. It always equals the ring's next output sequence.
    let mut next: u64 = 0;
    // The epoch the plug-in was last reset for.
    let mut epoch = audio.ring.flush_epoch();
    while !audio.stop.load(Ordering::Acquire) {
        if audio.gate.requested.load(Ordering::Acquire) {
            notes.release_all();
            audio.processor.reset();
            audio.gate.paused.store(true, Ordering::Release);
            let parked = std::time::Instant::now();
            while audio.gate.requested.load(Ordering::Acquire)
                && !audio.stop.load(Ordering::Acquire)
            {
                if parked.elapsed() < audio.pause_beat_limit {
                    audio.ring.beat();
                }
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
            match audio.ring.read_input(next, &mut input, &mut events) {
                InputRead::Ready(block) => {
                    let latest = audio.ring.flush_epoch();
                    // `latest - block` above half the range means the block is older than the newest epoch. A block
                    // stamped one ahead of the published epoch (the host bumps its counter just before it publishes)
                    // is current.
                    let stale = (latest.wrapping_sub(block.epoch) as i32) > 0;
                    if stale {
                        // Its events are not delivered. A note it would have stopped stays sounding in the guard until
                        // the newer epoch's first block, which sends the NoteOff.
                        notes.release_all();
                        publish(
                            &mut audio,
                            next,
                            block.epoch,
                            &silence,
                            &BlockMeta::default(),
                        );
                    } else {
                        if block.epoch != epoch {
                            // Before the reset: the NoteOffs go out with this block, after the plug-in is cleared.
                            notes.release_all();
                            audio.processor.reset();
                            epoch = block.epoch;
                        }
                        let mut count = 0;
                        if audio.kind == PluginKind::Instrument {
                            let words = &events[..usize::from(block.event_count)];
                            notes.admit(words, &mut |event| {
                                if let Some(slot) = admitted.get_mut(count) {
                                    *slot = event;
                                    count += 1;
                                }
                            });
                        }
                        audio.processor.process(
                            &input,
                            &mut output,
                            &block.meta,
                            &admitted[..count],
                        );
                        publish(&mut audio, next, block.epoch, &output, &block.meta);
                    }
                    next += 1;
                }
                InputRead::NotYet => break,
                InputRead::Lapped | InputRead::Torn => {
                    // Blocks were lost, so notes that were started may have had their NoteOffs among them.
                    notes.release_all();
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

    /// What the fake processor saw, in order.
    #[derive(Clone, Debug, PartialEq)]
    enum Seen {
        Reset,
        Block(Vec<MidiEvent>),
    }

    type Log = Arc<Mutex<Vec<Seen>>>;

    fn on(offset: u8, key: u8) -> u64 {
        note_on(offset, key).encode().unwrap()
    }
    fn off(offset: u8, key: u8) -> u64 {
        note_off(offset, key).encode().unwrap()
    }
    fn note_on(offset: u8, key: u8) -> MidiEvent {
        MidiEvent::NoteOn {
            offset,
            channel: 0,
            key,
            velocity: 90,
        }
    }
    fn note_off(offset: u8, key: u8) -> MidiEvent {
        MidiEvent::NoteOff {
            offset,
            channel: 0,
            key,
        }
    }

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

    /// Doubles its input, counts resets, and records resets and the events of each block. While `hold` is set it waits
    /// inside `process`, so a test can park the loop in the middle of a block.
    struct Doubler {
        resets: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
        log: Log,
        hold: Arc<AtomicBool>,
    }
    impl BlockProcessor for Doubler {
        fn reset(&mut self) {
            self.resets.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push(Seen::Reset);
        }
        fn process(
            &mut self,
            input: &[[f32; 2]],
            output: &mut [[f32; 2]],
            _: &BlockMeta,
            events: &[MidiEvent],
        ) {
            self.log.lock().unwrap().push(Seen::Block(events.to_vec()));
            self.calls.fetch_add(1, Ordering::SeqCst);
            while self.hold.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
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
        log: Log,
        hold: Arc<AtomicBool>,
        kind: PluginKind,
        pause_beat_limit: Duration,
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
                log: Log::default(),
                hold: Arc::new(AtomicBool::new(false)),
                kind: PluginKind::Effect,
                pause_beat_limit: Duration::from_secs(60),
                thread: None,
            }
        }

        fn start(&mut self) {
            let audio = AudioLoop {
                ring: self.ring.helper(),
                processor: Box::new(Doubler {
                    resets: self.resets.clone(),
                    calls: self.calls.clone(),
                    log: self.log.clone(),
                    hold: self.hold.clone(),
                }),
                input: Box::new(self.input.clone()),
                output: Box::new(self.output.clone()),
                gate: self.gate.clone(),
                stop: self.stop.clone(),
                kind: self.kind,
                idle_timeout: Duration::from_millis(5),
                pause_beat_limit: self.pause_beat_limit,
            };
            self.thread = Some(std::thread::spawn(move || run(audio)));
        }

        fn send(&mut self, seq: u64, value: f32) {
            self.send_events(seq, value, &[]);
        }

        fn send_events(&mut self, seq: u64, value: f32, words: &[u64]) {
            let block: Block = [[value, -value]; BLOCK_FRAMES];
            let meta = BlockMeta {
                tempo: 90.0 + seq as f64,
                ..BlockMeta::default()
            };
            assert!(self.host.send_input(seq, &block, &meta, words));
            self.input.signal();
        }

        /// The recorded blocks' events, with the resets between them.
        fn seen(&self) -> Vec<Seen> {
            self.log.lock().unwrap().clone()
        }

        /// Waits until the processor has been entered `calls` times (it may be waiting inside the last one).
        fn wait_for_calls(&self, calls: usize) {
            let start = Instant::now();
            while self.calls.load(Ordering::SeqCst) < calls {
                assert!(start.elapsed() < Duration::from_secs(5), "never entered");
                std::thread::sleep(Duration::from_millis(1));
            }
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
    fn a_pause_that_goes_on_too_long_stops_the_heartbeat() {
        let mut rig = Rig::new();
        rig.pause_beat_limit = Duration::from_millis(60);
        rig.start();
        assert!(rig.gate.pause(Duration::from_secs(2)));
        // For a while it beats, so a normal reconfigure is not mistaken for a hang.
        let beat = rig.host.heartbeat();
        std::thread::sleep(Duration::from_millis(30));
        assert!(rig.host.heartbeat() > beat);
        // Then it stops: the app's supervisor sees a helper that has gone quiet.
        std::thread::sleep(Duration::from_millis(120));
        let frozen = rig.host.heartbeat();
        std::thread::sleep(Duration::from_millis(80));
        assert_eq!(rig.host.heartbeat(), frozen);
        // And it beats again when the pause ends.
        rig.gate.resume();
        std::thread::sleep(Duration::from_millis(40));
        assert!(rig.host.heartbeat() > frozen);
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
    // ---- note events ---------------------------------------------------------------------------------------------

    #[test]
    fn an_instrument_is_given_its_events_in_offset_order_and_the_invalid_ones_are_dropped() {
        let mut rig = Rig::new();
        rig.kind = PluginKind::Instrument;
        rig.start();
        let controller = MidiEvent::Controller {
            offset: 1,
            channel: 0,
            controller: 64,
            value: 127,
        }
        .encode()
        .unwrap();
        rig.send_events(
            0,
            1.0,
            &[
                on(100, 61),
                on(5, 60),
                controller,
                u64::MAX,
                off(50, 60),
                off(9, 99),
            ],
        );
        rig.wait_for_output(0, 0);
        rig.stop();
        assert_eq!(
            rig.seen(),
            [
                Seen::Block(vec![note_on(5, 60), note_off(50, 60), note_on(100, 61)]),
                Seen::Reset,
            ],
            "sorted, with the controller, the invalid word and the NoteOff for a key never started dropped"
        );
    }

    #[test]
    fn an_effect_is_never_given_events() {
        let mut rig = Rig::new();
        rig.start();
        rig.send_events(0, 1.0, &[on(5, 60), off(6, 60)]);
        rig.wait_for_output(0, 0);
        rig.stop();
        assert_eq!(rig.seen(), [Seen::Block(vec![]), Seen::Reset]);
    }

    #[test]
    fn a_new_epoch_releases_the_notes_after_the_plug_in_is_reset() {
        let mut rig = Rig::new();
        rig.kind = PluginKind::Instrument;
        rig.start();
        rig.send_events(0, 1.0, &[on(5, 60), on(6, 64)]);
        rig.wait_for_output(0, 0);
        assert_eq!(rig.host.begin_flush(), 1);
        rig.send_events(1, 1.0, &[on(10, 72)]);
        rig.wait_for_output(1, 1);
        rig.send(2, 1.0);
        rig.wait_for_output(2, 1);
        rig.stop();
        assert_eq!(
            rig.seen(),
            [
                Seen::Block(vec![note_on(5, 60), note_on(6, 64)]),
                Seen::Reset,
                Seen::Block(vec![note_off(0, 60), note_off(0, 64), note_on(10, 72)]),
                Seen::Block(vec![]),
                Seen::Reset,
            ],
            "the old notes are stopped at offset 0 of the first block of the new epoch, once"
        );
    }

    #[test]
    fn a_pause_releases_the_notes() {
        let mut rig = Rig::new();
        rig.kind = PluginKind::Instrument;
        rig.start();
        rig.send_events(0, 1.0, &[on(5, 60)]);
        rig.wait_for_output(0, 0);
        assert!(rig.gate.pause(Duration::from_secs(2)));
        rig.gate.resume();
        rig.send_events(1, 1.0, &[on(7, 61)]);
        rig.wait_for_output(1, 0);
        rig.stop();
        assert_eq!(
            rig.seen(),
            [
                Seen::Block(vec![note_on(5, 60)]),
                Seen::Reset,
                Seen::Block(vec![note_off(0, 60), note_on(7, 61)]),
                Seen::Reset,
            ]
        );
    }

    #[test]
    fn a_stale_block_delivers_no_events_and_its_notes_are_never_started() {
        let mut rig = Rig::new();
        rig.kind = PluginKind::Instrument;
        rig.start();
        rig.send_events(0, 1.0, &[on(5, 60)]);
        rig.wait_for_output(0, 0);
        // Park the loop inside block 1, so that block 2 is waiting when the flush happens.
        rig.hold.store(true, Ordering::SeqCst);
        rig.send(1, 1.0);
        rig.wait_for_calls(2);
        rig.send_events(2, 1.0, &[on(8, 61), off(9, 60)]);
        assert_eq!(rig.host.begin_flush(), 1);
        rig.send_events(3, 3.0, &[on(12, 62)]);
        rig.hold.store(false, Ordering::SeqCst);
        let stale = rig.wait_for_output(2, 0);
        assert!(stale.iter().all(|f| *f == [0.0, 0.0]));
        rig.wait_for_output(3, 1);
        rig.stop();
        assert_eq!(
            rig.seen(),
            [
                Seen::Block(vec![note_on(5, 60)]),
                Seen::Block(vec![]),
                Seen::Reset,
                Seen::Block(vec![note_off(0, 60), note_on(12, 62)]),
                Seen::Reset,
            ],
            "key 61 was never started and the stale NoteOff did not run: key 60 is stopped by the release"
        );
    }

    #[test]
    fn falling_a_ring_behind_releases_the_notes() {
        let mut rig = Rig::new();
        rig.kind = PluginKind::Instrument;
        rig.start();
        rig.send_events(0, 1.0, &[on(5, 60)]);
        rig.wait_for_output(0, 0);
        // Hold the loop inside block 1 while the host runs more than a ring ahead, with a NoteOn the helper never sees.
        rig.hold.store(true, Ordering::SeqCst);
        rig.send(1, 1.0);
        rig.wait_for_calls(2);
        let last = 2 + RING_BLOCKS as u64 + 10;
        let skipped = [on(1, 99)];
        for seq in 2..=last {
            rig.send_events(seq, 1.0, if seq == 3 { &skipped } else { &[] });
        }
        rig.hold.store(false, Ordering::SeqCst);
        rig.wait_for_output(last, 0);
        rig.stop();
        let seen = rig.seen();
        assert_eq!(seen[0], Seen::Block(vec![note_on(5, 60)]));
        assert_eq!(seen[1], Seen::Block(vec![]));
        assert_eq!(
            seen[2],
            Seen::Block(vec![note_off(0, 60)]),
            "the first block after the skip stops the note"
        );
        assert!(
            seen[3..].iter().all(|entry| match entry {
                Seen::Block(events) => events.is_empty(),
                Seen::Reset => true,
            }),
            "{seen:?}"
        );
    }

    #[test]
    fn a_full_block_of_events_reaches_the_processor_whole() {
        let mut rig = Rig::new();
        rig.kind = PluginKind::Instrument;
        rig.start();
        let words: Vec<u64> = (0..64u8).map(|i| on(127 - i, i)).collect();
        rig.send_events(0, 1.0, &words);
        rig.wait_for_output(0, 0);
        rig.stop();
        let seen = rig.seen();
        let Seen::Block(events) = &seen[0] else {
            panic!("{seen:?}");
        };
        assert_eq!(events.len(), 64);
        for pair in events.windows(2) {
            assert!(pair[0].offset() <= pair[1].offset());
        }
    }
}
