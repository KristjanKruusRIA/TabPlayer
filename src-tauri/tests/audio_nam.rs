use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};
use tabplayer_lib::audio::nam::{NamModel, NamState, parse_nam};

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

fn heap_operations_during(work: impl FnOnce()) -> usize {
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|flag| flag.set(true));
    work();
    COUNT_HEAP.with(|flag| flag.set(false));
    HEAP_OPERATIONS.with(Cell::get)
}

const FIXTURES: [&[u8]; 4] = [
    include_bytes!("fixtures/nam/wavenet.nam"),
    include_bytes!("fixtures/nam/lstm.nam"),
    include_bytes!("fixtures/nam/wavenet_standard.nam"),
    include_bytes!("fixtures/nam/wavenet_minimal.nam"),
];

#[test]
fn process_stays_off_the_heap() {
    for bytes in FIXTURES {
        let model = NamModel::build(&parse_nam(bytes).unwrap());
        let mut state = NamState::new(&model);
        state.prewarm(&model);
        let mut snapshot = NamState::new(&model);
        let mut sum = 0.0f32;
        let operations = heap_operations_during(|| {
            for i in 0..48_000 {
                let x = 0.3 * ((i as f32) * 0.0287).sin();
                sum += state.process(&model, x);
            }
            snapshot.snapshot_from(&state);
        });
        assert!(sum.is_finite());
        assert_eq!(operations, 0);
    }
}

#[test]
fn an_old_edit_log_replays_beside_one_that_names_a_capture() {
    use tabplayer_lib::audio::dsp::{CaptureRef, FxSettings};
    use tabplayer_lib::edit_types::EditCommand;
    use tabplayer_lib::settings::TrackSound;
    let sound = |fx: FxSettings| TrackSound {
        voice_id: None,
        preset_id: "lead".into(),
        effects: fx,
        ..Default::default()
    };
    let mut plain = FxSettings::default();
    plain.amp.model = "lead".into();
    let mut named = plain.clone();
    named.amp.capture = Some(CaptureRef {
        id: "ab".repeat(16),
        name: "Plexi".into(),
        level_db: 2.5,
    });
    for fx in [plain.clone(), named] {
        let edit =
            serde_json::json!({"type":"setTrackSound","trackId":"t","sound":sound(fx.clone())});
        let command: EditCommand = serde_json::from_value(edit.clone()).unwrap();
        assert_eq!(serde_json::to_value(&command).unwrap(), edit);
        let EditCommand::SetTrackSound { sound, .. } = command else {
            panic!("not a sound edit")
        };
        sound.validate().unwrap();
        assert_eq!(sound.effects, fx);
    }
    let old = serde_json::to_string(&sound(plain)).unwrap();
    assert!(!old.contains("capture"));
    assert_eq!(
        serde_json::to_string(&serde_json::from_str::<TrackSound>(&old).unwrap()).unwrap(),
        old
    );
}
