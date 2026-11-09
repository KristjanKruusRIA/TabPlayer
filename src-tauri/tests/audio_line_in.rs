//! Line-In monitoring through the output transport: nothing on the audio threads touches the
//! heap, the Line-In is independent of the score, and its level and safety hold.
use ringbuf::traits::Producer;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::HashMap,
    f64::consts::TAU,
    io::Cursor,
    path::PathBuf,
    sync::Arc,
};
use tabplayer_lib::{
    audio::{
        audition::AuditionClip,
        decode::DecodedAudio,
        device::{CallbackTransport, HeadlessOutput, TransportCommand},
        line_in::{
            LineInControl, LineInMeter, LineInMonitor, LineInProducer, LineInRetired,
            LineInSettings, MonitorRing, build_chain, monitor_channel,
        },
        plan::PlaybackPlan,
        renderer::{PreparedMix, Renderer},
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
    },
    audio_input::{SampleSink, capture_block},
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

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio")
}

fn plan(generation: u64) -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":generation,"ppq":960,"durationTick":7680,"durationMs":8000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":60}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":4000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":4000,"endMs":8000}],"notes":[],"midi":[]})).unwrap()
}
fn renderer(generation: u64, rate: u32, settings: DocumentSettings) -> Box<Renderer> {
    let resources = Arc::new(AudioResources::load_for_requests(&root(), &[]).unwrap());
    Box::new(Renderer::new(Arc::new(plan(generation)), resources, settings, rate).unwrap())
}

fn sine(freq: f64, rate: f64, start: usize, count: usize, amplitude: f64) -> Vec<f32> {
    (start..start + count)
        .map(|n| (amplitude * (TAU * freq * n as f64 / rate).sin()) as f32)
        .collect()
}

fn peak(frames: &[[f32; 2]]) -> f32 {
    frames
        .iter()
        .flat_map(|f| f.iter())
        .fold(0.0, |p, x| p.max(x.abs()))
}

/// A sound that runs every effect that has its own state to carry: amp, cabinet, chorus, delay
/// and reverb.
fn busy_sound() -> TrackSound {
    let mut sound = TrackSound::default();
    sound.effects.amp.enabled = true;
    sound.effects.cabinet.enabled = true;
    sound.effects.chorus.enabled = true;
    sound.effects.delay.enabled = true;
    sound.effects.reverb.enabled = true;
    sound
}

struct Rig {
    transport: CallbackTransport,
    control: LineInControl,
    producer: LineInProducer,
    ring: Arc<MonitorRing>,
    meter: Arc<LineInMeter>,
    in_rate: f64,
    out_rate: u32,
    written: usize,
    block: Vec<[f32; 2]>,
    /// What the transport has handed back for the control side to free.
    retired: Vec<LineInRetired>,
}

impl Rig {
    fn new(in_rate: f64, out_rate: u32, settings: &LineInSettings) -> Self {
        let (transport, mut control) = CallbackTransport::headless_with_line_in(out_rate);
        let (producer, ring, meter) = monitor_channel(in_rate);
        control
            .attach(LineInMonitor::new(ring.clone(), meter.clone(), settings, out_rate).unwrap())
            .unwrap();
        Self {
            transport,
            control,
            producer,
            ring,
            meter,
            in_rate,
            out_rate,
            written: 0,
            block: vec![[0.0; 2]; 480],
            retired: Vec::with_capacity(32),
        }
    }
    /// What the input device delivers during one output block.
    fn feed(&mut self, freq: f64, amplitude: f64) {
        let count = (self.block.len() as f64 / f64::from(self.out_rate) * self.in_rate) as usize;
        let samples = sine(freq, self.in_rate, self.written, count, amplitude);
        self.producer.push_samples(&samples);
        self.producer.end_block(count);
        self.written += count;
    }
    /// One output block, as the callback does it: render, then hand back what was replaced.
    fn render(&mut self) {
        self.transport.render_into(&mut self.block);
        let retired = &mut self.retired;
        self.transport.retire_line_in(|item| {
            retired.push(item);
            None
        });
    }
}

#[test]
fn the_output_side_does_not_touch_the_heap() {
    for (in_rate, out_rate) in [
        (44_100.0, 48_000),
        (48_000.0, 44_100),
        (96_000.0, 48_000),
        (48_000.0, 48_000),
    ] {
        let mut rig = Rig::new(in_rate, out_rate, &LineInSettings::default());
        let mut operations = 0;
        // Priming: nothing has arrived yet.
        let (_, n) = counted(|| rig.render());
        operations += n;
        // Steady running with a busy sound chain, mismatched rates resampled throughout.
        let mut busy = LineInSettings::default();
        busy.sound = busy_sound();
        let chain = build_chain(&busy.sound, out_rate).unwrap();
        rig.control.chain(chain).unwrap();
        for _ in 0..150 {
            rig.feed(196.0, 0.4);
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        // Underrun: the input stops for a while, then returns.
        for _ in 0..30 {
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        for _ in 0..30 {
            rig.feed(196.0, 0.4);
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        assert!(rig.meter.underruns() >= 1, "{in_rate}->{out_rate}");
        // Overflow: a burst of 120 ms arrives at once.
        let burst = (in_rate * 0.12) as usize;
        let samples = sine(196.0, in_rate, rig.written, burst, 0.4);
        rig.producer.push_samples(&samples);
        rig.written += burst;
        for _ in 0..4 {
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        assert!(rig.meter.skips() >= 1, "{in_rate}->{out_rate}");
        // Settings swaps: two chains in quick succession (the second parks while the first
        // crossfades), then level and monitor changes.
        let mut next = busy.clone();
        next.sound.effects.reverb.mix = 0.4;
        let first = build_chain(&next.sound, out_rate).unwrap();
        next.sound.effects.delay.feedback = 0.5;
        let second = build_chain(&next.sound, out_rate).unwrap();
        rig.control.chain(first).unwrap();
        rig.control.chain(second).unwrap();
        rig.control.level(0.5, true).unwrap();
        for _ in 0..40 {
            rig.feed(196.0, 0.4);
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        rig.control.level(0.5, false).unwrap();
        for _ in 0..10 {
            rig.feed(196.0, 0.4);
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        // Replacing the whole monitor (a restart) and detaching it.
        let replacement =
            LineInMonitor::new(rig.ring.clone(), rig.meter.clone(), &busy, out_rate).unwrap();
        rig.control.attach(replacement).unwrap();
        for _ in 0..10 {
            rig.feed(196.0, 0.4);
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        rig.control.detach().unwrap();
        for _ in 0..4 {
            let (_, n) = counted(|| rig.render());
            operations += n;
        }
        assert_eq!(operations, 0, "{in_rate}->{out_rate}: heap operations");
        // Everything replaced was handed back for the control side to free.
        assert!(rig.retired.len() >= 4, "{}", rig.retired.len());
        assert!(
            rig.retired
                .iter()
                .any(|r| matches!(r, LineInRetired::Monitor(_)))
        );
    }
}

#[test]
fn the_input_side_does_not_touch_the_heap() {
    for rate in [44_100.0, 48_000.0, 96_000.0, 192_000.0] {
        let (mut producer, _ring, meter) = monitor_channel(rate);
        // Two channels of 16-bit samples and eight of floats, as devices deliver them.
        let stereo: Vec<i16> = (0..1024)
            .map(|n| ((n as f64 * 0.05).sin() * 8000.0) as i16)
            .collect();
        let many: Vec<f32> = (0..8 * 480)
            .map(|n| (n as f64 * 0.01).sin() as f32 * 0.3)
            .collect();
        let mut chosen = 0;
        let ((), operations) = counted(|| {
            for _ in 0..100 {
                capture_block(&stereo, 2, &mut producer, &mut chosen);
                capture_block(&many, 8, &mut producer, &mut chosen);
            }
        });
        assert_eq!(operations, 0, "{rate}");
        assert!(meter.take_peaks().0 > 0.0);
    }
}

#[test]
fn a_new_score_a_new_mix_and_a_new_sound_never_touch_the_line_in() {
    let mut settings = LineInSettings::default();
    settings.level = 0.6;
    let mut rig = Rig::new(48_000.0, 48_000, &settings);
    rig.transport
        .install(renderer(1, 48_000, DocumentSettings::default()), 1, false);
    rig.transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let level = |rig: &mut Rig, blocks: usize| {
        let mut loudest = 0.0f32;
        for _ in 0..blocks {
            rig.feed(220.0, 0.5);
            rig.render();
            loudest = loudest.max(peak(&rig.block));
        }
        loudest
    };
    level(&mut rig, 100);
    let before = level(&mut rig, 100);
    assert!((before - 0.5 * 0.6).abs() < 0.01, "{before}");
    // A different score installs while the Line-In sounds: no block of it goes quiet.
    rig.transport
        .install(renderer(2, 48_000, DocumentSettings::default()), 2, false);
    let mut quietest = f32::MAX;
    for _ in 0..50 {
        rig.feed(220.0, 0.5);
        rig.render();
        quietest = quietest.min(peak(&rig.block));
    }
    assert!(quietest > 0.25, "{quietest}");
    // A rebuilt mix with a loud master and a heavy track sound changes nothing about it.
    let mut document = DocumentSettings::default();
    document.sounds.insert("gm".into(), busy_sound());
    document.master = Some(Default::default());
    let mix = PreparedMix::prepare(&document, &plan(2), 48_000).unwrap();
    rig.transport.replace_mix(mix, 2);
    let after = level(&mut rig, 100);
    assert!((after - before).abs() < 0.005, "{before} -> {after}");
    assert!(rig.meter.underruns() == 0 && rig.meter.skips() == 0);
}

#[test]
fn level_and_monitor_apply_and_the_sum_is_held_below_full_scale() {
    let mut rig = Rig::new(48_000.0, 48_000, &LineInSettings::default());
    let run = |rig: &mut Rig, amplitude: f64, blocks: usize| {
        let mut loudest = 0.0f32;
        for _ in 0..blocks {
            rig.feed(220.0, amplitude);
            rig.render();
            loudest = loudest.max(peak(&rig.block));
        }
        loudest
    };
    run(&mut rig, 0.5, 60);
    let at_default = run(&mut rig, 0.5, 60);
    assert!((at_default - 0.4).abs() < 0.01, "{at_default}");
    rig.control.level(0.2, true).unwrap();
    run(&mut rig, 0.5, 10);
    let quieter = run(&mut rig, 0.5, 20);
    assert!((quieter - 0.1).abs() < 0.01, "{quieter}");
    // Monitor off: silent once the 5 ms glide is over, though the input is still read.
    rig.control.level(0.2, false).unwrap();
    run(&mut rig, 0.5, 5);
    assert!(run(&mut rig, 0.5, 20) < 1e-5);
    assert!(
        rig.meter.take_peaks().0 >= 0.49,
        "the input is still metered"
    );
    // And back on.
    rig.control.level(1.0, true).unwrap();
    run(&mut rig, 0.5, 10);
    assert!((run(&mut rig, 0.5, 20) - 0.5).abs() < 0.01);
    // A full-scale input at full level never reaches full scale ...
    let mut loud = LineInSettings::default();
    loud.level = 1.0;
    let mut hot = Rig::new(48_000.0, 48_000, &loud);
    for _ in 0..200 {
        hot.feed(110.0, 1.0);
        hot.render();
        assert!(peak(&hot.block) <= 1.0, "{}", peak(&hot.block));
    }
    assert!(peak(&hot.block) > 0.9);
}

#[test]
fn the_line_in_on_top_of_an_audition_stays_inside_full_scale() {
    let (mut transport, mut clips, mut control) =
        CallbackTransport::headless_with_audition_and_line_in(48_000);
    let (mut producer, ring, meter) = monitor_channel(48_000.0);
    let mut loud = LineInSettings::default();
    loud.level = 1.0;
    control
        .attach(LineInMonitor::new(ring, meter, &loud, 48_000).unwrap())
        .unwrap();
    assert!(
        clips
            .try_push(Box::new(AuditionClip {
                rate: 48_000,
                frames: vec![[0.8; 2]; 48_000],
                tone: false,
            }))
            .is_ok()
    );
    let mut block = [[0.0f32; 2]; 480];
    let mut written = 0;
    let mut loudest = 0.0f32;
    for _ in 0..100 {
        producer.push_samples(&sine(110.0, 48_000.0, written, 480, 1.0));
        producer.end_block(480);
        written += 480;
        transport.render_into(&mut block);
        loudest = loudest.max(peak(&block));
    }
    // 0.8 from the clip plus a full-scale guitar would be 1.8 unprotected.
    assert!(loudest > 0.95 && loudest <= 1.0, "{loudest}");
}

#[test]
fn a_sound_change_crossfades_without_a_step() {
    let mut rig = Rig::new(48_000.0, 48_000, &LineInSettings::default());
    let mut samples = Vec::new();
    for n in 0..300 {
        rig.feed(220.0, 0.5);
        if n == 100 {
            let mut changed = LineInSettings::default();
            changed.sound.effects.eq.enabled = true;
            changed.sound.effects.eq.low_db = 6.0;
            rig.control
                .chain(build_chain(&changed.sound, 48_000).unwrap())
                .unwrap();
        }
        rig.render();
        samples.extend(rig.block.iter().map(|f| f[0]));
    }
    let tail = &samples[samples.len() / 3..];
    let step = tail
        .windows(2)
        .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
    // A 220 Hz sine of this size moves at most 0.5 * 0.8 * 2 pi * 220 / 48000 per sample.
    assert!(step < 0.0125 * 1.5, "{step}");
    assert_eq!(rig.retired.len(), 1, "the replaced chain was handed back");
}

#[test]
fn the_tempo_for_synced_effects_follows_the_score_or_falls_back() {
    // A delay in quarter notes: its echo is where the score's tempo puts it, and 120 bpm with
    // no score. Played through the transport, the echo of a short burst lands at the delay time.
    let echo_at = |bpm_score: Option<u64>| -> f64 {
        let mut settings = LineInSettings::default();
        settings.sound.effects.delay.enabled = true;
        settings.sound.effects.delay.quarter_notes = 1.0;
        settings.sound.effects.delay.mix = 0.5;
        settings.sound.effects.delay.feedback = 0.0;
        let mut rig = Rig::new(48_000.0, 48_000, &settings);
        if let Some(generation) = bpm_score {
            rig.transport.install(
                renderer(generation, 48_000, DocumentSettings::default()),
                generation,
                false,
            );
        }
        let mut trace = Vec::new();
        for n in 0..300 {
            // A burst of tone in the first 10 ms, silence after.
            if n < 1 {
                rig.feed(500.0, 0.5);
            } else {
                let count = 480;
                rig.producer.push_samples(&vec![0.0; count]);
                rig.producer.end_block(count);
            }
            rig.render();
            trace.extend(rig.block.iter().map(|f| f[0]));
        }
        // The last loud sample after the first quiet gap is the echo's end; its start is the delay.
        let loud: Vec<usize> = trace
            .iter()
            .enumerate()
            .filter(|(_, x)| x.abs() > 0.02)
            .map(|(i, _)| i)
            .collect();
        // Onset of the second group of sound.
        let gap = loud
            .windows(2)
            .find(|w| w[1] - w[0] > 4800)
            .map(|w| w[1])
            .expect("an echo");
        (gap - loud[0]) as f64 / 48_000.0
    };
    let fallback = echo_at(None);
    assert!((fallback - 0.5).abs() < 0.03, "120 bpm quarter: {fallback}");
    let score = echo_at(Some(1));
    // The test score is at 60 bpm: a quarter note is a second.
    assert!((score - 1.0).abs() < 0.03, "60 bpm quarter: {score}");
}

#[test]
fn heap_counting_sees_what_it_should() {
    // The counter itself works: an allocation inside is counted.
    let ((), operations) = counted(|| {
        let v = vec![1u8; 100];
        std::hint::black_box(&v);
    });
    assert!(operations >= 2);
}

/// A real renderer playing a loud steady note, so the score has content that must not change.
fn loud_score(generation: u64, rate: u32) -> Box<Renderer> {
    let mut font = Cursor::new(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
        ))
        .unwrap(),
    );
    let frames = (0..192_000)
        .map(|n| [((TAU * 110.0 * n as f64 / 48_000.0).sin() * 0.6) as f32; 2])
        .collect();
    let resources = AudioResources {
        manifest: InstrumentManifest {
            schema_version: 1,
            instruments: vec![Instrument {
                id: "green-guitar".into(),
                regions: vec![Region {
                    sample_id: "sine".into(),
                    root_key: 45,
                    key_low: 0,
                    key_high: 127,
                    velocity_low: 0,
                    velocity_high: 127,
                    articulation: "picked".into(),
                    variant: 1,
                    sequence_length: 1,
                    trigger: "attack".into(),
                    pitch_keytrack: 100.0,
                    velocity_gain_high: 127,
                    release_seconds: 0.1,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        },
        samples: HashMap::from([(
            "sine".into(),
            Arc::new(DecodedAudio {
                sample_rate: 48_000,
                channels: 2,
                frames: Arc::new(frames),
            }),
        )]),
        sound_font: Arc::new(rustysynth::SoundFont::new(&mut font).unwrap()),
    };
    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation":generation,"ppq":960,"durationTick":3840,"durationMs":2000,
        "tracks":[{"id":"t0","program":24,"percussion":false}],
        "tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
        "notes":[{"id":"n0","trackId":"t0",
            "source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},
            "occurrence":0,"startTick":0,"endTick":3840,"key":45,"velocity":127,
            "articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}],
        "midi":[]
    }))
    .unwrap();
    Box::new(
        Renderer::new(
            Arc::new(plan),
            Arc::new(resources),
            DocumentSettings::default(),
            rate,
        )
        .unwrap(),
    )
}

#[test]
fn an_attached_line_in_leaves_the_score_alone() {
    let play = |transport: &mut CallbackTransport| {
        transport.install(loud_score(1, 48_000), 1, false);
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
    };
    let mut plain = CallbackTransport::headless(48_000);
    play(&mut plain);
    // A guitar that is silent, and one that is quiet enough to stay inside full scale.
    let mut silent = Rig::new(48_000.0, 48_000, &LineInSettings::default());
    play(&mut silent.transport);
    let mut guitar = Rig::new(48_000.0, 48_000, &LineInSettings::default());
    play(&mut guitar.transport);
    let mut alone = Rig::new(48_000.0, 48_000, &LineInSettings::default());
    let mut score_peak = 0.0f32;
    let mut block = vec![[0.0f32; 2]; 480];
    for n in 0..150 {
        plain.render_into(&mut block);
        let expected = block.clone();
        score_peak = score_peak.max(peak(&expected));
        silent.feed(110.0, 0.0);
        silent.render();
        guitar.feed(330.0, 0.05);
        guitar.render();
        alone.feed(330.0, 0.05);
        alone.render();
        // The silent guitar adds exactly nothing.
        assert!(
            silent
                .block
                .iter()
                .zip(&expected)
                .all(|(a, b)| a[0] == b[0] && a[1] == b[1]),
            "block {n}"
        );
        // The quiet one adds exactly itself: take it away and the score is left, to the bit
        // the float addition allows.
        for ((with, only), score) in guitar.block.iter().zip(&alone.block).zip(&expected) {
            for c in 0..2 {
                assert!(
                    (with[c] - only[c] - score[c]).abs() < 2e-7,
                    "block {n}: {} {} {}",
                    with[c],
                    only[c],
                    score[c]
                );
            }
        }
    }
    assert!(score_peak > 0.3, "the score has content: {score_peak}");
    assert!(peak(&guitar.block) > score_peak * 0.0);
    // A guitar that would carry the sum past full scale is turned down, not the score.
    let mut loud = LineInSettings::default();
    loud.level = 1.0;
    let mut hot = Rig::new(48_000.0, 48_000, &loud);
    play(&mut hot.transport);
    let mut worst = 0.0f32;
    for _ in 0..150 {
        hot.feed(110.0, 1.0);
        hot.render();
        worst = worst.max(peak(&hot.block));
    }
    assert!(worst <= 1.0, "{worst}");
}

#[test]
fn large_device_callbacks_play_through_the_transport_without_chopping_or_allocating() {
    for (in_rate, out_rate) in [(48_000.0, 48_000), (96_000.0, 44_100), (44_100.0, 48_000)] {
        for frames in [1536usize, 4096] {
            let mut rig = Rig::new(in_rate, out_rate, &LineInSettings::default());
            rig.block = vec![[0.0; 2]; frames];
            let mut operations = 0;
            let mut loudest_late = 0.0f32;
            let mut quietest_late = f32::MAX;
            for n in 0..160 {
                // Everything the device delivered while the last callback was playing.
                rig.feed(220.0, 0.5);
                let (_, count) = counted(|| {
                    rig.transport.render_callback(&mut rig.block);
                    let retired = &mut rig.retired;
                    rig.transport.retire_line_in(|item| {
                        retired.push(item);
                        None
                    });
                });
                operations += count;
                if n >= 100 {
                    loudest_late = loudest_late.max(peak(&rig.block));
                    quietest_late = quietest_late.min(peak(&rig.block));
                }
            }
            assert_eq!(operations, 0, "{in_rate}->{out_rate} @ {frames}");
            assert_eq!(rig.meter.underruns(), 0, "{in_rate}->{out_rate} @ {frames}");
            assert_eq!(rig.meter.skips(), 0, "{in_rate}->{out_rate} @ {frames}");
            assert!(
                quietest_late > 0.3 && loudest_late < 0.5,
                "{in_rate}->{out_rate} @ {frames}: {quietest_late} {loudest_late}"
            );
        }
    }
}

/// A transport on a device with callbacks of `frames`, where the Line-In is attached only after
/// the first block of a callback has been rendered, as a message from the control side can be.
#[test]
fn a_monitor_attached_partway_through_a_callback_stays_in_step() {
    for (in_rate, out_rate) in [(48_000.0, 48_000), (44_100.0, 48_000)] {
        for frames in [1536usize, 4096] {
            let (mut transport, mut control) = CallbackTransport::headless_with_line_in(out_rate);
            let (mut producer, ring, meter) = monitor_channel(in_rate);
            let settings = LineInSettings::default();
            let mut written = 0usize;
            let feed = |producer: &mut LineInProducer, written: &mut usize| {
                let count = (frames as f64 / f64::from(out_rate) * in_rate) as usize;
                producer.push_samples(&sine(220.0, in_rate, *written, count, 0.5));
                producer.end_block(count);
                *written += count;
            };
            // Block 1 of a callback renders without it; the Attach lands before blocks 2 and 3.
            feed(&mut producer, &mut written);
            transport.set_device_frames(frames);
            let mut block = vec![[0.0f32; 2]; 512];
            transport.render_into(&mut block);
            control
                .attach(
                    LineInMonitor::new(ring.clone(), meter.clone(), &settings, out_rate).unwrap(),
                )
                .unwrap();
            let mut rest = frames - 512;
            while rest > 0 {
                let count = rest.min(512);
                transport.render_into(&mut block[..count]);
                assert!(
                    block[..count].iter().all(|f| f[0] == 0.0),
                    "silent until the next callback begins"
                );
                rest -= count;
            }
            // Then 40 s of ordinary callbacks.
            let mut callback = vec![[0.0f32; 2]; frames];
            let mut sound = Vec::new();
            let seconds = 40.0;
            let calls = (seconds * f64::from(out_rate) / frames as f64) as usize;
            for n in 0..calls {
                feed(&mut producer, &mut written);
                transport.render_callback(&mut callback);
                if n > calls / 2 {
                    sound.extend(callback.iter().map(|f| f[0]));
                }
            }
            assert_eq!(meter.underruns(), 0, "{in_rate}->{out_rate} @ {frames}");
            assert_eq!(meter.skips(), 0, "{in_rate}->{out_rate} @ {frames}");
            assert!(peak_of(&sound) > 0.35);
            // No dropouts in the second half: every 10 ms stretch has sound in it.
            let window = (out_rate / 100) as usize;
            let quiet = sound
                .chunks(window)
                .filter(|w| w.iter().fold(0.0f32, |p, x| p.max(x.abs())) < 0.05)
                .count();
            assert!(
                quiet * 20 < sound.len() / window,
                "{in_rate}->{out_rate} @ {frames}: {quiet} quiet stretches"
            );
        }
    }
}

fn peak_of(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0, |p, x| p.max(x.abs()))
}

/// The output callback itself, not just the transport inside it: the command and retirement
/// queues, the channel mapping and the Line-In, at the sizes real devices use.
#[test]
fn the_output_callback_itself_does_not_touch_the_heap_at_large_sizes() {
    for (in_rate, out_rate) in [(48_000.0, 48_000), (96_000.0, 44_100)] {
        for frames in [1536usize, 4096] {
            for channels in [1usize, 2, 6] {
                let mut output = HeadlessOutput::new(out_rate);
                let (mut producer, ring, meter) = monitor_channel(in_rate);
                output
                    .control()
                    .attach(
                        LineInMonitor::new(
                            ring,
                            meter.clone(),
                            &LineInSettings::default(),
                            out_rate,
                        )
                        .unwrap(),
                    )
                    .unwrap();
                let mut buffer = vec![0.0f32; frames * channels];
                let mut written = 0usize;
                let mut operations = 0;
                let mut freed = 0;
                for n in 0..120 {
                    let count = (frames as f64 / f64::from(out_rate) * in_rate) as usize;
                    producer.push_samples(&sine(220.0, in_rate, written, count, 0.5));
                    producer.end_block(count);
                    written += count;
                    if n == 40 {
                        // A new sound mid-run: the replaced chain is retired through the ring.
                        let mut changed = LineInSettings::default();
                        changed.sound = busy_sound();
                        output
                            .control()
                            .chain(build_chain(&changed.sound, out_rate).unwrap())
                            .unwrap();
                    }
                    let ((), count) = counted(|| output.render(&mut buffer, channels));
                    operations += count;
                    freed += output.free_retired();
                }
                assert_eq!(
                    operations, 0,
                    "{in_rate}->{out_rate} @ {frames} x {channels}"
                );
                assert!(freed >= 1, "the replaced chain went to the retirement ring");
                assert_eq!(
                    meter.underruns(),
                    0,
                    "{in_rate}->{out_rate} @ {frames} x {channels}"
                );
                let late = &buffer[..channels];
                let _ = late;
                assert!(
                    buffer.iter().step_by(channels).any(|x| x.abs() > 0.05),
                    "{in_rate}->{out_rate} @ {frames} x {channels}: sound"
                );
            }
        }
    }
}

#[test]
fn line_in_ignores_plugin_slot() {
    let mut settings = LineInSettings::default();
    settings.sound.plugin = Some(tabplayer_lib::settings::PluginSlot {
        format: tabplayer_lib::settings::PluginFormat::Vst3,
        class_id: "0123456789ABCDEF0123456789ABCDEF".into(),
        name: "Test".into(),
        vendor: "Test".into(),
        active: true,
        input_db: 0.0,
        output_db: 0.0,
        state: "a".repeat(64),
    });
    // Validation must refuse a plug-in slot per P37
    assert!(settings.validate().is_err());
    // And build_chain must refuse it as a second guard
    assert!(build_chain(&settings.sound, 48_000).is_err());
}
