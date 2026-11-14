//! The device service against a fake HID backend. No hardware, driver or system service is needed.
use super::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const OFF_REPORTS: [[u8; 8]; 3] = [
    [0, 0, 0, 0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0, 0, 0, 2],
    [0, 0, 0, 0, 0, 0, 0, 3],
];
fn events() -> (EventSink, Arc<Mutex<Vec<StatusEvent>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (Arc::new(move |event| lock(&sink).push(event)), seen)
}
fn states(seen: &Mutex<Vec<StatusEvent>>) -> Vec<DeviceState> {
    lock(seen).iter().map(|event| event.state).collect()
}
fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn reports(log: &Mutex<Vec<Vec<u8>>>) -> Vec<Vec<u8>> {
    lock(log).clone()
}
/// The state over a fake with one Fretlight and quick timings, and the fake.
fn rig() -> (FretlightState, Arc<FakeBackend>) {
    let fake = Arc::new(FakeBackend::new(vec![HidInfo::new(
        VENDOR_ID,
        PRODUCT_ID,
        Some("FretLight Guitar"),
    )]));
    let state = FretlightState::new(fake.clone())
        .with_timings(Duration::from_millis(300), Duration::from_millis(10));
    (state, fake)
}
fn one(string: usize, fret: usize) -> Frame {
    Frame::OFF.with(string, fret)
}

#[test]
fn nothing_is_listed_or_opened_before_connect() {
    let (state, fake) = rig();
    assert_eq!(state.status().state, DeviceState::Disconnected);
    assert!(state.send_frame(1, one(1, 0)).is_err());
    state.disconnect(None);
    state.disconnect(Some(3));
    state.shutdown();
    assert_eq!((fake.lists(), fake.opens()), (0, 0));
    assert!(reports(&fake.log()).is_empty());
    let (sink, _) = events();
    state.connect(sink).expect("connects");
    assert_eq!((fake.lists(), fake.opens()), (1, 1));
    state.shutdown();
}

#[test]
fn a_frame_is_written_as_three_eight_byte_reports_with_report_id_zero() {
    let (state, fake) = rig();
    let (sink, seen) = events();
    let session = state.connect(sink).expect("connects");
    assert_eq!(session, 1);
    assert_eq!(
        states(&seen),
        [DeviceState::Connecting, DeviceState::Connected]
    );
    state.send_frame(session, one(1, 0).with(6, 21)).unwrap();
    wait_until("three reports", || reports(&fake.log()).len() == 3);
    assert_eq!(
        reports(&fake.log()),
        [
            vec![0, 0, 0, 0, 0, 0, 0x80, 1],
            vec![0, 0, 0, 0, 0, 0, 0, 2],
            vec![0, 0, 0x10, 0, 0, 0, 0, 3],
        ]
    );
    assert_eq!(state.status().sent, 1);
    state.shutdown();
}

#[test]
fn only_a_device_with_the_right_ids_and_name_is_matched() {
    for (name, info, code) in [
        (
            "another product name",
            HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("USB Keyboard")),
            "name_mismatch:",
        ),
        (
            "no product name",
            HidInfo::new(VENDOR_ID, PRODUCT_ID, None),
            "name_mismatch:",
        ),
        (
            "another vendor",
            HidInfo::new(0x0926, PRODUCT_ID, Some("Fretlight")),
            "not_found:",
        ),
        (
            "another product",
            HidInfo::new(VENDOR_ID, 0x2001, Some("Fretlight")),
            "not_found:",
        ),
    ] {
        let fake = Arc::new(FakeBackend::new(vec![info]));
        let state = FretlightState::new(fake.clone());
        let (sink, seen) = events();
        let error = state.connect(sink).expect_err(name);
        assert!(error.starts_with(code), "{name}: {error}");
        assert_eq!(fake.opens(), 0, "{name} must not be opened");
        assert_eq!(states(&seen).last(), Some(&DeviceState::Error));
        assert_eq!(state.status().state, DeviceState::Error);
    }
    // The name is matched without regard to case, and the right one is chosen among several.
    let fake = Arc::new(FakeBackend::new(vec![
        HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("Other")),
        HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("my FRETLIGHT")),
    ]));
    let state = FretlightState::new(fake.clone());
    state.connect(events().0).expect("matches");
    assert_eq!(fake.opened_names(), ["my FRETLIGHT"]);
    state.shutdown();
}

#[test]
fn a_flood_of_frames_is_coalesced_to_the_newest_at_a_bounded_rate() {
    let fake = Arc::new(FakeBackend::new(vec![HidInfo::new(
        VENDOR_ID,
        PRODUCT_ID,
        Some("Fretlight"),
    )]));
    let state = FretlightState::new(fake.clone())
        .with_timings(Duration::from_millis(300), Duration::from_millis(40));
    let session = state.connect(events().0).unwrap();
    let begun = Instant::now();
    for n in 0..5000usize {
        state.send_frame(session, one(1 + n % 6, n % 22)).unwrap();
    }
    let last = one(1 + 4999 % 6, 4999 % 22);
    let want = encode(&last);
    wait_until("the newest frame", || {
        let log = reports(&fake.log());
        log.len() >= 3
            && log[log.len() - 3..]
                .iter()
                .zip(want)
                .all(|(r, p)| r[1..] == p)
    });
    let sent = state.status().sent;
    let allowed = begun.elapsed().as_millis() as u64 / 40 + 2;
    assert!(sent <= allowed, "{sent} frames in {:?}", begun.elapsed());
    assert!(
        sent < 50,
        "a flood of 5000 must not reach the device: {sent}"
    );
    assert_eq!(reports(&fake.log()).len() as u64, sent * 3);
    assert!(state.status().coalesced >= 4900);
    state.shutdown();
}

#[test]
fn a_failed_write_is_lost_and_leaves_the_leds_as_they_are() {
    let (state, fake) = rig();
    let (sink, seen) = events();
    let session = state.connect(sink).unwrap();
    state.send_frame(session, one(1, 0)).unwrap();
    wait_until("the first frame", || reports(&fake.log()).len() == 3);
    fake.fail_writes_from(3);
    state.send_frame(session, one(2, 2)).unwrap();
    wait_until("lost", || state.status().state == DeviceState::Lost);
    assert_eq!(states(&seen).last(), Some(&DeviceState::Lost));
    let message = lock(&seen).last().unwrap().message.clone();
    assert!(message.contains("Fretlight"), "{message}");
    // Nothing is written after the failure, not even the all-off frame.
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(reports(&fake.log()).len(), 3);
    assert!(state.send_frame(session, one(3, 3)).is_err());
    state.disconnect(None);
    assert_eq!(reports(&fake.log()).len(), 3);
    // Connecting again is the player's own act and gets a new session.
    fake.fail_writes_from(usize::MAX);
    assert!(state.connect(events().0).unwrap() > session);
    state.shutdown();
}

#[test]
fn disconnect_sends_an_all_off_frame_first() {
    let (state, fake) = rig();
    let (sink, seen) = events();
    let session = state.connect(sink).unwrap();
    state.send_frame(session, one(1, 0)).unwrap();
    wait_until("lit", || reports(&fake.log()).len() == 3);
    state.disconnect(Some(session));
    let log = reports(&fake.log());
    assert_eq!(log.len(), 6);
    assert_eq!(log[3..], OFF_REPORTS.map(|r| r.to_vec()));
    assert_eq!(state.status().state, DeviceState::Disconnected);
    assert_eq!(states(&seen).last(), Some(&DeviceState::Disconnected));
    assert!(state.send_frame(session, one(1, 1)).is_err());
}

#[test]
fn a_frame_still_waiting_is_dropped_by_the_all_off_at_disconnect() {
    let fake = Arc::new(FakeBackend::new(vec![HidInfo::new(
        VENDOR_ID,
        PRODUCT_ID,
        Some("Fretlight"),
    )]));
    let state = FretlightState::new(fake.clone())
        .with_timings(Duration::from_millis(300), Duration::from_millis(200));
    let session = state.connect(events().0).unwrap();
    state.send_frame(session, one(1, 0)).unwrap();
    wait_until("first", || reports(&fake.log()).len() == 3);
    state.send_frame(session, one(2, 1)).unwrap();
    state.disconnect(Some(session));
    let log = reports(&fake.log());
    assert_eq!(log.len(), 6, "the waiting frame is replaced by all-off");
    assert_eq!(log[3..], OFF_REPORTS.map(|r| r.to_vec()));
}

#[test]
fn exit_sends_an_all_off_frame() {
    let (state, fake) = rig();
    let session = state.connect(events().0).unwrap();
    state.send_frame(session, one(6, 21)).unwrap();
    wait_until("lit", || reports(&fake.log()).len() == 3);
    state.shutdown();
    assert_eq!(reports(&fake.log())[3..], OFF_REPORTS.map(|r| r.to_vec()));
}

#[test]
fn a_stale_session_changes_nothing() {
    let (state, fake) = rig();
    let first = state.connect(events().0).unwrap();
    let second = state.connect(events().0).unwrap();
    assert_eq!(second, first + 1);
    assert!(state.send_frame(first, one(1, 1)).is_err());
    state.disconnect(Some(first));
    assert_eq!(state.status().state, DeviceState::Connected);
    state.send_frame(second, one(1, 1)).unwrap();
    wait_until("frame", || reports(&fake.log()).len() >= 3);
    state.shutdown();
}

#[test]
fn an_open_that_never_returns_times_out_and_is_not_stacked() {
    let fake = Arc::new(
        FakeBackend::new(vec![HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("Fretlight"))])
            .with_open_delay(Duration::from_millis(600)),
    );
    let state = FretlightState::new(fake.clone())
        .with_timings(Duration::from_millis(60), Duration::from_millis(10));
    let (sink, seen) = events();
    let begun = Instant::now();
    let error = state.connect(sink).expect_err("times out");
    assert!(error.starts_with("open_timeout:"), "{error}");
    assert!(begun.elapsed() < Duration::from_millis(500));
    assert_eq!(states(&seen).last(), Some(&DeviceState::Error));
    // The driver still has the open; another Connect waits for it rather than starting a second.
    let again = state.connect(events().0).expect_err("pending");
    assert!(again.starts_with("open_pending:"), "{again}");
    wait_until("the late open to return", || fake.opens() == 1);
    wait_until("the refusal to end", || {
        !state
            .connect(events().0)
            .err()
            .is_some_and(|error| error.starts_with("open_pending:"))
    });
    state.shutdown();
}

#[test]
fn a_listing_error_is_shown_as_an_error() {
    let fake =
        Arc::new(FakeBackend::new(vec![]).with_list_error("The HID service is not available."));
    let state = FretlightState::new(fake);
    let error = state.connect(events().0).expect_err("fails");
    assert!(
        error.contains("The HID service is not available."),
        "{error}"
    );
    assert_eq!(state.status().state, DeviceState::Error);
}

#[test]
fn hostile_frames_are_refused_when_they_are_decoded() {
    let good = format!("[{}]", vec!["false"; LEDS].join(","));
    assert_eq!(serde_json::from_str::<Frame>(&good).unwrap(), Frame::OFF);
    let all_on = format!("[{}]", vec!["true"; LEDS].join(","));
    assert!(serde_json::from_str::<Frame>(&all_on).unwrap().lit(6, 21));
    for (name, text) in [
        (
            "one short",
            format!("[{}]", vec!["false"; LEDS - 1].join(",")),
        ),
        (
            "one long",
            format!("[{}]", vec!["false"; LEDS + 1].join(",")),
        ),
        ("huge", format!("[{}]", vec!["true"; 200_000].join(","))),
        ("empty", "[]".into()),
        ("numbers", format!("[{}]", vec!["1"; LEDS].join(","))),
        ("strings", format!("[{}]", vec!["\"true\""; LEDS].join(","))),
        ("null", "null".into()),
        ("object", "{\"leds\":[]}".into()),
        ("nested", format!("[{}]", vec!["[true]"; LEDS].join(","))),
    ] {
        assert!(serde_json::from_str::<Frame>(&text).is_err(), "{name}");
    }
}

#[test]
fn notices_are_numbered_and_name_the_device() {
    let (state, _fake) = rig();
    let (sink, seen) = events();
    let session = state.connect(sink).unwrap();
    state.disconnect(Some(session));
    let notices = lock(&seen).clone();
    assert!(notices.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    assert!(notices.iter().all(|notice| notice.session == session));
    assert_eq!(notices[1].state, DeviceState::Connected);
    assert_eq!(notices[1].device, "FretLight Guitar");
}

#[test]
fn the_real_backend_starts_nothing_until_it_is_asked_to_list() {
    // Making the state, asking its status and shutting it down never initialise the USB library.
    let backend = HidApiBackend::default();
    assert!(lock(&backend.api).is_none());
    backend.release();
    assert!(lock(&backend.api).is_none());
    let state = FretlightState::new(Arc::new(HidApiBackend::default()));
    assert_eq!(state.status().state, DeviceState::Disconnected);
    state.shutdown();
}

#[test]
fn the_documented_ids_and_a_fretlight_name_make_a_match() {
    assert!(HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("Fretlight")).is_fretlight());
    assert!(HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("USB FRETLIGHT guitar")).is_fretlight());
    assert!(!HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("Lakeview Research device")).is_fretlight());
    assert!(!HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("")).is_fretlight());
}
#[test]
fn a_rejected_name_is_reported_bounded_and_clean_and_never_opened() {
    let long = "x".repeat(300);
    let fake = Arc::new(FakeBackend::new(vec![
        HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("Odd | Name\u{7}\n")),
        HidInfo::new(VENDOR_ID, PRODUCT_ID, Some(&long)),
        HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("Third")),
        HidInfo::new(VENDOR_ID, PRODUCT_ID, Some("Fourth")),
        HidInfo::new(VENDOR_ID, PRODUCT_ID, None),
    ]));
    let state = FretlightState::new(fake.clone());
    let error = state.connect(events().0).expect_err("rejected");
    let names: Vec<&str> = error
        .strip_prefix("name_mismatch: ")
        .expect("coded")
        .split(" | ")
        .collect();
    assert_eq!(names.len(), 3, "at most three names: {error}");
    assert_eq!(names[0], "Odd  Name");
    assert_eq!(names[1].chars().count(), 40);
    assert_eq!(names[2], "Third");
    assert!(!error.chars().any(|c| c.is_control()));
    assert_eq!(fake.opens(), 0);
}

#[test]
fn the_wait_for_the_next_frame_cannot_go_negative() {
    let min = Duration::from_millis(40);
    assert_eq!(
        remaining(Duration::from_millis(10), min),
        Duration::from_millis(30)
    );
    assert_eq!(remaining(Duration::from_millis(40), min), Duration::ZERO);
    assert_eq!(remaining(Duration::from_millis(41), min), Duration::ZERO);
    assert_eq!(remaining(Duration::MAX, min), Duration::ZERO);
}

#[test]
fn a_worker_that_panics_ends_as_lost_and_refuses_frames() {
    let (state, fake) = rig();
    let (sink, seen) = events();
    let session = state.connect(sink).unwrap();
    fake.panic_on_writes(true);
    state.send_frame(session, one(1, 0)).unwrap();
    wait_until("lost", || state.status().state == DeviceState::Lost);
    let last = lock(&seen).last().cloned().unwrap();
    assert_eq!(last.state, DeviceState::Lost);
    assert!(last.message.contains("Fretlight"), "{}", last.message);
    assert!(state.send_frame(session, one(2, 2)).is_err());
    // The player can connect again.
    fake.panic_on_writes(false);
    assert!(state.connect(events().0).unwrap() > session);
    state.shutdown();
}

#[test]
fn a_new_connect_is_refused_while_the_old_worker_is_stuck_in_a_write() {
    let (state, fake) = rig();
    let state = state.with_close_timeout(Duration::from_millis(60));
    let session = state.connect(events().0).unwrap();
    fake.set_write_delay(Duration::from_millis(500));
    state.send_frame(session, one(1, 0)).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let begun = Instant::now();
    state.disconnect(Some(session));
    assert!(
        begun.elapsed() < Duration::from_millis(400),
        "Disconnect is bounded"
    );
    fake.set_write_delay(Duration::ZERO);
    let error = state.connect(events().0).expect_err("stuck");
    assert!(error.starts_with("worker_stuck:"), "{error}");
    wait_until("the stuck write to finish", || {
        state.connect(events().0).is_ok()
    });
    state.shutdown();
}

#[test]
fn a_session_replaced_by_a_newer_one_leaves_the_newer_lights_alone() {
    let (state, fake) = rig();
    let first = state.connect(events().0).unwrap();
    state.send_frame(first, one(1, 0)).unwrap();
    wait_until("lit", || reports(&fake.log()).len() == 3);
    let second = state.connect(events().0).unwrap();
    assert!(second > first);
    state.send_frame(second, one(2, 2)).unwrap();
    wait_until("second lit", || reports(&fake.log()).len() >= 9);
    let log = reports(&fake.log());
    let want: Vec<Vec<u8>> = encode(&one(2, 2))
        .iter()
        .map(|packet| [&[0u8][..], &packet[..]].concat())
        .collect();
    assert_eq!(log[log.len() - 3..], want);
    state.shutdown();
}
