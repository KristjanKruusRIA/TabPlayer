//! Where a plan's notes become a hosted instrument's notes (THE-218).
//!
//! Every note that reaches an instrument plug-in passes through [`NoteMap::note`], and the renderer's plan MIDI dispatch
//! is its one caller. The map takes the whole plan event, not a key and a velocity: a drum track's map (THE-219) reads
//! the key and the articulation id the event names, and sends the key the track's map gives that sound.
//!
//! A NoteOn and its NoteOff name the same key and articulation id, so the same map gives them the same key. A sound the
//! map leaves silent sends nothing at all, neither the NoteOn nor its NoteOff. The held-note bookkeeping of the insert is
//! by the key actually sent, so a release never maps again.
//!
//! Only `NoteOn` and `NoteOff` become notes. Program changes, controllers 7, 10 and 11 and bends are not forwarded in this
//! version: a hosted instrument is played by its own state and its own mixer, not by the score's channel settings.
//!
//! The map is plain data, built where the mix is prepared (off the audio thread) and held by the mix's channel, so a
//! change of map is a mix change like a change of plug-in, with no renderer rebuilt. The audio thread only reads it:
//! [`NoteMap::note`] does not allocate, lock or wait.
use super::drum_map::DrumMap;
use super::plan::PlanMidiEvent;

/// One note for an instrument plug-in, as `PluginInsert::stage_note` takes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstrumentNote {
    pub on: bool,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
}

/// What a plan's notes become for one hosted instrument: the plan's channel and velocity, and the key the track's drum
/// map gives the note. Not `Copy`, so that the 256-byte table is borrowed and never copied per event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteMap {
    /// `None` sends the plan's key as it is, which is what a track with no drum map, or one that equals General MIDI, gets.
    drum: Option<DrumMap>,
}

impl Default for NoteMap {
    fn default() -> NoteMap {
        NoteMap::identity()
    }
}

impl NoteMap {
    /// The map that sends every note as the plan has it.
    pub fn identity() -> NoteMap {
        NoteMap { drum: None }
    }

    /// The map for a track whose resolved drum map is `drum`. General MIDI is the identity: the plan's key as it is.
    pub fn with_drum_map(drum: DrumMap) -> NoteMap {
        NoteMap {
            drum: (drum != DrumMap::IDENTITY).then_some(drum),
        }
    }

    /// The key the plan's note sounds: `None` when the drum map leaves its articulation silent.
    #[inline]
    fn sent_key(&self, key: u8, id: Option<u8>) -> Option<u8> {
        match &self.drum {
            Some(drum) => drum.key(key, id),
            None => Some(key),
        }
    }

    /// The note `event` is for the instrument, or `None` for anything that is not a `NoteOn` or `NoteOff`.
    ///
    /// A NoteOff carries velocity 0: the instrument's release velocity is not used. A NoteOn with velocity 0 stays as the
    /// plan has it; the insert reads it as a NoteOff, as MIDI does. A note whose articulation the drum map leaves silent is
    /// `None`, like an event that is not a note. Does not allocate.
    pub fn note(&self, event: &PlanMidiEvent) -> Option<InstrumentNote> {
        match event {
            PlanMidiEvent::NoteOn {
                channel,
                key,
                velocity,
                articulation_id,
                ..
            } => Some(InstrumentNote {
                on: true,
                channel: *channel,
                key: self.sent_key(*key, *articulation_id)?,
                velocity: *velocity,
            }),
            PlanMidiEvent::NoteOff {
                channel,
                key,
                articulation_id,
                ..
            } => Some(InstrumentNote {
                on: false,
                channel: *channel,
                key: self.sent_key(*key, *articulation_id)?,
                velocity: 0,
            }),
            PlanMidiEvent::Program { .. }
            | PlanMidiEvent::Controller { .. }
            | PlanMidiEvent::Bend { .. }
            | PlanMidiEvent::NoteBend { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(json: serde_json::Value) -> PlanMidiEvent {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn the_identity_map_passes_note_ons_and_note_offs_and_nothing_else() {
        let map = NoteMap::identity();
        let on = event(
            serde_json::json!({"type":"noteOn","trackId":"d","tick":0,"channel":9,"key":38,"velocity":97}),
        );
        let off = event(
            serde_json::json!({"type":"noteOff","trackId":"d","tick":9,"channel":9,"key":38,"velocity":64}),
        );
        assert_eq!(
            map.note(&on),
            Some(InstrumentNote {
                on: true,
                channel: 9,
                key: 38,
                velocity: 97
            })
        );
        assert_eq!(
            map.note(&off),
            Some(InstrumentNote {
                on: false,
                channel: 9,
                key: 38,
                velocity: 0
            })
        );
        for other in [
            serde_json::json!({"type":"program","trackId":"d","tick":0,"channel":0,"program":3}),
            serde_json::json!({"type":"controller","trackId":"d","tick":0,"channel":0,"controller":7,"value":9}),
            serde_json::json!({"type":"bend","trackId":"d","tick":0,"channel":0,"value":1.0}),
            serde_json::json!({"type":"noteBend","trackId":"d","tick":0,"channel":0,"key":3,"value":1.0}),
        ] {
            assert_eq!(map.note(&event(other)), None);
        }
    }
}
