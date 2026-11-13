//! MIDI input through the public API with a fake driver: what a device can make the app do, and that it cannot make the
//! app do much. No hardware is involved.
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tabplayer_lib::{
    midi_in::{
        CHORD_BURST, CHORDS_PER_SECOND, CaptureSettings, InputLink, InputState, MidiInBackend,
        MidiInEvent, MidiInState, RawSink,
    },
    midi_out::MidiPortInfo,
};

const PORT: &str = "Guitar MIDI";

#[derive(Default)]
struct Driver {
    sink: Arc<Mutex<Option<RawSink>>>,
    closed: Arc<AtomicU64>,
}
struct Link(Arc<Mutex<Option<RawSink>>>, Arc<AtomicU64>);
impl InputLink for Link {}
impl Drop for Link {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
        self.1.fetch_add(1, Ordering::SeqCst);
    }
}
impl MidiInBackend for Driver {
    fn ports(&self) -> Result<Vec<MidiPortInfo>, String> {
        Ok(vec![MidiPortInfo {
            id: "0".into(),
            name: PORT.into(),
        }])
    }
    fn open(&self, name: &str, sink: RawSink) -> Result<Box<dyn InputLink>, String> {
        if name != PORT {
            return Err(format!("no such input {name}"));
        }
        *self.sink.lock().unwrap() = Some(sink);
        Ok(Box::new(Link(self.sink.clone(), self.closed.clone())))
    }
}
impl Driver {
    fn send(&self, bytes: &[u8]) {
        if let Some(sink) = self.sink.lock().unwrap().as_mut() {
            sink(bytes);
        }
    }
}

fn settings(window: u32, floor: u8) -> CaptureSettings {
    CaptureSettings {
        chord_window_ms: window,
        min_velocity: floor,
    }
}
fn started(window: u32, floor: u8) -> (Arc<Driver>, MidiInState, u64, mpsc::Receiver<MidiInEvent>) {
    started_at(window, floor, None)
}
/// With a clock the test moves, notes are stamped exactly as it says and no scheduling delay can change the grouping.
fn started_at(
    window: u32,
    floor: u8,
    clock: Option<Arc<AtomicU64>>,
) -> (Arc<Driver>, MidiInState, u64, mpsc::Receiver<MidiInEvent>) {
    let driver = Arc::new(Driver::default());
    let mut state = MidiInState::new(driver.clone());
    if let Some(clock) = clock {
        state = state.with_clock(clock);
    }
    let (tx, rx) = mpsc::channel();
    let session = state
        .start(
            PORT,
            settings(window, floor),
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    (driver, state, session, rx)
}
fn chords(
    rx: &mpsc::Receiver<MidiInEvent>,
    wait: Duration,
) -> Vec<tabplayer_lib::midi_in::ChordEvent> {
    let deadline = Instant::now() + wait;
    let mut found = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        if let Ok(MidiInEvent::Chord(chord)) = rx.recv_timeout(left) {
            found.push(chord);
        }
    }
    found
}

#[test]
fn a_strummed_chord_arrives_once_with_its_session_and_sequence_number() {
    let clock = Arc::new(AtomicU64::new(0));
    let (driver, state, session, rx) = started_at(30, 1, Some(clock.clone()));
    for (channel, key) in [(5u8, 40u8), (4, 45), (3, 50)] {
        driver.send(&[0x90 | channel, key, 100]);
        clock.fetch_add(5_000, Ordering::SeqCst);
    }
    // 30 ms after the last note the window has passed.
    clock.fetch_add(30_000, Ordering::SeqCst);
    // Ten seconds is only a guard against a hang.
    let found = loop {
        match rx
            .recv_timeout(Duration::from_secs(10))
            .expect("a chord arrives")
        {
            MidiInEvent::Chord(chord) => break vec![chord],
            MidiInEvent::Status(_) => {}
        }
    };
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!((found[0].session, found[0].seq), (session, 1));
    let channels: Vec<_> = found[0].notes.iter().map(|n| n.channel).collect();
    assert_eq!(channels, [5, 4, 3]);
    state.stop(Some(session));
    assert_eq!(driver.closed.load(Ordering::SeqCst), 1);
    assert_eq!(state.status().state, InputState::Stopped);
}

#[test]
fn a_device_sending_only_junk_makes_no_chord() {
    let (driver, state, _session, rx) = started(10, 1);
    let mut junk: Vec<Vec<u8>> = vec![
        vec![],
        vec![0xFF],
        vec![0x90, 0x80, 0x80],
        vec![0x90, 60, 0],
        vec![0x80, 60, 64],
        vec![0xE0, 0, 0x40],
        vec![0xF0; 70_000],
    ];
    junk.extend((0..=255u8).map(|status| vec![status, 1, 1, 1]));
    for message in &junk {
        driver.send(message);
    }
    assert!(chords(&rx, Duration::from_millis(200)).is_empty());
    assert_eq!(state.status().chords, 0);
}

#[test]
fn a_million_messages_stay_bounded_and_the_service_stays_responsive() {
    let (driver, state, session, rx) = started(10, 1);
    let began = Instant::now();
    for i in 0..1_000_000u32 {
        driver.send(&[0x90, (i % 128) as u8, 1 + (i % 127) as u8]);
    }
    let found = chords(&rx, Duration::from_millis(500));
    let status = state.status();
    assert!(status.dropped > 0, "{status:?}");
    let allowed = CHORD_BURST + CHORDS_PER_SECOND * (began.elapsed().as_secs() + 1);
    assert!(found.len() as u64 <= allowed, "{} chords", found.len());
    assert!(found.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    assert!(
        found
            .iter()
            .all(|chord| chord.session == session && chord.notes.len() <= 8)
    );
    let stopping = Instant::now();
    state.stop(None);
    assert!(stopping.elapsed() < Duration::from_secs(2));
    assert_eq!(driver.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn start_refuses_what_it_should_before_opening_anything() {
    let driver = Arc::new(Driver::default());
    let state = MidiInState::new(driver.clone())
        .with_timings(Duration::from_millis(200), Duration::from_secs(1));
    let emit: tabplayer_lib::midi_in::EventSink = Arc::new(|_| {});
    assert!(
        state
            .start("Elsewhere", settings(60, 1), emit.clone())
            .is_err()
    );
    assert_eq!(state.status().state, InputState::Error);
    assert!(state.start(PORT, settings(9, 1), emit.clone()).is_err());
    assert!(state.start(PORT, settings(60, 128), emit).is_err());
    assert!(driver.sink.lock().unwrap().is_none());
    // Listing is separate from opening.
    assert_eq!(state.ports().unwrap().len(), 1);
    assert!(driver.sink.lock().unwrap().is_none());
}
