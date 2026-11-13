//! THE-57 / P20: where the backing sits against the score when a loop starts or ends inside a beat, at each speed, after
//! a seek, and under a count-in. The score is a recorded one-sample guitar attack on each chosen tick; the backing is
//! rendered in a second, identical run (so the two never sum) with an isolated impulse or a tone burst on the same ticks.
//! Alignment is the difference between where the two runs put each event, in output frames.
use std::{path::PathBuf, sync::Arc};
use tabplayer_lib::{
    audio::{
        backing::BackingMap,
        decode::DecodedAudio,
        device::{CallbackTransport, PracticeSettings, TransportCommand},
        plan::PlaybackPlan,
        practice::{CountInSettings, MetronomeSettings, PracticeTempo},
        renderer::Renderer,
        resources::{AudioResources, Instrument, Region},
    },
    settings::DocumentSettings,
};

const RATE: u32 = 48_000;
/// Every event of the score: partial-beat ticks (1440, 3120, 3360, 4560, 5400) among whole beats. Bar 0 is 120 BPM
/// (25 frames per tick), bar 1 is 60 BPM (50 frames per tick), so every tick is a whole frame of score time.
const TICKS: [u32; 14] = [
    0, 960, 1440, 1920, 2400, 2880, 3120, 3360, 3840, 4320, 4560, 4800, 5400, 6720,
];

#[derive(Clone, Copy, PartialEq)]
enum Content {
    None,
    Impulse,
    /// Impulses of three different heights: 0.9 on tick 1440, 0.5 on tick 3360, 0.7 elsewhere.
    Marked,
    Burst,
}

fn score_frames(tick: u32) -> usize {
    if tick < 3840 {
        tick as usize * 25
    } else {
        96_000 + (tick as usize - 3840) * 50
    }
}

fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":6000,"tracks":[{"id":"guitar","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120},{"tick":3840,"bpm":60}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":6000}],"notes":[],"midi":[]})).unwrap()
}

fn renderer(
    note_ticks: &[u32],
    ticks: &[u32],
    score: bool,
    content: Content,
    offset_ms: f64,
) -> Box<Renderer> {
    let notes: Vec<_> = note_ticks.iter().enumerate().map(|(index, &tick)| {
        serde_json::json!({"id":format!("q{index}"),"trackId":"guitar","source":{"target":{"track":0,"staff":0,"bar":u32::from(tick >= 3840),"voice":0,"beat":index},"string":1},"occurrence":0,"startTick":tick,"endTick":tick + 120,"key":57,"velocity":127,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":tick,"semitones":0}]})
    }).collect();
    let mut plan = plan();
    if score {
        let mut value = serde_json::to_value(&plan).unwrap();
        value["notes"] = serde_json::Value::Array(notes);
        plan = serde_json::from_value(value).unwrap();
    }
    let mut resources = AudioResources::load_for_requests(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
        &[],
    )
    .unwrap();
    resources.manifest.instruments = vec![Instrument {
        id: "green-guitar".into(),
        regions: vec![Region {
            sample_id: "impulse".into(),
            root_key: 57,
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
            ..Default::default()
        }],
        ..Default::default()
    }];
    let mut impulse = vec![[0.0; 2]; 480];
    impulse[0] = [1.0; 2];
    resources.samples.insert(
        "impulse".into(),
        Arc::new(DecodedAudio {
            sample_rate: RATE,
            channels: 2,
            frames: Arc::new(impulse),
        }),
    );
    let plan = Arc::new(plan);
    let mut renderer = Renderer::new(
        plan.clone(),
        Arc::new(resources),
        DocumentSettings::default(),
        RATE,
    )
    .unwrap();
    if content != Content::None {
        let shift = (offset_ms / 1000.0 * f64::from(RATE)).round() as usize;
        let mut frames = vec![[0.0f32; 2]; 8 * RATE as usize];
        for &tick in ticks {
            // The map reads source = score - offset, so an event meant for score time S sits at S - offset in the
            // file. One that would fall before the file's start (or its burst before it) is left out.
            let at = score_frames(tick) as i64 - shift as i64;
            if at < 0 || content == Content::Burst && at < 960 {
                continue;
            }
            let at = at as usize;
            match content {
                Content::Impulse => frames[at] = [1.0; 2],
                Content::Marked => {
                    let height = match tick {
                        1440 => 0.9,
                        3360 => 0.5,
                        _ => 0.7,
                    };
                    frames[at] = [height; 2];
                }
                Content::Burst => {
                    // 40 ms of 1 kHz under a Hann window, centred on the event.
                    for n in 0..1920usize {
                        let w = 0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / 1920.0).cos();
                        let s = (std::f64::consts::TAU * 1000.0 * n as f64 / f64::from(RATE)).sin()
                            * w
                            * 0.5;
                        frames[at - 960 + n] = [s as f32; 2];
                    }
                }
                Content::None => unreachable!(),
            }
        }
        renderer
            .install_backing(
                Arc::new(DecodedAudio {
                    sample_rate: RATE,
                    channels: 2,
                    frames: Arc::new(frames),
                }),
                BackingMap::new(&[], offset_ms, &plan).unwrap(),
                Default::default(),
            )
            .unwrap();
    }
    Box::new(renderer)
}

fn settings(tempo: PracticeTempo, bars: u8, between_loops: bool) -> PracticeSettings {
    PracticeSettings {
        tempo,
        metronome: MetronomeSettings {
            enabled: false,
            volume: 0.4,
            visual: false,
            sound: Default::default(),
        },
        count_in: CountInSettings {
            bars,
            between_loops,
        },
        tonality: 0,
    }
}

struct Scenario {
    tempo: PracticeTempo,
    loop_ticks: Option<(f64, f64)>,
    seek: Option<f64>,
    count_bars: u8,
    between: bool,
    frames: usize,
    ticks: &'static [u32],
    /// Where the score's own notes sit when that is not where the backing's events are (a swung feel).
    note_ticks: Option<&'static [u32]>,
    offset_ms: f64,
}

impl Scenario {
    fn new(tempo: PracticeTempo, frames: usize) -> Self {
        Self {
            tempo,
            loop_ticks: None,
            seek: None,
            count_bars: 0,
            between: false,
            frames,
            ticks: &TICKS,
            note_ticks: None,
            offset_ms: 0.0,
        }
    }
    fn render(&self, score: bool, content: Content) -> Vec<[f32; 2]> {
        let mut transport = CallbackTransport::headless(RATE);
        transport.install_with_practice(
            renderer(
                self.note_ticks.unwrap_or(self.ticks),
                self.ticks,
                score,
                content,
                self.offset_ms,
            ),
            1,
            false,
            settings(self.tempo, self.count_bars, self.between),
        );
        if let Some((start_tick, end_tick)) = self.loop_ticks {
            transport
                .command(TransportCommand::SetLoop {
                    generation: 1,
                    start_tick,
                    end_tick,
                })
                .unwrap();
        }
        if let Some(tick) = self.seek {
            transport
                .command(TransportCommand::SeekTick {
                    generation: 1,
                    tick,
                })
                .unwrap();
        }
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let mut pcm = vec![[0.0; 2]; self.frames];
        let mut offset = 0;
        for size in [127, 511, 1024].into_iter().cycle() {
            let end = (offset + size).min(pcm.len());
            transport.render_into(&mut pcm[offset..end]);
            offset = end;
            if offset == pcm.len() {
                break;
            }
        }
        pcm
    }
}

/// The first frame of each run of loud frames; a run ends after 200 quiet frames.
fn onsets(pcm: &[[f32; 2]]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut last: Option<usize> = None;
    for (frame, x) in pcm.iter().enumerate() {
        if x[0].abs() > 0.3 {
            if last.is_none_or(|l| frame - l > 200) {
                out.push(frame);
            }
            last = Some(frame);
        }
    }
    out
}

/// How far each backing event is from the score event of the same index, in frames.
fn gaps(score: &[usize], backing: &[usize]) -> Vec<i64> {
    assert_eq!(
        score.len(),
        backing.len(),
        "score {score:?}\nbacking {backing:?}"
    );
    score
        .iter()
        .zip(backing)
        .map(|(s, b)| *b as i64 - *s as i64)
        .collect()
}

fn impulse_gaps(scenario: &Scenario) -> (Vec<usize>, Vec<i64>) {
    let score = onsets(&scenario.render(true, Content::None));
    let backing = onsets(&scenario.render(false, Content::Impulse));
    let gaps = gaps(&score, &backing);
    (score, gaps)
}

/// The centroid of the energy in `pcm` within `half` frames of each expected frame.
fn centroids(pcm: &[[f32; 2]], around: &[usize], half: usize) -> Vec<f64> {
    around
        .iter()
        .map(|&centre| {
            let from = centre.saturating_sub(half);
            let to = (centre + half).min(pcm.len());
            let (mut sum, mut weight) = (0.0f64, 0.0f64);
            for (frame, x) in pcm.iter().enumerate().take(to).skip(from) {
                let e = f64::from(x[0]) * f64::from(x[0]);
                sum += e * frame as f64;
                weight += e;
            }
            if weight < 1e-6 {
                f64::NAN
            } else {
                sum / weight
            }
        })
        .collect()
}

const LOOP_A: (f64, f64) = (1440.0, 3360.0);
const LOOP_B: (f64, f64) = (3120.0, 4560.0);

#[test]
fn backing_transients_land_on_the_score_frame_in_a_loop_that_starts_and_ends_inside_a_beat() {
    for ratio in [0.5, 1.0, 1.7] {
        for (name, loop_ticks, frames) in [("A", LOOP_A, 300_000), ("B", LOOP_B, 340_000)] {
            let mut scenario = Scenario::new(PracticeTempo::Relative { ratio }, frames);
            scenario.loop_ticks = Some(loop_ticks);
            let (score, gaps) = impulse_gaps(&scenario);
            eprintln!(
                "loop {name} ratio {ratio}: {} events, gaps {gaps:?}",
                score.len()
            );
            assert!(score.len() >= 8, "loop {name} ratio {ratio}: {score:?}");
            assert!(
                gaps.iter().all(|g| *g == 0),
                "loop {name} ratio {ratio}: score {score:?} gaps {gaps:?}"
            );
        }
    }
}

#[test]
fn the_backing_event_on_the_loop_start_plays_and_the_one_on_the_loop_end_does_not() {
    // The two edges of loop A carry events of different heights (start tick 1440: 0.9, end tick 3360: 0.5, the rest
    // 0.7), so which one is heard is read from the sample value itself, not from a count that a merged pair of onsets
    // would leave unchanged. What each height comes out as after the mix is taken from one unlooped reference run.
    let reference = {
        let scenario = Scenario::new(PracticeTempo::Relative { ratio: 1.0 }, 90_000);
        scenario.render(false, Content::Marked)
    };
    let start_level = reference[score_frames(1440)][0];
    let end_level = reference[score_frames(3360)][0];
    let middle_level = reference[score_frames(1920)][0];
    assert!(
        (start_level - end_level).abs() > 0.1 && (middle_level - end_level).abs() > 0.1,
        "levels {start_level} {middle_level} {end_level}"
    );
    for ratio in [0.5, 1.0, 1.7] {
        let mut scenario = Scenario::new(PracticeTempo::Relative { ratio }, 260_000);
        scenario.loop_ticks = Some(LOOP_A);
        let pcm = scenario.render(false, Content::Marked);
        let near = |level: f32| -> Vec<usize> {
            pcm.iter()
                .enumerate()
                .filter(|(_, x)| (x[0] - level).abs() < 0.02)
                .map(|(frame, _)| frame)
                .collect()
        };
        let (starts, ends, middles) = (near(start_level), near(end_level), near(middle_level));
        // Pass length in output frames: 1440..3360 is 48,000 score frames.
        let pass = (48_000.0 / ratio) as usize;
        assert!(
            ends.is_empty(),
            "ratio {ratio}: end-tick event heard at {ends:?}"
        );
        assert!(starts.len() >= 2, "ratio {ratio}: {starts:?}");
        assert_eq!(
            starts[0], 0,
            "ratio {ratio}: first pass starts on the event"
        );
        assert!(
            starts[1].abs_diff(pass) <= 1,
            "ratio {ratio}: second pass starts at {}, pass {pass}",
            starts[1]
        );
        // Four whole-pass events (1920, 2400, 2880, 3120) between each pair of starts.
        assert!(middles.len() >= 8, "ratio {ratio}: {middles:?}");
    }
}

#[test]
fn backing_tone_bursts_sit_a_fixed_musical_time_off_the_score_in_a_partial_beat_loop() {
    // Sustained backing audio goes through the grain stretcher, not the exact-impulse path. It is not sample aligned
    // away from 1.0x: it is early below 1.0x and late above it, by an amount that in score time (source frames)
    // is bounded by the search window, 256 + 256 * |1 - ratio|, and that measured within about 6% of it. Each row is
    // (ratio, sign, lowest accepted, highest accepted) in source frames; the highest is that structural maximum plus
    // a few frames, the lowest is about 10% under the smallest value measured. Measured worst, 8 bursts apiece:
    // 463.0 (0.1), 366.3 (0.5), 403.8 (1.7), 765.0 (3.0).
    const BURSTS: [u32; 4] = [1920, 2880, 4320, 4800];
    const ROWS: [(f64, f64, f64, f64); 5] = [
        (0.1, -1.0, 415.0, 490.0),
        (0.5, -1.0, 325.0, 390.0),
        (1.0, 0.0, 0.0, 0.001),
        (1.7, 1.0, 350.0, 440.0),
        (3.0, 1.0, 560.0, 775.0),
    ];
    let mut report = Vec::new();
    for (ratio, sign, low, high) in ROWS {
        // Three passes of the loop 1500..5000 (116,500 score frames, divided by the speed), so at least two whole
        // passes of four bursts are measured at every speed.
        let frames = (116_500.0 / ratio * 3.0) as usize;
        let mut scenario = Scenario::new(PracticeTempo::Relative { ratio }, frames);
        scenario.loop_ticks = Some((1500.0, 5000.0));
        scenario.ticks = &BURSTS;
        let score = onsets(&scenario.render(true, Content::None));
        let backing = scenario.render(false, Content::Burst);
        let centres = centroids(&backing, &score, (3000.0 / ratio) as usize);
        let errors: Vec<f64> = centres
            .iter()
            .zip(&score)
            .map(|(c, s)| (c - *s as f64) * ratio)
            .collect();
        report.push(format!("ratio {ratio}: errors {errors:?}"));
        assert!(errors.len() >= 8, "ratio {ratio}: {} bursts", errors.len());
        for e in &errors {
            assert!(e.is_finite(), "ratio {ratio}: {errors:?}");
            if sign == 0.0 {
                assert!(e.abs() <= high, "ratio {ratio}: {errors:?}");
            } else {
                assert!(
                    e.signum() == sign && (low..=high).contains(&e.abs()),
                    "ratio {ratio}: expected sign {sign} and {low}..{high}, got {errors:?}"
                );
            }
        }
        // No drift: each pass reproduces the previous pass burst for burst, to a hundredth of a frame.
        for i in 4..errors.len() {
            assert!(
                (errors[i] - errors[i - 4]).abs() < 0.01,
                "ratio {ratio}: burst {i} differs from the pass before: {errors:?}"
            );
        }
    }
    eprintln!(
        "{}",
        report.join(
            "
"
        )
    );
}

#[test]
fn a_swung_feel_moves_the_score_and_not_the_backing() {
    // A triplet feel moves written notes to other ticks. The bars and tempos are untouched, so the backing is too.
    const STRAIGHT: [u32; 4] = [0, 480, 960, 1440];
    const SWUNG: [u32; 4] = [0, 640, 960, 1600];
    for ratio in [0.5, 1.0] {
        let mut straight = Scenario::new(PracticeTempo::Relative { ratio }, 120_000);
        straight.ticks = &STRAIGHT;
        let mut swung = Scenario::new(PracticeTempo::Relative { ratio }, 120_000);
        swung.ticks = &STRAIGHT;
        swung.note_ticks = Some(&SWUNG);
        let backing = onsets(&straight.render(false, Content::Impulse));
        assert_eq!(
            backing,
            onsets(&swung.render(false, Content::Impulse)),
            "ratio {ratio}"
        );
        let plain = onsets(&straight.render(true, Content::None));
        let moved = onsets(&swung.render(true, Content::None));
        assert_eq!(plain, backing, "ratio {ratio}");
        // 160 ticks is 4,000 score frames: 4,000 / ratio output frames.
        let shift = (4000.0 / ratio) as i64;
        assert_eq!(moved[1] as i64 - plain[1] as i64, shift, "ratio {ratio}");
        assert_eq!(moved[3] as i64 - plain[3] as i64, shift, "ratio {ratio}");
        assert_eq!(moved[2], plain[2], "ratio {ratio}");
    }
}

#[test]
fn a_seek_into_the_middle_of_a_beat_starts_the_backing_where_the_score_starts() {
    for ratio in [0.5, 1.0, 1.7] {
        let mut scenario = Scenario::new(PracticeTempo::Relative { ratio }, 150_000);
        scenario.seek = Some(3200.0);
        let (score, gaps) = impulse_gaps(&scenario);
        assert!(score.len() >= 4, "ratio {ratio}: {score:?}");
        assert!(
            gaps.iter().all(|g| *g == 0),
            "ratio {ratio}: {score:?} {gaps:?}"
        );
    }
}

#[test]
fn a_count_in_between_partial_beat_loop_passes_resumes_the_backing_with_the_score() {
    for ratio in [0.5, 1.0] {
        let mut scenario = Scenario::new(PracticeTempo::Relative { ratio }, 900_000);
        scenario.loop_ticks = Some(LOOP_A);
        scenario.count_bars = 1;
        scenario.between = true;
        let (score, gaps) = impulse_gaps(&scenario);
        assert!(score.len() >= 12, "ratio {ratio}: {score:?}");
        assert!(
            gaps.iter().all(|g| *g == 0),
            "ratio {ratio}: {score:?} {gaps:?}"
        );
    }
}

#[test]
fn an_offset_backing_follows_a_partial_beat_loop_by_its_offset() {
    for ratio in [0.5, 1.0] {
        let mut scenario = Scenario::new(PracticeTempo::Relative { ratio }, 300_000);
        scenario.loop_ticks = Some(LOOP_A);
        scenario.offset_ms = 100.0;
        let (score, gaps) = impulse_gaps(&scenario);
        assert!(score.len() >= 8, "ratio {ratio}: {score:?}");
        assert!(
            gaps.iter().all(|g| *g == 0),
            "ratio {ratio}: {score:?} {gaps:?}"
        );
    }
}
