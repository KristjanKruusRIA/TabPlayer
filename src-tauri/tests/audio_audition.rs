use ringbuf::{HeapRb, traits::*};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    path::PathBuf,
    sync::Arc,
    time::Instant,
};
use tabplayer_lib::{
    audio::{
        audition::{AuditionClip, AuditionRequest, render_clip},
        device::{CallbackTransport, TransportCommand},
        plan::PlaybackPlan,
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

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio")
}
fn request(program: u8, percussion: bool, keys: &[(u8, u32)], duration: u32) -> AuditionRequest {
    serde_json::from_value(serde_json::json!({
        "voice": TrackSound::default(),
        "program": program,
        "percussion": percussion,
        "mix": {"gain": 1, "pan": 0, "mute": false, "solo": false},
        "notes": keys.iter().map(|(key, start)| serde_json::json!({"key": key, "startMs": start, "velocity": 100})).collect::<Vec<_>>(),
        "durationMs": duration,
    }))
    .unwrap()
}
fn peak(frames: &[[f32; 2]]) -> f32 {
    frames
        .iter()
        .flat_map(|f| f.iter())
        .fold(0.0, |p, x| p.max(x.abs()))
}
fn constant(rate: u32, frames: usize, value: f32) -> Box<AuditionClip> {
    Box::new(AuditionClip {
        rate,
        frames: vec![[value; 2]; frames],
        tone: false,
    })
}
fn silent_renderer(generation: u64) -> Box<Renderer> {
    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":generation,"ppq":960,"durationTick":7680,"durationMs":4000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":4000}],"notes":[],"midi":[]})).unwrap();
    let resources = Arc::new(AudioResources::load_for_requests(&root(), &[]).unwrap());
    Box::new(
        Renderer::new(
            Arc::new(plan),
            resources,
            DocumentSettings::default(),
            48_000,
        )
        .unwrap(),
    )
}

#[test]
fn request_is_strict_and_bounded() {
    let valid = request(24, false, &[(40, 0), (45, 60)], 1500);
    valid.validate().unwrap();
    let json = |mutate: &dyn Fn(&mut serde_json::Value)| {
        let mut value = serde_json::json!({
            "voice": TrackSound::default(),
            "program": 24,
            "percussion": false,
            "mix": {"gain": 1, "pan": 0, "mute": false, "solo": false},
            "notes": [{"key": 40, "startMs": 0, "velocity": 100}],
            "durationMs": 800,
        });
        mutate(&mut value);
        serde_json::from_value::<AuditionRequest>(value)
    };
    assert!(json(&|_| {}).unwrap().validate().is_ok());
    let invalid = |mutate: &dyn Fn(&mut serde_json::Value)| match json(mutate) {
        Ok(request) => request.validate().is_err(),
        Err(_) => true,
    };
    assert!(invalid(&|v| v["notes"] = serde_json::json!([])));
    assert!(invalid(&|v| {
        v["notes"] = serde_json::Value::Array(
            (0..13)
                .map(|_| serde_json::json!({"key": 40, "startMs": 0, "velocity": 100}))
                .collect(),
        )
    }));
    assert!(!invalid(&|v| {
        v["notes"] = serde_json::Value::Array(
            (0..12)
                .map(|_| serde_json::json!({"key": 127, "startMs": 1000, "velocity": 127}))
                .collect(),
        )
    }));
    assert!(invalid(&|v| v["notes"][0]["key"] = 128.into()));
    assert!(invalid(&|v| v["notes"][0]["key"] = 256.into()));
    assert!(invalid(&|v| v["notes"][0]["key"] = (-1).into()));
    assert!(invalid(&|v| v["notes"][0]["startMs"] = 1001.into()));
    assert!(invalid(&|v| v["notes"][0]["velocity"] = 0.into()));
    assert!(invalid(&|v| v["notes"][0]["velocity"] = 128.into()));
    assert!(invalid(&|v| v["durationMs"] = 99.into()));
    assert!(invalid(&|v| v["durationMs"] = 3001.into()));
    assert!(!invalid(&|v| v["durationMs"] = 100.into()));
    assert!(!invalid(&|v| v["durationMs"] = 3000.into()));
    assert!(invalid(&|v| v["program"] = 128.into()));
    assert!(invalid(&|v| v["mix"]["gain"] = 1.5.into()));
    assert!(invalid(&|v| v["mix"]["pan"] = (-2).into()));
    assert!(invalid(&|v| v["voice"]["voiceId"] = "banjo".into()));
    // Unknown keys are refused at every level.
    assert!(invalid(&|v| v["extra"] = 1.into()));
    assert!(invalid(&|v| v["notes"][0]["extra"] = 1.into()));
    assert!(invalid(&|v| v["mix"]["extra"] = 1.into()));
    assert!(invalid(&|v| v["voice"]["extra"] = 1.into()));
    assert!(invalid(&|v| {
        v.as_object_mut().unwrap().remove("durationMs");
    }));
}

#[test]
fn sample_voice_clip_is_stereo_non_silent_and_fades_out() {
    for rate in [44_100, 48_000] {
        let request = request(24, false, &[(40, 0), (45, 60), (50, 120)], 800);
        let clip = render_clip(&root(), &request, rate).unwrap();
        assert_eq!(clip.rate, rate);
        assert_eq!(
            clip.frames.len(),
            ((120 + 800) as u64 * rate as u64 / 1000) as usize
        );
        assert!(peak(&clip.frames) > 0.02, "recorded guitar was silent");
        assert!(clip.frames.iter().flatten().all(|x| x.is_finite()));
        let fade = rate as usize * 30 / 1000;
        let tail = &clip.frames[clip.frames.len() - fade..];
        assert_eq!(*clip.frames.last().unwrap(), [0.0, 0.0]);
        assert!(peak(tail) < peak(&clip.frames[..clip.frames.len() - fade]));
        // The fade is monotonic once the held notes have settled.
        let early = peak(&clip.frames[..rate as usize / 10]);
        assert!(early > 0.02);
    }
}

#[test]
fn gm_voice_and_percussion_clips_are_non_silent() {
    let piano = render_clip(
        &root(),
        &request(0, false, &[(60, 0), (64, 30)], 600),
        48_000,
    )
    .unwrap();
    assert!(peak(&piano.frames) > 0.01, "GM piano was silent");
    let drum = render_clip(&root(), &request(0, true, &[(38, 0)], 300), 48_000).unwrap();
    assert!(peak(&drum.frames) > 0.01, "GM percussion was silent");
}

#[test]
fn mix_follows_gain_and_ignores_mute_and_solo() {
    let make = |mix: serde_json::Value| {
        let mut value = serde_json::to_value(serde_json::json!({
            "voice": TrackSound::default(),
            "program": 24,
            "percussion": false,
            "mix": mix,
            "notes": [{"key": 45, "startMs": 0, "velocity": 100}],
            "durationMs": 300,
        }))
        .unwrap();
        value["voice"] = serde_json::to_value(TrackSound::default()).unwrap();
        let request: AuditionRequest = serde_json::from_value(value).unwrap();
        render_clip(&root(), &request, 48_000).unwrap()
    };
    let full = make(serde_json::json!({"gain": 1, "pan": 0, "mute": false, "solo": false}));
    let muted = make(serde_json::json!({"gain": 1, "pan": 0, "mute": true, "solo": false}));
    let quiet = make(serde_json::json!({"gain": 0.25, "pan": 0, "mute": false, "solo": false}));
    let left = make(serde_json::json!({"gain": 1, "pan": -1, "mute": false, "solo": false}));
    assert_eq!(full.frames, muted.frames);
    assert!(peak(&quiet.frames) < peak(&full.frames) * 0.6);
    let right_peak = left.frames.iter().fold(0.0f32, |p, f| p.max(f[1].abs()));
    assert!(right_peak < 1e-4 && peak(&left.frames) > 0.01);
}

#[test]
fn clip_mixes_while_stopped_and_while_playing_without_touching_playback() {
    let request = request(24, false, &[(45, 0)], 300);
    let clip = render_clip(&root(), &request, 48_000).unwrap();
    let expected: Vec<[f32; 2]> = clip.frames[..512].to_vec();
    let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
    // Stopped, no document at all.
    assert!(producer.try_push(clip).is_ok());
    let mut output = [[0.0; 2]; 512];
    transport.render_into(&mut output);
    assert_eq!(&output[..], &expected[..]);
    let status = transport.status();
    assert_eq!(status.audition_serial, 1);
    assert!(status.audition_peak > 0.0);
    assert!((status.audition_peak - f64::from(peak(&expected))).abs() < 1e-9);
    assert!(!status.playing);
    assert_eq!(status.rendered_frames, 0);
    assert_eq!(status.output_peak, 0.0);
    // Let the first clip run out, then play over a started transport.
    for _ in 0..40 {
        transport.render_into(&mut output);
    }
    // Playing: playback counters advance and the clip is added on top.
    transport.install(silent_renderer(1), 1, false);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let second = render_clip(&root(), &request, 48_000).unwrap();
    let expected: Vec<[f32; 2]> = second.frames[..512].to_vec();
    assert!(producer.try_push(second).is_ok());
    transport.render_into(&mut output);
    assert_eq!(&output[..], &expected[..]);
    let status = transport.status();
    assert!(status.playing);
    assert_eq!(status.rendered_frames, 512);
    assert_eq!(status.audition_serial, 2);
    // Pausing stops playback frames but the rest of the clip keeps sounding.
    transport
        .command(TransportCommand::Pause { generation: 1 })
        .unwrap();
    transport.render_into(&mut output);
    assert!(peak(&output) > 0.0);
    assert_eq!(transport.status().rendered_frames, 512);
}

#[test]
fn replacement_fades_the_earlier_clip_over_five_milliseconds() {
    let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
    let mut output = [[0.0; 2]; 512];
    assert!(producer.try_push(constant(48_000, 9_600, 1.0)).is_ok());
    transport.render_into(&mut output);
    assert!(output.iter().all(|f| *f == [1.0, 1.0]));
    assert_eq!(transport.status().audition_peak, 1.0);
    assert!(producer.try_push(constant(48_000, 9_600, 0.25)).is_ok());
    transport.render_into(&mut output);
    // 5 ms is 240 frames: 1.0 ramps down while the new clip is added at once.
    assert!((output[0][0] - 1.25).abs() < 1e-5);
    assert!((output[119][0] - (0.5 + 0.25 + 1.0 / 240.0)).abs() < 1e-4);
    assert!((output[239][0] - (0.25 + 1.0 / 240.0)).abs() < 1e-5);
    assert!(output[240..].iter().all(|f| (f[0] - 0.25).abs() < 1e-6));
    let status = transport.status();
    assert_eq!(status.audition_serial, 2);
    // The peak is the latest clip as mixed, not the clip it replaced.
    assert!((status.audition_peak - 0.25).abs() < 1e-6);
    // The faded clip is handed back for deallocation off the audio thread.
    let mut returned = Vec::new();
    transport.retire_auditions(|clip| {
        returned.push(clip);
        None
    });
    assert_eq!(returned.len(), 1);
    assert_eq!(returned[0].frames[0], [1.0, 1.0]);
    // Several clips queued within one callback leave only the newest sounding.
    for value in [0.1, 0.2, 0.3] {
        assert!(producer.try_push(constant(48_000, 9_600, value)).is_ok());
    }
    transport.render_into(&mut output);
    assert!((output[300][0] - 0.3).abs() < 1e-6);
    assert_eq!(transport.status().audition_serial, 3);
}

#[test]
fn clips_for_another_sample_rate_are_dropped_unplayed() {
    let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
    assert!(producer.try_push(constant(44_100, 4_800, 1.0)).is_ok());
    let mut output = [[0.0; 2]; 512];
    transport.render_into(&mut output);
    assert!(output.iter().all(|f| *f == [0.0, 0.0]));
    assert_eq!(transport.status().audition_serial, 0);
    let mut returned = 0;
    transport.retire_auditions(|_| {
        returned += 1;
        None
    });
    assert_eq!(returned, 1);
}

#[test]
fn finished_clip_is_retired_and_serial_counts_each_start() {
    let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
    let mut output = [[0.0; 2]; 512];
    assert!(producer.try_push(constant(48_000, 700, 0.5)).is_ok());
    transport.render_into(&mut output);
    assert_eq!(output[511][0], 0.5);
    transport.render_into(&mut output);
    assert_eq!(output[187][0], 0.5);
    assert_eq!(output[188][0], 0.0);
    let mut returned = 0;
    transport.retire_auditions(|_| {
        returned += 1;
        None
    });
    assert_eq!(returned, 1);
    assert_eq!(transport.status().audition_serial, 1);
    // A retire path that refuses keeps the clip for the next attempt.
    assert!(producer.try_push(constant(48_000, 10, 0.5)).is_ok());
    transport.render_into(&mut output);
    let mut refused = 0;
    transport.retire_auditions(|clip| {
        refused += 1;
        Some(clip)
    });
    assert_eq!(refused, 1);
    let mut accepted = 0;
    transport.retire_auditions(|_| {
        accepted += 1;
        None
    });
    assert_eq!(accepted, 1);
    assert_eq!(transport.status().audition_serial, 2);
}

#[test]
fn audition_callback_path_does_not_touch_the_heap() {
    let request = request(24, false, &[(45, 0), (52, 40)], 300);
    let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
    let first = render_clip(&root(), &request, 48_000).unwrap();
    let second = render_clip(&root(), &request, 48_000).unwrap();
    let third = render_clip(&root(), &request, 48_000).unwrap();
    let (mut retire_in, mut retire_out) = HeapRb::<Box<AuditionClip>>::new(16).split();
    transport.install(silent_renderer(1), 1, false);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut block = [[0.0; 2]; 512];
    let mut operations = 0;
    let mut run = |transport: &mut CallbackTransport, blocks: usize| {
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|f| f.set(true));
        for _ in 0..blocks {
            transport.render_into(&mut block);
            transport.retire_auditions(|clip| match retire_in.try_push(clip) {
                Ok(()) => None,
                Err(clip) => Some(clip),
            });
        }
        COUNT_HEAP.with(|f| f.set(false));
        HEAP_OPERATIONS.with(Cell::get)
    };
    // A clip starts while playing, is replaced mid-way, and the last one runs to its end.
    assert!(producer.try_push(first).is_ok());
    operations += run(&mut transport, 5);
    assert!(producer.try_push(second).is_ok());
    operations += run(&mut transport, 2);
    assert!(producer.try_push(third).is_ok());
    operations += run(&mut transport, 60);
    assert_eq!(
        operations, 0,
        "audition mixing allocated or freed heap memory"
    );
    assert_eq!(transport.status().audition_serial, 3);
    let mut retired = 0;
    while retire_out.try_pop().is_some() {
        retired += 1;
    }
    assert_eq!(retired, 3);
}

#[test]
#[ignore = "Prints release-mode audition render latency; run with --ignored --nocapture."]
fn render_latency_report() {
    let guitar6 = request(
        24,
        false,
        &[
            (40, 0),
            (45, 60),
            (50, 120),
            (55, 180),
            (59, 240),
            (64, 300),
        ],
        1500,
    );
    let piano = request(0, false, &[(60, 0), (64, 0), (67, 0)], 800);
    let bass = request(33, false, &[(40, 0)], 800);
    for (name, request) in [
        ("guitar chord x6", &guitar6),
        ("guitar single", &request(24, false, &[(52, 0)], 800)),
        ("bass single", &bass),
        ("GM piano chord x3", &piano),
    ] {
        for attempt in ["cold", "warm"] {
            let started = Instant::now();
            let clip = render_clip(&root(), request, 48_000).unwrap();
            println!(
                "audition render {name} {attempt}: {:.1} ms ({} frames)",
                started.elapsed().as_secs_f64() * 1000.0,
                clip.frames.len()
            );
        }
    }
}

#[test]
fn eviction_and_wrong_rate_paths_do_not_touch_the_heap() {
    let (mut transport, mut producer) = CallbackTransport::headless_with_audition(48_000);
    let (mut retire_in, mut retire_out) = HeapRb::<Box<AuditionClip>>::new(32).split();
    let mut clips = vec![
        constant(48_000, 4_800, 0.1),
        constant(48_000, 4_800, 0.2),
        constant(44_100, 4_800, 0.9),
        constant(48_000, 4_800, 0.3),
        constant(48_000, 4_800, 0.4),
        constant(48_000, 4_800, 0.5),
    ]
    .into_iter();
    let mut block = [[0.0; 2]; 32];
    let mut operations = 0;
    let mut pushed = 0;
    // Short blocks (under a millisecond) keep every replaced clip mid-fade, so the
    // third replacement evicts the oldest fading clip; one clip has the wrong rate.
    for step in 0..8 {
        if let Some(clip) = clips.next().filter(|_| step < 6) {
            assert!(producer.try_push(clip).is_ok());
            pushed += 1;
        }
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|f| f.set(true));
        transport.render_into(&mut block);
        transport.retire_auditions(|clip| match retire_in.try_push(clip) {
            Ok(()) => None,
            Err(clip) => Some(clip),
        });
        COUNT_HEAP.with(|f| f.set(false));
        operations += HEAP_OPERATIONS.with(Cell::get);
    }
    // Let everything finish.
    for _ in 0..40 {
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|f| f.set(true));
        transport.render_into(&mut [[0.0; 2]; 512]);
        transport.retire_auditions(|clip| match retire_in.try_push(clip) {
            Ok(()) => None,
            Err(clip) => Some(clip),
        });
        COUNT_HEAP.with(|f| f.set(false));
        operations += HEAP_OPERATIONS.with(Cell::get);
    }
    assert_eq!(
        operations, 0,
        "eviction or stashing allocated or freed heap memory"
    );
    assert_eq!(pushed, 6);
    let mut retired = 0;
    while retire_out.try_pop().is_some() {
        retired += 1;
    }
    assert_eq!(
        retired, 6,
        "every clip is returned for off-thread deallocation"
    );
    assert_eq!(transport.status().audition_serial, 5);
}

#[test]
fn audition_ignores_plugin_slot() {
    let mut req = request(24, false, &[(40, 0), (45, 60)], 500);
    req.voice.plugin = Some(tabplayer_lib::settings::PluginSlot {
        format: tabplayer_lib::settings::PluginFormat::Vst3,
        class_id: "0123456789ABCDEF0123456789ABCDEF".into(),
        name: "Test".into(),
        vendor: "Test".into(),
        active: true,
        input_db: 0.0,
        output_db: 0.0,
        state: "a".repeat(64),
    });
    let clip = render_clip(&root(), &req, 48_000).unwrap();
    assert!(!clip.frames.is_empty());
    assert!(!clip.tone);
}
