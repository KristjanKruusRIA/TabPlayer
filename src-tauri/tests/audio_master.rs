//! The master chain on the mixed output: bit-exact when untouched, a limiter that holds its ceiling, level and balance,
//! the effects, changes that do not click, and nothing on the heap.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::HashMap,
    f64::consts::TAU,
    io::Cursor,
    sync::Arc,
};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        master::MasterBus,
        plan::PlaybackPlan,
        renderer::{PreparedMix, Renderer, master_limit},
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
    },
    settings::{DocumentSettings, MasterSettings},
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

const RATES: [u32; 2] = [44_100, 48_000];

fn master(edit: impl FnOnce(&mut MasterSettings)) -> MasterSettings {
    let mut settings = MasterSettings::default();
    edit(&mut settings);
    settings
}
fn db(value: f64) -> f64 {
    20.0 * value.max(1e-12).log10()
}
fn ceiling(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

/// Several tracks holding the same loud steady note, to play through a real renderer.
fn loud_scene(tracks: usize) -> (Arc<PlaybackPlan>, Arc<AudioResources>) {
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
    let ids: Vec<String> = (0..tracks).map(|i| format!("t{i}")).collect();
    let plan = serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
        "tracks":ids.iter().map(|id| serde_json::json!({"id":id,"program":24,"percussion":false})).collect::<Vec<_>>(),
        "tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
        "notes":ids.iter().enumerate().map(|(i, id)| serde_json::json!({
            "id":format!("n{i}"),"trackId":id,
            "source":{"target":{"track":i,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},
            "occurrence":0,"startTick":0,"endTick":3840,"key":45,"velocity":127,
            "articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]
        })).collect::<Vec<_>>(),
        "midi":[]
    }))
    .unwrap();
    (Arc::new(plan), Arc::new(resources))
}
fn with_master(master: Option<MasterSettings>) -> DocumentSettings {
    DocumentSettings {
        master,
        ..Default::default()
    }
}

/// Renders `frames` frames in the callback's block size, settling a parked mix before each block as the callback does.
fn render(renderer: &mut Renderer, frames: usize) -> Vec<[f32; 2]> {
    let mut out = Vec::with_capacity(frames);
    while out.len() < frames {
        drop(renderer.settle_mix());
        let mut block = [[0.0f32; 2]; 64];
        renderer.render_into(&mut block);
        out.extend_from_slice(&block);
    }
    out.truncate(frames);
    out
}
fn peak(frames: &[[f32; 2]]) -> f32 {
    frames
        .iter()
        .flat_map(|f| f.iter())
        .fold(0.0, |m, v| m.max(v.abs()))
}

/// What the mix was before the master existed: every stem summed in order, then the fixed soft limit.
#[test]
fn an_untouched_master_leaves_the_mix_bit_for_bit_as_it_was() {
    let (plan, resources) = loud_scene(4);
    let neutral = [
        None,
        Some(MasterSettings::default()),
        // Numbers behind blocks that are switched off are not a setting.
        Some(master(|m| {
            m.compressor.threshold_db = -40.0;
            m.compressor.ratio = 10.0;
            m.eq.low_db = 12.0;
            m.reverb.mix = 1.0;
            m.limiter.ceiling_db = -12.0;
        })),
    ];
    for rate in RATES {
        for settings in &neutral {
            for metronome in [false, true] {
                let mut renderer = Renderer::new(
                    plan.clone(),
                    resources.clone(),
                    with_master(settings.clone()),
                    rate,
                )
                .unwrap();
                renderer.set_metronome(metronome);
                let stems = 4 + usize::from(metronome);
                let frames = rate as usize / 2;
                let mut outputs = vec![vec![[0.0f32; 2]; frames]; stems];
                let mut views: Vec<&mut [[f32; 2]]> =
                    outputs.iter_mut().map(|o| o.as_mut_slice()).collect();
                let mut mix = vec![[0.0f32; 2]; frames];
                renderer.render_stems_and_mix_until(&mut views, &mut mix, f64::INFINITY);
                let mut loud = 0;
                for n in 0..frames {
                    let mut sum = [0.0f32; 2];
                    for stem in &outputs {
                        for c in 0..2 {
                            sum[c] += stem[n][c];
                        }
                    }
                    let legacy = sum.map(master_limit);
                    assert_eq!(
                        mix[n].map(f32::to_bits),
                        legacy.map(f32::to_bits),
                        "frame {n} at {rate}, metronome {metronome}"
                    );
                    loud += usize::from(sum[0].abs() > 0.9);
                }
                assert!(loud > frames / 4, "the scene must reach the soft limit");
            }
        }
    }
}

#[test]
fn a_neutral_master_stays_neutral_through_a_change_to_another_neutral_master() {
    let (plan, resources) = loud_scene(4);
    let mut plain =
        Renderer::new(plan.clone(), resources.clone(), with_master(None), 48_000).unwrap();
    let mut swapped =
        Renderer::new(plan.clone(), resources.clone(), with_master(None), 48_000).unwrap();
    // Whole blocks, so the two renderers stay on the same frames.
    let a = render(&mut plain, 24_064);
    let b = render(&mut swapped, 6_016);
    let mix =
        PreparedMix::prepare(&with_master(Some(MasterSettings::default())), &plan, 48_000).unwrap();
    drop(swapped.replace_mix(mix));
    let b: Vec<_> = b.into_iter().chain(render(&mut swapped, 18_048)).collect();
    // The track mixes also glide on a swap, but to the same values, so nothing differs.
    assert_eq!(
        a.iter().map(|f| f.map(f32::to_bits)).collect::<Vec<_>>(),
        b.iter().map(|f| f.map(f32::to_bits)).collect::<Vec<_>>()
    );
}

#[test]
fn the_limiter_never_passes_its_ceiling() {
    let (plan, resources) = loud_scene(4);
    for rate in RATES {
        let mut open =
            Renderer::new(plan.clone(), resources.clone(), with_master(None), rate).unwrap();
        let unlimited = peak(&render(&mut open, rate as usize / 2));
        assert!(unlimited > 0.95, "the scene is hot: {unlimited}");
        for ceiling_db in [-12.0, -6.0, -3.0, -1.0, 0.0] {
            for release_ms in [10.0, 100.0, 1000.0] {
                for level in [0.0, 12.0] {
                    let settings = master(|m| {
                        m.gain_db = level;
                        m.limiter.enabled = true;
                        m.limiter.ceiling_db = ceiling_db;
                        m.limiter.release_ms = release_ms;
                    });
                    let mut renderer = Renderer::new(
                        plan.clone(),
                        resources.clone(),
                        with_master(Some(settings)),
                        rate,
                    )
                    .unwrap();
                    renderer.set_metronome(true);
                    let out = render(&mut renderer, rate as usize / 2);
                    let top = peak(&out);
                    let limit = ceiling(ceiling_db);
                    assert!(
                        top <= limit,
                        "{ceiling_db} dB, {release_ms} ms, {level} dB up at {rate}: {top} over {limit}"
                    );
                    assert!(
                        top >= limit.min(0.9) * 0.8,
                        "{ceiling_db} dB: the limiter must leave the loud part sounding, {top}"
                    );
                }
            }
        }
    }
}

#[test]
fn the_limiter_holds_its_ceiling_against_anything_it_is_fed() {
    for rate in RATES {
        for ceiling_db in [-12.0, -6.0, -0.5, 0.0] {
            let mut bus = MasterBus::new(
                Some(&master(|m| {
                    m.limiter.enabled = true;
                    m.limiter.ceiling_db = ceiling_db;
                    m.limiter.release_ms = 10.0;
                })),
                rate,
            )
            .unwrap();
            let limit = ceiling(ceiling_db);
            let mut state = 0x1234_5678u32;
            let mut worst = 0.0f32;
            for n in 0..rate as usize * 2 {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let noise = state as f32 / u32::MAX as f32 * 2.0 - 1.0;
                // Noise, a swept sine far past full scale, lone spikes, and values no mix should hold.
                let x = match n % 4_000 {
                    0 => [8.0, -8.0],
                    1 => [f32::NAN, 3.0],
                    2 => [f32::INFINITY, f32::NEG_INFINITY],
                    3 => [1.0e30, -1.0e30],
                    _ => {
                        let sweep =
                            ((n as f64 * 0.02 + (n as f64 * 1e-4).powi(2)).sin() * 4.0) as f32;
                        [sweep + noise, noise * 5.0]
                    }
                };
                let y = bus.limit(x);
                assert!(y[0].is_finite() && y[1].is_finite());
                worst = worst.max(y[0].abs()).max(y[1].abs());
            }
            assert!(
                worst <= limit,
                "{ceiling_db} dB at {rate}: {worst} over {limit}"
            );
            assert!(
                worst > limit * 0.9,
                "{ceiling_db} dB held the signal down to {worst}"
            );
        }
    }
}

#[test]
fn a_limiter_switched_on_or_lowered_holds_its_ceiling_once_the_change_has_settled() {
    for rate in RATES {
        let limited = |ceiling_db: f64| {
            master(|m| {
                m.limiter.enabled = true;
                m.limiter.ceiling_db = ceiling_db;
            })
        };
        for (before, after, ceiling_db) in [
            (MasterSettings::default(), limited(-12.0), -12.0),
            (limited(-3.0), limited(-12.0), -12.0),
            (limited(-12.0), limited(-3.0), -3.0),
        ] {
            let mut bus = MasterBus::new(Some(&before), rate).unwrap();
            for n in 0..rate as usize / 10 {
                run(&mut bus, tone(n, rate, 150.0, 0.9));
            }
            let mut next = MasterBus::new(Some(&after), rate).unwrap();
            next.transition_from(&mut bus);
            let settle = rate as usize / 100 + 2;
            let mut worst = 0.0f32;
            for n in 0..rate as usize / 2 {
                let y = run(&mut next, tone(n, rate, 150.0, 0.9));
                if n >= settle {
                    worst = worst.max(y[0].abs());
                }
            }
            assert!(
                worst <= ceiling(ceiling_db),
                "{ceiling_db} dB at {rate}: {worst}"
            );
            assert!(worst > ceiling(ceiling_db) * 0.9);
            assert!(!next.ramping());
        }
    }
}

#[test]
fn a_switched_off_limiter_passes_what_it_is_given() {
    let mut bus = MasterBus::new(Some(&MasterSettings::default()), 48_000).unwrap();
    for x in [[0.3, -0.2], [0.95, -4.0], [100.0, 0.0]] {
        assert_eq!(bus.limit(x).map(f32::to_bits), x.map(f32::to_bits));
    }
}

#[test]
fn level_and_balance_scale_the_music_but_not_the_click() {
    let (plan, resources) = loud_scene(2);
    for rate in RATES {
        let render_with = |m: Option<MasterSettings>| {
            let mut renderer =
                Renderer::new(plan.clone(), resources.clone(), with_master(m), rate).unwrap();
            renderer.set_metronome(true);
            let frames = rate as usize / 4;
            let mut outputs = vec![vec![[0.0f32; 2]; frames]; 3];
            let mut views: Vec<&mut [[f32; 2]]> =
                outputs.iter_mut().map(|o| o.as_mut_slice()).collect();
            let mut mix = vec![[0.0f32; 2]; frames];
            renderer.render_stems_and_mix_until(&mut views, &mut mix, f64::INFINITY);
            (outputs, mix)
        };
        let (plain_stems, _) = render_with(None);
        for (gain_db, balance) in [
            (-6.0, 0.0),
            (-24.0, 0.0),
            (3.0, 0.0),
            (0.0, 1.0),
            (0.0, -0.5),
            (-6.0, 0.25),
        ] {
            let (stems, mix) = render_with(Some(master(|m| {
                m.gain_db = gain_db;
                m.balance = balance;
            })));
            // Stems come before the master and are not touched by it.
            assert_eq!(stems, plain_stems, "the stems are the tracks' own");
            let gain = 10f64.powf(gain_db / 20.0);
            let level = [
                (gain * (1.0 - f64::max(balance, 0.0))) as f32,
                (gain * (1.0 + f64::min(balance, 0.0))) as f32,
            ];
            for n in 0..mix.len() {
                let mut program = [0.0f32; 2];
                for stem in &stems[..2] {
                    for c in 0..2 {
                        program[c] += stem[n][c];
                    }
                }
                let expected = std::array::from_fn::<f32, 2, _>(|c| {
                    let scaled = program[c] * level[c];
                    scaled + stems[2][n][c]
                })
                .map(master_limit);
                assert_eq!(
                    mix[n], expected,
                    "frame {n}, {gain_db} dB, balance {balance}"
                );
            }
        }
    }
}

/// One frame through the effects and level, then the limiter, as the renderer does with no click.
fn run(bus: &mut MasterBus, x: [f32; 2]) -> [f32; 2] {
    let y = bus.bus(x, 120.0);
    bus.limit(y)
}
/// A steady tone of `hz` at `amplitude`, in both channels.
fn tone(n: usize, rate: u32, hz: f64, amplitude: f64) -> [f32; 2] {
    [((TAU * hz * n as f64 / rate as f64).sin() * amplitude) as f32; 2]
}
/// The RMS of the left channel after `settle` frames, of `hz` run through `bus`.
fn through(bus: &mut MasterBus, rate: u32, hz: f64, amplitude: f64) -> f64 {
    let frames = rate as usize;
    let mut sum = 0.0;
    let mut count = 0;
    for n in 0..frames {
        let y = run(bus, tone(n, rate, hz, amplitude));
        if n >= frames / 2 {
            sum += (y[0] as f64).powi(2);
            count += 1;
        }
    }
    (sum / count as f64).sqrt()
}

#[test]
fn the_equalizer_shapes_the_mix() {
    for rate in RATES {
        let rms = |m: &MasterSettings, hz: f64| {
            through(&mut MasterBus::new(Some(m), rate).unwrap(), rate, hz, 0.2)
        };
        let flat = rms(&MasterSettings::default(), 60.0);
        let boosted = rms(
            &master(|m| {
                m.eq.enabled = true;
                m.eq.low_db = 12.0;
            }),
            60.0,
        );
        assert!(
            (db(boosted) - db(flat) - 12.0).abs() < 1.0,
            "{} dB",
            db(boosted) - db(flat)
        );
        let cut = rms(
            &master(|m| {
                m.eq.enabled = true;
                m.eq.high_db = -12.0;
            }),
            10_000.0,
        );
        let flat = rms(&MasterSettings::default(), 10_000.0);
        assert!(
            (db(cut) - db(flat) + 12.0).abs() < 1.5,
            "{} dB",
            db(cut) - db(flat)
        );
        let mid = |db_gain: f64| {
            rms(
                &master(|m| {
                    m.eq.enabled = true;
                    m.eq.mid_db = db_gain;
                    m.eq.mid_hz = 1000.0;
                }),
                1000.0,
            )
        };
        assert!((db(mid(9.0)) - db(mid(0.0)) - 9.0).abs() < 0.5);
    }
}

#[test]
fn the_compressor_holds_a_loud_mix_down_and_leaves_a_quiet_one() {
    for rate in RATES {
        let settings = master(|m| {
            m.compressor.enabled = true;
            m.compressor.threshold_db = -20.0;
            m.compressor.ratio = 4.0;
            m.compressor.attack_ms = 5.0;
            m.compressor.release_ms = 100.0;
        });
        let run = |amplitude: f64| {
            db(through(
                &mut MasterBus::new(Some(&settings), rate).unwrap(),
                rate,
                220.0,
                amplitude,
            )) - db(amplitude / 2f64.sqrt())
        };
        let quiet = run(0.02);
        let loud = run(0.8);
        assert!(
            quiet.abs() < 0.5,
            "below the threshold nothing changes: {quiet} dB"
        );
        assert!(loud < -6.0, "a loud mix is turned down: {loud} dB");
    }
}

#[test]
fn the_reverb_adds_a_tail_that_the_dry_mix_does_not_have() {
    for rate in RATES {
        for send in [0.1, 0.5] {
            let tail_energy = |reverb: bool| {
                let mut bus = MasterBus::new(
                    Some(&master(|m| {
                        m.reverb.enabled = reverb;
                        m.reverb.mix = send;
                    })),
                    rate,
                )
                .unwrap();
                for n in 0..rate as usize / 10 {
                    bus.bus(tone(n, rate, 440.0, 0.5), 120.0);
                }
                let mut energy = 0.0f64;
                for _ in 0..rate as usize / 2 {
                    let y = bus.bus([0.0; 2], 120.0);
                    energy += (y[0] as f64).powi(2) + (y[1] as f64).powi(2);
                }
                energy
            };
            assert_eq!(tail_energy(false), 0.0);
            assert!(tail_energy(true) > 1e-3, "no tail at send {send}");
        }
    }
}

#[test]
fn a_seek_clears_the_tail_and_the_limiter() {
    let rate = 48_000;
    let mut reverb = MasterBus::new(
        Some(&master(|m| {
            m.reverb.enabled = true;
            m.reverb.mix = 0.5;
        })),
        rate,
    )
    .unwrap();
    for n in 0..rate as usize / 4 {
        run(&mut reverb, tone(n, rate, 330.0, 0.9));
    }
    reverb.reset();
    let mut tail = 0.0f32;
    for _ in 0..rate as usize / 4 {
        tail = tail.max(reverb.bus([0.0; 2], 120.0)[0].abs());
    }
    assert!(tail < 1e-6, "tail left after the seek: {tail}");
    let mut limiter = MasterBus::new(
        Some(&master(|m| {
            m.limiter.enabled = true;
            m.limiter.ceiling_db = -12.0;
            m.limiter.release_ms = 1000.0;
        })),
        rate,
    )
    .unwrap();
    for n in 0..rate as usize / 4 {
        run(&mut limiter, tone(n, rate, 330.0, 0.9));
    }
    // The limiter holds the gain down for a second; after a seek a quiet note below the ceiling passes whole.
    assert!(run(&mut limiter, [0.05; 2])[0] < 0.04);
    limiter.reset();
    assert_eq!(run(&mut limiter, [0.05; 2])[0], 0.05);
}

#[test]
fn changing_the_master_while_it_plays_does_not_click() {
    let steps = |bus: &mut MasterBus, rate: u32, range: std::ops::Range<usize>, last: &mut f64| {
        let mut most = 0.0f64;
        for n in range {
            let y = run(bus, tone(n, rate, 220.0, 0.5))[0] as f64;
            most = most.max((y - *last).abs());
            *last = y;
        }
        most
    };
    let on = |edit: fn(&mut MasterSettings)| master(edit);
    let changes: Vec<(&str, MasterSettings, MasterSettings)> = vec![
        (
            "level up",
            MasterSettings::default(),
            on(|m| m.gain_db = 9.0),
        ),
        (
            "level down",
            on(|m| m.gain_db = 6.0),
            on(|m| m.gain_db = -20.0),
        ),
        (
            "balance",
            MasterSettings::default(),
            on(|m| m.balance = 0.9),
        ),
        (
            "equalizer",
            MasterSettings::default(),
            on(|m| {
                m.eq.enabled = true;
                m.eq.mid_db = 12.0;
                m.eq.mid_hz = 220.0;
            }),
        ),
        (
            "compressor",
            MasterSettings::default(),
            on(|m| {
                m.compressor.enabled = true;
                m.compressor.threshold_db = -30.0;
                m.compressor.ratio = 10.0;
            }),
        ),
        (
            "reverb",
            MasterSettings::default(),
            on(|m| {
                m.reverb.enabled = true;
                m.reverb.mix = 0.6;
            }),
        ),
        (
            "limiter on",
            MasterSettings::default(),
            on(|m| {
                m.limiter.enabled = true;
                m.limiter.ceiling_db = -12.0;
            }),
        ),
        (
            "limiter off",
            on(|m| {
                m.limiter.enabled = true;
                m.limiter.ceiling_db = -12.0;
            }),
            MasterSettings::default(),
        ),
        (
            "everything off",
            on(|m| {
                m.gain_db = 6.0;
                m.eq.enabled = true;
                m.eq.low_db = 12.0;
                m.compressor.enabled = true;
                m.compressor.threshold_db = -30.0;
                m.reverb.enabled = true;
                m.limiter.enabled = true;
            }),
            MasterSettings::default(),
        ),
    ];
    for rate in RATES {
        for (what, before, after) in &changes {
            // The most a settled sound moves in a frame, before and after, which the change must stay near.
            let settled = |settings: &MasterSettings| {
                let mut bus = MasterBus::new(Some(settings), rate).unwrap();
                let mut last = 0.0;
                steps(&mut bus, rate, 0..rate as usize, &mut last);
                steps(&mut bus, rate, rate as usize..rate as usize * 2, &mut last)
            };
            let allowed = settled(before).max(settled(after)) * 1.5 + 0.004;
            for offset in [0usize, 7, 31, 100] {
                let mut bus = MasterBus::new(Some(before), rate).unwrap();
                let mut last = 0.0;
                steps(&mut bus, rate, 0..rate as usize + offset, &mut last);
                let mut next = MasterBus::new(Some(after), rate).unwrap();
                next.transition_from(&mut bus);
                let during = steps(
                    &mut next,
                    rate,
                    rate as usize + offset..rate as usize * 2,
                    &mut last,
                );
                assert!(
                    during <= allowed,
                    "{what} at {rate}, offset {offset}: step {during} over {allowed}"
                );
            }
        }
    }
}

#[test]
fn the_master_stays_off_the_heap() {
    let loud = master(|m| {
        m.gain_db = 3.0;
        m.balance = 0.2;
        m.compressor.enabled = true;
        m.eq.enabled = true;
        m.eq.low_db = 4.0;
        m.reverb.enabled = true;
        m.limiter.enabled = true;
        m.limiter.ceiling_db = -6.0;
    });
    for rate in RATES {
        let mut buses = [
            MasterBus::new(None, rate).unwrap(),
            MasterBus::new(Some(&loud), rate).unwrap(),
            MasterBus::new(Some(&MasterSettings::default()), rate).unwrap(),
            MasterBus::new(Some(&loud), rate).unwrap(),
        ];
        let mut sum = 0.0f32;
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|f| f.set(true));
        for index in 0..buses.len() {
            if index > 0 {
                let (done, rest) = buses.split_at_mut(index);
                rest[0].transition_from(&mut done[index - 1]);
            }
            for n in 0..rate as usize / 5 {
                let y = run(&mut buses[index], tone(n, rate, 110.0, 0.9));
                sum += y[0] + y[1];
            }
            std::hint::black_box(buses[index].ramping());
            buses[index].reset();
        }
        COUNT_HEAP.with(|f| f.set(false));
        std::hint::black_box(sum);
        assert_eq!(
            HEAP_OPERATIONS.with(Cell::get),
            0,
            "the master chain allocated or freed heap memory"
        );
    }
}

#[test]
fn a_mix_arriving_mid_play_with_a_master_is_the_same_sound_as_one_started_with_it() {
    let (plan, resources) = loud_scene(4);
    let settings = master(|m| {
        m.gain_db = -6.0;
        m.compressor.enabled = true;
        m.compressor.threshold_db = -24.0;
        m.limiter.enabled = true;
        m.limiter.ceiling_db = -3.0;
    });
    let rate = 48_000;
    let mut started = Renderer::new(
        plan.clone(),
        resources.clone(),
        with_master(Some(settings.clone())),
        rate,
    )
    .unwrap();
    let mut swapped =
        Renderer::new(plan.clone(), resources.clone(), with_master(None), rate).unwrap();
    render(&mut swapped, 1_000);
    let mix = PreparedMix::prepare(&with_master(Some(settings)), &plan, rate).unwrap();
    drop(swapped.replace_mix(mix));
    let a = render(&mut started, 40_000);
    let b = render(&mut swapped, 39_000);
    // Once the crossfade has ended, only the compressor's memory of the first moments differs: the level and ceiling
    // are the same, so the two settle to the same loudness.
    let tail = |frames: &[[f32; 2]]| {
        frames[frames.len() - 8_000..]
            .iter()
            .map(|f| f[0].abs())
            .fold(0.0, f32::max)
    };
    assert!(
        (tail(&a) - tail(&b)).abs() < 0.05,
        "{} against {}",
        tail(&a),
        tail(&b)
    );
    // The swap crossfades for ten milliseconds, 480 frames, after which the ceiling holds.
    assert!(peak(&a) <= ceiling(-3.0) && peak(&b[1_000..]) <= ceiling(-3.0));
}

#[test]
fn settings_outside_their_ranges_are_refused() {
    let bad: Vec<(&str, MasterSettings)> = vec![
        ("level high", master(|m| m.gain_db = 12.5)),
        ("level low", master(|m| m.gain_db = -25.0)),
        ("level nan", master(|m| m.gain_db = f64::NAN)),
        ("balance", master(|m| m.balance = 1.5)),
        (
            "ceiling above full scale",
            master(|m| m.limiter.ceiling_db = 0.5),
        ),
        ("ceiling low", master(|m| m.limiter.ceiling_db = -13.0)),
        ("release short", master(|m| m.limiter.release_ms = 9.0)),
        ("release long", master(|m| m.limiter.release_ms = 1001.0)),
        ("ratio", master(|m| m.compressor.ratio = 25.0)),
        ("eq", master(|m| m.eq.low_db = 30.0)),
        ("reverb mix", master(|m| m.reverb.mix = 1.2)),
        ("reverb model", master(|m| m.reverb.model = "cave".into())),
    ];
    for (what, settings) in bad {
        assert!(settings.validate().is_err(), "{what}");
        assert!(
            with_master(Some(settings.clone())).validate().is_err(),
            "{what}"
        );
        assert!(MasterBus::new(Some(&settings), 48_000).is_err(), "{what}");
    }
    assert!(MasterSettings::default().validate().is_ok());
    assert!(MasterSettings::default().is_neutral());
}

#[test]
fn a_master_is_stored_as_the_camel_case_object_the_editor_writes() {
    let json = serde_json::json!({
        "gainDb": -3.0, "balance": 0.25,
        "compressor": {"enabled": true, "thresholdDb": -12.0, "ratio": 2.0, "attackMs": 30.0, "releaseMs": 200.0, "makeupDb": 1.5},
        "eq": {"enabled": true, "lowDb": 1.0, "midDb": -2.0, "highDb": 3.0, "midHz": 800.0},
        "reverb": {"enabled": true, "model": "plate", "room": 0.6, "damping": 0.5, "mix": 0.1},
        "limiter": {"enabled": true, "ceilingDb": -1.0, "releaseMs": 100.0}
    });
    let parsed: MasterSettings = serde_json::from_value(json.clone()).unwrap();
    assert!(!parsed.is_neutral());
    assert_eq!(serde_json::to_value(&parsed).unwrap(), json);
    // A room reverb is stored without its model, as every pedalboard's is, and reads back as the room.
    let mut room = json.clone();
    room["reverb"]["model"] = "room".into();
    let parsed: MasterSettings = serde_json::from_value(room.clone()).unwrap();
    room["reverb"].as_object_mut().unwrap().remove("model");
    assert_eq!(serde_json::to_value(&parsed).unwrap(), room);
    assert_eq!(
        serde_json::from_value::<MasterSettings>(room).unwrap(),
        parsed
    );
    // Nothing else may ride along.
    let mut extra = json;
    extra["amp"] = serde_json::json!({});
    assert!(serde_json::from_value::<MasterSettings>(extra).is_err());
    // An untouched document does not write the field at all, so projects saved before it serialize as they did.
    let settings = DocumentSettings::default();
    assert!(
        serde_json::to_value(&settings)
            .unwrap()
            .get("master")
            .is_none()
    );
}

/// Run with `cargo test --release --test audio_master master_cost -- --ignored --nocapture`.
#[test]
#[ignore]
fn master_cost() {
    let rate = 48_000u32;
    let seconds = 20usize;
    let signal: Vec<[f32; 2]> = (0..rate as usize * seconds)
        .map(|n| {
            let t = n as f64 / rate as f64;
            let swell = 0.5 * (-3.0 * t.fract()).exp();
            let note = (TAU * 82.41 * t).sin()
                + 0.7 * (TAU * 330.0 * t).sin()
                + 0.3 * (TAU * 2_500.0 * t).sin();
            [(swell * note) as f32, (swell * note * 0.8) as f32]
        })
        .collect();
    let cases: Vec<(&str, Option<MasterSettings>)> = vec![
        ("untouched (none)", None),
        ("defaults", Some(MasterSettings::default())),
        (
            "level and balance",
            Some(master(|m| {
                m.gain_db = -3.0;
                m.balance = 0.1;
            })),
        ),
        ("limiter", Some(master(|m| m.limiter.enabled = true))),
        ("eq", Some(master(|m| m.eq.enabled = true))),
        ("compressor", Some(master(|m| m.compressor.enabled = true))),
        ("reverb hall", Some(master(|m| m.reverb.enabled = true))),
        (
            "everything",
            Some(master(|m| {
                m.gain_db = -3.0;
                m.balance = 0.1;
                m.limiter.enabled = true;
                m.eq.enabled = true;
                m.compressor.enabled = true;
                m.reverb.enabled = true;
            })),
        ),
    ];
    for (name, settings) in cases {
        let mut bus = MasterBus::new(settings.as_ref(), rate).unwrap();
        let mut sink = 0.0f32;
        let start = std::time::Instant::now();
        for frame in &signal {
            let y = run(&mut bus, *frame);
            sink += y[0];
        }
        let elapsed = start.elapsed().as_secs_f64();
        std::hint::black_box(sink);
        let per_frame = elapsed / signal.len() as f64;
        println!(
            "{name:>20}: {:6.1} ns/frame, {:5.2}% of one core at {rate} Hz",
            per_frame * 1e9,
            per_frame * rate as f64 * 100.0
        );
    }
    let start = std::time::Instant::now();
    let built = MasterBus::new(None, rate).unwrap();
    println!("building a bus: {:?}", start.elapsed());
    drop(built);
}
