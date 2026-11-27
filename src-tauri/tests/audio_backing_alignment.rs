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

/// The requirement for sustained audio against the score clock: 2 ms, 96 source frames at 48 kHz.
const WITHIN_2_MS: f64 = 96.0;
/// The 40 ms bursts used here are short against the stretcher's grains, so their first grains are still converging:
/// they are held to 3 ms (144 frames). Measured worst 100 (2.1 ms, at 2.5x). Bursts of 200 ms, in `audio_backing_stretch`,
/// are held to 2 ms.
const SHORT_BURST_3_MS: f64 = 144.0;
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
fn backing_tone_bursts_sit_on_the_score_in_a_partial_beat_loop_at_every_speed() {
    // Sustained backing audio goes through the grain stretcher, not the exact-impulse path. THE-57 re-centred it: the
    // stretcher aims each grain so the middle of its output is on the score clock, and the correlation search is
    // pulled toward that position. The error of each burst in score time (source frames) is therefore small at every
    // speed, and exactly 0 at 1.0x. The requirement is 2 ms (96 source frames at 48 kHz) for sustained audio and 3 ms for these short bursts.
    const BURSTS: [u32; 4] = [1920, 2880, 4320, 4800];
    const ROWS: [(f64, f64); 5] = [
        (0.1, SHORT_BURST_3_MS),
        (0.5, SHORT_BURST_3_MS),
        (1.0, 0.001),
        (1.7, SHORT_BURST_3_MS),
        (3.0, SHORT_BURST_3_MS),
    ];
    let mut report = Vec::new();
    for (ratio, bound) in ROWS {
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
            assert!(
                e.abs() <= bound,
                "ratio {ratio}: bound {bound}, got {errors:?}"
            );
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

// Fixed tempo with a backing (THE-57 decision 2). The backing follows the score clock exactly as in relative mode, so a
// fixed tempo F stretches it by F over the authored tempo at each point: here 120 BPM in bar 0 and 60 BPM in bar 1, so
// F = 90 plays the backing at 0.75x then 1.5x, F = 60 at 0.5x then 1.0x, F = 150 at 1.25x then 2.5x.
const FIXED: [f64; 3] = [60.0, 90.0, 150.0];

fn fixed(bpm: f64, frames: usize) -> Scenario {
    Scenario::new(PracticeTempo::Fixed { bpm }, frames)
}

#[test]
fn a_fixed_tempo_backing_lands_on_the_score_frame_across_a_tempo_change() {
    for bpm in FIXED {
        let (score, gaps) = impulse_gaps(&fixed(bpm, 420_000));
        assert!(score.len() >= 12, "fixed {bpm}: {score:?}");
        // The fixed tempo is really in force: ticks 0 and 960 are a beat of F BPM apart, not of the authored 120.
        assert_eq!(
            score[1] - score[0],
            (960.0 / (bpm * 16.0) * 48_000.0).round() as usize,
            "fixed {bpm}"
        );
        assert!(
            gaps.iter().all(|g| *g == 0),
            "fixed {bpm}: {score:?} {gaps:?}"
        );
    }
}

#[test]
fn a_fixed_tempo_backing_lands_on_the_score_frame_through_loop_wraps_seeks_count_ins_and_offsets() {
    for bpm in [90.0, 150.0] {
        let mut looped = fixed(bpm, 300_000);
        looped.loop_ticks = Some(LOOP_A);
        let mut seek = fixed(bpm, 300_000);
        seek.seek = Some(3200.0);
        let mut counted = fixed(bpm, 700_000);
        counted.loop_ticks = Some(LOOP_A);
        counted.count_bars = 1;
        counted.between = true;
        let mut offset = fixed(bpm, 300_000);
        offset.loop_ticks = Some(LOOP_A);
        offset.offset_ms = 100.0;
        for (name, scenario, events) in [
            ("loop", looped, 8),
            ("seek", seek, 4),
            ("count-in between loops", counted, 12),
            ("offset loop", offset, 8),
        ] {
            let (score, gaps) = impulse_gaps(&scenario);
            assert!(score.len() >= events, "fixed {bpm} {name}: {score:?}");
            assert!(
                gaps.iter().all(|g| *g == 0),
                "fixed {bpm} {name}: {score:?} {gaps:?}"
            );
        }
    }
}

#[test]
fn a_fixed_tempo_backing_loop_edges_play_as_in_relative_mode() {
    let reference = Scenario::new(PracticeTempo::Relative { ratio: 1.0 }, 90_000)
        .render(false, Content::Marked);
    let (start_level, end_level) = (
        reference[score_frames(1440)][0],
        reference[score_frames(3360)][0],
    );
    for bpm in [90.0, 150.0] {
        let mut scenario = fixed(bpm, 260_000);
        scenario.loop_ticks = Some(LOOP_A);
        let pcm = scenario.render(false, Content::Marked);
        let heard = |level: f32| pcm.iter().filter(|x| (x[0] - level).abs() < 0.02).count();
        assert_eq!(
            heard(end_level),
            0,
            "fixed {bpm}: the end-tick event is heard"
        );
        assert!(
            heard(start_level) >= 2,
            "fixed {bpm}: the start-tick event repeats each pass"
        );
    }
}

#[test]
fn fixed_tempo_tone_bursts_sit_on_the_score_across_a_tempo_change_and_loop_passes() {
    // As the relative-speed test, with the speed changing at tick 3840. The error is in source frames, at the speed
    // of the bar the burst is in (F / 120 in bar 0, F / 60 in bar 1).
    const BURSTS: [u32; 4] = [1920, 2880, 4320, 4800];
    for bpm in FIXED {
        let frames = (3.0 * 3500.0 / (bpm * 16.0) * 48_000.0) as usize + 20_000;
        let mut scenario = fixed(bpm, frames);
        scenario.loop_ticks = Some((1500.0, 5000.0));
        scenario.ticks = &BURSTS;
        let score = onsets(&scenario.render(true, Content::None));
        let backing = scenario.render(false, Content::Burst);
        assert!(score.len() >= 8, "fixed {bpm}: {score:?}");
        let ratios = BURSTS
            .iter()
            .cycle()
            .map(|&tick| if tick < 3840 { bpm / 120.0 } else { bpm / 60.0 });
        let errors: Vec<f64> = score
            .iter()
            .zip(ratios)
            .map(|(&s, ratio)| {
                (centroids(&backing, &[s], (3000.0 / ratio) as usize)[0] - s as f64) * ratio
            })
            .collect();
        for e in &errors {
            assert!(e.abs() <= SHORT_BURST_3_MS, "fixed {bpm}: {errors:?}");
        }
        for i in 4..errors.len() {
            assert!(
                (errors[i] - errors[i - 4]).abs() < 0.01,
                "fixed {bpm}: pass drift {errors:?}"
            );
        }
    }
}

#[test]
fn an_export_with_a_backing_lands_sustained_audio_where_playback_does() {
    use tabplayer_lib::export::{
        audio::{AudioExportRender, AudioExportRequest},
        stems::{StemKind, StemTrack},
        wav::AudioFormat,
    };
    // The export drives the same renderer and stretcher as playback (`set_speed`, then the same render), so it is
    // centred the same way: at 50% and at 170% the bursts sit within the playback requirement, and where playback puts
    // them to within a frame.
    const BURSTS: [u32; 4] = [1920, 2880, 4320, 4800];
    for speed in [0.5, 1.7] {
        let renderer = *renderer(&[], &BURSTS, false, Content::Burst, 0.0);
        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "guitar".into(),
                name: "Guitar".into(),
                preset: "gm".into(),
                kind: StemKind::Score,
            }],
            range: None,
            format: AudioFormat::wav(RATE, 24),
            speed,
            metronome: false,
            metronome_sound: Default::default(),
            tail_seconds: 0.0,
            include_backing: true,
            include_mix: true,
            normalize_rms_db: None,
        };
        let mut export = AudioExportRender::new(renderer, &plan(), request).unwrap();
        let mut exported = Vec::new();
        loop {
            let mut block = [[0.0f32; 2]; 512];
            let n = export.render_mix(&mut block).unwrap();
            if n == 0 {
                break;
            }
            exported.extend_from_slice(&block[..n]);
        }
        let played = Scenario::new(PracticeTempo::Relative { ratio: speed }, exported.len())
            .render(false, Content::Burst);
        // The score is silent here (no notes), so the expected frame of a burst is its tick's frame over the speed.
        let expected: Vec<usize> = BURSTS
            .iter()
            .map(|&tick| (score_frames(tick) as f64 / speed).round() as usize)
            .collect();
        let half = (3000.0 / speed) as usize;
        let from_export = centroids(&exported, &expected, half);
        let from_playback = centroids(&played, &expected, half);
        for ((e, p), want) in from_export.iter().zip(&from_playback).zip(&expected) {
            let (e, p) = ((e - *want as f64) * speed, (p - *want as f64) * speed);
            assert!(e.abs() <= WITHIN_2_MS, "speed {speed}: export error {e}");
            assert!(
                (e - p).abs() < 1.0,
                "speed {speed}: export {e}, playback {p}"
            );
        }
    }
}

fn fermata_plan(fermatas: &[(f64, f64, f64)]) -> PlaybackPlan {
    use tabplayer_lib::audio::plan::{PlanFermata, effective_tempos};

    let mut p = plan();
    let list: Vec<PlanFermata> = fermatas
        .iter()
        .map(|&(start_tick, end_tick, length)| PlanFermata {
            start_tick,
            end_tick,
            length,
        })
        .collect();
    let effective = effective_tempos(&p.tempos, Some(&list));
    let ms_at = |tick: f64| -> f64 {
        let mut secs = 0.0;
        let mut prev = 0.0;
        let mut bpm = effective[0].bpm;
        for t in &effective {
            if t.tick > tick {
                break;
            }
            secs += (t.tick - prev) * 60.0 / (960.0 * bpm);
            prev = t.tick;
            bpm = t.bpm;
        }
        (secs + (tick - prev) * 60.0 / (960.0 * bpm)) * 1000.0
    };
    p.fermatas = Some(list);
    for o in &mut p.occurrences {
        o.start_ms = ms_at(o.start_tick);
        o.end_ms = ms_at(o.end_tick);
    }
    p.duration_ms = ms_at(p.duration_tick);
    p.validate().unwrap();
    p
}

fn fermata_renderer(
    base_plan: &PlaybackPlan,
    note_ticks: &[u32],
    ticks: &[u32],
    score: bool,
    content: Content,
    offset_ms: f64,
    anchors: &[tabplayer_lib::settings::SyncAnchor],
) -> Box<Renderer> {
    use tabplayer_lib::audio::plan::Timeline;
    let mut plan = base_plan.clone();
    if score {
        let notes: Vec<_> = note_ticks
            .iter()
            .enumerate()
            .map(|(index, &tick)| {
                serde_json::json!({
                    "id": format!("q{index}"),
                    "trackId": "guitar",
                    "source": {"target": {"track": 0, "staff": 0, "bar": u32::from(tick >= 3840), "voice": 0, "beat": index}, "string": 1},
                    "occurrence": 0,
                    "startTick": tick,
                    "endTick": tick + 120,
                    "key": 57,
                    "velocity": 127,
                    "articulation": "picked",
                    "legatoFrom": null,
                    "pitch": [{"tick": tick, "semitones": 0}]
                })
            })
            .collect();
        let mut value = serde_json::to_value(&plan).unwrap();
        value["notes"] = serde_json::Value::Array(notes);
        plan = serde_json::from_value(value).unwrap();
    }
    let timeline = Timeline::new(&plan).unwrap();
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
        let total_secs = (timeline.tick_to_seconds(plan.duration_tick).ceil() as usize + 4).max(10);
        let mut frames = vec![[0.0f32; 2]; total_secs * RATE as usize];
        for &tick in ticks {
            let source_frame = if anchors.is_empty() {
                (timeline.tick_to_seconds(f64::from(tick)) * f64::from(RATE)).round() as i64
            } else {
                score_frames(tick) as i64
            };
            let at = source_frame - shift as i64;
            if at < 0 || (content == Content::Burst && at < 960) {
                continue;
            }
            let at = at as usize;
            match content {
                Content::Impulse => frames[at] = [1.0; 2],
                Content::Burst => {
                    for n in 0..1920usize {
                        let w = 0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / 1920.0).cos();
                        let s = (std::f64::consts::TAU * 1000.0 * n as f64 / f64::from(RATE)).sin()
                            * w
                            * 0.5;
                        frames[at - 960 + n] = [s as f32; 2];
                    }
                }
                _ => unreachable!(),
            }
        }
        renderer
            .install_backing(
                Arc::new(DecodedAudio {
                    sample_rate: RATE,
                    channels: 2,
                    frames: Arc::new(frames),
                }),
                BackingMap::new(anchors, offset_ms, &plan).unwrap(),
                Default::default(),
            )
            .unwrap();
    }
    Box::new(renderer)
}

fn render_fermata_transport(
    plan: &PlaybackPlan,
    ticks: &[u32],
    score: bool,
    content: Content,
    tempo: PracticeTempo,
    loop_ticks: Option<(f64, f64)>,
    seek: Option<f64>,
    count_bars: u8,
    offset_ms: f64,
    anchors: &[tabplayer_lib::settings::SyncAnchor],
    frames: usize,
) -> Vec<[f32; 2]> {
    let mut transport = CallbackTransport::headless(RATE);
    transport.install_with_practice(
        fermata_renderer(plan, ticks, ticks, score, content, offset_ms, anchors),
        1,
        false,
        PracticeSettings {
            tempo,
            metronome: MetronomeSettings {
                enabled: count_bars > 0,
                volume: 0.4,
                visual: false,
                sound: Default::default(),
            },
            count_in: CountInSettings {
                bars: count_bars,
                between_loops: false,
            },
            tonality: 0,
        },
    );
    if let Some((start_tick, end_tick)) = loop_ticks {
        transport
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick,
                end_tick,
            })
            .unwrap();
    }
    if let Some(tick) = seek {
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
    let mut pcm = vec![[0.0; 2]; frames];
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

#[test]
fn score_and_backing_stay_aligned_across_fermata_holds_in_relative_and_fixed_mode() {
    for length in [0.5, 1.0] {
        let p = fermata_plan(&[(1920.0, 2880.0, length)]);
        let tempos = [
            PracticeTempo::Relative { ratio: 0.5 },
            PracticeTempo::Relative { ratio: 1.0 },
            PracticeTempo::Relative { ratio: 1.7 },
            PracticeTempo::Fixed { bpm: 60.0 },
            PracticeTempo::Fixed { bpm: 90.0 },
            PracticeTempo::Fixed { bpm: 150.0 },
        ];
        for tempo in tempos {
            let frames = 600_000;
            let score = onsets(&render_fermata_transport(
                &p,
                &TICKS,
                true,
                Content::None,
                tempo,
                None,
                None,
                0,
                0.0,
                &[],
                frames,
            ));
            let backing = onsets(&render_fermata_transport(
                &p,
                &TICKS,
                false,
                Content::Impulse,
                tempo,
                None,
                None,
                0,
                0.0,
                &[],
                frames,
            ));
            assert!(
                score.len() >= 10,
                "length {length} tempo {tempo:?}: {score:?}"
            );
            let g = gaps(&score, &backing);
            let max_gap = match tempo {
                PracticeTempo::Relative { .. } if (length - 1.0).abs() < 1e-9 => 0,
                _ => 1,
            };
            assert!(
                g.iter().all(|d| d.abs() <= max_gap),
                "length {length} tempo {tempo:?}: {score:?} vs {backing:?} -> {g:?}"
            );
        }
    }

    // Tone bursts (sustained audio through the stretcher) remain within 3 ms across the fermata.
    const BURSTS: [u32; 4] = [960, 1920, 2880, 4800];
    let p = fermata_plan(&[(1920.0, 2880.0, 0.5)]);
    for tempo in [
        PracticeTempo::Relative { ratio: 0.5 },
        PracticeTempo::Relative { ratio: 1.0 },
        PracticeTempo::Fixed { bpm: 90.0 },
    ] {
        let frames = 400_000;
        let score = onsets(&render_fermata_transport(
            &p,
            &BURSTS,
            true,
            Content::None,
            tempo,
            None,
            None,
            0,
            0.0,
            &[],
            frames,
        ));
        let backing = render_fermata_transport(
            &p,
            &BURSTS,
            false,
            Content::Burst,
            tempo,
            None,
            None,
            0,
            0.0,
            &[],
            frames,
        );
        assert_eq!(score.len(), 4, "{tempo:?}: {score:?}");
        for (index, (&s, &tick)) in score.iter().zip(&BURSTS).enumerate() {
            let local_speed = match tempo {
                PracticeTempo::Relative { ratio } => ratio,
                PracticeTempo::Fixed { bpm } => {
                    let source_bpm = if tick < 1920 {
                        120.0
                    } else if tick < 2880 {
                        tabplayer_lib::audio::plan::fermata_effective_bpm(120.0, 0.5)
                    } else if tick < 3840 {
                        120.0
                    } else {
                        60.0
                    };
                    let target_bpm = if (1920..2880).contains(&tick) {
                        tabplayer_lib::audio::plan::fermata_effective_bpm(bpm, 0.5)
                    } else {
                        bpm
                    };
                    target_bpm / source_bpm
                }
                _ => unreachable!(),
            };
            let c = centroids(&backing, &[s], (3000.0 / local_speed) as usize)[0];
            let err_source_frames = (c - s as f64) * local_speed;
            assert!(
                err_source_frames.abs() <= SHORT_BURST_3_MS,
                "tempo {tempo:?} burst {index}: {err_source_frames}"
            );
        }
    }
}

#[test]
fn length_two_fermata_keeps_fixed_mode_validation_and_alignment() {
    use tabplayer_lib::audio::practice::AuthoredTempos;
    let p = fermata_plan(&[(1920.0, 2880.0, 2.0)]);
    // Authored tempos are still 60..120 BPM, so Fixed 90 BPM is valid with a backing track.
    PracticeSettings {
        tempo: PracticeTempo::Fixed { bpm: 90.0 },
        ..PracticeSettings::default()
    }
    .validate(Some(AuthoredTempos::of_plan(&p)))
    .unwrap();

    // Cross the exit of the length-2 fermata (1 BPM inside 1920..2880, 90 BPM from 2880).
    let near_exit = [2880u32, 3120, 3360];
    let frames = 120_000;
    let tempo = PracticeTempo::Fixed { bpm: 90.0 };
    let score = onsets(&render_fermata_transport(
        &p,
        &near_exit,
        true,
        Content::None,
        tempo,
        None,
        Some(2875.0),
        0,
        0.0,
        &[],
        frames,
    ));
    let backing = onsets(&render_fermata_transport(
        &p,
        &near_exit,
        false,
        Content::Impulse,
        tempo,
        None,
        Some(2875.0),
        0,
        0.0,
        &[],
        frames,
    ));
    assert_eq!(score.len(), 3, "{score:?}");
    assert_eq!(gaps(&score, &backing), vec![0, 0, 0]);
}

#[test]
fn fermata_partial_loops_seeks_offsets_count_in_export_and_anchors_align() {
    use tabplayer_lib::export::{
        audio::{AudioExportRender, AudioExportRequest},
        stems::{StemKind, StemTrack},
        wav::AudioFormat,
    };
    use tabplayer_lib::settings::SyncAnchor;

    let p = fermata_plan(&[(1920.0, 2880.0, 1.0)]);
    // Partial-beat loop spanning fermata, loop starting inside fermata, seek inside fermata, and 100 ms offset.
    for (name, tempo, loop_ticks, seek, offset_ms, min_events) in [
        (
            "rel loop span",
            PracticeTempo::Relative { ratio: 0.5 },
            Some((1440.0, 3360.0)),
            None,
            0.0,
            4,
        ),
        (
            "fixed loop span",
            PracticeTempo::Fixed { bpm: 90.0 },
            Some((1440.0, 3360.0)),
            None,
            0.0,
            6,
        ),
        (
            "loop inside fermata",
            PracticeTempo::Relative { ratio: 1.0 },
            Some((2160.0, 3360.0)),
            None,
            0.0,
            4,
        ),
        (
            "seek inside fermata",
            PracticeTempo::Fixed { bpm: 90.0 },
            None,
            Some(2160.0),
            100.0,
            4,
        ),
    ] {
        let frames = 500_000;
        let score = onsets(&render_fermata_transport(
            &p,
            &TICKS,
            true,
            Content::None,
            tempo,
            loop_ticks,
            seek,
            0,
            offset_ms,
            &[],
            frames,
        ));
        let backing = onsets(&render_fermata_transport(
            &p,
            &TICKS,
            false,
            Content::Impulse,
            tempo,
            loop_ticks,
            seek,
            0,
            offset_ms,
            &[],
            frames,
        ));
        assert!(score.len() >= min_events, "{name}: {score:?}");
        let max_gap = match tempo {
            PracticeTempo::Relative { .. } => 0,
            _ => 1,
        };
        assert!(
            gaps(&score, &backing).iter().all(|g| g.abs() <= max_gap),
            "{name}: {score:?} vs {backing:?}"
        );
    }

    // Count-in before a bar starting with a fermata clicks at the authored 120 BPM (24,000 frames), not the slowed fermata BPM.
    let bar0_fermata = fermata_plan(&[(0.0, 960.0, 1.0)]);
    let score_counted = render_fermata_transport(
        &bar0_fermata,
        &[960, 1920],
        true,
        Content::None,
        PracticeTempo::Relative { ratio: 1.0 },
        None,
        None,
        1,
        0.0,
        &[],
        300_000,
    );
    let backing_counted = render_fermata_transport(
        &bar0_fermata,
        &[960, 1920],
        false,
        Content::Impulse,
        PracticeTempo::Relative { ratio: 1.0 },
        None,
        None,
        1,
        0.0,
        &[],
        300_000,
    );
    // Count-in clicks sit in frames 0..96_000 (4 beats at 120 BPM = 2.0 s = 96,000 frames).
    let mut click_onsets = Vec::new();
    let mut last_click = None::<usize>;
    for (frame, x) in backing_counted[..95_000].iter().enumerate() {
        if x[0].abs() > 0.02 && last_click.is_none_or(|l| frame - l > 10_000) {
            click_onsets.push(frame);
            last_click = Some(frame);
        }
    }
    assert_eq!(click_onsets.len(), 4, "count-in clicks: {click_onsets:?}");
    for w in click_onsets.windows(2) {
        assert!(
            (w[1] as i64 - w[0] as i64 - 24_000).abs() <= 2,
            "count-in spacing: {click_onsets:?}"
        );
    }
    let score_after = onsets(&score_counted[95_500..]);
    let backing_after = onsets(&backing_counted[95_500..]);
    assert_eq!(gaps(&score_after, &backing_after), vec![0, 0]);

    // AudioExportRender with a fermata + backing matches playback to within 1 frame.
    const EXPORT_BURSTS: [u32; 3] = [960, 1920, 2880];
    for speed in [0.5, 1.7] {
        let r = *fermata_renderer(&p, &[], &EXPORT_BURSTS, false, Content::Burst, 0.0, &[]);
        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "guitar".into(),
                name: "Guitar".into(),
                preset: "gm".into(),
                kind: StemKind::Score,
            }],
            range: Some(tabplayer_lib::export::audio::MeasureRange { first: 0, last: 0 }),
            format: AudioFormat::wav(RATE, 24),
            speed,
            metronome: false,
            metronome_sound: Default::default(),
            tail_seconds: 0.0,
            include_backing: true,
            include_mix: true,
            normalize_rms_db: None,
        };
        let mut export = AudioExportRender::new(r, &p, request).unwrap();
        let mut exported = Vec::new();
        loop {
            let mut block = [[0.0f32; 2]; 512];
            let n = export.render_mix(&mut block).unwrap();
            if n == 0 {
                break;
            }
            exported.extend_from_slice(&block[..n]);
        }
        let played = render_fermata_transport(
            &p,
            &EXPORT_BURSTS,
            false,
            Content::Burst,
            PracticeTempo::Relative { ratio: speed },
            None,
            None,
            0,
            0.0,
            &[],
            exported.len(),
        );
        let expected: Vec<usize> = onsets(&render_fermata_transport(
            &p,
            &EXPORT_BURSTS,
            true,
            Content::None,
            PracticeTempo::Relative { ratio: speed },
            None,
            None,
            0,
            0.0,
            &[],
            exported.len(),
        ));
        assert_eq!(expected.len(), 3);
        let from_export = centroids(&exported, &expected, 2000);
        let from_playback = centroids(&played, &expected, 2000);
        for (e, p_val) in from_export.iter().zip(&from_playback) {
            assert!(
                (e - p_val).abs() < 1.0,
                "speed {speed}: export {e} vs playback {p_val}"
            );
        }
    }

    // Anchored un-held backing stretches across the fermata and lands beat 3 & beat 4 on the exact score frame.
    let anchors = [
        SyncAnchor {
            bar: 0,
            occurrence: 0,
            ratio: 0.5,
            audio_ms: 1000.0,
        },
        SyncAnchor {
            bar: 0,
            occurrence: 0,
            ratio: 0.75,
            audio_ms: 1500.0,
        },
    ];
    let anchor_ticks = [1920u32, 2880];
    let frames = 200_000;
    let score = onsets(&render_fermata_transport(
        &p,
        &anchor_ticks,
        true,
        Content::None,
        PracticeTempo::Relative { ratio: 1.0 },
        None,
        None,
        0,
        0.0,
        &anchors,
        frames,
    ));
    let backing = onsets(&render_fermata_transport(
        &p,
        &anchor_ticks,
        false,
        Content::Impulse,
        PracticeTempo::Relative { ratio: 1.0 },
        None,
        None,
        0,
        0.0,
        &anchors,
        frames,
    ));
    assert_eq!(score.len(), 2);
    assert_eq!(gaps(&score, &backing), vec![0, 0]);
}
