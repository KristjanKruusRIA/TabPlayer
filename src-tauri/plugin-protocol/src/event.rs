//! The event word: one note or controller event for an instrument plug-in, packed in a `u64` that crosses the ring.
//!
//! ```text
//! bits  0..8   offset in frames from the start of the block, below BLOCK_FRAMES (128)
//! bits  8..16  kind: 1 NoteOn, 2 NoteOff, 3 Controller, 4 AllNotesOff
//! bits 16..24  channel, below 16
//! bits 24..32  key (notes) or controller number, below 128; zero for AllNotesOff
//! bits 32..40  NoteOn velocity 1..=127, or controller value below 128; zero for NoteOff and AllNotesOff
//! bits 40..64  zero
//! ```
//!
//! The word comes from an untrusted peer, so [`MidiEvent::decode`] is strict: any field out of range, any unknown kind and
//! any bit that the kind does not use makes the whole word invalid (`None`), and it never panics. A field a kind ignores
//! must be zero (NoteOff has no release velocity, AllNotesOff has no key or value), so each event has exactly one
//! encoding and `decode` followed by `encode` returns the same word.
//!
//! What the sender (the app side, a later slice) must honour:
//! - `AllNotesOff` is per channel. "Everything off" is not an event: it is the flush, a new epoch, which makes the helper
//!   release every key it believes sounding.
//! - A NoteOn with velocity 0 is invalid. Convert it to a NoteOff before encoding, and never discard an
//!   [`MidiEvent::encode`] `None` silently: a lost NoteOff leaves a note sounding.
//! - A NoteOff must use the channel of the NoteOn it ends; the helper matches them by channel and key.
//! - `Controller` words decode, but the helper currently drops them.
use crate::limits::BLOCK_FRAMES;

pub const KIND_NOTE_ON: u8 = 1;
pub const KIND_NOTE_OFF: u8 = 2;
pub const KIND_CONTROLLER: u8 = 3;
pub const KIND_ALL_NOTES_OFF: u8 = 4;

/// A validated event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MidiEvent {
    NoteOn {
        offset: u8,
        channel: u8,
        key: u8,
        velocity: u8,
    },
    NoteOff {
        offset: u8,
        channel: u8,
        key: u8,
    },
    Controller {
        offset: u8,
        channel: u8,
        controller: u8,
        value: u8,
    },
    AllNotesOff {
        offset: u8,
        channel: u8,
    },
}

fn pack(offset: u8, kind: u8, channel: u8, key: u8, value: u8) -> u64 {
    u64::from(offset)
        | (u64::from(kind) << 8)
        | (u64::from(channel) << 16)
        | (u64::from(key) << 24)
        | (u64::from(value) << 32)
}

impl MidiEvent {
    /// Frames from the start of the block.
    pub fn offset(&self) -> u8 {
        match *self {
            Self::NoteOn { offset, .. }
            | Self::NoteOff { offset, .. }
            | Self::Controller { offset, .. }
            | Self::AllNotesOff { offset, .. } => offset,
        }
    }

    /// The word for this event, or `None` when a field is out of range (see the module comment). A caller must not treat
    /// `None` as "nothing to send": a NoteOff that fails to encode is a note that never stops. NoteOn with velocity 0 is
    /// out of range: send the NoteOff instead.
    pub fn encode(&self) -> Option<u64> {
        let word = match *self {
            Self::NoteOn {
                offset,
                channel,
                key,
                velocity,
            } => pack(offset, KIND_NOTE_ON, channel, key, velocity),
            Self::NoteOff {
                offset,
                channel,
                key,
            } => pack(offset, KIND_NOTE_OFF, channel, key, 0),
            Self::Controller {
                offset,
                channel,
                controller,
                value,
            } => pack(offset, KIND_CONTROLLER, channel, controller, value),
            Self::AllNotesOff { offset, channel } => {
                pack(offset, KIND_ALL_NOTES_OFF, channel, 0, 0)
            }
        };
        // Reuse the decoder's rules so the two can never disagree.
        Self::decode(word).map(|_| word)
    }

    /// The event a word holds, or `None` for an invalid word.
    pub fn decode(word: u64) -> Option<MidiEvent> {
        if word >> 40 != 0 {
            return None;
        }
        let offset = word as u8;
        let kind = (word >> 8) as u8;
        let channel = (word >> 16) as u8;
        let key = (word >> 24) as u8;
        let value = (word >> 32) as u8;
        if usize::from(offset) >= BLOCK_FRAMES || channel >= 16 || key >= 128 {
            return None;
        }
        match kind {
            KIND_NOTE_ON if (1..=127).contains(&value) => Some(Self::NoteOn {
                offset,
                channel,
                key,
                velocity: value,
            }),
            KIND_NOTE_OFF if value == 0 => Some(Self::NoteOff {
                offset,
                channel,
                key,
            }),
            KIND_CONTROLLER if value < 128 => Some(Self::Controller {
                offset,
                channel,
                controller: key,
                value,
            }),
            KIND_ALL_NOTES_OFF if key == 0 && value == 0 => {
                Some(Self::AllNotesOff { offset, channel })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(offset: u64, kind: u64, channel: u64, key: u64, value: u64, high: u64) -> u64 {
        offset | (kind << 8) | (channel << 16) | (key << 24) | (value << 32) | (high << 40)
    }

    fn valid() -> [MidiEvent; 4] {
        [
            MidiEvent::NoteOn {
                offset: 127,
                channel: 15,
                key: 127,
                velocity: 127,
            },
            MidiEvent::NoteOff {
                offset: 0,
                channel: 0,
                key: 40,
            },
            MidiEvent::Controller {
                offset: 64,
                channel: 3,
                controller: 64,
                value: 127,
            },
            MidiEvent::AllNotesOff {
                offset: 5,
                channel: 9,
            },
        ]
    }

    #[test]
    fn every_kind_round_trips() {
        for event in valid() {
            let encoded = event.encode().expect("a valid event encodes");
            assert_eq!(MidiEvent::decode(encoded), Some(event), "{event:?}");
        }
    }

    #[test]
    fn the_layout_is_the_documented_one() {
        let on = MidiEvent::NoteOn {
            offset: 1,
            channel: 2,
            key: 3,
            velocity: 4,
        };
        assert_eq!(on.encode(), Some(word(1, 1, 2, 3, 4, 0)));
        assert_eq!(
            MidiEvent::decode(word(1, 2, 2, 3, 0, 0)).map(|e| e.offset()),
            Some(1)
        );
        assert_eq!(
            MidiEvent::decode(word(0, 3, 0, 7, 9, 0)),
            Some(MidiEvent::Controller {
                offset: 0,
                channel: 0,
                controller: 7,
                value: 9
            })
        );
        assert_eq!(
            MidiEvent::decode(word(0, 4, 1, 0, 0, 0)),
            Some(MidiEvent::AllNotesOff {
                offset: 0,
                channel: 1
            })
        );
    }

    #[test]
    fn each_invalid_field_is_refused() {
        // A good word of each kind first, so a refusal below is down to the one field changed.
        assert!(MidiEvent::decode(word(0, 1, 0, 60, 100, 0)).is_some());
        assert!(MidiEvent::decode(word(0, 2, 0, 60, 0, 0)).is_some());
        assert!(MidiEvent::decode(word(0, 3, 0, 60, 100, 0)).is_some());
        assert!(MidiEvent::decode(word(0, 4, 0, 0, 0, 0)).is_some());
        for kind in [1, 2, 3, 4] {
            let (key, value) = match kind {
                1 => (60, 100),
                2 => (60, 0),
                3 => (60, 100),
                _ => (0, 0),
            };
            assert_eq!(
                MidiEvent::decode(word(128, kind, 0, key, value, 0)),
                None,
                "offset 128, kind {kind}"
            );
            assert_eq!(
                MidiEvent::decode(word(255, kind, 0, key, value, 0)),
                None,
                "offset 255, kind {kind}"
            );
            assert_eq!(
                MidiEvent::decode(word(0, kind, 16, key, value, 0)),
                None,
                "channel 16, kind {kind}"
            );
            assert_eq!(
                MidiEvent::decode(word(0, kind, 0, key, value, 1)),
                None,
                "bit 40, kind {kind}"
            );
            assert_eq!(
                MidiEvent::decode(word(0, kind, 0, key, value, 0xFF_FFFF)),
                None,
                "high bits, kind {kind}"
            );
        }
        assert_eq!(
            MidiEvent::decode(word(0, 1, 0, 128, 100, 0)),
            None,
            "key 128"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 1, 0, 60, 0, 0)),
            None,
            "NoteOn velocity 0"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 1, 0, 60, 128, 0)),
            None,
            "NoteOn velocity 128"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 2, 0, 128, 0, 0)),
            None,
            "NoteOff key 128"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 2, 0, 60, 1, 0)),
            None,
            "NoteOff velocity must be zero"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 3, 0, 128, 0, 0)),
            None,
            "controller 128"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 3, 0, 7, 128, 0)),
            None,
            "controller value 128"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 4, 0, 1, 0, 0)),
            None,
            "AllNotesOff key must be zero"
        );
        assert_eq!(
            MidiEvent::decode(word(0, 4, 0, 0, 1, 0)),
            None,
            "AllNotesOff value must be zero"
        );
        for kind in [0, 5, 6, 127, 128, 255] {
            assert_eq!(
                MidiEvent::decode(word(0, kind, 0, 0, 0, 0)),
                None,
                "kind {kind}"
            );
        }
        assert_eq!(MidiEvent::decode(u64::MAX), None);
    }

    /// A xorshift64 generator, so the sweep below is the same on every run.
    fn next(state: &mut u64) -> u64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    }

    #[test]
    fn decoding_never_panics_on_any_word() {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..200_000 {
            let word = next(&mut state);
            if let Some(event) = MidiEvent::decode(word) {
                assert_eq!(event.encode(), Some(word));
            }
        }
    }

    #[test]
    fn whatever_decodes_encodes_back_to_the_same_word() {
        // Arbitrary 64-bit words almost never have bits 40..64 clear, so they almost never decode: they only show that
        // nothing panics. Words with each field drawn from a range wider than the valid one reach the round trip.
        let mut state = 0xD1B5_4A32_D192_ED03u64;
        let (mut decoded, mut refused) = (0u32, 0u32);
        let mut kinds = [0u32; 5];
        for _ in 0..200_000 {
            let r = next(&mut state);
            let word = word(
                (r & 0xFF) % 160,
                1 + ((r >> 8) & 0xFF) % 5,
                ((r >> 16) & 0xFF) % 20,
                // Zero too, for AllNotesOff's key.
                if (r >> 62) & 1 == 0 {
                    ((r >> 24) & 0xFF) % 140
                } else {
                    0
                },
                // Zero is common enough to reach NoteOff and AllNotesOff, 128 and over to be refused.
                if (r >> 63) & 1 == 0 {
                    ((r >> 32) & 0xFF) % 140
                } else {
                    0
                },
                0,
            );
            match MidiEvent::decode(word) {
                Some(event) => {
                    decoded += 1;
                    kinds[((word >> 8) & 0xFF) as usize] += 1;
                    assert_eq!(event.encode(), Some(word), "{event:?}");
                    assert_eq!(event.offset() as u64, word & 0xFF);
                }
                None => refused += 1,
            }
        }
        assert!(decoded > 20_000, "only {decoded} words decoded");
        assert!(refused > 20_000, "only {refused} words were refused");
        assert!(
            kinds[1..].iter().all(|&n| n > 1_000),
            "every kind is reached: {kinds:?}"
        );
    }

    #[test]
    fn an_out_of_range_event_does_not_encode() {
        let bad = [
            MidiEvent::NoteOn {
                offset: 128,
                channel: 0,
                key: 60,
                velocity: 100,
            },
            MidiEvent::NoteOn {
                offset: 0,
                channel: 16,
                key: 60,
                velocity: 100,
            },
            MidiEvent::NoteOn {
                offset: 0,
                channel: 0,
                key: 128,
                velocity: 100,
            },
            MidiEvent::NoteOn {
                offset: 0,
                channel: 0,
                key: 60,
                velocity: 0,
            },
            MidiEvent::NoteOff {
                offset: 0,
                channel: 0,
                key: 128,
            },
            MidiEvent::Controller {
                offset: 0,
                channel: 0,
                controller: 128,
                value: 0,
            },
            MidiEvent::Controller {
                offset: 0,
                channel: 0,
                controller: 0,
                value: 128,
            },
            MidiEvent::AllNotesOff {
                offset: 128,
                channel: 0,
            },
        ];
        for event in bad {
            assert_eq!(event.encode(), None, "{event:?}");
        }
    }
}
