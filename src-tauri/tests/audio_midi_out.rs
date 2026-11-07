//! External MIDI output through the output transport: what a routed track sends and when, that nothing on the audio
//! thread touches the heap, that no note is ever left sounding, that the state is stated again after a seek, and that
//! the offline renderer is unaffected.
use serde_json::{Value, json};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
};
use tabplayer_lib::{
    audio::{
        device::{CallbackTransport, PracticeSettings, TransportCommand},
        midi_out::{MidiOutShared, MidiRecord, MidiTap, RouteSpec},
        plan::PlaybackPlan,
        practice::{CountInSettings, MetronomeSettings, PracticeTempo},
        renderer::Renderer,
        resources::AudioResources,
    },
    settings::{DocumentSettings, TrackSound},
};

thread_local! {static COUNT_HEAP:Cell<bool>=const {Cell::new(false)};static HEAP_OPERATIONS:Cell<usize>=const {Cell::new(0)};}
struct CountAllocator;
unsafe impl GlobalAlloc for CountAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|n| n.set(n.get() + 1));
            }
        });
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|n| n.set(n.get() + 1));
            }
        });
        unsafe { System.dealloc(pointer, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: CountAllocator = CountAllocator;

/// Heap operations made by `work` on this thread.
fn counted<T>(work: impl FnOnce() -> T) -> (T, usize) {
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    let result = work();
    COUNT_HEAP.with(|f| f.set(false));
    (result, HEAP_OPERATIONS.with(Cell::get))
}

const RATE: u32 = 48_000;
/// One second is 960 ticks at 60 bpm, so a tick is 50 frames.
const FRAMES_PER_TICK: u64 = 50;
const LEAD: usize = 0;
const BASS: usize = 1;
const DRUMS: usize = 2;

fn event(kind: &str, track: &str, tick: u32, rest: Value) -> Value {
    let mut value = json!({"type": kind, "trackId": track, "tick": tick});
    for (key, item) in rest.as_object().unwrap() {
        value[key] = item.clone();
    }
    value
}
fn on(track: &str, tick: u32, channel: u8, key: u8) -> Value {
    event(
        "noteOn",
        track,
        tick,
        json!({"channel": channel, "key": key, "velocity": 90}),
    )
}
fn off(track: &str, tick: u32, channel: u8, key: u8) -> Value {
    event(
        "noteOff",
        track,
        tick,
        json!({"channel": channel, "key": key, "velocity": 0}),
    )
}
fn cc(track: &str, tick: u32, controller: u8, value: u8) -> Value {
    event(
        "controller",
        track,
        tick,
        json!({"channel": 0, "controller": controller, "value": value}),
    )
}

/// A lead (program 24), a bass and a drum track, 8 s at 60 bpm.
///
/// Lead: key 60 for the first two seconds, key 62 held from the start to tick 7000 (a long note to seek into), a
/// program change, a bend range of 12 semitones, an expression level and a bend of six semitones early on.
/// Bass: key 40 from 1 s to 3 s. Drums: kick (36) at the start and each second. Key 70 on the lead starts at tick
/// 7500 and is never ended by the score.
fn default_events() -> Vec<Value> {
    vec![
        event("program", "lead", 0, json!({"channel": 0, "program": 24})),
        cc("lead", 0, 7, 100),
        on("lead", 0, 0, 60),
        on("lead", 0, 0, 62),
        on("drums", 0, 9, 36),
        off("drums", 120, 9, 36),
        cc("lead", 100, 101, 0),
        cc("lead", 100, 100, 0),
        cc("lead", 100, 6, 12),
        event("program", "lead", 150, json!({"channel": 0, "program": 40})),
        cc("lead", 150, 11, 77),
        event("bend", "lead", 200, json!({"channel": 0, "value": 6.0})),
        on("bass", 960, 0, 40),
        on("drums", 960, 9, 36),
        off("drums", 1080, 9, 36),
        off("lead", 1920, 0, 60),
        on("drums", 1920, 9, 36),
        off("drums", 2040, 9, 36),
        off("bass", 2880, 0, 40),
        off("lead", 7000, 0, 62),
        on("lead", 7500, 0, 70),
    ]
}
fn plan(generation: u64) -> PlaybackPlan {
    plan_with(generation, default_events())
}
fn plan_with(generation: u64, mut midi: Vec<Value>) -> PlaybackPlan {
    midi.sort_by_key(|e| e["tick"].as_u64().unwrap());
    serde_json::from_value(json!({
        "generation": generation, "ppq": 960, "durationTick": 7680, "durationMs": 8000,
        "tracks": [
            {"id": "lead", "program": 24, "percussion": false},
            {"id": "bass", "program": 33, "percussion": false},
            {"id": "drums", "program": 0, "percussion": true}
        ],
        "tempos": [{"tick": 0, "bpm": 60}],
        "occurrences": [
            {"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":4000},
            {"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":4000,"endMs":8000}
        ],
        "notes": [], "midi": midi
    }))
    .unwrap()
}
fn resources() -> Arc<AudioResources> {
    Arc::new(
        AudioResources::load_for_requests(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .unwrap(),
    )
}
/// Settings that play every track on the General MIDI sounds, which the test resources carry.
fn general_midi(mut settings: DocumentSettings) -> DocumentSettings {
    for track in ["lead", "bass", "drums"] {
        settings.sounds.insert(
            track.into(),
            TrackSound {
                voice_id: Some("gm".into()),
                ..TrackSound::default()
            },
        );
    }
    settings
}
fn renderer(generation: u64, settings: DocumentSettings) -> Box<Renderer> {
    renderer_of(plan(generation), settings)
}
fn renderer_of(plan: PlaybackPlan, settings: DocumentSettings) -> Box<Renderer> {
    let settings = general_midi(settings);
    Box::new(Renderer::new(Arc::new(plan), resources(), settings, RATE).unwrap())
}
/// A track whose events are on plan channel 0 plays on `channel`; the drums' are on plan channel 9.
fn spec(slot: u8, channel: u8) -> RouteSpec {
    if channel == 9 {
        RouteSpec::lanes(slot, 0, &[(9, 9)])
    } else {
        RouteSpec::single(slot, channel)
    }
}
fn tap(routes: &[(usize, RouteSpec)]) -> Box<MidiTap> {
    MidiTap::new(&[24, 33, 0], routes)
}
fn practice(speed: f64) -> PracticeSettings {
    PracticeSettings {
        tempo: PracticeTempo::Relative { ratio: speed },
        metronome: MetronomeSettings {
            enabled: false,
            volume: 0.4,
            visual: false,
            sound: Default::default(),
        },
        count_in: CountInSettings {
            bars: 0,
            between_loops: false,
        },
    }
}

/// A transport playing `plan` with `routes`, and the ring its messages go to.
struct Rig {
    transport: CallbackTransport,
    shared: Arc<MidiOutShared>,
    callback: Vec<[f32; 2]>,
    heard: Vec<[f32; 2]>,
}
impl Rig {
    fn new(routes: &[(usize, RouteSpec)]) -> Self {
        Self::with_plan(routes, plan(1))
    }
    fn with_plan(routes: &[(usize, RouteSpec)], plan: PlaybackPlan) -> Self {
        let (mut transport, shared) = CallbackTransport::headless_with_midi(RATE);
        let mut renderer = renderer_of(plan, DocumentSettings::default());
        if !routes.is_empty() {
            renderer.replace_midi(tap(routes));
        }
        transport.install(renderer, 1, false);
        Self {
            transport,
            shared,
            callback: vec![[0.0; 2]; 480],
            heard: Vec::new(),
        }
    }
    fn command(&mut self, command: TransportCommand) {
        self.transport.command(command).unwrap();
    }
    fn play(&mut self) {
        self.command(TransportCommand::Play { generation: 1 });
    }
    /// Renders `seconds` in device callbacks of 480 frames, keeping what was heard.
    fn run(&mut self, seconds: f64) {
        for _ in 0..(seconds * f64::from(RATE) / 480.0).round() as usize {
            self.transport.render_callback(&mut self.callback);
            self.heard.extend_from_slice(&self.callback);
        }
    }
    fn messages(&self) -> Vec<Message> {
        let mut found = Vec::new();
        while let Some(record) = self.shared.ring.pop() {
            if let MidiRecord::Message {
                frame,
                slot,
                generation: _,
                len,
                bytes,
            } = record
            {
                found.push(Message {
                    frame,
                    slot,
                    bytes: bytes[..usize::from(len)].to_vec(),
                });
            }
        }
        found
    }
}
#[derive(Clone, Debug, PartialEq)]
struct Message {
    frame: u64,
    slot: u8,
    bytes: Vec<u8>,
}
fn peak(frames: &[[f32; 2]]) -> f32 {
    frames
        .iter()
        .flat_map(|f| f.iter())
        .fold(0.0, |p, x| p.max(x.abs()))
}

/// Notes a port would still be sounding after `messages`, as a synthesizer plays them: a note-on holds, a note-off
/// ends it unless the sustain pedal is down (then it rings until the pedal comes up), and all notes off or all sound
/// off end what is not held by the pedal; with the pedal down they leave the notes it holds ringing.
fn sounding(messages: &[Message]) -> Vec<(u8, u8, u8)> {
    use std::collections::{BTreeSet, HashSet};
    let mut keys: BTreeSet<(u8, u8, u8)> = BTreeSet::new();
    let mut pedal: HashSet<(u8, u8)> = HashSet::new();
    let mut sustained: BTreeSet<(u8, u8, u8)> = BTreeSet::new();
    for message in messages {
        let status = message.bytes[0] & 0xf0;
        let channel = message.bytes[0] & 15;
        let port = (message.slot, channel);
        let key = (message.slot, channel, message.bytes[1]);
        match status {
            0x90 if message.bytes[2] > 0 => {
                keys.insert(key);
                sustained.remove(&key);
            }
            0x80 | 0x90 => {
                if keys.remove(&key) && pedal.contains(&port) {
                    sustained.insert(key);
                }
            }
            0xb0 if message.bytes[1] == 64 => {
                if message.bytes[2] >= 64 {
                    pedal.insert(port);
                } else {
                    pedal.remove(&port);
                    sustained.retain(|(slot, ch, _)| (*slot, *ch) != port);
                }
            }
            0xb0 if message.bytes[1] == 123 || message.bytes[1] == 120 => {
                if pedal.contains(&port) {
                    // The pedal keeps what is down ringing.
                    let held: Vec<_> = keys
                        .iter()
                        .copied()
                        .filter(|(slot, ch, _)| (*slot, *ch) == port)
                        .collect();
                    sustained.extend(held);
                }
                keys.retain(|(slot, ch, _)| (*slot, *ch) != port);
            }
            _ => {}
        }
    }
    keys.union(&sustained).copied().collect()
}

fn all_routed() -> Vec<(usize, RouteSpec)> {
    vec![(LEAD, spec(0, 0)), (BASS, spec(0, 1)), (DRUMS, spec(0, 9))]
}

#[test]
fn routed_notes_arrive_stamped_with_the_frame_they_play_at_on_their_own_channels() {
    let mut rig = Rig::new(&all_routed());
    rig.play();
    rig.run(3.5);
    let messages = rig.messages();
    let find = |bytes: &[u8]| {
        messages
            .iter()
            .filter(|m| m.bytes == bytes)
            .map(|m| m.frame)
            .collect::<Vec<_>>()
    };
    assert_eq!(find(&[0x90, 60, 90]), vec![0]);
    // The bass note starts at tick 960 (1 s) on channel 1, and ends at tick 2880.
    let bass_on = find(&[0x91, 40, 90]);
    assert!(
        bass_on.len() == 1 && bass_on[0].abs_diff(960 * FRAMES_PER_TICK) <= 1,
        "{bass_on:?}"
    );
    let bass_off = find(&[0x81, 40, 0]);
    assert!(bass_off.len() == 1 && bass_off[0].abs_diff(2880 * FRAMES_PER_TICK) <= 1);
    // Drums are on channel 10 (9 counting from zero), a kick at the start and at each of the next seconds.
    assert_eq!(find(&[0x99, 36, 90]).len(), 3);
    // The lead's key 60 ends at 2 s.
    assert!(find(&[0x80, 60, 0])[0].abs_diff(1920 * FRAMES_PER_TICK) <= 1);
    // Frames never go backwards.
    assert!(messages.windows(2).all(|w| w[0].frame <= w[1].frame));
    assert!(messages.iter().all(|m| m.slot == 0));
}

#[test]
fn practice_speed_moves_the_messages_with_the_rendered_clock() {
    let mut rig = Rig::new(&all_routed());
    rig.command(TransportCommand::SetPractice {
        generation: 1,
        settings: practice(0.5),
    });
    rig.play();
    rig.run(2.5);
    let bass_on = rig
        .messages()
        .into_iter()
        .find(|m| m.bytes == [0x91, 40, 90])
        .unwrap();
    // Half speed: tick 960 is at 2 s.
    assert!(
        bass_on.frame.abs_diff(2 * u64::from(RATE)) <= 1,
        "{}",
        bass_on.frame
    );
}

#[test]
fn a_routed_track_is_silent_on_the_speakers_and_the_others_are_not_touched() {
    let mut open = Rig::new(&[]);
    open.play();
    open.run(0.9);
    assert!(
        peak(&open.heard) > 0.01,
        "the lead sounds when it is not routed"
    );
    let mut routed = Rig::new(&[(LEAD, spec(0, 0)), (DRUMS, spec(0, 9))]);
    routed.play();
    routed.run(0.9);
    assert!(peak(&routed.heard) < 1e-6, "{}", peak(&routed.heard));
    // The bass, unrouted, starts at 1 s and is heard.
    routed.run(1.0);
    assert!(peak(&routed.heard[(0.9 * 48_000.0) as usize..]) > 0.01);
    // Muting a routed track does not bring it back to the speakers.
    let mut muted = Rig::new(&[
        (
            LEAD,
            RouteSpec {
                audible: false,
                ..spec(0, 0)
            },
        ),
        (DRUMS, spec(0, 9)),
    ]);
    muted.play();
    muted.run(0.9);
    assert!(peak(&muted.heard) < 1e-6);
    assert!(
        muted.messages().iter().all(|m| m.bytes[0] & 15 != 0),
        "and the port gets nothing for it"
    );
}

#[test]
fn a_tap_with_no_routes_changes_nothing_bit_for_bit() {
    let render = |renderer: &mut Renderer| {
        let mut out = vec![[0.0f32; 2]; 96_000];
        renderer.render_into(&mut out);
        out
    };
    let mut plain = renderer(1, DocumentSettings::default());
    assert!(plain.midi_tap().is_none());
    let reference = render(&mut plain);
    assert!(peak(&reference) > 0.01);
    let mut empty = renderer(1, DocumentSettings::default());
    empty.replace_midi(tap(&[]));
    let with_empty = render(&mut empty);
    assert!(
        reference
            .iter()
            .zip(&with_empty)
            .all(|(a, b)| a[0].to_bits() == b[0].to_bits() && a[1].to_bits() == b[1].to_bits())
    );
}

/// A pedal held down from the start, a key struck twice while it is down, another key, and a bend: the situation in
/// which a note the tap counted twice used to leave the track unreleasable.
fn pedal_events() -> Vec<Value> {
    vec![
        cc("lead", 0, 64, 127),
        on("lead", 0, 0, 60),
        on("lead", 100, 0, 60),
        on("lead", 200, 0, 64),
        event("bend", "lead", 250, json!({"channel": 0, "value": 1.0})),
        off("lead", 500, 0, 60),
        off("lead", 600, 0, 60),
    ]
}

#[test]
fn a_key_struck_twice_under_the_pedal_is_let_go_however_the_score_stops_or_moves() {
    // Each way out, started while both strikes of key 60 and key 64 are down (0.4 s in, tick 384) or after the
    // note-offs with the pedal still down (0.7 s, tick 672).
    for (name, run_before, ending) in [
        ("stop", 0.4, "stop"),
        ("pause", 0.4, "pause"),
        ("stop after the offs", 0.7, "stop"),
        ("seek", 0.4, "seek"),
        ("loop", 0.4, "loop"),
        ("end", 0.4, "end"),
    ] {
        let mut rig = Rig::with_plan(&[(LEAD, spec(0, 0))], plan_with(1, pedal_events()));
        rig.play();
        if ending == "loop" {
            rig.command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 0.0,
                end_tick: 300.0,
            });
        }
        rig.run(run_before);
        let mut messages = rig.messages();
        let before = sounding(&messages);
        assert!(!before.is_empty(), "{name}: something sounds before");
        match ending {
            "stop" => rig.command(TransportCommand::Stop { generation: 1 }),
            "pause" => rig.command(TransportCommand::Pause { generation: 1 }),
            "seek" => {
                rig.command(TransportCommand::SeekTick {
                    generation: 1,
                    tick: 7000.0,
                });
                rig.command(TransportCommand::Pause { generation: 1 });
            }
            "loop" => {
                rig.run(1.0);
                messages.extend(rig.messages());
                rig.command(TransportCommand::Stop { generation: 1 });
            }
            _ => {
                rig.run(8.0);
                messages.extend(rig.messages());
            }
        }
        rig.run(0.2);
        messages.extend(rig.messages());
        assert_eq!(sounding(&messages), vec![], "{name}");
    }
}

#[test]
fn stopping_leaves_the_synthesizer_in_tune_and_unpedalled() {
    let mut rig = Rig::with_plan(&[(LEAD, spec(0, 0))], plan_with(1, pedal_events()));
    rig.play();
    rig.run(0.4);
    let mut messages = rig.messages();
    // The bend (tick 250) and the pedal (tick 0) have been sent and not taken back.
    assert!(messages.iter().any(|m| m.bytes == [0xe0, 0, 96]));
    assert!(messages.iter().any(|m| m.bytes == [0xb0, 64, 127]));
    rig.command(TransportCommand::Stop { generation: 1 });
    rig.run(0.1);
    messages.extend(rig.messages());
    let last = |bytes: &[u8]| messages.iter().rposition(|m| m.bytes == bytes);
    // After the last of them, the wheel is centred, the pedal is up and the controllers are reset.
    assert!(last(&[0xe0, 0, 64]) > last(&[0xe0, 0, 96]));
    assert!(last(&[0xb0, 64, 0]) > last(&[0xb0, 64, 127]));
    assert!(last(&[0xb0, 121, 0]).is_some());
    // Playing again from the start states the position: nothing of the old bend or pedal is left over.
    rig.play();
    rig.run(0.05);
    let again = rig.messages();
    assert_eq!(
        again.first().map(|m| m.bytes.clone()),
        Some(vec![0xb0, 121, 0])
    );
}

#[test]
fn the_audio_path_never_touches_the_heap_while_notes_are_routed() {
    let (mut transport, shared) = CallbackTransport::headless_with_midi(RATE);
    let mut first = renderer(1, DocumentSettings::default());
    first.replace_midi(tap(&all_routed()));
    transport.install(first, 1, false);
    // The counter itself works: an allocation inside is counted.
    assert!(counted(|| vec![1u8; 10].len()).1 > 0);
    let mut block = vec![[0.0f32; 2]; 1024];
    let delivered = Cell::new(0usize);
    let mut render = |transport: &mut CallbackTransport, callbacks: usize| {
        for _ in 0..callbacks {
            transport.render_callback(&mut block);
            while shared.ring.pop().is_some() {
                delivered.set(delivered.get() + 1);
            }
        }
    };
    let play = |transport: &mut CallbackTransport| {
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
    };
    // Playing: state at the start, notes, controllers, a bend, then the long note and the end of the score.
    let ((), operations) = counted(|| {
        play(&mut transport);
        render(&mut transport, 400);
    });
    assert_eq!(operations, 0, "playing");
    // Seeking into the middle of a held note, while playing and while paused.
    let ((), operations) = counted(|| {
        transport
            .command(TransportCommand::SeekTick {
                generation: 1,
                tick: 4000.0,
            })
            .unwrap();
        render(&mut transport, 10);
        transport
            .command(TransportCommand::Pause { generation: 1 })
            .unwrap();
        render(&mut transport, 3);
        transport
            .command(TransportCommand::SeekTick {
                generation: 1,
                tick: 100.0,
            })
            .unwrap();
        play(&mut transport);
        render(&mut transport, 10);
    });
    assert_eq!(operations, 0, "seeking and pausing");
    // Looping: each wrap is a seek.
    let ((), operations) = counted(|| {
        transport
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 960.0,
                end_tick: 1500.0,
            })
            .unwrap();
        render(&mut transport, 200);
        transport
            .command(TransportCommand::ClearLoop { generation: 1 })
            .unwrap();
    });
    assert_eq!(operations, 0, "looping");
    // Changing the route and the mix while notes sound, then stopping.
    let new_tap = |audible: bool, channel: u8| {
        tap(&[
            (
                LEAD,
                RouteSpec {
                    audible,
                    ..spec(0, channel)
                },
            ),
            (BASS, spec(0, 1)),
            (DRUMS, spec(0, 9)),
        ])
    };
    for (audible, channel) in [(true, 0), (true, 5), (false, 5), (true, 0)] {
        let taps = new_tap(audible, channel);
        let (old, operations) = counted(|| {
            let old = transport.replace_midi(taps, 1);
            render(&mut transport, 10);
            old
        });
        assert_eq!(operations, 0, "route change to ({audible}, {channel})");
        drop(old);
    }
    let ((), operations) = counted(|| {
        transport
            .command(TransportCommand::Stop { generation: 1 })
            .unwrap();
        render(&mut transport, 5);
    });
    assert_eq!(operations, 0, "stopping");
    // Notes, state, releases and anchors really flowed through the ring while it was counted.
    assert!(delivered.get() > 100, "{}", delivered.get());
}

#[test]
fn no_note_is_left_sounding_however_the_score_stops_or_moves() {
    // Stop and pause.
    for stop in [true, false] {
        let mut rig = Rig::new(&all_routed());
        rig.play();
        rig.run(1.5);
        rig.command(if stop {
            TransportCommand::Stop { generation: 1 }
        } else {
            TransportCommand::Pause { generation: 1 }
        });
        rig.run(0.1);
        let messages = rig.messages();
        assert!(messages.iter().any(|m| m.bytes[0] & 0xf0 == 0x90));
        assert_eq!(sounding(&messages), vec![], "stop={stop}");
    }
    // Resuming after a pause states the position again and strikes what was held; stopping again lets go.
    let mut rig = Rig::new(&all_routed());
    rig.play();
    rig.run(1.5);
    rig.command(TransportCommand::Pause { generation: 1 });
    rig.run(0.1);
    rig.play();
    rig.run(0.2);
    let mut messages = rig.messages();
    assert!(
        !sounding(&messages).is_empty(),
        "the long notes sound again after the pause"
    );
    rig.command(TransportCommand::Stop { generation: 1 });
    rig.run(0.1);
    messages.extend(rig.messages());
    assert_eq!(sounding(&messages), vec![]);
    // A seek in the middle of the held notes lets go and strikes the held one afresh.
    let mut rig = Rig::new(&all_routed());
    rig.play();
    rig.run(1.5);
    rig.command(TransportCommand::SeekTick {
        generation: 1,
        tick: 4000.0,
    });
    rig.run(0.2);
    let mut messages = rig.messages();
    assert_eq!(
        sounding(&messages),
        vec![(0, 0, 62)],
        "only the long lead note is held at tick 4000"
    );
    rig.command(TransportCommand::Stop { generation: 1 });
    rig.run(0.1);
    messages.extend(rig.messages());
    assert_eq!(sounding(&messages), vec![]);
    // A loop wrapping many times across held notes.
    let mut rig = Rig::new(&all_routed());
    rig.command(TransportCommand::SetLoop {
        generation: 1,
        start_tick: 900.0,
        end_tick: 1300.0,
    });
    rig.play();
    rig.run(3.0);
    let mut messages = rig.messages();
    let wraps = messages
        .iter()
        .filter(|m| m.bytes == [0x91, 40, 90])
        .count();
    assert!(wraps >= 4, "the loop wrapped: {wraps} bass strikes");
    rig.command(TransportCommand::Stop { generation: 1 });
    rig.run(0.1);
    messages.extend(rig.messages());
    assert_eq!(sounding(&messages), vec![]);
    // The end of the score, with a note the score never ends, lets go with nothing else done.
    let mut rig = Rig::new(&all_routed());
    rig.play();
    rig.run(8.3);
    let messages = rig.messages();
    assert!(
        messages.iter().any(|m| m.bytes == [0x90, 70, 90]),
        "the unended note was struck"
    );
    assert_eq!(sounding(&messages), vec![]);
    // Removing the route, muting the track and a failing port each release what the track holds.
    for how in ["remove", "mute", "move", "fault", "reinstall"] {
        let mut rig = Rig::new(&all_routed());
        rig.play();
        rig.run(1.5);
        match how {
            "remove" => {
                rig.transport.replace_midi(tap(&[]), 1);
            }
            "mute" => {
                let muted = tap(&[
                    (
                        LEAD,
                        RouteSpec {
                            audible: false,
                            ..spec(0, 0)
                        },
                    ),
                    (
                        BASS,
                        RouteSpec {
                            audible: false,
                            ..spec(0, 1)
                        },
                    ),
                    (
                        DRUMS,
                        RouteSpec {
                            audible: false,
                            ..spec(0, 9)
                        },
                    ),
                ]);
                rig.transport.replace_midi(muted, 1);
            }
            "move" => {
                rig.transport.replace_midi(
                    tap(&[(LEAD, spec(1, 3)), (BASS, spec(1, 4)), (DRUMS, spec(1, 9))]),
                    1,
                );
            }
            "fault" => rig.shared.faulted.store(1, Ordering::Release),
            _ => {
                // The document is replaced by a newer one with the same routing.
                let mut next = renderer(1, DocumentSettings::default());
                next.replace_midi(tap(&all_routed()));
                rig.transport.install(next, 1, true);
            }
        }
        rig.run(0.05);
        let messages = rig.messages();
        let on_first_port: Vec<_> = messages.iter().filter(|m| m.slot == 0).cloned().collect();
        let expected: Vec<(u8, u8, u8)> = if how == "reinstall" {
            // The replaced renderer let go, and the new one struck what is held at this position again.
            vec![(0, 0, 60), (0, 0, 62), (0, 1, 40)]
        } else {
            vec![]
        };
        assert_eq!(sounding(&on_first_port), expected, "{how}");
        if how == "reinstall" {
            let released = on_first_port
                .iter()
                .position(|m| m.bytes == [0x80, 62, 0])
                .expect("released first");
            let struck = on_first_port
                .iter()
                .rposition(|m| m.bytes == [0x90, 62, 90])
                .expect("struck again");
            assert!(released < struck);
        }
        if how == "fault" {
            // The drum track is back on the speakers: the kick at 2 s is heard.
            rig.run(0.6);
            assert!(peak(&rig.heard[(2.0 * 48_000.0) as usize..]) > 1e-4);
        }
    }
}

#[test]
fn state_is_stated_again_after_a_seek_and_after_a_loop_wrap() {
    let wanted = |messages: &[Message]| {
        let has = |bytes: &[u8]| messages.iter().any(|m| m.bytes == bytes);
        // The program in effect at the position (40 after tick 150), the expression, the range of 12 semitones,
        // the volume, the wheel six semitones up, and the held long note struck again.
        has(&[0xc0, 40])
            && has(&[0xb0, 11, 77])
            && has(&[0xb0, 6, 12])
            && has(&[0xb0, 101, 0])
            && has(&[0xb0, 101, 127])
            && has(&[0xb0, 7, 100])
            && has(&[0xe0, 0, 96])
            && has(&[0x90, 62, 90])
            && !has(&[0x90, 60, 90])
    };
    let mut rig = Rig::new(&all_routed());
    rig.play();
    rig.run(0.5);
    rig.messages();
    rig.command(TransportCommand::SeekTick {
        generation: 1,
        tick: 2500.0,
    });
    rig.run(0.1);
    assert!(wanted(&rig.messages()), "after a seek");
    // The same at a loop wrap: loop over ticks 2200..2400.
    let mut rig = Rig::new(&all_routed());
    rig.command(TransportCommand::SetLoop {
        generation: 1,
        start_tick: 2200.0,
        end_tick: 2400.0,
    });
    rig.play();
    rig.run(0.5);
    let messages = rig.messages();
    let restated = messages.iter().filter(|m| m.bytes == [0xc0, 40]).count();
    assert!(
        restated >= 2,
        "stated at the start and again after each wrap: {restated}"
    );
    assert!(wanted(&messages), "after a loop wrap");
    // Before any program change the track's own program is stated, with the default range.
    let mut rig = Rig::new(&all_routed());
    rig.command(TransportCommand::SeekTick {
        generation: 1,
        tick: 0.0,
    });
    rig.play();
    rig.run(0.01);
    let messages = rig.messages();
    assert!(
        messages.iter().any(|m| m.bytes == [0xc1, 33]),
        "the bass starts on its own program"
    );
    assert!(messages.iter().any(|m| m.bytes == [0xb1, 6, 2]));
    assert!(messages.iter().any(|m| m.bytes == [0xe1, 0, 64]));
}

#[test]
fn volume_and_pan_follow_the_mix_on_the_tracks_channel_and_on_a_change() {
    let loud = RouteSpec {
        gain: 1.0,
        pan: 0.0,
        ..spec(0, 2)
    };
    let mut rig = Rig::new(&[(LEAD, loud)]);
    rig.play();
    rig.run(0.05);
    let messages = rig.messages();
    // The lead's own volume of 100 with the full mix, centred.
    assert!(messages.iter().any(|m| m.bytes == [0xb2, 7, 100]));
    assert!(messages.iter().any(|m| m.bytes == [0xb2, 10, 64]));
    let quiet = RouteSpec {
        gain: 0.25,
        pan: 1.0,
        ..loud
    };
    rig.transport.replace_midi(tap(&[(LEAD, quiet)]), 1);
    rig.run(0.05);
    let messages = rig.messages();
    // 100 * sqrt(0.25), and hard right.
    assert!(
        messages.iter().any(|m| m.bytes == [0xb2, 7, 50]),
        "{messages:?}"
    );
    assert!(messages.iter().any(|m| m.bytes == [0xb2, 10, 127]));
    // Nothing for a track that is not routed.
    assert!(messages.iter().all(|m| m.bytes[0] & 15 == 2));
}

#[test]
fn a_loop_wrap_releases_the_notes_at_the_frame_the_loop_ends_not_where_the_block_began() {
    // Loop over the first second (960 ticks, 48000 frames). The lead's two long notes are held when the loop ends.
    let mut rig = Rig::new(&[(LEAD, spec(0, 0))]);
    rig.command(TransportCommand::SetLoop {
        generation: 1,
        start_tick: 0.0,
        end_tick: 960.0,
    });
    rig.play();
    rig.run(1.3);
    let messages = rig.messages();
    let first_release = messages
        .iter()
        .find(|m| m.bytes == [0x80, 62, 0])
        .expect("the long note is released at the wrap");
    // The callbacks are 480 frames, so the end of the loop falls on a block boundary; the release is stamped there.
    assert_eq!(
        first_release.frame, 48_000,
        "stamped {} frames in",
        first_release.frame
    );
    // And the strike again follows it at the same frame.
    let struck_again = messages
        .iter()
        .filter(|m| m.bytes == [0x90, 62, 90])
        .nth(1)
        .expect("struck again at the start of the loop");
    assert!(struck_again.frame >= first_release.frame);
}

#[test]
fn a_track_that_moves_to_a_port_while_sounding_fades_out_instead_of_cutting() {
    let mut rig = Rig::new(&[]);
    rig.play();
    rig.run(0.5);
    let before = rig.heard.len();
    let steady = rig.heard[before - 4800..]
        .windows(2)
        .map(|w| (w[1][0] - w[0][0]).abs())
        .fold(0.0f32, f32::max);
    assert!(
        peak(&rig.heard[before - 4800..]) > 0.01,
        "the lead is sounding"
    );
    // The lead is routed to a port.
    rig.transport.replace_midi(tap(&[(LEAD, spec(0, 0))]), 1);
    rig.run(0.2);
    let after = &rig.heard[before..];
    let step = after
        .windows(2)
        .take(480)
        .map(|w| (w[1][0] - w[0][0]).abs())
        .fold(0.0f32, f32::max);
    assert!(
        step <= steady * 3.0 + 1e-4,
        "the first samples after routing step by {step}, against {steady} while steady"
    );
    // Within 10 ms (five are the ramp) the internal sound of that track is gone.
    assert!(peak(&after[480..]) < 1e-6, "{}", peak(&after[480..]));
    // The ramp took more than one sample, and was heard.
    assert!(after[..240].iter().any(|f| f[0].abs() > 1e-4));
}

#[test]
fn a_count_in_bar_counts_as_playing_and_the_first_chord_follows_its_last_click() {
    let mut rig = Rig::new(&all_routed());
    let mut settings = practice(1.0);
    settings.count_in.bars = 1;
    rig.command(TransportCommand::SetPractice {
        generation: 1,
        settings,
    });
    rig.play();
    // One bar at 60 bpm is four seconds, in which nothing is rendered.
    rig.run(1.0);
    assert!(
        rig.shared.rendering.load(Ordering::Relaxed),
        "the sender is told the score is playing during the count-in"
    );
    assert!(
        rig.messages().iter().all(|m| m.bytes[0] & 0xf0 != 0x90),
        "no note sounds before the count-in ends"
    );
    rig.run(1.0);
    assert!(rig.shared.rendering.load(Ordering::Relaxed));
    rig.run(2.2);
    let messages = rig.messages();
    let chord: Vec<_> = messages
        .iter()
        .filter(|m| m.bytes == [0x90, 60, 90])
        .collect();
    assert_eq!(chord.len(), 1);
    // The count-in advances the stream's frames: the chord is at the end of the bar, with its state stated first.
    assert_eq!(chord[0].frame, 4 * u64::from(RATE));
    let program = messages
        .iter()
        .position(|m| m.bytes == [0xc0, 24])
        .expect("the program is stated");
    let on = messages
        .iter()
        .position(|m| m.bytes == [0x90, 60, 90])
        .unwrap();
    assert!(program < on && messages[program].frame == chord[0].frame);
    rig.command(TransportCommand::Stop { generation: 1 });
    rig.run(0.1);
    assert!(!rig.shared.rendering.load(Ordering::Relaxed));
}

#[test]
fn the_sender_is_told_the_score_is_playing_only_while_something_is_routed() {
    let mut open = Rig::new(&[]);
    open.play();
    open.run(0.2);
    assert!(
        !open.shared.rendering.load(Ordering::Relaxed),
        "nothing is routed, so there is nothing for the sender to watch"
    );
    let mut routed = Rig::new(&all_routed());
    routed.play();
    routed.run(0.2);
    assert!(routed.shared.rendering.load(Ordering::Relaxed));
    routed.command(TransportCommand::Pause { generation: 1 });
    routed.run(0.1);
    assert!(!routed.shared.rendering.load(Ordering::Relaxed));
    routed.play();
    routed.run(0.1);
    assert!(routed.shared.rendering.load(Ordering::Relaxed));
    // A stream that is asked to reset (frozen, replaced or failed) is not rendering.
    routed.shared.request_reset();
    assert!(!routed.shared.rendering.load(Ordering::Relaxed));
}
