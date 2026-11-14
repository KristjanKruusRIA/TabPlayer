//! The practice key shift: a copy of the plan with every melodic sounding key moved by whole semitones.
//!
//! This runs on the control thread only, when a renderer is built. The audio thread never sees a plan, only the
//! finished renderer, so nothing here may be called from a callback.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
};

use super::plan::{PlanMidiEvent, PlaybackPlan};

/// The channel that carries percussion in both synthesizers. On a melodic track an attack there is a golpe knock only
/// where no plan note owns it; a plan note on that channel plays pitched, like a note on any other channel.
const PERCUSSION_CHANNEL: u8 = 9;

/// One struck note as the events of the plan state it: its `noteOn`, the `noteOff` that ends it, and the plan note that
/// owns the attack, paired the way the renderer pairs them.
struct Struck {
    on: usize,
    off: Option<usize>,
    note: Option<usize>,
    moved: bool,
}

/// `(track, channel, key)` of a note event.
fn note_event(event: &PlanMidiEvent) -> Option<(&str, u8, u8)> {
    match event {
        PlanMidiEvent::NoteOn {
            track_id,
            channel,
            key,
            ..
        }
        | PlanMidiEvent::NoteOff {
            track_id,
            channel,
            key,
            ..
        }
        | PlanMidiEvent::NoteBend {
            track_id,
            channel,
            key,
            ..
        } => Some((track_id, *channel, *key)),
        _ => None,
    }
}

/// `plan` with its melodic keys moved by `semitones`; the same `Arc` for 0.
///
/// Percussion tracks never move, and neither does a golpe knock (a channel-9 attack on a melodic track that no plan
/// note owns). Every plan note of a melodic track moves, on whatever channel. Keys clamp to 0..=127 through one
/// function, so a note still pairs with its `noteOn`; where two notes that overlap land on one clamped key, the earlier
/// ends where the later starts (and is dropped when they start together), so the first `noteOff` cannot end the second.
pub fn transposed_plan(plan: &Arc<PlaybackPlan>, semitones: i8) -> Arc<PlaybackPlan> {
    if semitones == 0 {
        return Arc::clone(plan);
    }
    let percussion: HashSet<&str> = plan
        .tracks
        .iter()
        .filter(|track| track.percussion)
        .map(|track| track.id.as_str())
        .collect();
    let melodic = |track: &str| !percussion.contains(track);
    let pitched_on_nine: HashSet<(&str, u8)> = plan
        .notes
        .iter()
        .filter(|note| melodic(&note.track_id) && note.channel == Some(PERCUSSION_CHANNEL))
        .map(|note| (note.track_id.as_str(), note.key))
        .collect();
    // The renderer's own pairing of a plan note to the `noteOn` that sounds it.
    let mut attacks: HashMap<(&str, u8, u8, u64), VecDeque<usize>> = HashMap::new();
    for (index, note) in plan.notes.iter().enumerate() {
        attacks
            .entry((
                note.track_id.as_str(),
                note.channel.unwrap_or(0),
                note.key,
                note.start_tick.to_bits(),
            ))
            .or_default()
            .push_back(index);
    }
    let orphan_moves = |track: &str, channel: u8, key: u8| {
        melodic(track) && (channel != PERCUSSION_CHANNEL || pitched_on_nine.contains(&(track, key)))
    };
    let mut struck: Vec<Struck> = Vec::new();
    let mut open: HashMap<(&str, u8, u8), VecDeque<usize>> = HashMap::new();
    let mut moved_event = vec![false; plan.midi.len()];
    // The struck note each `noteBend` bends, so a bend goes with its note when the note is cut short or dropped.
    let mut bend_owner: HashMap<usize, usize> = HashMap::new();
    for (index, event) in plan.midi.iter().enumerate() {
        match event {
            PlanMidiEvent::NoteOn {
                track_id,
                tick,
                channel,
                key,
                ..
            } => {
                let note = attacks
                    .get_mut(&(track_id.as_str(), *channel, *key, tick.to_bits()))
                    .and_then(VecDeque::pop_front);
                let moved = melodic(track_id) && (*channel != PERCUSSION_CHANNEL || note.is_some());
                moved_event[index] = moved;
                open.entry((track_id.as_str(), *channel, *key))
                    .or_default()
                    .push_back(struck.len());
                struck.push(Struck {
                    on: index,
                    off: None,
                    note,
                    moved,
                });
            }
            PlanMidiEvent::NoteOff {
                track_id,
                channel,
                key,
                ..
            } => {
                let owner = open
                    .get_mut(&(track_id.as_str(), *channel, *key))
                    .and_then(VecDeque::pop_front);
                moved_event[index] = match owner {
                    Some(owner) => {
                        struck[owner].off = Some(index);
                        struck[owner].moved
                    }
                    None => orphan_moves(track_id, *channel, *key),
                };
            }
            PlanMidiEvent::NoteBend {
                track_id,
                channel,
                key,
                ..
            } => {
                moved_event[index] = match open
                    .get(&(track_id.as_str(), *channel, *key))
                    .and_then(VecDeque::front)
                {
                    Some(owner) => {
                        bend_owner.insert(index, *owner);
                        struck[*owner].moved
                    }
                    None => orphan_moves(track_id, *channel, *key),
                };
            }
            _ => {}
        }
    }

    let mut shifted = (**plan).clone();
    for note in &mut shifted.notes {
        if melodic(&note.track_id) {
            note.key = shift_key(note.key, semitones);
        }
    }
    for (index, event) in shifted.midi.iter_mut().enumerate() {
        if !moved_event[index] {
            continue;
        }
        if let PlanMidiEvent::NoteOn { key, .. }
        | PlanMidiEvent::NoteOff { key, .. }
        | PlanMidiEvent::NoteBend { key, .. } = event
        {
            *key = shift_key(*key, semitones);
        }
    }

    // Notes that overlap on one key only because of the clamp: the earlier ends where the later starts.
    let tick_of = |index: usize| plan.midi[index].tick();
    let mut groups: HashMap<(&str, u8, u8), Vec<usize>> = HashMap::new();
    for (index, pair) in struck.iter().enumerate() {
        if let (true, Some((track, channel, key))) =
            (pair.moved, note_event(&shifted.midi[pair.on]))
        {
            groups.entry((track, channel, key)).or_default().push(index);
        }
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by_key(|group| group[0]);
    let mut end: Vec<f64> = struck
        .iter()
        .map(|pair| pair.off.map_or(f64::INFINITY, tick_of))
        .collect();
    let mut dropped = vec![false; struck.len()];
    let mut before_on: HashMap<usize, Vec<usize>> = HashMap::new();
    for group in &groups {
        let mut current: Option<usize> = None;
        for &next in group {
            if let Some(held) = current {
                let starts = tick_of(struck[next].on);
                let differs = note_event(&plan.midi[struck[held].on]).map(|(_, _, key)| key)
                    != note_event(&plan.midi[struck[next].on]).map(|(_, _, key)| key);
                if differs && starts < end[held] {
                    if starts <= tick_of(struck[held].on) {
                        dropped[held] = true;
                    } else {
                        end[held] = starts;
                        before_on.entry(struck[next].on).or_default().push(held);
                    }
                }
            }
            current = Some(next);
        }
    }
    if dropped.iter().any(|d| *d) || !before_on.is_empty() {
        let mut gone: HashSet<usize> = HashSet::new();
        let mut gone_notes: HashSet<usize> = HashSet::new();
        let shortened_pairs: HashSet<usize> = before_on.values().flatten().copied().collect();
        for (index, pair) in struck.iter().enumerate() {
            let shortened = shortened_pairs.contains(&index);
            if dropped[index] {
                gone.extend(
                    bend_owner
                        .iter()
                        .filter(|&(_, &owner)| owner == index)
                        .map(|(&bend, _)| bend),
                );
                gone.insert(pair.on);
                gone_notes.extend(pair.note);
            }
            if dropped[index] || shortened {
                gone.extend(pair.off);
            }
            if shortened {
                gone.extend(
                    bend_owner
                        .iter()
                        .filter(|&(&bend, &owner)| owner == index && tick_of(bend) >= end[index])
                        .map(|(&bend, _)| bend),
                );
                if let Some(note) = pair.note {
                    let note = &mut shifted.notes[note];
                    note.end_tick = note.end_tick.min(end[index]);
                    let limit = note.end_tick;
                    note.pitch.retain(|point| point.tick <= limit);
                }
            }
        }
        let mut midi = Vec::with_capacity(shifted.midi.len());
        for (index, event) in shifted.midi.iter().enumerate() {
            for &held in before_on.get(&index).into_iter().flatten() {
                if let PlanMidiEvent::NoteOn {
                    track_id,
                    channel,
                    key,
                    kit_element,
                    ..
                } = &shifted.midi[struck[held].on]
                {
                    let velocity = struck[held].off.map_or(0, |off| match &shifted.midi[off] {
                        PlanMidiEvent::NoteOff { velocity, .. } => *velocity,
                        _ => 0,
                    });
                    midi.push(PlanMidiEvent::NoteOff {
                        track_id: track_id.clone(),
                        tick: end[held],
                        channel: *channel,
                        key: *key,
                        velocity,
                        kit_element: *kit_element,
                    });
                }
            }
            if !gone.contains(&index) {
                midi.push(event.clone());
            }
        }
        shifted.midi = midi;
        if !gone_notes.is_empty() {
            let removed: HashSet<String> = gone_notes
                .iter()
                .map(|index| shifted.notes[*index].id.clone())
                .collect();
            let mut index = 0;
            shifted.notes.retain(|_| {
                index += 1;
                !gone_notes.contains(&(index - 1))
            });
            for note in &mut shifted.notes {
                if note
                    .legato_from
                    .as_ref()
                    .is_some_and(|id| removed.contains(id))
                {
                    note.legato_from = None;
                }
            }
        }
    }
    Arc::new(shifted)
}

/// The one clamp every note and event key goes through.
fn shift_key(key: u8, semitones: i8) -> u8 {
    (i16::from(key) + i16::from(semitones)).clamp(0, 127) as u8
}
#[cfg(test)]
mod tests {
    use super::*;

    fn plan(notes: serde_json::Value, midi: serde_json::Value) -> Arc<PlaybackPlan> {
        Arc::new(serde_json::from_value(serde_json::json!({
            "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
            "tracks":[{"id":"g","program":25,"percussion":false},{"id":"d","program":0,"percussion":true}],
            "tempos":[{"tick":0,"bpm":120}],
            "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
            "notes":notes,"midi":midi
        })).unwrap())
    }
    fn note(id: &str, track: &str, key: u8, channel: Option<u8>) -> serde_json::Value {
        let mut value = serde_json::json!({"id":id,"trackId":track,"source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"startTick":0,"endTick":480,"key":key,"velocity":100,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}],"kitSound":36});
        if let Some(channel) = channel {
            value["channel"] = channel.into();
        }
        value
    }
    fn keys(plan: &PlaybackPlan) -> Vec<u8> {
        plan.notes.iter().map(|n| n.key).collect()
    }
    fn event_keys(plan: &PlaybackPlan) -> Vec<Option<u8>> {
        plan.midi
            .iter()
            .map(|event| match event {
                PlanMidiEvent::NoteOn { key, .. }
                | PlanMidiEvent::NoteOff { key, .. }
                | PlanMidiEvent::NoteBend { key, .. } => Some(*key),
                _ => None,
            })
            .collect()
    }
    fn on(track: &str, channel: u8, key: u8) -> serde_json::Value {
        serde_json::json!({"type":"noteOn","trackId":track,"tick":0,"channel":channel,"key":key,"velocity":100})
    }
    fn off(track: &str, channel: u8, key: u8) -> serde_json::Value {
        serde_json::json!({"type":"noteOff","trackId":track,"tick":480,"channel":channel,"key":key,"velocity":0})
    }
    fn bend(track: &str, channel: u8, key: u8) -> serde_json::Value {
        serde_json::json!({"type":"noteBend","trackId":track,"tick":10,"channel":channel,"key":key,"value":0.5})
    }

    #[test]
    fn a_shift_of_zero_is_the_same_plan() {
        let original = plan(
            serde_json::json!([note("a", "g", 60, None)]),
            serde_json::json!([]),
        );
        assert!(Arc::ptr_eq(&original, &transposed_plan(&original, 0)));
    }

    #[test]
    fn melodic_notes_and_events_move_together() {
        let original = plan(
            serde_json::json!([note("a", "g", 60, None), note("b", "g", 64, Some(3))]),
            serde_json::json!([
                on("g", 0, 60),
                off("g", 0, 60),
                bend("g", 3, 64),
                serde_json::json!({"type":"bend","trackId":"g","tick":5,"channel":0,"value":0.1})
            ]),
        );
        let up = transposed_plan(&original, 5);
        assert_eq!(keys(&up), vec![65, 69]);
        assert_eq!(event_keys(&up), vec![Some(65), Some(65), Some(69), None]);
        let down = transposed_plan(&original, -12);
        assert_eq!(keys(&down), vec![48, 52]);
        assert_eq!(
            keys(&original),
            vec![60, 64],
            "the original plan is untouched"
        );
    }

    fn note_at(
        id: &str,
        track: &str,
        key: u8,
        channel: Option<u8>,
        start: f64,
        end: f64,
    ) -> serde_json::Value {
        let mut value = note(id, track, key, channel);
        value["startTick"] = start.into();
        value["endTick"] = end.into();
        value["pitch"] = serde_json::json!([{"tick":start,"semitones":0}]);
        value
    }
    fn on_at(track: &str, channel: u8, key: u8, tick: f64) -> serde_json::Value {
        serde_json::json!({"type":"noteOn","trackId":track,"tick":tick,"channel":channel,"key":key,"velocity":100})
    }
    fn off_at(track: &str, channel: u8, key: u8, tick: f64) -> serde_json::Value {
        serde_json::json!({"type":"noteOff","trackId":track,"tick":tick,"channel":channel,"key":key,"velocity":0})
    }
    /// (kind, tick, key) of every note event, in order.
    fn sequence(plan: &PlaybackPlan) -> Vec<(&'static str, f64, u8)> {
        plan.midi
            .iter()
            .filter_map(|event| match event {
                PlanMidiEvent::NoteOn { tick, key, .. } => Some(("on", *tick, *key)),
                PlanMidiEvent::NoteOff { tick, key, .. } => Some(("off", *tick, *key)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn percussion_tracks_and_knocks_never_move_but_pitched_notes_on_channel_nine_do() {
        // "pitched" is a plan note of the guitar on channel 9, which plays pitched like any other channel; the knock
        // at key 80 has no plan note and is the percussion-bank hit the renderer takes it for.
        let original = plan(
            serde_json::json!([
                note_at("drum", "d", 38, Some(9), 0.0, 480.0),
                note_at("drum-no-channel", "d", 42, None, 0.0, 480.0),
                note_at("pitched", "g", 70, Some(9), 0.0, 480.0),
                note_at("melody", "g", 60, None, 0.0, 480.0),
            ]),
            serde_json::json!([
                on("d", 9, 38),
                on("g", 9, 70),
                on("g", 9, 80),
                on("d", 0, 42),
                on("g", 0, 60),
                bend("g", 9, 70),
                off("d", 9, 38),
                off("g", 9, 70),
                off("g", 9, 80)
            ]),
        );
        let shifted = transposed_plan(&original, 7);
        assert_eq!(keys(&shifted), vec![38, 42, 77, 67]);
        assert_eq!(
            event_keys(&shifted),
            vec![
                Some(38),
                Some(77),
                Some(80),
                Some(42),
                Some(67),
                Some(77),
                Some(38),
                Some(77),
                Some(80)
            ]
        );
        assert_eq!(
            shifted.notes[0].kit_sound,
            Some(36),
            "kit sounds are untouched"
        );
    }

    #[test]
    fn keys_clamp_and_still_pair_after_clamping() {
        // Sequential notes: 125 then 127 both clamp to 127 at +12; 3 then 0 both clamp to 0 at -12.
        let original = plan(
            serde_json::json!([
                note_at("a", "g", 125, None, 0.0, 480.0),
                note_at("b", "g", 127, None, 480.0, 960.0),
                note_at("c", "g", 3, None, 960.0, 1440.0),
                note_at("d", "g", 0, None, 1440.0, 1920.0)
            ]),
            serde_json::json!([
                on_at("g", 0, 125, 0.0),
                off_at("g", 0, 125, 480.0),
                on_at("g", 0, 127, 480.0),
                bend("g", 0, 127),
                off_at("g", 0, 127, 960.0),
                on_at("g", 0, 3, 960.0),
                off_at("g", 0, 3, 1440.0),
                on_at("g", 0, 0, 1440.0),
                off_at("g", 0, 0, 1920.0)
            ]),
        );
        let up = transposed_plan(&original, 12);
        assert_eq!(keys(&up)[..2], [127, 127]);
        assert_eq!(event_keys(&up)[..5], [Some(127); 5]);
        let down = transposed_plan(&original, -12);
        assert_eq!(keys(&down)[2..], [0, 0]);
        assert_eq!(event_keys(&down)[5..], [Some(0); 4]);
        // Every note still has a noteOn at the same (track, channel, key, tick) the renderer looks it up by.
        for shifted in [&up, &down] {
            for note in &shifted.notes {
                assert!(shifted.midi.iter().any(|event| matches!(event,
                        PlanMidiEvent::NoteOn { track_id, channel, key, tick, .. }
                            if *track_id == note.track_id && *channel == note.channel.unwrap_or(0) && *key == note.key && *tick == note.start_tick)));
            }
        }
    }

    #[test]
    fn notes_that_overlap_on_one_clamped_key_do_not_release_each_other() {
        // 125 sounds 0 to 960 and 127 from 480 to 1440; at +12 both are 127, and the first note-off would end the second.
        // The earlier is shortened to where the later starts, so the later holds to its own end. Likewise 3 and 0 at -12.
        for (low, high, shift, key) in [(125u8, 127u8, 12i8, 127u8), (3, 0, -12, 0)] {
            let original = plan(
                serde_json::json!([
                    note_at("a", "g", low, None, 0.0, 960.0),
                    note_at("b", "g", high, None, 480.0, 1440.0)
                ]),
                serde_json::json!([
                    on_at("g", 0, low, 0.0),
                    on_at("g", 0, high, 480.0),
                    off_at("g", 0, low, 960.0),
                    off_at("g", 0, high, 1440.0)
                ]),
            );
            let shifted = transposed_plan(&original, shift);
            assert_eq!(
                sequence(&shifted),
                vec![
                    ("on", 0.0, key),
                    ("off", 480.0, key),
                    ("on", 480.0, key),
                    ("off", 1440.0, key)
                ],
                "shift {shift}"
            );
            assert_eq!(shifted.notes[0].end_tick, 480.0);
            assert_eq!(shifted.notes[1].end_tick, 1440.0);
            assert_eq!(keys(&shifted), vec![key, key]);
            // The plan is still one the renderer accepts.
            shifted.validate().unwrap();
        }
    }

    #[test]
    fn notes_that_start_together_on_one_clamped_key_keep_one_and_stay_valid() {
        let original = plan(
            serde_json::json!([
                note_at("a", "g", 125, None, 0.0, 480.0),
                note_at("b", "g", 127, None, 0.0, 960.0)
            ]),
            serde_json::json!([
                on_at("g", 0, 125, 0.0),
                on_at("g", 0, 127, 0.0),
                off_at("g", 0, 125, 480.0),
                off_at("g", 0, 127, 960.0)
            ]),
        );
        let shifted = transposed_plan(&original, 12);
        assert_eq!(
            sequence(&shifted),
            vec![("on", 0.0, 127), ("off", 960.0, 127)]
        );
        assert_eq!(shifted.notes.len(), 1);
        assert_eq!(shifted.notes[0].id, "b");
        shifted.validate().unwrap();
    }

    #[test]
    fn bends_of_a_shortened_note_after_the_cut_go_with_it_and_do_not_bend_the_later_note() {
        let bend_at = |key: u8, tick: f64| serde_json::json!({"type":"noteBend","trackId":"g","tick":tick,"channel":0,"key":key,"value":0.5});
        // 125 sounds 0 to 960 and bends at 300 (before the cut at 480) and at 700 (after it); 127 starts at 480 and
        // bends at 800. At +12 both are key 127: the bend at 700 belonged to the earlier note and must not bend the later.
        let original = plan(
            serde_json::json!([
                note_at("a", "g", 125, None, 0.0, 960.0),
                note_at("b", "g", 127, None, 480.0, 1440.0)
            ]),
            serde_json::json!([
                on_at("g", 0, 125, 0.0),
                bend_at(125, 300.0),
                on_at("g", 0, 127, 480.0),
                bend_at(125, 700.0),
                bend_at(127, 800.0),
                off_at("g", 0, 125, 960.0),
                off_at("g", 0, 127, 1440.0)
            ]),
        );
        let shifted = transposed_plan(&original, 12);
        let bends: Vec<f64> = shifted
            .midi
            .iter()
            .filter_map(|event| match event {
                PlanMidiEvent::NoteBend { tick, .. } => Some(*tick),
                _ => None,
            })
            .collect();
        assert_eq!(bends, vec![300.0, 800.0]);
        shifted.validate().unwrap();
    }

    #[test]
    fn a_shortened_note_keeps_its_pitch_curve_inside_its_new_end() {
        let mut first = note_at("a", "g", 125, None, 0.0, 960.0);
        first["pitch"] = serde_json::json!([{"tick":0,"semitones":0},{"tick":700,"semitones":1}]);
        let original = plan(
            serde_json::json!([first, note_at("b", "g", 127, None, 480.0, 1440.0)]),
            serde_json::json!([
                on_at("g", 0, 125, 0.0),
                on_at("g", 0, 127, 480.0),
                off_at("g", 0, 125, 960.0),
                off_at("g", 0, 127, 1440.0)
            ]),
        );
        let shifted = transposed_plan(&original, 12);
        assert_eq!(shifted.notes[0].pitch.len(), 1);
        shifted.validate().unwrap();
    }

    #[test]
    fn everything_but_keys_is_untouched() {
        let original = plan(
            serde_json::json!([note("a", "g", 60, None)]),
            serde_json::json!([
                on("g", 0, 60),
                serde_json::json!({"type":"program","trackId":"g","tick":0,"channel":0,"program":25}),
                serde_json::json!({"type":"controller","trackId":"g","tick":0,"channel":0,"controller":7,"value":90})
            ]),
        );
        let shifted = transposed_plan(&original, 3);
        let mut expected = (*original).clone();
        expected.notes[0].key = 63;
        if let PlanMidiEvent::NoteOn { key, .. } = &mut expected.midi[0] {
            *key = 63;
        }
        assert_eq!(*shifted, expected);
    }

    #[test]
    fn a_shift_out_of_range_is_refused_by_validate() {
        let mut settings = super::super::practice::PracticeSettings::default();
        for value in [-13, 13, i8::MIN, i8::MAX] {
            settings.tonality = value;
            assert!(settings.validate(None).is_err(), "{value}");
        }
        for value in [-12, 0, 12] {
            settings.tonality = value;
            assert!(settings.validate(None).is_ok(), "{value}");
        }
    }
}
