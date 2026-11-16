//! The note guard: what an instrument plug-in is allowed to be told, whatever the app sent.
//!
//! The words in an input block come from the app, which the helper does not trust. [`NoteGuard::admit`] decodes them with
//! the protocol's strict decoder, puts them in offset order and passes on only what keeps the plug-in's notes sound:
//!
//! - **The helper never forwards a NoteOff for a key it did not start.** A NoteOn sets the key's bit in `sounding`; a
//!   NoteOff passes only when that bit is set, and clears it. The bit is per channel and key, 16 by 128.
//! - **Every path that can lose blocks ends in [`NoteGuard::release_all`].** It moves every sounding key to `release`,
//!   and the NoteOffs go out at offset 0 of the next block (or blocks), before anything that block carries. The audio loop
//!   calls it on a new epoch, on a lapped or torn read, on a pause and for a stale block.
//! - **A retrigger is a NoteOff and then a NoteOn.** A NoteOn for a key that is already sounding (or whose release is
//!   still waiting) emits a NoteOff and then the NoteOn at the same offset. The guard keeps one bit per key, so it can
//!   owe the plug-in only one NoteOff for it. A plug-in that gave the second NoteOn a second voice (a synthesizer with a
//!   sustain, a sampler with a loop) would hold that voice forever after the one NoteOff, a stuck note. Ending the first
//!   voice before the second starts keeps one voice per key, so one NoteOff always ends it. For a one-shot drum sampler
//!   the extra NoteOff is harmless: it chokes the previous hit, which is what hitting the same pad again does.
//! - **Controllers are dropped** in this version. An AllNotesOff releases the sounding keys of its channel at its offset.
//!
//! The plug-in's event list holds [`crate::vst3`]'s `EVENT_CAP` (1,024) events. One block never produces more than
//! [`MAX_BLOCK_EVENTS`]: at most [`RELEASE_PER_BLOCK`] NoteOffs that come from a release (pending ones and those of an
//! AllNotesOff share that budget; the rest wait for the next block), and at most two events for each of the
//! [`EVENTS_PER_BLOCK`] words (a retrigger). Nothing here allocates, locks or blocks: the block path runs on the audio
//! thread.
use tabplayer_plugin_protocol::{event::MidiEvent, limits::EVENTS_PER_BLOCK};

/// How many NoteOffs one block may emit for releases (pending ones and those an AllNotesOff asks for). A larger release
/// carries over to the next blocks: 2,048 keys take eight blocks, about 21 ms at 48 kHz.
pub const RELEASE_PER_BLOCK: usize = 256;
/// The most events one call of [`NoteGuard::admit`] emits.
pub const MAX_BLOCK_EVENTS: usize = RELEASE_PER_BLOCK + 2 * EVENTS_PER_BLOCK;

/// A placeholder to fill arrays with. Never read as an event.
const PAD: MidiEvent = MidiEvent::AllNotesOff {
    offset: 0,
    channel: 0,
};

/// Which keys the plug-in has been told to start and not to stop. See the module comment.
#[derive(Clone, Debug)]
pub struct NoteGuard {
    /// Per channel, a bit per key: started and not stopped.
    sounding: [u128; 16],
    /// Per channel, a bit per key: started, to be stopped (the NoteOff has not gone out yet).
    release: [u128; 16],
    /// Words that were not valid events, or that a block had no room for.
    dropped: u64,
}

impl Default for NoteGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl NoteGuard {
    pub fn new() -> NoteGuard {
        NoteGuard {
            sounding: [0; 16],
            release: [0; 16],
            dropped: 0,
        }
    }

    /// Schedules a NoteOff for every sounding key. They go out at offset 0 of the next call of [`NoteGuard::admit`], at
    /// most [`RELEASE_PER_BLOCK`] a block.
    pub fn release_all(&mut self) {
        for (release, sounding) in self.release.iter_mut().zip(&mut self.sounding) {
            *release |= *sounding;
            *sounding = 0;
        }
    }

    /// Keys the plug-in has been told to start and not to stop.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn sounding_count(&self) -> u32 {
        self.sounding.iter().map(|bits| bits.count_ones()).sum()
    }

    /// Keys whose NoteOff is waiting for a block.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn pending_count(&self) -> u32 {
        self.release.iter().map(|bits| bits.count_ones()).sum()
    }

    /// How many words were refused so far: not a valid event, or past the block's [`EVENTS_PER_BLOCK`].
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn dropped_words(&self) -> u64 {
        self.dropped
    }

    /// Takes the words of one block and calls `emit` for each event the plug-in may be given, in offset order: first the
    /// NoteOffs of earlier releases that are still waiting (at offset 0), then the block's events. Call it for every
    /// block the plug-in processes, with no words when the block has none, so a waiting release is never held up.
    ///
    /// `emit` gets only NoteOn and NoteOff, and at most [`MAX_BLOCK_EVENTS`] of them.
    pub fn admit(&mut self, words: &[u64], emit: &mut impl FnMut(MidiEvent)) {
        let mut budget = RELEASE_PER_BLOCK;
        self.drain(0, &mut budget, emit);

        // Valid events in offset order, equal offsets in arrival order: an insertion sort over at most 64 items.
        let mut valid = [PAD; EVENTS_PER_BLOCK];
        let mut count = 0;
        for (index, word) in words.iter().enumerate() {
            if index >= EVENTS_PER_BLOCK {
                self.dropped = self.dropped.saturating_add((words.len() - index) as u64);
                break;
            }
            let Some(event) = MidiEvent::decode(*word) else {
                self.dropped = self.dropped.saturating_add(1);
                continue;
            };
            let mut at = count;
            while at > 0 && valid[at - 1].offset() > event.offset() {
                valid[at] = valid[at - 1];
                at -= 1;
            }
            valid[at] = event;
            count += 1;
        }

        for event in &valid[..count] {
            match *event {
                MidiEvent::NoteOn {
                    offset,
                    channel,
                    key,
                    ..
                } => {
                    let (channel_index, bit) = (usize::from(channel), 1u128 << key);
                    if (self.sounding[channel_index] | self.release[channel_index]) & bit != 0 {
                        // The retrigger rule: end the old voice first.
                        self.release[channel_index] &= !bit;
                        emit(MidiEvent::NoteOff {
                            offset,
                            channel,
                            key,
                        });
                    }
                    self.sounding[channel_index] |= bit;
                    emit(*event);
                }
                MidiEvent::NoteOff { channel, key, .. } => {
                    let (channel_index, bit) = (usize::from(channel), 1u128 << key);
                    if self.sounding[channel_index] & bit != 0 {
                        self.sounding[channel_index] &= !bit;
                        emit(*event);
                    }
                }
                MidiEvent::AllNotesOff { offset, channel } => {
                    let channel_index = usize::from(channel);
                    self.release[channel_index] |= self.sounding[channel_index];
                    self.sounding[channel_index] = 0;
                    self.drain(offset, &mut budget, emit);
                }
                // Not carried in this version.
                MidiEvent::Controller { .. } => {}
            }
        }
    }

    /// Emits waiting NoteOffs at `offset`, lowest channel and key first, while `budget` lasts.
    fn drain(&mut self, offset: u8, budget: &mut usize, emit: &mut impl FnMut(MidiEvent)) {
        for (channel, bits) in self.release.iter_mut().enumerate() {
            while *budget > 0 && *bits != 0 {
                let key = bits.trailing_zeros();
                *bits &= !(1u128 << key);
                *budget -= 1;
                emit(MidiEvent::NoteOff {
                    offset,
                    channel: channel as u8,
                    key: key as u8,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(offset: u8, channel: u8, key: u8) -> u64 {
        MidiEvent::NoteOn {
            offset,
            channel,
            key,
            velocity: 100,
        }
        .encode()
        .unwrap()
    }

    fn off(offset: u8, channel: u8, key: u8) -> u64 {
        MidiEvent::NoteOff {
            offset,
            channel,
            key,
        }
        .encode()
        .unwrap()
    }

    fn all_off(offset: u8, channel: u8) -> u64 {
        MidiEvent::AllNotesOff { offset, channel }.encode().unwrap()
    }

    fn controller(offset: u8) -> u64 {
        MidiEvent::Controller {
            offset,
            channel: 0,
            controller: 64,
            value: 127,
        }
        .encode()
        .unwrap()
    }

    fn run(guard: &mut NoteGuard, words: &[u64]) -> Vec<MidiEvent> {
        let mut out = Vec::new();
        guard.admit(words, &mut |event| out.push(event));
        assert!(out.len() <= MAX_BLOCK_EVENTS, "{} events", out.len());
        out
    }

    fn note_on(offset: u8, channel: u8, key: u8) -> MidiEvent {
        MidiEvent::NoteOn {
            offset,
            channel,
            key,
            velocity: 100,
        }
    }

    fn note_off(offset: u8, channel: u8, key: u8) -> MidiEvent {
        MidiEvent::NoteOff {
            offset,
            channel,
            key,
        }
    }

    #[test]
    fn a_note_on_passes_and_its_note_off_ends_it() {
        let mut guard = NoteGuard::new();
        assert_eq!(run(&mut guard, &[on(10, 0, 60)]), [note_on(10, 0, 60)]);
        assert_eq!(guard.sounding_count(), 1);
        assert_eq!(run(&mut guard, &[off(20, 0, 60)]), [note_off(20, 0, 60)]);
        assert_eq!(guard.sounding_count(), 0);
    }

    #[test]
    fn a_note_off_for_a_key_that_was_not_started_is_dropped() {
        let mut guard = NoteGuard::new();
        assert_eq!(run(&mut guard, &[off(0, 0, 60)]), []);
        // Another channel's note does not count.
        run(&mut guard, &[on(0, 1, 60)]);
        assert_eq!(run(&mut guard, &[off(1, 0, 60)]), []);
        // A second NoteOff for the same note is dropped.
        assert_eq!(run(&mut guard, &[off(2, 1, 60)]), [note_off(2, 1, 60)]);
        assert_eq!(run(&mut guard, &[off(3, 1, 60)]), []);
        // A NoteOn and its NoteOff in the same block, the NoteOff given first: arrival order inside an offset decides.
        assert_eq!(
            run(&mut guard, &[off(5, 0, 70), on(5, 0, 70)]),
            [note_on(5, 0, 70)]
        );
        assert_eq!(guard.sounding_count(), 1);
    }

    #[test]
    fn events_are_put_in_offset_order_and_equal_offsets_keep_their_order() {
        let mut guard = NoteGuard::new();
        let out = run(
            &mut guard,
            &[
                on(100, 0, 1),
                on(5, 0, 2),
                on(5, 0, 3),
                on(127, 0, 4),
                on(0, 0, 5),
                on(5, 0, 6),
                off(50, 0, 5),
            ],
        );
        let seen: Vec<(u8, u8)> = out
            .iter()
            .map(|event| match *event {
                MidiEvent::NoteOn { offset, key, .. } => (offset, key),
                MidiEvent::NoteOff { offset, key, .. } => (offset, 100 + key),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            seen,
            [
                (0, 5),
                (5, 2),
                (5, 3),
                (5, 6),
                (50, 105),
                (100, 1),
                (127, 4)
            ]
        );
    }

    #[test]
    fn a_full_block_of_events_in_reverse_order_is_sorted() {
        let mut guard = NoteGuard::new();
        let words: Vec<u64> = (0..EVENTS_PER_BLOCK as u8)
            .map(|i| on(127 - i, 0, i))
            .collect();
        let out = run(&mut guard, &words);
        assert_eq!(out.len(), EVENTS_PER_BLOCK);
        for pair in out.windows(2) {
            assert!(pair[0].offset() <= pair[1].offset());
        }
    }

    #[test]
    fn invalid_words_are_dropped_and_counted() {
        let mut guard = NoteGuard::new();
        let bad = [
            1u64 << 40,                // a bit past the layout
            0,                         // kind 0
            on(0, 0, 1) | (200 << 24), // key out of range
            on(0, 0, 1) | (16 << 16),  // channel out of range
            on(0, 0, 1) | 128,         // offset out of range
            u64::MAX,
        ];
        let mut words = bad.to_vec();
        words.insert(3, on(7, 2, 9));
        let out = run(&mut guard, &words);
        assert_eq!(out, [note_on(7, 2, 9)]);
        assert_eq!(guard.dropped_words(), bad.len() as u64);
        assert_eq!(guard.sounding_count(), 1);
    }

    #[test]
    fn words_past_the_block_cap_are_dropped_and_counted() {
        let mut guard = NoteGuard::new();
        let words: Vec<u64> = (0..EVENTS_PER_BLOCK as u8 + 5)
            .map(|i| on(0, 0, i))
            .collect();
        let out = run(&mut guard, &words);
        assert_eq!(out.len(), EVENTS_PER_BLOCK);
        assert_eq!(guard.dropped_words(), 5);
    }

    #[test]
    fn controllers_are_dropped_without_being_counted_as_invalid() {
        let mut guard = NoteGuard::new();
        assert_eq!(
            run(&mut guard, &[controller(3), on(4, 0, 60)]),
            [note_on(4, 0, 60)]
        );
        assert_eq!(guard.dropped_words(), 0);
    }

    #[test]
    fn all_notes_off_stops_the_sounding_keys_of_its_channel_at_its_offset() {
        let mut guard = NoteGuard::new();
        run(&mut guard, &[on(0, 0, 60), on(0, 0, 64), on(0, 3, 40)]);
        let out = run(&mut guard, &[on(10, 0, 70), all_off(20, 0), off(30, 0, 70)]);
        assert_eq!(
            out,
            [
                note_on(10, 0, 70),
                note_off(20, 0, 60),
                note_off(20, 0, 64),
                note_off(20, 0, 70),
            ],
            "the NoteOff after it is dropped: the key is already off"
        );
        assert_eq!(guard.sounding_count(), 1, "channel 3 goes on sounding");
        assert_eq!(guard.pending_count(), 0);
        // An AllNotesOff with nothing sounding emits nothing.
        assert_eq!(run(&mut guard, &[all_off(0, 0)]), []);
    }

    #[test]
    fn a_retrigger_ends_the_old_voice_first() {
        let mut guard = NoteGuard::new();
        run(&mut guard, &[on(0, 0, 60)]);
        let out = run(&mut guard, &[on(40, 0, 60)]);
        assert_eq!(out, [note_off(40, 0, 60), note_on(40, 0, 60)]);
        assert_eq!(guard.sounding_count(), 1);
        // One NoteOff ends it: the plug-in holds one voice for the key, and the guard is empty after it.
        assert_eq!(run(&mut guard, &[off(50, 0, 60)]), [note_off(50, 0, 60)]);
        assert_eq!(run(&mut guard, &[off(51, 0, 60)]), []);
        // Twice in one block.
        let twice = run(&mut guard, &[on(1, 0, 61), on(2, 0, 61)]);
        assert_eq!(
            twice,
            [note_on(1, 0, 61), note_off(2, 0, 61), note_on(2, 0, 61)]
        );
        assert_eq!(guard.sounding_count(), 1);
    }

    #[test]
    fn a_waiting_release_goes_before_a_note_on_for_the_same_key() {
        let mut guard = NoteGuard::new();
        run(&mut guard, &[on(0, 0, 60)]);
        guard.release_all();
        assert_eq!((guard.sounding_count(), guard.pending_count()), (0, 1));
        let out = run(&mut guard, &[on(30, 0, 60)]);
        assert_eq!(
            out,
            [note_off(0, 0, 60), note_on(30, 0, 60)],
            "the release goes first, and the NoteOn is not a retrigger of it"
        );
        assert_eq!((guard.sounding_count(), guard.pending_count()), (1, 0));
    }

    #[test]
    fn a_note_on_for_a_key_whose_release_is_held_back_ends_the_old_voice_first() {
        let mut guard = NoteGuard::new();
        // 300 keys sounding: more than one block's release budget.
        let words: Vec<u64> = (0..300usize)
            .map(|i| on(0, (i / 128) as u8, (i % 128) as u8))
            .collect();
        for chunk in words.chunks(EVENTS_PER_BLOCK) {
            run(&mut guard, chunk);
        }
        guard.release_all();
        // Channel 2, key 40 is the last to be released, so its NoteOff is still waiting after this block's 256.
        let out = run(&mut guard, &[on(30, 2, 40)]);
        let stops_for_it = out
            .iter()
            .filter(|event| **event == note_off(0, 2, 40) || **event == note_off(30, 2, 40))
            .count();
        assert_eq!(stops_for_it, 1, "one NoteOff before the NoteOn, not two");
        assert_eq!(out.last(), Some(&note_on(30, 2, 40)));
        assert_eq!(out.len(), RELEASE_PER_BLOCK + 2);
        assert_eq!(guard.sounding_count(), 1);
        // The rest of the release goes out next block; the new note is not touched by it.
        let rest = run(&mut guard, &[]);
        assert_eq!(rest.len(), 300 - RELEASE_PER_BLOCK - 1);
        assert!(!rest.contains(&note_off(0, 2, 40)));
        assert_eq!((guard.sounding_count(), guard.pending_count()), (1, 0));
    }

    #[test]
    fn release_all_sends_a_note_off_for_every_sounding_key_at_offset_zero() {
        let mut guard = NoteGuard::new();
        run(&mut guard, &[on(0, 0, 60), on(0, 5, 61), on(0, 15, 127)]);
        guard.release_all();
        assert_eq!((guard.sounding_count(), guard.pending_count()), (0, 3));
        let out = run(&mut guard, &[on(9, 1, 1)]);
        assert_eq!(
            out,
            [
                note_off(0, 0, 60),
                note_off(0, 5, 61),
                note_off(0, 15, 127),
                note_on(9, 1, 1),
            ],
            "the releases come before what the block carries"
        );
        assert_eq!(guard.pending_count(), 0);
        // And never again.
        assert_eq!(run(&mut guard, &[]), []);
    }

    #[test]
    fn a_note_off_that_arrives_while_its_release_waits_is_dropped() {
        let mut guard = NoteGuard::new();
        run(&mut guard, &[on(0, 0, 60)]);
        guard.release_all();
        // The key is no longer sounding as far as the guard goes: the NoteOff the release owes is the only one.
        let out = run(&mut guard, &[off(5, 0, 60)]);
        assert_eq!(out, [note_off(0, 0, 60)]);
    }

    #[test]
    fn release_all_with_nothing_sounding_does_nothing() {
        let mut guard = NoteGuard::new();
        guard.release_all();
        guard.release_all();
        assert_eq!(run(&mut guard, &[]), []);
    }

    #[test]
    fn the_worst_case_of_every_channel_and_key_is_released_in_bounded_blocks() {
        let mut guard = NoteGuard::new();
        // Start all 2,048 notes, 64 words a block.
        let all: Vec<u64> = (0..16u8)
            .flat_map(|channel| (0..128u8).map(move |key| on(0, channel, key)))
            .collect();
        for chunk in all.chunks(EVENTS_PER_BLOCK) {
            assert_eq!(run(&mut guard, chunk).len(), chunk.len());
        }
        assert_eq!(guard.sounding_count(), 2048);
        guard.release_all();
        assert_eq!((guard.sounding_count(), guard.pending_count()), (0, 2048));

        // The plug-in's list holds 1,024; a block with a release and a full set of incoming words stays under it.
        const PLUG_IN_EVENT_CAP: usize = 1024;
        let mut seen = std::collections::HashSet::new();
        let mut blocks = 0;
        let mut worst = 0;
        while guard.pending_count() > 0 {
            // Each block also carries 64 notes on the same keys it is releasing, so the retrigger rule is in play too.
            let incoming: Vec<u64> = (0..EVENTS_PER_BLOCK as u8)
                .map(|i| off(1 + i % 100, 7, i))
                .collect();
            let out = run(&mut guard, &incoming);
            worst = worst.max(out.len());
            assert!(out.len() <= PLUG_IN_EVENT_CAP);
            for event in &out {
                let MidiEvent::NoteOff {
                    offset,
                    channel,
                    key,
                } = *event
                else {
                    panic!("only NoteOffs: {event:?}");
                };
                assert_eq!(offset, 0);
                assert!(
                    seen.insert((channel, key)),
                    "a NoteOff twice for {channel}/{key}"
                );
            }
            blocks += 1;
            assert!(blocks <= 8, "2,048 keys take eight blocks of 256");
        }
        assert_eq!(seen.len(), 2048, "every started key was stopped once");
        assert_eq!(blocks, 8);
        assert!(worst <= RELEASE_PER_BLOCK);
        assert_eq!(guard.sounding_count(), 0);
    }

    #[test]
    fn a_full_block_with_a_full_release_and_retriggers_stays_within_the_bound() {
        let mut guard = NoteGuard::new();
        let all: Vec<u64> = (0..16u8)
            .flat_map(|channel| (0..128u8).map(move |key| on(0, channel, key)))
            .collect();
        for chunk in all.chunks(EVENTS_PER_BLOCK) {
            run(&mut guard, chunk);
        }
        guard.release_all();
        // 64 NoteOns for keys whose releases wait, each a retrigger of a waiting release, and then an AllNotesOff.
        let mut words: Vec<u64> = (0..EVENTS_PER_BLOCK as u8 - 1)
            .map(|i| on(i, 0, i))
            .collect();
        words.push(all_off(120, 1));
        let out = run(&mut guard, &words);
        assert!(out.len() <= MAX_BLOCK_EVENTS);
        assert!(MAX_BLOCK_EVENTS <= 1024, "below the plug-in's event list");
        // Offsets never go backwards, so the plug-in's list is in order.
        for pair in out.windows(2) {
            assert!(pair[0].offset() <= pair[1].offset(), "{pair:?}");
        }
        // Finish: nothing is left sounding and nothing was stopped twice.
        guard.release_all();
        let mut stops = std::collections::HashMap::new();
        for event in &out {
            if let MidiEvent::NoteOff { channel, key, .. } = *event {
                *stops.entry((channel, key)).or_insert(0u32) += 1;
            }
        }
        for _ in 0..20 {
            for event in run(&mut guard, &[]) {
                if let MidiEvent::NoteOff { channel, key, .. } = event {
                    *stops.entry((channel, key)).or_insert(0u32) += 1;
                }
            }
        }
        assert_eq!(guard.pending_count(), 0);
        // The 63 retriggered keys of channel 0 were stopped for the retrigger, started again and stopped again.
        for channel in 0..16u8 {
            for key in 0..128u8 {
                let expected = if channel == 0 && key < EVENTS_PER_BLOCK as u8 - 1 {
                    2
                } else {
                    1
                };
                assert_eq!(
                    stops.get(&(channel, key)).copied().unwrap_or(0),
                    expected,
                    "{channel}/{key}"
                );
            }
        }
    }

    #[test]
    fn the_block_path_does_not_allocate() {
        let mut guard = NoteGuard::new();
        let words: Vec<u64> = (0..EVENTS_PER_BLOCK as u8)
            .map(|i| match i % 4 {
                0 => on(127 - i, 0, i),
                1 => off(i, 0, i - 1),
                2 => controller(i),
                _ => all_off(i, 1),
            })
            .collect();
        let mut sink = [PAD; MAX_BLOCK_EVENTS];
        let operations = crate::test_alloc::heap_operations(|| {
            for round in 0..200 {
                let mut n = 0;
                guard.admit(&words, &mut |event| {
                    sink[n % MAX_BLOCK_EVENTS] = event;
                    n += 1;
                });
                if round % 7 == 0 {
                    guard.release_all();
                }
            }
        });
        assert_eq!(operations, 0, "admitting events allocated");
    }
}
